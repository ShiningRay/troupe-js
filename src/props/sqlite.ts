import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { ConflictError } from "../core/errors.js";
import type { StoreCapabilities } from "./capabilities.js";
import type { CreateOptions, PropStore, StoredProps, WriteOptions } from "./prop-store.js";
import type { AcquireResult, OwnershipRecord, OwnershipStore } from "./ownership.js";
import type { DirectoryClaimResult, DirectoryRecord, DirectoryStore } from "./directory.js";

// vitest/vite 尚不识别 node:sqlite 内建，改为运行时 require（类型仍静态检查）
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/** SQLite 存储时钟（epoch ms；租约判定唯一权威，ADR 0002 §5——SQLite 仅同机，与系统时钟同源） */
const SQLITE_DB_NOW_MS =
  "(CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), -3) AS INTEGER))";

/** 所有权有效性 EXISTS 子句（ADR 0002 I3）：行必须存在且 owner/epoch 匹配、租约未过期 */
function ownershipExistsSql(alias: string, withOwner: boolean): string {
  const owner = withOwner ? ` AND ${alias}.owner_id = ?` : "";
  return `EXISTS (
    SELECT 1 FROM ownership ${alias}
    WHERE ${alias}.namespace = ? AND ${alias}.role_id = ? AND ${alias}.stage_name = ?${owner}
      AND ${alias}.epoch = ? AND ${alias}.lease_until > ${SQLITE_DB_NOW_MS}
  )`;
}

/**
 * 进程级持久化（DESIGN §7.2，M2）：`node:sqlite`，零 npm 依赖。
 * - 懒初始化：首次用到才建目录/建库/建表
 * - WAL + busy_timeout：支持同机多进程共享库文件（M3 所有权场景）
 * - create/write 以单条语句原子实现 CAS 合同；fencing 在同一语句内校验所有权行（ADR 0002 I1/I3）
 * - 附带所有权表（M3）：acquire/renew/顶替/释放均为单语句原子操作
 * - 目录化所有权（ADR 0004，P1-2）：ownership 表扩展 version/status（PRAGMA 检测迁移），
 *   实现 DirectoryStore——同机范围内路由权威
 *
 * capabilities（ADR 0002 §8）：crossNodeSafe=false——SQLite 仅同机多进程安全，
 * 跨主机共享盘的锁语义不成立；production 门禁（P0-6）据此拒绝，allowUnsafeProviders 显式豁免。
 */
export class SqlitePropStore implements PropStore, OwnershipStore, DirectoryStore {
  readonly capabilities: StoreCapabilities = {
    crossNodeSafe: false,
    supportsFencing: true,
    supportsTransactions: true,
  };

  private db: DatabaseSyncType | null = null;
  private stmts: {
    get: ReturnType<DatabaseSyncType["prepare"]>;
    insert: ReturnType<DatabaseSyncType["prepare"]>;
    /** 条件插入：所有权行有效才插入（ADR 0002 I1）——owner+epoch 成对 / 仅 epoch 两种形态 */
    insertFencedPair: ReturnType<DatabaseSyncType["prepare"]>;
    insertFencedToken: ReturnType<DatabaseSyncType["prepare"]>;
    update: ReturnType<DatabaseSyncType["prepare"]>;
    /** 严格 fencing CAS 写（ADR 0002 I3）：EXISTS(有效所有权)，行缺失/租约过期均拒绝 */
    updateFencedPair: ReturnType<DatabaseSyncType["prepare"]>;
    updateFencedToken: ReturnType<DatabaseSyncType["prepare"]>;
    del: ReturnType<DatabaseSyncType["prepare"]>;
    deleteFencedPair: ReturnType<DatabaseSyncType["prepare"]>;
    deleteFencedToken: ReturnType<DatabaseSyncType["prepare"]>;
    ownGet: ReturnType<DatabaseSyncType["prepare"]>;
    ownInsert: ReturnType<DatabaseSyncType["prepare"]>;
    ownRenew: ReturnType<DatabaseSyncType["prepare"]>;
    ownTakeover: ReturnType<DatabaseSyncType["prepare"]>;
    ownRelease: ReturnType<DatabaseSyncType["prepare"]>;
  } | null = null;

  constructor(
    private readonly dir: string = "./.troupe",
    private readonly file: string = "props.db",
  ) {}

  private ensure(): void {
    if (this.db) return;
    mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(join(this.dir, this.file));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 3000;"); // 同机多进程共享库文件时的写锁等待
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS props (
        namespace     TEXT    NOT NULL,
        role_id       TEXT    NOT NULL,
        stage_name    TEXT    NOT NULL,
        props_json    TEXT    NOT NULL,
        revision      INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        PRIMARY KEY (namespace, role_id, stage_name)
      );
      CREATE TABLE IF NOT EXISTS ownership (
        namespace   TEXT    NOT NULL,
        role_id     TEXT    NOT NULL,
        stage_name  TEXT    NOT NULL,
        owner_id    TEXT    NOT NULL,
        epoch       INTEGER NOT NULL,
        lease_until INTEGER NOT NULL,
        PRIMARY KEY (namespace, role_id, stage_name)
      );
    `);
    // 目录化所有权迁移（ADR 0004，P1-2）：对旧库补 version/status 列（PRAGMA 检测，幂等）
    const cols = (this.db.prepare("PRAGMA table_info(ownership)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    if (!cols.includes("version")) {
      this.db.exec("ALTER TABLE ownership ADD COLUMN version INTEGER NOT NULL DEFAULT 0;");
    }
    if (!cols.includes("status")) {
      this.db.exec("ALTER TABLE ownership ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");
    }
    this.stmts = {
      get: this.db.prepare(
        "SELECT props_json, revision, schema_version FROM props WHERE namespace = ? AND role_id = ? AND stage_name = ?",
      ),
      insert: this.db.prepare(
        "INSERT INTO props (namespace, role_id, stage_name, props_json, revision, schema_version) VALUES (?, ?, ?, ?, 1, ?)",
      ),
      insertFencedPair: this.db.prepare(`
        INSERT INTO props (namespace, role_id, stage_name, props_json, revision, schema_version)
        SELECT ?, ?, ?, ?, 1, ?
        WHERE ${ownershipExistsSql("o", true)}
      `),
      insertFencedToken: this.db.prepare(`
        INSERT INTO props (namespace, role_id, stage_name, props_json, revision, schema_version)
        SELECT ?, ?, ?, ?, 1, ?
        WHERE ${ownershipExistsSql("o", false)}
      `),
      update: this.db.prepare(
        "UPDATE props SET props_json = ?, revision = revision + 1, schema_version = ? WHERE namespace = ? AND role_id = ? AND stage_name = ? AND revision = ?",
      ),
      updateFencedPair: this.db.prepare(`
        UPDATE props SET props_json = ?, revision = revision + 1, schema_version = ?
        WHERE namespace = ? AND role_id = ? AND stage_name = ? AND revision = ?
          AND EXISTS (
            SELECT 1 FROM ownership o
            WHERE o.namespace = props.namespace AND o.role_id = props.role_id AND o.stage_name = props.stage_name
              AND o.owner_id = ? AND o.epoch = ? AND o.lease_until > ${SQLITE_DB_NOW_MS}
          )
      `),
      updateFencedToken: this.db.prepare(`
        UPDATE props SET props_json = ?, revision = revision + 1, schema_version = ?
        WHERE namespace = ? AND role_id = ? AND stage_name = ? AND revision = ?
          AND EXISTS (
            SELECT 1 FROM ownership o
            WHERE o.namespace = props.namespace AND o.role_id = props.role_id AND o.stage_name = props.stage_name
              AND o.epoch = ? AND o.lease_until > ${SQLITE_DB_NOW_MS}
          )
      `),
      del: this.db.prepare(
        "DELETE FROM props WHERE namespace = ? AND role_id = ? AND stage_name = ?",
      ),
      deleteFencedPair: this.db.prepare(`
        DELETE FROM props WHERE namespace = ? AND role_id = ? AND stage_name = ?
          AND ${ownershipExistsSql("o", true)}
      `),
      deleteFencedToken: this.db.prepare(`
        DELETE FROM props WHERE namespace = ? AND role_id = ? AND stage_name = ?
          AND ${ownershipExistsSql("o", false)}
      `),
      ownGet: this.db.prepare(
        "SELECT owner_id, epoch, lease_until, version, status FROM ownership WHERE namespace = ? AND role_id = ? AND stage_name = ?",
      ),
      ownInsert: this.db.prepare(
        "INSERT INTO ownership (namespace, role_id, stage_name, owner_id, epoch, lease_until, version, status) VALUES (?, ?, ?, ?, 1, ?, 1, 'active')",
      ),
      ownRenew: this.db.prepare(
        // 续租：epoch 不变；version+1（目录变更驱动缓存失效，ADR 0004 §3）
        "UPDATE ownership SET lease_until = ?, status = 'active', version = version + 1 WHERE namespace = ? AND role_id = ? AND stage_name = ? AND owner_id = ? AND epoch = ?",
      ),
      ownTakeover: this.db.prepare(
        // 顶替过期租约（含 tombstone/释放态）：epoch+1、version+1
        "UPDATE ownership SET owner_id = ?, epoch = epoch + 1, lease_until = ?, status = 'active', version = version + 1 WHERE namespace = ? AND role_id = ? AND stage_name = ? AND lease_until <= ?",
      ),
      ownRelease: this.db.prepare(
        // 不删行：置空租约 + draining——epoch 必须跨释放单调（否则旧持有者的 token 可通过 fencing）；version+1
        "UPDATE ownership SET lease_until = 0, status = 'draining', version = version + 1 WHERE namespace = ? AND role_id = ? AND stage_name = ? AND owner_id = ? AND epoch = ?",
      ),
    };
  }

  async read(namespace: string, roleId: string, stageName: string): Promise<StoredProps | null> {
    this.ensure();
    const row = this.stmts!.get.get(namespace, roleId, stageName) as
      | { props_json: string; revision: number; schema_version: number }
      | undefined;
    if (!row) return null;
    return {
      props: JSON.parse(row.props_json),
      revision: Number(row.revision),
      schemaVersion: Number(row.schema_version),
    };
  }

  /** fencing 参数形态：owner+epoch 成对（严格）/ 仅 epoch（过渡兼容，StageManager P0-5 起成对） */
  private fencedMode(opts: { fencingToken?: number; fencingOwner?: string } | undefined):
    | "pair"
    | "token"
    | null {
    if (!opts || opts.fencingToken === undefined) return null;
    return opts.fencingOwner !== undefined ? "pair" : "token";
  }

  /**
   * fencing 失败分类（ADR 0002 §7）：行缺失 / owner+epoch 不匹配 → "fencing"；
   * 行匹配但租约过期（存储时钟判定）→ "lease-expired"。
   */
  private rejectFencing(
    namespace: string,
    roleId: string,
    stageName: string,
    token: number,
  ): never {
    const own = this.stmts!.ownGet.get(namespace, roleId, stageName) as
      | { owner_id: string; epoch: number; lease_until: number }
      | undefined;
    if (!own) {
      throw new ConflictError(
        `fencing 拒绝：所有权行缺失（${namespace}/${roleId}/${stageName}，token=${token}）——不能放行无所有者的写入（ADR 0002 I3）`,
        "fencing",
      );
    }
    const nowMs = Date.now(); // SQLite 存储时钟与本地同源（仅同机部署）
    if (Number(own.lease_until) <= nowMs) {
      throw new ConflictError(
        `fencing 拒绝：租约已过期（epoch=${own.epoch}，owner=${own.owner_id}，lease_until=${own.lease_until} <= now=${nowMs}）——持有资格失效（ADR 0002 I3）`,
        "lease-expired",
      );
    }
    throw new ConflictError(
      `fencing 拒绝：所有权 epoch=${own.epoch}（owner=${own.owner_id}）与写入 token=${token} 不匹配——旧持有者的写入被拒（ADR 0002 I3）`,
      "fencing",
    );
  }

  async create(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    schemaVersion: number,
    opts?: CreateOptions,
  ): Promise<StoredProps> {
    this.ensure();
    const mode = this.fencedMode(opts);
    const payload = JSON.stringify(props);
    if (mode === null) {
      try {
        this.stmts!.insert.run(namespace, roleId, stageName, payload, schemaVersion);
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ConflictError(`记录已存在：${namespace}/${roleId}/${stageName}`, "exists");
        }
        throw e;
      }
      return { props, revision: 1, schemaVersion };
    }
    // 条件插入（ADR 0002 I1）：所有权行有效才允许；失败必须分类（行缺失≠放行）
    const changes =
      mode === "pair"
        ? this.stmts!.insertFencedPair.run(
            namespace, roleId, stageName, payload, schemaVersion,
            namespace, roleId, stageName, opts!.fencingOwner!, opts!.fencingToken!,
          ).changes
        : this.stmts!.insertFencedToken.run(
            namespace, roleId, stageName, payload, schemaVersion,
            namespace, roleId, stageName, opts!.fencingToken!,
          ).changes;
    if (changes === 0) {
      // 所有权无效 或 props 行已存在——先分类所有权，再判定 exists
      const own = this.stmts!.ownGet.get(namespace, roleId, stageName) as
        | { owner_id: string; epoch: number; lease_until: number }
        | undefined;
      const valid =
        own !== undefined &&
        (mode === "token" || own.owner_id === opts!.fencingOwner) &&
        Number(own.epoch) === opts!.fencingToken &&
        Number(own.lease_until) > Date.now();
      if (!valid) this.rejectFencing(namespace, roleId, stageName, opts!.fencingToken!);
      throw new ConflictError(`记录已存在：${namespace}/${roleId}/${stageName}`, "exists");
    }
    return { props, revision: 1, schemaVersion };
  }

  async write(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    opts: WriteOptions,
  ): Promise<StoredProps> {
    this.ensure();
    const mode = this.fencedMode(opts);
    const payload = JSON.stringify(props);
    const changes =
      mode === "pair"
        ? this.stmts!.updateFencedPair.run(
            payload, opts.schemaVersion, namespace, roleId, stageName, opts.expectedRevision,
            opts.fencingOwner!, opts.fencingToken!,
          ).changes
        : mode === "token"
          ? this.stmts!.updateFencedToken.run(
              payload, opts.schemaVersion, namespace, roleId, stageName, opts.expectedRevision,
              opts.fencingToken!,
            ).changes
          : this.stmts!.update.run(
              payload, opts.schemaVersion, namespace, roleId, stageName, opts.expectedRevision,
            ).changes;
    if (changes === 0) {
      // 分类顺序（ADR 0002 §7）：资格失败（fencing/lease-expired）优先于 revision 冲突
      if (mode !== null) {
        const own = this.stmts!.ownGet.get(namespace, roleId, stageName) as
          | { owner_id: string; epoch: number; lease_until: number }
          | undefined;
        const valid =
          own !== undefined &&
          (mode === "token" || own.owner_id === opts.fencingOwner) &&
          Number(own.epoch) === opts.fencingToken &&
          Number(own.lease_until) > Date.now();
        if (!valid) this.rejectFencing(namespace, roleId, stageName, opts.fencingToken!);
      }
      const row = this.stmts!.get.get(namespace, roleId, stageName) as
        | { revision: number }
        | undefined;
      if (!row) {
        throw new ConflictError(
          `记录不存在（期望 revision=${opts.expectedRevision}）：${namespace}/${roleId}/${stageName}；首次写入应使用 create`,
          "revision",
        );
      }
      throw new ConflictError(
        `CAS 冲突：期望 revision=${opts.expectedRevision}，实际 revision=${row.revision}（${namespace}/${roleId}/${stageName}）`,
        "revision",
      );
    }
    return { props, revision: opts.expectedRevision + 1, schemaVersion: opts.schemaVersion };
  }

  async delete(
    namespace: string,
    roleId: string,
    stageName: string,
    opts?: { fencingToken?: number; fencingOwner?: string },
  ): Promise<void> {
    this.ensure();
    const mode = this.fencedMode(opts);
    if (mode === null) {
      this.stmts!.del.run(namespace, roleId, stageName);
      return;
    }
    const changes =
      mode === "pair"
        ? this.stmts!.deleteFencedPair.run(
            namespace, roleId, stageName,
            namespace, roleId, stageName, opts!.fencingOwner!, opts!.fencingToken!,
          ).changes
        : this.stmts!.deleteFencedToken.run(
            namespace, roleId, stageName,
            namespace, roleId, stageName, opts!.fencingToken!,
          ).changes;
    if (changes === 0) this.rejectFencing(namespace, roleId, stageName, opts!.fencingToken!);
  }

  // ---- 所有权（DESIGN §6.5，M3）与目录（ADR 0004，P1-2）----

  private rowToRecord(row: {
    namespace?: string;
    role_id?: string;
    stage_name?: string;
    owner_id: string;
    epoch: number;
    lease_until: number;
    version: number;
    status: string;
  }, fallback: { namespace: string; roleId: string; stageName: string }): DirectoryRecord {
    return {
      namespace: row.namespace ?? fallback.namespace,
      roleId: row.role_id ?? fallback.roleId,
      stageName: row.stage_name ?? fallback.stageName,
      ownerId: row.owner_id,
      epoch: Number(row.epoch),
      leaseUntil: Number(row.lease_until),
      version: Number(row.version),
      status: row.status as DirectoryRecord["status"],
    };
  }

  /** 目录 claim（原 acquire 语义 + version 单调 + status 维护；tombstone 租约为 0 → 可顶替重建） */
  async claim(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<DirectoryClaimResult> {
    this.ensure();
    const now = Date.now();
    const until = now + leaseMs;
    const row = this.stmts!.ownGet.get(namespace, roleId, stageName) as
      | { owner_id: string; epoch: number; lease_until: number; version: number; status: string }
      | undefined;
    if (!row) {
      try {
        this.stmts!.ownInsert.run(namespace, roleId, stageName, ownerId, until);
        return { ok: true, epoch: 1, leaseUntil: until, version: 1 };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // 并发抢占落败：走下面的续租/顶替路径
      }
    } else if (row.owner_id === ownerId) {
      // 续租：epoch 不变；version+1（目录变更）
      const c = this.stmts!.ownRenew.run(until, namespace, roleId, stageName, ownerId, row.epoch).changes;
      if (c === 1) return { ok: true, epoch: row.epoch, leaseUntil: until, version: Number(row.version) + 1 };
    }
    // 顶替过期租约（含 tombstone/释放态）：epoch + 1（fencing token 单调递增），version+1
    const c = this.stmts!.ownTakeover.run(ownerId, until, namespace, roleId, stageName, now).changes;
    if (c === 1) {
      const fresh = this.stmts!.ownGet.get(namespace, roleId, stageName) as {
        epoch: number;
        version: number;
      };
      return { ok: true, epoch: Number(fresh.epoch), leaseUntil: until, version: Number(fresh.version) };
    }
    const holder = (this.stmts!.ownGet.get(namespace, roleId, stageName) as {
      owner_id: string;
      epoch: number;
      lease_until: number;
      version: number;
      status: string;
    })!;
    return {
      ok: false,
      holder: this.rowToRecord(holder, { namespace, roleId, stageName }),
    };
  }

  /** OwnershipStore 兼容层：委托 claim（不带 version） */
  async acquire(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<AcquireResult> {
    const r = await this.claim(namespace, roleId, stageName, ownerId, leaseMs);
    if (r.ok) return { ok: true, epoch: r.epoch, leaseUntil: r.leaseUntil };
    const { namespace: _n, roleId: _r, stageName: _s, version: _v, status: _st, ...holder } = r.holder;
    return { ok: false, holder };
  }

  async lookup(
    namespace: string,
    roleId: string,
    stageName: string,
  ): Promise<DirectoryRecord | null> {
    this.ensure();
    const row = this.stmts!.ownGet.get(namespace, roleId, stageName) as
      | { owner_id: string; epoch: number; lease_until: number; version: number; status: string }
      | undefined;
    return row ? this.rowToRecord(row, { namespace, roleId, stageName }) : null;
  }

  async readOwnership(
    namespace: string,
    roleId: string,
    stageName: string,
  ): Promise<OwnershipRecord | null> {
    const rec = await this.lookup(namespace, roleId, stageName);
    if (!rec) return null;
    return { ownerId: rec.ownerId, epoch: rec.epoch, leaseUntil: rec.leaseUntil };
  }

  async release(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    epoch: number,
  ): Promise<boolean> {
    this.ensure();
    // 不删行：置空租约 + draining（交接/停服语义）——epoch 跨释放单调，version 推进缓存失效
    return this.stmts!.ownRelease.run(namespace, roleId, stageName, ownerId, epoch).changes === 1;
  }

  async bumpVersion(namespace: string, roleId: string, stageName: string): Promise<number | null> {
    this.ensure();
    const rows = this.db!.prepare(
      "UPDATE ownership SET version = version + 1 WHERE namespace = ? AND role_id = ? AND stage_name = ? RETURNING version",
    ).all(namespace, roleId, stageName) as Array<{ version: number }>;
    return rows.length > 0 ? Number(rows[0].version) : null;
  }

  async listOwned(ownerIdPrefix: string): Promise<DirectoryRecord[]> {
    this.ensure();
    const rows = this.db!.prepare(
      "SELECT namespace, role_id, stage_name, owner_id, epoch, lease_until, version, status FROM ownership WHERE owner_id LIKE ? || '#%'",
    ).all(`${ownerIdPrefix}`) as Array<{
      namespace: string;
      role_id: string;
      stage_name: string;
      owner_id: string;
      epoch: number;
      lease_until: number;
      version: number;
      status: string;
    }>;
    return rows.map((row) => this.rowToRecord(row, { namespace: row.namespace, roleId: row.role_id, stageName: row.stage_name }));
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Error &&
    /UNIQUE constraint/i.test(e.message)
  );
}
