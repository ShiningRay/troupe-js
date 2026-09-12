import { randomUUID } from "node:crypto";
import type { CueStore, ReminderRecord } from "./cue-store.js";
import { nextDueAfter } from "./cue-store.js";
import type { StageManager } from "../core/stage-manager.js";
import type { EventBus } from "../core/events.js";

export interface CueSchedulerOptions {
  tickMs: number; // 默认 1000（DESIGN §8.2 Cue tick）
  claimLeaseMs: number; // 执行租约（默认 30s；宕机后到期重投递）
  cueTimeoutMs: number; // onCue 调用期限
  retryBackoffMs: number; // onCue 失败后的重试退避
  batchSize: number;
}

const DEFAULTS: CueSchedulerOptions = {
  tickMs: 1_000,
  claimLeaseMs: 30_000,
  cueTimeoutMs: 30_000,
  retryBackoffMs: 1_000,
  batchSize: 64,
};

/**
 * 提醒调度器（DESIGN §7.5）：
 * - 每 tick 查询到期提醒（仅本 Stage 环归属的键）→ 原子 claim → 以 onCue(name, payload)
 *   作为一条 Call 进入该 Actor 的串行 Turn（不在场则重新登台）→ complete（CAS）。
 * - 至少一次投递：执行中宕机 → 租约到期后被重新 claim、重复投递；业务需幂等。
 * - 错过多个周期：complete 时 nextDue = now + every（跳过并立即补发一次，不追赶）。
 */
export class CueScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private opts: CueSchedulerOptions;

  constructor(
    private readonly store: CueStore,
    private readonly namespace: string,
    private readonly ownerId: string,
    private readonly isRingOwner: (roleId: string, stageName: string) => boolean,
    private readonly stageManager: StageManager,
    private readonly events: EventBus,
    private readonly now: () => number,
    opts: Partial<CueSchedulerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  start(): void {
    if (this.timer !== null) return;
    // 错相位启动，避免多 Stage 同拍查询
    const jitter = Math.floor(Math.random() * this.opts.tickMs);
    setTimeout(() => {
      this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
      this.timer.unref?.();
      void this.tick();
    }, jitter).unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  list(): Promise<ReminderRecord[]> {
    return this.store.list(this.namespace);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.store.due(this.now(), this.opts.batchSize);
      for (const rec of due) {
        if (!this.isRingOwner(rec.roleId, rec.stageName)) continue;
        await this.fire(rec);
      }
    } catch (e) {
      this.events.emit({
        type: "warn",
        roleId: "<cues>",
        at: this.now(),
        detail: { message: `Cue tick 异常（忽略本轮）：${e instanceof Error ? e.message : String(e)}` },
      });
    } finally {
      this.ticking = false;
    }
  }

  private async fire(rec: ReminderRecord): Promise<void> {
    const key = {
      namespace: rec.namespace,
      roleId: rec.roleId,
      stageName: rec.stageName,
      name: rec.name,
    };
    const now = this.now();
    const claimed = await this.store.claim(key, this.ownerId, now + this.opts.claimLeaseMs, now);
    if (!claimed) return; // 被他人认领或已注销
    try {
      await this.stageManager.call({
        callId: randomUUID(),
        roleId: rec.roleId,
        stageName: rec.stageName,
        method: "onCue",
        args: [rec.name, rec.payload],
        deadline: now + this.opts.cueTimeoutMs,
        hops: 0,
      });
      const next = nextDueAfter(rec, this.now());
      const ok = await this.store.complete(key, claimed.statusVersion, next);
      this.events.emit({
        type: "cueFired",
        roleId: rec.roleId,
        stageName: rec.stageName,
        method: rec.name,
        at: this.now(),
        detail: { completed: ok, nextDue: next },
      });
    } catch (e) {
      // 失败退避后重试（至少一次语义；业务需幂等）
      await this.store
        .complete(key, claimed.statusVersion, this.now() + this.opts.retryBackoffMs)
        .catch(() => {});
      this.events.emit({
        type: "cueFailed",
        roleId: rec.roleId,
        stageName: rec.stageName,
        method: rec.name,
        at: this.now(),
        detail: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }
}
