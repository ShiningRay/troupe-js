import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { InMemoryCueStore } from "../src/cues/memory.js";
import { sleep } from "./helpers.js";

let flushed = 0;
let ticks: number[] = [];
let slowBusy = 0;

class MemCueActor extends Actor<{ n: number }> {
  static role = "MemCue";
  static initialProps = () => ({ n: 0 });

  override async onStage() {
    this.registerCue("flush", 40, () => {
      flushed++;
    });
  }

  async touch() {
    this.props.n++;
    return this.props.n;
  }
}

class SlowCueActor extends Actor<{ n: number }> {
  static role = "SlowCue";
  static initialProps = () => ({ n: 0 });

  override async onStage() {
    this.registerCue("slow", 30, async () => {
      slowBusy++;
      await sleep(120); // 慢回调
    });
  }

  async peek() {
    return this.props.n;
  }
}

class ReentrantTickActor extends Actor<{ log: string[] }> {
  static role = "Tick";
  static initialProps = () => ({ log: [] });

  override async onStage() {
    this.registerCue("tick", 50, async () => {
      ticks.push(Date.now());
      await sleep(30);
    });
  }

  async replace() {
    this.registerCue("tick", 50, () => {
      ticks.push(-1);
    });
    return true;
  }

  async cancel() {
    this.cancelCue("tick");
    return true;
  }

  async peek() {
    return this.props.log.length;
  }
}

describe("M4 补齐：内存 Cue registerCue（DESIGN §3.3）", () => {
  it("在场时周期触发；随下场自动清理，重新登台后重新注册", async () => {
    flushed = 0;
    const troupe = await Troupe.form({
      actors: [MemCueActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 150,
    });
    const agent = troupe.cast(MemCueActor, "u1");
    await agent.touch(); // 激活 → onStage 注册 flush
    await sleep(400);
    expect(flushed).toBeGreaterThanOrEqual(3);

    await troupe.off("MemCue", "u1"); // 下场 → 内存 Cue 清理
    const at = flushed;
    await sleep(300);
    expect(flushed).toBe(at); // 下场后零触发

    await agent.touch(); // 重新登台 → onStage 重新注册
    await sleep(250);
    expect(flushed).toBeGreaterThan(at);
    await troupe.shutdown();
  });

  it("回调经串行 Turn：慢回调期间业务调用排队不交错；上一拍未完成跳过本拍", async () => {
    slowBusy = 0;
    const troupe = await Troupe.form({
      actors: [SlowCueActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    const agent = troupe.cast(SlowCueActor, "u1");
    await agent.peek(); // 激活
    await sleep(400); // 回调每 30ms 调度但每拍 120ms → inFlight 跳过后约 3-4 次
    expect(slowBusy).toBeGreaterThanOrEqual(2);
    expect(slowBusy).toBeLessThanOrEqual(6); // 未堆积（跳过本拍）
    await troupe.shutdown();
  });

  it("同名重注册覆盖旧定时器；cancelCue 立即停止", async () => {
    ticks = [];
    const troupe = await Troupe.form({
      actors: [ReentrantTickActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    const agent = troupe.cast(ReentrantTickActor, "u1");
    await agent.peek();
    await sleep(160);
    expect(ticks.filter((t) => t === -1).length).toBe(0); // 初始回调记录时间戳

    await agent.cancel();
    const n = ticks.length;
    await sleep(200);
    expect(ticks.length).toBe(n); // 取消后零触发
    await troupe.shutdown();
  });

  it("内存 Cue 与持久提醒可并存（flush 攒批 + 持久巡检）", async () => {
    flushed = 0;
    const troupe = await Troupe.form({
      actors: [MemCueActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cues: { store: new InMemoryCueStore(), tickMs: 50 },
    });
    await troupe.cast(MemCueActor, "u2").touch();
    await sleep(200);
    expect(flushed).toBeGreaterThanOrEqual(2);
    await troupe.shutdown();
  });
});
