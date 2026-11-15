import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ConflictError, RetentionExceededError } from "../src/index.js";
import { PostgresStreamStore } from "../src/streams/postgres.js";
import type { StreamStore } from "../src/streams/stream-store.js";

/**
 * StreamStore 契约（ADR 0005 §2/§7，ROADMAP P2-2）：
 * 并发 append 无重复 seq、幂等 eventId、ack 只前进（回退拒绝）、replay 显式回拨、
 * retain 裁剪 + RetentionExceeded。需要 PostgreSQL：TROUPE_TEST_PG_URL 门控；
 * CI pg-required leg 必跑（TROUPE_REQUIRE_PG=1 缺 URL 即失败）。
 */
const REQUIRE_PG = process.env.TROUPE_REQUIRE_PG === "1";
const PG_URL = process.env.TROUPE_TEST_PG_URL;

describe.runIf(REQUIRE_PG && !PG_URL)("PG 门禁（stream）", () => {
  it("TROUPE_REQUIRE_PG=1 但未提供 TROUPE_TEST_PG_URL：拒绝静默跳过", () => {
    throw new Error("缺少 TROUPE_TEST_PG_URL：PostgresStreamStore 契约在 CI 必跑（ROADMAP P0-7）");
  });
});

describe.runIf(!!PG_URL)("PostgresStreamStore 契约（真实 PostgreSQL）", () => {
  const store: StreamStore = new PostgresStreamStore(PG_URL!);
  // 每组契约独立 topic 隔离
  const t = (tag: string) => `str_${tag}_${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

  afterAll(async () => {
    await store.close?.();
  });

  it("append/read 往返：seq 从 1 单调递增、事件内容与 DB 时钟 createdAt", async () => {
    const topic = t("basic");
    const a1 = await store.append(topic, { n: 1 });
    const a2 = await store.append(topic, { n: 2 }, { eventId: "fixed-id" });
    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    const msgs = await store.read(topic, 0, 10);
    expect(msgs.map((m) => m.seq)).toEqual([1, 2]);
    expect(msgs[1].eventId).toBe("fixed-id");
    expect(msgs[0].event).toEqual({ n: 1 });
    expect(msgs[0].createdAt).toBeGreaterThan(0);
    // 空区间
    expect(await store.read(topic, 2, 10)).toEqual([]);
    expect(await store.topics()).toContain(topic);
  });

  it("并发 append：seq 唯一且连续（原子分配）", async () => {
    const topic = t("concurrent");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.append(topic, { i })),
    );
    const seqs = results.map((r) => r.seq).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(20); // 无重复
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)); // 连续 1..20
  });

  it("幂等 eventId：重复 append 返回原 seq、不新增事件", async () => {
    const topic = t("idem");
    const id = randomUUID();
    const first = await store.append(topic, { v: 1 }, { eventId: id });
    const second = await store.append(topic, { v: 1 }, { eventId: id });
    expect(second.seq).toBe(first.seq);
    expect(await store.read(topic, 0, 10)).toHaveLength(1);
  });

  it("ack 只前进：推进/同值幂等/回退拒绝（kind=revision）", async () => {
    const topic = t("ack");
    for (let i = 0; i < 3; i++) await store.append(topic, { i });
    const key = { topic, consumer: "c1" } as const;
    expect(await store.cursor(topic, "c1")).toBeNull();
    await store.ack(topic, "c1", 2);
    expect(await store.cursor(topic, "c1")).toMatchObject({ ackedSeq: 2 });
    await store.ack(topic, "c1", 2); // 同值幂等
    expect(await store.cursor(topic, "c1")).toMatchObject({ ackedSeq: 2 });
    const err = await store.ack(topic, "c1", 1).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).kind).toBe("revision");
    await store.ack(topic, "c1", 3);
    expect(await store.cursor(topic, "c1")).toMatchObject({ ackedSeq: 3 });
  });

  it("replay：显式回拨后重新可读；向前回拨拒绝", async () => {
    const topic = t("replay");
    for (let i = 1; i <= 3; i++) await store.append(topic, { i });
    await store.ack(topic, "c2", 3);
    await store.replay(topic, "c2", 1);
    expect(await store.cursor(topic, "c2")).toMatchObject({ ackedSeq: 1 });
    const msgs = await store.read(topic, 1, 10);
    expect(msgs.map((m) => m.seq)).toEqual([2, 3]); // 从 afterSeq=1 重读
    const err = await store.replay(topic, "c2", 3).catch((e) => e); // 向前：拒绝
    expect(err).toBeInstanceOf(ConflictError);
  });

  it("retain：裁剪旧事件；请求区间含已裁剪段 → RetentionExceeded（显式失败，不静默跳读）", async () => {
    const topic = t("retain");
    for (let i = 1; i <= 5; i++) await store.append(topic, { i });
    const { trimmed } = await store.retain(topic, 2);
    expect(trimmed).toBe(3); // seq 1..3 被裁剪，最早保留 = 4

    // 请求区间起点落在裁剪段内（afterSeq+1 < minSeq）→ 显式失败
    const err = await store.read(topic, 0, 10).catch((e) => e);
    expect(err).toBeInstanceOf(RetentionExceededError);
    const err2 = await store.read(topic, 2, 10).catch((e) => e);
    expect(err2).toBeInstanceOf(RetentionExceededError);
    expect(String(err2)).toMatch(/最早保留 seq=4/);

    // 起点合法（afterSeq+1 >= minSeq）→ 正常返回保留段
    expect((await store.read(topic, 3, 10)).map((m) => m.seq)).toEqual([4, 5]);
    expect(await store.read(topic, 5, 10)).toEqual([]);
  });
});
