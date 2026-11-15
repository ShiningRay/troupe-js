/**
 * CI 跳过项汇总（ROADMAP P0-7：不再以静默 skip 换绿）。
 * 读取 vitest JSON 报告，把跳过用例连同文件名列进 GITHUB_STEP_SUMMARY；
 * TROUPE_REQUIRE_PG=1 的 job 若存在 PG 相关跳过，以非零退出使 job 失败。
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";

const file = process.argv[2] ?? "test-results/vitest.json";
const requirePg = process.env.TROUPE_REQUIRE_PG === "1";

if (!existsSync(file)) {
  console.error(`[ci-skip-summary] 未找到 ${file}`);
  process.exit(requirePg ? 1 : 0);
}

const data = JSON.parse(readFileSync(file, "utf8"));
const skipped = [];
const guardSkipped = [];
for (const tr of data.testResults ?? []) {
  for (const a of tr.assertionResults ?? []) {
    if (a.status === "skipped" || a.status === "todo") {
      const entry = `${tr.name ?? tr.file ?? "?"} :: ${a.fullName ?? a.title ?? "?"}`;
      // "PG 门禁"守卫本身不是 PG 用例：URL 已提供时它按设计跳过（见 ownership-fencing.test.ts）
      if (/拒绝静默跳过/.test(a.fullName ?? a.title ?? "")) guardSkipped.push(entry);
      else skipped.push(entry);
    }
  }
}

const lines = [
  "## 跳过的用例（列明原因，非静默跳过）",
  skipped.length ? skipped.map((s) => `- ${s}`).join("\n") : "（无跳过项）",
];
if (guardSkipped.length) {
  lines.push("", `门禁守卫按设计跳过（非 PG 用例）：${guardSkipped.length} 项`);
}
const summary = lines.join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}\n`);
}

if (requirePg && skipped.length > 0) {
  console.error(
    "[ci-skip-summary] TROUPE_REQUIRE_PG=1 的 job 不允许任何跳过（ROADMAP P0-7：PG 用例跳过即 job 失败）",
  );
  process.exit(1);
}
