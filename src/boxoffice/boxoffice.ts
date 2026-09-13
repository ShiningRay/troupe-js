import { createServer, type Server } from "node:http";
import type { Troupe } from "../troupe.js";
import { attachWebSocket, WsConnection } from "./ws.js";
import { BOXOFFICE_HTML } from "./page.js";

export interface BoxOfficeOptions {
  host?: string; // 默认 127.0.0.1（§6.1）
  port?: number; // 默认 7600，被占自动 +1
}

const MAX_CONNECTIONS = 256;

/**
 * BoxOffice（M8，DESIGN §2 售票处）：WebSocket 客户端网关——浏览器直拿 Agent。
 *
 * 协议（JSON 文本帧）：
 *   → { op: "call", callId, roleId, stageName, method, args }
 *   ← { op: "result", callId, ok, result? , error? }
 *   → { op: "ping" }  ← { op: "pong" }
 * 鉴权：token 设置后（opts.token 或 TROUPE_BOXOFFICE_TOKEN），WS 升级必须带
 * ?ticket=<token>。调用经 troupe.cast 完整管道（白名单/串行 Turn/编解码边界）。
 */
export class BoxOffice {
  private server: Server | null = null;
  private connections = new Set<WsConnection>();
  address: string | null = null;
  private readonly token: string | null;

  constructor(
    private readonly troupe: Troupe,
    token?: string | null,
  ) {
    this.token = token === undefined ? (process.env.TROUPE_BOXOFFICE_TOKEN ?? null) : token || null;
  }

  /** ticket（构造时决定；null = 无鉴权，仅 loopback 开发） */
  get ticket(): string | null {
    return this.token;
  }

  async start(opts: BoxOfficeOptions = {}): Promise<string> {
    const host = opts.host ?? "127.0.0.1";
    const preferred = opts.port ?? Number(process.env.TROUPE_BOXOFFICE_PORT ?? 7600);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/boxoffice")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(BOXOFFICE_HTML);
        return;
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, connections: this.connections.size }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.server = server;
    attachWebSocket(server, {
      path: "/ws",
      authorize: (req) => {
        if (!this.token) return true;
        const url = new URL(req.url ?? "/", "http://local");
        return url.searchParams.get("ticket") === this.token;
      },
      onConnection: (conn) => {
        if (this.connections.size >= MAX_CONNECTIONS) {
          conn.close(1013);
          return;
        }
        this.connections.add(conn);
        conn.bind((text) => this.handleMessage(conn, text), () => this.connections.delete(conn));
      },
    });

    const attempts = preferred === 0 ? [0] : Array.from({ length: 10 }, (_, i) => preferred + i);
    let port: number | null = null;
    for (const p of attempts) {
      const got = await this.tryListen(host, p, server);
      if (got !== null) {
        port = got;
        break;
      }
    }
    if (port === null) port = (await this.tryListen(host, 0, server)) ?? 0;
    this.address = `http://${host}:${port}`;
    return this.address;
  }

  private tryListen(host: string, port: number, server: Server): Promise<number | null> {
    return new Promise((resolve) => {
      server.once("error", () => resolve(null));
      server.listen(port, host, () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  private handleMessage(conn: WsConnection, text: string): void {
    let msg: {
      op?: string;
      callId?: string;
      roleId?: string;
      stageName?: string;
      method?: string;
      args?: unknown;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      conn.sendText(JSON.stringify({ op: "error", error: "消息不是合法 JSON" }));
      return;
    }
    if (msg.op === "ping") {
      conn.sendText(JSON.stringify({ op: "pong" }));
      return;
    }
    if (msg.op !== "call") {
      conn.sendText(JSON.stringify({ op: "error", error: `未知 op "${msg.op}"（支持 call/ping）` }));
      return;
    }
    const callId = typeof msg.callId === "string" ? msg.callId : "?";
    if (
      typeof msg.roleId !== "string" ||
      typeof msg.stageName !== "string" ||
      typeof msg.method !== "string" ||
      !Array.isArray(msg.args)
    ) {
      conn.sendText(
        JSON.stringify({ op: "result", callId, ok: false, error: "需要 { roleId, stageName, method, args[] }" }),
      );
      return;
    }
    try {
      const agent = this.troupe.cast(msg.roleId, msg.stageName) as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >;
      if (typeof agent[msg.method] !== "function") {
        conn.sendText(JSON.stringify({ op: "result", callId, ok: false, error: `方法 "${msg.method}" 不在白名单` }));
        return;
      }
      void agent[msg.method](...msg.args).then(
        (result) => conn.sendText(JSON.stringify({ op: "result", callId, ok: true, result: result ?? null })),
        (e: unknown) =>
          conn.sendText(
            JSON.stringify({
              op: "result",
              callId,
              ok: false,
              error: `${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
      );
    } catch (e) {
      conn.sendText(
        JSON.stringify({
          op: "result",
          callId,
          ok: false,
          error: `${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : String(e)}`,
        }),
      );
    }
  }

  stop(): void {
    for (const c of this.connections) c.close(1001);
    this.connections.clear();
    this.server?.close();
    this.server = null;
  }
}
