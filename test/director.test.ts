import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Actor, Troupe, Transport, type WireMessage } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { InMemoryCueStore } from "../src/cues/memory.js";

const noop = (_m: WireMessage, _r: (m: WireMessage) => void) => {};

class DirCartActor extends Actor<{ items: string[] }> {
  static role = "DirCart";
  static initialProps = () => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }

  async arm(name: string) {
    await this.scheduleReminder(name, { every: 60_000, payload: { k: 1 } });
    return true;
  }
}

async function mkTroupe(withCluster: boolean, cueStore?: InMemoryCueStore) {
  return Troupe.form({
    actors: [DirCartActor],
    propStore: new InMemoryPropStore(),
    defaultIntermission: 0,
    ...(cueStore ? { cues: { store: cueStore, tickMs: 1_000_000 } } : {}),
    ...(withCluster ? { cluster: { port: 0 } } : {}),
  });
}

async function dirRequest(
  addr: string,
  method: string,
  args: unknown[],
  token?: string,
): Promise<{ ok: boolean; result?: unknown; err?: { kind: string; reason?: string; message: string } }> {
  const client = new Transport(noop);
  try {
    const id = randomUUID();
    const res = (await client.request(
      addr,
      { t: "dir", callId: id, from: "test", method, args, ...(token ? { token } : {}) },
      id,
      5_000,
    )) as { ok: boolean; result?: unknown; err?: { kind: string; reason?: string; message: string } };
    return res;
  } finally {
    client.destroy();
  }
}

describe("M4 验收：Director 系统角色（DESIGN §11.1）", () => {
  it("本地门面：roster/actors/inspect/invoke 白名单/off/cues", async () => {
    const cues = new InMemoryCueStore();
    const troupe = await mkTroupe(false, cues);
    const dir = troupe.director();

    const roster = (await dir.roster()) as { self: string; members: string[]; roles: string[] };
    expect(roster.roles).toContain("DirCart");
    expect(roster.members.length).toBe(1);

    await troupe.cast(DirCartActor, "u1").add("x");
    const actors = (await dir.actors()) as Array<{ roleId: string; state: string }>;
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({ roleId: "DirCart", state: "running" });

    const inspect = (await dir.inspect("DirCart", "u1")) as {
      committed: { props: { items: string[] }; revision: number };
    };
    expect(inspect.committed.props).toEqual({ items: ["x"] });
    expect(inspect.committed.revision).toBe(1);

    expect(await dir.invoke("DirCart", "u1", "add", ["y"])).toBe(2);
    const wl = await dir.invoke("DirCart", "u1", "saveProps", []).catch((e) => e);
    expect((wl as Error).message).toMatch(/白名单/);

    await troupe.cast(DirCartActor, "u1").arm("beat");
    const cuesList = (await dir.cues()) as Array<{ name: string; everyMs: number }>;
    expect(cuesList).toHaveLength(1);
    expect(cuesList[0]).toMatchObject({ name: "beat", everyMs: 60_000 });

    await dir.off("DirCart", "u1");
    expect(troupe.slots().length).toBe(0);
    await troupe.shutdown();
  });

  it("wire 通道（CLI 路径）：dir 消息经 cluster 边缘；未知方法拒绝", async () => {
    const troupe = await mkTroupe(true);
    const addr = troupe.clusterAddress()!;
    const ok = await dirRequest(addr, "roster", []);
    expect(ok.ok).toBe(true);
    expect((ok.result as { roles: string[] }).roles).toContain("DirCart");

    const bad = await dirRequest(addr, "nope", []);
    expect(bad.ok).toBe(false);
    expect(bad.err!.message).toMatch(/未知 Director 方法/);

    const invoke = await dirRequest(addr, "invoke", ["DirCart", "w1", "add", ["a"]]);
    expect(invoke.ok).toBe(true);
    expect(invoke.result).toBe(1);
    await troupe.shutdown();
  });

  it("TROUPE_ADMIN_TOKEN：无/错 token 拒绝，正确 token 放行（§11.1）", async () => {
    const prev = process.env.TROUPE_ADMIN_TOKEN;
    process.env.TROUPE_ADMIN_TOKEN = "s3cret";
    try {
      const troupe = await mkTroupe(true);
      const addr = troupe.clusterAddress()!;
      const noToken = await dirRequest(addr, "roster", []);
      expect(noToken.ok).toBe(false);
      expect(noToken.err!.message).toMatch(/token/);

      const wrong = await dirRequest(addr, "roster", [], "wrong");
      expect(wrong.ok).toBe(false);

      const right = await dirRequest(addr, "roster", [], "s3cret");
      expect(right.ok).toBe(true);
      await troupe.shutdown();
    } finally {
      if (prev === undefined) delete process.env.TROUPE_ADMIN_TOKEN;
      else process.env.TROUPE_ADMIN_TOKEN = prev;
    }
  });
});

describe("M4 验收：Booth /healthz 与 /metrics（DESIGN §11.4）", () => {
  it("healthz 返回健康快照；metrics 输出 Prometheus 文本", async () => {
    const troupe = await Troupe.form({
      actors: [DirCartActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
    });
    await troupe.cast(DirCartActor, "h1").add("x");
    const base = troupe.boothAddress()!;

    const hz = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; actors: number };
    expect(hz.ok).toBe(true);
    expect(hz.actors).toBe(1);

    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain("troupe_calls_total");
    expect(metrics).toContain('role="DirCart"');
    expect(metrics).toContain('quantile="0.99"');
    await troupe.shutdown();
  });
});
