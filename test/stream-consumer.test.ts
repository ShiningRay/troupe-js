import { afterAll, describe, expect, it } from "vitest";
import { PostgresStreamStore } from "../src/streams/postgres.js";
import { StreamConsumer } from "../src/streams/consumer.js";
import type { StreamMessage, StreamStore } from "../src/streams/stream-store.js";

/**
 * StreamConsumer 契约（ADR 0005 §3，ROADMAP P2-3）：
 * 断点续传、失败不 ack、会话内去重、consumer 间独立（慢/故障消费者不拖垮他人）。
 * 需要 PostgreSQL：TROUPE_TEST_PG_URL 门控；CI pg-required leg 必跑。
 */
const REQUIRE_PG = process.env.TROUPE_REQUIRE_PG === "1";
const PG_URL = process.env.TROUPE_TEST_PG_URL;

describe.runIf(REQUIRE_PG && !PG_URL)("PG 门禁（stream consumer）", () => {
  it("TROUPE_REQUIRE_PG=1 但未提供 TROUPE_TEST_PG_URL：拒绝静默跳过", () => {
    throw new Error("缺少 TROUPE_TEST_PG_URL：StreamConsumer 契约在 CI 必跑（ROADMAP P0-7）");
  });
});

describe.runIf(!!PG_URL)("StreamConsumer 契约（真实 PostgreSQL）", () => {
  const store: StreamStore = new PostgresStreamStore(PG_URL!);
  const t = (tag: string) => `con_${tag}_${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

  afterAll(async () => {
    await store.close?.();
  });

  const appendN = async (topic: string, n: number, from = 1): Promise<void> => {
    for (let i = from; i < from + n; i++) await store.append(topic, { i });
  };

  it("断点续传：消费者重启（同 consumer id）后从游标继续，只投递新事件", async () => {
    const topic = t("resume");
    await appendN(topic, 3);
    const seen: number[] = [];
    const c1 = new StreamConsumer({
      store, topic, consumer: "app-1", pollIntervalMs: 0,
      deliver: async (m: StreamMessage) => seen.push(m.seq),
    });
    expect(await c1.pollOnce()).toBe(3);
    expect(seen).toEqual([1, 2, 3]);

    // 新事件入流；模拟重启：新实例 + 同 consumer id（lastDeliveredSeq 归零）
    await appendN(topic, 2, 4);
    const c2 = new StreamConsumer({
      store, topic, consumer: "app-1", pollIntervalMs: 0,
      deliver: async (m: StreamMessage) => seen.push(m.seq),
    });
    expect(await c2.pollOnce()).toBe(2);
    expect(seen).toEqual([1, 2, 3, 4, 5]); // 从游标继续，不重投旧事件
  });

  it("失败不 ack：deliver 抛错游标不推进，恢复后从失败条重投（at-least-once）", async () => {
    const topic = t("fail");
    await appendN(topic, 3);
    const seen: number[] = [];
    let failOn = 2;
    const consumer = new StreamConsumer({
      store, topic, consumer: "flaky", pollIntervalMs: 0,
      deliver: async (m) => {
        if (m.seq === failOn) throw new Error(`deliver 失败：seq=${m.seq}`);
        seen.push(m.seq);
      },
    });
    // 第一拍：seq1 成功、seq2 抛错 → 批次中止（seq3 未投递）
    await expect(consumer.pollOnce()).rejects.toThrow(/seq=2/);
    expect(seen).toEqual([1]);
    expect(await store.cursor(topic, "flaky")).toMatchObject({ ackedSeq: 1 });

    // 恢复：从 seq2 重投（at-least-once）
    failOn = 0;
    expect(await consumer.pollOnce()).toBe(2);
    expect(seen).toEqual([1, 2, 3]);
    expect(await store.cursor(topic, "flaky")).toMatchObject({ ackedSeq: 3 });
  });

  it("会话内去重：已交付区间不回读（同实例 replay 后不重投）；跨会话重投属 at-least-once", async () => {
    const topic = t("dup");
    await appendN(topic, 2);
    const delivered: number[] = [];
    const consumer = new StreamConsumer({
      store, topic, consumer: "dedup", pollIntervalMs: 0,
      deliver: async (m) => delivered.push(m.seq),
    });
    await consumer.pollOnce();
    expect(delivered).toEqual([1, 2]);

    // 同实例 + 游标被回拨（模拟 ack 丢失）：会话内 lastDeliveredSeq 使 poll 直接从
    // max(acked, lastDelivered) 之后拉取——已交付区间根本不回读（比逐条判重更省）
    await store.replay(topic, "dedup", 0);
    expect(await consumer.pollOnce()).toBe(0);
    expect(delivered).toEqual([1, 2]); // 业务只执行一次

    // 跨会话（新实例，lastDeliveredSeq 归零）+ 回拨后的游标 → 重投两次（at-least-once，
    // 业务按 eventId/幂等键吸收——框架不承诺 exactly-once，ADR 0005 §6）
    const c2 = new StreamConsumer({
      store, topic, consumer: "dedup", pollIntervalMs: 0,
      deliver: async (m) => delivered.push(m.seq),
    });
    expect(await c2.pollOnce()).toBe(2);
    expect(delivered).toEqual([1, 2, 1, 2]);
  });

  it("consumer 间独立：故障消费者不影响同 topic 其他 consumer 的游标推进", async () => {
    const topic = t("indep");
    await appendN(topic, 3);
    const broken = new StreamConsumer({
      store, topic, consumer: "broken", pollIntervalMs: 0,
      deliver: async () => {
        throw new Error("always fail");
      },
    });
    const healthy: number[] = [];
    const ok = new StreamConsumer({
      store, topic, consumer: "ok", pollIntervalMs: 0,
      deliver: async (m) => healthy.push(m.seq),
    });
    await expect(broken.pollOnce()).rejects.toThrow("always fail");
    expect(await ok.pollOnce()).toBe(3);
    expect(healthy).toEqual([1, 2, 3]);
    // broken 从未成功 ack（游标不存在）；ok 独立推进到 3
    expect(await store.cursor(topic, "broken")).toBeNull();
    expect(await store.cursor(topic, "ok")).toMatchObject({ ackedSeq: 3 });
    // broken 恢复后仍可独立追平（事件未被他人消费掉——流按 topic 保留）
    expect((await store.read(topic, 0, 10)).length).toBe(3);
  });
});
