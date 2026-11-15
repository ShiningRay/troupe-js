import { describe, expect, it } from "vitest";
import { DirectoryRouter, type DirectoryRouterDeps } from "../src/cluster/directory-router.js";
import type {
  DirectoryClaimResult,
  DirectoryRecord,
  DirectoryStore,
} from "../src/props/directory.js";

/** 可编程 fake：记录调用计数，lookup/claim 行为按测试注入 */
class FakeDirectoryStore implements DirectoryStore {
  lookups = 0;
  claims = 0;
  lastClaimOwner = "";
  lookupFn: (ns: string, r: string, s: string) => DirectoryRecord | null = () => null;
  claimFn: (ns: string, r: string, s: string, o: string, l: number) => DirectoryClaimResult = () => {
    throw new Error("claim not configured");
  };

  async claim(_ns: string, r: string, s: string, o: string, l: number) {
    this.claims++;
    this.lastClaimOwner = o;
    return this.claimFn(_ns, r, s, o, l);
  }
  async lookup(ns: string, r: string, s: string) {
    this.lookups++;
    return this.lookupFn(ns, r, s);
  }
  async release() {
    return true;
  }
  async bumpVersion() {
    return null;
  }
  async listOwned() {
    return [];
  }
}

function rec(over: Partial<DirectoryRecord>): DirectoryRecord {
  return {
    namespace: "ns",
    roleId: "Cart",
    stageName: "k1",
    ownerId: "127.0.0.1:1#a",
    epoch: 1,
    leaseUntil: 10_000,
    version: 1,
    status: "active",
    ...over,
  };
}

function makeRouter(store: FakeDirectoryStore, over: Partial<DirectoryRouterDeps> = {}) {
  let t = 1_000;
  const deps: DirectoryRouterDeps = {
    store,
    namespace: "ns",
    selfAddr: "127.0.0.1:1",
    selfId: "127.0.0.1:1#a",
    leaseMs: 3_000,
    candidates: () => ["127.0.0.1:1"],
    now: () => t,
    ...over,
  };
  const router = new DirectoryRouter(deps);
  return { router, deps, advance: (ms: number) => (t += ms) };
}

describe("DirectoryRouter（ADR 0004 §3）：缓存 → 回源 → claim → 重读", () => {
  it("缓存命中：一次回源后重复 resolve 不再查目录；invalidateAll 后必须回源", async () => {
    const store = new FakeDirectoryStore();
    store.lookupFn = () => rec({ ownerId: "127.0.0.1:2#b" });
    const { router } = makeRouter(store);
    const r1 = await router.resolveOwner("Cart", "k1");
    expect(r1).toEqual({ addr: "127.0.0.1:2", self: false });
    expect(store.lookups).toBe(1);
    await router.resolveOwner("Cart", "k1");
    expect(store.lookups).toBe(1); // 缓存命中
    expect(router.stats().hits).toBe(1);

    router.invalidateAll();
    await router.resolveOwner("Cart", "k1");
    expect(store.lookups).toBe(2); // 成员变更失效 → 回源
  });

  it("TTL 过期 → 回源；缓存过期不会把路由发给已释放 owner（租约清零 → 走 claim 路径）", async () => {
    const store = new FakeDirectoryStore();
    store.lookupFn = () => rec({ ownerId: "127.0.0.1:2#b" });
    const { router, advance } = makeRouter(store);
    await router.resolveOwner("Cart", "k1");
    advance(4_000); // > TTL（leaseMs/3 = 1000）
    store.lookupFn = () => null; // 目录条目已被释放/删除
    store.claimFn = (_n, _r, _s, o) => ({ ok: true, epoch: 1, leaseUntil: 99_000, version: 1 }) as DirectoryClaimResult & { owner: string };
    const r = await router.resolveOwner("Cart", "k1");
    // 本节点是首候选 → 冷键 claim 成功 → 路由给自己（绝不发给已释放 owner）
    expect(r).toEqual({ addr: "127.0.0.1:1", self: true });
    expect(store.lastClaimOwner).toBe("127.0.0.1:1#a");
  });

  it("环与目录不一致时以目录为准（候选说 self，目录说 other）", async () => {
    const store = new FakeDirectoryStore();
    store.lookupFn = () => rec({ ownerId: "127.0.0.1:9#z" });
    const { router } = makeRouter(store); // candidates 默认 self
    const r = await router.resolveOwner("Cart", "k1");
    expect(r).toEqual({ addr: "127.0.0.1:9", self: false });
    expect(store.claims).toBe(0); // 目录有有效条目：不 claim
  });

  it("冷键：无条目 + self 是首候选 → claim 成功路由自己；claim 落败 → 重读目录以目录为准", async () => {
    const store = new FakeDirectoryStore();
    store.lookupFn = () => null;
    store.claimFn = (_n, _r, _s, o) =>
      o === "127.0.0.1:1#a"
        ? { ok: true, epoch: 1, leaseUntil: 99_000, version: 1 }
        : { ok: false, holder: rec({ ownerId: "127.0.0.1:2#b", epoch: 3 }) };
    const { router } = makeRouter(store);
    expect(await router.resolveOwner("Cart", "cold")).toEqual({ addr: "127.0.0.1:1", self: true });

    // 落败场景：self 非持有者（首查无条目；claim 落败后目录已有持有者——重读以目录为准）
    const store2 = new FakeDirectoryStore();
    let lookups2 = 0;
    store2.lookupFn = () => (++lookups2 === 1 ? null : rec({ ownerId: "127.0.0.1:2#b", epoch: 3, leaseUntil: 50_000 }));
    store2.claimFn = () => ({ ok: false, holder: rec({ ownerId: "127.0.0.1:2#b", epoch: 3, leaseUntil: 50_000 }) });
    const { router: router2 } = makeRouter(store2);
    const r = await router2.resolveOwner("Cart", "cold2");
    expect(r).toEqual({ addr: "127.0.0.1:2", self: false }); // 重读目录，不猜
  });

  it("非首候选不抢冷键：转发给首候选（由它 claim）；环视图为空才返回 null", async () => {
    const store = new FakeDirectoryStore();
    store.lookupFn = () => null;
    const { router } = makeRouter(store, { candidates: () => ["127.0.0.1:9"] });
    const r = await router.resolveOwner("Cart", "cold");
    expect(r).toEqual({ addr: "127.0.0.1:9", self: false }); // 转给首候选，路由有进展
    expect(store.claims).toBe(0); // 非首候选不发起 claim

    const { router: router2 } = makeRouter(store, { candidates: () => [] });
    expect(await router2.resolveOwner("Cart", "cold")).toBeNull(); // 无环视图：可重试拒绝
  });

  it("draining 且租约仍有效 → 仍路由旧 owner（交接中继续服务）；tombstone → 走 claim 重建", async () => {
    const store = new FakeDirectoryStore();
    store.lookupFn = () => rec({ status: "draining", ownerId: "127.0.0.1:3#c" });
    const { router } = makeRouter(store);
    expect(await router.resolveOwner("Cart", "d1")).toEqual({ addr: "127.0.0.1:3", self: false });

    const store2 = new FakeDirectoryStore();
    store2.lookupFn = () => rec({ status: "tombstone", ownerId: "127.0.0.1:3#c" });
    store2.claimFn = (_n, _r, _s, o) =>
      o === "127.0.0.1:1#a" ? { ok: true, epoch: 5, leaseUntil: 99_000, version: 9 } : { ok: false, holder: rec({ ownerId: "127.0.0.1:3#c" }) };
    const { router: router2 } = makeRouter(store2);
    expect(await router2.resolveOwner("Cart", "t1")).toEqual({ addr: "127.0.0.1:1", self: true });
    expect(store2.claims).toBe(1);
  });
});
