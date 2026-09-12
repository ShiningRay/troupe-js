import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";

class PanelCartActor extends Actor<{ items: string[] }> {
  static role = "PanelCart";
  static initialProps = () => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }
}

describe("Booth 预览版（内省面板，PLAN M9 提前交付极简版）", () => {
  it("GET / 返回单文件页面；/api/overview 汇报 Stage/Actor/指标/事件", async () => {
    const troupe = await Troupe.form({
      actors: [PanelCartActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
    });
    const base = troupe.boothAddress()!;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("Troupe Booth");

    await troupe.cast(PanelCartActor, "u1").add("x");
    const overview = (await (await fetch(`${base}/api/overview`)).json()) as {
      stage: { pid: number };
      members: string[];
      actors: Array<{ roleId: string; stageName: string; state: string; revision: number }>;
      metrics: Record<string, { calls: number }>;
      events: Array<{ type: string }>;
    };
    expect(overview.stage.pid).toBe(process.pid);
    expect(overview.members.length).toBeGreaterThan(0);
    expect(overview.actors).toHaveLength(1);
    expect(overview.actors[0]).toMatchObject({ roleId: "PanelCart", stageName: "u1", state: "running" });
    expect(overview.actors[0].revision).toBe(1);
    expect(overview.metrics["PanelCart"].calls).toBe(1);
    expect(overview.events.some((e) => e.type === "turnStarted")).toBe(true);

    await troupe.shutdown();
  });

  it("POST /api/call：白名单内调用返回结果；白名单外 400", async () => {
    const troupe = await Troupe.form({
      actors: [PanelCartActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
    });
    const base = troupe.boothAddress()!;

    const ok = await (
      await fetch(`${base}/api/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId: "PanelCart", stageName: "u1", method: "add", args: ["a"] }),
      })
    ).json();
    expect(ok).toMatchObject({ ok: true, result: 1 });

    const wl = await fetch(`${base}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: "PanelCart", stageName: "u1", method: "saveProps", args: [] }),
    });
    expect(wl.status).toBe(400);
    expect(((await wl.json()) as { error: string }).error).toMatch(/白名单/);

    const unknown = await fetch(`${base}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: "Nope", stageName: "u1", method: "x", args: [] }),
    });
    expect(unknown.status).toBe(400);

    await troupe.shutdown();
  });

  it("POST /api/off：强制下场后 Actor 从面板消失；shutdown 后面板关闭", async () => {
    const troupe = await Troupe.form({
      actors: [PanelCartActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
    });
    const base = troupe.boothAddress()!;
    await troupe.cast(PanelCartActor, "u1").add("x");
    expect(troupe.slots().length).toBe(1);

    const off = await (
      await fetch(`${base}/api/off`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId: "PanelCart", stageName: "u1" }),
      })
    ).json();
    expect(off).toMatchObject({ ok: true });
    expect(troupe.slots().length).toBe(0);

    await troupe.shutdown();
    const after = await fetch(`${base}/api/overview`).catch((e) => e);
    expect(after).toBeInstanceOf(Error); // 服务已随 shutdown 关闭
  });

  it("GET /api/stream：SSE 实时推送——连接即收快照，事件触发后自动更新", async () => {
    const troupe = await Troupe.form({
      actors: [PanelCartActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      booth: { port: 0 },
    });
    const base = troupe.boothAddress()!;
    const res = await fetch(`${base}/api/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const snapshots: Array<{ actors?: Array<{ roleId: string }> }> = [];

    async function pump(ms: number): Promise<void> {
      const deadline = Date.now() + ms;
      for (;;) {
        const remain = deadline - Date.now();
        if (remain <= 0) return;
        const chunk = (await Promise.race([
          reader.read(),
          new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), remain)),
        ])) as { done: boolean; value?: Uint8Array };
        if (chunk.done) return;
        buf += decoder.decode(chunk.value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) {
            try {
              snapshots.push(JSON.parse(dataLine.slice(6)));
            } catch {
              // 忽略坏帧
            }
          }
        }
      }
    }

    await pump(500); // 连接即推当前快照
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const countBefore = snapshots.length;
    await troupe.cast(PanelCartActor, "sse-1").add("x");
    await pump(1_500); // 事件驱动推送（~250ms 合并）+ 1s 保活帧

    expect(snapshots.length).toBeGreaterThan(countBefore); // 无轮询，靠事件推进
    expect(snapshots.some((s) => (s.actors ?? []).some((a) => a.roleId === "PanelCart"))).toBe(true);

    await reader.cancel().catch(() => {});
    await troupe.shutdown();
  }, 10_000);
});
