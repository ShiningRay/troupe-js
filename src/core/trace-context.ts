/**
 * 调用链追踪上下文（M8，DESIGN §11.4 OTel 打通——零依赖桥）：
 * - W3C traceparent 格式（00-<32hex>-<16hex>-01）随 CallEnvelope 传播
 * - Turn 执行经 AsyncLocalStorage 绑定上下文：Actor 内 this.cast 自动携带当前
 *   Turn 的 span 作为父（跨 Stage 经 wire 信封透传）
 * - `form({ onSpan })` 导出钩子：每个 Turn 结束回调（桥接真实 OTel SDK 用，
 *   框架自身不依赖 OTel）
 */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface SpanContext {
  /** W3C traceparent：00-<32hex traceId>-<16hex spanId>-01 */
  traceparent: string;
}

export const callAls = new AsyncLocalStorage<SpanContext>();

const HEX = "0123456789abcdef";

function hex(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += HEX[Math.floor(Math.random() * 16)];
  return s;
}

/** 生成新 span（无父）：新 traceId + spanId */
export function newSpan(): SpanContext {
  return { traceparent: `00-${hex(32)}-${hex(16)}-01` };
}

/** 子 span：继承 traceId，新 spanId；父非法则生成新 span */
export function childSpan(parent: string | undefined): SpanContext {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(parent ?? "");
  if (!m) return newSpan();
  return { traceparent: `00-${m[1]}-${hex(16)}-01` };
}

/** 便捷：从 span 提取 traceId（非法返回 null） */
export function traceIdOf(traceparent: string | undefined): string | null {
  const m = /^00-([0-9a-f]{32})-/.exec(traceparent ?? "");
  return m ? m[1] : null;
}

/** 当前 Turn 的 span（Actor 方法内 this.cast 自动携带） */
export function currentSpan(): SpanContext | undefined {
  return callAls.getStore();
}

export { randomUUID };
