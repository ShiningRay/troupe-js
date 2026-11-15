/** 观测埋点与测试注入接口（PLAN M1：完整界面后移） */

export type TroupeEventType =
  | "warn"
  | "activationStarted"
  | "activated"
  | "activationFailed"
  | "callRejected"
  | "turnStarted"
  | "turnEnded"
  | "drainStarted"
  | "offStage"
  | "offStageFailed"
  | "invalidated"
  | "ownershipRecovered"
  | "saveSucceeded"
  | "saveFailed"
  | "clusterStarted"
  | "membershipChanged"
  | "cueFired"
  | "cueFailed"
  | "cueSkipped"
  | "leaseRenewFailed"
  | "showPublished"
  | "showDelivered"
  | "showDropped"
  | "codeSwapped";

export interface TroupeEvent {
  type: TroupeEventType;
  roleId: string;
  stageName?: string;
  method?: string;
  at: number;
  detail?: Record<string, unknown>;
}

export class EventBus {
  private listeners = new Set<(e: TroupeEvent) => void>();

  /** 订阅埋点事件；返回退订函数。监听器抛错不影响运行时。 */
  on(listener: (e: TroupeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(e: TroupeEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // 埋点失败不影响运行时
      }
    }
  }
}

export interface RoleMetricsSnapshot {
  calls: number;
  errors: number;
  rejections: number;
  /** 内存 Cue 因上一拍未完成而被跳过的次数（游戏循环变慢的首要信号） */
  cueSkipped: number;
  /** 租约续期失败次数（ADR 0002 I4：连续失败触发 stop-serving） */
  leaseRenewFailures: number;
  /** 环漂移交接次数（ADR 0004 §4 handoff：排空→落盘→释放→新 owner 接管） */
  handovers: number;
  latency: { p50: number; p99: number; max: number; samples: number };
}

const RING_SIZE = 256;

export class Metrics {
  private byRole = new Map<
    string,
    { calls: number; errors: number; rejections: number; cueSkipped: number; leaseRenewFailures: number; handovers: number; ring: number[] }
  >();

  constructor(private readonly now: () => number) {}

  private role(roleId: string) {
    let r = this.byRole.get(roleId);
    if (!r) {
      r = { calls: 0, errors: 0, rejections: 0, cueSkipped: 0, leaseRenewFailures: 0, handovers: 0, ring: [] };
      this.byRole.set(roleId, r);
    }
    return r;
  }

  /** 记录一次完成的 Turn（ok=false 表示业务执行抛错；调用方超时不计入 errors） */
  call(roleId: string, latencyMs: number, ok: boolean): void {
    const r = this.role(roleId);
    r.calls++;
    if (!ok) r.errors++;
    if (r.ring.length >= RING_SIZE) r.ring.shift();
    r.ring.push(latencyMs);
  }

  rejection(roleId: string): void {
    this.role(roleId).rejections++;
  }

  /** 内存 Cue 跳拍计数（上一拍未完成，本拍丢弃） */
  cueSkipped(roleId: string): void {
    this.role(roleId).cueSkipped++;
  }

  /** 租约续期存储失败计数（ADR 0002 I4：不再"仅 warn 继续"，连续失败 → 停止接单） */
  leaseRenewFailed(roleId: string): void {
    this.role(roleId).leaseRenewFailures++;
  }

  /** 环漂移交接计数（ADR 0004 §4：建议性迁移的排空落盘释放） */
  handover(roleId: string): void {
    this.role(roleId).handovers++;
  }

  snapshot(): Record<string, RoleMetricsSnapshot> {
    const out: Record<string, RoleMetricsSnapshot> = {};
    for (const [roleId, r] of this.byRole) {
      const sorted = [...r.ring].sort((a, b) => a - b);
      const pick = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
      out[roleId] = {
        calls: r.calls,
        errors: r.errors,
        rejections: r.rejections,
        cueSkipped: r.cueSkipped,
        leaseRenewFailures: r.leaseRenewFailures,
        handovers: r.handovers,
        latency: {
          p50: pick(0.5),
          p99: pick(0.99),
          max: sorted.length ? sorted[sorted.length - 1] : 0,
          samples: sorted.length,
        },
      };
    }
    return out;
  }
}
