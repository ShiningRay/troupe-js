import { Socket, connect } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { sleep } from "./helpers.js";

/** 最小 WS 客户端（测试用）：握手 + mask 帧 + 文本收发 */
class WsTestClient {
  private buffer = Buffer.alloc(0);
  private pending: Array<(text: string) => void> = [];
  private texts: string[] = [];
  private socket = new Socket();
  ready: Promise<void>;

  constructor(port: number, path: string) {
    this.socket.connect(port, "127.0.0.1");
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", () => {
        const key = randomBytes(16).toString("base64");
        this.socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      const onHandshake = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = this.buffer.subarray(0, end).toString();
        this.buffer = this.buffer.subarray(end + 4);
        this.socket.off("data", onHandshake);
        if (!head.includes("101")) {
          reject(new Error(`握手失败：${head.split("\r\n")[0]}`));
          return;
        }
        this.socket.on("data", (c) => this.feed(c));
        resolve();
      };
      this.socket.on("data", onHandshake);
      this.socket.on("error", reject);
    });
    this.socket.on("error", () => {});
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      const opcode = this.buffer.length >= 0 ? 1 : 1;
      void opcode;
      const text = payload.toString("utf8");
      const waiter = this.pending.shift();
      if (waiter) waiter(text);
      else this.texts.push(text);
    }
  }

  sendMasked(text: string): void {
    const payload = Buffer.from(text, "utf8");
    const mask = randomBytes(4);
    let head: Buffer;
    if (payload.length < 126) {
      head = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      head = Buffer.alloc(4);
      head[0] = 0x81;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([head, mask, masked]));
  }

  /** 等待匹配 callId 的 result 帧 */
  async waitFor(callId: string, timeoutMs = 5_000): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const start = Date.now();
    const idx = this.texts.findIndex((t) => t.includes(callId));
    if (idx >= 0) {
      const [hit] = this.texts.splice(idx, 1);
      return JSON.parse(hit);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${callId} 超时`)), timeoutMs);
      this.pending.push((text) => {
        clearTimeout(timer);
        resolve(JSON.parse(text));
      });
      void start;
    });
  }
}

interface BxProps {
  items: string[];
}

class ShopActor extends Actor<BxProps> {
  static role = "Shop";
  static initialProps = (): BxProps => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }
}

async function openClient(port: number, ticket?: string): Promise<WsTestClient> {
  const path = "/ws" + (ticket ? `?ticket=${encodeURIComponent(ticket)}` : "");
  const c = new WsTestClient(port, path);
  await c.ready;
  return c;
}

describe("M8 验收：BoxOffice（WS 网关，浏览器直拿 Agent）", () => {
  it("ticket 鉴权：无/错 ticket 升级被拒；正确 ticket 建连", async () => {
    const troupe = await Troupe.form({
      actors: [ShopActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      boxoffice: { port: 0, token: "tick-1" },
    });
    const port = Number(troupe.boxofficeAddress()!.split(":")[2]);

    await expect(openClient(port)).rejects.toThrow(/401/); // 无 ticket
    await expect(openClient(port, "wrong")).rejects.toThrow(/401/); // 错 ticket

    const client = await openClient(port, "tick-1");
    client.sendMasked(JSON.stringify({ op: "ping" }));
    const pong = await client.waitFor("pong", 3_000).catch(() => null);
    expect(pong).not.toBeNull();
    await troupe.shutdown();
  });

  it("浏览器等价调用：WS call → cast 完整管道（白名单/持久化）", async () => {
    const troupe = await Troupe.form({
      actors: [ShopActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      boxoffice: { port: 0 },
    });
    const port = Number(troupe.boxofficeAddress()!.split(":")[2]);
    const client = await openClient(port); // 无 token → 直接建连

    const id1 = randomUUID();
    client.sendMasked(
      JSON.stringify({ op: "call", callId: id1, roleId: "Shop", stageName: "u1", method: "add", args: ["a"] }),
    );
    expect(await client.waitFor(id1)).toMatchObject({ ok: true, result: 1 });

    // 白名单外方法（saveProps）拒绝
    const id2 = randomUUID();
    client.sendMasked(
      JSON.stringify({ op: "call", callId: id2, roleId: "Shop", stageName: "u1", method: "saveProps", args: [] }),
    );
    const wl = await client.waitFor(id2);
    expect(wl.ok).toBe(false);
    expect(wl.error).toMatch(/白名单/);

    // 业务异常透传
    const id3 = randomUUID();
    client.sendMasked(
      JSON.stringify({ op: "call", callId: id3, roleId: "Ghost", stageName: "g", method: "x", args: [] }),
    );
    const ghost = await client.waitFor(id3);
    expect(ghost.ok).toBe(false);

    await troupe.shutdown();
  });

  it("调用链传播：WS → Actor → Actor 内 this.cast，traceparent 同一 traceId + onSpan 钩子", async () => {
    class ChainActor extends Actor<Record<string, never>> {
      static role = "Chain";
      static initialProps = () => ({}) as Record<string, never>;

      async start() {
        return this.cast(ShopActor, "chain-shop").add("via-chain");
      }
    }
    const spans: Array<{ traceparent: string; roleId: string; method: string }> = [];
    const troupe = await Troupe.form({
      actors: [ShopActor, ChainActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      boxoffice: { port: 0 },
      onSpan: (s) => spans.push(s),
    });
    const port = Number(troupe.boxofficeAddress()!.split(":")[2]);
    const client = await openClient(port);

    const id = randomUUID();
    client.sendMasked(
      JSON.stringify({ op: "call", callId: id, roleId: "Chain", stageName: "c1", method: "start", args: [] }),
    );
    expect(await client.waitFor(id)).toMatchObject({ ok: true, result: 1 });
    await sleep(50);

    // 两个 Turn（Chain.start → Shop.add）应共享同一 traceId
    const shopSpans = spans.filter((s) => s.roleId === "Shop");
    const chainSpans = spans.filter((s) => s.roleId === "Chain");
    expect(shopSpans.length).toBe(1);
    expect(chainSpans.length).toBe(1);
    expect(shopSpans[0].traceparent.split("-")[1]).toBe(chainSpans[0].traceparent.split("-")[1]);
    expect(shopSpans[0].traceparent).not.toBe(chainSpans[0].traceparent); // spanId 不同
    await troupe.shutdown();
  });
});

