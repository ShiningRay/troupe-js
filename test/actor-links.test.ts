import { describe, expect, it } from "vitest";
import { Actor, CallTimeoutError, Troupe } from "../src/index.js";
import { sleep } from "./helpers.js";

class LeafActor extends Actor<{ n: number }> {
  static initialProps = () => ({ n: 0 });

  async double(v: number) {
    await sleep(10);
    return v * 2;
  }
}

class CallerActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async callLeaf(name: string, v: number) {
    return this.cast(LeafActor, name).double(v);
  }

  async fanOut(n: number) {
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => this.cast(LeafActor, `leaf-${i}`).double(i)),
    );
    return results.reduce((a, b) => a + b, 0);
  }
}

class AliceActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async ask() {
    return await this.cast(BobActor, "b1").echo();
  }

  async hello() {
    return "alive";
  }
}

class BobActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async echo() {
    // 回环：B 调回 A → 环状等待，只能靠 deadline 打破（DESIGN §5.4）
    return await this.cast(AliceActor, "a1").ask();
  }
}

describe("M1 验收：Actor 互调（DESIGN §10.1，this.cast）", () => {
  it("Actor 内 cast 其它角色并取回结果", async () => {
    const troupe = await Troupe.form({ actors: [LeafActor, CallerActor], defaultIntermission: 0 });
    const caller = troupe.cast(CallerActor, "c1");
    expect(await caller.callLeaf("l1", 21)).toBe(42);
    await troupe.drainAll();
  });

  it("fan-out 到多个 Actor 并行；同一热点 Actor 串行（容量事实 §5.3）", async () => {
    const troupe = await Troupe.form({ actors: [LeafActor, CallerActor], defaultIntermission: 0 });
    const caller = troupe.cast(CallerActor, "c2");

    const t0 = Date.now();
    expect(await caller.fanOut(5)).toBe(20); // 5 个不同 leaf-* 并行，各 ~10ms
    const parallelMs = Date.now() - t0;

    const t1 = Date.now();
    const rs: number[] = [];
    for (let i = 0; i < 5; i++) rs.push(await caller.callLeaf("hot", i)); // 同一热点串行
    const serialMs = Date.now() - t1;
    expect(rs.reduce((a, b) => a + b, 0)).toBe(20);

    expect(parallelMs).toBeLessThan(serialMs);
    expect(serialMs).toBeGreaterThan(40); // 5 × 10ms 的串行下限
    await troupe.drainAll();
  }, 10_000);

  it("A→B→A 环状等待被 deadline 打破，之后 Actor 仍可用", async () => {
    const troupe = await Troupe.form({
      actors: [AliceActor, BobActor],
      defaultTimeout: 200,
      defaultIntermission: 0,
    });
    const alice = troupe.cast(AliceActor, "a1");

    const err = await alice.ask().catch((e) => e);
    expect(err).toBeInstanceOf(CallTimeoutError);
    expect((err as CallTimeoutError).phase).toBe("executing");

    expect(await alice.hello()).toBe("alive"); // 串行通道已恢复
    await troupe.drainAll();
  }, 10_000);
});
