import { randomUUID } from "node:crypto";
import type { CallEnvelope } from "../core/stage-manager.js";
import type { RoleMeta } from "../core/meta.js";
import type { EventBus, TroupeEvent } from "../core/events.js";
import {
  CallRejectedError,
  CallTimeoutError,
  ConflictError,
  TroupeError,
  UnknownOutcomeError,
} from "../core/errors.js";
import {
  Transport,
  WIRE_PROTOCOL_VERSION,
  type ReplyFn,
  type TransportHandler,
  type WireCall,
  type WireErr,
  type WireMessage,
} from "./transport.js";
import { Roster } from "./roster.js";
import { Playbill } from "./playbill.js";
import { DirectoryRouter } from "./directory-router.js";
import type { DirectoryStore } from "../props/directory.js";
import { ShowBroker } from "../show/show.js";
import type { Audience } from "../show/show.js";
import type { SubscriptionStore } from "../show/subscription-store.js";

export interface ClusterOptions {
  /** 绑定地址，dev 默认 127.0.0.1（§8.2；开放监听属生产模式，M3） */
  host?: string;
  /** 端口，dev 默认 7300 被占自动 +1；production 必须显式指定且固定 */
  port?: number;
  /** 对外通告地址 host:port；缺省 = host:实际端口；production 必须显式指定 */
  advertise?: string;
  /** 种子节点列表 */
  seeds?: string[];
  /** 集群协议版本（join 校验，§6.2） */
  protocolVersion?: number;
  /**
   * production（M3，§6.2/§8.2）：固定端口（被占即败）、必须 advertiseAddress、
   * 必须成功入团（所有 seed 不可达 → 启动失败）、角色集合不一致拒绝入团。
   * production 另强制 TLS（tls）与 Director 管理凭证（adminToken 或 TROUPE_ADMIN_TOKEN）——P1-6。
   * 也可经 TROUPE_MODE=production 开启。
   */
  mode?: "dev" | "production";
  /** TLS（P1-6，ROADMAP）：cert/key 为 PEM 内容，ca 供自签名链；production 必配 */
  tls?: { cert: string; key: string; ca?: string };
  /** 入团预共享 token（P1-6）：join 必须携带；缺省读 TROUPE_JOIN_TOKEN */
  joinToken?: string;
  /** Director 管理凭证（P1-6）：production 必配（或 TROUPE_ADMIN_TOKEN）；dir 消息未授权拒绝 */
  adminToken?: string;
}

/**
 * Cluster 门面（M2）：TCP + Roster + Playbill 的接线层。
 * - 出站：route() 按环视图决定本地执行或转发（跳数上限 2，§6.3）
 * - 入站：信封校验 + 白名单 + 归属判定 + 漂移转发 + 错误分类应答（§6.1）
 */
export class Cluster {
  private readonly transport: Transport;
  private roster: Roster | null = null;
  private readonly playbill: Playbill;
  private readonly broker: ShowBroker;
  /** 目录路由器（ADR 0004）：deps.directory 提供且 start() 后就绪；null = 环路由（dev/未启用） */
  private router: DirectoryRouter | null = null;
  /** 本节点已远程发出的 Call（P2-5：cancel 路由依据；应答后清除） */
  private readonly callRoutes = new Map<string, string>();
  private stopped = false;
  selfAddr = "";
  private stageIdValue = "";

  constructor(
    private readonly deps: {
      namespace: string;
      roles: ReadonlyMap<string, RoleMeta>;
      events: EventBus;
      localExec: (env: CallEnvelope) => Promise<unknown>;
      /** Director 通道（DESIGN §11.1）：由 Troupe.form 晚绑定注入 */
      directorRef?: { current?: (method: string, args: unknown[]) => Promise<unknown> };
      /** Show 通道（M6）：deliver 由 Troupe.form 晚绑定注入（经完整调用管道） */
      showDeliver?: (audience: Audience, topic: string, event: unknown) => Promise<void>;
      /** Show 订阅持久化（M11+ 收尾）：coordinator 重启后重载订阅 */
      showStore?: SubscriptionStore;
      /** 目录化所有权（ADR 0004，P1-3）：提供即启用目录路由（环降级为候选/减载） */
      directory?: DirectoryStore;
      /** 目录路由租约时长（ms；缺省 5000） */
      leaseMs?: number;
      /** 协作取消（P2-5）：本节点中止 callId 的信号（StageManager.abortCall） */
      abortCall?: (callId: string) => boolean;
    },
    private readonly opts: ClusterOptions = {},
  ) {
    this.playbill = new Playbill(deps.namespace, []);
    this.broker = new ShowBroker({
      namespace: deps.namespace,
      subscriptionStore: deps.showStore,
      isShowOwner: (t) => this.showOwnerOf(t) === this.selfAddr,
      forward: (topic, kind, audience, event) => {
        const owner = this.showOwnerOf(topic);
        if (!owner || owner === this.selfAddr) return;
        void this.transport
          .send(owner, { t: kind, from: this.selfAddr, topic, audience, event })
          .catch(() => {});
      },
      deliver: async (audience, topic, event) => {
        if (!deps.showDeliver) throw new TroupeError("Show 投递通道未就绪");
        await deps.showDeliver(audience, topic, event);
      },
      onEvent: (kind, topic, detail) => {
        deps.events.emit({
          type: kind === "published" ? "showPublished" : kind === "delivered" ? "showDelivered" : "showDropped",
          roleId: "<show>",
          method: topic,
          at: Date.now(),
          detail,
        });
      },
    });
    const handler: TransportHandler = (msg, reply) => this.onWire(msg, reply);
    this.transport = new Transport(handler, { ...(this.opts.tls ? { tls: this.opts.tls } : {}) });
  }

  async start(): Promise<void> {
    const production = this.opts.mode === "production" || process.env.TROUPE_MODE === "production";
    const host = this.opts.host ?? "127.0.0.1";
    if (production) {
      if (this.opts.port === undefined) {
        throw new TroupeError("production 模式必须显式指定 cluster.port（固定端口是部署前提，§6.2）");
      }
      if (!this.opts.advertise) {
        throw new TroupeError("production 模式必须显式指定 cluster.advertise（advertiseAddress，§6.2）");
      }
      // P1-6 安全门禁（ROADMAP）：production 强制 TLS 与 Director 管理凭证
      if (!this.opts.tls) {
        throw new TroupeError(
          "production 模式必须启用 TLS（cluster.tls：{ cert, key, ca? }，P1-6）——明文线协议不满足生产安全",
        );
      }
      if (!(this.opts.adminToken ?? process.env.TROUPE_ADMIN_TOKEN)) {
        throw new TroupeError(
          "production 模式必须配置 Director 管理凭证（cluster.adminToken 或 TROUPE_ADMIN_TOKEN，P1-6）",
        );
      }
    }
    const preferred = this.opts.port ?? Number(process.env.TROUPE_PORT ?? 7300);
    const port = await this.transport.listen(host, preferred, { strict: production });
    if (!production && preferred !== 0 && port !== preferred) {
      console.log(`[troupe] 端口 ${preferred} 被占，改用 ${port}（§8.2 dev 便利；生产请固定端口）`);
    }
    this.selfAddr = this.opts.advertise ?? `${host}:${port}`;
    // Stage 身份 = addr#incarnation：重启即新身份（旧身份的租约/成员记录自然作废，§6.2/§6.5）
    this.stageIdValue = `${this.selfAddr}#${Date.now()}`;
    // 目录路由器（ADR 0004 §3）：ownership 表即目录；环降级为候选生成器
    if (this.deps.directory) {
      this.router = new DirectoryRouter({
        store: this.deps.directory,
        namespace: this.deps.namespace,
        selfAddr: this.selfAddr,
        selfId: this.stageIdValue,
        leaseMs: this.deps.leaseMs ?? 5_000,
        candidates: (r, s2) => this.playbill.candidates(r, s2),
        now: () => Date.now(),
      });
    }
    this.roster = new Roster(
      this.selfAddr,
      (addr, m) => this.transport.send(addr, m),
      [...this.deps.roles.keys()],
      {
        protocolVersion: this.opts.protocolVersion ?? WIRE_PROTOCOL_VERSION,
        joinToken: this.opts.joinToken ?? process.env.TROUPE_JOIN_TOKEN ?? undefined,
      },
    );
    this.roster.strictJoinFlag = production;
    this.roster.onMembersChanged = (alive) => {
      this.playbill.setMembers(alive);
      // 目录路由：成员视图变更不猜测新归属——全部缓存条目失效，下一条消息回源（ADR 0004 §3）
      this.router?.invalidateAll();
      // 成员视图变更 → 按新归属重放持久化订阅（M11+：coordinator 漂移接管）
      void this.broker.reloadOwned().catch(() => {});
      this.deps.events.emit({
        type: "membershipChanged",
        roleId: "<cluster>",
        at: Date.now(),
        detail: { alive, self: this.selfAddr },
      });
    };
    this.playbill.setMembers([this.selfAddr]);
    await this.roster.start(this.opts.seeds ?? seedsFromEnv(), production);
    await this.broker.reloadOwned().catch(() => {}); // 重启后重载持久化订阅
    this.deps.events.emit({
      type: "clusterStarted",
      roleId: "<cluster>",
      at: Date.now(),
      detail: { addr: this.selfAddr, stageId: this.stageIdValue, seeds: this.opts.seeds ?? [], production },
    });
  }

  /** Stage 身份（addr#incarnation）——所有权 ownerId 使用 */
  stageId(): string {
    return this.stageIdValue;
  }

  address(): string | null {
    return this.selfAddr || null;
  }

  members(): string[] {
    return this.roster?.aliveMembers() ?? [];
  }

  ownerOf(roleId: string, stageName: string): string | null {
    return this.playbill.ownerOf(roleId, stageName);
  }

  /**
   * 协作取消（P2-5，ROADMAP）：callId 在本 Stage → 本地中止；是本节点已远程发出的 Call
   * → 向执行节点发 cancel 消息。两者皆非（未知/已 settle）返回 false。
   */
  cancelCall(callId: string): boolean {
    if (this.deps.abortCall?.(callId)) return true;
    const addr = this.callRoutes.get(callId);
    if (!addr) return false;
    void this.transport.send(addr, { t: "cancel", from: this.selfAddr, callId }).catch(() => {});
    return true;
  }

  /** 目录路由统计（ADR 0004 §6 观测；未启用目录路由返回 null） */
  routerStats(): { hits: number; misses: number; claims: number; claimWins: number; cacheSize: number } | null {
    return this.router?.stats() ?? null;
  }

  // ---- Show（M6）----

  private showOwnerOf(topic: string): string | null {
    return this.playbill.ownerOfKey(`show:${topic}`);
  }

  async subscribe(topic: string, audience: Audience): Promise<void> {
    const owner = this.showOwnerOf(topic);
    if (!owner || owner === this.selfAddr) await this.broker.subscribe(topic, audience);
    else
      await this.transport
        .send(owner, { t: "sub", from: this.selfAddr, topic, audience })
        .catch(() => {});
  }

  async unsubscribe(topic: string, audience: Audience): Promise<void> {
    const owner = this.showOwnerOf(topic);
    if (!owner || owner === this.selfAddr) await this.broker.unsubscribe(topic, audience);
    else
      await this.transport
        .send(owner, { t: "unsub", from: this.selfAddr, topic, audience })
        .catch(() => {});
  }

  /** 发布：本 Stage 是 coordinator 直接 fan-out，否则转发给归属 Stage */
  async publish(topic: string, event: unknown): Promise<void> {
    const owner = this.showOwnerOf(topic);
    if (owner && owner !== this.selfAddr) {
      const callId = randomUUID();
      await this.transport.request(
        owner,
        { t: "pub", callId, from: this.selfAddr, topic, event },
        callId,
        10_000,
      );
      return;
    }
    await this.broker.publish(topic, event);
  }

  showSubscriberCount(topic: string): number {
    return this.broker.subscriberCount(topic);
  }

  /** 部署广播（M11，§9.4）：向所有成员（含自身）扇出 dir deploy 并汇总结果 */
  async deployBroadcast(
    bundle: { roleId: string; source: string; className?: string; policy: "swap"; sig: string },
  ): Promise<Array<{ stage: string } & Record<string, unknown>>> {
    const members = [this.selfAddr, ...this.roster?.aliveMembers() ?? []];
    const token = this.opts.adminToken ?? process.env.TROUPE_ADMIN_TOKEN;
    const results = await Promise.allSettled(
      members.map(async (addr) => {
        const callId = randomUUID();
        const res = await this.transport.request(
          addr,
          {
            t: "dir",
            callId,
            from: this.selfAddr,
            method: "deploy",
            args: [bundle],
            ...(token ? { token } : {}),
          },
          callId,
          30_000,
        );
        if (!res.ok) throw new Error(res.err?.message ?? "deploy 失败");
        return res.result as Record<string, unknown>;
      }),
    );
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? { stage: members[i], ...(r.value as Record<string, unknown>) }
        : { stage: members[i], error: String(r.reason).replace(/^Error: /, "") },
    );
  }

  /** Director 集群聚合（M9，§11.1）：向所有成员（含自身）扇出 dir 请求并汇总 */
  async aggregateDirector(): Promise<unknown> {
    const members = [this.selfAddr, ...this.roster?.aliveMembers() ?? []];
    const token = process.env.TROUPE_ADMIN_TOKEN;
    const stages = await Promise.allSettled(
      members.map(async (addr) => {
        const callId = randomUUID();
        const res = await this.transport.request(
          addr,
          { t: "dir", callId, from: this.selfAddr, method: "roster", args: [], ...(token ? { token } : {}) },
          callId,
          5_000,
        );
        if (!res.ok) throw new Error(res.err?.message ?? "roster 失败");
        return { addr, roster: res.result as Record<string, unknown> };
      }),
    );
    const actors = await Promise.allSettled(
      members.map(async (addr) => {
        const callId = randomUUID();
        const res = await this.transport.request(
          addr,
          { t: "dir", callId, from: this.selfAddr, method: "actors", args: [], ...(token ? { token } : {}) },
          callId,
          5_000,
        );
        if (!res.ok) throw new Error(res.err?.message ?? "actors 失败");
        return { addr, actors: res.result as Array<Record<string, unknown>> };
      }),
    );
    const cues = await Promise.allSettled(
      members.map(async (addr) => {
        const callId = randomUUID();
        const res = await this.transport.request(
          addr,
          { t: "dir", callId, from: this.selfAddr, method: "cues", args: [], ...(token ? { token } : {}) },
          callId,
          5_000,
        );
        if (!res.ok) throw new Error(res.err?.message ?? "cues 失败");
        return { addr, cues: res.result as Array<Record<string, unknown>> };
      }),
    );
    const okValue = (r: PromiseSettledResult<{ addr: string; [k: string]: unknown }>) =>
      r.status === "fulfilled" ? (r.value as Record<string, unknown>) : null;
    return {
      self: this.selfAddr,
      members,
      stages: stages.map((r, i) => {
        const v = okValue(r);
        const roster = (v?.roster ?? null) as Record<string, unknown> | null;
        return roster
          ? { stage: members[i], booth: roster.booth ?? null, pid: roster.pid, roles: roster.roles }
          : { stage: members[i], unreachable: true };
      }),
      actors: actors.flatMap((r, i) => {
        const v = okValue(r);
        return ((v?.actors ?? []) as Array<Record<string, unknown>>).map((x) => ({
          ...x,
          stage: members[i],
        }));
      }),
      cues: cues.flatMap((r, i) => {
        const v = okValue(r);
        return ((v?.cues ?? []) as Array<Record<string, unknown>>).map((x) => ({ ...x, stage: members[i] }));
      }),
    };
  }

  /** 出站路由：目录模式读目录（缓存→回源→claim→重读，ADR 0004）；否则按环视图 */
  async route(env: CallEnvelope): Promise<unknown> {
    if (this.stopped) {
      throw new CallRejectedError("Stage 已停机，拒收新 Call（优雅停机中）", "shutdown", false);
    }
    if (this.router) {
      const target = await this.router.resolveOwner(env.roleId, env.stageName);
      if (target === null) {
        throw new CallRejectedError(
          `目录路由未定归属：${env.roleId}/${env.stageName}（冷键首候选未就绪或目录不可达）——可安全重试`,
          "ownership",
          true,
        );
      }
      if (target.self) return this.deps.localExec(env);
      return this.remoteCall(target.addr, env);
    }
    const owner = this.ownerOf(env.roleId, env.stageName);
    if (!owner || owner === this.selfAddr) return this.deps.localExec(env);
    return this.remoteCall(owner, env);
  }

  private async remoteCall(addr: string, env: CallEnvelope): Promise<unknown> {
    const wire: WireCall = {
      t: "call",
      callId: env.callId,
      from: this.selfAddr,
      to: { roleId: env.roleId, stageName: env.stageName },
      method: env.method,
      args: env.args,
      deadline: env.deadline,
      hops: env.hops ?? 0,
    };
    this.callRoutes.set(env.callId, addr); // P2-5：cancel 路由依据
    try {
      const timeoutMs = Math.max(1, env.deadline - Date.now());
      const res = await this.transport.request(addr, wire, env.callId, timeoutMs);
      if (res.ok) return res.result;
      throw decodeWireErr(res.err!);
    } finally {
      this.callRoutes.delete(env.callId);
    }
  }

  private onWire(msg: WireMessage, reply: ReplyFn): void {
    if (msg.t === "call") {
      void this.handleCall(msg, reply);
      return;
    }
    if (msg.t === "dir") {
      void this.handleDirector(msg, reply);
      return;
    }
    if (msg.t === "cancel") {
      // 协作取消（P2-5）：转交本 Stage 的信号源；无应答（调用方自行等待 Turn settle）
      this.deps.abortCall?.(msg.callId);
      return;
    }
    if (msg.t === "sub" || msg.t === "unsub" || msg.t === "pub") {
      void this.handleShow(msg, reply);
      return;
    }
    this.roster?.handle(msg, reply);
  }

  private async handleShow(
    msg: Extract<WireMessage, { t: "sub" } | { t: "unsub" } | { t: "pub" }>,
    reply: ReplyFn,
  ): Promise<void> {
    const callId = msg.callId ?? "show";
    try {
      if (typeof msg.topic !== "string") throw new CallRejectedError("show 信封需要 topic", "whitelist", false);
      const owner = this.showOwnerOf(msg.topic);
      if (owner && owner !== this.selfAddr) {
        // 话题视图漂移：再转发一层（当前实现不计数——show 转发非热路径）
        void this.transport.send(owner, msg).catch(() => {});
        reply({ t: "res", callId, ok: true, result: null });
        return;
      }
      if (msg.t === "pub") {
        await this.broker.publish(msg.topic, msg.event);
        reply({ t: "res", callId, ok: true, result: null });
        return;
      }
      if (msg.audience) {
        if (msg.t === "sub") await this.broker.subscribe(msg.topic, msg.audience);
        else await this.broker.unsubscribe(msg.topic, msg.audience);
      }
      reply({ t: "res", callId, ok: true, result: null });
    } catch (e) {
      reply({
        t: "res",
        callId,
        ok: false,
        err: {
          kind: "rejected",
          name: "CallRejectedError",
          message: e instanceof Error ? e.message : String(e),
          reason: "whitelist",
          retryable: false,
        },
      });
    }
  }

  /** Director 通道（§11.1）：TROUPE_ADMIN_TOKEN 设置后必须携带匹配 token */
  private async handleDirector(
    msg: Extract<WireMessage, { t: "dir" }>,
    reply: ReplyFn,
  ): Promise<void> {
    const callId = msg.callId;
    try {
      if (this.stopped) {
        throw new CallRejectedError("Stage 已停机", "shutdown", false);
      }
      if (typeof msg.method !== "string" || !Array.isArray(msg.args)) {
        throw new CallRejectedError("dir 信封需要 { method, args[] }", "whitelist", false);
      }
      const expectedToken = this.opts.adminToken ?? process.env.TROUPE_ADMIN_TOKEN;
      if (expectedToken && msg.token !== expectedToken) {
        throw new CallRejectedError("Director 访问被拒：token 不匹配（TROUPE_ADMIN_TOKEN，§11.1）", "whitelist", false);
      }
      const fn = this.deps.directorRef?.current;
      if (!fn) throw new CallRejectedError("Director 未就绪", "whitelist", false);
      const result = await fn(msg.method, msg.args);
      reply({ t: "res", callId, ok: true, result: result ?? null });
    } catch (e) {
      reply({ t: "res", callId, ok: false, err: encodeWireErr(e) });
    }
  }

  private async handleCall(msg: WireCall, reply: ReplyFn): Promise<void> {
    const callId = msg.callId;
    try {
      if (this.stopped) {
        throw new CallRejectedError("Stage 已停机，拒收入站 Call", "shutdown", false);
      }
      // 接收端始终校验信封与参数（§6.1）
      if (
        typeof msg.to?.roleId !== "string" ||
        typeof msg.to?.stageName !== "string" ||
        typeof msg.method !== "string" ||
        !Array.isArray(msg.args) ||
        typeof msg.deadline !== "number"
      ) {
        throw new CallRejectedError("信封字段非法（§6.1）", "whitelist", false);
      }
      const env: CallEnvelope & { from?: string } = {
        callId,
        roleId: msg.to.roleId,
        stageName: msg.to.stageName,
        method: msg.method,
        args: msg.args,
        deadline: msg.deadline,
        hops: (msg.hops ?? 0) + 1,
        from: msg.from, // trace 调用方（§11.4）
        traceparent: msg.traceparent, // 调用链跨 Stage 传播（§11.4）
      };
      // 归属判定（ADR 0004 §3）：目录模式缓存→回源→claim→重读；环与目录不一致以目录为准
      let owner: string | null;
      if (this.router) {
        const t = await this.router.resolveOwner(env.roleId, env.stageName);
        owner = t === null ? null : t.addr;
        if (owner === null) {
          throw new CallRejectedError(
            `目录路由未定归属：${env.roleId}/${env.stageName}（冷键首候选未就绪或目录不可达）——可安全重试`,
            "ownership",
            true,
          );
        }
      } else {
        owner = this.ownerOf(env.roleId, env.stageName);
      }
      if (owner && owner !== this.selfAddr) {
        // 环漂移期：转发给当前归属（跳数上限 2，§6.3）
        if ((msg.hops ?? 0) >= 2) {
          throw new CallRejectedError(
            `环漂移转发跳数耗尽（当前归属 ${owner}）：稍后重试待环收敛`,
            "drift",
            true,
          );
        }
        const result = await this.remoteCall(owner, env);
        reply({ t: "res", callId, ok: true, result });
        return;
      }
      // 本地执行前白名单（含"角色未加载"显式报错，§3.2）
      const meta = this.deps.roles.get(env.roleId);
      if (!meta || !meta.rpcMethods.has(env.method)) {
        throw new CallRejectedError(
          `方法 "${env.method}" 不在本 Stage 的 ${env.roleId} RPC 白名单（角色未加载或方法不存在，§6.1）`,
          "whitelist",
          false,
        );
      }
      const result = await this.deps.localExec(env);
      reply({ t: "res", callId, ok: true, result });
    } catch (e) {
      reply({ t: "res", callId, ok: false, err: encodeWireErr(e) });
    }
  }

  /** 优雅停机：广播 leave → 停止接新（存量由上层排空后关闭） */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.roster?.stop(true);
    this.transport.closeServer();
  }

  closeClients(): void {
    this.transport.closeClients();
  }

  /** 硬杀模拟（kill -9）：无 leave、无排空，连接立即销毁 */
  destroy(): void {
    this.stopped = true;
    void this.roster?.stop(false);
    this.transport.destroy();
  }
}

/** 错误 → 线上分类（§6.1；stack 不上线，仅本地日志） */
function encodeWireErr(e: unknown): WireErr {
  if (e instanceof ConflictError) {
    return { kind: "conflict", name: "ConflictError", message: e.message };
  }
  if (e instanceof UnknownOutcomeError) {
    return { kind: "unknown", name: "UnknownOutcomeError", message: e.message };
  }
  if (e instanceof CallTimeoutError) {
    return { kind: "unknown", name: "UnknownOutcomeError", message: `执行超时，结果未知：${e.message}` };
  }
  if (e instanceof CallRejectedError) {
    return { kind: "rejected", name: "CallRejectedError", message: e.message, reason: e.reason, retryable: e.retryable };
  }
  return {
    kind: "business",
    name: e instanceof Error ? e.name : "Error",
    message: e instanceof Error ? e.message : String(e),
  };
}

function decodeWireErr(err: WireErr): Error {
  switch (err.kind) {
    case "conflict":
      return new ConflictError(err.message, "revision");
    case "unknown":
      return new UnknownOutcomeError(err.message);
    case "rejected":
      return new CallRejectedError(
        err.message,
        (err.reason as CallRejectedError["reason"]) ?? "whitelist",
        err.retryable ?? true,
      );
    default: {
      const e = new Error(err.message);
      e.name = err.name;
      return e;
    }
  }
}

function seedsFromEnv(): string[] {
  const raw = process.env.TROUPE_SEEDS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type { TroupeEvent };
