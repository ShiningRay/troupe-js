import { randomUUID } from "node:crypto";
import { attachContext, type Actor, type ActorContext, type ActorCtor } from "./actor.js";
import { pruneIdem, unwrapEnvelope, wrapEnvelope, type IdemMap } from "./envelope.js";
import { codecCopy } from "./codec.js";
import type { RoleMeta } from "./meta.js";
import type { PropStore, StoredProps } from "../props/prop-store.js";
import type { ReminderSpec } from "../cues/cue-store.js";
import type { OwnershipStore } from "../props/ownership.js";
import type { ActorCueApi } from "../cues/actor-cues.js";
import type { EventBus, Metrics } from "./events.js";
import {
  ActivationError,
  CallRejectedError,
  CallTimeoutError,
  ConflictError,
  InvalidActorStateError,
  SerializationError,
  TroupeError,
} from "./errors.js";

export interface CallEnvelope {
  callId: string;
  roleId: string;
  stageName: string;
  method: string;
  args: unknown[];
  /** 绝对期限（epoch ms）。排队中过期不执行；执行中超时只应答不放行（DESIGN §5.1） */
  deadline: number;
  /** 环漂移转发跳数（§6.3，上限 2）；本地发起为 0 */
  hops?: number;
}

export interface StageConfig {
  namespace: string;
  /** 每 Actor CallBoard 深度上限（DESIGN §5.3，默认 1024） */
  queueDepth: number;
  /** 排空期间新请求：wait=等待后重新激活（默认）；reject=明确拒绝（DESIGN §5.2） */
  drainPolicy: "wait" | "reject";
  /** 幂等记录保留期限 ms（DESIGN §6.5，默认 7 天） */
  idempotencyRetentionMs: number;
  /** 每 Stage 在场 Actor 数上限（全局背压，§5.3） */
  maxActivations: number;
  /** 每 Stage 总排队字节预算（全局背压，§5.3） */
  maxQueuedBytes: number;
}

/** Actor 互调句柄（DESIGN §10.1）：由 Troupe 在 form() 完成后注入 */
export type CastHandle = (first: ActorCtor<Actor<any>> | string, stageName: string) => unknown;

/** 所有权依赖（DESIGN §6.5，M3）：由 Troupe.form 组装后注入 */
export interface OwnershipDeps {
  /** Stage 身份（addr#incarnation） */
  ownerId: string;
  /** 租约时长 ms（默认 5000） */
  leaseMs: number;
  store: OwnershipStore;
  /** 当前环视图下键是否归属本 Stage（无集群时恒真） */
  isRingOwner(roleId: string, stageName: string): boolean;
}

/** 生命周期状态机（DESIGN §5.2）：未激活=不在 slots 表中 */
type SlotState = "activating" | "running" | "draining" | "invalid";

interface PendingCall {
  env: CallEnvelope;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  /** 入队时估算的字节数（排队预算扣减用） */
  bytes: number;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 入队字节估算（args 已过 Codec 边界，可安全 stringify） */
function estimateCallBytes(env: CallEnvelope): number {
  try {
    const args = JSON.stringify(env.args);
    return env.method.length + (args ? args.length : 2);
  } catch {
    return env.method.length + 256;
  }
}

class ActorSlot {
  state: SlotState = "activating";
  instance: Actor<any> | null = null;
  /** 激活 single-flight：并发首调共享同一 Promise（DESIGN §5.2） */
  activation: Promise<void> | null = null;
  queue: PendingCall[] = [];
  looping = false;
  loopPromise: Promise<void> = Promise.resolve();
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  drainWaiters: Array<() => void> = [];
  /** 当前已提交 revision；0 = 尚未落盘（首次保存走 create） */
  revision = 0;
  idem: IdemMap = {};
  /** 最近一次入队时间（观测用：空闲时长） */
  lastActivityAt = 0;
  /** 所有权 fencing token（0 = 无所有权/未启用，§6.5） */
  epoch = 0;
  /** 上次租约续租时间 */
  lastRenewAt = 0;
  /** 内存 Cue（§3.3）：随实例下场清理 */
  memoryCues = new Map<string, { timer: ReturnType<typeof setInterval>; fn: () => void | Promise<void>; inFlight: boolean }>();

  constructor(
    readonly key: string,
    readonly meta: RoleMeta,
    readonly stageName: string,
  ) {}

  notifyDrained(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }
}

function slotKey(roleId: string, stageName: string): string {
  return `${roleId}\u0000${stageName}`;
}

/** 每 N 个 Turn 让出一次事件循环（DESIGN §5.3） */
const TURN_YIELD_INTERVAL = 64;

export class StageManager {
  private readonly slots = new Map<string, ActorSlot>();
  private queuedBytes = 0;
  private closed = false;
  private leaseTicker: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: PropStore,
    private readonly roles: ReadonlyMap<string, RoleMeta>,
    private readonly events: EventBus,
    private readonly metrics: Metrics,
    private readonly config: StageConfig,
    private readonly now: () => number,
    private readonly casterRef?: { current?: CastHandle },
    private readonly ownershipRef?: { current?: OwnershipDeps },
    private readonly cueApi?: ActorCueApi,
  ) {
    if (ownershipRef) {
      // 固定节拍的续期调度器（§6.5）；每 slot 的实际续租间隔由 leaseMs/3 决定（晚绑定后可知）
      this.leaseTicker = setInterval(() => void this.renewLeases(), 500);
      this.leaseTicker.unref?.();
    }
  }

  /** 所有权依赖（晚绑定：Troupe.form 在 cluster 启动后填充） */
  private get ownership(): OwnershipDeps | undefined {
    return this.ownershipRef?.current;
  }

  /** 优雅停机第一步：拒收新 Call（存量由 drainAll 排空） */
  close(): void {
    this.closed = true;
    if (this.leaseTicker !== null) {
      clearInterval(this.leaseTicker);
      this.leaseTicker = null;
    }
  }

  private async renewLeases(): Promise<void> {
    const own = this.ownership;
    if (!own || this.closed) return;
    const cadence = Math.max(250, Math.floor(own.leaseMs / 3));
    for (const slot of [...this.slots.values()]) {
      if (slot.epoch === 0 || slot.state !== "running") continue;
      if (this.now() - slot.lastRenewAt < cadence) continue;
      slot.lastRenewAt = this.now();
      try {
        const res = await own.store.acquire(
          this.config.namespace, slot.meta.roleId, slot.stageName,
          own.ownerId, own.leaseMs,
        );
        if (!res.ok) {
          this.events.emit({
            type: "invalidated",
            roleId: slot.meta.roleId,
            stageName: slot.stageName,
            at: this.now(),
            detail: { error: `所有权丢失：被 ${res.holder.ownerId}（epoch=${res.holder.epoch}）持有` },
          });
          this.invalidate(slot, new TroupeError(`所有权丢失：holder=${res.holder.ownerId} epoch=${res.holder.epoch}`));
          continue;
        }
        slot.epoch = res.epoch;
        if (!own.isRingOwner(slot.meta.roleId, slot.stageName)) {
          // 环漂移 → 主动交接：排空 → offStage+save → 释放（§6.5 扩容交接）
          void this.drain(slot, "handover");
        }
      } catch (e) {
        // 存储不可达：不失效（可能是暂时的网络问题），记录事件
        this.events.emit({
          type: "warn",
          roleId: slot.meta.roleId,
          stageName: slot.stageName,
          at: this.now(),
          detail: { message: `租约续期存储异常（忽略本轮）：${errMessage(e)}` },
        });
      }
    }
  }

  async call(env: CallEnvelope): Promise<unknown> {
    if (this.closed) {
      throw new CallRejectedError("Stage 已停机，拒收新 Call（优雅停机中）", "shutdown", false);
    }
    for (;;) {
      const slot = await this.ensureSlot(env);
      if (slot === null) continue; // 排空已完成，重新走激活
      return this.enqueue(slot, env);
    }
  }

  /** 管理下场（M4 Director 复用）：排空 → offStage → 移除 */
  async off(roleId: string, stageName: string): Promise<void> {
    const slot = this.slots.get(slotKey(roleId, stageName));
    if (slot) await this.drain(slot, "manual");
  }

  /** 排空全部在场 Actor（优雅停机/测试钩子） */
  async drainAll(): Promise<void> {
    await Promise.all([...this.slots.values()].map((s) => this.drain(s, "shutdown")));
  }

  /** 测试/运维：在场 Actor 快照 */
  snapshotSlots(): Array<{
    roleId: string;
    stageName: string;
    state: SlotState;
    queued: number;
    revision: number;
    idleMs: number;
  }> {
    const now = this.now();
    return [...this.slots.values()].map((s) => ({
      roleId: s.meta.roleId,
      stageName: s.stageName,
      state: s.state,
      queued: s.queue.length,
      revision: s.revision,
      idleMs: s.lastActivityAt ? Math.max(0, now - s.lastActivityAt) : -1,
    }));
  }

  // ---- 激活（single-flight）与槽位管理 ----

  private async ensureSlot(env: CallEnvelope): Promise<ActorSlot | null> {
    const key = slotKey(env.roleId, env.stageName);
    const existing = this.slots.get(key);

    if (!existing) {
      const meta = this.requireMeta(env.roleId);
      if (this.slots.size >= this.config.maxActivations) {
        this.metrics.rejection(env.roleId);
        this.emitRejected(env, { state: "activating" } as ActorSlot, "backpressure");
        throw new CallRejectedError(
          `在场 Actor 数已达上限 ${this.config.maxActivations}（全局背压，§5.3）：拒绝激活 ${env.roleId}/${env.stageName}`,
          "backpressure",
          true,
        );
      }
      const slot = new ActorSlot(key, meta, env.stageName);
      this.slots.set(key, slot);
      slot.activation = this.activate(slot);
      try {
        await slot.activation;
      } catch (e) {
        throw this.wrapActivationError(slot, e);
      }
      return this.slots.get(key) === slot ? slot : null;
    }

    if (existing.state === "activating") {
      try {
        await existing.activation!;
      } catch (e) {
        throw this.wrapActivationError(existing, e);
      }
      return this.slots.get(key) === existing ? existing : null;
    }

    if (existing.state === "running") return existing;

    if (existing.state === "draining") {
      if (this.config.drainPolicy === "reject") {
        throw new CallRejectedError(
          `${env.roleId}/${env.stageName} 排空中，drainPolicy=reject：请求被拒绝（可稍后重试）`,
          "draining",
          true,
        );
      }
      // wait 策略：等排空完成后重新激活（DESIGN §5.2：不能静默丢弃）
      await new Promise<void>((r) => existing.drainWaiters.push(r));
      return null;
    }

    return null; // invalid（理论不可达：失效即从表中移除）
  }

  private requireMeta(roleId: string): RoleMeta {
    const meta = this.roles.get(roleId);
    if (!meta) throw new TroupeError(`内部错误：角色 ${roleId} 不在本 Troupe 注册表中`);
    return meta;
  }

  private wrapActivationError(slot: ActorSlot, e: unknown): Error {
    if (e instanceof ActivationError) return e;
    if (e instanceof CallRejectedError) return e; // 拒绝类（如未取得所有权）原样透传，不算激活失败
    return new ActivationError(
      `激活失败 ${slot.meta.roleId}/${slot.stageName}（加载/迁移/onStage 抛错）：${errMessage(e)}`,
      { cause: e },
    );
  }

  private async activate(slot: ActorSlot): Promise<void> {
    const { meta } = slot;
    const roleId = meta.roleId;
    const stageName = slot.stageName;
    this.events.emit({ type: "activationStarted", roleId, stageName, at: this.now() });
    try {
      // 所有权前置（§6.5）：CAS 取得租约（新 epoch > 旧）→ 才允许 OnStage
      if (this.ownership) {
        slot.epoch = await this.acquireWithRetry(slot);
      }
      const stored = await this.store.read(this.config.namespace, roleId, stageName);
      let userProps: unknown;
      if (stored) {
        const unwrapped = unwrapEnvelope(stored.props);
        slot.idem = unwrapped.idem;
        slot.revision = stored.revision;
        userProps = unwrapped.props;
      } else {
        userProps = meta.initialProps();
      }

      const instance = this.instantiate(meta);

      // schemaVersion 驱动迁移（DESIGN §7.4）：失败即激活失败，实例不进场服务
      if (stored && stored.schemaVersion < meta.schemaVersion) {
        let current = userProps;
        let v = stored.schemaVersion;
        while (v < meta.schemaVersion) {
          try {
            current = await instance.migrateProps(current as never, v);
            v++;
          } catch (e) {
            throw new TroupeError(
              `迁移失败：${roleId}/${stageName} schemaVersion ${v}→${v + 1}：${errMessage(e)}`,
              { cause: e },
            );
          }
        }
        userProps = current;
      }

      const ctx: ActorContext = {
        roleId,
        stageName,
        idem: slot.idem,
        idempotencyRetentionMs: this.config.idempotencyRetentionMs,
        now: this.now,
        save: () => this.save(slot),
        ...(this.cueApi
          ? {
              cues: {
                schedule: (name: string, spec: ReminderSpec) => this.cueApi!.schedule({ roleId, stageName }, name, spec),
                cancel: (name: string) => this.cueApi!.cancel({ roleId, stageName }, name),
              },
            }
          : {}),
        memoryCues: {
          register: (name: string, everyMs: number, fn: () => void | Promise<void>) =>
            this.registerMemoryCue(slot, name, everyMs, fn),
          cancel: (name: string) => this.clearMemoryCue(slot, name),
        },
      };
      if (this.casterRef) {
        ctx.cast = (first, targetStage) => {
          const fn = this.casterRef!.current;
          if (!fn) throw new TroupeError("cast 句柄尚未就绪（Troupe.form 未完成）");
          return fn(first, targetStage);
        };
      }
      attachContext(instance, ctx);
      instance.props = this.copyIn(userProps);
      slot.instance = instance;

      await instance.onStage();
      slot.state = "running";
      this.events.emit({ type: "activated", roleId, stageName, at: this.now() });
      this.scheduleIdle(slot);
    } catch (e) {
      slot.state = "invalid";
      this.slots.delete(slot.key);
      slot.notifyDrained();
      if (slot.epoch > 0 && this.ownership) {
        void this.ownership.store
          .release(this.config.namespace, roleId, stageName, this.ownership.ownerId, slot.epoch)
          .catch(() => {});
      }
      this.events.emit({
        type: "activationFailed",
        roleId,
        stageName,
        at: this.now(),
        detail: { error: errMessage(e) },
      });
      throw e;
    }
  }

  /** 内存 Cue（§3.3）：定时器挂 slot；fire 经串行 Turn 执行，上一拍未完成则跳过 */
  private registerMemoryCue(
    slot: ActorSlot,
    name: string,
    everyMs: number,
    fn: () => void | Promise<void>,
  ): void {
    this.clearMemoryCue(slot, name);
    const entry = { timer: null as unknown as ReturnType<typeof setInterval>, fn, inFlight: false };
    entry.timer = setInterval(() => {
      if (entry.inFlight || slot.state !== "running") return;
      entry.inFlight = true;
      void this.call({
        callId: randomUUID(),
        roleId: slot.meta.roleId,
        stageName: slot.stageName,
        method: "__memoryCue__",
        args: [name],
        deadline: this.now() + 60_000,
        hops: 0,
      })
        .catch(() => {})
        .finally(() => {
          entry.inFlight = false;
        });
    }, everyMs);
    entry.timer.unref?.();
    slot.memoryCues.set(name, entry);
  }

  private clearMemoryCue(slot: ActorSlot, name: string): void {
    const entry = slot.memoryCues.get(name);
    if (entry) {
      clearInterval(entry.timer);
      slot.memoryCues.delete(name);
    }
  }

  private clearAllMemoryCues(slot: ActorSlot): void {
    for (const name of [...slot.memoryCues.keys()]) this.clearMemoryCue(slot, name);
  }

  /** 激活期获取所有权：短重试掩盖竞态，失败则显式拒绝（调用方可安全重试） */
  private async acquireWithRetry(slot: ActorSlot): Promise<number> {
    const own = this.ownership!;
    const roleId = slot.meta.roleId;
    const stageName = slot.stageName;
    let last: { holder: { ownerId: string; epoch: number; leaseUntil: number } } | undefined;
    for (let i = 0; i < 3; i++) {
      const res = await own.store.acquire(
        this.config.namespace, roleId, stageName, own.ownerId, own.leaseMs,
      );
      if (res.ok) {
        slot.lastRenewAt = this.now();
        return res.epoch;
      }
      last = res;
      await new Promise((r) => setTimeout(r, 100));
    }
    const holder = last!.holder;
    throw new CallRejectedError(
      `未取得所有权：${roleId}/${stageName} 由 ${holder.ownerId} 持有（epoch=${holder.epoch}，租约至 ${new Date(holder.leaseUntil).toISOString()}）——稍后重试待交接/租约到期（DESIGN §6.5）`,
      "ownership",
      true,
    );
  }

  private instantiate(meta: RoleMeta): Actor<any> {
    try {
      return new (meta.ctor as new () => Actor<any>)();
    } catch (e) {
      throw new TroupeError(
        `实例化失败：${meta.roleId}（Actor 子类必须可无参构造）：${errMessage(e)}`,
        { cause: e },
      );
    }
  }

  /** 经 Codec 复制边界进入内存（本地/远程/存储三种来源行为一致，§6.1） */
  private copyIn(v: unknown): unknown {
    try {
      return codecCopy(v);
    } catch (e) {
      throw new SerializationError(`Props 无法通过复制边界：${errMessage(e)}`);
    }
  }

  // ---- 入队与严格串行调度 ----

  private enqueue(slot: ActorSlot, env: CallEnvelope): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (slot.state !== "running") {
        this.metrics.rejection(env.roleId);
        reject(
          new CallRejectedError(
            `${env.roleId}/${env.stageName} 状态=${slot.state}，拒绝请求（可安全重试）`,
            "invalidated",
            true,
          ),
        );
        return;
      }
      if (slot.queue.length >= this.config.queueDepth) {
        this.metrics.rejection(env.roleId);
        this.emitRejected(env, slot, "backpressure");
        reject(
          new CallRejectedError(
            `CallBoard 已满：${env.roleId}/${env.stageName} 排队 ${slot.queue.length} ≥ 上限 ${this.config.queueDepth}（DESIGN §5.3）`,
            "backpressure",
            true,
          ),
        );
        return;
      }
      const bytes = estimateCallBytes(env);
      if (this.queuedBytes + bytes > this.config.maxQueuedBytes) {
        this.metrics.rejection(env.roleId);
        this.emitRejected(env, slot, "backpressure");
        reject(
          new CallRejectedError(
            `排队字节预算超限：当前 ${this.queuedBytes}B + 本请求 ${bytes}B > 上限 ${this.config.maxQueuedBytes}B（全局背压，§5.3）`,
            "backpressure",
            true,
          ),
        );
        return;
      }
      if (this.now() >= env.deadline) {
        this.metrics.rejection(env.roleId);
        this.emitRejected(env, slot, "queued-expired");
        reject(
          new CallTimeoutError(
            `排队过期：callId=${env.callId} 未开始执行即超过 deadline（无副作用，可安全重试）`,
            "queued",
          ),
        );
        return;
      }
      this.clearIdle(slot);
      slot.lastActivityAt = this.now();
      slot.queue.push({ env, resolve, reject, bytes });
      this.queuedBytes += bytes;
      this.scheduleLoop(slot);
    });
  }

  private emitRejected(env: CallEnvelope, slot: ActorSlot, reason: string): void {
    this.events.emit({
      type: "callRejected",
      roleId: env.roleId,
      stageName: slot.stageName,
      method: env.method,
      at: this.now(),
      detail: { reason },
    });
  }

  private scheduleLoop(slot: ActorSlot): void {
    if (slot.looping) return;
    slot.looping = true;
    slot.loopPromise = (async () => {
      let turns = 0;
      try {
        for (;;) {
          const call = this.nextCall(slot);
          if (!call) break;
          await this.runTurn(slot, call);
          // 周期性让出事件循环（§5.3）：防止微任务连续流饿死定时器与 IO
          if (++turns % TURN_YIELD_INTERVAL === 0) {
            await new Promise<void>((r) => setImmediate(r));
          }
        }
      } finally {
        slot.looping = false;
        this.onQueueEmpty(slot);
      }
    })();
  }

  /** 弹出下一个未过期 Call；过期者就地拒绝（从未执行，无副作用） */
  private nextCall(slot: ActorSlot): PendingCall | null {
    for (;;) {
      const call = slot.queue.shift();
      if (!call) return null;
      this.queuedBytes -= call.bytes;
      if (this.now() >= call.env.deadline) {
        this.metrics.rejection(call.env.roleId);
        this.emitRejected(call.env, slot, "queued-expired");
        call.reject(
          new CallTimeoutError(
            `排队过期：callId=${call.env.callId} 在开始执行前超过 deadline（无副作用，可安全重试）`,
            "queued",
          ),
        );
        continue;
      }
      return call;
    }
  }

  private async runTurn(slot: ActorSlot, call: PendingCall): Promise<void> {
    const { env, resolve, reject } = call;
    const startedAt = this.now();
    this.events.emit({
      type: "turnStarted",
      roleId: env.roleId,
      stageName: env.stageName,
      method: env.method,
      at: startedAt,
    });

    // 接收端白名单（§6.1 防御纵深；Agent 侧已过滤一次）
    const inst = slot.instance;
    // onCue / __memoryCue__ 是调度器内部专用通道（集群边缘/Agent 白名单不暴露，仅本地分派）
    if (
      !inst ||
      (env.method !== "onCue" &&
        env.method !== "__memoryCue__" &&
        !slot.meta.rpcMethods.has(env.method))
    ) {
      this.metrics.rejection(env.roleId);
      reject(
        new CallRejectedError(
          `方法 "${env.method}" 不在 ${env.roleId} 的 RPC 白名单（DESIGN §6.1）`,
          "whitelist",
          false,
        ),
      );
      return;
    }

    const exec =
      env.method === "__memoryCue__"
        ? (async () => {
            const cue = slot.memoryCues.get(env.args[0] as string);
            if (!cue) return undefined; // 已注销：静默完成
            return await cue.fn();
          })()
        : (async () => {
            const fn = (inst as unknown as Record<string, (...a: unknown[]) => unknown>)[env.method];
            return await fn.apply(inst, env.args);
          })();

    const timeoutMs = Math.max(0, env.deadline - this.now());
    let answered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, timeoutReject) => {
      timer = setTimeout(() => {
        if (answered) return; // 调用方已拿到结果，超时作废
        timeoutReject(
          new CallTimeoutError(
            `执行超时（${timeoutMs}ms）：${env.roleId}/${env.stageName}.${env.method} 结果未知；执行占用保持到原执行结束（DESIGN §5.1）`,
            "executing",
          ),
        );
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([exec, timeoutPromise]);
      if (!answered) {
        answered = true;
        resolve(result);
      }
    } catch (e) {
      if (!answered) {
        answered = true;
        reject(e);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // 执行占用（DESIGN §5.1）：调用方超时后原执行继续；settle 前不放行下一 Turn
    let execOk = true;
    try {
      await exec;
    } catch {
      execOk = false;
    }

    this.metrics.call(env.roleId, this.now() - startedAt, execOk);
    this.events.emit({
      type: "turnEnded",
      roleId: env.roleId,
      stageName: env.stageName,
      method: env.method,
      at: this.now(),
      detail: { ok: execOk },
    });
  }

  // ---- 空闲回收与排空 ----

  private onQueueEmpty(slot: ActorSlot): void {
    if (this.slots.get(slot.key) !== slot) return;
    if (slot.state !== "running") return;
    this.scheduleIdle(slot);
  }

  private scheduleIdle(slot: ActorSlot): void {
    this.clearIdle(slot);
    const ms = slot.meta.intermissionMs;
    if (!(ms > 0)) return; // <=0：禁用自动下场
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      void this.drain(slot, "intermission");
    }, ms);
    (slot.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearIdle(slot: ActorSlot): void {
    if (slot.idleTimer !== null) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  }

  private async drain(
    slot: ActorSlot,
    reason: "intermission" | "shutdown" | "manual" | "handover",
  ): Promise<void> {
    if (slot.state !== "running") return;
    slot.state = "draining";
    this.clearIdle(slot);
    this.clearAllMemoryCues(slot); // 内存 Cue 随下场消失（§3.3）；重新登台经 onStage 重注册
    this.events.emit({
      type: "drainStarted",
      roleId: slot.meta.roleId,
      stageName: slot.stageName,
      at: this.now(),
      detail: { reason },
    });

    // quiesce：等所有运行中 Turn 与框架回调结束（§5.2；非只等"当前 turn"）
    await slot.loopPromise;

    // offStage/save 期间可能已失效（跨 await 的状态变化，显式放宽收窄）
    if ((slot.state as SlotState) === "invalid") {
      this.slots.delete(slot.key);
      slot.notifyDrained();
      return;
    }
    this.rejectRemaining(slot); // 保险：排空期间不应有新入队

    const inst = slot.instance;
    if (inst) {
      try {
        await inst.offStage();
        this.events.emit({
          type: "offStage",
          roleId: slot.meta.roleId,
          stageName: slot.stageName,
          at: this.now(),
          detail: { reason },
        });
      } catch (e) {
        this.events.emit({
          type: "offStageFailed",
          roleId: slot.meta.roleId,
          stageName: slot.stageName,
          at: this.now(),
          detail: { reason, error: errMessage(e) },
        });
        this.invalidate(slot, e);
        return;
      }
    }

    this.slots.delete(slot.key);
    slot.notifyDrained();
    // 所有权交接收尾：释放（仅 owner+epoch 匹配时生效；旧持有者不误删新租约）
    if (slot.epoch > 0 && this.ownership) {
      const own = this.ownership;
      void own.store
        .release(this.config.namespace, slot.meta.roleId, slot.stageName, own.ownerId, slot.epoch)
        .catch(() => {});
    }
  }

  private rejectRemaining(slot: ActorSlot): void {
    for (const call of slot.queue.splice(0)) {
      this.queuedBytes -= call.bytes;
      this.metrics.rejection(call.env.roleId);
      this.emitRejected(call.env, slot, "invalidated");
      call.reject(
        new CallRejectedError(
          `${call.env.roleId}/${slot.stageName} 实例已失效，排队请求被拒绝（可安全重试）`,
          "invalidated",
          true,
        ),
      );
    }
  }

  private invalidate(slot: ActorSlot, error: unknown): void {
    if (slot.state === "invalid") return;
    slot.state = "invalid";
    if (this.slots.get(slot.key) === slot) this.slots.delete(slot.key);
    this.clearIdle(slot);
    this.clearAllMemoryCues(slot);
    this.rejectRemaining(slot);
    this.events.emit({
      type: "invalidated",
      roleId: slot.meta.roleId,
      stageName: slot.stageName,
      at: this.now(),
      detail: { error: errMessage(error) },
    });
    slot.notifyDrained();
  }

  // ---- 保存（CAS）与失败语义 ----

  private async save(slot: ActorSlot): Promise<void> {
    const { meta } = slot;
    const roleId = meta.roleId;
    const stageName = slot.stageName;
    if (this.slots.get(slot.key) !== slot || slot.state === "invalid" || !slot.instance) {
      throw new InvalidActorStateError(
        `实例已失效，拒绝保存：${roleId}/${stageName}（DESIGN §7.3）`,
      );
    }
    try {
      const payload = this.wrapForStore(slot);
      let stored: StoredProps;
      if (slot.revision === 0) {
        try {
          stored = await this.store.create(
            this.config.namespace, roleId, stageName, payload, meta.schemaVersion,
          );
        } catch (e) {
          if (e instanceof ConflictError && e.kind === "exists") {
            // 竞态兜底：记录已存在 → 读取实际 revision 后按 CAS 重试一次
            const cur = await this.store.read(this.config.namespace, roleId, stageName);
            if (!cur) throw e;
            slot.revision = cur.revision;
            stored = await this.store.write(
              this.config.namespace, roleId, stageName, payload,
              { expectedRevision: slot.revision, schemaVersion: meta.schemaVersion },
            );
          } else {
            throw e;
          }
        }
      } else {
        stored = await this.store.write(
          this.config.namespace, roleId, stageName, payload,
          {
            expectedRevision: slot.revision,
            schemaVersion: meta.schemaVersion,
            ...(this.ownership && slot.epoch > 0 ? { fencingToken: slot.epoch } : {}),
          },
        );
      }
      slot.revision = stored.revision;
      this.events.emit({
        type: "saveSucceeded",
        roleId,
        stageName,
        at: this.now(),
        detail: { revision: stored.revision },
      });
    } catch (e) {
      this.events.emit({
        type: "saveFailed",
        roleId,
        stageName,
        at: this.now(),
        detail: { error: errMessage(e) },
      });
      // 保存失败默认实例失效（DESIGN §7.3）：下次调用从最后已提交快照重新加载
      this.invalidate(slot, e);
      throw e;
    }
  }

  private wrapForStore(slot: ActorSlot): unknown {
    try {
      return wrapEnvelope(codecCopy(slot.instance!.props), pruneIdem(slot.idem, this.now()));
    } catch (e) {
      throw new SerializationError(
        `Props 无法通过复制边界：${slot.meta.roleId}/${slot.stageName}：${errMessage(e)}（默认边界语义见 DESIGN §6.1）`,
      );
    }
  }
}
