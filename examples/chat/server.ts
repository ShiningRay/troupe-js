/**
 * 聊天室 demo（M1/M2 原语构建）：
 *   - RoomActor（每房间一个实例）：消息与成员住在 Props，SqlitePropStore 持久化（重启不丢）
 *   - 发送走 this.idempotent（msgId + 参数指纹）：网络失败重试不重不漏（§6.5）
 *   - 边缘层：node:http + SSE 推送（零依赖）；Booth 内省面板开在 7500
 *
 * 运行：npm run example:chat [端口，默认 8787]
 * 多房间：浏览器地址加 ?room=xxx（每个房间 = 一个 Room Actor 实例）
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Actor, IdempotencyConflictError, Troupe } from "../../src/index.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";
import { CHAT_HTML } from "./page.js";

interface ChatMessage {
  id: number;
  user: string;
  text: string;
  at: number;
}

interface RoomProps {
  seq: number;
  messages: ChatMessage[];
  members: string[];
}

const HISTORY_CAP = 200;

export class RoomActor extends Actor<RoomProps> {
  static role = "Room";
  static initialProps = (): RoomProps => ({ seq: 0, messages: [], members: [] });

  async join(user: string): Promise<string[]> {
    if (!this.props.members.includes(user)) this.props.members.push(user);
    await this.saveProps();
    return [...this.props.members];
  }

  async leave(user: string): Promise<string[]> {
    this.props.members = this.props.members.filter((m) => m !== user);
    await this.saveProps();
    return [...this.props.members];
  }

  /** 幂等发送：msgId 为操作键，user:text 为参数指纹；helper 在 settle 后原子提交 */
  async send(msgId: string, user: string, text: string): Promise<ChatMessage> {
    return this.idempotent(`send:${msgId}`, `${user}:${text}`, async () => {
      const msg: ChatMessage = { id: ++this.props.seq, user, text, at: Date.now() };
      this.props.messages.push(msg);
      if (this.props.messages.length > HISTORY_CAP) {
        this.props.messages.splice(0, this.props.messages.length - HISTORY_CAP);
      }
      return msg;
    });
  }

  async since(cursor: number): Promise<ChatMessage[]> {
    return this.props.messages.filter((m) => m.id > cursor);
  }

  async members(): Promise<string[]> {
    return [...this.props.members];
  }
}

// ---- 边缘层：HTTP + SSE（鉴权/校验示意，真实项目走 Edge 框架） ----

type Room = string;
const subscribers = new Map<Room, Set<ServerResponse>>();

function broadcast(room: Room, payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  const subs = subscribers.get(room);
  if (!subs) return;
  for (const res of subs) {
    try {
      res.write(frame);
    } catch {
      subs.delete(res);
    }
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? process.env.TROUPE_CHAT_PORT ?? 8787);

  const troupe = await Troupe.form({
    actors: [RoomActor],
    propStore: new SqlitePropStore(".troupe/chat-demo"), // 重启保留历史；rm -rf .troupe 重置
    defaultIntermission: "1m", // 空闲下场：Props 归还，下次消息重新登台（Booth 可观察）
    cluster: { port: 0 },
    booth: { port: 7500 },
  });

  const server = createServer((req, res) => void handle(req, res));
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const room = (url.searchParams.get("room") || "lobby").replace(/[^\w-]/g, "").slice(0, 32) || "lobby";
    const agent = troupe.cast(RoomActor, room);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(CHAT_HTML);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/stream") {
        const user = String(url.searchParams.get("user") ?? "").slice(0, 32);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.flushHeaders?.();
        let subs = subscribers.get(room);
        if (!subs) {
          subs = new Set();
          subscribers.set(room, subs);
        }
        subs.add(res);
        // 连接即推：历史 + 成员
        res.write(
          `data: ${JSON.stringify({
            type: "init",
            room,
            messages: await agent.since(0),
            members: await agent.members(),
          })}\n\n`,
        );
        req.on("close", () => {
          subs!.delete(res);
          if (user) {
            void agent.leave(user).then((ms) => broadcast(room, { type: "members", members: ms }));
          }
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/join") {
        const body = await readJson(req);
        const user = String(body.user ?? "").trim().slice(0, 32);
        if (!user) return json(res, 400, { error: "需要昵称" });
        const members = await agent.join(user);
        broadcast(room, { type: "members", members });
        return json(res, 200, { ok: true, members });
      }
      if (req.method === "POST" && url.pathname === "/api/send") {
        const body = await readJson(req);
        const msgId = String(body.msgId ?? "");
        const user = String(body.user ?? "").trim().slice(0, 32);
        const text = String(body.text ?? "").trim().slice(0, 500);
        if (!msgId || !user || !text) return json(res, 400, { error: "需要 { msgId, user, text }" });
        try {
          const message = await agent.send(msgId, user, text);
          broadcast(room, { type: "message", message });
          return json(res, 200, { ok: true, id: message.id });
        } catch (e) {
          if (e instanceof IdempotencyConflictError) {
            return json(res, 409, { error: "msgId 已用于不同内容" });
          }
          throw e;
        }
      }
      if (req.method === "GET" && url.pathname === "/api/messages") {
        return json(res, 200, {
          room,
          messages: await agent.since(0),
          members: await agent.members(),
        });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  console.log(`💬 聊天室：http://127.0.0.1:${port}/?room=lobby`);
  console.log(`🎭 Booth 面板：${troupe.boothAddress()}（看 Room Actor 的状态机/revision/事件流）`);
  console.log(`   提示：历史存 .troupe/chat-demo（重启不丢）；Ctrl+C 优雅停机（排空 + 保存）`);

  const shutdown = async () => {
    console.log("\n优雅停机：排空 → offStage + saveProps…");
    await troupe.shutdown();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// vitest 下导入 RoomActor 做单测时不启动服务
if (process.env.VITEST === undefined) {
  void main();
}
