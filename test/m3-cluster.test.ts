import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Actor, CallRejectedError, Troupe } from "../src/index.js";
import { SqlitePropStore } from "../src/props/sqlite.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 15_000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

/** 结果未知或未取得所有权（交接/租约窗口）时重试——§6.5 调用方语义 */
async function retryTransient<T>(fn: () => Promise<T>, tries = 40, backoffMs = 150): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retriable =
        (e as Error).name === "UnknownOutcomeError" ||
        (e instanceof CallRejectedError && (e.reason === "ownership" || e.reason === "drift"));
      if (i === tries - 1 || !retriable) throw e;
      await sleep(backoffMs);
    }
  }
}

class OwnCartActor extends Actor<{ items: string[] }> {
  static role = "OwnCart";
  static initialProps = () => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "troupe-m3-"));
}

interface Stage {
  troupe: Troupe;
  store: SqlitePropStore;
}

async function startStage(dir: string, seeds: string[] = [], leaseMs = 600): Promise<Stage> {
  const store = new SqlitePropStore(dir);
  const troupe = await Troupe.form({
    actors: [OwnCartActor],
    propStore: store,
    defaultIntermission: 0,
    defaultTimeout: "10s",
    cluster: { port: 0, seeds },
    ownership: { leaseMs },
  });
  return { troupe, store };
}

describe("M3 验收：kill -9 + 租约到期接管（节点级，共享 SQLite）", () => {
  it("归属 Stage 被硬杀 → 判死 → 租约到期 → 存活方以更高 epoch 接管并恢复数据", async () => {
    const dir = tmpDir();
    const a = await startStage(dir);
    const b = await startStage(dir, [a.troupe.clusterAddress()!]);
    await waitUntil(() => a.troupe.clusterMembers()!.includes(b.troupe.clusterAddress()!));

    let key = "";
    for (let i = 0; i < 1000; i++) {
      const n = `k${i}-${Math.random().toString(36).slice(2, 6)}`;
      if (a.troupe.ownerOf("OwnCart", n) === b.troupe.clusterAddress()) {
        key = n;
        break;
      }
    }
    expect(await retryTransient(() => a.troupe.cast(OwnCartActor, key).add("one"))).toBe(1);
    expect(await retryTransient(() => a.troupe.cast(OwnCartActor, key).add("two"))).toBe(2);
    const own1 = await b.store.readOwnership("default", "OwnCart", key);
    expect(own1!.ownerId).toContain(b.troupe.clusterAddress()!); // B 持有

    b.troupe.destroy(); // kill -9：无 leave、无排空、租约滞留
    await waitUntil(() => a.troupe.clusterMembers()!.length === 0, 15_000);

    // 接管：A 的激活 acquire 需等 B 的租约过期（600ms）→ retryTransient 覆盖窗口
    expect(await retryTransient(() => a.troupe.cast(OwnCartActor, key).peek())).toBe(2);
    expect(await retryTransient(() => a.troupe.cast(OwnCartActor, key).add("three"))).toBe(3);

    const own2 = await a.store.readOwnership("default", "OwnCart", key);
    expect(own2!.ownerId).toContain(a.troupe.clusterAddress()!);
    expect(own2!.epoch).toBeGreaterThan(own1!.epoch); // fencing token 单调递增
    await a.troupe.shutdown();
  }, 30_000);
});

describe("M3 验收：正常扩容交接（旧持有者排空落盘释放，无双活）", () => {
  it("新 Stage 入环 → 键漂移 → 旧持有者主动交接（排空+释放）→ 新持有者以完整 Props 接管", async () => {
    const dir = tmpDir();
    const a = await startStage(dir);
    const b = await startStage(dir, [a.troupe.clusterAddress()!]);
    await waitUntil(() => a.troupe.clusterMembers()!.length === 1);

    // 找一批归属 B 的键并写入
    const candidates: string[] = [];
    for (let i = 0; i < 2000 && candidates.length < 40; i++) {
      const n = `h${i}-${Math.random().toString(36).slice(2, 6)}`;
      if (a.troupe.ownerOf("OwnCart", n) === b.troupe.clusterAddress()) candidates.push(n);
    }
    expect(candidates.length).toBeGreaterThanOrEqual(20);
    for (const k of candidates) {
      await retryTransient(() => a.troupe.cast(OwnCartActor, k).add("seed"));
    }

    // 扩容：C 入环 → 键漂移
    const c = await startStage(dir, [a.troupe.clusterAddress()!]);
    await waitUntil(() => a.troupe.clusterMembers()!.length === 2);
    const drifted = candidates.find((k) => a.troupe.ownerOf("OwnCart", k) === c.troupe.clusterAddress()!);
    expect(drifted).toBeDefined();
    const before = await b.store.readOwnership("default", "OwnCart", drifted!);

    // 漂移键的下一次调用：B 的续租 ticker 发现不再归属 → 排空 → offStage+save → 释放
    // （期间新持有者 acquire 可能被旧租约挡住 → retryTransient 覆盖交接窗口 ≤ leaseMs）
    expect(await retryTransient(() => a.troupe.cast(OwnCartActor, drifted!).peek())).toBe(1);

    const after = await c.store.readOwnership("default", "OwnCart", drifted!);
    expect(after!.ownerId).toContain(c.troupe.clusterAddress()!);
    expect(after!.epoch).toBeGreaterThan(before!.epoch);
    // B 已释放并移除在场实例（无双活的本地证据）
    expect(b.troupe.slots().find((s) => s.stageName === drifted)).toBeUndefined();
    await a.troupe.shutdown();
    await b.troupe.shutdown();
    await c.troupe.shutdown();
  }, 30_000);
});

describe("M3 验收：production 部署模式（§6.2/§8.2）", () => {
  it("缺少显式 advertise 或 port → 拒绝启动", async () => {
    const dir = tmpDir();
    await expect(
      Troupe.form({
        actors: [OwnCartActor],
        propStore: new SqlitePropStore(dir),
        cluster: { mode: "production", port: 7901 }, // 缺 advertise
      }),
    ).rejects.toThrow(/advertise/);
    await expect(
      Troupe.form({
        actors: [OwnCartActor],
        propStore: new SqlitePropStore(dir),
        cluster: { mode: "production", advertise: "127.0.0.1:7902" }, // 缺 port
      }),
    ).rejects.toThrow(/port/);
  });

  it("所有 seeds 不可达 → 启动失败（显式要求入团）", async () => {
    const dir = tmpDir();
    await expect(
      Troupe.form({
        actors: [OwnCartActor],
        propStore: new SqlitePropStore(dir),
        cluster: {
          mode: "production",
          port: 7903,
          advertise: "127.0.0.1:7903",
          seeds: ["127.0.0.1:1"], // 不可达
        },
      }),
    ).rejects.toThrow(/入团失败/);
  });

  it("production 强制所有权：存储不支持 OwnershipStore → 拒绝", async () => {
    const { InMemoryPropStore } = await import("../src/props/memory.js");
    // 先起一个 dev 种子（满足 production 的入团要求），让失败点落在所有权检查
    const seedDir = tmpDir();
    const seed = await Troupe.form({
      actors: [OwnCartActor],
      propStore: new SqlitePropStore(seedDir),
      cluster: { port: 0 },
    });
    await expect(
      Troupe.form({
        actors: [OwnCartActor],
        propStore: new InMemoryPropStore(),
        cluster: {
          mode: "production",
          port: 7904,
          advertise: "127.0.0.1:7904",
          seeds: [seed.clusterAddress()!],
        },
      }),
      // P0-6 起门禁前移：crossNodeSafe=false 的 Provider 在 OwnershipStore 检查之前即被拒（ADR 0002 I5）
    ).rejects.toThrow(/crossNodeSafe|所有权/);
    await seed.shutdown();
  });
});
