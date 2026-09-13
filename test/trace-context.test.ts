import { describe, expect, it } from "vitest";
import { Actor, Troupe, traceIdOf } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";

class AActor extends Actor<Record<string, never>> {
  static role = "A";
  static initialProps = () => ({}) as Record<string, never>;

  async go() {
    await this.cast(BActor, "b1").ping();
    return "a-done";
  }
}

class BActor extends Actor<Record<string, never>> {
  static role = "B";
  static initialProps = () => ({}) as Record<string, never>;

  async ping() {
    return "pong";
  }
}

describe("M8 验收：调用链追踪（W3C traceparent + onSpan，DESIGN §11.4）", () => {
  it("traceIdOf 解析与拒绝", () => {
    expect(traceIdOf("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
    expect(traceIdOf("garbage")).toBeNull();
    expect(traceIdOf(undefined)).toBeNull();
  });

  it("顶层调用生成新 trace；Actor 内 cast 链共享 traceId、spanId 不同", async () => {
    const spans: Array<{ traceparent: string; roleId: string; method: string; ok: boolean }> = [];
    const troupe = await Troupe.form({
      actors: [AActor, BActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      onSpan: (s) => spans.push(s),
    });
    expect(await troupe.cast(AActor, "a1").go()).toBe("a-done");
    await sleep(30);

    expect(spans.length).toBe(2);
    const a = spans.find((s) => s.roleId === "A")!;
    const b = spans.find((s) => s.roleId === "B")!;
    const traceA = traceIdOf(a.traceparent)!;
    const traceB = traceIdOf(b.traceparent)!;
    expect(traceA).toBe(traceB); // 同一调用链
    expect(a.traceparent).not.toBe(b.traceparent); // span 不同
    expect(a.ok).toBe(true);
    await troupe.drainAll();
  });

  it("无 onSpan 时零开销路径（不报错）", async () => {
    const troupe = await Troupe.form({
      actors: [BActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    expect(await troupe.cast(BActor, "b2").ping()).toBe("pong");
    await troupe.drainAll();
  });
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
