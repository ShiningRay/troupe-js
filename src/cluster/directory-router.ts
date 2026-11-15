import type { DirectoryRecord, DirectoryStore } from "../props/directory.js";

/**
 * 目录路由器（ADR 0004 §3，ROADMAP P1-3）：
 * 缓存 → 目录回源 → claim → 落败重读。环只经 candidates() 参与冷键 claim 发起，
 * 永不直接决定归属；路由决策失败宁可拒绝（可重试），不退回环猜测。
 *
 * 缓存条目携带 version + TTL：TTL 是兜底（默认 min(leaseMs/3, 2s)），
 * 目录变更经 bumpVersion/release 的 version 推进可被外部观测；成员变更由
 * Cluster 调 invalidateAll()。miss 必须回源——"缓存说谁就是谁"不存在。
 */
export interface DirectoryRouterDeps {
  store: DirectoryStore;
  /** 存储命名空间（目录键三元组之一） */
  namespace: string;
  /** 本节点通告地址（路由地址域：ownerId = addr#incarnation 的 addr 部分） */
  selfAddr: string;
  /** claim 用的 Stage 身份（addr#incarnation 全值） */
  selfId: string;
  leaseMs: number;
  /** 环候选序列（按优先级；首候选发起冷键 claim） */
  candidates(roleId: string, stageName: string): string[];
  now(): number;
  /** 缓存 TTL 覆盖（缺省 min(leaseMs/3, 2s)，下限 250ms） */
  ttlMs?: number;
}

interface CacheEntry {
  rec: DirectoryRecord;
  expiresAt: number;
}

export interface RouterStats {
  hits: number;
  misses: number;
  claims: number;
  claimWins: number;
  cacheSize: number;
}

export class DirectoryRouter {
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private claims = 0;
  private claimWins = 0;

  constructor(private readonly deps: DirectoryRouterDeps) {}

  private get ttl(): number {
    return this.deps.ttlMs ?? Math.max(250, Math.min(Math.floor(this.deps.leaseMs / 3), 2_000));
  }

  private static key(roleId: string, stageName: string): string {
    return `${roleId}\u0000${stageName}`;
  }

  /** ownerId（addr#incarnation）→ 路由地址 */
  private static addrOf(rec: DirectoryRecord): string {
    return rec.ownerId.split("#")[0];
  }

  private usable(rec: DirectoryRecord): boolean {
    return rec.status !== "tombstone" && rec.leaseUntil > this.deps.now();
  }

  /**
   * 解析归属：返回 {addr, self}；null = 目录无有效条目且本节点未取得所有权
   * （调用方应按可重试拒绝处理——冷键归属的首候选节点未就绪/存储不可达）。
   */
  async resolveOwner(roleId: string, stageName: string): Promise<{ addr: string; self: boolean } | null> {
    const k = DirectoryRouter.key(roleId, stageName);
    const cached = this.cache.get(k);
    if (cached && cached.expiresAt > this.deps.now() && this.usable(cached.rec)) {
      this.hits++;
      const addr = DirectoryRouter.addrOf(cached.rec);
      return { addr, self: addr === this.deps.selfAddr };
    }
    // miss / 过期 / 失效 → 必须回源（ADR 0004 §3）
    this.misses++;
    this.cache.delete(k);
    const entry = await this.deps.store.lookup(this.deps.namespace, roleId, stageName);
    if (entry && this.usable(entry)) {
      this.cache.set(k, { rec: entry, expiresAt: this.deps.now() + this.ttl });
      const addr = DirectoryRouter.addrOf(entry);
      return { addr, self: addr === this.deps.selfAddr };
    }
    // 无条目 / 过期 / tombstone → 争取所有权（环首候选发起；ADR 0004 §3 冷键）
    this.claims++;
    const cands = this.deps.candidates(roleId, stageName);
    if (cands.length === 0) {
      // 无环视图：无法定进展方向，拒绝可重试
      return null;
    }
    if (cands[0] !== this.deps.selfAddr) {
      // 本节点非首候选：不抢冷键——再读一次（可能已被首候选建立）；
      // 仍无则把 Call 转给首候选，由它 claim（保证路由有进展；首候选死亡 → UnknownOutcome 可重试）
      const fresh = await this.deps.store.lookup(this.deps.namespace, roleId, stageName);
      if (fresh && this.usable(fresh)) {
        this.cache.set(k, { rec: fresh, expiresAt: this.deps.now() + this.ttl });
        const addr = DirectoryRouter.addrOf(fresh);
        return { addr, self: addr === this.deps.selfAddr };
      }
      return { addr: cands[0], self: false };
    }
    const r = await this.deps.store.claim(this.deps.namespace, roleId, stageName, this.deps.selfId, this.deps.leaseMs);
    if (r.ok) {
      this.claimWins++;
      const rec: DirectoryRecord = {
        namespace: "",
        roleId,
        stageName,
        ownerId: this.deps.selfId,
        epoch: r.epoch,
        leaseUntil: r.leaseUntil,
        version: r.version,
        status: "active",
      };
      this.cache.set(k, { rec, expiresAt: this.deps.now() + this.ttl });
      return { addr: this.deps.selfAddr, self: true };
    }
    // claim 落败 → 重读目录，以目录为准（不回退到环）
    const fresh = await this.deps.store.lookup(this.deps.namespace, roleId, stageName);
    if (fresh) {
      this.cache.set(k, { rec: fresh, expiresAt: this.deps.now() + this.ttl });
      const addr = DirectoryRouter.addrOf(fresh);
      return { addr, self: addr === this.deps.selfAddr };
    }
    return null;
  }

  /** 成员视图变更：全部条目标记失效（下一条消息回源，不猜测新归属） */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** 本地激活/释放后的主动修正（本地即权威变更源时使用） */
  invalidate(roleId: string, stageName: string): void {
    this.cache.delete(DirectoryRouter.key(roleId, stageName));
  }

  stats(): RouterStats {
    return { hits: this.hits, misses: this.misses, claims: this.claims, claimWins: this.claimWins, cacheSize: this.cache.size };
  }
}
