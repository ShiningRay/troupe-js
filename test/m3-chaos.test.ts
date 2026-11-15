import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Actor, CallRejectedError, Troupe } from "../src/index.js";
import { SqlitePropStore } from "../src/props/sqlite.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 20_000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

async function retryTransient<T>(fn: () => Promise<T>, tries = 60, backoffMs = 200): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retriable =
        (e as Error).name === "UnknownOutcomeError" ||
        (e instanceof CallRejectedError && (e.reason === "ownership" || e.reason === "drift"));
      if (i === tries - 1 || !retriable) throw e;
      await sleep(backoffMs);
    }
  }
}

class ChaosCartActor extends Actor<{ items: string[] }> {
  static role = "ChaosCart";
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

/**
 * M3 验收（横切场景：事件循环暂停、旧节点恢复）：
 * SIGSTOP 冻结归属 Stage 的事件循环 → 租约无法续期 → 存活方在租约到期后接管（epoch+1）
 * → SIGCONT 恢复旧持有者 → 其用旧 fencing token 的写入被存储拒绝。
 */
describe("M3 混沌验收：事件循环暂停 → 接管 → 旧持有者写入被 fencing 拒绝", () => {
  // Windows 无 SIGSTOP/SIGCONT（Node 抛 "Unknown signal"），该用例仅在 POSIX 有意义
  it.skipIf(process.platform === "win32")("SIGSTOP/SIGCONT 全链路", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-chaos-"));
    const stageA = await Troupe.form({
      actors: [ChaosCartActor],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      defaultTimeout: "10s",
      cluster: { port: 0 },
      ownership: { leaseMs: 600 },
    });

    // 拉起独立子进程 Stage B（真事件循环，可被冻结）
    const fixture = fileURLToPath(new URL("./fixtures/pausable-stage.ts", import.meta.url));
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", fixture, "--dir", dir, "--seeds", stageA.clusterAddress()!, "--lease", "600"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines: string[] = [];
    let fencedResolve: ((v: string) => void) | undefined;
    createInterface({ input: child.stdout! }).on("line", (line) => {
      lines.push(line);
      if (line.startsWith("FENCED") || line.startsWith("WROTE")) fencedResolve!(line);
    });
    createInterface({ input: child.stderr! }).on("line", (line) => console.error(`  [B] ${line}`));

    try {
      const childAddr = await new Promise<string>((resolve) => {
        const t = setInterval(() => {
          const ready = lines.find((l) => l.startsWith("READY addr="));
          if (ready) {
            clearInterval(t);
            resolve(/addr=(\S+)/.exec(ready)![1]);
          }
        }, 50);
      });
      const keyLine = await new Promise<string>((resolve) => {
        const t = setInterval(() => {
          const k = lines.find((l) => l.startsWith("KEY "));
          if (k) {
            clearInterval(t);
            resolve(k.slice(4));
          }
        }, 50);
      });
      await waitUntil(() => stageA.clusterMembers()!.includes(childAddr));
      const epochLine = await new Promise<string>((resolve) => {
        const t = setInterval(() => {
          const e = lines.find((l) => l.startsWith("EPOCH "));
          if (e) {
            clearInterval(t);
            resolve(e);
          }
        }, 25);
        setTimeout(() => {
          clearInterval(t);
          resolve("");
        }, 10_000).unref?.();
      });
      expect(epochLine).toMatch(/^EPOCH \d+$/);
      const oldEpoch = Number(/EPOCH (\d+)/.exec(epochLine)![1]);
      expect(oldEpoch).toBeGreaterThanOrEqual(1);

      // ① 冻结 B 的事件循环（租约续期停止、探测无 ACK）
      child.kill("SIGSTOP");
      console.log("  [chaos] SIGSTOP B（事件循环冻结）");

      // ② A 探测判死（两阶段：suspect → dead，约 6-7s）
      const dead = await waitUntil(() => !stageA.clusterMembers()!.includes(childAddr), 20_000);
      expect(dead).toBe(true);

      // ③ A 接管：租约已过期（600ms ≪ 冻结时长）→ acquire 顶替（epoch+1）
      expect(await retryTransient(() => stageA.cast(ChaosCartActor, keyLine).add("two"))).toBe(2);
      expect(await retryTransient(() => stageA.cast(ChaosCartActor, keyLine).peek())).toBe(2);

      // ④ 恢复 B：旧持有者用旧 token 写入 → fencing 拒绝
      child.kill("SIGCONT");
      console.log(`  [chaos] SIGCONT B（旧持有者恢复，尝试以旧 token 写入）`);
      const outcome = await new Promise<string>((resolve) => {
        fencedResolve = resolve;
        child.stdin!.write("try-write\n");
        setTimeout(() => resolve("TIMEOUT"), 8_000).unref?.();
      });
      expect(outcome).toMatch(/^FENCED /);
      console.log(`  [chaos] ${outcome.slice(0, 90)}…`);

      // A 的新写入不受影响（新 epoch）
      expect(await retryTransient(() => stageA.cast(ChaosCartActor, keyLine).add("three"))).toBe(3);
    } finally {
      child.kill("SIGKILL");
      await stageA.shutdown();
    }
  }, 60_000);

  /**
   * P1-4 验收（ADR 0004 §4/§6，3 进程 + 目录路由）：
   * 冻结 owner B → 幸存方（A 或 C）在租约到期后接管（epoch+1）→ B 恢复后旧 token 写入被拒。
   * 与上方双进程场景的差异：存在第三方 C——接管者可能是 C（经目录路由转发），覆盖
   * "路由给非相邻幸存者"的路径；接管后无重复成功写（fencing 单调）。
   */
  it.skipIf(process.platform === "win32")("3 节点：冻结 owner → 幸存方接管 → 恢复后写入被拒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-chaos3-"));
    const fixture = fileURLToPath(new URL("./fixtures/pausable-stage.ts", import.meta.url));
    const lease = "600";
    const stageA = await Troupe.form({
      actors: [ChaosCartActor],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      defaultTimeout: "10s",
      cluster: { port: 0 },
      ownership: { leaseMs: 600 },
    });

    const spawnStage = async (): Promise<{ child: ChildProcess; addr: string; key: Promise<string>; lines: string[] }> => {
      const child: ChildProcess = spawn(
        process.execPath,
        ["--import", "tsx", fixture, "--dir", dir, "--seeds", stageA.clusterAddress()!, "--lease", lease],
        { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
      );
      const lines: string[] = [];
      createInterface({ input: child.stdout! }).on("line", (line) => lines.push(line));
      createInterface({ input: child.stderr! }).on("line", (line) => console.error(`  [child] ${line.slice(0, 90)}`));
      const addr = await new Promise<string>((resolve) => {
        const t = setInterval(() => {
          const ready = lines.find((l) => l.startsWith("READY addr="));
          if (ready) {
            clearInterval(t);
            resolve(/addr=(\S+)/.exec(ready)![1]);
          }
        }, 50);
      });
      const key = new Promise<string>((resolve) => {
        const t = setInterval(() => {
          const k = lines.find((l) => l.startsWith("KEY "));
          if (k) {
            clearInterval(t);
            resolve(k.slice(4));
          }
        }, 50);
      });
      return { child, addr, key, lines };
    };

    const b = await spawnStage();
    const c = await spawnStage();
    const probe = new SqlitePropStore(dir); // 只读探针（WAL 共享）

    try {
      await waitUntil(
        () =>
          stageA.clusterMembers()!.includes(b.addr) &&
          stageA.clusterMembers()!.includes(c.addr),
        20_000,
      );
      const key = await b.key;
      const oldEpoch = Number(/EPOCH (\d+)/.exec(b.lines.find((l) => l.startsWith("EPOCH ")) ?? "EPOCH 1")![1]);

      // B 持有期间：A 经目录路由写入 B（返回 2 = B 的 items 长度）
      expect(await retryTransient(() => stageA.cast(ChaosCartActor, key).add("two"))).toBe(2);

      // ① 冻结 B（租约无法续期、探测无 ACK）
      b.child.kill("SIGSTOP");
      console.log("  [chaos3] SIGSTOP B");
      // ② A 判死 B → 成员变更 → 目录缓存失效
      const dead = await waitUntil(() => !stageA.clusterMembers()!.includes(b.addr), 20_000);
      expect(dead).toBe(true);
      // ③ 幸存方（A 或 C，环首候选决定）接管：epoch+1，恢复数据
      expect(await retryTransient(() => stageA.cast(ChaosCartActor, key).add("three"))).toBe(3);
      const own = await probe.readOwnership("default", "ChaosCart", key);
      const takerAddrs = [stageA.clusterAddress()!, c.addr];
      expect(takerAddrs.some((a) => own!.ownerId.startsWith(a.split("#")[0]))).toBe(true);
      expect(own!.epoch).toBeGreaterThan(oldEpoch);

      // ④ B 恢复：旧 token 写入 → fencing 拒绝（无重复成功写）
      b.child.kill("SIGCONT");
      console.log("  [chaos3] SIGCONT B（旧持有者恢复，尝试以旧 token 写入）");
      b.child.stdin!.write("try-write\n"); // 触发夹具以旧 epoch 直接 store.write
      const outcome = await new Promise<string>((resolve) => {
        const t = setInterval(() => {
          const fenced = b.lines.find((l) => l.startsWith("FENCED ") || l.startsWith("WROTE"));
          if (fenced) {
            clearInterval(t);
            resolve(fenced);
          }
        }, 50);
        setTimeout(() => {
          clearInterval(t);
          resolve("TIMEOUT");
        }, 8_000).unref?.();
      });
      expect(outcome).toMatch(/^FENCED /);
      console.log(`  [chaos3] ${outcome.slice(0, 90)}…`);

      // ⑤ 接管方继续可写。注意 at-least-once 语义（DESIGN §6.1 / ADR 0004 §4）：B 冻结期间
      // socket 缓冲里可能存有已转发的 Call，恢复后按目录重放给新 owner——非幂等测试 Actor
      // 会被重复执行（此处即 add("three") 可能重放）。业务按 ctx.idem 幂等吸收；断言只要求
      // "接管方可继续成功写"（次数 ≥ 4），并已由 FENCED 证明旧 token 无成功写。
      expect(await retryTransient(() => stageA.cast(ChaosCartActor, key).add("four"))).toBeGreaterThanOrEqual(4);
    } finally {
      b.child.kill("SIGKILL");
      c.child.kill("SIGKILL");
      await stageA.shutdown();
    }
  }, 90_000);
});
