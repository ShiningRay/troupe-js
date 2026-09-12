import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { UnknownOutcomeError } from "../src/index.js";
import { Transport, type WireMessage } from "../src/cluster/transport.js";

function frameOf(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function rawFrame(body: string): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, Buffer.from(body)]);
}

const noopHandler = (_msg: WireMessage, _reply: (m: WireMessage) => void) => {};

describe("M2 验收：Transport（DESIGN §6.1 长度前缀 + 帧上限 + 错误分类）", () => {
  it("请求-响应往返；ping 由服务端 handler 应答 ack", async () => {
    const server = new Transport((msg, reply) => {
      if (msg.t === "call") reply({ t: "res", callId: msg.callId, ok: true, result: "pong" });
      else if (msg.t === "ping") reply({ t: "ack", from: "server" });
    });
    const port = await server.listen("127.0.0.1", 0);
    const addr = `127.0.0.1:${port}`;
    const client = new Transport(noopHandler);

    const res = await client.request(
      addr,
      { t: "call", callId: "c1", from: "client", to: { roleId: "X", stageName: "y" }, method: "m", args: [], deadline: Date.now() + 1000, hops: 0 },
      "c1",
      1000,
    );
    expect(res.ok).toBe(true);
    expect(res.result).toBe("pong");

    const acks: string[] = [];
    const client2 = new Transport((msg) => {
      if (msg.t === "ack") acks.push(msg.from);
    });
    await client2.send(addr, { t: "ping", from: "client" });
    await new Promise((r) => setTimeout(r, 100));
    expect(acks).toContain("server");

    client.destroy();
    client2.destroy();
    server.destroy();
  });

  it("坏 JSON 帧只销毁该连接：进程与后续连接不崩", async () => {
    const server = new Transport((msg, reply) => {
      if (msg.t === "call") reply({ t: "res", callId: msg.callId, ok: true, result: 1 });
    });
    const port = await server.listen("127.0.0.1", 0);
    const addr = `127.0.0.1:${port}`;

    const raw = connect(port, "127.0.0.1");
    const closed = new Promise<void>((r) => raw.on("close", () => r()));
    raw.on("connect", () => raw.write(rawFrame("this is not json{{{")));
    await closed; // 畸形帧 → 该连接被销毁

    const client = new Transport(noopHandler);
    const res = await client.request(
      addr,
      { t: "call", callId: "c2", from: "client", to: { roleId: "X", stageName: "y" }, method: "m", args: [], deadline: Date.now() + 1000, hops: 0 },
      "c2",
      1000,
    );
    expect(res.ok).toBe(true); // 新连接照常服务
    client.destroy();
    server.destroy();
  });

  it("超长帧在解码前被拒：连接销毁、进程不崩", async () => {
    const server = new Transport(noopHandler, { maxFrameBytes: 1024 });
    const port = await server.listen("127.0.0.1", 0);

    const raw = connect(port, "127.0.0.1");
    const closed = new Promise<void>((r) => raw.on("close", () => r()));
    raw.on("connect", () => {
      const head = Buffer.alloc(4);
      head.writeUInt32LE(10 * 1024 * 1024, 0); // 声称 10MB
      raw.write(head);
    });
    await closed;
    server.destroy();
  });

  it("服务端每连接 in-flight 上限：超限请求收到 backpressure 拒绝", async () => {
    const server = new Transport(
      (msg, reply) => {
        if (msg.t === "call") {
          setTimeout(() => reply({ t: "res", callId: msg.callId, ok: true, result: 1 }), 150);
        }
      },
      { maxInflightPerConn: 2 },
    );
    const port = await server.listen("127.0.0.1", 0);
    const addr = `127.0.0.1:${port}`;
    const client = new Transport(noopHandler);

    const mk = (id: string) =>
      client.request(
        addr,
        { t: "call", callId: id, from: "client", to: { roleId: "X", stageName: "y" }, method: "m", args: [], deadline: Date.now() + 2000, hops: 0 },
        id,
        2000,
      );
    const rs = await Promise.all([mk("a"), mk("b"), mk("c").catch((e) => e)]);
    expect(rs[0]).toMatchObject({ ok: true });
    expect(rs[1]).toMatchObject({ ok: true });
    expect(rs[2]).toMatchObject({ ok: false, err: { kind: "rejected", reason: "backpressure" } });

    client.destroy();
    server.destroy();
  });

  it("连接断开时未完成请求 → UnknownOutcomeError（结果未知）", async () => {
    const server = new Transport((_msg, _reply) => {
      // 永不回复
    });
    const port = await server.listen("127.0.0.1", 0);
    const client = new Transport(noopHandler);
    const addr = `127.0.0.1:${port}`;

    const p = client.request(
      addr,
      { t: "call", callId: "hang", from: "client", to: { roleId: "X", stageName: "y" }, method: "m", args: [], deadline: Date.now() + 5000, hops: 0 },
      "hang",
      5000,
    );
    await new Promise((r) => setTimeout(r, 50));
    server.destroy(); // 服务端消失
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(UnknownOutcomeError);
    client.destroy();
  });

  it("请求超时 → UnknownOutcomeError（结果未知，非失败）", async () => {
    const server = new Transport((_msg, _reply) => {});
    const port = await server.listen("127.0.0.1", 0);
    const client = new Transport(noopHandler);

    const err = await client
      .request(
        `127.0.0.1:${port}`,
        { t: "call", callId: "slow", from: "client", to: { roleId: "X", stageName: "y" }, method: "m", args: [], deadline: Date.now() + 200, hops: 0 },
        "slow",
        200,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnknownOutcomeError);
    client.destroy();
    server.destroy();
  });
});
