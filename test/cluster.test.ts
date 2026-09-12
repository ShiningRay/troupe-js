import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Actor,
  CallRejectedError,
  InMemoryPropStore,
  Troupe,
  Transport,
  type WireMessage,
} from "../src/index.js";
import { SqlitePropStore } from "../src/props/sqlite.js";
import { unwrapEnvelope } from "../src/core/envelope.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 12_000, stepMs = 50): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil 超时（${timeoutMs}ms）`);
    await sleep(stepMs);
  }
}

class NodeCartActor extends Actor<{ items: string[] }> {
  static role = "NodeCart";
  static initialProps = () => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }

  async slow(ms: number) {
    await sleep(ms);
    return "slow-done";
  }
}

interface Stage {
  troupe: Troupe;
  store: InMemoryPropStore;
}

async function startStage(seeds: string[] = [], store?: InMemoryPropStore): Promise<Stage> {
  const s = store ?? new InMemoryPropStore();
  const troupe = await Troupe.form({
    actors: [NodeCartActor],
    propStore: s,
    defaultIntermission: 0,
    defaultTimeout: "10s",
    cluster: { port: 0, seeds },
  });
  return { troupe, store: s };
}

/** 找一个归属指定 Stage 的 stageName（确定性挑键，避免测试依赖哈希分布） */
function keyOwnedBy(owner: Troupe, other: Troupe, roleId = "NodeCart"): string {
  for (let i = 0; i < 1000; i++) {
    const name = `k${i}-${randomUUID().slice(0, 6)}`;
    if (owner.ownerOf(roleId, name) === owner.clusterAddress()) return name;
  }
  throw new Error("找不到归属键");
}

describe("M2 验收：双 Stage 组团与透明路由（PLAN M2）", () => {
  it("seeds 入团互相收敛；跨 Stage cast 透明，Props 落在归属 Stage 的存储", async () => {
    const a = await startStage();
    const b = await startStage([a.troupe.clusterAddress()!]);

    await waitUntil(() =>
      b.troupe.clusterMembers()!.includes(a.troupe.clusterAddress()!) &&
      a.troupe.clusterMembers()!.includes(b.troupe.clusterAddress()!),
    );

    // 本地键（A 自己归属）
    const localKey = keyOwnedBy(a.troupe, b.troupe);
    expect(await a.troupe.cast(NodeCartActor, localKey).add("x")).toBe(1);
    expect(unwrapEnvelope((await a.store.read("default", "NodeCart", localKey))!.props).props)
      .toEqual({ items: ["x"] });

    // 远程键（B 归属）：从 A cast，透明路由到 B 执行并写 B 的存储
    const remoteKey = (() => {
      for (let i = 0; i < 1000; i++) {
        const name = `r${i}-${randomUUID().slice(0, 6)}`;
        if (a.troupe.ownerOf("NodeCart", name) === b.troupe.clusterAddress()) return name;
      }
      throw new Error("找不到远程键");
    })();
    expect(await a.troupe.cast(NodeCartActor, remoteKey).add("y")).toBe(1);
    expect(await b.store.read("default", "NodeCart", remoteKey)).not.toBeNull();
    expect(await a.store.read("default", "NodeCart", remoteKey)).toBeNull(); // A 没有越权写

    await a.troupe.shutdown();
    await b.troupe.shutdown();
  }, 20_000);
});

describe("M2 验收：环漂移转发（跳数上限 2，§6.3）", () => {
  it("把 Call 打到非归属 Stage → 转发到归属并回程结果；hops=2 → 拒绝 drift", async () => {
    const a = await startStage();
    const b = await startStage([a.troupe.clusterAddress()!]);
    await waitUntil(() => a.troupe.clusterMembers()!.length === 1);

    // 找一个归属 B 的键
    let remoteKey = "";
    for (let i = 0; i < 1000; i++) {
      const name = `f${i}-${randomUUID().slice(0, 6)}`;
      if (a.troupe.ownerOf("NodeCart", name) === b.troupe.clusterAddress()) {
        remoteKey = name;
        break;
      }
    }

    const raw = new Transport((_msg: WireMessage, _reply) => {});
    const mk = (hops: number, id: string) =>
      raw.request(
        a.troupe.clusterAddress()!,
        {
          t: "call", callId: id, from: "raw-test",
          to: { roleId: "NodeCart", stageName: remoteKey },
          method: "add", args: ["forwarded"], deadline: Date.now() + 5000, hops,
        },
        id,
        5000,
      );

    const res = await mk(0, randomUUID());
    expect(res).toMatchObject({ ok: true, result: 1 }); // A 转发给 B 执行

    const rejected = await mk(2, randomUUID());
    expect(rejected).toMatchObject({
      ok: false,
      err: { kind: "rejected", reason: "drift" },
    });

    raw.destroy();
    await a.troupe.shutdown();
    await b.troupe.shutdown();
  }, 20_000);
});

describe("M2 验收：kill -9 后存活 Stage 重激活（进程级：本地 SQLite 同机恢复）", () => {
  it("硬杀归属 Stage → 探测判死 → 键漂移到存活方 → 从共享 SQLite 恢复", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-kill9-"));
    const shared = new SqlitePropStore(dir);
    const a = await Troupe.form({
      actors: [NodeCartActor],
      propStore: shared,
      defaultIntermission: 0,
      defaultTimeout: "10s",
      cluster: { port: 0 },
    });
    const b = await Troupe.form({
      actors: [NodeCartActor],
      propStore: shared,
      defaultIntermission: 0,
      defaultTimeout: "10s",
      cluster: { port: 0, seeds: [a.clusterAddress()!] },
    });
    await waitUntil(() => a.clusterMembers()!.includes(b.clusterAddress()!));

    // 找归属 B 的键，写入两笔
    let key = "";
    for (let i = 0; i < 1000; i++) {
      const name = `d${i}-${randomUUID().slice(0, 6)}`;
      if (a.ownerOf("NodeCart", name) === b.clusterAddress()) {
        key = name;
        break;
      }
    }
    expect(await a.cast(NodeCartActor, key).add("one")).toBe(1);
    expect(await a.cast(NodeCartActor, key).add("two")).toBe(2);

    // kill -9：无 leave、无排空
    b.destroy();

    // 探测判死（后继连续 3 个周期无 ACK ≈ 3s）→ 环收敛为 {A}
    await waitUntil(() => a.clusterMembers()!.length === 0, 15_000);
    expect(a.ownerOf("NodeCart", key)).toBe(a.clusterAddress());

    // 后续 Call 在 A 重激活，Props 从共享 SQLite 恢复
    expect(await a.cast(NodeCartActor, key).add("three")).toBe(3);
    expect(await a.cast(NodeCartActor, key).peek()).toBe(3);
    await a.shutdown();
  }, 30_000);
});

describe("M2 验收：优雅停机全链路（PLAN M2：量化定义）", () => {
  it("停机后新 Call 被拒；存量 settle；全员 offStage+save；对端收到 leave", async () => {
    const a = await startStage();
    const b = await startStage([a.troupe.clusterAddress()!]);
    await waitUntil(() => a.troupe.clusterMembers()!.includes(b.troupe.clusterAddress()!));

    const key = keyOwnedBy(a.troupe, b.troupe);
    const slowP = a.troupe.cast(NodeCartActor, key).slow(200); // 在途请求
    await sleep(20);

    const shutP = a.troupe.shutdown();
    const rejected = await a.troupe.cast(NodeCartActor, key).peek().catch((e) => e);
    expect(rejected).toBeInstanceOf(CallRejectedError);
    expect((rejected as CallRejectedError).reason).toBe("shutdown");

    expect(await slowP).toBe("slow-done"); // 存量请求 settle
    await shutP;
    expect(a.troupe.slots().length).toBe(0); // 全员下场

    await waitUntil(() => b.troupe.clusterMembers()!.length === 0); // leave 快速收敛
    await b.troupe.shutdown();
  }, 20_000);
});

describe("M2 验收：全局背压（DESIGN §5.3）", () => {
  it("在场 Actor 数上限：超限拒绝激活（backpressure）", async () => {
    const troupe = await Troupe.form({
      actors: [NodeCartActor],
      defaultIntermission: 0,
      maxActivations: 1,
    });
    await troupe.cast(NodeCartActor, "only-one").add("x");
    const err = await troupe.cast(NodeCartActor, "second").add("y").catch((e) => e);
    expect(err).toBeInstanceOf(CallRejectedError);
    expect((err as CallRejectedError).reason).toBe("backpressure");
    await troupe.drainAll();
  });

  it("排队字节预算：超限拒绝入队（backpressure）", async () => {
    const troupe = await Troupe.form({
      actors: [NodeCartActor],
      defaultIntermission: 0,
      defaultTimeout: "10s",
      maxQueuedBytes: 200,
    });
    const agent = troupe.cast(NodeCartActor, "hot");
    const slowP = agent.slow(150); // 占用通道
    await sleep(10);
    const bigArg = "x".repeat(500);
    const err = await agent.add(bigArg).catch((e) => e); // 排队即超预算
    expect(err).toBeInstanceOf(CallRejectedError);
    expect((err as Error).message).toMatch(/排队字节预算超限/);
    await slowP;
    await troupe.drainAll();
  });
});
