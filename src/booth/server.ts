import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Troupe } from "../troupe.js";
import type { TroupeEvent } from "../core/events.js";
import { BOOTH_HTML } from "./page.js";

export interface BoothOptions {
  /** 默认 127.0.0.1（DESIGN §11.1：仅 loopback；远程 + token 属 M4 Director） */
  host?: string;
  /** 默认 7500；被占自动 +1（至多 10 次），全占退回随机端口 */
  port?: number;
}

const MAX_EVENTS = 200;

/**
 * Booth 预览版（提前于 M9 交付的极简内省面板）：
 * - GET  /            单文件页面（零构建、无外部资源）
 * - GET  /api/overview  Stage/成员/在场 Actor/指标/事件流
 * - POST /api/off       强制下场（排空 → offStage → 保存）
 * - POST /api/call      白名单内方法调用（调试）
 * 安全：默认仅绑定 loopback（§6.1/§11.1）；生产鉴权随 M4 Director 交付。
 */
export class Booth {
  private server: Server | null = null;
  private events: TroupeEvent[] = [];
  private readonly startedAt = Date.now();
  private readonly unsubscribe: () => void;
  address: string | null = null;

  private sseClients = new Set<ServerResponse>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly troupe: Troupe) {
    this.unsubscribe = troupe.events.on((e) => {
      this.events.unshift(e);
      if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
      this.schedulePush(); // 事件驱动推送（合并去抖）
    });
  }

  async start(opts: BoothOptions = {}): Promise<string> {
    const host = opts.host ?? "127.0.0.1";
    const preferred = opts.port ?? Number(process.env.TROUPE_BOOTH_PORT ?? 7500);
    const attempts = preferred === 0 ? [0] : Array.from({ length: 10 }, (_, i) => preferred + i);
    let port: number | null = null;
    for (const p of attempts) {
      port = await this.tryListen(host, p);
      if (port !== null) break;
    }
    if (port === null) port = await this.tryListen(host, 0);
    if (port === null) throw new Error("Booth 无法绑定端口");
    this.address = `http://${host}:${port}`;
    // 1s 保活帧：让 uptime/空闲时长持续刷新（SSE，§11.3）
    this.keepAlive = setInterval(() => this.pushAll(), 1_000);
    this.keepAlive.unref?.();
    return this.address;
  }

  private tryListen(host: string, port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", () => resolve(null));
      server.listen(port, host, () => {
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    if (this.keepAlive !== null) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.pushTimer !== null) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
    this.unsubscribe();
  }

  /** 事件驱动的合并推送：250ms 去抖，避免调用高峰刷屏 */
  private schedulePush(): void {
    if (this.pushTimer !== null) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushAll();
    }, 250);
    this.pushTimer.unref?.();
  }

  private pushAll(): void {
    if (this.sseClients.size === 0) return;
    const frame = `data: ${JSON.stringify(this.overview())}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(frame);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(BOOTH_HTML);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/overview") {
        this.json(res, 200, this.overview());
        return;
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        this.json(res, 200, {
          ok: true,
          addr: this.troupe.clusterAddress() ?? `local:${process.pid}`,
          members: (this.troupe.clusterMembers() ?? []).length,
          actors: this.troupe.slots().length,
          uptimeMs: Date.now() - this.startedAt,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        // Prometheus 文本格式（DESIGN §11.4 计数器/延迟直方图）
        const snapshot = this.troupe.metrics.snapshot();
        const lines: string[] = [
          "# TYPE troupe_actors_onstage gauge",
          `troupe_actors_onstage ${this.troupe.slots().length}`,
          "# TYPE troupe_members gauge",
          `troupe_members ${(this.troupe.clusterMembers() ?? []).length}`,
        ];
        for (const [role, m] of Object.entries(snapshot)) {
          const r = escapeLabel(role);
          lines.push(
            `# TYPE troupe_calls_total counter`,
            `troupe_calls_total{role="${r}"} ${m.calls}`,
            `troupe_errors_total{role="${r}"} ${m.errors}`,
            `troupe_rejections_total{role="${r}"} ${m.rejections}`,
            `troupe_latency_ms{role="${r}",quantile="0.5"} ${round1(m.latency.p50)}`,
            `troupe_latency_ms{role="${r}",quantile="0.99"} ${round1(m.latency.p99)}`,
            `troupe_latency_ms{role="${r}",quantile="max"} ${round1(m.latency.max)}`,
          );
        }
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(lines.join("\n") + "\n");
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/stream") {
        // SSE 实时推送（DESIGN §11.3：实时推送用 SSE）；连接即推当前快照
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.flushHeaders?.();
        this.sseClients.add(res);
        try {
          res.write(`data: ${JSON.stringify(this.overview())}\n\n`);
        } catch {
          this.sseClients.delete(res);
        }
        req.on("close", () => this.sseClients.delete(res));
        return;
      }
      if (req.method === "POST" && (url.pathname === "/api/off" || url.pathname === "/api/call")) {
        const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
        if (url.pathname === "/api/off") {
          if (typeof body?.roleId !== "string" || typeof body?.stageName !== "string") {
            this.json(res, 400, { error: "需要 { roleId, stageName }" });
            return;
          }
          await this.troupe.off(body.roleId, body.stageName);
          this.json(res, 200, { ok: true });
          return;
        }
        // /api/call：白名单校验（§6.1）后经正式调度通道调用
        const { roleId, stageName, method, args } = body ?? {};
        if (
          typeof roleId !== "string" || typeof stageName !== "string" ||
          typeof method !== "string" || !Array.isArray(args)
        ) {
          this.json(res, 400, { error: "需要 { roleId, stageName, method, args: unknown[] }" });
          return;
        }
        let methods: string[];
        try {
          methods = this.troupe.methodsOf(roleId);
        } catch (e) {
          this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          return;
        }
        if (!methods.includes(method)) {
          this.json(res, 400, { error: `方法 "${method}" 不在 ${roleId} 的 RPC 白名单：${methods.join(", ") || "（无）"}` });
          return;
        }
        try {
          const agent = this.troupe.cast(roleId, stageName) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
          const result = await agent[method](...args);
          this.json(res, 200, { ok: true, result: result ?? null });
        } catch (e) {
          this.json(res, 200, { ok: false, error: `${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }
      this.json(res, 404, { error: "not found" });
    } catch (e) {
      this.json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private overview() {
    const members = this.troupe.clusterMembers();
    return {
      stage: {
        addr: this.troupe.clusterAddress() ?? `local:${process.pid}`,
        pid: process.pid,
        uptimeMs: Date.now() - this.startedAt,
        node: process.version,
        namespace: process.env.TROUPE_NAMESPACE ?? "default",
      },
      members: this.troupe.clusterAddress()
        ? [this.troupe.clusterAddress()!, ...(members ?? [])]
        : [`local:${process.pid}`],
      actors: this.troupe.slots(),
      metrics: this.troupe.metrics.snapshot(),
      events: this.events.map((e) => ({
        type: e.type,
        roleId: e.roleId,
        stageName: e.stageName,
        method: e.method,
        at: e.at,
      })),
    };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) {
        req.destroy();
        reject(new Error("请求体超过 1MB 上限"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${e instanceof Error ? e.message : String(e)}`));
      }
    });
    req.on("error", reject);
  });
}
