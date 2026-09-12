import { describe, expect, it } from "vitest";
import {
  ActivationError,
  Actor,
  CallRejectedError,
  Troupe,
  type TroupeEvent,
} from "../src/index.js";
import { sleep } from "./helpers.js";

let onStageCount = 0;
let offStageCount = 0;
let failFirstActivation = false;

class FanActor extends Actor<{ n: number }> {
  static initialProps = (): { n: number } => ({ n: 0 });

  async onStage() {
    onStageCount++;
    if (failFirstActivation) {
      failFirstActivation = false;
      throw new Error("boom-onStage");
    }
    await sleep(10);
  }

  async bump() {
    this.props.n++;
    await this.saveProps();
    return this.props.n;
  }
}

class DrainActor extends Actor<{ n: number }> {
  static initialProps = (): { n: number } => ({ n: 0 });

  async onStage() {
    onStageCount++;
  }

  async offStage() {
    await sleep(30);
    offStageCount++;
  }

  async bump() {
    this.props.n++;
    await this.saveProps();
    return this.props.n;
  }
}

// GC 验收专用：独立计数器，避免其它测试的短 Intermission troupe 异步累计
let gcOnStage = 0;
let gcOffStage = 0;

class GcActor extends Actor<{ n: number }> {
  static initialProps = (): { n: number } => ({ n: 0 });

  async onStage() {
    gcOnStage++;
  }

  async offStage() {
    gcOffStage++;
  }

  async bump() {
    this.props.n++;
    await this.saveProps();
    return this.props.n;
  }
}

describe("M1 验收：激活 single-flight 与生命周期状态机（DESIGN §5.2）", () => {
  it("并发首次调用只激活一次", async () => {
    onStageCount = 0;
    const troupe = await Troupe.form({ actors: [FanActor], defaultIntermission: 0 });
    const agent = troupe.cast(FanActor, "fan-1");

    const results = await Promise.all(Array.from({ length: 20 }, () => agent.bump()));

    expect(onStageCount).toBe(1);
    expect(results[19]).toBe(20);
    await troupe.drainAll();
  });

  it("激活失败：并发调用共享同一失败；下次调用重新激活", async () => {
    onStageCount = 0;
    failFirstActivation = true;
    const troupe = await Troupe.form({ actors: [FanActor], defaultIntermission: 0 });
    const agent = troupe.cast(FanActor, "fan-2");

    const first = agent.bump().catch((e) => e);
    const second = agent.bump().catch((e) => e);
    const [e1, e2] = await Promise.all([first, second]);

    expect(e1).toBeInstanceOf(ActivationError);
    expect(e2).toBeInstanceOf(ActivationError);
    expect((e1 as ActivationError).message).toContain("fan");
    expect(onStageCount).toBe(1); // 只尝试了一次激活

    expect(await agent.bump()).toBe(1); // 失败后重新激活成功
    expect(onStageCount).toBe(2);
    await troupe.drainAll();
  });
});

describe("M1 验收：排空期间新请求（DESIGN §5.2：等待或明确拒绝，不静默丢）", () => {
  it("drainPolicy=wait（默认）：等待排空完成后重新激活", async () => {
    onStageCount = 0;
    const troupe = await Troupe.form({ actors: [DrainActor], defaultIntermission: 20 });
    const agent = troupe.cast(DrainActor, "drain-1");
    await agent.bump();
    expect(onStageCount).toBe(1);

    let late: Promise<number> | undefined;
    const drainStarted = new Promise<void>((r) =>
      troupe.events.on((e: TroupeEvent) => {
        if (e.type === "drainStarted") {
          late = agent.bump();
          r();
        }
      }),
    );
    await drainStarted; // 精确卡进 offStage 的 30ms 排空窗口

    expect(await late!).toBe(2);
    expect(onStageCount).toBe(2); // 重新激活
    await troupe.drainAll();
  });

  it("drainPolicy=reject：排空期间明确拒绝（可重试）", async () => {
    onStageCount = 0;
    const troupe = await Troupe.form({
      actors: [DrainActor],
      defaultIntermission: 20,
      drainPolicy: "reject",
    });
    const agent = troupe.cast(DrainActor, "drain-2");
    await agent.bump();

    let late: Promise<unknown> | undefined;
    const drainStarted = new Promise<void>((r) =>
      troupe.events.on((e: TroupeEvent) => {
        if (e.type === "drainStarted") {
          late = agent.bump().catch((e) => e);
          r();
        }
      }),
    );
    await drainStarted;

    const outcome = (await late!) as CallRejectedError;
    expect(outcome).toBeInstanceOf(CallRejectedError);
    expect(outcome.reason).toBe("draining");
    expect(outcome.retryable).toBe(true);
  });
});

describe("M1 验收：Intermission 空闲回收（PLAN M1）", () => {
  it("空闲到期自动下场并触发 offStage 钩子", async () => {
    gcOnStage = 0;
    gcOffStage = 0;
    const troupe = await Troupe.form({ actors: [GcActor], defaultIntermission: 1000 });
    const agent = troupe.cast(GcActor, "gc-1");
    await agent.bump();

    expect(troupe.slots().length).toBe(1); // 在场
    await sleep(1300); // 1s Intermission 后自动下场

    expect(troupe.slots().length).toBe(0); // 已下场
    expect(gcOffStage).toBe(1);
    expect(gcOnStage).toBe(1);

    expect(await agent.bump()).toBe(2); // 下次调用重新登台
    expect(gcOnStage).toBe(2);
    await troupe.drainAll();
  }, 10_000);
});
