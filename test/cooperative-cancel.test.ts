import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Actor, CallRejectedError, Troupe } from "../src/index.js";
import { SqlitePropStore } from "../src/props/sqlite.js";

/**
 * 协作取消契约（ADR 0005 §5，ROADMAP P2-5）：
 * - 排队期取消 → 直接拒绝（无副作用，reason="cancelled"）
 * - 执行期取消 → ctx.signal.aborted 到达 Actor（远程经 wire cancel），自主提前返回
 * - 取消不产生新的成功写；框架不强行 kill（CPU 阻塞无法抢占，文档明确）
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 等 Turn 进入在飞/排队（activeCalls 注册）后再取消：cast → 激活 → enqueue 之间存在
 * 激活窗口（首调无单飞缓存时），期间 abortCall 返回 false 属正常。
 */
async function abortWhenRunning(p: Promise<unknown>, abort: () => boolean): Promise<boolean> {
  let settled = false;
  p.finally(() => {
    settled = true;
  }).catch(() => {});
  const callId = (p as unknown as { callId?: string }).callId!;
  expect(callId).toBeTruthy();
  for (let i = 0; i < 100 && !settled; i++) {
    if (abort()) return true;
    await sleep(50);
  }
  return abort();
}

class CancelCart extends Actor<{ items: string[]; lastAborted?: boolean }> {
  static role = "CancelCart";
  static initialProps = () => ({ items: [] });

  /** 长任务：每 20ms 检查一次取消信号；被取消 → 标记并返回（不写盘） */
  async work(seconds = 5) {
    const deadline = this.ctx.now() + seconds * 1000;
    let aborted = false;
    while (this.ctx.now() < deadline) {
      if (this.ctx.signal.aborted) {
        aborted = true;
        break;
      }
      await sleep(20);
    }
    if (!aborted) {
      this.props.items.push("done");
      await this.saveProps();
    }
    this.props.lastAborted = aborted;
    return aborted ? "cancelled" : "completed";
  }

  /** 快速占位：占住串行通道 */
  async blocker() {
    await sleep(400);
    return "blocked";
  }

  /** CPU 阻塞：无视取消信号（框架无法抢占——文档语义） */
  async cpuBound() {
    let sum = 0;
    const end = Date.now() + 150;
    while (Date.now() < end) sum++;
    return sum > 0;
  }
}

describe("协作取消（P2-5，ADR 0005 §5）", () => {
  it("本地：排队期取消 → 直接拒绝（reason=cancelled，不启动 Turn）", async () => {
    const troupe = await Troupe.form({
      actors: [CancelCart],
      propStore: new SqlitePropStore(mkdtempSync(join(tmpdir(), "troupe-cancel-"))),
      defaultIntermission: 0,
      defaultTimeout: "10s",
    });
    // 占住串行通道
    const blockerP = troupe.cast(CancelCart, "k").blocker();
    await sleep(50);
    // 排队第二个调用：拿到 callId 后立即取消（仍在排队——blocker 尚未 settle）
    const queuedP = troupe.cast(CancelCart, "k").work();
    const queuedId = (queuedP as unknown as { callId?: string }).callId;
    expect(queuedId).toBeTruthy();
    await sleep(30);
    expect(troupe.abortCall(queuedId!)).toBe(true);
    const err = await queuedP.catch((e) => e);
    expect(err).toBeInstanceOf(CallRejectedError);
    expect((err as CallRejectedError).reason).toBe("cancelled");
    expect((err as CallRejectedError).message).toMatch(/未开始执行/);
    expect(await blockerP).toBe("blocked");
    await troupe.drainAll();
    await troupe.shutdown();
  }, 30_000);

  it("执行期取消：ctx.signal 到达 Actor → 自主提前返回；取消不产生新的成功写", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-cancel2-"));
    const store = new SqlitePropStore(dir);
    const troupe = await Troupe.form({
      actors: [CancelCart],
      propStore: store,
      defaultIntermission: 0,
      defaultTimeout: "30s",
    });
    const p = troupe.cast(CancelCart, "k").work();
    expect(await abortWhenRunning(p, () => troupe.abortCall((p as unknown as { callId?: string }).callId!))).toBe(true);
    const result = await p;
    expect(result).toBe("cancelled"); // Actor 检查 signal 后自主返回
    // 取消不产生新的成功写：items 未 push "done"
    const stored = await store.read("default", "CancelCart", "k");
    const wrapped = stored?.props as Record<string, unknown> | undefined;
    const inner = (wrapped?.props ?? wrapped) as { items?: string[] } | undefined;
    expect(inner?.items ?? []).not.toContain("done");
    await troupe.drainAll();
    await troupe.shutdown();
  }, 30_000);

  it("远程取消经 wire cancel 消息到达执行节点；不产生新的成功写", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-cancel3-"));
    const store = new SqlitePropStore(dir);
    const a = await Troupe.form({
      actors: [CancelCart],
      propStore: store,
      defaultIntermission: 0,
      defaultTimeout: "30s",
      cluster: { port: 0 },
      ownership: { leaseMs: 5_000 },
    });
    const b = await Troupe.form({
      actors: [CancelCart],
      propStore: store,
      defaultIntermission: 0,
      defaultTimeout: "30s",
      cluster: { port: 0, seeds: [a.clusterAddress()!] },
      ownership: { leaseMs: 5_000 },
    });
    // 找归属 B 的键：A 发起 → 目录路由转发到 B 执行
    let key = "";
    for (let i = 0; i < 2000 && !key; i++) {
      const n = `c${i}`;
      if (a.ownerOf("CancelCart", n) === b.clusterAddress()) key = n;
    }
    const p = a.cast(CancelCart, key || "c0").work();
    // A 端发起：先本地查（false=已在 B）→ wire cancel → B 中止信号
    expect(await abortWhenRunning(p, () => a.abortCall((p as unknown as { callId?: string }).callId!))).toBe(true);
    const result = await p;
    expect(result).toBe("cancelled"); // B 的 Actor 观察到 aborted
    // 无新的成功写
    const stored = await store.read("default", "CancelCart", key || "c0");
    const wrapped = stored?.props as Record<string, unknown> | undefined;
    const inner = (wrapped?.props ?? wrapped) as { items?: string[] } | undefined;
    expect(inner?.items ?? []).not.toContain("done");
    await b.shutdown();
    await a.shutdown();
  }, 40_000);

  it("CPU 阻塞无法抢占（框架不强行 kill）：信号置位后 Turn 仍完整执行", async () => {
    const troupe = await Troupe.form({
      actors: [CancelCart],
      propStore: new SqlitePropStore(mkdtempSync(join(tmpdir(), "troupe-cancel4-"))),
      defaultIntermission: 0,
      defaultTimeout: "10s",
    });
    const p = troupe.cast(CancelCart, "k").cpuBound();
    const callId = (p as unknown as { callId?: string }).callId!;
    troupe.abortCall(callId); // 信号置位，但 CPU 循环不检查 → 完整执行
    const result = await p;
    expect(result).toBe(true); // 完整执行（未被杀）
    await troupe.drainAll();
    await troupe.shutdown();
  }, 30_000);
});
