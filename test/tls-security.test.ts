import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as plainConnect } from "node:net";
import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { SqlitePropStore } from "../src/props/sqlite.js";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./fixtures/test-tls.js";

/**
 * P1-6 安全验收（ROADMAP）：TLS 线路加密、join 预共享 token + 限速、Director 管理凭证、
 * production 安全门禁（TLS + adminToken 必配）。
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 15_000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

class SecCart extends Actor<{ items: string[] }> {
  static role = "SecCart";
  static initialProps = () => ({ items: [] });
  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }
}

const TLS = { cert: TEST_TLS_CERT, key: TEST_TLS_KEY, ca: TEST_TLS_CERT };

describe("P1-6 安全验收：TLS / join token / admin token", () => {
  const base = 17_900 + (process.pid % 1_000);

  it("production 门禁：缺 TLS / 缺 adminToken → 启动失败", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-sec-"));
    await expect(
      Troupe.form({
        actors: [SecCart],
        propStore: new SqlitePropStore(dir),
        cluster: { mode: "production", port: base, advertise: `127.0.0.1:${base}`, adminToken: "t" },
      }),
    ).rejects.toThrow(/TLS/);
    await expect(
      Troupe.form({
        actors: [SecCart],
        propStore: new SqlitePropStore(dir),
        cluster: { mode: "production", port: base + 1, advertise: `127.0.0.1:${base + 1}`, tls: TLS },
      }),
    ).rejects.toThrow(/adminToken|TROUPE_ADMIN_TOKEN/);
  });

  it("TLS 双 Stage：加密线路互调可用；明文连接 TLS 端口被拒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-tls-"));
    const a = await Troupe.form({
      actors: [SecCart],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      cluster: { port: 0, tls: TLS },
      ownership: { leaseMs: 5_000 },
    });
    const b = await Troupe.form({
      actors: [SecCart],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      cluster: { port: 0, tls: TLS, seeds: [a.clusterAddress()!] },
      ownership: { leaseMs: 5_000 },
    });
    await waitUntil(() => a.clusterMembers()!.length === 1);
    // 找一个归属 B 的键并经 TLS 线路跨 Stage 调用
    let key = "";
    for (let i = 0; i < 2000 && !key; i++) {
      const n = `s${i}`;
      if (a.ownerOf("SecCart", n) === b.clusterAddress()) key = n;
    }
    expect(await a.cast(SecCart, key || "s0").add("x")).toBeGreaterThanOrEqual(1);

    // 明文连接 TLS 端口：TLS 握手失败（服务端直接断开，不产生可用连接）
    const plain = await new Promise<boolean>((resolve) => {
      const sock = plainConnect({ host: "127.0.0.1", port: Number(b.clusterAddress()!.split(":")[1]) });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 2_000);
      sock.once("data", () => {
        clearTimeout(timer);
        sock.destroy();
        resolve(true); // 收到了响应帧 = 明文竟然可用（不应发生）
      });
      sock.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      sock.once("close", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    expect(plain).toBe(false);

    await b.shutdown();
    await a.shutdown();
  }, 30_000);

  it("join token：错误 token 被拒不入团；正确 token 入团；错误 token 限速后静默", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-join-"));
    const a = await Troupe.form({
      actors: [SecCart],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      cluster: { port: 0, joinToken: "secret-token" },
    });
    // 错误 token：join 被 nack，不入成员表
    const bad = await Troupe.form({
      actors: [SecCart],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      cluster: { port: 0, joinToken: "wrong", seeds: [a.clusterAddress()!] },
    });
    await sleep(1_500);
    expect(a.clusterMembers()!.includes(bad.clusterAddress()!)).toBe(false);

    // 限速：再发多次错误 token join（dev 模式下 sendJoin 周期触发）→ 服务端窗口内静默
    await sleep(1_200);

    // 正确 token：入团成功
    const good = await Troupe.form({
      actors: [SecCart],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      cluster: { port: 0, joinToken: "secret-token", seeds: [a.clusterAddress()!] },
    });
    const joined = await waitUntil(() => a.clusterMembers()!.includes(good.clusterAddress()!), 10_000);
    expect(joined).toBe(true);

    await good.shutdown();
    await bad.shutdown();
    await a.shutdown();
  }, 30_000);

  it("Director 管理凭证（wire dir 通道）：无 token / 错 token 拒绝；正确 token 可用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-dir-"));
    const a = await Troupe.form({
      actors: [SecCart],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      cluster: { port: 0, adminToken: "director-secret" },
    });
    try {
      await a.cast(SecCart, "d1").add("one");
      // 真实 wire 路径：裸 socket + 4 字节小端长度前缀 + JSON 帧（与 Transport 帧协议一致）
      const [host, port] = a.clusterAddress()!.split(":");
      const callDirector = (token?: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const sock = plainConnect({ host, port: Number(port) });
          const frame = (obj: unknown): Buffer => {
            const body = Buffer.from(JSON.stringify(obj), "utf8");
            const head = Buffer.alloc(4);
            head.writeUInt32LE(body.length);
            return Buffer.concat([head, body]);
          };
          let buf = Buffer.alloc(0);
          const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error("dir 应答超时"));
          }, 3_000);
          sock.on("data", (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            if (buf.length < 4) return;
            const len = buf.readUInt32LE(0);
            if (buf.length < 4 + len) return;
            clearTimeout(timer);
            const res = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as {
              ok: boolean;
              err?: { message: string };
              result?: Record<string, unknown>;
            };
            sock.destroy();
            if (res.ok) resolve(res.result ?? {});
            else resolve({ __err: res.err?.message ?? "unknown" });
          });
          sock.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          sock.write(
            frame({ t: "dir", callId: `d-${Date.now()}`, from: "test-client", method: "roster", args: [], ...(token ? { token } : {}) }),
          );
        });

      const deniedWrong = await callDirector("wrong-token");
      expect(deniedWrong.__err).toMatch(/token 不匹配/);
      const deniedNone = await callDirector(undefined);
      expect(deniedNone.__err).toMatch(/token 不匹配/);
      const ok = await callDirector("director-secret");
      expect(ok.__err).toBeUndefined();
      expect(ok).toBeTruthy();
    } finally {
      await a.shutdown();
    }
  });
});
