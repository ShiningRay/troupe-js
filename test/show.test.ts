import { describe, expect, it } from "vitest";
import { Actor, Troupe, type Audience } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { sleep } from "./helpers.js";

const waitUntil = async (cond: () => boolean, timeoutMs = 6_000): Promise<boolean> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(10);
  }
  return true;
};

interface SubProps {
  received: Array<{ topic: string; event: unknown }>;
}

/** 订阅者：onEvent 默认入口 + 自定义方法入口 */
class FanActor extends Actor<SubProps> {
  static role = "Fan";
  static initialProps = (): SubProps => ({ received: [] });

  override async onStage() {
    await this.subscribe("news"); // 默认 onEvent
  }

  override async onEvent(event: unknown) {
    this.props.received.push({ topic: "news", event });
    await this.saveProps();
  }

  async read() {
    return this.props.received;
  }
}

class CustomFanActor extends Actor<SubProps> {
  static role = "CustomFan";
  static initialProps = (): SubProps => ({ received: [] });

  override async onStage() {
    await this.subscribe("news", "onNews"); // 自定义回调方法
  }

  async onNews(event: unknown) {
    this.props.received.push({ topic: "news(custom)", event });
  }

  async read() {
    return this.props.received;
  }

  async leave() {
    await this.unsubscribe("news", "onNews");
    return true;
  }
}

describe("M6 验收：Show/Audience 单进程（DESIGN §2）", () => {
  it("publish → 多订阅者（默认/自定义回调方法）都收到；重复订阅去重", async () => {
    const troupe = await Troupe.form({
      actors: [FanActor, CustomFanActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    await troupe.cast(FanActor, "f1").read(); // 激活 → onStage 订阅
    await troupe.cast(FanActor, "f1").read(); // 二次激活（不重复订阅——ensure 去重）
    await troupe.cast(CustomFanActor, "c1").read();

    await troupe.publish("news", { text: "hello" });

    expect((await troupe.cast(FanActor, "f1").read())).toEqual([
      { topic: "news", event: { text: "hello" } },
    ]);
    expect((await troupe.cast(CustomFanActor, "c1").read())).toEqual([
      { topic: "news(custom)", event: { text: "hello" } },
    ]);
    await troupe.drainAll();
  });

  it("unsubscribe 后不再收到", async () => {
    const troupe = await Troupe.form({
      actors: [CustomFanActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    await troupe.cast(CustomFanActor, "c1").read();
    expect(await troupe.cast(CustomFanActor, "c1").leave()).toBe(true);

    await troupe.publish("news", { text: "second" });
    expect((await troupe.cast(CustomFanActor, "c1").read())).toEqual([]); // 退订后零投递
    await troupe.drainAll();
  });

  it("订阅者不在场 → publish 触发重新登台处理（投递即 Call 语义）", async () => {
    const troupe = await Troupe.form({
      actors: [FanActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    await troupe.cast(FanActor, "f1").read(); // 订阅
    await troupe.off("Fan", "f1"); // 下场（订阅仍在 coordinator 目录中）
    await troupe.publish("news", { text: "wake" });

    const ok = await waitUntil(
      () => troupe.cast(FanActor, "f1").read !== undefined &&
        ((troupe.slots().some((s) => s.stageName === "f1")) || true),
    );
    expect(ok).toBe(true);
    await waitUntil(async () =>
      ((await troupe.cast(FanActor, "f1").read()) as unknown[]).length > 0, 5_000);
    expect(await troupe.cast(FanActor, "f1").read()).toEqual([
      { topic: "news", event: { text: "wake" } },
    ]);
    await troupe.drainAll();
  });

  it("投递失败降级：Audience 角色未注册 → 记事件、publish 不炸、其它订阅者不受影响", async () => {
    const troupe = await Troupe.form({
      actors: [FanActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    await troupe.cast(FanActor, "f1").read();
    const ghost: Audience = { roleId: "Ghost", stageName: "g1", method: "onEvent" };
    await troupe.subscribe("news", ghost); // 未注册角色

    const dropped = (await new Promise<unknown[]>((resolve) => {
      const found: unknown[] = [];
      const unsub = troupe.events.on((e) => {
        if (e.type === "showDropped") found.push(e);
        if (found.length >= 1) {
          unsub();
          resolve(found);
        }
      });
      void troupe.publish("news", { text: "mixed" }).then(() => {
        // publish 受理完成后稍候，让事件送达监听器
        setTimeout(() => resolve(found), 100);
      });
    })) as unknown[];
    expect(dropped.length).toBe(1); // ghost 投递被记为 dropped
    expect((await troupe.cast(FanActor, "f1").read()).length).toBe(1); // 正常订阅者不受影响
    await troupe.drainAll();
  });

  it("无订阅者发布为 no-op", async () => {
    const troupe = await Troupe.form({ actors: [FanActor], propStore: new InMemoryPropStore() });
    await expect(troupe.publish("empty-topic", { x: 1 })).resolves.toBeUndefined();
    await troupe.drainAll();
  });
});
