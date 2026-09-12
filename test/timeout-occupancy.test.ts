import { describe, expect, it } from "vitest";
import { Actor, CallRejectedError, Troupe } from "../src/index.js";
import { sleep } from "./helpers.js";

const log: string[] = [];

class SlowActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;
  static timeouts = { b: "5s" }; // b 需要在 a 结束后仍有充足期限

  async a() {
    log.push("a-start");
    await sleep(120);
    log.push("a-end");
    return "a-done";
  }

  async b() {
    log.push("b-start");
    return "b-done";
  }
}

const executed: string[] = [];

class QueueActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;
  static timeouts = { a: "5s" }; // a 慢但不超时；b 用默认短超时验证排队过期

  async a() {
    await sleep(100);
    executed.push("a");
    return "a";
  }

  async b() {
    executed.push("b");
    return "b";
  }

  async c() {
    executed.push("c");
    return "c";
  }
}

describe("M1 验收：超时与执行占用（DESIGN §5.1 响应期限与执行占用分离）", () => {
  it("A 超时后 B 不与 A 交错：A 结束前 B 不执行", async () => {
    log.length = 0;
    const troupe = await Troupe.form({ actors: [SlowActor], defaultTimeout: 40, defaultIntermission: 0 });
    const agent = troupe.cast(SlowActor, "s1");

    const aPromise = agent.a(); // 执行需 120ms，40ms 即超时
    await sleep(10); // 确保 a 已开始执行
    const bPromise = agent.b(); // 排队

    // 调用方拿到超时（结果未知），但旧任务仍占着串行通道
    await expect(aPromise).rejects.toMatchObject({ phase: "executing" });

    // b 只能在 a 真正 settle 之后开始
    expect(await bPromise).toBe("b-done");
    expect(log).toEqual(["a-start", "a-end", "b-start"]);
    await troupe.drainAll();
  });

  it("排队过期：未开始执行的 Call 直接拒绝、零副作用", async () => {
    executed.length = 0;
    const troupe = await Troupe.form({ actors: [QueueActor], defaultTimeout: 40, defaultIntermission: 0 });
    const agent = troupe.cast(QueueActor, "q1");

    const aPromise = agent.a(); // 占用通道 100ms
    await sleep(5);
    const bPromise = agent.b().catch((e) => e); // 排队；40ms deadline 将先到期

    const outcome = await bPromise;
    expect(outcome).toMatchObject({ phase: "queued" }); // 从未执行
    expect(await aPromise).toBe("a");
    expect(executed).toEqual(["a"]); // b 零副作用
    await troupe.drainAll();
  });

  it("CallBoard 深度上限：超限显式拒绝（DESIGN §5.3）", async () => {
    executed.length = 0;
    const troupe = await Troupe.form({
      actors: [QueueActor],
      defaultTimeout: 5_000,
      defaultIntermission: 0,
      queueDepth: 1,
    });
    const agent = troupe.cast(QueueActor, "q2");

    const aPromise = agent.a(); // 执行中（已出队）
    await sleep(5);
    const bPromise = agent.b(); // 排队（depth=1 占满）
    const cPromise = agent.c().catch((e) => e); // 超限

    const outcome = (await cPromise) as CallRejectedError;
    expect(outcome).toBeInstanceOf(CallRejectedError);
    expect(outcome.reason).toBe("backpressure");
    expect(await aPromise).toBe("a");
    expect(await bPromise).toBe("b");
    expect(executed).toEqual(["a", "b"]);
    await troupe.drainAll();
  });
});
