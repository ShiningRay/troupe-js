import { describe, expect, it } from "vitest";
import { Actor, createOtelOnSpan, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { sleep } from "./helpers.js";

interface MockSpan {
  name: string;
  options: Record<string, unknown>;
  status?: { code: number; message?: string };
  ended: boolean;
}

class ChainActor extends Actor<Record<string, never>> {
  static role = "Chain";
  static initialProps = () => ({}) as Record<string, never>;

  async start() {
    return this.cast(LeafActor, "leaf-1").ping();
  }
}

class LeafActor extends Actor<Record<string, never>> {
  static role = "Leaf";
  static initialProps = () => ({}) as Record<string, never>;

  async ping() {
    return "pong";
  }

  async boom() {
    throw new Error("业务失败");
  }
}

describe("M11+ 收尾：OTel SDK 直连适配（createOtelOnSpan）", () => {
  it("每个 Turn 产出一个 span：名称/属性/耗时/错误状态/Link 关联调用链", async () => {
    const spans: MockSpan[] = [];
    const tracer = {
      startSpan(name: string, options: Record<string, unknown>) {
        const span: MockSpan = { name, options, ended: false };
        spans.push(span);
        return {
          setAttribute(k: string, v: unknown) {
            (span.options as Record<string, unknown>)[k] = v;
            return this;
          },
          setStatus(s: { code: number; message?: string }) {
            span.status = s;
            return this;
          },
          end() {
            span.ended = true;
          },
        };
      },
    };

    const troupe = await Troupe.form({
      actors: [ChainActor, LeafActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      onSpan: createOtelOnSpan({ tracer, attributes: { "service.name": "demo" } }),
    });
    await troupe.cast(LeafActor, "ok-1").ping();
    await sleep(20);
    const okSpan = spans.find((s) => s.name === "troupe.Leaf.ping")!;
    expect(okSpan).toBeDefined();
    expect(okSpan.ended).toBe(true);
    expect(okSpan.status).toBeUndefined(); // 成功 → 不设 ERROR
    const attrs = okSpan.options.attributes as Record<string, unknown>;
    expect(attrs["troupe.role"]).toBe("Leaf");
    expect(attrs["service.name"]).toBe("demo");
    expect(attrs["troupe.ok"]).toBe(true);

    // 失败 Turn → ERROR 状态（code 2）
    await troupe.cast(LeafActor, "bad-1").boom().catch(() => {});
    await sleep(20);
    const errSpan = spans.find((s) => s.name === "troupe.Leaf.boom")!;
    expect(errSpan.status).toMatchObject({ code: 2 });
    await troupe.drainAll();
  });

  it("调用链：Actor→Actor 两 Turn 的 traceparent 同 traceId，span 以 Link 关联", async () => {
    const spans: MockSpan[] = [];
    const tracer = {
      startSpan(name: string, options: Record<string, unknown>) {
        const span: MockSpan = { name, options, ended: false };
        spans.push(span);
        return {
          setAttribute: () => this,
          setStatus: () => this,
          end() {
            span.ended = true;
          },
        };
      },
    };
    const troupe = await Troupe.form({
      actors: [ChainActor, LeafActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      onSpan: createOtelOnSpan({ tracer }),
    });
    await troupe.cast(ChainActor, "c1").start();
    await sleep(20);

    const chain = spans.find((s) => s.name === "troupe.Chain.start")!;
    const leaf = spans.find((s) => s.name === "troupe.Leaf.ping")!;
    const attr = (o: Record<string, unknown>, k: string) =>
      (o.attributes as Record<string, unknown>)[k] as string;
    const chainTrace = attr(chain.options, "troupe.trace_id");
    const leafTrace = attr(leaf.options, "troupe.trace_id");
    expect(chainTrace).toMatch(/^[0-9a-f]{32}$/);
    expect(leafTrace).toBe(chainTrace); // Actor→Actor：同一 traceId

    // Leaf span 带 Link 指向父 span（Chain 的 traceId + spanId）
    const links = (leaf.options as { links?: Array<{ context: { traceId: string; spanId: string } }> }).links;
    expect(links?.[0]?.context.traceId).toBe(chainTrace);
    expect(links?.[0]?.context.spanId).toBe(attr(chain.options, "troupe.span_id"));
    expect(attr(leaf.options, "troupe.span_id")).not.toBe(attr(chain.options, "troupe.span_id"));
    // 顶层调用（Chain）：无父 → 无 Link
    expect((chain.options as { links?: unknown }).links).toBeUndefined();
    await troupe.drainAll();
  });
});
