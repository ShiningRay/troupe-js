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
  it("SIGSTOP/SIGCONT 全链路", async () => {
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
      console.log("  [chaos] SIGCONT B（旧持有者恢复，尝试以旧 token 写入）");
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
});
