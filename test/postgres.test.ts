import { afterAll, describe, expect, it } from "vitest";
import { ConflictError } from "../src/index.js";
import { PostgresPropStore } from "../src/props/postgres.js";
import { wrapEnvelope } from "../src/core/envelope.js";

/**
 * PostgresPropStore 验收（节点级共享存储 + 所有权，DESIGN §7.2/§6.5）。
 * 需要本地 Postgres：默认尝试 postgres://postgres:postgres@127.0.0.1:5432/postgres，
 * 可用 TROUPE_TEST_PG=postgres://user:pass@host:5432/db 指定；不可用时整组跳过。
 */
const conn =
  process.env.TROUPE_TEST_PG ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const schema = `troupe_test_${Date.now()}`;
const store = new PostgresPropStore(conn, schema);

let pgOk = false;
try {
  await store.read("ns", "ping", "ping");
  pgOk = true;
} catch (e) {
  console.log(
    `[postgres] 本机 PG 不可达（${e instanceof Error ? e.message.slice(0, 60) : e}），跳过该组测试；` +
      `TROUPE_TEST_PG=postgres://… 可启用`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!pgOk)("M3 验收：PostgresPropStore（行级 CAS + 所有权 + fencing）", () => {
  it("create/read/write 往返与 CAS 冲突", async () => {
    await store.create("ns", "Cart", "u1", wrapEnvelope({ a: 1 }, {}), 1);
    const w = await store.write("ns", "Cart", "u1", wrapEnvelope({ a: 2 }, {}), {
      expectedRevision: 1,
      schemaVersion: 1,
    });
    expect(w.revision).toBe(2);
    const err = await store
      .write("ns", "Cart", "u1", wrapEnvelope({}, {}), { expectedRevision: 99, schemaVersion: 1 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((await store.read("ns", "Cart", "u1"))!.revision).toBe(2);
  });

  it("所有权：acquire/续租/顶替/release 保序（epoch 单调）", async () => {
    const a1 = await store.acquire("ns", "Cart", "u2", "pg-A", 5_000);
    expect(a1).toEqual({ ok: true, epoch: 1, leaseUntil: expect.any(Number) });
    const b1 = await store.acquire("ns", "Cart", "u2", "pg-B", 5_000);
    expect(b1).toMatchObject({ ok: false, holder: { ownerId: "pg-A" } });
    expect(await store.acquire("ns", "Cart", "u2", "pg-A", 5_000)).toEqual({ ok: true, epoch: 1, leaseUntil: expect.any(Number) }); // 续租
    expect(await store.release("ns", "Cart", "u2", "pg-A", 1)).toBe(true);
    expect(await store.acquire("ns", "Cart", "u2", "pg-B", 5_000)).toEqual({ ok: true, epoch: 2, leaseUntil: expect.any(Number) }); // 顶替
  });

  it("fencing：旧 token 写入被拒（单语句原子校验）", async () => {
    await store.create("ns", "Cart", "u3", wrapEnvelope({ items: [] }, {}), 1);
    await store.acquire("ns", "Cart", "u3", "pg-A", 60); // 短租约
    await store.write("ns", "Cart", "u3", wrapEnvelope({ items: ["x"] }, {}), {
      expectedRevision: 1,
      schemaVersion: 1,
      fencingToken: 1,
    });
    await sleep(120); // 租约过期
    expect(await store.acquire("ns", "Cart", "u3", "pg-B", 10_000)).toEqual({ ok: true, epoch: 2, leaseUntil: expect.any(Number) });
    const err = await store
      .write("ns", "Cart", "u3", wrapEnvelope({ items: ["stale"] }, {}), {
        expectedRevision: 2,
        schemaVersion: 1,
        fencingToken: 1, // 旧持有者
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toMatch(/fencing 拒绝/);
    // 新 token 可写
    await store.write("ns", "Cart", "u3", wrapEnvelope({ items: ["x", "b"] }, {}), {
      expectedRevision: 2,
      schemaVersion: 1,
      fencingToken: 2,
    });
  });

  afterAll(async () => {
    if (!pgOk) return;
    // 清理测试 schema
    const c = (await (store as unknown as { client(): Promise<never> }).client()) as unknown as {
      query(s: string): Promise<unknown>;
      release(): void;
    };
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
    c.release();
    await store.close();
  });
});
