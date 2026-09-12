import { connect, createServer, type Server, type Socket } from "node:net";
import {
  CallRejectedError,
  TroupeError,
  UnknownOutcomeError,
} from "../core/errors.js";

export const WIRE_PROTOCOL_VERSION = 2; // M3：成员消息携带 incarnation

/** 线上错误分类（DESIGN §6.1）：业务异常 / 请求拒绝 / 存储冲突 / 执行结果未知 */
export type WireErrKind = "business" | "rejected" | "conflict" | "unknown";

export interface WireErr {
  kind: WireErrKind;
  name: string;
  message: string;
  reason?: string;
  retryable?: boolean;
}

export interface WireCall {
  t: "call";
  callId: string;
  from: string;
  to: { roleId: string; stageName: string };
  method: string;
  args: unknown[];
  deadline: number;
  hops: number;
}

export interface WireResponse {
  t: "res";
  callId: string;
  ok: boolean;
  result?: unknown;
  err?: WireErr;
}

export interface WireMember {
  addr: string;
  incarnation: number;
  state: "alive" | "suspect" | "dead";
}

export interface WireDirector {
  t: "dir";
  callId: string;
  from: string;
  method: string;
  args: unknown[];
  token?: string;
}

export type WireMessage =
  | WireCall
  | WireResponse
  | WireDirector
  | { t: "join"; from: string; inc: number; protocol: number; roles: string[] }
  | { t: "join-nack"; from: string; reason: string }
  | { t: "roster"; from: string; inc: number; members: WireMember[] }
  | { t: "ping"; from: string; inc: number }
  | { t: "ack"; from: string; inc: number }
  | { t: "leave"; from: string; inc: number };

export interface TransportOptions {
  /** 单帧最大字节数（解码前限制，DESIGN §6.1） */
  maxFrameBytes: number;
  /** 每连接未完成请求数上限（服务端） */
  maxInflightPerConn: number;
  /** 每连接未完成请求数上限（客户端） */
  maxPendingPerConn: number;
  connectTimeoutMs: number;
}

export type ReplyFn = (msg: WireMessage) => void;

/** 服务端入站消息回调（非 res 消息） */
export type TransportHandler = (msg: WireMessage, reply: ReplyFn) => void;

interface PendingEntry {
  resolve: (res: WireResponse) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Conn {
  socket: Socket;
  pending: Map<string, PendingEntry>;
  inflight: number;
}

const DEFAULTS: TransportOptions = {
  maxFrameBytes: 4 * 1024 * 1024,
  maxInflightPerConn: 256,
  maxPendingPerConn: 512,
  connectTimeoutMs: 3_000,
};

/**
 * TCP 传输（DESIGN §6.1）：4 字节小端长度前缀 + JSON。
 * - 解码前限制帧长度、每连接缓冲、未完成请求数
 * - 畸形帧（超长/坏 JSON）只销毁该连接，进程不崩
 * - 客户端请求超时/断连 → UnknownOutcomeError（结果未知语义，§6.1）
 */
export class Transport {
  private server: Server | null = null;
  private serverSockets = new Set<Socket>();
  private conns = new Map<string, Conn>();
  private connecting = new Map<string, Promise<Conn>>();
  private opts: TransportOptions;
  listenPort: number | null = null;
  listenHost: string | null = null;

  constructor(
    private readonly handler: TransportHandler,
    opts: Partial<TransportOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  address(): { host: string; port: number } | null {
    if (this.listenHost === null || this.listenPort === null) return null;
    return { host: this.listenHost, port: this.listenPort };
  }

  /**
   * 监听；dev：端口被占自动 +1 重试至多 10 次（§8.2）；strict（production）：
   * 固定端口，被占直接抛错——生产不允许悄悄换端口被路由配置遗漏。
   */
  async listen(host = "127.0.0.1", preferredPort = 7300, opts: { strict?: boolean } = {}): Promise<number> {
    if (opts.strict) {
      const port = await this.tryListen(host, preferredPort);
      if (port === null) {
        throw new TroupeError(
          `production 模式端口 ${preferredPort} 被占用：固定端口是部署前提（§6.2/§8.2）`,
        );
      }
      this.listenHost = host;
      this.listenPort = port;
      return port;
    }
    const attempts = preferredPort === 0 ? [0] : Array.from({ length: 10 }, (_, i) => preferredPort + i);
    let lastPort: number | null = null;
    for (const port of attempts) {
      const got = await this.tryListen(host, port);
      if (got !== null) {
        this.listenHost = host;
        this.listenPort = got;
        return got;
      }
    }
    // 全部被占：随机端口兜底
    lastPort = await this.tryListen(host, 0);
    if (lastPort === null) throw new TroupeError(`无法在 ${host} 上监听任何端口`);
    this.listenHost = host;
    this.listenPort = lastPort;
    return lastPort;
  }

  private tryListen(host: string, port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const server = createServer((socket) => this.setupServerSocket(socket));
      server.once("error", () => resolve(null));
      server.listen(port, host, () => {
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  private setupServerSocket(socket: Socket): void {
    const conn: Conn = { socket, pending: new Map(), inflight: 0 };
    this.serverSockets.add(socket);
    socket.on("data", this.makeParser(socket, conn, (msg) => this.onServerMessage(conn, msg)));
    socket.on("close", () => this.serverSockets.delete(socket));
    socket.on("error", () => {
      this.serverSockets.delete(socket);
      socket.destroy();
    });
  }

  private onServerMessage(conn: Conn, msg: WireMessage): void {
    const reply: ReplyFn = (m) => this.writeFrame(conn.socket, m);
    if (msg.t === "call") {
      if (conn.inflight >= this.opts.maxInflightPerConn) {
        reply({
          t: "res",
          callId: msg.callId,
          ok: false,
          err: {
            kind: "rejected",
            name: "CallRejectedError",
            message: `该连接未完成请求过多（≥ ${this.opts.maxInflightPerConn}），背压拒绝（§6.1）`,
            reason: "backpressure",
            retryable: true,
          },
        });
        return;
      }
      conn.inflight++;
      let settled = false;
      const wrappedReply: ReplyFn = (m) => {
        if (settled) return; // 单 Call 单应答
        settled = true;
        conn.inflight--;
        reply(m);
      };
      try {
        this.handler(msg, wrappedReply);
      } catch (e) {
        wrappedReply({
          t: "res",
          callId: msg.callId,
          ok: false,
          err: {
            kind: "rejected",
            name: "CallRejectedError",
            message: `处理入站 Call 时同步抛错：${e instanceof Error ? e.message : String(e)}`,
            reason: "whitelist",
            retryable: false,
          },
        });
      }
      return;
    }
    this.handler(msg, reply);
  }

  private async ensureConn(addr: string): Promise<Conn> {
    const existing = this.conns.get(addr);
    if (existing && !existing.socket.destroyed) return existing;
    const pending = this.connecting.get(addr);
    if (pending) return pending;
    const [host, portStr] = addr.split(":");
    const port = Number(portStr);
    const promise = new Promise<Conn>((resolve, reject) => {
      let settled = false;
      const socket = connect({ host, port });
      const conn: Conn = { socket, pending: new Map(), inflight: 0 };
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        this.connecting.delete(addr);
        socket.destroy();
        reject(e);
      };
      const timer = setTimeout(
        () => fail(new TroupeError(`连接 ${addr} 超时（${this.opts.connectTimeoutMs}ms）`)),
        this.opts.connectTimeoutMs,
      );
      timer.unref?.();
      socket.on("error", (e) => fail(new TroupeError(`连接 ${addr} 失败：${e.message}`)));
      socket.on("close", () => {
        this.conns.delete(addr);
        this.failPending(
          conn,
          new UnknownOutcomeError(`与 ${addr} 的连接断开：执行结果未知（§6.1），勿假定失败`),
        );
      });
      socket.on("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.conns.set(addr, conn);
        this.connecting.delete(addr);
        socket.on("data", this.makeParser(socket, conn, (msg) => this.onClientMessage(conn, msg)));
        resolve(conn);
      });
    });
    this.connecting.set(addr, promise);
    return promise;
  }

  private onClientMessage(conn: Conn, msg: WireMessage): void {
    if (msg.t === "res") {
      const entry = conn.pending.get(msg.callId);
      if (entry) {
        clearTimeout(entry.timer);
        conn.pending.delete(msg.callId);
        entry.resolve(msg);
      }
      return;
    }
    this.handler(msg, (m) => this.writeFrame(conn.socket, m));
  }

  /** 单向消息（ping/roster/join/leave）；写入完成即认为发出 */
  async send(addr: string, msg: WireMessage): Promise<void> {
    const conn = await this.ensureConn(addr);
    await this.writeFrameAsync(conn.socket, msg);
  }

  /** 请求-响应；超时或断连 → UnknownOutcomeError（结果未知）。callId 必须与信封内一致 */
  async request(addr: string, msg: WireMessage, callId: string, timeoutMs: number): Promise<WireResponse> {
    if (msg.t === "call" && msg.callId !== callId) {
      throw new TroupeError(
        `request 的 callId 参数（${callId}）与信封内 callId（${msg.callId}）不一致：响应将无法关联，请使用同一 id`,
      );
    }
    let conn: Conn;
    try {
      conn = await this.ensureConn(addr);
    } catch (e) {
      // 连接失败按 §6.1 归类为"执行结果未知"（调用方按幂等键重试，勿假定失败）
      throw new UnknownOutcomeError(
        `无法连接 ${addr}：${e instanceof Error ? e.message : String(e)}（§6.1 结果未知）`,
      );
    }
    if (conn.pending.size >= this.opts.maxPendingPerConn) {
      throw new CallRejectedError(
        `对 ${addr} 的未完成请求过多（≥ ${this.opts.maxPendingPerConn}），背压拒绝`,
        "backpressure",
        true,
      );
    }
    return new Promise<WireResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(callId);
        reject(
          new UnknownOutcomeError(
            `对 ${addr} 的请求超时（${timeoutMs}ms）：执行结果未知（§6.1），勿假定失败`,
          ),
        );
      }, Math.max(1, timeoutMs));
      conn.pending.set(callId, {
        resolve,
        reject,
        timer,
      });
      this.writeFrameAsync(conn.socket, msg).catch((e) => {
        clearTimeout(timer);
        conn.pending.delete(callId);
        reject(e);
      });
    });
  }

  private failPending(conn: Conn, err: unknown): void {
    for (const [, entry] of conn.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    conn.pending.clear();
  }

  /** 帧解析器：长度前缀 + 上限校验 + JSON 解析；畸形帧销毁连接（进程不崩） */
  private makeParser(socket: Socket, conn: Conn, onMsg: (msg: WireMessage) => void): (chunk: Buffer) => void {
    let buf = Buffer.alloc(0);
    return (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32LE(0);
        if (len > this.opts.maxFrameBytes) {
          socket.destroy(); // 超长帧：仅销毁该连接（§6.1 解码前限制）
          this.failPending(conn, new UnknownOutcomeError("对端发送超长帧，连接已断开：结果未知"));
          return;
        }
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let msg: unknown;
        try {
          msg = JSON.parse(body.toString("utf8"));
        } catch {
          socket.destroy(); // 坏 JSON：可控拒绝，进程不崩
          this.failPending(conn, new UnknownOutcomeError("对端发送无法解析的帧，连接已断开：结果未知"));
          return;
        }
        if (msg === null || typeof msg !== "object" || typeof (msg as { t?: unknown }).t !== "string") {
          continue; // 非omitempty消息：忽略（无法关联 callId）
        }
        onMsg(msg as WireMessage);
      }
    };
  }

  private writeFrame(socket: Socket, msg: WireMessage): void {
    try {
      const body = Buffer.from(JSON.stringify(msg), "utf8");
      const head = Buffer.allocUnsafe(4);
      head.writeUInt32LE(body.length, 0);
      socket.write(Buffer.concat([head, body]));
    } catch {
      socket.destroy();
    }
  }

  private writeFrameAsync(socket: Socket, msg: WireMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(msg), "utf8");
      const head = Buffer.allocUnsafe(4);
      head.writeUInt32LE(body.length, 0);
      socket.write(Buffer.concat([head, body]), (err) => (err ? reject(err) : resolve()));
    });
  }

  /** 优雅关闭：停止接新；存量连接保留给上层排空后调用 closeClients */
  closeServer(): void {
    this.server?.close();
    this.server = null;
  }

  closeClients(): void {
    for (const conn of this.conns.values()) {
      this.failPending(conn, new UnknownOutcomeError("本地主动关闭连接：执行结果未知"));
      conn.socket.destroy();
    }
    this.conns.clear();
  }

  destroyServerSockets(): void {
    for (const s of this.serverSockets) s.destroy();
    this.serverSockets.clear();
  }

  /** 硬杀模拟（kill -9）：无 leave、无排空 */
  destroy(): void {
    this.closeServer();
    this.destroyServerSockets();
    this.closeClients();
  }
}
