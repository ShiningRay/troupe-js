import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { sleep } from "./helpers.js";

const waitUntil = async (cond: () => boolean, timeoutMs = 12_000): Promise<boolean> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(25);
  }
  return true;
};

class AggActor extends Actor<{ n: number }> {
  static role = "Agg";
  static initialProps = () => ({ n: 0 });

  async bump() {
    this.props.n++;
    await this.saveProps();
    return this.props.n;
  }
}

describe("M9 验收：Booth 完整版（Director 聚合 + Live Trace + booth 发现）", () => {
  it("Director cluster 聚合：跨 Stage 汇总 actors/cues/booth 地址（§11.1 M4 边界补齐）", async () => {
    const a = await Troupe.form({
      actors: [AggActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
      cluster: { port: 0 },
    });
    const b = await Troupe.form({
      actors: [AggActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
      cluster: { port: 0, seeds: [a.clusterAddress()!] },
    });
    await waitUntil(() => a.clusterMembers()!.includes(b.clusterAddress()!));

    // 各自激活一个 Actor
    await a.cast(AggActor, "on-a").bump();
    await b.cast(AggActor, "on-b").bump();

    const cluster = (await a.director().cluster()) as {
      members: string[];
      stages: Array<{ stage: string; booth: string | null }>;
      actors: Array<{ roleId: string; stageName: string; stage: string }>;
    };
    expect(cluster.members.length).toBe(2);
    expect(cluster.stages.length).toBe(2);
    expect(cluster.stages.every((s) => typeof s.booth === "string" && s.booth.startsWith("http"))).toBe(true);
    expect(cluster.actors.length).toBe(2); // on-a + on-b 跨 Stage 汇总
    expect(cluster.actors.map((x) => x.stageName).sort()).toEqual(["on-a", "on-b"]);
    expect(cluster.actors.every((x) => x.stage)).toBeTruthy(); // 每条标注来源 Stage

    // roster 暴露 booth 地址（CLI booth 发现用）
    const roster = (await a.director().roster()) as { booth: string | null };
    expect(roster.booth).toBe(a.boothAddress());

    // wire dir 通道同样可用（CLI 路径）
    const dirA = await (async () => {
      const res = await fetch(`http://127.0.0.1:${new URL(a.boothAddress()!).port}/api/overview`);
      return (await res.json()) as { cluster: { actors: unknown[] } | null };
    })();
    expect(dirA.cluster?.actors.length).toBe(2); // Booth overview 聚合化
    await a.shutdown();
    await b.shutdown();
  }, 30_000);

  it("inspect 详情端点：committed props + slot 状态", async () => {
    const troupe = await Troupe.form({
      actors: [AggActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
    });
    await troupe.cast(AggActor, "d1").bump();
    const base = troupe.boothAddress()!;
    const res = await fetch(`${base}/api/inspect?roleId=Agg&stageName=d1`);
    const detail = (await res.json()) as {
      roleId: string;
      committed: { props: { n: number }; revision: number };
      slot: { state: string } | null;
    };
    expect(detail.committed.props).toEqual({ n: 1 });
    expect(detail.committed.revision).toBe(1);
    expect(detail.slot?.state).toBe("running");
    await troupe.shutdown();
  });

  it("Live Trace 对接 M6 总线：overview 携带 traces（SSE 同源）", async () => {
    const troupe = await Troupe.form({
      actors: [AggActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
    });
    await troupe.cast(AggActor, "lt").bump();
    await sleep(50);
    const traces = troupe.traces(10);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces[0].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const base = troupe.boothAddress()!;
    const overview = (await (await fetch(`${base}/api/overview`)).json()) as {
      traces: Array<{ method: string; traceparent: string }>;
    };
    expect(overview.traces.length).toBeGreaterThanOrEqual(1);
    expect(overview.traces[0].traceparent).toMatch(/^00-/);
    await troupe.shutdown();
  });

  it("未启用集群：cluster 方法显式报错（不静默给本地视图）", async () => {
    const troupe = await Troupe.form({
      actors: [AggActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    await expect(troupe.director().cluster()).rejects.toThrow(/未启用集群/);
    await troupe.drainAll();
  });
});
