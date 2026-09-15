/**
 * OTel SDK 直连适配（M11+ 收尾，PLAN §8.4）：
 * 把 `form({ onSpan })` 产生的 Turn 数据桥接到 OpenTelemetry Tracer——
 * 框架自身不依赖 @opentelemetry/api；本适配器以**结构化接口**接受任意
 * 符合 OTel API 的 Tracer（用户传入，依赖由用户安装）。
 *
 * 用法：
 *   import { trace } from "@opentelemetry/api";
 *   const troupe = await Troupe.form({
 *     onSpan: createOtelOnSpan({ tracer: trace.getTracer("troupe") }),
 *   });
 *
 * 语义：
 * - span 名：`troupe.<roleId>.<method>`
 * - traceId/spanId：从 W3C traceparent 解析并经 SpanContext 传播（不可直接设置时，
 *   以属性 `troupe.traceparent` 记录，保证调用链在 OTel 侧仍可关联）
 * - 状态：ok → UNSET(0)；业务失败/超时 → ERROR(2)
 */
import { traceIdOf } from "../core/trace-context.js";

/** OTel API Tracer 的结构化子集（兼容 @opentelemetry/api 的 Tracer） */
export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: {
      startTime?: number; // epoch ms（OTel TimeInput 接受）
      attributes?: Record<string, unknown>;
      links?: Array<{ context: { traceId: string; spanId: string }; attributes?: Record<string, unknown> }>;
    },
    context?: unknown,
  ): OtelSpanLike;
}

export interface OtelSpanLike {
  setAttribute(key: string, value: unknown): this;
  setStatus(status: { code: number; message?: string }): this;
  end(endTime?: number): this;
}

export interface OtelOnSpanOptions {
  tracer: OtelTracerLike;
  /** 额外属性注入（如服务名/环境） */
  attributes?: Record<string, unknown>;
}

export interface TurnSpanData {
  traceparent: string;
  /** 父 span（调用方）的 traceparent；顶层调用为 undefined */
  parentTraceparent?: string;
  roleId: string;
  stageName: string;
  method: string;
  durationMs: number;
  ok: boolean;
}

/** 生成 onSpan 回调：把每个 Turn 记录为 OTel span */
export function createOtelOnSpan(
  opts: OtelOnSpanOptions,
): (s: TurnSpanData) => void {
  return (s: TurnSpanData) => {
    const traceId = traceIdOf(s.traceparent);
    const spanIdHex = s.traceparent.split("-")[2] ?? "";
    // Span Link 指向父 span（调用方）；顶层调用无父 → 无 Link
    const parentTrace = traceIdOf(s.parentTraceparent ?? "");
    const parentSpanId = s.parentTraceparent?.split("-")[2];
    const links =
      parentTrace && parentSpanId
        ? [{ context: { traceId: parentTrace, spanId: parentSpanId }, attributes: { "troupe.role": s.roleId } }]
        : undefined;
    const span = opts.tracer.startSpan(
      `troupe.${s.roleId}.${s.method}`,
      {
        startTime: Date.now() - s.durationMs,
        attributes: {
          "troupe.role": s.roleId,
          "troupe.stage_name": s.stageName,
          "troupe.method": s.method,
          "troupe.duration_ms": s.durationMs,
          "troupe.ok": s.ok,
          ...(traceId ? { "troupe.trace_id": traceId } : {}),
          ...(spanIdHex ? { "troupe.span_id": spanIdHex } : {}),
          ...opts.attributes,
        },
        ...(links ? { links } : {}),
      },
    );
    if (!s.ok) {
      // SpanStatusCode.ERROR = 2（结构化传值，避免依赖 @opentelemetry/api 枚举）
      span.setStatus({ code: 2, message: "troupe turn failed" });
    }
    span.end(Date.now());
  };
}
