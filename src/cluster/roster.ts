import { HashRing } from "./hash-ring.js";
import type { WireMember, WireMessage } from "./transport.js";

/**
 * Roster 硬化版（DESIGN §6.2，M3）：
 * - 传播（gossip 反熵）：全量成员表，合并规则单调——incarnation 大者胜；
 *   同 incarnation 下 dead > suspect > alive（第三方 alive 不复活已判死成员）
 * - 探测（直接 ping + ACK）：环序 2 个后继；连续 missLimit 个周期无 ACK → suspect，
 *   再等 missLimit 个周期 → confirmed dead → 摘环
 * - 重启/反驳身份：dead 只能以更高 incarnation 复活；节点发现自身被标 suspect/dead 时
 *   抬升 incarnation 重新入团（反驳）——暂停后恢复的旧身份（同 inc）不得复活，M3 核心语义
 * - 死亡记录过期清理时保留墓碑（incarnation），旧身份不得借清理窗口复活
 */
export interface RosterOptions {
  probeIntervalMs: number;
  missLimit: number;
  staleMs: number;
  deadTtlMs: number;
  protocolVersion: number;
}

interface MemberState {
  addr: string;
  incarnation: number;
  state: "alive" | "suspect" | "dead";
  lastSeen: number;
  lastAck: number;
}

const DEFAULTS: RosterOptions = {
  probeIntervalMs: 1_000,
  missLimit: 3,
  staleMs: 15_000,
  deadTtlMs: 60_000,
  protocolVersion: 2,
};

const STATE_RANK: Record<MemberState["state"], number> = { alive: 0, suspect: 1, dead: 2 };

export class Roster {
  private members = new Map<string, MemberState>();
  /** 死亡记录过期清理后的墓碑：addr → 已清理记录的 incarnation。只有更高 incarnation 可重新入册 */
  private tombstones = new Map<string, number>();
  private ring: HashRing;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: RosterOptions;
  /** 当前身份（启动时为时间戳；被误判死亡时抬升反驳，M3） */
  private selfInc = Date.now();
  get selfIncarnation(): number {
    return this.selfInc;
  }
  private pendingJoins = new Map<
    string,
    { resolve: (ok: true) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  onMembersChanged?: (alive: string[]) => void;

  constructor(
    private readonly selfAddr: string,
    private readonly send: (addr: string, msg: WireMessage) => Promise<void>,
    private readonly roleIds: string[],
    opts: Partial<RosterOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.ring = new HashRing([selfAddr]);
  }

  /**
   * 启动。strictJoin=true（production）：至少一个 seed 必须在超时内
   * 完成 join 握手（收到 roster 应答），否则 reject——生产不允许静默自成一团。
   */
  async start(seeds: string[], strictJoin = false): Promise<void> {
    this.timer = setInterval(() => void this.tick(), this.opts.probeIntervalMs);
    this.timer.unref?.();
    if (seeds.length === 0) {
      if (strictJoin) {
        throw new Error("production 模式必须配置 seeds（显式要求入团，§6.2）");
      }
      return;
    }
    const attempts = seeds.filter((s) => s !== this.selfAddr);
    if (!strictJoin) {
      for (const seed of attempts) {
        void this.sendJoin(seed).catch((e) => {
          console.warn(
            `[troupe] seed 不可达：${seed}（${e instanceof Error ? e.message : String(e)}）——dev 下自成一团继续运行（§8.5）`,
          );
        });
      }
      return;
    }
    const results = await Promise.allSettled(attempts.map((seed) => this.sendJoin(seed, 4_000)));
    if (results.every((r) => r.status === "rejected")) {
      throw new Error(
        `production 模式入团失败：所有 seeds 不可达（${attempts.join(", ")}）——显式要求入团（§6.2）`,
      );
    }
  }

  private sendJoin(seed: string, timeoutMs?: number): Promise<true> {
    return new Promise<true>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJoins.delete(seed);
        reject(new Error(`join ${seed} 超时（${timeoutMs ?? 0}ms）`));
      }, timeoutMs ?? 3_000);
      timer.unref?.();
      this.pendingJoins.set(seed, { resolve, reject, timer });
      void this.send(seed, {
        t: "join",
        from: this.selfAddr,
        inc: this.selfIncarnation,
        protocol: this.opts.protocolVersion,
        roles: this.roleIds,
      }).catch((e) => {
        clearTimeout(timer);
        this.pendingJoins.delete(seed);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /** 成员消息处理（非 Call） */
  handle(msg: WireMessage, reply: (m: WireMessage) => void): void {
    switch (msg.t) {
      case "join": {
        const production = this.strictJoinFlag;
        this.touch(msg.from, msg.inc);
        if (msg.protocol !== this.opts.protocolVersion) {
          reply({ t: "join-nack", from: this.selfAddr, reason: `协议版本不一致：对方=${msg.protocol} 本地=${this.opts.protocolVersion}（§6.2）` });
          return;
        }
        if (production && msg.roles.length > 0 && !sameSet(msg.roles, this.roleIds)) {
          reply({ t: "join-nack", from: this.selfAddr, reason: `角色集合不一致：对方=${msg.roles.join(",")} 本地=${this.roleIds.join(",")}（production 拒绝，§3.2/§6.2）` });
          return;
        }
        if (!production && msg.roles.length > 0 && !sameSet(msg.roles, this.roleIds)) {
          console.warn(`[troupe] 角色集合不一致（dev 仅警告）：${msg.from}=${msg.roles.join(",")}，本地=${this.roleIds.join(",")}`);
        }
        reply(this.rosterMsg());
        return;
      }
      case "join-nack": {
        console.warn(`[troupe] 入团被拒：${msg.reason}`);
        const pending = this.pendingJoins.get(msg.from);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingJoins.delete(msg.from);
          pending.reject(new Error(msg.reason));
        }
        return;
      }
      case "roster": {
        this.touch(msg.from, msg.inc);
        // 反驳规则（§6.2）：被误判者发现自身被判 suspect/dead → 抬升 incarnation 并重新广播身份
        const selfView = msg.members.find((x) => x.addr === this.selfAddr);
        if (
          selfView &&
          (selfView.state === "suspect" || selfView.state === "dead") &&
          selfView.incarnation >= this.selfInc
        ) {
          this.selfInc = Math.max(this.selfInc, selfView.incarnation) + 1;
          console.warn(
            `[troupe] 检测到自身被标记为 ${selfView.state}：抬升 incarnation=${this.selfInc} 反驳并重新入团`,
          );
          void this.send(msg.from, {
            t: "join", from: this.selfAddr, inc: this.selfInc,
            protocol: this.opts.protocolVersion, roles: this.roleIds,
          }).catch(() => {});
        }
        const pending = this.pendingJoins.get(msg.from);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingJoins.delete(msg.from);
          pending.resolve(true); // production 严格入团：握手完成
        }
        this.merge(msg.members);
        return;
      }
      case "ping":
        this.touch(msg.from, msg.inc);
        reply({ t: "ack", from: this.selfAddr, inc: this.selfIncarnation });
        return;
      case "ack": {
        const m = this.touch(msg.from, msg.inc);
        if (m) m.lastAck = Date.now();
        return;
      }
      case "leave":
        this.markDead(msg.from, msg.inc, "主动离开");
        return;
      default:
        return;
    }
  }

  /** production 严格入团/角色校验开关（由 Cluster 注入） */
  strictJoinFlag = false;

  /** 非死亡成员（alive+suspect 保持路由可达；dead 摘环） */
  aliveMembers(): string[] {
    return [...this.members.values()].filter((m) => m.state !== "dead").map((m) => m.addr);
  }

  /** 停止；announce=true 时广播 leave（优雅停机） */
  async stop(announce: boolean): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [, p] of this.pendingJoins) {
      clearTimeout(p.timer);
      p.reject(new Error("roster 已停止"));
    }
    this.pendingJoins.clear();
    if (announce) {
      await Promise.allSettled(
        this.aliveMembers().map((addr) =>
          this.send(addr, { t: "leave", from: this.selfAddr, inc: this.selfIncarnation }),
        ),
      );
    }
  }

  private rosterMsg(): WireMessage {
    // 必须包含自身：joiner 靠这份快照认识种子（§6.2）
    const members: WireMember[] = [
      { addr: this.selfAddr, incarnation: this.selfIncarnation, state: "alive" as const },
      ...[...this.members.values()].map((m) => ({
        addr: m.addr,
        incarnation: m.incarnation,
        state: m.state,
      })),
    ];
    return { t: "roster", from: this.selfAddr, inc: this.selfIncarnation, members };
  }

  /**
   * 直接通信证据：
   * - 未知成员 → 入册 alive（须高于墓碑/已死记录的 incarnation）
   * - 更高 incarnation → 重启的新身份：复活并更新 incarnation
   * - 同 incarnation → 复活（suspect/dead 被直接接触反驳）
   * - 更低 incarnation → 忽略：暂停后恢复的旧身份不得复活、不刷新 lastSeen（M3）
   * 返回 null 表示被墓碑/旧身份规则拒绝。
   */
  private touch(addr: string, inc: number): MemberState | null {
    let m = this.members.get(addr);
    const now = Date.now();
    if (!m) {
      const tomb = this.tombstones.get(addr);
      if (tomb !== undefined && inc <= tomb) return null; // 旧身份：拒绝入册
      m = { addr, incarnation: inc, state: "alive", lastSeen: now, lastAck: now };
      this.members.set(addr, m);
      this.rebuild();
      return m;
    }
    if (inc > m.incarnation) {
      m.incarnation = inc;
      m.state = "alive";
      m.lastSeen = now;
      m.lastAck = now;
      this.rebuild();
      return m;
    }
    if (inc < m.incarnation) {
      return null; // 旧 incarnation：忽略（不复活、不续期）
    }
    if (m.state === "dead") {
      return null; // dead 只能以更高 incarnation 复活（重启/反驳）；同 inc 直接接触不复活
    }
    m.lastSeen = now;
    if (m.state !== "alive") {
      m.state = "alive"; // suspect 被直接接触反驳
      this.rebuild();
    }
    return m;
  }

  /** 反熵合并（单调）：inc 高者胜；同 inc 下更差状态胜（第三方 alive 不复活） */
  private merge(list: WireMember[]): void {
    let changed = false;
    for (const wire of list) {
      if (wire.addr === this.selfAddr) continue;
      const existing = this.members.get(wire.addr);
      if (!existing) {
        const tomb = this.tombstones.get(wire.addr);
        if (tomb !== undefined && wire.incarnation <= tomb) continue; // 墓碑：旧身份不复活
        this.members.set(wire.addr, {
          addr: wire.addr,
          incarnation: wire.incarnation,
          state: wire.state,
          lastSeen: Date.now(),
          lastAck: Date.now(),
        });
        changed = true;
        continue;
      }
      if (wire.incarnation > existing.incarnation) {
        existing.incarnation = wire.incarnation;
        existing.state = wire.state;
        existing.lastSeen = Date.now();
        existing.lastAck = Date.now();
        changed = true;
        continue;
      }
      if (wire.incarnation === existing.incarnation && STATE_RANK[wire.state] > STATE_RANK[existing.state]) {
        existing.state = wire.state;
        changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  private markDead(addr: string, inc: number, why: string): void {
    const m = this.members.get(addr);
    if (!m || (inc !== undefined && inc < m.incarnation)) return; // 旧身份的 leave 不影响新记录
    if (m.state === "dead") return;
    m.state = "dead";
    m.lastSeen = Date.now();
    console.warn(`[troupe] 成员判死：${addr}#${m.incarnation}（${why}，摘除出环）`);
    this.rebuild();
  }

  private tick(): void {
    const now = Date.now();
    const successors = this.ring.successors(this.selfAddr, 2);
    for (const addr of successors) {
      void this.send(addr, { t: "ping", from: this.selfAddr, inc: this.selfIncarnation }).catch(() => {});
    }
    const gossipTargets = this.aliveMembers();
    if (gossipTargets.length > 0) {
      const partner = gossipTargets[Math.floor(Math.random() * gossipTargets.length)];
      void this.send(partner, this.rosterMsg()).catch(() => {});
    }
    let changed = false;
    for (const m of [...this.members.values()]) {
      if (m.state === "alive") {
        const threshold = successors.includes(m.addr)
          ? this.opts.missLimit * this.opts.probeIntervalMs
          : this.opts.staleMs;
        if (now - m.lastAck >= threshold && now - m.lastSeen >= threshold) {
          m.state = "suspect";
          changed = true;
          console.warn(`[troupe] 成员 suspect：${m.addr}#${m.incarnation}（${successors.includes(m.addr) ? "后继探测无 ACK" : "长期无直接通信"}）`);
        }
      } else if (m.state === "suspect") {
        const threshold = successors.includes(m.addr)
          ? this.opts.missLimit * this.opts.probeIntervalMs
          : this.opts.staleMs;
        if (now - m.lastAck >= 2 * threshold && now - m.lastSeen >= 2 * threshold) {
          m.state = "dead";
          changed = true;
          console.warn(`[troupe] 成员判死：${m.addr}#${m.incarnation}（suspect 超时未反驳，摘除出环）`);
        }
      } else if (now - m.lastSeen > this.opts.deadTtlMs) {
        // 死亡记录过期：留墓碑（记录 incarnation），旧身份不得借清理窗口复活
        if ((this.tombstones.get(m.addr) ?? 0) < m.incarnation) {
          this.tombstones.set(m.addr, m.incarnation);
        }
        this.members.delete(m.addr);
      }
    }
    if (changed) this.rebuild();
  }

  private rebuild(): void {
    this.ring = new HashRing([this.selfAddr, ...this.aliveMembers()]);
    this.onMembersChanged?.([this.selfAddr, ...this.aliveMembers()]);
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
