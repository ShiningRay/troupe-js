/**
 * 进程内 callback Audience（M11.5）：subscribe(topic, fn)。
 * 边缘代码（WS/SSE 推送、仪表盘）无需 Actor 壳即可消费 Show 事件流。
 */
import { afterEach, describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";

class FanActor extends Actor<{ last: unknown }> {
  static initialProps = () => ({ last: null as unknown });

  override async onStage() {
    await this.subscribe("t:topic");
  }

  override async onEvent(event: unknown) {
    this.props.last = event;
  }

  async peek(): Promise<unknown> {
    return this.props.last;
  }
}

let troupe: Troupe | undefined;
afterEach(async () => {
  if (troupe) {
    await troupe.drainAll();
    await troupe.shutdown();
    troupe = undefined;
  }
});

describe("进程内 callback Audience", () => {
  it("callback 收到发布事件；退订函数生效；同引用重复订阅幂等", async () => {
    troupe = await Troupe.form({ actors: [FanActor] });
    const got: unknown[] = [];
    const un1 = await troupe.subscribe("t:topic", (e) => got.push(e));
    const fn: (e: unknown) => void = (e) => got.push(e);
    await troupe.subscribe("t:topic", fn);
    await troupe.subscribe("t:topic", fn); // 同引用 Set 去重

    await troupe.publish("t:topic", { n: 1 });
    expect(got).toEqual([{ n: 1 }, { n: 1 }]); // 两个不同 callback 各一次

    await un1();
    await troupe.publish("t:topic", { n: 2 });
    expect(got).toEqual([{ n: 1 }, { n: 1 }, { n: 2 }]);
  });

  it("callback 与 Actor Audience 共存：同一发布双方都收到", async () => {
    troupe = await Troupe.form({ actors: [FanActor] });
    const fan = troupe.cast(FanActor, "f1");
    await fan.peek(); // 激活 → onStage 里 subscribe("t:topic")

    const got: unknown[] = [];
    await troupe.subscribe("t:topic", (e) => got.push(e));

    await troupe.publish("t:topic", "x");
    expect(got).toEqual(["x"]);
    expect(await fan.peek()).toBe("x");
  });

  it("callback 抛错：publish 正常完成、其他订阅者不受影响、记 showDropped", async () => {
    troupe = await Troupe.form({ actors: [FanActor] });
    const dropped: unknown[] = [];
    troupe.events.on((e) => {
      if (e.type === "showDropped") dropped.push(e);
    });
    const got: unknown[] = [];
    await troupe.subscribe("t:topic", () => {
      throw new Error("边缘消费者挂了");
    });
    await troupe.subscribe("t:topic", (e) => got.push(e));

    await expect(troupe.publish("t:topic", 42)).resolves.toBeUndefined();
    expect(got).toEqual([42]);
    expect(dropped).toHaveLength(1);
  });
});
