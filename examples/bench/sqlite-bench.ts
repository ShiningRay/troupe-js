/**
 * SQLite 写入基准（PLAN M2 验收：DatabaseSync 阻塞影响量化）
 * 运行：npm run bench:sqlite [N]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Actor, Troupe } from "../../src/index.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";

class BenchActor extends Actor<{ payload: string; n: number }> {
  static role = "BenchCart";
  static initialProps = () => ({ payload: "", n: 0 });

  async save(n: number) {
    this.props.n = n;
    this.props.payload = "x".repeat(1024); // 固定 ~1KB，避免随次数增长
    await this.saveProps();
    return n;
  }
}

const N = Number(process.argv[2] ?? 1000);
const dir = mkdtempSync(join(tmpdir(), "troupe-bench-"));
const troupe = await Troupe.form({
  actors: [BenchActor],
  propStore: new SqlitePropStore(dir),
  defaultIntermission: 0,
});
const agent = troupe.cast(BenchActor, "bench-1");

// 心跳模拟：5ms 周期计时器，测量同步写盘造成的最大调度间隙
let hbLast = performance.now();
let hbMaxGap = 0;
const hb = setInterval(() => {
  const now = performance.now();
  hbMaxGap = Math.max(hbMaxGap, now - hbLast);
  hbLast = now;
}, 5);
hb.unref();

const lat: number[] = [];
const yieldLoop = () => new Promise<void>((r) => setImmediate(r)); // 让事件循环走完相位，心跳可触发
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await agent.save(i);
  lat.push(performance.now() - t);
  await yieldLoop(); // yield 不计入延迟
}
clearInterval(hb);
await troupe.drainAll();

const sorted = [...lat].sort((a, b) => a - b);
const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
console.log(`SQLite saveProps 基准（N=${N}，每次写 ~1KB props，WAL 模式）`);
console.log(
  `  save 延迟: p50=${pick(0.5).toFixed(2)}ms  p95=${pick(0.95).toFixed(2)}ms  p99=${pick(0.99).toFixed(2)}ms  max=${sorted[sorted.length - 1].toFixed(2)}ms`,
);
console.log(`  事件循环: 5ms 心跳模拟的最大调度间隙 = ${hbMaxGap.toFixed(2)}ms（无阻塞时 ≈5-7ms）`);
console.log(`  提示：DatabaseSync 同步执行会阻塞事件循环；写入密集场景请参考 DESIGN §7.2 切换共享存储的界限`);
console.log(`  数据目录：${dir}（可删）`);
