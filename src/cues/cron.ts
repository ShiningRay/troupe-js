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
