import { describe, expect, it } from "vitest";
import { Actor, IdempotencyConflictError, Troupe } from "../src/index.js";
import { sleep } from "./helpers.js";

let executions = 0;

class ReserveActor extends Actor<{ remaining: number }> {
  static initialProps = () => ({ remaining: 10 });

  async reserve(requestId: string, qty: number) {
    // 幂等执行（DESIGN §6.5）：键 + 参数指纹；helper 在 settle 后原子提交状态+记录
    return this.idempotent(`reserve:${requestId}`, `${requestId}:${qty}`, async () => {
      executions++;
      this.props.remaining -= qty; // 只改内存；由 idempotent 统一原子落盘
      return { ok: true, remaining: this.props.remaining };
    });
  }

  async remaining() {
    return this.props.remaining;
  }
}

class FailingOpActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async op(requestId: string) {
    return this.idempotent(`op:${requestId}`, requestId, async () => {
      executions++;
      throw new Error("business failure");
    });
  }
}

describe("M1 验收：幂等记录（DESIGN §6.5 失败契约）", () => {
  it("同键同参数 → 重放原结果，只执行一次", async () => {
    executions = 0;
    const troupe = await Troupe.form({ actors: [ReserveActor], defaultIntermission: 0 });
    const agent = troupe.cast(ReserveActor, "inv-1");

    const first = await agent.reserve("req-1", 2);
    const replay = await agent.reserve("req-1", 2);

    expect(executions).toBe(1);
    expect(replay).toEqual(first);
    expect(replay).toEqual({ ok: true, remaining: 8 });
    await troupe.drainAll();
  });

  it("同键不同参数指纹 → IdempotencyConflictError", async () => {
    executions = 0;
    const troupe = await Troupe.form({ actors: [ReserveActor], defaultIntermission: 0 });
    const agent = troupe.cast(ReserveActor, "inv-2");

    await agent.reserve("req-1", 2);
    const outcome = await agent.reserve("req-1", 5).catch((e) => e);

    expect(outcome).toBeInstanceOf(IdempotencyConflictError);
    expect(executions).toBe(1);
    await troupe.drainAll();
  });

  it("幂等记录随 Props 原子落盘：下场重登后仍可重放", async () => {
    executions = 0;
    const troupe = await Troupe.form({ actors: [ReserveActor], defaultIntermission: 30 });
    const agent = troupe.cast(ReserveActor, "inv-3");

    const first = await agent.reserve("req-9", 1);
    await sleep(150); // 等 Intermission 下场 + 重新激活
    const replay = await agent.reserve("req-9", 1);

    expect(executions).toBe(1); // 跨激活重放，未重复扣减
    expect(replay).toEqual(first);
    expect(await agent.remaining()).toBe(9);
    await troupe.drainAll();
  });

  it("保留期限到期后同键视为新操作", async () => {
    executions = 0;
    const troupe = await Troupe.form({
      actors: [ReserveActor],
      defaultIntermission: 0,
      idempotencyRetention: 40,
    });
    const agent = troupe.cast(ReserveActor, "inv-4");

    await agent.reserve("req-1", 2);
    await sleep(80); // 超过保留期限
    await agent.reserve("req-1", 2);

    expect(executions).toBe(2);
    expect(await agent.remaining()).toBe(6);
    await troupe.drainAll();
  });

  it("失败也记录并重放（错误路径幂等）", async () => {
    executions = 0;
    const troupe = await Troupe.form({ actors: [FailingOpActor], defaultIntermission: 0 });
    const agent = troupe.cast(FailingOpActor, "f-1");

    const e1 = await agent.op("req-x").catch((e) => e);
    const e2 = await agent.op("req-x").catch((e) => e);

    expect(executions).toBe(1);
    expect((e1 as Error).message).toBe("business failure");
    expect((e2 as Error).message).toBe("business failure");
    await troupe.drainAll();
  });
});
