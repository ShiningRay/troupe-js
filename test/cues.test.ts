import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { InMemoryCueStore } from "../src/cues/memory.js";
import { SqliteCueStore } from "../src/cues/sqlite.js";
import { InMemoryPropStore } from "../src/props/memory.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 8_000, stepMs = 25): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

let fired: Array<{ name: string; payload: unknown }> = [];
let onStageCount = 0;

class HBActor extends Actor<{ n: number }> {
  static role = "HB";
  static initialProps = () => ({ n: 0 });

  override async onStage() {
    onStageCount++;
  }

  override async onCue(name: string, payload: unknown) {
    fired.push({ name, payload });
  }

  async arm(name: string, every: number, payload?: unknown) {
    await this.scheduleReminder(name, { every, payload });
    return true;
  }

  async armAt(name: string, at: number, payload?: unknown) {
    await this.scheduleReminder(name, { at, payload });
    return true;
  }

  async disarm(name: string) {
    return this.cancelReminder(name);
  }
}

function reset() {
  fired = [];
  onStageCount = 0;
}

function mkTroupe(opts: {
  store?: InMemoryCueStore;
  tickMs?: number;
  intermission?: number;
}) {
  return Troupe.form({
    actors: [HBActor],
    propStore: new InMemoryPropStore(),
    defaultIntermission: opts.intermission ?? 0,
    cues: { store: opts.store ?? new InMemoryCueStore(), tickMs: opts.tickMs ?? 50 },
  });
}

describe("M4 验收：CueStore 语义（DESIGN §7.5）", () => {
  it("upsert/due/claim/complete 的 CAS 与租约", async () => {
    const store = new InMemoryCueStore();
    await store.upsert({
      namespace: "ns", roleId: "HB", stageName: "u1", name: "tick",
      payload: null, everyMs: 100, at: null, nextDue: 1,
    });
    expect((await store.due(10, 10)).length).toBe(1);
    const c1 = await store.claim(
      { namespace: "ns", roleId: "HB", stageName: "u1", name: "tick" }, "A", 200, 10,
    );
    expect(c1!.statusVersion).toBe(2);
    // 租约未过期：他人不能 claim；到期后可以（statusVersion 再 +1）
    expect(
      await store.claim({ namespace: "ns", roleId: "HB", stageName: "u1", name: "tick" }, "B", 300, 100),
    ).toBeNull();
    const c2 = await store.claim(
      { namespace: "ns", roleId: "HB", stageName: "u1", name: "tick" }, "B", 500, 300,
    );
    expect(c2!.statusVersion).toBe(3);
    // 旧 statusVersion 的 complete 失败（注销/upsert 竞争裁决）；正确的成功
    expect(
      await store.complete({ namespace: "ns", roleId: "HB", stageName: "u1", name: "tick" }, c1!.statusVersion, 400),
    ).toBe(false);
    expect(
      await store.complete({ namespace: "ns", roleId: "HB", stageName: "u1", name: "tick" }, c2!.statusVersion, 400),
    ).toBe(true);
    // 一次性完成 → 删除（statusVersion 匹配）
    expect(
      await store.complete({ namespace: "ns", roleId: "HB", stageName: "u1", name: "tick" }, c2!.statusVersion, null),
    ).toBe(true);
    expect((await store.list("ns")).length).toBe(0);
  });
});

describe("M4 验收：持久提醒调度（PLAN M4：下场/重启后可发现、至少一次）", () => {
  it("周期提醒触发 onCue 进入串行 Turn，payload 原样传递", async () => {
    reset();
    const troupe = await mkTroupe({});
    await troupe.cast(HBActor, "u1").arm("beat", 40, { seq: 1, tag: "x" });
    const ok = await waitUntil(() => fired.length >= 3, 5_000);
    expect(ok).toBe(true);
    expect(fired[0]).toEqual({ name: "beat", payload: { seq: 1, tag: "x" } });
    await troupe.shutdown();
  });

  it("Actor 下场后由提醒重新登台（触发即 OnStage，§3.3）", async () => {
    reset();
    const troupe = await mkTroupe({ intermission: 150 });
    await troupe.cast(HBActor, "u1").arm("beat", 300);
    await waitUntil(() => fired.length >= 1, 5_000); // 首次激活 + 触发
    await waitUntil(() => onStageCount >= 2, 8_000); // 空闲下场 → 提醒重新登台
    expect(onStageCount).toBeGreaterThanOrEqual(2);
    await troupe.shutdown();
  });

  it("一次性 at：触发一次后记录删除", async () => {
    reset();
    const troupe = await mkTroupe({});
    await troupe.cast(HBActor, "u1").armAt("once", Date.now() + 80, { v: 9 });
    await waitUntil(() => fired.length >= 1, 5_000);
    await sleep(350);
    expect(fired.length).toBe(1); // 只触发一次
    expect(fired[0].payload).toEqual({ v: 9 });
    expect((await (troupe as unknown as { director: () => { cues: () => Promise<unknown[]> } }).director().cues()).length).toBe(0);
    await troupe.shutdown();
  });

  it("注销后不再触发（cancel）", async () => {
    reset();
    const troupe = await mkTroupe({});
    await troupe.cast(HBActor, "u1").arm("beat", 40);
    await waitUntil(() => fired.length >= 1, 5_000);
    const count = fired.length;
    expect(await troupe.cast(HBActor, "u1").disarm("beat")).toBe(true);
    await sleep(300);
    expect(fired.length).toBe(count); // 注销后零触发
    await troupe.shutdown();
  });

  it("至少一次：执行者宕机（租约滞留）→ 到期后重新投递", async () => {
    reset();
    const store = new InMemoryCueStore();
    const troupe = await mkTroupe({ store });
    await troupe.cast(HBActor, "u1").arm("beat", 60);
    // 模拟"另一执行者认领后宕机"：租约 120ms、永不 complete
    const ghost = await store.claim(
      { namespace: "default", roleId: "HB", stageName: "u1", name: "beat" }, "ghost", Date.now() + 120, Date.now(),
    );
    expect(ghost).not.toBeNull();
    await sleep(60);
    expect(fired.length).toBe(0); // 租约期内不投递（防重复风暴）
    const ok = await waitUntil(() => fired.length >= 1, 5_000); // 租约到期 → 重新 claim 投递
    expect(ok).toBe(true);
    await troupe.shutdown();
  });

  it("错过多个周期：合并补发一次、不追赶（tick 慢于周期）", async () => {
    reset();
    const troupe = await mkTroupe({ tickMs: 400 });
    await troupe.cast(HBActor, "u1").arm("beat", 30);
    await sleep(1_300); // 理论可触发 ~43 次；合并后应远少于此
    expect(fired.length).toBeGreaterThanOrEqual(2);
    expect(fired.length).toBeLessThanOrEqual(6);
    await troupe.shutdown();
  });

  it("重启后提醒仍可被发现（SQLite 持久，PLAN M4 验收）", async () => {
    reset();
    const dir = mkdtempSync(join(tmpdir(), "troupe-cues-"));
    const store = new SqliteCueStore(dir);
    const t1 = await Troupe.form({
      actors: [HBActor],
      defaultIntermission: 0,
      cues: { store, tickMs: 1_000_000 }, // 不让它触发：仅登记
    });
    await t1.cast(HBActor, "u1").arm("beat", 40, { persist: true });
    await t1.shutdown();

    const t2 = await Troupe.form({
      actors: [HBActor],
      defaultIntermission: 0,
      cues: { store, tickMs: 50 }, // 新进程：从持久存储发现到期提醒
    });
    const ok = await waitUntil(() => fired.length >= 1, 5_000);
    expect(ok).toBe(true);
    expect(fired[0].payload).toEqual({ persist: true });
    await t2.shutdown();
  });
});
