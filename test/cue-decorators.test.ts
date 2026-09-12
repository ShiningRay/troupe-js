import { describe, expect, it } from "vitest";
import { nextCronTime, parseCronExpression } from "../src/cues/cron.js";
import { Actor, Cron, Every, Local, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { InMemoryCueStore } from "../src/cues/memory.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 6_000, stepMs = 25): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

describe("M4+：cron 解析器（5 字段，本地时间）", () => {
  it("标准向量：日常/步进/跨月/周日/每分钟", () => {
    const at = (y: number, mo: number, d: number, h: number, mi: number) =>
      new Date(y, mo - 1, d, h, mi).getTime();
    const next = (expr: string, from: number) =>
      nextCronTime(parseCronExpression(expr), from)!;

    expect(new Date(next("0 9 * * *", at(2026, 9, 13, 10, 0))).getDate()).toBe(14); // 过点 → 明天
    expect(new Date(next("0 9 * * *", at(2026, 9, 13, 8, 0))).getHours()).toBe(9); // 未到 → 当天
    expect(new Date(next("*/15 * * * *", at(2026, 9, 13, 10, 7))).getMinutes()).toBe(15);
    const monthly = new Date(next("30 14 1 * *", at(2026, 9, 2, 0, 0)));
    expect(monthly.getMonth()).toBe(9); // 10 月
    expect(monthly.getDate()).toBe(1);
    expect(new Date(next("0 0 * * 0", at(2026, 9, 13, 0, 0))).getDate()).toBe(20); // 9/13 周日 → 下周日
    expect(new Date(next("* * * * *", at(2026, 9, 13, 10, 30))).getMinutes()).toBe(31);
  });

  it("非法表达式装饰期/解析期报错", () => {
    expect(() => parseCronExpression("61 * * * *")).toThrow(/bounds/);
    expect(() => parseCronExpression("* * *")).toThrow(/5 fields/);
    expect(() => parseCronExpression("a * * * *")).toThrow(/invalid/);
  });
});

let everyRuns = 0;
let localRuns = 0;
let manualTrigger = 0;

/** 只含 @Local（内存 Cue 不依赖 CueStore，无需 cues 选项） */
class LocalOnlyActor extends Actor<Record<string, never>> {
  static role = "LocalOnly";
  static initialProps = () => ({}) as Record<string, never>;

  @Local(60)
  async heartbeat() {
    localRuns++;
  }

  async trigger() {
    return "ok";
  }
}

class ReportActor extends Actor<{ n: number }> {
  static role = "Report";
  static initialProps = () => ({ n: 0 });

  @Every(80)
  async sweep() {
    everyRuns++;
    this.props.n++;
    await this.saveProps();
  }

  @Cron("30 3 * * *")
  async nightly() {
    // 凌晨 03:30——测试只验证登记，不等待触发
    everyRuns += 0;
  }

  @Local(60)
  async heartbeat() {
    localRuns++;
  }

  async trigger() {
    manualTrigger++;
    return "manual";
  }
}

describe("M4+：声明式 Cue 装饰器（@Cron/@Every/@Local）", () => {
  it("@Every 激活即自动登记并周期触发（ensure 不重置已排期）", async () => {
    everyRuns = 0;
    const store = new InMemoryCueStore();
    const troupe = await Troupe.form({
      actors: [ReportActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cues: { store, tickMs: 50 },
    });
    await troupe.cast(ReportActor, "r1").trigger(); // 激活 → 声明式提醒自动登记
    const ok = await waitUntil(() => everyRuns >= 3, 5_000);
    expect(ok).toBe(true);

    const cues = (await troupe.director().cues()) as Array<{ name: string; everyMs: number | null }>;
    expect(cues.find((c) => c.name === "sweep")?.everyMs).toBe(80);
    await troupe.shutdown();
  });

  it("@Cron 登记 nextDue 正确（按表达式计算，不等待真实触发）", async () => {
    const troupe = await Troupe.form({
      actors: [ReportActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cues: { store: new InMemoryCueStore(), tickMs: 1_000_000 },
    });
    await troupe.cast(ReportActor, "r2").trigger();
    const cues = (await troupe.director().cues()) as Array<{ name: string; nextDue: string }>;
    const nightly = cues.find((c) => c.name === "nightly")!;
    const due = new Date(nightly.nextDue);
    expect(due.getHours()).toBe(3);
    expect(due.getMinutes()).toBe(30);
    await troupe.shutdown();
  });

  it("@Local 仅在场时触发（内存 Cue，随下场清理；无需 cues 选项）", async () => {
    localRuns = 0;
    const troupe = await Troupe.form({
      actors: [LocalOnlyActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 120,
    });
    await troupe.cast(LocalOnlyActor, "r3").trigger();
    await waitUntil(() => localRuns >= 3, 5_000);
    await troupe.off("LocalOnly", "r3");
    const at = localRuns;
    await sleep(300);
    expect(localRuns).toBe(at); // 下场后停止
    await troupe.shutdown();
  });

  it("装饰的方法仍可经 RPC 手动触发（CLI/Booth 调试通道）", async () => {
    everyRuns = 0;
    const troupe = await Troupe.form({
      actors: [ReportActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cues: { store: new InMemoryCueStore(), tickMs: 1_000_000 },
    });
    expect(await troupe.cast(ReportActor, "r4").sweep()).toBeUndefined();
    expect(everyRuns).toBe(1);
    await troupe.shutdown();
  });

  it("ensure 语义：重复激活不重置 nextDue（upsert 才重置）", async () => {
    const store = new InMemoryCueStore();
    await store.upsert({
      namespace: "default", roleId: "Report", stageName: "r5", name: "sweep",
      payload: null, everyMs: 60_000, at: null, cron: null, nextDue: 12345,
    });
    await store.ensure({
      namespace: "default", roleId: "Report", stageName: "r5", name: "sweep",
      payload: null, everyMs: 80, at: null, cron: null, nextDue: 99999,
    });
    const rec = (await store.list("default"))[0];
    expect(rec.nextDue).toBe(12345); // ensure 不覆盖
    expect(rec.everyMs).toBe(60_000);
  });

  it("使用 @Cron/@Every 但未启用 cues → 显式报错", async () => {
    await expect(
      Troupe.form({ actors: [ReportActor], propStore: new InMemoryPropStore(), defaultIntermission: 0 }),
    ).rejects.toThrow(/cues: true/);
  });
});
