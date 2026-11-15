import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { ConflictError } from "../src/core/errors.js";
import { unwrapEnvelope } from "../src/core/envelope.js";
import type { TroupeEvent } from "../src/core/events.js";
import type { PropStore, StoredProps, WriteOptions } from "../src/props/prop-store.js";
import type { AcquireResult, OwnershipRecord, OwnershipStore } from "../src/props/ownership.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { PostgresPropStore } from "../src/props/postgres.js";
import { SqlitePropStore } from "../src/props/sqlite.js";

/**
 * 所有权/fencing 失败反例（ROADMAP P0-2，ADR 0002 §3）。
 * 每条反例对应 ADR 不变量 I1–I5；修复前必须红（失败演示），P0-3～P0-6 落地后转绿。
 *
 * - F1/I1：旧 epoch 在 takeover 后 create 必须失败
 * - F2/I2：旧 epoch 的 create 冲突回退 write 必须失败（StageManager save 竞态兜底路径）
 * - F3/I3：ownership 行缺失时 write 必须失败（不能靠 NOT EXISTS 放行）
 * - F4/I3：lease 过期后旧 owner 的 write 必须失败
 * - F5/I4：续租 store 抛错，fake clock 推进到租约边界 → 实例停止接单
 * - F6/I5：production + SqlitePropStore 启动失败（allowUnsafeProviders 显式豁免除外）
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 8_000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

class FencingCart extends Actor<{ items: string[]; marker?: string }> {
  static role = "FencingCart";
  static initialProps = () => ({ items: [] });

  /** 落盘（可选携带标记，用于区分不同 Stage 的写入） */
  async touch(marker?: string) {
    if (marker !== undefined) this.props.marker = marker;
    await this.saveProps();
    return this.props.items.length;
  }

  /** 只读：触发激活但不落盘（保持 revision=0） */
  async peek() {
    return this.props;
  }
}

// ---- PG 用例门控：TROUPE_REQUIRE_PG=1 时缺失连接串必须失败，不允许静默 skip（P0-7）----

const REQUIRE_PG = process.env.TROUPE_REQUIRE_PG === "1";
const PG_URL = process.env.TROUPE_TEST_PG_URL;

// ---- F1/I1：旧 epoch takeover 后 create 必须失败（SQLite）----

describe("反例 F1（ADR I1）：旧 epoch 在 takeover 后 create 必须失败", () => {
  it("SQLite：nodeA token=1 在 nodeB 顶替（epoch=2）后 create 被拒；nodeB create 正常", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-f1-"));
    const store = new SqlitePropStore(dir);
    const first = await store.acquire("ns", "Cart", "k1", "nodeA", 60);
    expect(first.ok).toBe(true);
    await sleep(90); // nodeA 租约过期
    const takeover = await store.acquire("ns", "Cart", "k1", "nodeB", 5_000);
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return; // 类型收窄
    expect(takeover.epoch).toBe(2);

    // 旧持有者以旧 token create：必须被 fencing 拒绝（修复前 create 无 token → 成功 → 红）
    const stale = await store
      .create("ns", "Cart", "k1", { v: "stale" }, 1, { fencingToken: 1, fencingOwner: "nodeA" })
      .then(
        () => null,
        (e) => e,
      );
    expect(stale).toBeInstanceOf(ConflictError);
    expect((stale as ConflictError).kind).toBe("fencing");

    // 新持有者 create 正常（revision=1）
    const fresh = await store.create("ns", "Cart", "k1", { v: "fresh" }, 1, {
      fencingToken: takeover.epoch,
      fencingOwner: "nodeB",
    });
    expect(fresh.revision).toBe(1);
    const read = await store.read("ns", "Cart", "k1");
    expect(read?.props).toEqual({ v: "fresh" });
  });
});

// ---- F2/I2：create 冲突回退 write 必须带 token（StageManager save 路径）----

describe("反例 F2（ADR I2）：旧 epoch 的 create 冲突回退 write 必须失败", () => {
  it("双 Stage 共享 SQLite：B 顶替落盘后，A 的回退写不得覆盖 B 的数据", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-f2-"));
    const store = new SqlitePropStore(dir);

    // Stage A：fake clock 冻结 → 续租永不发生（本地时钟只是近似提示，租约以存储为准）
    let fakeNow = 1_000_000;
    const a = await Troupe.form({
      actors: [FencingCart],
      propStore: store,
      defaultIntermission: 0,
      defaultTimeout: "5s",
      cluster: { port: 0 },
      ownership: { leaseMs: 300 },
      now: () => fakeNow,
    });
    // 激活 A（acquire epoch=1，revision=0 不落盘）
    expect(await a.cast(FencingCart, "k").peek()).toEqual({ items: [] });
    await sleep(400); // A 的租约过期（fake clock 冻结 → 不续租）

    // Stage B：真实时钟，顶替过期租约（epoch=2）并落盘
    const b = await Troupe.form({
      actors: [FencingCart],
      propStore: store,
      defaultIntermission: 0,
      defaultTimeout: "5s",
      cluster: { port: 0 },
      ownership: { leaseMs: 5_000 },
    });
    await b.cast(FencingCart, "k").touch("from-B");
    const afterB = await store.read("default", "FencingCart", "k");
    expect(unwrapEnvelope(afterB?.props).props).toMatchObject({ marker: "from-B" });
    expect(afterB?.revision).toBe(1);

    // A 以旧 token（epoch=1）保存：create 冲突 → 回退 write 必须被 fencing 拒绝
    // （修复前回退 write 无 token → 成功覆盖 B → 红）
    await expect(a.cast(FencingCart, "k").touch()).rejects.toBeInstanceOf(ConflictError);

    // B 的数据未被旧持有者覆盖
    const final = await store.read("default", "FencingCart", "k");
    expect(unwrapEnvelope(final?.props).props).toMatchObject({ marker: "from-B" });

    await b.shutdown();
    await a.shutdown();
  }, 30_000);
});

// ---- F3/I3：ownership 行缺失时 write 必须失败（SQLite）----

describe("反例 F3（ADR I3）：ownership 行缺失时 write 必须失败", () => {
  it("SQLite：删除所有权行后，带 token 的 write 被拒（修复前 NOT EXISTS 放行 → 红）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-f3-"));
    const store = new SqlitePropStore(dir);
    await store.acquire("ns", "Cart", "k3", "nodeA", 5_000);
    await store.create("ns", "Cart", "k3", { v: 1 }, 1);

    // 直接删除所有权行（模拟目录/租约记录丢失）
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => { exec(sql: string): void };
    };
    const raw = new DatabaseSync(join(dir, "props.db"));
    raw.exec("DELETE FROM ownership");
    raw.close();

    const res = await store
      .write("ns", "Cart", "k3", { v: 2 }, {
        expectedRevision: 1,
        schemaVersion: 1,
        fencingToken: 1,
        fencingOwner: "nodeA",
      })
      .then(
        () => null,
        (e) => e,
      );
    expect(res).toBeInstanceOf(ConflictError);
    expect((res as ConflictError).kind).toBe("fencing");
  });
});

// ---- F4/I3：lease 过期后旧 owner 的 write 必须失败（SQLite）----

describe("反例 F4（ADR I3）：lease 过期后旧 owner 的 write 必须失败", () => {
  it("SQLite：租约过期后带 token 的 write 被拒（kind=lease-expired；修复前放行 → 红）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-f4-"));
    const store = new SqlitePropStore(dir);
    await store.acquire("ns", "Cart", "k4", "nodeA", 60);
    await store.create("ns", "Cart", "k4", { v: 1 }, 1);
    await sleep(90); // 租约过期，且未被任何人顶替

    const res = await store
      .write("ns", "Cart", "k4", { v: 2 }, {
        expectedRevision: 1,
        schemaVersion: 1,
        fencingToken: 1,
        fencingOwner: "nodeA",
      })
      .then(
        () => null,
        (e) => e,
      );
    expect(res).toBeInstanceOf(ConflictError);
    expect((res as ConflictError).kind).toBe("lease-expired");
  });
});

// ---- F5/I4：续租存储异常 → 推进到租约边界 → 实例停止接单 ----

/** PropStore + OwnershipStore 合一 fake：首次 acquire 成功，其后（存储故障期）一律抛错 */
class FlakyOwnershipMemoryStore implements PropStore, OwnershipStore {
  private mem = new InMemoryPropStore();
  private own = new Map<string, { ownerId: string; epoch: number; leaseUntil: number }>();
  private attempts = 0;
  private down = true;

  constructor(private readonly now: () => number) {}

  /** 模拟存储恢复 */
  recover(): void {
    this.down = false;
  }

  read(a: string, b: string, c: string) {
    return this.mem.read(a, b, c);
  }
  create(a: string, b: string, c: string, d: unknown, e: number, opts?: { fencingToken?: number; fencingOwner?: string }) {
    return this.mem.create(a, b, c, d, e, opts as never);
  }
  write(a: string, b: string, c: string, d: unknown, opts: WriteOptions) {
    return this.mem.write(a, b, c, d, opts);
  }
  delete(a: string, b: string, c: string) {
    return this.mem.delete(a, b, c);
  }

  async acquire(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<AcquireResult> {
    this.attempts++;
    if (this.attempts > 1 && this.down) {
      throw new Error("store down（F5 模拟存储不可达）");
    }
    const key = `${namespace}\u0000${roleId}\u0000${stageName}`;
    const rec = this.own.get(key);
    const until = this.now() + leaseMs;
    if (!rec) {
      this.own.set(key, { ownerId, epoch: 1, leaseUntil: until });
      return { ok: true, epoch: 1, leaseUntil: until };
    }
    if (rec.ownerId === ownerId) {
      rec.leaseUntil = until;
      return { ok: true, epoch: rec.epoch, leaseUntil: until };
    }
    if (rec.leaseUntil <= this.now()) {
      rec.ownerId = ownerId;
      rec.epoch += 1;
      rec.leaseUntil = until;
      return { ok: true, epoch: rec.epoch, leaseUntil: until };
    }
    return { ok: false, holder: { ...rec } satisfies OwnershipRecord };
  }

  async readOwnership(namespace: string, roleId: string, stageName: string): Promise<OwnershipRecord | null> {
    const rec = this.own.get(`${namespace}\u0000${roleId}\u0000${stageName}`);
    return rec ? { ...rec } : null;
  }

  async release(namespace: string, roleId: string, stageName: string, ownerId: string, epoch: number): Promise<boolean> {
    const key = `${namespace}\u0000${roleId}\u0000${stageName}`;
    const rec = this.own.get(key);
    if (!rec || rec.ownerId !== ownerId || rec.epoch !== epoch) return false;
    rec.leaseUntil = 0;
    return true;
  }
}

describe("反例 F5（ADR I4）：续租失败累计到租约边界 → 实例必须停止接单", () => {
  it("fake store 续租抛错 + fake clock 推进 → invalidated + 后续调用不再由旧实例服务", async () => {
    let t = 1_000_000;
    const clock = () => t;
    const store = new FlakyOwnershipMemoryStore(clock);
    const events: TroupeEvent[] = [];
    const troupe = await Troupe.form({
      actors: [FencingCart],
      propStore: store,
      defaultIntermission: 0,
      defaultTimeout: "30s",
      ownership: { leaseMs: 1_000 },
      now: clock,
      onEvent: (e) => events.push(e),
    });
    // 激活（acquire #1 成功，leaseUntil = 1_001_000，DB 域租约）
    expect(await troupe.cast(FencingCart, "k").peek()).toEqual({ items: [] });

    // 续租失败 #1（t≈1_000_700，尚未越过 leaseUntil - leaseMs/6 = 1_000_833 → 只累计）
    t += 700;
    await sleep(750);
    // 续租失败 #2（t≈1_001_400 ≥ 阈值 2 且已越过边界 → invalidate，先停止接单）
    t += 700;
    await sleep(750);

    const invalidated = await waitUntil(() => events.some((e) => e.type === "invalidated"));
    expect(invalidated).toBe(true); // 修复前仅 warn 继续 → 红

    // 旧实例已停止接单：存储仍不可达，任何调用不得再被旧实例成功服务
    await expect(troupe.cast(FencingCart, "k").peek()).rejects.toThrow();

    // 存储恢复后可重新激活（新租约）
    store.recover();
    expect(await troupe.cast(FencingCart, "k").peek()).toEqual({ items: [] });
    await troupe.shutdown();
  }, 30_000);
});

// ---- F6/I5：production 拒绝不安全 Provider ----

describe("反例 F6（ADR I5）：production + SqlitePropStore 启动必须失败", () => {
  const basePort = 17_400 + (process.pid % 1_500);

  it("production 门禁拒绝 SQLite；allowUnsafeProviders 显式豁免可启动并标记 degraded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-f6-"));
    // production 严格入团要求可达 seed：先起一个 dev seed Stage
    const seed = await Troupe.form({
      actors: [FencingCart],
      propStore: new SqlitePropStore(dir),
      cluster: { port: basePort, advertise: `127.0.0.1:${basePort}` },
    });
    const seedAddr = `127.0.0.1:${basePort}`;

    let formed: Troupe | null = null;
    try {
      formed = await Troupe.form({
        actors: [FencingCart],
        propStore: new SqlitePropStore(dir),
        cluster: { mode: "production", port: basePort + 1, advertise: `127.0.0.1:${basePort + 1}`, seeds: [seedAddr] },
      });
      // 修复前：SQLite 通过 production 检查 → 走到这里 → 红
      expect.fail("production 集群接受了 crossNodeSafe=false 的 SqlitePropStore");
    } catch (e) {
      if (formed) throw e; // form 成功后 expect.fail 抛 AssertionError——先停服再断言失败
      expect(String(e)).toMatch(/crossNodeSafe|supportsFencing|allowUnsafeProviders|不安全/);
    } finally {
      await formed?.shutdown();
    }

    // 显式豁免：可启动（入团同一 seed），但事件流必须带 degraded 标记
    const unsafeEvents: TroupeEvent[] = [];
    const unsafe = await Troupe.form({
      actors: [FencingCart],
      propStore: new SqlitePropStore(dir),
      allowUnsafeProviders: true,
      cluster: { mode: "production", port: basePort + 2, advertise: `127.0.0.1:${basePort + 2}`, seeds: [seedAddr] },
      onEvent: (e) => unsafeEvents.push(e),
    });
    try {
      const degraded = unsafeEvents.some(
        (e) => e.type === "warn" && /degraded|unsafe/i.test(JSON.stringify(e.detail ?? {})),
      );
      expect(degraded).toBe(true);
    } finally {
      await unsafe.shutdown();
      await seed.shutdown();
    }
  }, 30_000);
});

// ---- PG 反例（真实 PostgreSQL；CI 必跑，本地无 PG 时跳过并在 VERIFICATION 列明）----

describe.runIf(REQUIRE_PG && !PG_URL)("PG 门禁", () => {
  it("TROUPE_REQUIRE_PG=1 但未提供 TROUPE_TEST_PG_URL：拒绝静默跳过", () => {
    throw new Error("缺少 TROUPE_TEST_PG_URL：PG fencing 反例在 CI 必跑，skip 视为失败（ROADMAP P0-7）");
  });
});

describe.runIf(!!PG_URL)("PG 反例（真实 PostgreSQL）", () => {
  it("F1-PG/I1：旧 epoch 在 takeover 后 create 必须失败", async () => {
    const store = new PostgresPropStore(PG_URL!);
    const ns = `pgf1_${Date.now()}_${process.pid}`;
    try {
      const first = await store.acquire(ns, "Cart", "k1", "nodeA", 60);
      expect(first.ok).toBe(true);
      await sleep(120);
      const takeover = await store.acquire(ns, "Cart", "k1", "nodeB", 5_000);
      expect(takeover.ok).toBe(true);
      if (!takeover.ok) return;
      expect(takeover.epoch).toBe(2);
      const stale: ConflictError | StoredProps | null = await store
        .create(ns, "Cart", "k1", { v: "stale" }, 1, { fencingToken: 1, fencingOwner: "nodeA" })
        .then(
          () => null,
          (e) => e,
        );
      expect(stale).toBeInstanceOf(ConflictError);
      expect((stale as ConflictError).kind).toBe("fencing");
    } finally {
      await store.close();
    }
  });

  it("F3-PG/I3：ownership 行缺失时 write 必须失败", async () => {
    const store = new PostgresPropStore(PG_URL!);
    const ns = `pgf3_${Date.now()}_${process.pid}`;
    try {
      await store.acquire(ns, "Cart", "k3", "nodeA", 5_000);
      await store.create(ns, "Cart", "k3", { v: 1 }, 1);
      // 删除所有权行
      const c = await (store as unknown as { client(): Promise<{ query: (s: string, p?: unknown[]) => Promise<{ rowCount: number }> ; release(): void }> }).client();
      try {
        await c.query(`DELETE FROM public.ownership WHERE namespace = $1`, [ns]);
      } finally {
        c.release();
      }
      const res = await store
        .write(ns, "Cart", "k3", { v: 2 }, {
          expectedRevision: 1,
          schemaVersion: 1,
          fencingToken: 1,
          fencingOwner: "nodeA",
        })
        .then(
          () => null,
          (e) => e,
        );
      expect(res).toBeInstanceOf(ConflictError);
      expect((res as ConflictError).kind).toBe("fencing");
    } finally {
      await store.close();
    }
  });

  it("F4-PG/I3：lease 过期后旧 owner 的 write 必须失败（kind=lease-expired）", async () => {
    const store = new PostgresPropStore(PG_URL!);
    const ns = `pgf4_${Date.now()}_${process.pid}`;
    try {
      await store.acquire(ns, "Cart", "k4", "nodeA", 60);
      await store.create(ns, "Cart", "k4", { v: 1 }, 1);
      await sleep(150); // PG 时钟域：多留余量
      const res = await store
        .write(ns, "Cart", "k4", { v: 2 }, {
          expectedRevision: 1,
          schemaVersion: 1,
          fencingToken: 1,
          fencingOwner: "nodeA",
        })
        .then(
          () => null,
          (e) => e,
        );
      expect(res).toBeInstanceOf(ConflictError);
      expect((res as ConflictError).kind).toBe("lease-expired");
    } finally {
      await store.close();
    }
  });
});
