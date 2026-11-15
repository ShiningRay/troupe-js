import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HashRing, xxh32 } from "../src/cluster/hash-ring.js";
import { encodeWireErr, decodeWireErr } from "../src/cluster/cluster.js";
import { newSpan, traceIdOf } from "../src/core/trace-context.js";
import { wrapEnvelope, unwrapEnvelope } from "../src/core/envelope.js";
import { ConflictError, CallRejectedError, TroupeError } from "../src/core/errors.js";

/**
 * golden fixtures（ADR 0003，ROADMAP P3-2）：跨语言协议锚点。
 * 实现变更导致本测试红 = 协议漂移——必须显式更新 test/golden/protocol-v2.json
 * 并附兼容说明（R5）；troupe.cr（Crystal 仓）以同一份 fixtures 对齐。
 */
const fixtures = JSON.parse(
  readFileSync(new URL("./golden/protocol-v2.json", import.meta.url), "utf8"),
) as {
  protocolVersion: number;
  xxh32: Record<string, number>;
  hashRing: { nodes: string[]; assignments: Record<string, string> };
  traceparent: { format: string; known: { traceparent: string; traceId: string } };
  envelope: { mark: string; version: number; wrapped: Record<string, unknown> };
  wireErr: Record<string, Record<string, unknown>>;
};

describe("golden fixtures（协议锚点，P3-2）", () => {
  it("协议版本锚定：WIRE_PROTOCOL_VERSION 与 fixtures 一致", async () => {
    const { WIRE_PROTOCOL_VERSION } = await import("../src/cluster/transport.js");
    expect(WIRE_PROTOCOL_VERSION).toBe(fixtures.protocolVersion);
  });

  it("xxh32 哈希锚定（跨语言目录/环一致性）", () => {
    for (const [key, expected] of Object.entries(fixtures.xxh32)) {
      expect(xxh32(key)).toBe(expected);
    }
  });

  it("HashRing 归属锚定（同成员同键 → 同 owner）", () => {
    const ring = new HashRing(fixtures.hashRing.nodes);
    for (const [key, owner] of Object.entries(fixtures.hashRing.assignments)) {
      expect(ring.get(key)).toBe(owner);
    }
  });

  it("traceparent 格式与 traceId 提取锚定", () => {
    const { known } = fixtures.traceparent;
    expect(traceIdOf(known.traceparent)).toBe(known.traceId);
    expect(traceIdOf("garbage")).toBeNull();
    const span = newSpan();
    expect(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(span.traceparent)).toBe(true);
    expect(traceIdOf(span.traceparent)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("存储信封形状锚定（mark/version/props/idem——R6 幂等记录结构）", () => {
    const idem = { k1: { fp: "fp-hash", ok: true, value: 42, exp: 12345 } };
    const wrapped = wrapEnvelope({ a: 1 }, idem) as Record<string, unknown>;
    expect(wrapped).toEqual(fixtures.envelope.wrapped); // 深比较：漂移即红
    const unwrapped = unwrapEnvelope(wrapped);
    expect(unwrapped.props).toEqual({ a: 1 });
    expect(unwrapped.idem).toEqual(idem);
  });

  it("wire 错误编码形状锚定 + 往返解码（R5 消息兼容语义）", () => {
    for (const [name, expected] of Object.entries(fixtures.wireErr)) {
      const actual =
        name === "conflict"
          ? encodeWireErr(new ConflictError("CAS 冲突：期望 revision=1，实际 revision=2", "revision"))
          : name === "rejected"
            ? encodeWireErr(new CallRejectedError("白名单外方法", "whitelist", false))
            : encodeWireErr(new Error("boom"));
      expect(actual).toEqual(expected);
      // 往返：decode → re-encode 恒等（R5：旧字段不被丢弃）
      const decoded = decodeWireErr(actual as never);
      const reEncoded = encodeWireErr(decoded);
      expect(reEncoded.kind).toBe(expected.kind);
      expect(reEncoded.name).toBe(expected.name);
    }
  });

  it("未知错误类型 → business 兜底（R5：新增错误类不破坏旧解码）", () => {
    class FutureError extends TroupeError {}
    const err = encodeWireErr(new FutureError("new in v3"));
    expect(err.kind).toBe("business"); // 旧版本可按 business 处理（可忽略新增语义）
    expect(decodeWireErr(err).message).toBe("new in v3");
  });
});
