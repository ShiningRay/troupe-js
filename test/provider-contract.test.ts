import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, InMemoryPropStore, SqlitePropStore } from "../src/index.js";
import { InMemoryCueStore, SqliteCueStore } from "../src/index.js";
import { PostgresPropStore } from "../src/props/postgres.js";
import type { StoreCapabilities } from "../src/props/capabilities.js";
import type { PropStore } from "../src/props/prop-store.js";
import type { CueStore } from "../src/cues/cue-store.js";

/**
 * Provider 合同测试（ADR 0002 §8 + ADR 0005 §7，ROADMAP P2-6）：
 * Memory/SQLite/PG 跑同一套契约（capability 感知——声明不支持的能力不做要求，
 * 但声明与实际行为必须一致）。新增 Provider 必须过本合同。
 * PG 由 TROUPE_TEST_PG_URL 门控；CI pg-required leg 必跑。
 */
const REQUIRE_PG = process.env.TROUPE_REQUIRE_PG === "1";
const PG_URL = process.env.TROUPE_TEST_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PropStoreFactory {
  name: string;
  caps: StoreCapabilities;
  make: () => PropStore;
  done: () => Promise<void>;
  /** ownership 语义（InMemory 无 OwnershipStore——fencing 契约不适用） */
  supportsOwnership: boolean;
}

const factories: PropStoreFactory[] = [
  {
    name: "InMemoryPropStore",
    caps: { crossNodeSafe: false, supportsFencing: false },
    supportsOwnership: false,
    make: () => new InMemoryPropStore(),
    done: async () => {},
  },
  {
    name: "SqlitePropStore",
    caps: { crossNodeSafe: false, supportsFencing: true, supportsTransactions: true },
    supportsOwnership: true,
    make: () => new SqlitePropStore(mkdtempSync(join(tmpdir(), "troupe-contract-"))),
    done: async () => {},
  },
];
if (PG_URL) {
  factories.push({
    name: "PostgresPropStore",
    caps: { crossNodeSafe: true, supportsFencing: true, supportsTransactions: true },
    supportsOwnership: true,
    make: () => new PostgresPropStore(PG_URL!),
    done: async () => {},
  });
}

const NS = `contract_${Date.now()}_${process.pid}`;
let seq = 0;
const uniq = (tag: string) => `${tag}_${++seq}_${Math.floor(Math.random() * 1e9)}`;

for (const f of factories) {
  describe(`PropStore 合同（${f.name}）`, () => {
    let store: PropStore;
    beforeEach(() => {
      store = f.make();
    });
    afterAll(async () => {
      await f.done();
    });

    it("capabilities 与白名单一致（ADR 0002 §8：声明即合同）", () => {
      expect(store.capabilities).toEqual(f.caps);
    });

    it("create 往返；重复 create → ConflictError(kind=exists)", async () => {
      const k = uniq("create");
      const created = await store.create(NS, "Cart", k, { v: 1 }, 1);
      expect(created).toEqual({ props: { v: 1 }, revision: 1, schemaVersion: 1 });
      const err = await store.create(NS, "Cart", k, { v: 2 }, 1).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).kind).toBe("exists");
    });

    it("write CAS：revision 匹配 +1；不匹配 → kind=revision；记录缺失 → kind=revision", async () => {
      const k = uniq("cas");
      await store.create(NS, "Cart", k, { v: 1 }, 1);
      const bad = await store
        .write(NS, "Cart", k, { v: 2 }, { expectedRevision: 9, schemaVersion: 1 })
        .catch((e) => e);
      expect(bad).toBeInstanceOf(ConflictError);
      expect((bad as ConflictError).kind).toBe("revision");
      const okWrite = await store.write(NS, "Cart", k, { v: 2 }, { expectedRevision: 1, schemaVersion: 2 });
      expect(okWrite).toMatchObject({ revision: 2, schemaVersion: 2 });
      const missing = await store
        .write(NS, "Cart", uniq("missing"), { v: 0 }, { expectedRevision: 1, schemaVersion: 1 })
        .catch((e) => e);
      expect(missing).toBeInstanceOf(ConflictError);
      expect((missing as ConflictError).kind).toBe("revision");
    });

    const fencingIt = f.supportsOwnership && f.caps.supportsFencing ? it : it.skip;

    fencingIt("fencing（ADR 0002 I1/I3）：行缺失/租约过期/旧 epoch create 全部拒绝", async () => {
      // 归属 store 自身实现 OwnershipStore 才可造出所有权场景
      const own = store as unknown as {
        acquire(ns: string, r: string, s: string, o: string, l: number): Promise<{ ok: boolean; epoch?: number }>;
      };
      if (typeof own.acquire !== "function") {
        throw new Error("supportsFencing=true 但未实现 acquire（声明与行为不一致）");
      }
      const k = uniq("fence");

      // F3/I3：行缺失 → write 带 token 拒绝 kind=fencing
      const missing = await store
        .write(NS, "Cart", k, { v: 0 }, {
          expectedRevision: 1, schemaVersion: 1, fencingToken: 1, fencingOwner: "w",
        })
        .catch((e) => e);
      expect(missing).toBeInstanceOf(ConflictError);
      expect((missing as ConflictError).kind).toBe("fencing");

      // 先造所有权 + 记录，再令租约过期 → write 拒绝 kind=lease-expired
      const a = await own.acquire(NS, "Cart", k, "nodeA", 60);
      expect(a.ok).toBe(true);
      await store.create(NS, "Cart", k, { v: 1 }, 1, { fencingToken: (a as { epoch: number }).epoch, fencingOwner: "nodeA" });
      await sleep(90);
      const expired = await store
        .write(NS, "Cart", k, { v: 2 }, {
          expectedRevision: 1, schemaVersion: 1, fencingToken: (a as { epoch: number }).epoch, fencingOwner: "nodeA",
        })
        .catch((e) => e);
      expect(expired).toBeInstanceOf(ConflictError);
      expect((expired as ConflictError).kind).toBe("lease-expired");

      // F1/I1：他人顶替（epoch+1）后，旧 epoch 的 create 拒绝 kind=fencing
      const b = await own.acquire(NS, "Cart", k, "nodeB", 10_000);
      expect(b.ok).toBe(true);
      const stale = await store
        .create(NS, "Cart", uniq("stale"), { v: 0 }, 1, {
          fencingToken: (a as { epoch: number }).epoch, fencingOwner: "nodeA",
        })
        .catch((e) => e);
      expect(stale).toBeInstanceOf(ConflictError);
      expect((stale as ConflictError).kind).toBe("fencing");
    });

    it("无 token 写（未启用 ownership 模式）保持可用——文档标注不承诺跨节点", async () => {
      const k = uniq("plain");
      await store.create(NS, "Cart", k, { v: 1 }, 1);
      const w = await store.write(NS, "Cart", k, { v: 2 }, { expectedRevision: 1, schemaVersion: 1 });
      expect(w.revision).toBe(2);
    });
  });
}

// CueStore capability 契约（P1-5 留位 → P2-6 声明一致性）
describe("CueStore capabilities 合同", () => {
  it("InMemoryCueStore：crossNodeSafe=false", () => {
    expect(new InMemoryCueStore().capabilities.crossNodeSafe).toBe(false);
  });
  it("SqliteCueStore：crossNodeSafe=false（同机语义）", () => {
    expect(new SqliteCueStore(mkdtempSync(join(tmpdir(), "troupe-cc-"))).capabilities.crossNodeSafe).toBe(false);
  });
});

// PG 门禁（REQUIRE_PG=1 缺 URL → 拒绝静默跳过）
describe.runIf(REQUIRE_PG && !PG_URL)("PG 门禁（provider contract）", () => {
  it("TROUPE_REQUIRE_PG=1 但未提供 TROUPE_TEST_PG_URL：拒绝静默跳过", () => {
    throw new Error("缺少 TROUPE_TEST_PG_URL：PG Provider 合同在 CI 必跑（ROADMAP P0-7）");
  });
});

// PG 契约经 factories 动态注入（上方 for 循环已覆盖）；此 describe 仅校验注入成功
describe.runIf(!!PG_URL)("Provider 合同（PostgreSQL 注入确认）", () => {
  it("factories 含 PostgresPropStore", () => {
    expect(factories.some((f) => f.name === "PostgresPropStore")).toBe(true);
  });
});

// CueStore 合同占位类型引用（P2-6：新增 Provider 须同时满足 PropStore/CueStore 契约）
export type { PropStore, CueStore };
