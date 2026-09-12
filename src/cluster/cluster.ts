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
   * 也可经 TROUPE_MODE=production 开启。
   */
  mode?: "dev" | "production";
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
    },
    private readonly opts: ClusterOptions = {},
  ) {
    this.playbill = new Playbill(deps.namespace, []);
    const handler: TransportHandler = (msg, reply) => this.onWire(msg, reply);
    this.transport = new Transport(handler);
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
    }
    const preferred = this.opts.port ?? Number(process.env.TROUPE_PORT ?? 7300);
    const port = await this.transport.listen(host, preferred, { strict: production });
    if (!production && preferred !== 0 && port !== preferred) {
      console.log(`[troupe] 端口 ${preferred} 被占，改用 ${port}（§8.2 dev 便利；生产请固定端口）`);
    }
    this.selfAddr = this.opts.advertise ?? `${host}:${port}`;
    // Stage 身份 = addr#incarnation：重启即新身份（旧身份的租约/成员记录自然作废，§6.2/§6.5）
    this.stageIdValue = `${this.selfAddr}#${Date.now()}`;
    this.roster = new Roster(
      this.selfAddr,
      (addr, m) => this.transport.send(addr, m),
      [...this.deps.roles.keys()],
      { protocolVersion: this.opts.protocolVersion ?? WIRE_PROTOCOL_VERSION },
    );
    this.roster.strictJoinFlag = production;
    this.roster.onMembersChanged = (alive) => {
      this.playbill.setMembers(alive);
      this.deps.events.emit({
        type: "membershipChanged",
        roleId: "<cluster>",
        at: Date.now(),
        detail: { alive, self: this.selfAddr },
      });
    };
    this.playbill.setMembers([this.selfAddr]);
    await this.roster.start(this.opts.seeds ?? seedsFromEnv(), production);
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

  /** 出站路由：归属自己（或无成员视图）→ 本地；否则转发到归属 Stage */
  async route(env: CallEnvelope): Promise<unknown> {
    if (this.stopped) {
      throw new CallRejectedError("Stage 已停机，拒收新 Call（优雅停机中）", "shutdown", false);
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
    const timeoutMs = Math.max(1, env.deadline - Date.now());
    const res = await this.transport.request(addr, wire, env.callId, timeoutMs);
    if (res.ok) return res.result;
    throw decodeWireErr(res.err!);
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
    this.roster?.handle(msg, reply);
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
      const expectedToken = process.env.TROUPE_ADMIN_TOKEN;
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
      const env: CallEnvelope = {
        callId,
        roleId: msg.to.roleId,
        stageName: msg.to.stageName,
        method: msg.method,
        args: msg.args,
        deadline: msg.deadline,
        hops: (msg.hops ?? 0) + 1,
      };
      const owner = this.ownerOf(env.roleId, env.stageName);
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
