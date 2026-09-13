/**
 * 大规模激活与热点倾斜基准（PLAN M8 验收：十万级在场 Actor）：
 *   S1 激活 100_000 个 Actor（各自唯一 stageName，最小 Props）→ 激活吞吐 + RSS
 *   S2 热点倾斜：10k 次调用集中 1 个 Actor vs 分散 10k 个 Actor（串行通道容量事实 §5.3）
 *   S3 全局内存预算：maxActivations 上限下拒绝行为（快速冒烟）
 *
 * 运行：npm run bench:scale [激活数=100000] [倾斜调用数=10000]
 */
import { performance } from "node:perf_hooks";
import { Actor, Troupe } from "../../src/index.js";
import { InMemoryPropStore } from "../../src/props/memory.js";

const COUNT = Number(process.argv[2] ?? 100_000);
const SKEW = Number(process.argv[3] ?? 10_000);

class ScaleActor extends Actor<{ n: number }> {
  static role = "Scale";
  static initialProps = () => ({ n: 0 });

  async touch() {
    this.props.n++;
    return this.props.n;
  }
}

const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const heapMb = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

async function main(): Promise<void> {
  console.log(
    `大规模基准：node ${process.version}，激活 ${COUNT.toLocaleString()} 个 Actor，倾斜调用 ${SKEW.toLocaleString()} 次`,
  );
  const troupe = await Troupe.form({
    actors: [ScaleActor],
    propStore: new InMemoryPropStore(),
    defaultIntermission: 0, // 保持全部在场
    defaultTimeout: "30s",
    maxActivations: 150_000,
    localCallByReference: true, // 压测调度与激活本身（Codec 开销已有专项基准）
  });

  // ---- S1 激活吞吐 ----
  console.log(`\nS1 激活 ${COUNT.toLocaleString()} 个（每次一个 touch 调用 → 激活 + Turn + 保存 InMemory）`);
  const t0 = performance.now();
  let done = 0;
  const CONC = 2_000; // 并发在途（避免微任务队列爆栈）
  for (let base = 0; base < COUNT; base += CONC) {
    const batch = Math.min(CONC, COUNT - base);
    await Promise.all(
      Array.from({ length: batch }, (_, i) => troupe.cast(ScaleActor, `a${base + i}`).touch()),
    );
    done += batch;
  }
  const activateMs = performance.now() - t0;
  console.log(
    `  激活+调用：${done.toLocaleString()} 个 / ${(activateMs / 1000).toFixed(1)}s = ${Math.round(done / (activateMs / 1000)).toLocaleString()} activations/s`,
  );
  console.log(`  内存：RSS ${rssMb()}MB，heap ${heapMb()}MB（≈${(rssMb() / (COUNT / 1000)).toFixed(1)}KB/Actor）`);

  // ---- S2 热点倾斜 ----
  console.log(`\nS2 热点倾斜：${SKEW.toLocaleString()} 次 touch`);
  const t1 = performance.now();
  for (let i = 0; i < SKEW; i++) await troupe.cast(ScaleActor, "hot").touch(); // 单热点串行
  const hotMs = performance.now() - t1;
  console.log(`  单热点 Actor（串行通道）：${Math.round(SKEW / (hotMs / 1000)).toLocaleString()} msg/s（${hotMs.toFixed(0)}ms）`);

  const t2 = performance.now();
  for (let base = 0; base < SKEW; base += CONC) {
    const batch = Math.min(CONC, SKEW - base);
    await Promise.all(
      Array.from({ length: batch }, (_, i) => troupe.cast(ScaleActor, `a${base + i}`).touch()),
    );
  }
  const spreadMs = performance.now() - t2;
  console.log(`  分散 ${Math.min(SKEW, COUNT).toLocaleString()} 个 Actor（并行）：${Math.round(SKEW / (spreadMs / 1000)).toLocaleString()} msg/s（${spreadMs.toFixed(0)}ms）`);
  console.log(`  容量事实（§5.3）：单 Actor 一个串行通道；扩容 = 更多 Actor/Stage`);

  // ---- S3 全局内存预算（快速冒烟）----
  const tight = await Troupe.form({
    actors: [ScaleActor],
    propStore: new InMemoryPropStore(),
    defaultIntermission: 0,
    maxActivations: 2,
  });
  await tight.cast(ScaleActor, "ok-1").touch();
  await tight.cast(ScaleActor, "ok-2").touch(); // 1/2、2/2 正常
  let rejected = false;
  try {
    await tight.cast(ScaleActor, "ok-3").touch(); // 3/2 超限
  } catch {
    rejected = true;
  }
  console.log(`\nS3 全局预算：maxActivations=2 下第三个激活被拒 = ${rejected}（§5.3）`);
  await tight.drainAll();

  const shutdownStart = performance.now();
  await troupe.drainAll();
  console.log(`\n收尾：drainAll（${COUNT.toLocaleString()} 个下场）${(performance.now() - shutdownStart).toFixed(0)}ms`);
}

void main();
