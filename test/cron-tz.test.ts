import { describe, expect, it } from "vitest";
import { nextCronTime, nextCronTimeInZone, parseCronExpression, validateTimeZone } from "../src/cues/cron.js";

/** P1-5：cron 时区语义（ADR 0004 配套，ROADMAP P1-5） */
describe("cron timeZone（Intl wall clock）", () => {
  it("Asia/Shanghai 的 09:00 = UTC 01:00", () => {
    const expr = parseCronExpression("0 9 * * *");
    // 起点：UTC 2026-06-15T00:30Z（上海 08:30）→ 下一匹配 09:00 上海 = 01:00 UTC
    const from = Date.UTC(2026, 5, 15, 0, 30);
    const got = nextCronTimeInZone(expr, from, "Asia/Shanghai");
    expect(got).toBe(Date.UTC(2026, 5, 15, 1, 0));
  });

  it("跨日界：New York 23:30 的 '0 0 * * *' → 次日 04:00/05:00 UTC（视 DST）", () => {
    const expr = parseCronExpression("0 0 * * *");
    // 2026-06-15T23:30Z（纽约夏令时 19:30）→ 次日 00:00 EDT = 04:00 UTC
    const from = Date.UTC(2026, 5, 15, 23, 30);
    const got = nextCronTimeInZone(expr, from, "America/New_York");
    expect(got).toBe(Date.UTC(2026, 5, 16, 4, 0));
  });

  it("Pacific/Auckland（UTC+12/13）与本地无关：'30 8 * * *' 命中 UTC 前一日 19:30/20:30", () => {
    const expr = parseCronExpression("30 8 * * *");
    // 2026-01-10T00:00Z（奥克兰 1 月 10 日 13:00，NZDT=+13）→ 当日 08:30 已过 →
    // 下一匹配：1 月 11 日 08:30 奥克兰 = 1 月 10 日 19:30 UTC
    const from = Date.UTC(2026, 0, 10, 0, 0);
    const got = nextCronTimeInZone(expr, from, "Pacific/Auckland");
    expect(got).toBe(Date.UTC(2026, 0, 10, 19, 30));
  });

  it("每周字段按该时区的星期判定（'0 9 * * 1' → 周一的 09:00 上海）", () => {
    const expr = parseCronExpression("0 9 * * 1");
    // 2026-06-13 是周六（UTC）；上海 06-13 20:00（周六）→ 下一匹配：06-15（周一）09:00 上海 = 01:00 UTC
    const from = Date.UTC(2026, 5, 13, 12, 0);
    const got = nextCronTimeInZone(expr, from, "Asia/Shanghai");
    expect(got).toBe(Date.UTC(2026, 5, 15, 1, 0));
    const d = new Date(got);
    // 上海时间 06-15 为周一
    expect(d.getUTCDay()).toBe(1);
  });

  it("UTC 时区与绝对时刻换算一致（与宿主本地时区无关）", () => {
    const expr = parseCronExpression("15 10 * * *");
    const from = Date.UTC(2026, 5, 15, 0, 0);
    expect(nextCronTimeInZone(expr, from, "UTC")).toBe(Date.UTC(2026, 5, 15, 10, 15));
  });

  it("无效时区名显式拒绝（拒绝模糊配置）", () => {
    expect(() => validateTimeZone("Not/AZone")).toThrow(/无效 timeZone/);
    expect(() => nextCronTimeInZone(parseCronExpression("0 9 * * *"), Date.now(), "Mars/Olympus")).toThrow();
  });
});
