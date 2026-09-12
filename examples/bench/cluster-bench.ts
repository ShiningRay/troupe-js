/**
 * 集群消息处理基准（PLAN M5 观测/压测的前置基建）：
 *
 * 拓扑：父进程 Stage A + 两个独立子进程 Stage B/C（真实 TCP 路由、真实 SQLite 落盘）
 * 相位：
 *   P0 直调·同步（裸对象）       —— 纯 JS 方法调用（无框架、无 await）
 *   P0+ 直调·async/await（裸对象）—— 原生 Promise 机制开销
 *   P1 本地·串行 echo            —— 框架本地路径：Codec 边界 + 排队 + 串行 Turn + 超时竞速
 *   P2 跨 Stage·串行 echo        —— P1 + TCP 往返（长度前缀帧 + JSON 信封）
 *   P3 跨 Stage·串行 echoSave    —— P2 + 归属子进程 SQLite 落盘（WAL）
 *   P4 跨 Stage·并发 echo ×C     —— 并发在途请求下的吞吐
 *   P5 本地·串行 echoSave        —— 落盘基线（无所有权）
 *   P6 本地·串行 echoSave+所有权 —— P5 + M3 租约/fencing 开销
 *
 * 运行：npm run bench:cluster [相位时长秒=5] [payload字节=256] [并发=8]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Actor, Troupe } from "../../src/index.js";
import { InMemoryPropStore } from "../../src/props/memory.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";
import { BenchActor, type BenchProps } from "./bench-stage.js";

const [durArg = "5", sizeArg = "256", concArg = "8"] = process.argv.slice(2);
const DUR_MS = Number(durArg) * 1_000;
const PAYLOAD = "x".repeat(Number(sizeArg));
const CONCURRENCY = Number(concArg);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PhaseResult {
  name: string;
  note: string;
  msgs: number;
  errors: number;
  elapsedMs: number;
  lat: number[];
}

async function runPhase(
  name: string,
  note: string,
  concurrency: number,
  fn: () => Promise<unknown> | unknown,
  opts: { sync?: boolean; sampleEvery?: number } = {},
): Promise<PhaseResult> {
  const sampleEvery = opts.sampleEvery ?? 1; // 极快相位抽样存延迟，防数组爆内存
  const lat: number[] = [];
  let msgs = 0;
  let errors = 0;
  const start = performance.now();
  const stopAt = start + DUR_MS;
  const worker = async () => {
    let iter = 0;
    while (performance.now() < stopAt) {
      const t = performance.now();
      try {
        if (opts.sync) fn();
        else await fn();
        msgs++;
      } catch {
        errors++;
      }
      if (++iter % sampleEvery === 0) lat.push(performance.now() - t);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { name, note, msgs, errors, elapsedMs: performance.now() - start, lat };
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function printResults(results: PhaseResult[]): void {
  console.log(`\n相位（每相 ${Math.round(DUR_MS / 1000)}s，payload ${PAYLOAD.length}B 往返）`);
  console.log("  相位                              │  msg/s │   p50 │   p95 │   p99 │   max │  错误");
  console.log("  ──────────────────────────────────┼────────┼───────┼───────┼───────┼───────┼──────");
  for (const r of results) {
    const sorted = [...r.lat].sort((a, b) => a - b);
    const rate = (r.msgs / (r.elapsedMs / 1000)).toFixed(0).padStart(6);
    const p50 = pct(sorted, 0.5).toFixed(2).padStart(5);
    const p95 = pct(sorted, 0.95).toFixed(2).padStart(5);
    const p99 = pct(sorted, 0.99).toFixed(2).padStart(5);
    const max = (sorted[sorted.length - 1] ?? 0).toFixed(2).padStart(5);
    console.log(
      `  ${(r.name + " " + r.note).padEnd(34, "　")}│ ${rate} │ ${p50} │ ${p95} │ ${p99} │ ${max} │ ${String(r.errors).padStart(4)}`,
    );
  }
}

function findKeyOwnedBy(owner: Troupe, target: string, tag: string): string {
  for (let i = 0; i < 5000; i++) {
    const name = `${tag}-${i}-${randomUUID().slice(0, 4)}`;
    if (owner.ownerOf("Bench", name) === target) return name;
  }
  throw new Error("找不到归属键");
}

/** 裸基线：不经框架、不经 Codec、不经调度的普通对象 */
class PlainSync {
  echo(payload: string): string {
    return payload;
  }
}

class PlainAsync {
  async echo(payload: string): Promise<string> {
    return payload;
  }
}

class LocalBenchActor extends Actor<BenchProps> {
  static role = "Bench";
  static initialProps = (): BenchProps => ({ n: 0 });

  async echo(payload: string): Promise<string> {
    return payload;
  }

  async echoSave(payload: string): Promise<string> {
    this.props.n++;
    await this.saveProps();
    return payload;
  }
}

async function main(): Promise<void> {
  console.log(
    `集群消息处理基准：node ${process.version}，相位时长 ${durArg}s，并发 ${CONCURRENCY}，` +
      `payload ${PAYLOAD.length}B（echo 双向）`,
  );

  const dirChild = mkdtempSync(join(tmpdir(), "troupe-bench-cluster-"));
  const stageA = await Troupe.form({
    actors: [LocalBenchActor],
    propStore: new InMemoryPropStore(),
    defaultIntermission: 0,
    defaultTimeout: "30s",
    cluster: { port: 0 },
  });
  console.log(`[setup] Stage A（父进程）addr=${stageA.clusterAddress()} pid=${process.pid}`);

  const spawnBench = (): { proc: ChildProcess; ready: Promise<string> } => {
    const proc = spawn(
      process.execPath,
      [
        "--import", "tsx", "examples/bench/bench-stage.ts",
        "--dir", mkdtempSync(join(tmpdir(), "troupe-bench-stage-")),
        "--seeds", stageA.clusterAddress()!,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let resolveReady: (v: string) => void;
    const ready = new Promise<string>((r) => (resolveReady = r));
    const pipe = (stream: NodeJS.ReadableStream, label: string) => {
      createInterface({ input: stream }).on("line", (line) => {
        const m = /^READY addr=(\S+)/.exec(line);
        if (m) resolveReady!(m[1]);
        else if (!line.startsWith("READY")) console.log(`  ${label}│ ${line}`);
      });
    };
    pipe(proc.stdout!, "B");
    pipe(proc.stderr!, "B[stderr] ");
    return { proc, ready };
  };

  const b = spawnBench();
  const c = spawnBench();
  const addrB = await b.ready;
  const addrC = await c.ready;
  const converged = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const m = stageA.clusterMembers()!;
      if (m.includes(addrB) && m.includes(addrC)) return true;
      await sleep(50);
    }
    return false;
  })();
  console.log(`[setup] B=${addrB}，C=${addrC}，收敛=${converged}（3 Stage 环）`);
  if (!converged) throw new Error("集群未收敛");

  // 键分布：A 本地若干、B 若干（P2/P3/P4 目标）
  const selfAddr = stageA.clusterAddress()!;
  const localKey = findKeyOwnedBy(stageA, selfAddr, "kl");
  const remoteKeys = [findKeyOwnedBy(stageA, addrB, "kr"), findKeyOwnedBy(stageA, addrB, "kr")];
  console.log(`[setup] 本地键 → A；远程键 → B（经 TCP 路由）`);

  // P5/P6 对照组：本地（无集群噪声）SQLite 落盘 ± 所有权
  const dirP5 = mkdtempSync(join(tmpdir(), "troupe-bench-p5-"));
  const dirP6 = mkdtempSync(join(tmpdir(), "troupe-bench-p6-"));
  const t5 = await Troupe.form({
    actors: [LocalBenchActor],
    propStore: new SqlitePropStore(dirP5),
    defaultIntermission: 0,
    defaultTimeout: "30s",
  });
  const t6 = await Troupe.form({
    actors: [LocalBenchActor],
    propStore: new SqlitePropStore(dirP6),
    defaultIntermission: 0,
    defaultTimeout: "30s",
    ownership: { leaseMs: 1_000 },
  });

  const results: PhaseResult[] = [];
  try {
    const agentLocal = stageA.cast(LocalBenchActor, localKey);
    const agentRemote = stageA.cast(LocalBenchActor, remoteKeys[0]);
    const agentRemote2 = stageA.cast(LocalBenchActor, remoteKeys[1]);
    const agent5 = t5.cast(LocalBenchActor, "save-bench");
    const agent6 = t6.cast(LocalBenchActor, "save-bench");

    console.log(`\n[bench] 运行中（每相位 ${durArg}s）…`);
    const plainSync = new PlainSync();
    const plainAsync = new PlainAsync();
    results.push(await runPhase("P0 直调·同步", "裸对象（无框架/await）", 1, () => plainSync.echo(PAYLOAD), { sync: true, sampleEvery: 200 }));
    results.push(await runPhase("P0 直调·async", "裸对象（原生 Promise）", 1, () => plainAsync.echo(PAYLOAD), { sampleEvery: 100 }));
    results.push(await runPhase("P1 本地·串行", "echo（框架本地路径）", 1, () => agentLocal.echo(PAYLOAD)));
    results.push(await runPhase("P2 跨 Stage·串行", "echo", 1, () => agentRemote.echo(PAYLOAD)));
    results.push(await runPhase("P3 跨 Stage·串行", "echoSave", 1, () => agentRemote.echoSave(PAYLOAD)));
    results.push(
      await runPhase(`P4 跨 Stage·并发×${CONCURRENCY}`, "echo", CONCURRENCY, () =>
        agentRemote2.echo(PAYLOAD),
      ),
    );
    results.push(await runPhase("P5 本地·串行", "echoSave（无所有权）", 1, () => agent5.echoSave(PAYLOAD)));
    results.push(await runPhase("P6 本地·串行", "echoSave（+所有权）", 1, () => agent6.echoSave(PAYLOAD)));

    printResults(results);

    // 派生结论
    const med = (i: number) => pct([...results[i].lat].sort((a, b) => a - b), 0.5);
    const asyncMech = med(1) - med(0);
    const frameworkLocal = med(2) - med(1);
    const tcp = med(3) - med(2);
    const persist = med(4) - med(3);
    const ownership = med(7) - med(6);
    const rate5 = results[5].msgs / (results[5].elapsedMs / 1000);
    console.log(`\n结论（中位数差）：`);
    console.log(`  async/await 机制    ≈ ${asyncMech.toFixed(3)}ms/条（P0 async - P0 同步：Promise/微任务）`);
    console.log(`  框架本地开销        ≈ ${frameworkLocal.toFixed(3)}ms/条（P1-P0 async：Codec×2+排队+串行 Turn+超时竞速）`);
    console.log(`  TCP 路由开销        ≈ ${tcp.toFixed(2)}ms/条（P2-P1：帧封装+JSON+loopback 往返）`);
    console.log(`  持久化开销          ≈ ${persist.toFixed(2)}ms/条（P3-P2：归属进程 SQLite WAL 写）`);
    console.log(`  M3 所有权每写开销   ≈ ${ownership.toFixed(2)}ms/条（P6-P5：fencing 校验 + 摊销续租）`);
    console.log(`  并发吞吐            ≈ ${rate5.toFixed(0)} msg/s（${CONCURRENCY} 在途，串行 Turn 天然限流单 Actor）`);
    console.log(`  提示：并发相位受单 Actor 串行通道限制（§5.3 容量事实）；多键并行才扩容`);
  } finally {
    await Promise.allSettled([t5.shutdown(), t6.shutdown(), stageA.shutdown()]);
    b.proc.kill("SIGTERM");
    c.proc.kill("SIGTERM");
    await sleep(300);
    b.proc.kill("SIGKILL");
    c.proc.kill("SIGKILL");
  }
}

void main();
