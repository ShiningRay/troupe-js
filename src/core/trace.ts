/**
 * Trace 总线（DESIGN §11.4，M6）：
 * - 每 Stage 环形缓冲（默认 1 万条）+ 字节预算
 * - 采样率（每 N 条取 1）与按角色/方法过滤
 * - 实时订阅（live）与历史查询（latest）
 * TraceEvent 在 Turn 边界产出：调用方（已知时）、方法、耗时、结果。
 */
export interface TraceEvent {
  callId: string;
  roleId: string;
  stageName: string;
  method: string;
  /** 调用方（wire 信封 from；本地调用为 local） */
  caller: string;
  /** 执行耗时 ms（排队等待不含） */
  durationMs: number;
  ok: boolean;
  /** completed=正常结束；timeout=调用方超时（结果未知）；rejected=启动即拒 */
  outcome: "completed" | "timeout" | "rejected";
  at: number;
  /** W3C traceparent（M8 调用链追踪） */
  traceparent: string;
}

export interface TraceFilter {
  roleId?: string;
  method?: string;
}

export interface TraceOptions {
  capacity: number; // 默认 10_000
  sampleEvery: number; // 默认 1（全采）
  byteBudget: number; // 默认 4MB
}

const DEFAULTS: TraceOptions = { capacity: 10_000, sampleEvery: 1, byteBudget: 4 * 1024 * 1024 };

export class TraceBus {
  private ring: TraceEvent[] = [];
  private bytes = 0;
  private counter = 0;
  private listeners = new Set<(e: TraceEvent) => void>();
  private opts: TraceOptions;

  constructor(opts: Partial<TraceOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  record(e: TraceEvent): void {
    this.counter++;
    if (this.opts.sampleEvery > 1 && this.counter % this.opts.sampleEvery !== 0) return;
    const size = e.callId.length + e.roleId.length + e.stageName.length + e.method.length + e.caller.length + 64;
    this.ring.push(e);
    this.bytes += size;
    while (this.ring.length > this.opts.capacity || this.bytes > this.opts.byteBudget) {
      const dropped = this.ring.shift();
      if (!dropped) break;
      this.bytes -=
        dropped.callId.length + dropped.roleId.length + dropped.stageName.length + dropped.method.length + dropped.caller.length + 64;
    }
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // 监听器抛错不影响运行时
      }
    }
  }

  matches(e: TraceEvent, f?: TraceFilter): boolean {
    if (!f) return true;
    if (f.roleId !== undefined && e.roleId !== f.roleId) return false;
    if (f.method !== undefined && e.method !== f.method) return false;
    return true;
  }

  /** 历史查询：最新 n 条（倒序返回，新的在前） */
  latest(n: number, filter?: TraceFilter): TraceEvent[] {
    const out: TraceEvent[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < n; i--) {
      if (this.matches(this.ring[i], filter)) out.push(this.ring[i]);
    }
    return out;
  }

  /** 实时订阅；返回退订函数 */
  live(filter: TraceFilter | undefined, fn: (e: TraceEvent) => void): () => void {
    const wrapped = (e: TraceEvent) => {
      if (this.matches(e, filter)) fn(e);
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }

  get size(): number {
    return this.ring.length;
  }
}
