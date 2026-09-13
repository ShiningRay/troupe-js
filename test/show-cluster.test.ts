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

interface SubProps {
  received: unknown[];
}

class SubActor extends Actor<SubProps> {
  static role = "Sub";
  static initialProps = (): SubProps => ({ received: [] });

  override async onStage() {
    await this.subscribe("alerts"); // 话题归属由 HashRing 决定
  }

  override async onEvent(event: unknown) {
    this.props.received.push(event);
    await this.saveProps();
  }

  async read() {
    return this.props.received;
  }
}

describe("M6 验收：Show 跨 Stage（PLAN M6：pub/sub 全链路）", () => {
  it("订阅与发布落在不同 Stage：publish 经 coordinator 转发，跨 Stage Audience 收到", async () => {
    const a = await Troupe.form({
      actors: [SubActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "10s",
      cluster: { port: 0 },
    });
    const b = await Troupe.form({
      actors: [SubActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "10s",
      cluster: { port: 0, seeds: [a.clusterAddress()!] },
    });
    await waitUntil(() => a.clusterMembers()!.includes(b.clusterAddress()!));

    // 让 Sub/alerts 的订阅者落在 B：从 A cast 一个 B 归属的 stageName
    let key = "";
    for (let i = 0; i < 1000; i++) {
      const n = `sub-${i}`;
      if (a.ownerOf("Sub", n) === b.clusterAddress()) {
        key = n;
        break;
      }
    }
    expect(key).not.toBe("");
    await a.cast(SubActor, key).read(); // 激活 + 订阅（注册到话题归属 Stage）

    // 从 A 发布（A 可能不是 coordinator）
    await a.publish("alerts", { level: "red", text: "跨 Stage 事件" });

    // B 上的订阅者收到
    const ok = await waitUntil(async () =>
      ((await b.cast(SubActor, key).read()) as unknown[]).length > 0,
    );
    expect(ok).toBe(true);
    expect(await b.cast(SubActor, key).read()).toEqual([{ level: "red", text: "跨 Stage 事件" }]);

    await a.shutdown();
    await b.shutdown();
  }, 30_000);

  it("无订阅者话题：发布 no-op；成员视图漂移下发布不炸", async () => {
    const a = await Troupe.form({
      actors: [SubActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cluster: { port: 0 },
    });
    const b = await Troupe.form({
      actors: [SubActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cluster: { port: 0, seeds: [a.clusterAddress()!] },
    });
    await waitUntil(() => a.clusterMembers()!.includes(b.clusterAddress()!));
    b.destroy(); // 漂移：环收敛期间发布
    await waitUntil(() => a.clusterMembers()!.length === 0, 15_000);
    await expect(a.publish("alerts", { level: "info" })).resolves.toBeUndefined();
    await a.shutdown();
  }, 30_000);
});
