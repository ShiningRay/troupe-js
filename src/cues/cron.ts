/**
 * 5 字段 cron 解析与下次触发计算（零依赖）。
 * 字段：分 时 日 月 周（周 0 或 7=周日）。支持 星号、步进(n)、单值、区间(a-b)、区间带步进，及逗号列表。
 * 日/周均为受限时按标准 cron 语义取"或"；求值使用服务器本地时间（timezone 字段预留，§7.5）。
 */
export interface CronExpr {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number> | null; // null = *
  months: Set<number>;
  dows: Set<number> | null; // null = *
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week（7 归一为 0=周日）
];

function expandField(token: string, idx: number): Set<number> {
  const [min, max] = FIELD_RANGES[idx];
  const out = new Set<number>();
  for (const part of token.split(",")) {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) {
      throw new TypeError(`cron field invalid: ${JSON.stringify(part)} (field ${idx + 1})`);
    }
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (!(step >= 1)) throw new TypeError(`cron step invalid: ${part}`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      if (m[1].includes("-")) {
        const [a, b] = m[1].split("-").map(Number);
        if (a < min || b > max || a > b) throw new TypeError(`cron range out of bounds: ${part} (${min}-${max})`);
        lo = a;
        hi = b;
      } else {
        const v = Number(m[1]);
        if (v < min || v > max) throw new TypeError(`cron value out of bounds: ${v} (${min}-${max})`);
        lo = hi = v;
        if (m[2] !== undefined) hi = max; // `a/n`：从 a 到字段上限
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (idx === 4 && out.has(7)) {
    out.add(0);
    out.delete(7);
  }
  if (out.size === 0) throw new TypeError(`cron field empty: ${token}`);
  return out;
}

export function parseCronExpression(expr: string): CronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new TypeError(`cron needs 5 fields (min hour dom month dow): ${JSON.stringify(expr)}`);
  }
  const doms = expandField(fields[2], 2);
  const dows = expandField(fields[4], 4);
  return {
    minutes: expandField(fields[0], 0),
    hours: expandField(fields[1], 1),
    doms: doms.size === 31 ? null : doms,
    months: expandField(fields[3], 3),
    dows: dows.size === 7 ? null : dows,
  };
}

function matches(expr: CronExpr, d: Date): boolean {
  if (!expr.minutes.has(d.getMinutes()) || !expr.hours.has(d.getHours())) return false;
  if (!expr.months.has(d.getMonth() + 1)) return false;
  const dom = d.getDate();
  const dow = d.getDay();
  if (expr.doms !== null && expr.dows !== null) {
    return expr.doms.has(dom) || expr.dows.has(dow);
  }
  if (expr.doms !== null) return expr.doms.has(dom);
  if (expr.dows !== null) return expr.dows.has(dow);
  return true;
}

/** 下次触发时间（epoch ms）；一年内无匹配返回 null。按分钟粒度扫描。 */
export function nextCronTime(expr: CronExpr, fromMs: number): number | null {
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(expr, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ---- 时区支持（P1-5 / ROADMAP：cron 计算用 Intl，ReminderSpec.timeZone）----

interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const tzFormatters = new Map<string, Intl.DateTimeFormat>();

function getTzFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = tzFormatters.get(timeZone);
  if (!f) {
    // 无效时区名在此抛 RangeError——调用方转为显式错误（拒绝模糊配置）
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    tzFormatters.set(timeZone, f);
  }
  return f;
}

/** 校验 IANA 时区名（无效抛 TypeError）；启动/登记期拒绝模糊配置 */
export function validateTimeZone(timeZone: string): void {
  try {
    getTzFormatter(timeZone).format(new Date());
  } catch (e) {
    throw new TypeError(
      `无效 timeZone："${timeZone}"（需 IANA 名称如 Asia/Shanghai；${e instanceof Error ? e.message : String(e)}）`,
    );
  }
}

function zonedWall(utcMs: number, timeZone: string): WallParts {
  const parts = getTzFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const hour = get("hour") % 24; // en-US 24h 制 0 可能为 "24"
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute") };
}

/** 该时刻 timeZone 的 UTC 偏移（ms，东正西负） */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const w = zonedWall(utcMs, timeZone);
  const asUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUTC - Math.floor(utcMs / 60_000) * 60_000;
}

/** 时区 wall 时间 → epoch ms（两次求偏移消 DST 歧义；按下一匹配分钟取整） */
function wallToEpoch(w: WallParts, timeZone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const off1 = tzOffsetMs(guess, timeZone);
  const candidate = guess - off1;
  const off2 = tzOffsetMs(candidate, timeZone);
  return off2 === off1 ? candidate : guess - off2;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function dayOfWeek(y: number, m: number, d: number): number {
  // Zeller/欧拉：0=周日（与 CronExpr.dow 一致）
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = m < 3 ? y - 1 : y;
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
}

function matchesWall(expr: CronExpr, w: WallParts): boolean {
  if (!expr.minutes.has(w.minute) || !expr.hours.has(w.hour)) return false;
  if (!expr.months.has(w.month)) return false;
  const dom = w.day;
  const dow = dayOfWeek(w.year, w.month, w.day);
  if (expr.doms !== null && expr.dows !== null) return expr.doms.has(dom) || expr.dows.has(dow);
  if (expr.doms !== null) return expr.doms.has(dom);
  if (expr.dows !== null) return expr.dows.has(dow);
  return true;
}

/**
 * 指定时区的下次触发（epoch ms）：在该时区的 wall clock 上按分钟扫描（DST 跳变即
 * wall 语义本身），命中后换算回 epoch；一年内无匹配返回 null。
 * 注意：DST 春季跳变会跳过不存在的 wall 分钟（标准 cron 行为）。
 */
export function nextCronTimeInZone(expr: CronExpr, fromMs: number, timeZone: string): number | null {
  validateTimeZone(timeZone);
  const w = zonedWall(fromMs, timeZone);
  // 对齐到下一分钟（wall 域）
  let { year, month, day, hour, minute } = w;
  minute += 1;
  if (minute > 59) {
    minute = 0;
    hour += 1;
    if (hour > 23) {
      hour = 0;
      day += 1;
      if (day > daysInMonth(year, month)) {
        day = 1;
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
    }
  }
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const cw = { year, month, day, hour, minute };
    if (matchesWall(expr, cw)) {
      const epoch = wallToEpoch(cw, timeZone);
      if (epoch > fromMs) return epoch;
      // DST 回拨导致的 wall 重复：继续扫下一分钟
    }
    minute += 1;
    if (minute > 59) {
      minute = 0;
      hour += 1;
      if (hour > 23) {
        hour = 0;
        day += 1;
        if (day > daysInMonth(year, month)) {
          day = 1;
          month += 1;
          if (month > 12) {
            month = 1;
            year += 1;
          }
        }
      }
    }
  }
  return null;
}
