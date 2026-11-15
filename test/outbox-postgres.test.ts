import { afterAll, describe, expect, it } from "vitest";
import { PostgresPropStore } from "../src/props/postgres.js";
import { PostgresOutboxStore } from "../src/streams/outbox.js";
import { ConflictError } from "../src/index.js";

/**
 * Outbox/Inbox 契约（ADR 0005 §4，ROADMAP P2-4）：
 * Props+Outbox 同事务（提交后必存在/失败整体回滚）、dispatcher SKIP LOCKED + lease
 * （宕机重派）、退避重试与 dead-letter、Inbox 接收方幂等。
 * 需要 PostgreSQL：TROUPE_TEST_PG_URL 门控；CI pg-required leg 必跑。
 */
const REQUIRE_PG = process.env.TROUPE_REQUIRE_PG === "1";
const PG_URL = process.env.TROUPE_TEST_PG_URL;

describe.runIf(REQUIRE_PG && !PG_URL)("PG 门禁（outbox）", () => {
  it("TROUPE_REQUIRE_PG=1 但未提供 TROUPE_TEST_PG_URL：拒绝静默跳过", () => {
    throw new Error("缺少 TROUPE_TEST_PG_URL：Outbox 契约在 CI 必跑（ROADMAP P0-7）");
  });
});

describe.runIf(!!PG_URL)("PostgresOutboxStore 契约（真实 PostgreSQL）", () => {
  const propStore = new PostgresPropStore(PG_URL!);
  const outbox = new PostgresOutboxStore(PG_URL!);
  const ns = `outbox_${Date.now()}_${process.pid}`;
  const t = (tag: string) => `ob_${tag}_${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  afterAll(async () => {
    await outbox.close();
    await propStore.close();
  });

  it("同事务验收：Props 提交后 outbox 必存在；outbox 失败 → Props 回滚", async () => {
    const topic = t("tx");
    const { props, eventId } = await outbox.publishWithProps(propStore, topic, { hello: 1 }, {
      eventId: "evt-tx-1",
      props: {
        namespace: ns, roleId: "R", stageName: "s1", props: { items: [1] },
        create: { schemaVersion: 1 },
      },
    });
    expect(props?.revision).toBe(1);
    expect(eventId).toBe("evt-tx-1");
    // Props 提交后 outbox 必存在（同事务两侧都可读）
    expect((await propStore.read(ns, "R", "s1"))?.revision).toBe(1);
    const claimed = await outbox.claimBatch("w1", 10, 60_000);
    expect(claimed.map((m) => m.eventId)).toContain("evt-tx-1");

    // 失败回滚：CAS revision 不匹配 → 整个事务回滚，outbox 无新增、Props 未被写
    const before = await outbox.stats();
    await expect(
      outbox.publishWithProps(propStore, topic, { hello: 2 }, {
        eventId: "evt-tx-2",
        props: {
          namespace: ns, roleId: "R", stageName: "s1", props: { items: [2] },
          write: { expectedRevision: 99, schemaVersion: 1 },
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await outbox.stats();
    expect(after).toEqual(before); // outbox 无新增（事务回滚）
    expect((await propStore.read(ns, "R", "s1"))?.revision).toBe(1); // Props 未被写
  });

  it("dispatcher：claim 唯一租约、宕机（不 markDone）租约到期后重派、markDone/markRetry/dead-letter", async () => {
    const topic = t("dispatch");
    for (let i = 1; i <= 3; i++) await outbox.append(topic, { i });

    // 两 worker 竞争：无重复派发
    const [w1, w2] = await Promise.all([
      outbox.claimBatch("w1", 10, 80), // 短租约：模拟宕机不 markDone
      outbox.claimBatch("w2", 10, 60_000),
    ]);
    expect(w1).toHaveLength(3);
    expect(w2).toHaveLength(0); // SKIP LOCKED + 已租约：不重复派发

    // 宕机重派：w1 未 markDone → 80ms 租约到期 → 可重新 claim
    await sleep(100);
    const reclaimed = await outbox.claimBatch("w3", 10, 60_000);
    expect(reclaimed).toHaveLength(3);
    expect(reclaimed.every((m) => m.attempts === 0)).toBe(true); // 重派不计失败

    // 成功路径
    for (const m of reclaimed.slice(0, 2)) await outbox.markDone(m.id);
    // 失败路径：退避（1s 内不可再 claim），attempts+1
    const failing = reclaimed[2]!;
    await outbox.markRetry(failing.id, new Error("downstream down"));
    expect(await outbox.claimBatch("w3", 10, 60_000)).toHaveLength(0); // 退避期内
    await sleep(1_100);
    const retried = await outbox.claimBatch("w3", 10, 60_000);
    expect(reclaimed.map((m) => m.id)).toContain(retried[0]!.id);
    expect(retried[0]!.attempts).toBe(1);
    await outbox.markDone(retried[0]!.id);

    // dead-letter：maxAttempts=1 的 store，一次失败即 dead
    const strict = new PostgresOutboxStore(PG_URL!, "public", 1);
    const dt = t("dead");
    await strict.append(dt, { x: 1 });
    const [m] = await strict.claimBatch("wx", 10, 60_000);
    const res = await strict.markRetry(m!.id, new Error("fail once"));
    expect(res.dead).toBe(true);
    expect((await strict.stats()).dead).toBe(1);
    expect(await strict.claimBatch("wx", 10, 60_000)).toHaveLength(0); // dead 不再派发
    await strict.close();
  });

  it("Inbox 接收方幂等：同 eventId 只处理一次；重复不产生二次副作用", async () => {
    const topic = t("inbox");
    const eventId = "evt-inbox-1";
    let sideEffects = 0;
    const processMessage = async (): Promise<void> => {
      // 接收方：Inbox 记录与业务处理同事务语义——recordIfNew=false 即跳过
      const isNew = await outbox.recordIfNew(topic, eventId);
      if (!isNew) return;
      sideEffects += 1;
    };
    await processMessage();
    await processMessage(); // 重复投递
    expect(sideEffects).toBe(1);
    // 消费者两实例并发投递同 eventId：恰一个首次
    const results = await Promise.all([
      outbox.recordIfNew(topic, "evt-inbox-2"),
      outbox.recordIfNew(topic, "evt-inbox-2"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
