const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/;

/** 解析 "500ms" / "2s" / "10m" / "1h" 或毫秒数 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") return input;
  const m = DURATION_RE.exec(input.trim());
  if (!m) {
    throw new TypeError(
      `无法解析时长 ${JSON.stringify(input)}：支持 "500ms"、"2s"、"10m"、"1h" 或毫秒数字`,
    );
  }
  return Number(m[1]) * UNIT_MS[m[2] ?? "ms"];
}
