import { afterAll, describe, expect, it } from "vitest";
import { PostgresCueStore } from "../src/cues/postgres.js";
import type { CueStore } from "../src/cues/cue-store.js";

/**
 * PostgresCueStore 契约（ROADMAP P1-5）：
 * upsert/ensure/due/claim/complete/list + 两进程竞争唯一胜者 + 时区字段持久化。
 * 需要 PostgreSQL：TROUPE_TEST_PG_URL 门控；CI pg-required leg 必跑。
 */
const REQUIRE_PG = process.env.TROUPE_REQUIRE_PG === "1";
const PG_URL = process.env.TROUPE_TEST_PG_URL;

describe.runIf(REQUIRE_PG && !PG_URL)("PG 门禁（cues）", () => {
  it("TROUPE_REQUIRE_PG=1 但未提供 TROUPE_TEST_PG_URL：拒绝静默跳过", () => {
    throw new Error("缺少 TROUPE_TEST_PG_URL：PostgresCueStore 契约在 CI 必跑（ROADMAP P0-7）");
  });
});

describe.runIf(!!PG_URL)("PostgresCueStore 契约（真实 PostgreSQL）", () => {
  const stores: PostgresCueStore[] = [];
  const ns = `cue_${Date.now()}_${process.pid}`;

  function make(): CueStore {
    const s = new PostgresCueStore(PG_URL!);
    stores.push(s);
    return s;
  }
  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()));
  });

  it("upsert/ensure/due/claim/complete 往返", async () => {
    const store = make();
    await store.ensure({ namespace: ns, roleId: "A", stageName: "s1", name: "tick", payload: { n: 1 }, everyMs: 1_000, at: null, cron: null, timeZone: null, nextDue: 1_000 });
    // ensure 幂等：重复登记不改 nextDue
    await store.ensure({ namespace: ns, roleId: "A", stageName: "s1", name: "tick", payload: { n: 2 }, everyMs: 1_000, at: null, cron: null, timeZone: null, nextDue: 99_000 });
    const due = await store.due(2_000, 10);
    expect(due.map((r) => r.name)).toContain("tick");
    const claimed = await store.claim({ namespace: ns, roleId: "A", stageName: "s1", name: "tick" }, "owner-1", 99_999, 2_000);
    expect(claimed).toMatchObject({ owner: "owner-1", statusVersion: 2 });
    // 租约期内不可再 claim
    expect(await store.claim({ namespace: ns, roleId: "A", stageName: "s1", name: "tick" }, "owner-2", 99_999, 2_000)).toBeNull();
    // complete CAS：旧 statusVersion 失败，新版本成功
    expect(await store.complete({ namespace: ns, roleId: "A", stageName: "s1", name: "tick" }, 1, 102_000)).toBe(false);
    expect(await store.complete({ namespace: ns, roleId: "A", stageName: "s1", name: "tick" }, 2, 102_000)).toBe(true);
    const list = await store.list(ns);
    expect(list.find((r) => r.name === "tick")).toMatchObject({ nextDue: 102_000, owner: null });
  });

  it("两进程竞争 claim：唯一胜者（SKIP LOCKED + CAS）", async () => {
    const s1 = make();
    const s2 = make();
    await s1.upsert({ namespace: ns, roleId: "A", stageName: "race", name: "r", payload: null, everyMs: 1_000, at: null, cron: null, timeZone: null, nextDue: 1_000 });
    const key = { namespace: ns, roleId: "A", stageName: "race", name: "r" };
    const [x, y] = await Promise.all([s1.claim(key, "p1", 99_999, 2_000), s2.claim(key, "p2", 99_999, 2_000)]);
    const winners = [x, y].filter((v) => v !== null);
    expect(winners).toHaveLength(1);
    // 租约释放后另一方可接管（statusVersion 递增）
    const winner = winners[0]!;
    await s1.complete(key, winner.statusVersion, 1_500); // nextDue 回到过去 → 再次到期
    const again = await s2.claim(key, "p2", 99_999, 2_000);
    expect(again).toMatchObject({ owner: "p2" });
  });

  it("时区字段持久化与注销竞争（statusVersion CAS）", async () => {
    const store = make();
    await store.upsert({ namespace: ns, roleId: "A", stageName: "tz", name: "daily", payload: null, everyMs: null, at: null, cron: "0 9 * * *", timeZone: "Asia/Shanghai", nextDue: 50_000 });
    const claimed = await store.claim({ namespace: ns, roleId: "A", stageName: "tz", name: "daily" }, "o", 99_999, 1_000);
    expect(claimed?.timeZone).toBe("Asia/Shanghai");
    const sv = claimed!.statusVersion;
    // 注销与 complete 竞争：注销后旧 statusVersion 的 complete 失效
    expect(await store.delete({ namespace: ns, roleId: "A", stageName: "tz", name: "daily" })).toBe(true);
    expect(await store.complete({ namespace: ns, roleId: "A", stageName: "tz", name: "daily" }, sv, 60_000)).toBe(false);
    expect(await store.list(ns).then((l) => l.some((r) => r.name === "daily"))).toBe(false);
  });
});
