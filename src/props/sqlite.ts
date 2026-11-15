import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { ConflictError } from "../core/errors.js";
import type { StoreCapabilities } from "./capabilities.js";
import type { CreateOptions, PropStore, StoredProps, WriteOptions } from "./prop-store.js";
import type { AcquireResult, OwnershipRecord, OwnershipStore } from "./ownership.js";

// vitest/vite 尚不识别 node:sqlite 内建，改为运行时 require（类型仍静态检查）
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/**
 * 进程级持久化（DESIGN §7.2，M2）：`node:sqlite`，零 npm 依赖。
 * - 懒初始化：首次用到才建目录/建库/建表
 * - WAL + busy_timeout：支持同机多进程共享库文件（M3 所有权场景）
 * - create/write 以单条语句原子实现 CAS 合同；write 携 fencingToken 时校验所有权（ADR 0002）
 * - 附带所有权表（M3）：acquire/renew/顶替/释放均为单语句原子操作
 *
 * capabilities（ADR 0002 §8）：crossNodeSafe=false——SQLite 仅同机多进程安全，
 * 跨主机共享盘的锁语义不成立；production 门禁（P0-6）据此拒绝，allowUnsafeProviders 显式豁免。
 */
export class SqlitePropStore implements PropStore, OwnershipStore {
  readonly capabilities: StoreCapabilities = {
    crossNodeSafe: false,
    supportsFencing: true,
    supportsTransactions: true,
  };

  private db: DatabaseSyncType | null = null;
  private stmts: {
    get: ReturnType<DatabaseSyncType["prepare"]>;
    insert: ReturnType<DatabaseSyncType["prepare"]>;
    update: ReturnType<DatabaseSyncType["prepare"]>;
    updateFenced: ReturnType<DatabaseSyncType["prepare"]>;
    del: ReturnType<DatabaseSyncType["prepare"]>;
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
    this.stmts = {
      get: this.db.prepare(
        "SELECT props_json, revision, schema_version FROM props WHERE namespace = ? AND role_id = ? AND stage_name = ?",
      ),
      insert: this.db.prepare(
        "INSERT INTO props (namespace, role_id, stage_name, props_json, revision, schema_version) VALUES (?, ?, ?, ?, 1, ?)",
      ),
      update: this.db.prepare(
        "UPDATE props SET props_json = ?, revision = revision + 1, schema_version = ? WHERE namespace = ? AND role_id = ? AND stage_name = ? AND revision = ?",
      ),
      updateFenced: this.db.prepare(`
        UPDATE props SET props_json = ?, revision = revision + 1, schema_version = ?
        WHERE namespace = ? AND role_id = ? AND stage_name = ? AND revision = ?
          AND NOT EXISTS (
            SELECT 1 FROM ownership o
            WHERE o.namespace = props.namespace AND o.role_id = props.role_id AND o.stage_name = props.stage_name
              AND o.epoch > ?
          )
      `),
      del: this.db.prepare(
        "DELETE FROM props WHERE namespace = ? AND role_id = ? AND stage_name = ?",
      ),
      ownGet: this.db.prepare(
        "SELECT owner_id, epoch, lease_until FROM ownership WHERE namespace = ? AND role_id = ? AND stage_name = ?",
      ),
      ownInsert: this.db.prepare(
        "INSERT INTO ownership (namespace, role_id, stage_name, owner_id, epoch, lease_until) VALUES (?, ?, ?, ?, 1, ?)",
      ),
      ownRenew: this.db.prepare(
        "UPDATE ownership SET lease_until = ? WHERE namespace = ? AND role_id = ? AND stage_name = ? AND owner_id = ? AND epoch = ?",
      ),
      ownTakeover: this.db.prepare(
        "UPDATE ownership SET owner_id = ?, epoch = epoch + 1, lease_until = ? WHERE namespace = ? AND role_id = ? AND stage_name = ? AND lease_until <= ?",
      ),
      ownRelease: this.db.prepare(
        // 不删行：置空租约即可——epoch 必须跨释放单调（否则旧持有者的 token 可通过 fencing）
        "UPDATE ownership SET lease_until = 0 WHERE namespace = ? AND role_id = ? AND stage_name = ? AND owner_id = ? AND epoch = ?",
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

  async create(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    schemaVersion: number,
    opts?: CreateOptions,
  ): Promise<StoredProps> {
    this.ensure();
    try {
      this.stmts!.insert.run(namespace, roleId, stageName, JSON.stringify(props), schemaVersion);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictError(`记录已存在：${namespace}/${roleId}/${stageName}`, "exists");
      }
      throw e;
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
    const changes =
      opts.fencingToken !== undefined
        ? this.stmts!.updateFenced.run(
            JSON.stringify(props),
            opts.schemaVersion,
            namespace,
            roleId,
            stageName,
            opts.expectedRevision,
            opts.fencingToken,
          ).changes
        : this.stmts!.update.run(
            JSON.stringify(props),
            opts.schemaVersion,
            namespace,
            roleId,
            stageName,
            opts.expectedRevision,
          ).changes;
    if (changes === 0) {
      if (opts.fencingToken !== undefined) {
        const own = this.stmts!.ownGet.get(namespace, roleId, stageName) as
          | { owner_id: string; epoch: number }
          | undefined;
        if (own && own.epoch > opts.fencingToken) {
          throw new ConflictError(
            `fencing 拒绝：所有权 epoch=${own.epoch}（owner=${own.owner_id}）> 写入 token=${opts.fencingToken}——旧持有者的写入被拒（DESIGN §6.5）`,
            "revision",
          );
        }
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
    _opts?: { fencingToken?: number; fencingOwner?: string },
  ): Promise<void> {
    this.ensure();
    this.stmts!.del.run(namespace, roleId, stageName);
  }

  // ---- 所有权（DESIGN §6.5，M3）----

  async acquire(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<AcquireResult> {
    this.ensure();
    const now = Date.now();
    const until = now + leaseMs;
    const row = this.stmts!.ownGet.get(namespace, roleId, stageName) as
      | { owner_id: string; epoch: number; lease_until: number }
      | undefined;
    if (!row) {
      try {
        this.stmts!.ownInsert.run(namespace, roleId, stageName, ownerId, until);
        return { ok: true, epoch: 1, leaseUntil: until };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // 并发抢占落败：走下面的续租/顶替路径
      }
    } else if (row.owner_id === ownerId) {
      // 续租：epoch 不变
      const c = this.stmts!.ownRenew.run(until, namespace, roleId, stageName, ownerId, row.epoch).changes;
      if (c === 1) return { ok: true, epoch: row.epoch, leaseUntil: until };
    }
    // 顶替过期租约：epoch + 1（fencing token 单调递增）
    const c = this.stmts!.ownTakeover.run(ownerId, until, namespace, roleId, stageName, now).changes;
    if (c === 1) {
      const fresh = this.stmts!.ownGet.get(namespace, roleId, stageName) as { epoch: number };
      return { ok: true, epoch: Number(fresh.epoch), leaseUntil: until };
    }
    const holder = (this.stmts!.ownGet.get(namespace, roleId, stageName) as {
      owner_id: string;
      epoch: number;
      lease_until: number;
    })!;
    return { ok: false, holder: { ownerId: holder.owner_id, epoch: Number(holder.epoch), leaseUntil: Number(holder.lease_until) } };
  }

  async readOwnership(
    namespace: string,
    roleId: string,
    stageName: string,
  ): Promise<OwnershipRecord | null> {
    this.ensure();
    const row = this.stmts!.ownGet.get(namespace, roleId, stageName) as
      | { owner_id: string; epoch: number; lease_until: number }
      | undefined;
    return row
      ? { ownerId: row.owner_id, epoch: Number(row.epoch), leaseUntil: Number(row.lease_until) }
      : null;
  }

  async release(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    epoch: number,
  ): Promise<boolean> {
    this.ensure();
    return this.stmts!.ownRelease.run(namespace, roleId, stageName, ownerId, epoch).changes === 1;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Error &&
    /UNIQUE constraint/i.test(e.message)
  );
}
