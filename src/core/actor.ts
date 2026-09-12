import { IdempotencyConflictError, TroupeError } from "./errors.js";
import type { IdemMap } from "./envelope.js";
import type { Agent } from "./agent.js";
import type { ReminderSpec } from "../cues/cue-store.js";
import { parseDuration } from "./duration.js";
import { decoratedCueHandler } from "./cue-dispatch.js";

/** 运行时注入到每个 Actor 实例的上下文（对调用方不可见，DESIGN §3.2） */
export interface ActorContext {
  roleId: string;
  stageName: string;
  save(): Promise<void>;
  idem: IdemMap;
  idempotencyRetentionMs: number;
  now(): number;
  /** Actor 互调（DESIGN §10.1）：由 Troupe 注入的 cast 句柄（M1 为进程内直连） */
  cast?: (first: ActorCtor<Actor<any>> | string, stageName: string) => unknown;
  /** 持久提醒（DESIGN §3.3/§7.5）：form({ cues: true }) 启用后注入 */
  cues?: {
    schedule(name: string, spec: ReminderSpec): Promise<void>;
    cancel(name: string): Promise<boolean>;
  };
  /** 内存 Cue（DESIGN §3.3）：随实例下场消失，仅在场时有效；经串行 Turn 执行 */
  memoryCues?: {
    register(name: string, everyMs: number, fn: () => void | Promise<void>): void;
    cancel(name: string): void;
  };
}

const CTX = Symbol("troupe.actorCtx");

/**
 * Actor 基类（DESIGN §3.1）。
 *
 * 约定：
 * - 子类必须可无参构造（框架激活时 new ctor()）
 * - this.props 由运行时在 onStage 前注入：已提交快照（经复制边界）或 initialProps()
 * - 状态演进由 schemaVersion 驱动 migrateProps（§7.4）
 */
export abstract class Actor<TProps = unknown> {
  /** 由运行时注入（首次为 initialProps()，之后为最后已提交快照的副本） */
  props!: TProps;

  /** 运行时注入的上下文；直接 new 出来的实例上不存在 */
  declare readonly [CTX]: ActorContext;

  get stageName(): string {
    return this[CTX]?.stageName;
  }

  /**
   * Actor 互调（DESIGN §10.1）：获取其它角色的 Agent。
   * 经当前 Troupe 的 Repertoire 校验；M1 为进程内直连，M2 起经 Playbill 路由。
   */
  protected cast<T extends Actor<any>>(target: ActorCtor<T>, stageName: string): Agent<T>;
  protected cast<T extends Actor<any>>(roleId: string, stageName: string): Agent<T>;
  protected cast<T extends Actor<any>>(
    first: ActorCtor<T> | string,
    stageName: string,
  ): Agent<T> {
    const cast = this[CTX]?.cast;
    if (!cast) throw new TroupeError("当前运行时未注入 cast 句柄");
    return cast(first, stageName) as Agent<T>;
  }

  /** 显式持久化（DESIGN §7.3）：持久成功语义下，提交成功后才应返回业务成功 */
  protected async saveProps(): Promise<void> {
    return this[CTX].save();
  }

  /**
   * 幂等执行（DESIGN §6.5 失败契约）：
   * - 同键同参数指纹 → 重放首次结果（或重抛首次错误）
   * - 同键不同参数指纹 → IdempotencyConflictError
   * - fn 内只修改内存状态、不要 saveProps：helper 在 fn settle 后把
   *   Props 变更 + 幂等记录**一次原子提交**（持久成功语义，§7.3）
   * - 保留期限默认 7 天（form 可配），过期后同键视为新操作
   */
  protected async idempotent<T>(key: string, fingerprint: string, fn: () => Promise<T>): Promise<T> {
    const ctx = this[CTX];
    const existing = ctx.idem[key];
    if (existing && existing.exp > ctx.now()) {
      if (existing.fp !== fingerprint) {
        throw new IdempotencyConflictError(
          `幂等键 "${key}" 已用于不同参数指纹（${existing.fp} ≠ ${fingerprint}）`,
        );
      }
      if (existing.ok) return existing.value as T;
      const err = new Error(existing.err?.message ?? "");
      err.name = existing.err?.name ?? "Error";
      throw err;
    }
    let ok = true;
    let value: T | undefined;
    let errInfo: { name: string; message: string } | undefined;
    try {
      value = await fn();
      return value;
    } catch (e) {
      ok = false;
      const err = e as Error;
      errInfo = { name: err?.name ?? "Error", message: err?.message ?? String(err) };
      throw e;
    } finally {
      ctx.idem[key] = {
        fp: fingerprint,
        ok,
        ...(ok ? { value } : { err: errInfo }),
        exp: ctx.now() + ctx.idempotencyRetentionMs,
      };
      // 原子提交：业务状态 + 幂等记录同一行落盘（失败则实例按 §7.3 失效）
      await ctx.save();
    }
  }

  /**
   * 持久提醒（DESIGN §3.3/§7.5）：稳定名称 + 可序列化负载；不持久化闭包。
   * every=周期（"2s"/毫秒），at=一次性绝对时间；触发时经 onCue 进入串行 Turn。
   */
  protected async scheduleReminder(name: string, spec: ReminderSpec): Promise<void> {
    const cues = this[CTX]?.cues;
    if (!cues) throw new TroupeError("未启用持久提醒：Troupe.form({ cues: true })（DESIGN §7.5）");
    return cues.schedule(name, spec);
  }

  /** 注销提醒；返回是否存在 */
  protected async cancelReminder(name: string): Promise<boolean> {
    const cues = this[CTX]?.cues;
    if (!cues) throw new TroupeError("未启用持久提醒：Troupe.form({ cues: true })");
    return cues.cancel(name);
  }

  /**
   * 内存 Cue（DESIGN §3.3）：仅在场时有效的轻量定时器——随实例下场自动消失，
   * 重新登台（onStage）时需重新注册。回调经该 Actor 的串行 Turn 执行（§5.2，
   * 不与业务调用交错）；周期内上一拍未完成则跳过本拍（不堆积）。
   * 适合：攒批 flush、会话心跳等"在场才有意义"的周期任务。
   */
  protected registerCue(name: string, every: string | number, fn: () => void | Promise<void>): void {
    const mc = this[CTX]?.memoryCues;
    if (!mc) throw new TroupeError("内存 Cue 不可用（运行时未注入）");
    mc.register(name, parseDuration(every), fn);
  }

  /** 注销内存 Cue（下场时框架自动全部清理，通常无需手动调用） */
  protected cancelCue(name: string): void {
    this[CTX]?.memoryCues?.cancel(name);
  }

  /** 登台钩子：this.props 已就绪（可选） */
  async onStage(): Promise<void> {}

  /** 下场钩子：需要持久化时在此 saveProps()（可选） */
  async offStage(): Promise<void> {}

  /**
   * 持久提醒的稳定入口（§3.3）：调度器以内部 Call 分派，与业务调用同一串行 Turn；
   * 至少一次投递——业务需按 (name, payload) 幂等（§7.5）。
   * 默认实现分派到 @Cron/@Every 装饰的同名方法；覆写时可 super.onCue 兜底。
   */
  async onCue(name: string, payload: unknown): Promise<void> {
    const decorated = decoratedCueHandler(this.constructor, name);
    if (decorated !== null) {
      await (this as unknown as Record<string, () => unknown>)[decorated]();
    }
  }

  /** 结构迁移钩子（§7.4）：从 fromVersion 逐级升到当前声明版本 */
  async migrateProps(stored: TProps, _fromVersion: number): Promise<TProps> {
    return stored;
  }
}

/** 框架内部：向实例注入上下文 */
export function attachContext(instance: Actor<any>, ctx: ActorContext): void {
  Object.defineProperty(instance, CTX, { value: ctx, enumerable: false, writable: false });
}

export type ActorClass<T extends Actor<any>> = abstract new (...args: any[]) => T;

/** 静态字段等价物（DESIGN §3.1）：与装饰器双轨，二选一 */
export interface ActorStaticOptions {
  role?: string;
  roleId?: string;
  intermission?: string | number;
  improv?: string[];
  readOnly?: string[];
  timeouts?: Record<string, string | number>;
  schemaVersion?: number;
  initialProps?: () => unknown;
}

export type ActorCtor<T extends Actor<any>> = ActorClass<T> & Partial<ActorStaticOptions>;
