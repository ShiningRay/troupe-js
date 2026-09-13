import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { TraceBus } from "../src/core/trace.js";
import { sleep } from "./helpers.js";

class TraceActor extends Actor<{ n: number }> {
  static role = "Trace";
  static initialProps = () => ({ n: 0 });

  async work(ms: number) {
    await sleep(ms);
    this.props.n++;
    return this.props.n;
  }

  async boom() {
    throw new Error("业务失败");
  }
}

describe("M6 验收：Trace 总线（DESIGN §11.4）", () => {
  it("Turn 产出 trace：耗时/结果/callId；历史查询可过滤", async () => {
    const troupe = await Troupe.form({
      actors: [TraceActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    await troupe.cast(TraceActor, "t1").work(30);
    await troupe.cast(TraceActor, "t1").boom().catch(() => {});

    const traces = troupe.traces(50);
    expect(traces.length).toBe(2);
    expect(traces[0].method).toBe("boom"); // 新的在前
    expect(traces[0].ok).toBe(false); // 业务异常 → ok=false
    expect(traces[1].method).toBe("work");
    expect(traces[1].ok).toBe(true);
    expect(traces[1].durationMs).toBeGreaterThanOrEqual(25);
    expect(traces[1].caller).toBe("local");

    expect(troupe.traces(10, { method: "boom" }).length).toBe(1);
    expect(troupe.traces(10, { roleId: "Nope" }).length).toBe(0);
    await troupe.drainAll();
  });

  it("实时订阅（subscribeTrace）", async () => {
    const troupe = await Troupe.form({
      actors: [TraceActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    const seen: string[] = [];
    const unsub = troupe.subscribeTrace({ method: "work" }, (e) =>
      seen.push((e as { method: string }).method),
    );
    await troupe.cast(TraceActor, "t2").work(5);
    await troupe.cast(TraceActor, "t2").boom().catch(() => {}); // 被过滤
    await sleep(50);
    expect(seen).toEqual(["work"]);
    unsub();
    await troupe.cast(TraceActor, "t2").work(5);
    expect(seen).toEqual(["work"]); // 退订后不再收
    await troupe.drainAll();
  });

  it("TraceBus：环形容量、采样、字节预算", () => {
    const bus = new TraceBus({ capacity: 100, sampleEvery: 10, byteBudget: 1024 * 1024 });
    for (let i = 0; i < 1000; i++) {
      bus.record({
        callId: `c${i}`,
        roleId: "R",
        stageName: "s",
        method: "m",
        caller: "local",
        durationMs: 1,
        ok: true,
        outcome: "completed",
        at: i,
      });
    }
    expect(bus.size).toBe(100); // 1000 条采样 1/10 → 100 条全保留
    expect(bus.latest(1)[0].callId).toBe("c999");

    const tiny = new TraceBus({ capacity: 10_000, byteBudget: 2 * 1024 }); // 小预算强制丢弃
    for (let i = 0; i < 500; i++) {
      tiny.record({
        callId: `call-${i}-${"x".repeat(64)}`,
        roleId: "R",
        stageName: "s",
        method: "m",
        caller: "local",
        durationMs: 1,
        ok: true,
        outcome: "completed",
        at: i,
      });
    }
    expect(tiny.size).toBeLessThan(500); // 字节预算生效
    expect(tiny.latest(1)[0].callId).toContain("call-"); // 最新的仍在
  });
});
