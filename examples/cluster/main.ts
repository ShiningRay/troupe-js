/**
 * 多进程集群 demo（一个 OS 进程 = 一个 Stage，真·kill -9）：
 *   1. 父进程 Stage A + 子进程 Stage B、C（各自独立 node 进程）组团，共享同机 SQLite
 *   2. 跨进程透明路由：从 A cast 归属 B/C 的键，调用经 TCP 到对方进程执行
 *   3. kill -9 真实信号杀掉 B 进程（SIGKILL）→ 探测判死 → 键漂移 → 从共享 SQLite 恢复
 *   4. 观察窗口（默认 60s，Ctrl+C 提前结束）：系统进程列表可见 A(父) 与 C 两个 node 进程
 *   5. 窗口结束：SIGTERM 让 C 优雅停机（leave → 排空 → 保存），A 最后关闭
 *
 * 运行：npm run example:cluster [观察秒数，默认 60]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { Actor, Troupe } from "../../src/index.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";

const t0 = Date.now();
const ts = () => `${String(Date.now() - t0).padStart(4, " ")}ms`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const section = (t: string) => console.log(`\n━━━ ${t} ━━━`);

const HOLD_SEC = Number(process.argv[2] ?? 60);
/**
 * 用 node --import tsx 启动子进程：loader 进程内注册，spawn 的 pid 就是
 * 真正跑 stage.ts 的进程（信号精确命中；tsx cli.mjs 会再 fork 一层孙子进程）
 */
function stageArgs(args: string[]): string[] {
  return ["--import", "tsx", "examples/cluster/stage.ts", ...args];
}

class ClusCartActor extends Actor<{ items: string[] }> {
  static role = "ClusCart";
  static initialProps = () => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(50);
  }
  return true;
}

/**
 * 漂移窗口重试（§6.5）：成员视图非对称时（A 已判死、C 尚未），调用会得到
 * UnknownOutcomeError——调用方按幂等语义重试，直到各方环视图收敛。
 */
async function retryOnUnknown<T>(fn: () => Promise<T>, tries = 20, backoffMs = 300): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error & { reason?: string };
      const retriable =
        err.name === "UnknownOutcomeError" ||
        (err.name === "CallRejectedError" && (err.reason === "ownership" || err.reason === "drift"));
      if (i === tries - 1 || !retriable) throw e;
      await sleep(backoffMs);
    }
  }
}

function findKeyOwnedBy(owner: Troupe, target: string, tag: string): string {
  for (let i = 0; i < 1000; i++) {
    const name = `${tag}-${i}-${randomUUID().slice(0, 4)}`;
    if (owner.ownerOf("ClusCart", name) === target) return name;
  }
  throw new Error("找不到归属键");
}

interface SpawnedStage {
  proc: ChildProcess;
  /** STAGE_READY 解析出的通告地址与真实 pid */
  ready: Promise<{ addr: string; pid: number }>;
}

function spawnStage(name: string, seeds: string, dir: string, boothPort: number): SpawnedStage {
  const proc = spawn(
    process.execPath,
    stageArgs(["--name", name, "--port", "0", "--seeds", seeds, "--dir", dir, "--booth", "--booth-port", String(boothPort), "--lease", "1000"]),
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let resolveReady: (v: { addr: string; pid: number; booth?: string }) => void;
  const ready = new Promise<{ addr: string; pid: number; booth?: string }>((r) => (resolveReady = r));
  const pipe = (stream: NodeJS.ReadableStream, label: string) => {
    createInterface({ input: stream }).on("line", (line) => {
      const m = /^STAGE_READY name=(\S+) addr=(\S+) pid=(\d+)(?: booth=(\S+))?$/.exec(line);
      if (m) {
        console.log(`[${ts()}] ${m[1]} 就绪：addr=${m[2]}，pid=${m[3]}${m[4] ? `，Booth=${m[4]}` : ""}${Number(m[3]) === proc.pid ? "" : "（⚠ pid 与父进程记录不一致）"}`);
        resolveReady!({ addr: m[2], pid: Number(m[3]), booth: m[4] });
        return;
      }
      if (line.startsWith("STAGE_EXIT")) {
        console.log(`  ${name} │ 已退出`);
        return;
      }
      console.log(`  ${name} ${label}│ ${line}`);
    });
  };
  pipe(proc.stdout!, "");
  pipe(proc.stderr!, "[stderr] ");
  return { proc, ready };
}

const dir = mkdtempSync(join(tmpdir(), "troupe-multiproc-"));
const shared = new SqlitePropStore(dir);
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
  console.log(`\n  收到 Ctrl+C，提前收尾`);
});

const children: ChildProcess[] = [];
try {
  section(`多进程组团（共享 SQLite：${dir}）`);
  const stageA = await Troupe.form({
    actors: [ClusCartActor],
    propStore: shared,
    defaultIntermission: 0,
    defaultTimeout: "10s",
    cluster: { port: 0 },
    booth: { port: 7500 },
    ownership: { leaseMs: 1000 }, // M3：租约 + fencing（短租约演示接管）
  });
  console.log(`[${ts()}] Stage A（父进程）addr=${stageA.clusterAddress()} pid=${process.pid}，Booth=${stageA.boothAddress()}`);

  const stageB = spawnStage("B", stageA.clusterAddress()!, dir, 7501);
  const stageC = spawnStage("C", stageA.clusterAddress()!, dir, 7502);
  children.push(stageB.proc, stageC.proc);
  const rb = await stageB.ready;
  const rc = await stageC.ready;
  const ok = await waitUntil(() => stageA.clusterMembers()!.length === 2);
  console.log(`[${ts()}] B、C 已入团（收敛=${ok}）：`);
  console.log(`[${ts()}]   A pid=${process.pid}（父进程，${stageA.clusterAddress()}）`);
  console.log(`[${ts()}]   B pid=${rb.pid}，C pid=${rc.pid}（独立 node 子进程）`);

  section("跨进程透明路由");
  const keyB = findKeyOwnedBy(stageA, rb.addr, "kb");
  const keyC = findKeyOwnedBy(stageA, rc.addr, "kc");
  console.log(`[${ts()}] ${keyB} 归属 B 进程，${keyC} 归属 C 进程（HashRing 决定）`);
  console.log(`[${ts()}] 从 A cast ${keyB} → add = ${await stageA.cast(ClusCartActor, keyB).add("one")}（TCP 到 B 进程执行）`);
  console.log(`[${ts()}] 从 A cast ${keyC} → add = ${await stageA.cast(ClusCartActor, keyC).add("one")}（TCP 到 C 进程执行）`);
  await stageA.cast(ClusCartActor, keyB).add("two");

  section("kill -9：真实 SIGKILL 杀掉 B 进程");
  console.log(`[${ts()}] kill -9 → B pid=${rb.pid}（可另开终端观察：ps -p ${rb.pid}）`);
  stageB.proc.kill("SIGKILL");
  await new Promise<void>((r) => stageB.proc.once("exit", () => r()));
  console.log(`[${ts()}] B 进程已消失；等待 A/C 探测判死（两阶段 suspect→dead，约 6s）+ 租约到期（1s）…`);
  const dead = await waitUntil(() => !stageA.clusterMembers()!.includes(rb.addr), 15_000);
  const newOwner = stageA.ownerOf("ClusCart", keyB);
  console.log(`[${ts()}] B 判死=${dead}；${keyB} 新归属 = ${newOwner === stageA.clusterAddress() ? "A" : "C"} 进程`);
  // 非对称视图窗口：C 可能仍认为键属于 B，调用得 UnknownOutcomeError → 幂等重试至收敛
  console.log(`[${ts()}] 接管后 peek = ${await retryOnUnknown(() => stageA.cast(ClusCartActor, keyB).peek())}（跨进程共享 SQLite 恢复）`);
  console.log(`[${ts()}] 继续可用 add = ${await retryOnUnknown(() => stageA.cast(ClusCartActor, keyB).add("three"))}`);

  section(`观察窗口（${HOLD_SEC}s，Ctrl+C 提前结束）——去看系统进程列表与 Booth 面板`);
  console.log(`  ps -ef | grep "cluster/stage" | grep -v grep        ← 应看到 A(父) 与 C 两个进程`);
  console.log(`  lsof -nP -iTCP -sTCP:LISTEN | grep node             ← 各自监听端口`);
  console.log(`  Booth 面板（浏览器打开，SSE 实时推送）：`);
  console.log(`    A(父)：${stageA.boothAddress()}`);
  if (rc.booth) console.log(`    C：${rc.booth}`);
  console.log(`  父进程 pid=${process.pid}，C pid=${rc.pid}`);

  // 窗口期间保持跨进程流量（ticker 键归属 C，调用持续经 TCP 落到 C 进程）
  const tickerKey = findKeyOwnedBy(stageA, rc.addr, "tick");
  let ticks = 0;
  const ticker = setInterval(() => {
    void stageA
      .cast(ClusCartActor, tickerKey)
      .add(`tick-${ticks}`)
      .then((n) => {
        ticks++;
        if (ticks % 5 === 0) console.log(`  [${ts()}] 跨进程流量：ticker 已写 ${n} 笔（落在 C 进程）`);
      })
      .catch(() => {});
  }, 2_000);

  for (let left = HOLD_SEC; left > 0 && !interrupted; left -= 5) {
    console.log(
      `  [${ts()}] 剩余 ${Math.max(left, 0)}s｜A 视角成员=${stageA.clusterMembers()!.length + 1}｜A 在场=${stageA.slots().length}｜存活进程：父 ${process.pid} + C ${rc.pid}`,
    );
    await sleep(Math.min(5_000, left * 1_000));
  }
  clearInterval(ticker);

  section("收尾：SIGTERM 让 C 优雅停机，A 最后关闭");
  stageC.proc.kill("SIGTERM");
  const cExited = await new Promise<boolean>((r) => {
    const timer = setTimeout(() => r(false), 10_000);
    stageC.proc.once("exit", () => {
      clearTimeout(timer);
      r(true);
    });
  });
  console.log(`[${ts()}] C 退出=${cExited}（leave → 排空 → 保存完成）`);
  await waitUntil(() => stageA.clusterMembers()!.length === 0, 5_000);
  await stageA.shutdown();
  console.log(`[${ts()}] A 优雅停机完成，demo 结束（总耗时 ${Date.now() - t0}ms）`);
} finally {
  // 兜底：任何路径退出前清理残留子进程（防孤儿）
  for (const c of children) {
    if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
  }
}
