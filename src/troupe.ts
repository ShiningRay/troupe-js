import { randomUUID } from "node:crypto";
import type { Actor, ActorCtor } from "./core/actor.js";
import { EventBus, Metrics, type TroupeEvent } from "./core/events.js";
import { TraceBus, type TraceFilter } from "./core/trace.js";
import { callAls, newSpan } from "./core/trace-context.js";
import { scanActorSource } from "./hot/reload.js";
import type { ReloadPolicy } from "./hot/reload.js";
import { compatViolations, evaluateBundle, verifyBundle, DeployHistory, type DeployBundle } from "./hot/deploy.js";
import { SwapViolationError } from "./core/errors.js";
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
import type { Audience } from "./show/show.js";
import { SqliteSubscriptionStore } from "./show/sqlite.js";
import type { SubscriptionStore } from "./show/subscription-store.js";

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
  /** BoxOffice（M8）：WebSocket 客户端网关（ticket 鉴权，浏览器直拿 Agent） */
  boxoffice?: boolean | { host?: string; port?: number; token?: string | null };
  /**
   * Show 持久订阅（M11+ 收尾）：订阅记录落盘（SQLite，`show:<topic>` coordinator
   * 重启/漂移后自动重载），投递升级为至少一次（失败退避重试，订阅方幂等）。
   */
  show?: { persist?: boolean | { dir?: string } };
  /** OTel 桥（M8）：每个 Turn 结束回调（W3C traceparent + 父 span），桥接真实 OTel SDK 用 */
  onSpan?: (span: {
    traceparent: string;
    parentTraceparent?: string;
    roleId: string;
    stageName: string;
    method: string;
    durationMs: number;
    ok: boolean;
  }) => void;
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

const sleepLocal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    private readonly localSubs: Map<string, Map<string, Audience>>,
    private readonly traceBus: TraceBus,
    private readonly deployHistory = new DeployHistory(),
  ) {}

  // ---- 生产热替换（M11，DESIGN §9.4，独立实验）----

  /**
   * 部署一个 bundle 到本 Stage：验签 → data: 求值 → 兼容静态检查（L3 规则）→
   * swap 热替换（不打断流量：排队请求在换码后继续）。
   */
  async deployLocal(bundle: DeployBundle): Promise<{ roleId: string; fromVersion: number; toVersion: number }> {
    const secret = process.env.TROUPE_DEPLOY_SECRET;
    if (secret && !verifyBundle(bundle, secret)) {
      throw new TroupeError(`部署被拒：签名校验失败（${bundle.roleId}）——bundle 疑被篡改（§9.4）`);
    }
    const existing = this.roleMap.get(bundle.roleId);
    if (!existing) {
      throw new TroupeError(`部署被拒：角色 "${bundle.roleId}" 未在本 Stage 注册（§9.4）`);
    }
    const ctor = await evaluateBundle(bundle);
    const probe = describeRole(ctor, { intermissionMs: existing.intermissionMs });
    if (probe.meta.roleId !== bundle.roleId) {
      throw new TroupeError(`部署被拒：bundle 类解析出角色 "${probe.meta.roleId}" ≠ 目标 "${bundle.roleId}"`);
    }
    const violations = compatViolations(existing, ctor, probe.meta);
    if (violations.length > 0) {
      throw new TroupeError(`部署被拒：不兼容变更（${violations.length} 条）\n- ${violations.join("\n- ")}`);
    }
    this.deployHistory.push(bundle.roleId, bundle);
    const applied = await this.reloadActorClass(ctor, { policy: "swap", source: bundle.source });
    return { roleId: bundle.roleId, fromVersion: applied.fromVersion, toVersion: applied.toVersion };
  }

  /** 一键回滚：重新部署上一已接受版本（§9.4 回滚规则） */
  async rollbackDeploy(roleId: string): Promise<{ roleId: string; toVersion: number } | { error: string }> {
    const prev = this.deployHistory.previous(roleId);
    if (!prev) return { error: `无可回滚版本：${roleId} 的部署历史不足` };
    return await this.deployLocal(prev);
  }

  /** 广播部署：本 Stage 执行 + 扇出全部成员，返回各 Stage 结果（§9.4 下发通道） */
  async deployCluster(bundle: DeployBundle): Promise<Array<{ stage: string } & Record<string, unknown>>> {
    if (!this.cluster) throw new TroupeError("deployCluster 需要集群模式（单 Stage 用 deployLocal）");
    return this.cluster.deployBroadcast(bundle);
  }

  // ---- Trace（M6，DESIGN §11.4）----

  /** 历史查询：最新 n 条（新的在前） */
  traces(n: number, filter?: TraceFilter) {
    return this.traceBus.latest(n, filter);
  }

  /** 实时订阅；返回退订函数 */
  subscribeTrace(filter: TraceFilter | undefined, fn: (e: unknown) => void): () => void {
    return this.traceBus.live(filter, fn);
  }

  // ---- Show（M6，DESIGN §2：演出，可演可看）----

  /** 发布事件到话题；订阅者（Audience）经完整调用管道异步收到（尽力而为，at-most-once） */
  async publish(topic: string, event: unknown): Promise<void> {
    if (this.cluster) return this.cluster.publish(topic, event);
    const subs = this.localSubs.get(topic);
    if (!subs || subs.size === 0) return;
    await Promise.allSettled(
      [...subs.values()].map(async (audience) => {
        const key = `${audience.roleId}/${audience.stageName}.${audience.method}`;
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await this.stageManager.call({
              callId: randomUUID(),
              roleId: audience.roleId,
              stageName: audience.stageName,
              method: audience.method,
              args: [event],
              deadline: this.now() + this.defaultTimeoutMs,
              hops: 0,
            });
            this.events.emit({
              type: "showDelivered",
              roleId: "<show>",
              method: topic,
              at: this.now(),
              detail: { audience: key, attempt },
            });
            return;
          } catch (e) {
            lastError = e;
            if (attempt < 3) await sleepLocal(200 * attempt);
          }
        }
        this.events.emit({
          type: "showDropped",
          roleId: "<show>",
          method: topic,
          at: this.now(),
          detail: { audience: key, error: lastError instanceof Error ? lastError.message : String(lastError) },
        });
      }),
    );
  }

  /** 订阅（Edge/测试用便捷门面；Actor 内推荐 this.subscribe） */
  async subscribe(topic: string, audience: Audience): Promise<void> {
    if (this.cluster) return this.cluster.subscribe(topic, audience);
    let subs = this.localSubs.get(topic);
    if (!subs) {
      subs = new Map();
      this.localSubs.set(topic, subs);
    }
    subs.set(`${audience.roleId}\u0000${audience.stageName}\u0000${audience.method}`, audience);
  }

  async unsubscribe(topic: string, audience: Audience): Promise<void> {
    if (this.cluster) return this.cluster.unsubscribe(topic, audience);
    this.localSubs.get(topic)?.delete(
      `${audience.roleId}\u0000${audience.stageName}\u0000${audience.method}`,
    );
  }

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
      traces: (n, filter) => this.traces(n, filter),
      boothAddr: this.boothAddress(),
      clusterAggregate: this.cluster ? () => this.cluster!.aggregateDirector() : undefined,
      deployLocal: (bundle) => this.deployLocal(bundle as never),
      rollbackDeploy: (roleId) => this.rollbackDeploy(roleId),
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
      cluster: () => directorCall("cluster", [], deps),
      deploy: (bundle: unknown) => directorCall("deploy", [bundle], deps),
      rollback: (roleId: string) => directorCall("rollback", [roleId], deps),
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
    const troupeRef: { current?: Troupe } = {};
    // Show 订阅 API（M6）：非集群 = 本地 broker 语义（归属恒为本 Stage）
    const localSubs = new Map<string, Map<string, Audience>>();
    const dedupKey = (a: Audience) => `${a.roleId}\u0000${a.stageName}\u0000${a.method}`;
    const showApi = {
      subscribe: async (identity: { roleId: string; stageName: string }, topic: string, method = "onEvent") => {
        const audience: Audience = { roleId: identity.roleId, stageName: identity.stageName, method };
        if (cluster) {
          await cluster.subscribe(topic, audience);
          return;
        }
        let subs = localSubs.get(topic);
        if (!subs) {
          subs = new Map();
          localSubs.set(topic, subs);
        }
        subs.set(dedupKey(audience), audience);
        await showStore?.upsert({ namespace: config.namespace, topic, ...audience });
      },
      unsubscribe: async (identity: { roleId: string; stageName: string }, topic: string, method = "onEvent") => {
        const audience: Audience = { roleId: identity.roleId, stageName: identity.stageName, method };
        if (cluster) {
          await cluster.unsubscribe(topic, audience);
          return;
        }
        localSubs.get(topic)?.delete(dedupKey(audience));
        await showStore?.delete(topic, audience.roleId, audience.stageName, audience.method);
      },
    };
    const traceBus = new TraceBus();
    const stageManager = new StageManager(
      propStore, roles, events, metrics, config, now, casterRef, ownershipRef, cueApi, showApi,
      (topic, event) => troupeRef.current!.publish(topic, event),
      traceBus,
      opts.onSpan,
    );
    void troupeRef; // 晚绑定：troupe 构造后回填

    // 本地执行包装：结果出边界（本地/远程/Rehearsal 行为一致，§6.1）
    const localRef = opts.localCallByReference ?? false;
    const execLocal = async (env: CallEnvelope): Promise<unknown> => {
      const result = await stageManager.call(env);
      return localRef ? result : codecCopy(result);
    };

    // Show 订阅持久化（M11+ 收尾）：coordinator 重启/漂移后重载
    const showStore = opts.show?.persist
      ? new SqliteSubscriptionStore(
          typeof opts.show.persist === "object" && opts.show.persist.dir
            ? opts.show.persist.dir
            : process.env.TROUPE_SHOWS_DIR ?? "./.troupe",
        )
      : undefined;

    let cluster: Cluster | null = null;
    if (opts.cluster) {
      cluster = new Cluster(
        {
          namespace: config.namespace,
          roles,
          events,
          localExec: execLocal,
          directorRef,
          showStore,
          // Show 投递（M6）：经完整调用管道（Playbill 路由 → 串行 Turn）。
          // Audience 可能在其它 Stage——必须走 route（本地执行/远程转发），
          // 回调运行晚于 form() 完成，cluster 变量此时已就绪。
          showDeliver: async (audience, _topic, event) => {
            await cluster!.route({
              callId: randomUUID(),
              roleId: audience.roleId,
              stageName: audience.stageName,
              method: audience.method,
              args: [event],
              deadline: now() + defaultTimeoutMs,
              hops: 0,
            });
          },
        },
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
      localSubs, traceBus,
    );
    troupeRef.current = troupe;
    // 非集群模式：启动重载持久化订阅（集群模式由 broker.reloadOwned 在 start/成员变更时处理）
    if (showStore) {
      try {
        for (const rec of await showStore.list(config.namespace)) {
          let subs = localSubs.get(rec.topic);
          if (!subs) {
            subs = new Map();
            localSubs.set(rec.topic, subs);
          }
          subs.set(`${rec.roleId}\u0000${rec.stageName}\u0000${rec.method}`, {
            roleId: rec.roleId,
            stageName: rec.stageName,
            method: rec.method,
          });
        }
      } catch (e) {
        console.warn(`[troupe] 持久订阅重载失败（忽略）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Actor 内 publishShow 通道（晚绑定到 troupe.publish）
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
        traces: (n, filter) => troupe.traces(n, filter),
        boothAddr: troupe.boothAddress(),
        clusterAggregate: cluster ? () => cluster.aggregateDirector() : undefined,
        deployLocal: (bundle) => troupe.deployLocal(bundle as never),
        rollbackDeploy: (roleId) => troupe.rollbackDeploy(roleId),
        propStore,
        namespace: config.namespace,
        pid: process.pid,
        startedAt: troupe.startedAt,
      });

    if (opts.boxoffice) {
      const bo = opts.boxoffice === true ? {} : opts.boxoffice;
      const { BoxOffice } = await import("./boxoffice/boxoffice.js");
      const boxoffice = new BoxOffice(troupe, bo.token);
      const addr = await boxoffice.start({ host: bo.host, port: bo.port });
      troupe.attachBoxOffice(boxoffice);
      console.log(
        `[troupe] BoxOffice 网关：${addr}（WS /ws；${boxoffice.ticket ? "ticket 已启用" : "无鉴权——仅限 loopback 开发"}）`,
      );
    }
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
  private boxoffice: { stop(): void; address: string | null; ticket: string | null } | null = null;

  /** @internal BoxOffice 启动后回填 */
  attachBoxOffice(bo: { stop(): void; address: string | null; ticket: string | null }): void {
    this.boxoffice = bo;
  }

  /** BoxOffice 网关地址（未启用为 null） */
  boxofficeAddress(): string | null {
    return this.boxoffice?.address ?? null;
  }

  /** BoxOffice ticket（未启用鉴权为 null） */
  boxofficeTicket(): string | null {
    return this.boxoffice?.ticket ?? null;
  }

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

  /**
   * 热重载一个 Actor 类（M10，DESIGN §9.3）：注册表换新版本（codeVersion+1），
   * 按策略处理在场实例。swap 强制守则静态检查（需要 source）。
   */
  async reloadActorClass(
    ctor: Function,
    opts: {
      policy?: ReloadPolicy | ((roleId: string) => ReloadPolicy);
      source?: string;
    } = {},
  ): Promise<{ roleId: string; policy: ReloadPolicy; fromVersion: number; toVersion: number; affected: number }> {
    const probe = describeRole(ctor, { intermissionMs: 5 * 60_000 });
    const roleId = probe.meta.roleId;
    const existing = this.roleMap.get(roleId);
    if (!existing) {
      throw new UnknownRoleError(
        `reload 失败：角色 "${roleId}" 未注册（首次注册请走 form({ actors }) 或 @Performs）`,
      );
    }
    const policy: ReloadPolicy =
      typeof opts.policy === "function" ? opts.policy(roleId) : (opts.policy ?? "recycle");
    if (policy === "swap") {
      if (!opts.source) {
        throw new SwapViolationError("swap 需要提供 source 做守则静态检查（DESIGN §9.5）", [
          "未提供源码文本",
        ]);
      }
      const violations = scanActorSource(opts.source);
      if (violations.length > 0) {
        throw new SwapViolationError(
          `swap 被拒绝：源码违反 ${violations.length} 条守则（DESIGN §9.5）`,
          violations,
        );
      }
    }
    const newMeta = {
      ...probe.meta,
      roleId,
      intermissionMs: existing.intermissionMs, // 换码不改生命周期配置
      codeVersion: existing.codeVersion + 1,
    };
    this.roleMap.set(roleId, newMeta);
    let applied: { swapped: number; recycled: number; kept: number };
    try {
      applied = await this.stageManager.applyVersion(roleId, newMeta, policy, existing.codeVersion);
    } catch (e) {
      // swap 失败（如 onCodeSwap 抛错）：roleMap 与原型一并回滚（§9.5#7）
      this.roleMap.set(roleId, existing);
      throw e;
    }
    return {
      roleId,
      policy,
      fromVersion: existing.codeVersion,
      toVersion: newMeta.codeVersion,
      affected: applied.swapped + applied.recycled,
    };
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
          // 调用链追踪（§11.4）：仅当存在父上下文（Turn 内 this.cast）才传播；
          // 顶层调用保持 undefined → StageManager 生成全新根 trace（无父 Link）
          ...(callAls.getStore() ? { traceparent: callAls.getStore()!.traceparent } : {}),
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
    this.boxoffice?.stop();
  }

  /** 硬杀模拟（kill -9）：无 leave、无排空——仅测试/混沌用 */
  destroy(): void {
    this.cueScheduler?.stop();
    this.cluster?.destroy();
    this.stageManager.close();
    this.booth?.stop();
    this.boxoffice?.stop();
  }

  /** 测试/运维：在场 Actor 快照（状态机观测） */
  slots(): ReturnType<StageManager["snapshotSlots"]> {
    return this.stageManager.snapshotSlots();
  }

  private roleIdOf(ctor: ActorCtor<Actor<any>>): string {
    for (const [roleId, meta] of this.roleMap) {
      if (meta.ctor === ctor) return roleId;
    }
    // 热重载后旧类引用（dev 场景 import 不变）：按解析出的 roleId 查注册表
    const { meta } = describeRole(ctor, { intermissionMs: 0 });
    if (this.roleMap.has(meta.roleId)) return meta.roleId;
    throw new UnknownRoleError(
      `cast 失败：${meta.roleId} 未注册（显式传入 form({ actors: [...] })，或 import 其模块使 @Performs 生效）`,
    );
  }
}

