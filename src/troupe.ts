import { randomUUID } from "node:crypto";
import type { Actor, ActorCtor } from "./core/actor.js";
import { EventBus, Metrics, type TroupeEvent } from "./core/events.js";
import {
  CallRejectedError,
  RoleConflictError,
  TroupeError,
  UnknownRoleError,
} from "./core/errors.js";
import { parseDuration } from "./core/duration.js";
import { describeRole, type RoleMeta } from "./core/meta.js";
import { snapshotProcessRegistry } from "./core/repertoire.js";
import { codecCopy } from "./core/codec.js";
import type { PropStore } from "./props/prop-store.js";
import { InMemoryPropStore } from "./props/memory.js";
import { SqlitePropStore } from "./props/sqlite.js";
import { StageManager, type CallEnvelope, type CastHandle, type OwnershipDeps, type StageConfig } from "./core/stage-manager.js";
import { isOwnershipStore } from "./props/ownership.js";
import { createAgent, type Agent } from "./core/agent.js";
import { Cluster, type ClusterOptions } from "./cluster/cluster.js";
import { Booth, type BoothOptions } from "./booth/server.js";
import type { CueStore, ReminderSpec } from "./cues/cue-store.js";
import { nextCronTime, parseCronExpression } from "./cues/cron.js";
import { InMemoryCueStore } from "./cues/memory.js";
import { SqliteCueStore } from "./cues/sqlite.js";
import { CueScheduler } from "./cues/scheduler.js";
import type { ActorCueApi } from "./cues/actor-cues.js";
import { directorCall, type DirectorDeps } from "./director/director.js";

export interface TroupeOptions {
  /** 显式注册（推荐，DESIGN §3.2/§8.3）；缺省取 @Performs 进程注册表快照 */
  actors?: ActorCtor<Actor<any>>[];
  propStore?: PropStore;
  /** 存储命名空间（DESIGN §3.2），默认 TROUPE_NAMESPACE 或 "default" */
  namespace?: string;
  /** Call 默认超时（DESIGN §5.4），默认 30s；可被 static timeouts 按方法覆盖 */
  defaultTimeout?: string | number;
  /** 默认 Intermission（DESIGN §3.1），默认 5m；可被 @Intermission/static intermission 覆盖 */
  defaultIntermission?: string | number;
  /** 每 Actor CallBoard 深度上限（DESIGN §5.3），默认 1024 */
  queueDepth?: number;
  /** 排空期间新请求策略（DESIGN §5.2），默认 "wait" */
  drainPolicy?: "wait" | "reject";
  /** 幂等记录保留期限（DESIGN §6.5），默认 7d */
  idempotencyRetention?: string | number;
  /** 每 Stage 在场 Actor 数上限（全局背压，§5.3），默认 10_000 */
  maxActivations?: number;
  /** 每 Stage 总排队字节预算（全局背压，§5.3），默认 64MB */
  maxQueuedBytes?: number;
  /** 本地调用是否绕过 Codec 复制边界（默认 false：本地/远程/Rehearsal 一致，§6.1） */
  localCallByReference?: boolean;
  /** 集群（M2）：启用 TCP + Roster + Playbill 路由 */
  cluster?: ClusterOptions;
  /**
   * 所有权（M3，DESIGN §6.5）：启用租约 + fencing token（要求存储实现 OwnershipStore）。
   * production 集群强制启用；默认租约 5s。
   */
  ownership?: { leaseMs?: number };
  /**
   * 持久提醒（M4，DESIGN §7.5）：启用 CueStore 与调度器（tick 默认 1s）。
   * Actor 内经 scheduleReminder/cancelReminder/onCue 使用。
   */
  cues?: boolean | { store?: CueStore; tickMs?: number };
  /** Booth 预览版：内省面板（loopback，默认 7500；完整版属 M9） */
  booth?: boolean | BoothOptions;
  /** 测试注入时钟（PLAN M1 测试注入接口） */
  now?: () => number;
  /** 埋点订阅（PLAN M1 观测埋点；完整界面后移） */
  onEvent?: (e: TroupeEvent) => void;
}

/** Node 最低版本启动检查（PLAN §5：>=22.13，node:sqlite 自 22.13 起无需 flag） */
export function checkNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new TroupeError(
      `Node ${process.versions.node} 不满足最低要求 >=22.13（见 PLAN.md §5 技术选型）`,
    );
  }
}

export class Troupe {
  private constructor(
    readonly events: EventBus,
    readonly metrics: Metrics,
    private readonly roleMap: Map<string, RoleMeta>,
    private readonly stageManager: StageManager,
    private readonly now: () => number,
    private readonly defaultTimeoutMs: number,
    private readonly cluster: Cluster | null,
    private readonly localRef: boolean,
    private readonly propStore: PropStore,
    private readonly namespaceValue: string,
    private readonly cueScheduler: CueScheduler | null,
    private readonly cuesEnabled: boolean,
  ) {}

  readonly startedAt = Date.now();

  /** 本地 Director 门面（§11.1；远程经 wire "dir" 通道 + TROUPE_ADMIN_TOKEN） */
  director() {
    const deps: DirectorDeps = {
      selfAddr: this.cluster?.address() ?? null,
      members: this.cluster?.members() ?? [],
      slots: () => this.slots() as unknown as Array<Record<string, unknown>>,
      repertoire: this.repertoire(),
      methodsOf: (roleId) => this.methodsOf(roleId),
      invoke: (roleId, stageName, method, args) => {
        const agent = this.cast(roleId, stageName) as unknown as Record<
          string,
          (...a: unknown[]) => Promise<unknown>
        >;
        return agent[method](...args);
      },
      off: (roleId, stageName) => this.off(roleId, stageName),
      cueList: () => (this.cueScheduler ? this.cueScheduler.list() : Promise.resolve([])),
      propStore: this.propStore,
      namespace: this.namespaceValue,
      pid: process.pid,
      startedAt: this.startedAt,
    };
    return {
      roster: () => directorCall("roster", [], deps),
      actors: (filter?: { role?: string }) => directorCall("actors", [filter], deps),
      inspect: (roleId: string, stageName: string) => directorCall("inspect", [roleId, stageName], deps),
      invoke: (roleId: string, stageName: string, method: string, args: unknown[]) =>
        directorCall("invoke", [roleId, stageName, method, args], deps),
      off: (roleId: string, stageName: string) => directorCall("off", [roleId, stageName], deps),
      cues: () => directorCall("cues", [], deps),
      ring: () => directorCall("ring", [], deps),
    };
  }

  static async form(opts: TroupeOptions = {}): Promise<Troupe> {
    checkNodeVersion();
    const now = opts.now ?? (() => Date.now());
    const events = new EventBus();
    if (opts.onEvent) events.on(opts.onEvent);
    const metrics = new Metrics(now);

    const registry = snapshotProcessRegistry();
    const registrySource = new Map<Function, string>();
    for (const { ctor, source } of registry.values()) registrySource.set(ctor, source);

    const defaultIntermissionMs = parseDuration(opts.defaultIntermission ?? 5 * 60_000);
    const actorList: Function[] = opts.actors ?? [...registry.values()].map((r) => r.ctor);

    const roles = new Map<string, RoleMeta>();
    for (const ctor of actorList) {
      const source = registrySource.get(ctor) ?? "<form({ actors })>";
      const { meta, warnings } = describeRole(ctor, { intermissionMs: defaultIntermissionMs }, source);
      const existing = roles.get(meta.roleId);
      if (existing && existing.ctor !== meta.ctor) {
        throw new RoleConflictError(
          `角色名冲突："${meta.roleId}" 同时由 ${existing.source} 与 ${source} 注册（DESIGN §8.5）`,
        );
      }
      roles.set(meta.roleId, meta);
      for (const w of warnings) {
        events.emit({ type: "warn", roleId: meta.roleId, at: now(), detail: { message: w } });
        console.warn(`[troupe] ${w}`);
      }
    }

    // 默认存储（§8.2）：test → InMemory（Rehearsal 语义）；否则 SqlitePropStore（进程级）
    const propStore: PropStore =
      opts.propStore ??
      (process.env.NODE_ENV === "test"
        ? new InMemoryPropStore()
        : new SqlitePropStore(process.env.TROUPE_PROPS_DIR ?? "./.troupe"));

    const config: StageConfig = {
      namespace: opts.namespace ?? process.env.TROUPE_NAMESPACE ?? "default",
      queueDepth: opts.queueDepth ?? 1024,
      drainPolicy: opts.drainPolicy ?? "wait",
      idempotencyRetentionMs: parseDuration(opts.idempotencyRetention ?? 7 * 24 * 60 * 60_000),
      maxActivations: opts.maxActivations ?? 10_000,
      maxQueuedBytes: opts.maxQueuedBytes ?? 64 * 1024 * 1024,
    };
    const defaultTimeoutMs = parseDuration(opts.defaultTimeout ?? 30_000);

    // 持久提醒（§7.5）：schedule/cancel 只依赖存储，可先于 StageManager 构造
    let cueStore: CueStore | null = null;
    if (!opts.cues) {
      const offender = [...roles.values()].find((m) => m.persistentCues.size > 0);
      if (offender) {
        throw new TroupeError(
          `角色 "${offender.roleId}" 使用 @Cron/@Every 声明式提醒，需要 Troupe.form({ cues: true }) 启用（§7.5）`,
        );
      }
    }
    if (opts.cues) {
      const c = opts.cues === true ? {} : opts.cues;
      cueStore =
        c.store ??
        (process.env.NODE_ENV === "test"
          ? new InMemoryCueStore()
          : new SqliteCueStore(process.env.TROUPE_CUES_DIR ?? "./.troupe"));
    }
    const buildRecord = (
      identity: { roleId: string; stageName: string },
      name: string,
      spec: ReminderSpec,
    ) => {
      const everyMs = spec.every !== undefined ? parseDuration(spec.every) : null;
      const at = spec.at !== undefined ? new Date(spec.at).getTime() : null;
      const cron = spec.cron ?? null;
      if (everyMs === null && at === null && cron === null) {
        throw new TroupeError(`提醒 "${name}" 需要 every（周期）、at（一次性时间）或 cron 之一（§7.5）`);
      }
      if (everyMs !== null && !(everyMs > 0)) {
        throw new TroupeError(`提醒 "${name}" 的 every 必须为正时长`);
      }
      let nextDue: number;
      if (cron !== null) {
        const t = nextCronTime(parseCronExpression(cron), now());
        if (t === null) throw new TroupeError(`提醒 "${name}" 的 cron 一年内无触发时间：${cron}`);
        nextDue = t;
      } else if (everyMs !== null) {
        nextDue = now() + everyMs;
      } else {
        nextDue = at!;
      }
      return {
        namespace: config.namespace,
        roleId: identity.roleId,
        stageName: identity.stageName,
        name,
        payload: spec.payload ?? null,
        everyMs,
        at,
        cron,
        nextDue,
      };
    };
    const cueApi: ActorCueApi | undefined = cueStore
      ? {
          schedule: async (identity, name, spec) => {
            await cueStore!.upsert(buildRecord(identity, name, spec));
          },
          ensure: async (identity, name, spec) => {
            await cueStore!.ensure(buildRecord(identity, name, spec));
          },
          cancel: (identity, name) =>
            cueStore!.delete({ namespace: config.namespace, roleId: identity.roleId, stageName: identity.stageName, name }),
        }
      : undefined;

    const casterRef: { current?: CastHandle } = {};
    const ownershipRef: { current?: OwnershipDeps } = {};
    const directorRef: { current?: (method: string, args: unknown[]) => Promise<unknown> } = {};
    const stageManager = new StageManager(
      propStore, roles, events, metrics, config, now, casterRef, ownershipRef, cueApi,
    );

    // 本地执行包装：结果出边界（本地/远程/Rehearsal 行为一致，§6.1）
    const localRef = opts.localCallByReference ?? false;
    const execLocal = async (env: CallEnvelope): Promise<unknown> => {
      const result = await stageManager.call(env);
      return localRef ? result : codecCopy(result);
    };

    let cluster: Cluster | null = null;
    if (opts.cluster) {
      cluster = new Cluster(
        { namespace: config.namespace, roles, events, localExec: execLocal, directorRef },
        opts.cluster,
      );
      await cluster.start();
    }

    // 所有权（§6.5）：显式开启或 production 模式强制；要求共享存储支持
    const productionMode =
      opts.cluster?.mode === "production" || process.env.TROUPE_MODE === "production";
    if (opts.ownership || productionMode) {
      if (!isOwnershipStore(propStore)) {
        throw new TroupeError(
          "所有权要求 PropStore 实现 OwnershipStore（SqlitePropStore 同机多进程 / PostgresPropStore 节点级，DESIGN §6.5/§7.2）",
        );
      }
      ownershipRef.current = {
        ownerId: cluster ? cluster.stageId() : `local:${process.pid}`,
        leaseMs: opts.ownership?.leaseMs ?? 5_000,
        store: propStore,
        isRingOwner: (r, s) => (cluster ? cluster.ownerOf(r, s) === cluster.selfAddr : true),
      };
    } else if (cluster && isOwnershipStore(propStore)) {
      const message =
        "共享存储支持所有权但未启用：当前为允许重复激活的实验性集群（§6.5）；form({ ownership: {} }) 或 production 模式启用";
      events.emit({ type: "warn", roleId: "<troupe>", at: now(), detail: { message } });
      console.warn(`[troupe] ${message}`);
    }

    // 提醒调度器（§7.5）：仅触发本 Stage 环归属的键；至少一次 + 幂等
    let cueScheduler: CueScheduler | null = null;
    if (cueStore) {
      const cueOpts = typeof opts.cues === "object" ? opts.cues : undefined;
      cueScheduler = new CueScheduler(
        cueStore,
        config.namespace,
        cluster ? cluster.stageId() : `local:${process.pid}`,
        (r, s) => (cluster ? cluster.ownerOf(r, s) === cluster.selfAddr : true),
        stageManager,
        events,
        now,
        cueOpts?.tickMs !== undefined ? { tickMs: cueOpts.tickMs } : {},
      );
      cueScheduler.start();
    }

    const troupe = new Troupe(
      events, metrics, roles, stageManager, now, defaultTimeoutMs, cluster, localRef,
      propStore, config.namespace, cueScheduler, cueStore !== null,
    );
    // Actor 互调句柄：form() 完成后绑定（避免构造期循环依赖）
    casterRef.current = (first, stageName) => troupe.cast(first as ActorCtor<Actor<any>>, stageName);
    // Director 通道（§11.1）：CLI / Booth / 远程管理经 cluster 边缘进入
    directorRef.current = (method, args) =>
      directorCall(method, args, {
        selfAddr: cluster?.address() ?? null,
        members: cluster?.members() ?? [],
        slots: () => troupe.slots() as unknown as Array<Record<string, unknown>>,
        repertoire: troupe.repertoire(),
        methodsOf: (roleId) => troupe.methodsOf(roleId),
        invoke: (roleId, stageName, method, invokeArgs) => {
          const agent = troupe.cast(roleId, stageName) as unknown as Record<
            string,
            (...a: unknown[]) => Promise<unknown>
          >;
          return agent[method](...invokeArgs);
        },
        off: (roleId, stageName) => troupe.off(roleId, stageName),
        cueList: () => (cueScheduler ? cueScheduler.list() : Promise.resolve([])),
        propStore,
        namespace: config.namespace,
        pid: process.pid,
        startedAt: troupe.startedAt,
      });

    if (opts.booth) {
      const boothOpts = opts.booth === true ? {} : opts.booth;
      const booth = new Booth(troupe);
      const addr = await booth.start(boothOpts);
      troupe.attachBooth(booth);
      console.log(`[troupe] Booth 内省面板：${addr}（仅 loopback，§11.1；远程 + token 属 M4）`);
    }
    return troupe;
  }

  private booth: Booth | null = null;

  /** @internal Booth 启动后回填（form 内部使用） */
  attachBooth(booth: Booth): void {
    this.booth = booth;
  }

  /** Booth 面板地址（未启用为 null） */
  boothAddress(): string | null {
    return this.booth?.address ?? null;
  }

  /** 角色的 RPC 方法白名单（Booth/CLI 调用面板用，§6.1） */
  methodsOf(roleId: string): string[] {
    const meta = this.roleMap.get(roleId);
    if (!meta) {
      throw new UnknownRoleError(
        `角色 "${roleId}" 不在本 Troupe 的 Repertoire（当前：${this.repertoire().join(", ") || "空"}）`,
      );
    }
    return [...meta.rpcMethods];
  }

  /** 组团后的角色清单（报错与调试用） */
  repertoire(): string[] {
    return [...this.roleMap.keys()];
  }

  /** 集群地址（未启用集群为 null） */
  clusterAddress(): string | null {
    return this.cluster?.address() ?? null;
  }

  /** 存活成员地址列表（未启用集群为 null） */
  clusterMembers(): string[] | null {
    return this.cluster ? this.cluster.members() : null;
  }

  /** 键的当前归属 Stage（调试/测试；未启用集群为 null） */
  ownerOf(roleId: string, stageName: string): string | null {
    return this.cluster?.ownerOf(roleId, stageName) ?? null;
  }

  cast<T extends Actor<any>>(ctor: ActorCtor<T>, stageName: string): Agent<T>;
  cast<T extends Actor<any>>(roleId: string, stageName: string): Agent<T>;
  cast<T extends Actor<any>>(first: ActorCtor<T> | string, stageName: string): Agent<T> {
    const roleId = typeof first === "string" ? first : this.roleIdOf(first);
    const meta = this.roleMap.get(roleId);
    if (!meta) {
      throw new UnknownRoleError(
        `cast 失败：角色 "${roleId}" 不在本 Troupe 的 Repertoire（当前：${
          this.repertoire().join(", ") || "空"
        }）（DESIGN §8.5）`,
      );
    }
    const stageManager = this.stageManager;
    const cluster = this.cluster;
    const defaultTimeoutMs = this.defaultTimeoutMs;
    const now = this.now;
    const dispatch = (method: string, rawArgs: unknown[]): Promise<unknown> => {
      // Agent 方法统一返回 Promise：任何同步错误（如编解码失败）也走 rejection
      try {
        if (!meta.rpcMethods.has(method)) {
          throw new CallRejectedError(
            `方法 "${method}" 不在 ${roleId} 的 RPC 白名单（DESIGN §6.1）`,
            "whitelist",
            false,
          );
        }
        const timeoutMs = meta.timeouts.get(method) ?? defaultTimeoutMs;
        const env: CallEnvelope = {
          callId: randomUUID(),
          roleId,
          stageName,
          method,
          args: this.localRef ? rawArgs : codecCopy(rawArgs),
          deadline: now() + timeoutMs,
          hops: 0,
        };
        return cluster
          ? cluster.route(env)
          : stageManager.call(env).then((r) => (this.localRef ? r : codecCopy(r)));
      } catch (e) {
        return Promise.reject(e);
      }
    };
    return createAgent<T>(roleId, stageName, meta.rpcMethods, dispatch);
  }

  /** 管理下场：排空 → offStage → 移除（M4 Director.off 复用此通道） */
  off(roleId: string, stageName: string): Promise<void> {
    return this.stageManager.off(roleId, stageName);
  }

  /** 排空全部在场 Actor（测试钩子；不停机） */
  async drainAll(): Promise<void> {
    await this.stageManager.drainAll();
  }

  /**
   * 优雅停机（M2 全链路）：
   * 广播 leave → 拒收新 Call（本地+入站）→ 存量 settle 或超时 → 全员 offStage+saveProps → 关连接。
   * Booth 最后关闭：停机过程（排空/下场）在面板上全程可见。
   */
  async shutdown(): Promise<void> {
    this.cueScheduler?.stop(); // 先停提醒：排空期间不再触发新激活
    if (this.cluster) await this.cluster.stop();
    this.stageManager.close();
    await this.stageManager.drainAll();
    this.cluster?.closeClients();
    this.booth?.stop();
  }

  /** 硬杀模拟（kill -9）：无 leave、无排空——仅测试/混沌用 */
  destroy(): void {
    this.cueScheduler?.stop();
    this.cluster?.destroy();
    this.stageManager.close();
    this.booth?.stop();
  }

  /** 测试/运维：在场 Actor 快照（状态机观测） */
  slots(): ReturnType<StageManager["snapshotSlots"]> {
    return this.stageManager.snapshotSlots();
  }

  private roleIdOf(ctor: ActorCtor<Actor<any>>): string {
    for (const [roleId, meta] of this.roleMap) {
      if (meta.ctor === ctor) return roleId;
    }
    // 未注册的类引用：解析出目标 roleId 以给出准确报错
    const { meta } = describeRole(ctor, { intermissionMs: 0 });
    throw new UnknownRoleError(
      `cast 失败：${meta.roleId} 未注册（显式传入 form({ actors: [...] })，或 import 其模块使 @Performs 生效）`,
    );
  }
}

