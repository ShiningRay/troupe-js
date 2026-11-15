import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PostgresPropStore } from "../src/props/postgres.js";
import { SqlitePropStore } from "../src/props/sqlite.js";
import type { DirectoryStore } from "../src/props/directory.js";

/**
 * DirectoryStore 契约测试（ROADMAP P1-2，ADR 0004 §6）：
 * claim 竞争、过期顶替、release、version 单调、status 维护、listOwned 前缀扫描。
 * SQLite 本地必跑；PG 由 TROUPE_TEST_PG_URL 门控（CI pg-required leg 必跑）。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REQUIRE_PG = process.env.TROUPE_REQUIRE_PG === "1";
const PG_URL = process.env.TROUPE_TEST_PG_URL;

/** 两家 Provider 共用同一套契约（P2-6 的 Provider 合同测试前置形态） */
function contractSuite(name: string, makeStore: () => { store: DirectoryStore; done: () => Promise<void> }) {
  describe(name, () => {
    it("claim：首次 epoch=1/version=1；他人被拒返回持有者；本人续租 epoch 不变 version+1", async () => {
      const { store, done } = makeStore();
      try {
        const a1 = await store.claim("ns", "Cart", "u1", "stage-A", 10_000);
        expect(a1).toMatchObject({ ok: true, epoch: 1, version: 1 });
        const b1 = await store.claim("ns", "Cart", "u1", "stage-B", 10_000);
        expect(b1.ok).toBe(false);
        if (!b1.ok) {
          // PG adapter 的身份带套件隔离前缀——用 stringContaining 兼容两种形态
        expect(b1.holder).toMatchObject({ ownerId: expect.stringContaining("stage-A"), epoch: 1, status: "active" });
        }
        const a2 = await store.claim("ns", "Cart", "u1", "stage-A", 10_000);
        expect(a2).toMatchObject({ ok: true, epoch: 1, version: 2 });
      } finally {
        await done();
      }
    });

    it("过期顶替：epoch+1、version 单调递增、status 回 active", async () => {
      const { store, done } = makeStore();
      try {
        const a1 = await store.claim("ns", "Cart", "u1", "stage-A", 60);
        expect(a1.ok).toBe(true);
        await sleep(90);
        const b = await store.claim("ns", "Cart", "u1", "stage-B", 10_000);
        expect(b).toMatchObject({ ok: true, epoch: 2 });
        if (b.ok) expect(b.version).toBeGreaterThan((a1 as { version: number }).version);
        const rec = await store.lookup("ns", "Cart", "u1");
        expect(rec).toMatchObject({ ownerId: expect.stringContaining("stage-B"), epoch: 2, status: "active" });
      } finally {
        await done();
      }
    });

    it("release：仅 owner+epoch 匹配生效；成功后 status=draining、租约清零、version+1", async () => {
      const { store, done } = makeStore();
      try {
        const a = await store.claim("ns", "Cart", "u2", "stage-A", 10_000);
        if (!a.ok) throw new Error("claim 应成功");
        expect(await store.release("ns", "Cart", "u2", "stage-B", a.epoch)).toBe(false);
        expect(await store.release("ns", "Cart", "u2", "stage-A", a.epoch + 99)).toBe(false);
        const before = await store.lookup("ns", "Cart", "u2");
        expect(await store.release("ns", "Cart", "u2", "stage-A", a.epoch)).toBe(true);
        const after = await store.lookup("ns", "Cart", "u2");
        expect(after).toMatchObject({ status: "draining", leaseUntil: 0 });
        expect(after!.version).toBe(before!.version + 1);
      } finally {
        await done();
      }
    });

    it("bumpVersion：无条件 +1；条目缺失返回 null", async () => {
      const { store, done } = makeStore();
      try {
        expect(await store.bumpVersion("ns", "Cart", "missing")).toBeNull();
        await store.claim("ns", "Cart", "u3", "stage-A", 10_000);
        const v1 = await store.bumpVersion("ns", "Cart", "u3");
        const v2 = await store.bumpVersion("ns", "Cart", "u3");
        expect(v2!).toBe(v1! + 1);
        const rec = await store.lookup("ns", "Cart", "u3");
        expect(rec!.version).toBe(v2);
      } finally {
        await done();
      }
    });

    it("并发 claim 只有一个成功，失败方看到同一持有者", async () => {
      const { store, done } = makeStore();
      try {
        const results = await Promise.all(
          ["A", "B", "C", "D"].map((o) => store.claim("ns", "Cart", "hot", `stage-${o}`, 10_000)),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        const losers = results.filter((r) => !r.ok) as Array<{ holder: { ownerId: string } }>;
        expect(new Set(losers.map((r) => r.holder.ownerId.replace(/^test:[^s]*/, "")))).toHaveLength(1);
      } finally {
        await done();
      }
    });

    it("listOwned：按 owner 地址前缀扫描（重启恢复用）", async () => {
      const { store, done } = makeStore();
      try {
        await store.claim("ns", "Cart", "k1", "127.0.0.1:7000#111", 10_000);
        await store.claim("ns", "Cart", "k2", "127.0.0.1:7000#222", 10_000);
        await store.claim("ns", "Cart", "k3", "127.0.0.1:8000#333", 10_000);
        const owned = await store.listOwned("127.0.0.1:7000");
        expect(owned.map((r) => r.stageName).sort()).toEqual(["k1", "k2"]);
        expect(owned.every((r) => r.status === "active")).toBe(true);
      } finally {
        await done();
      }
    });
  });
}

contractSuite("DirectoryStore 契约（SQLite，同机）", () => {
  const store = new SqlitePropStore(mkdtempSync(join(tmpdir(), "troupe-dir-")));
  return { store, done: async () => {} };
});

if (PG_URL) {
  contractSuite("DirectoryStore 契约（PostgreSQL，节点级）", () => {
    const store = new PostgresPropStore(PG_URL!);
    // 每组契约用独立 namespace 隔离（store 共享连接池；listOwned 的地址前缀不含 namespace，
    // 用带 ns 的 owner 地址保证扫描隔离）
    const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    const ns = `dir_${suffix}`;
    const addr = `test:${suffix}`;
    const isolated: DirectoryStore = {
      claim: (_n, r, s, o, l) => store.claim(ns, r, s, `${addr}${o}`, l),
      lookup: (_n, r, s) => store.lookup(ns, r, s),
      release: (_n, r, s, o, e) => store.release(ns, r, s, `${addr}${o}`, e),
      bumpVersion: (_n, r, s) => store.bumpVersion(ns, r, s),
      listOwned: (p) => store.listOwned(`${addr}${p}`),
    };
    return { store: isolated, done: () => store.close() };
  });
}

// REQUIRE_PG=1 且缺失 URL：拒绝静默跳过（与 ownership-fencing 同一规则，P0-7）
describe.runIf(REQUIRE_PG && !PG_URL)("PG 门禁（directory）", () => {
  it("TROUPE_REQUIRE_PG=1 但未提供 TROUPE_TEST_PG_URL：拒绝静默跳过", () => {
    throw new Error("缺少 TROUPE_TEST_PG_URL：DirectoryStore PG 契约在 CI 必跑（ROADMAP P0-7）");
  });
});
