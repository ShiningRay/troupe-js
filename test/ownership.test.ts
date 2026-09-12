import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConflictError } from "../src/index.js";
import { SqlitePropStore } from "../src/props/sqlite.js";
import { wrapEnvelope } from "../src/core/envelope.js";

function tmpStore(): SqlitePropStore {
  return new SqlitePropStore(mkdtempSync(join(tmpdir(), "troupe-own-")));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("M3 验收：所有权契约（DESIGN §6.5，SQLite 共享存储）", () => {
  it("acquire/续租/顶替/释放：epoch 单调、旧持有者不能误删新租约", async () => {
    const store = tmpStore();
    // 首次获取
    const a1 = await store.acquire("ns", "Cart", "u1", "stage-A", 10_000);
    expect(a1).toEqual({ ok: true, epoch: 1 });
    // 他人获取：租约未过期 → 拒绝并返回持有者
    const b1 = await store.acquire("ns", "Cart", "u1", "stage-B", 10_000);
    expect(b1).toMatchObject({ ok: false, holder: { ownerId: "stage-A", epoch: 1 } });
    // 本人续租：epoch 不变
    const a2 = await store.acquire("ns", "Cart", "u1", "stage-A", 10_000);
    expect(a2).toEqual({ ok: true, epoch: 1 });
    // 释放：owner+epoch 匹配才生效
    expect(await store.release("ns", "Cart", "u1", "stage-B", 1)).toBe(false); // 他人无效
    expect(await store.release("ns", "Cart", "u1", "stage-A", 99)).toBe(false); // 错 epoch 无效
    expect(await store.release("ns", "Cart", "u1", "stage-A", 1)).toBe(true);
    // 释放后他人可获取（新周期）
    const b2 = await store.acquire("ns", "Cart", "u1", "stage-B", 10_000);
    expect(b2).toEqual({ ok: true, epoch: 2 }); // 顶替路径：epoch+1
  });

  it("租约过期后可被顶替（epoch 递增）——kill -9 接管的时间窗", async () => {
    const store = tmpStore();
    await store.acquire("ns", "Cart", "u1", "stage-A", 60); // 短租约
    await sleep(120); // 过期
    const b = await store.acquire("ns", "Cart", "u1", "stage-B", 10_000);
    expect(b).toEqual({ ok: true, epoch: 2 });
  });

  it("fencing：旧 epoch 的写入被拒（暂停后恢复的旧持有者，M3 核心语义）", async () => {
    const store = tmpStore();
    await store.create("ns", "Cart", "u1", wrapEnvelope({ items: [] }, {}), 1);
    const a = await store.acquire("ns", "Cart", "u1", "stage-A", 60);
    const oldEpoch = (a as { epoch: number }).epoch;
    await store.write("ns", "Cart", "u1", wrapEnvelope({ items: ["x"] }, {}), {
      expectedRevision: 1, schemaVersion: 1, fencingToken: oldEpoch,
    });
    // 租约过期 → B 顶替（epoch+1）
    await sleep(120);
    const b = await store.acquire("ns", "Cart", "u1", "stage-B", 10_000);
    expect(b).toEqual({ ok: true, epoch: 2 });
    // A（暂停后恢复）用旧 token 写入 → fencing 拒绝
    const err = await store
      .write("ns", "Cart", "u1", wrapEnvelope({ items: ["stale"] }, {}), {
        expectedRevision: 2, schemaVersion: 1, fencingToken: oldEpoch,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toMatch(/fencing 拒绝.*epoch=2.*token=1/);
    // B 用新 token 写入成功
    await store.write("ns", "Cart", "u1", wrapEnvelope({ items: ["x", "b"] }, {}), {
      expectedRevision: 2, schemaVersion: 1, fencingToken: 2,
    });
    const rec = await store.read("ns", "Cart", "u1");
    expect(rec!.revision).toBe(3);
  });

  it("并发抢占只有一个成功（原子性）", async () => {
    const store = tmpStore();
    const results = await Promise.all(
      ["A", "B", "C", "D"].map((owner) => store.acquire("ns", "Cart", "u1", owner, 10_000)),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    // 所有失败方看到同一个持有者
    const loserViews = new Set(
      results
        .filter((r) => !r.ok)
        .map((r) => (r as { holder: { ownerId: string } }).holder.ownerId),
    );
    expect(loserViews.size).toBe(1);
  });
});
