import { describe, expect, it } from "vitest";
import { Roster } from "../src/cluster/roster.js";
import type { WireMessage } from "../src/cluster/transport.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noopReply = (_m: WireMessage) => {};

function mkRoster(): Roster {
  // 小窗口真实定时器：missLimit 2 × 50ms = suspect ~100ms；dead ~200ms+
  return new Roster("10.0.0.1:1000", async () => {}, ["Cart"], {
    probeIntervalMs: 50,
    missLimit: 2,
    staleMs: 150,
    deadTtlMs: 300,
    protocolVersion: 2,
  });
}

describe("M3 验收：Roster 硬化（DESIGN §6.2）", () => {
  it("后继探测两阶段：alive → suspect → dead；死亡后摘环", async () => {
    const r = mkRoster();
    await r.start([]);
    const member = "10.0.0.2:2000";
    r.handle({ t: "join", from: member, inc: 100, protocol: 2, roles: ["Cart"] }, noopReply);
    expect(r.aliveMembers()).toContain(member);

    await sleep(180); // 无 ACK → suspect（不摘环）
    expect(r.aliveMembers()).toContain(member);

    await sleep(250); // 继续 miss → dead
    expect(r.aliveMembers()).not.toContain(member);
    await r.stop(false);
  });

  it("dead 只能以更高 incarnation 复活：旧身份/同 inc（暂停恢复）均不得复活", async () => {
    const r = mkRoster();
    await r.start([]);
    const member = "10.0.0.2:2000";
    r.handle({ t: "join", from: member, inc: 500, protocol: 2, roles: [] }, noopReply);
    await sleep(430); // 判死（记录 incarnation=500）
    expect(r.aliveMembers()).not.toContain(member);

    // 旧身份（inc 100 < 500，如重启前的旧进程仍在发包）：不得复活
    r.handle({ t: "ping", from: member, inc: 100 }, noopReply);
    expect(r.aliveMembers()).not.toContain(member);

    // 同 incarnation（暂停后恢复的旧身份）：同样不得复活
    r.handle({ t: "ping", from: member, inc: 500 }, noopReply);
    expect(r.aliveMembers()).not.toContain(member);

    // 更高 incarnation（重启/反驳后的新身份）：复活
    r.handle({ t: "ping", from: member, inc: 600 }, noopReply);
    expect(r.aliveMembers()).toContain(member);
    await r.stop(false);
  });

  it("反驳规则：节点发现自身被标 dead → 抬升 incarnation 并重新 join", async () => {
    const sent: WireMessage[] = [];
    const wire = new Roster("10.0.0.2:2000", async (_a, m) => { sent.push(m); }, ["Cart"], {
      probeIntervalMs: 50, missLimit: 2, staleMs: 150, deadTtlMs: 300, protocolVersion: 2,
    });
    await wire.start([]);
    const before = wire.selfIncarnation;
    // 收到对端视角：自己已被判 dead（inc = before）
    wire.handle(
      {
        t: "roster", from: "10.0.0.1:1000", inc: 1,
        members: [{ addr: "10.0.0.2:2000", incarnation: before, state: "dead" }],
      },
      noopReply,
    );
    await sleep(100); // 反驳 join 异步发出
    expect(wire.selfIncarnation).toBeGreaterThan(before); // 身份抬升
    const join = sent.find((m) => m.t === "join") as { t: "join"; inc: number } | undefined;
    expect(join?.inc).toBeGreaterThan(before); // 以更高 incarnation 重新入团
    await wire.stop(false);
  });

  it("重启身份：更高 incarnation 复活并接管成员记录", async () => {
    const r = mkRoster();
    await r.start([]);
    const member = "10.0.0.2:2000";
    r.handle({ t: "join", from: member, inc: 100, protocol: 2, roles: [] }, noopReply);
    await sleep(430); // 判死（inc 100）
    expect(r.aliveMembers()).not.toContain(member);

    // 重启：新 incarnation 直接消息 → 复活
    r.handle({ t: "ping", from: member, inc: 999 }, noopReply);
    expect(r.aliveMembers()).toContain(member);

    // 旧 incarnation 的 leave 不影响新记录
    r.handle({ t: "leave", from: member, inc: 100 }, noopReply);
    expect(r.aliveMembers()).toContain(member);
    // 新 incarnation 的 leave 生效
    r.handle({ t: "leave", from: member, inc: 999 }, noopReply);
    expect(r.aliveMembers()).not.toContain(member);
    await r.stop(false);
  });

  it("反熵合并且单调：第三方 alive 不复活同 inc 已死成员；更高 inc 采信", async () => {
    const r = mkRoster();
    await r.start([]);
    const dead1 = "10.0.0.2:2000";
    const peer = "10.0.0.3:3000";
    r.handle({ t: "join", from: dead1, inc: 100, protocol: 2, roles: [] }, noopReply);
    await sleep(430);
    expect(r.aliveMembers()).not.toContain(dead1);

    // 第三方 gossip 声称它 alive（同 inc）：不得复活（单调）
    r.handle(
      { t: "roster", from: peer, inc: 1, members: [{ addr: dead1, incarnation: 100, state: "alive" }] },
      noopReply,
    );
    expect(r.aliveMembers()).not.toContain(dead1);

    // 第三方带来更高 incarnation：采信为 alive（重启）
    r.handle(
      { t: "roster", from: peer, inc: 1, members: [{ addr: dead1, incarnation: 500, state: "alive" }] },
      noopReply,
    );
    expect(r.aliveMembers()).toContain(dead1);

    // 乱序/重复投递不破坏收敛：重放旧状态无效果
    r.handle(
      { t: "roster", from: peer, inc: 1, members: [{ addr: dead1, incarnation: 100, state: "dead" }] },
      noopReply,
    );
    expect(r.aliveMembers()).toContain(dead1);
    await r.stop(false);
  });
});
