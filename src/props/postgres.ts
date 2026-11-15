import { ConflictError } from "../core/errors.js";
import type { StoreCapabilities } from "./capabilities.js";
import type { CreateOptions, PropStore, StoredProps, WriteOptions } from "./prop-store.js";
import type { AcquireResult, OwnershipRecord, OwnershipStore } from "./ownership.js";
import type {
  DirectoryClaimResult,
  DirectoryRecord,
  DirectoryStore,
} from "./directory.js";
// pg 为可选 peer 依赖：仅在选用 PostgresPropStore 时需要安装（PLAN §5）
import { Pool, type PoolClient } from "pg";

/** PG 存储时钟（epoch ms）：租约判定的唯一权威（ADR 0002 §5），clock_timestamp 不受事务起点影响 */
const PG_DB_NOW_MS = "(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint";

/**
 * 节点级共享持久化（DESIGN §7.2，M3）：PostgresPropStore。
 * - 行级 CAS（单条 UPDATE ... WHERE revision = ?）
 * - fencing（ADR 0002 I1/I3）：create/write/delete 在同一原子语句内校验所有权行
 *   `owner_id + epoch + lease_until > 存储时钟`；行缺失 = 拒绝（不再 NOT EXISTS 放行）
 * - 所有权 acquire/续租/顶替/释放均为单语句原子操作（依赖行锁），租约边界以 PG 时钟为准
 * - 目录化所有权（ADR 0004，P1-2）：ownership 表扩展 version/status 列（自动迁移），
 *   实现 DirectoryStore——路由权威，version 单调
 * 选择：Troupe.form({ propStore: new PostgresPropStore("postgres://…") })
 *
 * capabilities（ADR 0002 §8）：跨节点安全 + 支持 fencing（P0 唯一满足 production 门禁的 Provider）。
 */
export class PostgresPropStore implements PropStore, OwnershipStore, DirectoryStore {
  readonly capabilities: StoreCapabilities = {
    crossNodeSafe: true,
    supportsFencing: true,
    supportsTransactions: true,
  };

  private pool: Pool | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly schema = "public",
  ) {}

  private async client(): Promise<PoolClient> {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
      await this.withClient(this.pool, async (c) => {
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await c.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.props (
            namespace     TEXT NOT NULL,
            role_id       TEXT NOT NULL,
            stage_name    TEXT NOT NULL,
            props_json    TEXT NOT NULL,
            revision      BIGINT NOT NULL,
            schema_version INT   NOT NULL,
            PRIMARY KEY (namespace, role_id, stage_name)
          );
          CREATE TABLE IF NOT EXISTS ${this.schema}.ownership (
            namespace   TEXT NOT NULL,
            role_id     TEXT NOT NULL,
            stage_name  TEXT NOT NULL,
            owner_id    TEXT NOT NULL,
            epoch       BIGINT NOT NULL,
            lease_until BIGINT NOT NULL,
            PRIMARY KEY (namespace, role_id, stage_name)
          );
          -- 目录化所有权迁移（ADR 0004，P1-2）：version 单调 + status；对旧库幂等
          ALTER TABLE ${this.schema}.ownership ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
          ALTER TABLE ${this.schema}.ownership ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
        `);
      });
    }
    return this.pool.connect();
  }

  private async withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }

  private q(table: "props" | "ownership"): string {
    return `${this.schema}.${table}`;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  async read(namespace: string, roleId: string, stageName: string): Promise<StoredProps | null> {
    const c = await this.client();
    try {
      const r = await c.query(
        `SELECT props_json, revision, schema_version FROM ${this.q("props")} WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
        [namespace, roleId, stageName],
      );
      if (r.rows.length === 0) return null;
      const row = r.rows[0] as { props_json: string; revision: string | number; schema_version: number };
      return {
        props: JSON.parse(row.props_json),
        revision: Number(row.revision),
        schemaVersion: Number(row.schema_version),
      };
    } finally {
      c.release();
    }
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
   * 行匹配但租约过期（存储时钟判定）→ "lease-expired"。异步：需回查所有权行与 DB 时钟。
   */
  private async rejectFencing(
    c: PoolClient,
    namespace: string,
    roleId: string,
    stageName: string,
    token: number,
  ): Promise<never> {
    const own = await c.query(
      `SELECT owner_id, epoch, lease_until FROM ${this.q("ownership")} WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
      [namespace, roleId, stageName],
    );
    const o = own.rows[0] as { owner_id: string; epoch: string; lease_until: string } | undefined;
    if (!o) {
      throw new ConflictError(
        `fencing 拒绝：所有权行缺失（${namespace}/${roleId}/${stageName}，token=${token}）——不能放行无所有者的写入（ADR 0002 I3）`,
        "fencing",
      );
    }
    const nowR = await c.query(`SELECT ${PG_DB_NOW_MS} AS db_now`);
    const dbNow = Number((nowR.rows[0] as { db_now: string }).db_now);
    if (Number(o.lease_until) <= dbNow) {
      throw new ConflictError(
        `fencing 拒绝：租约已过期（epoch=${o.epoch}，owner=${o.owner_id}，lease_until=${o.lease_until} <= db_now=${dbNow}）——持有资格失效（ADR 0002 I3）`,
        "lease-expired",
      );
    }
    throw new ConflictError(
      `fencing 拒绝：所有权 epoch=${o.epoch}（owner=${o.owner_id}）与写入 token=${token} 不匹配——旧持有者的写入被拒（ADR 0002 I3）`,
      "fencing",
    );
  }

  /** 所有权行是否对 (mode, owner, token) 有效（含 DB 时钟租约判定） */
  private async ownershipValid(
    c: PoolClient,
    namespace: string,
    roleId: string,
    stageName: string,
    mode: "pair" | "token",
    owner: string,
    token: number,
  ): Promise<boolean> {
    const own = await c.query(
      `SELECT owner_id, epoch, lease_until FROM ${this.q("ownership")} WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
      [namespace, roleId, stageName],
    );
    const o = own.rows[0] as { owner_id: string; epoch: string; lease_until: string } | undefined;
    if (!o) return false;
    if (mode === "pair" && o.owner_id !== owner) return false;
    if (Number(o.epoch) !== token) return false;
    const nowR = await c.query(`SELECT ${PG_DB_NOW_MS} AS db_now`);
    return Number(o.lease_until) > Number((nowR.rows[0] as { db_now: string }).db_now);
  }

  async create(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    schemaVersion: number,
    opts?: CreateOptions,
  ): Promise<StoredProps> {
    const c = await this.client();
    try {
      const mode = this.fencedMode(opts);
      const payload = JSON.stringify(props);
      if (mode === null) {
        const r = await c.query(
          `INSERT INTO ${this.q("props")} (namespace, role_id, stage_name, props_json, revision, schema_version)
           VALUES ($1, $2, $3, $4, 1, $5)
           ON CONFLICT (namespace, role_id, stage_name) DO NOTHING`,
          [namespace, roleId, stageName, payload, schemaVersion],
        );
        if (r.rowCount === 0) {
          throw new ConflictError(`记录已存在：${namespace}/${roleId}/${stageName}`, "exists");
        }
        return { props, revision: 1, schemaVersion };
      }
      // 条件插入（ADR 0002 I1）：所有权行有效才允许；失败必须分类（行缺失≠放行）
      const withOwner = mode === "pair";
      const r = await c.query(
        `INSERT INTO ${this.q("props")} (namespace, role_id, stage_name, props_json, revision, schema_version)
         SELECT $1, $2, $3, $4, 1, $5
         WHERE EXISTS (
           SELECT 1 FROM ${this.q("ownership")} o
           WHERE o.namespace = $1 AND o.role_id = $2 AND o.stage_name = $3
             ${withOwner ? "AND o.owner_id = $6" : ""}
             AND o.epoch = ${withOwner ? "$7" : "$6"} AND o.lease_until > ${PG_DB_NOW_MS}
         )
         ON CONFLICT (namespace, role_id, stage_name) DO NOTHING`,
        withOwner
          ? [namespace, roleId, stageName, payload, schemaVersion, opts!.fencingOwner!, opts!.fencingToken!]
          : [namespace, roleId, stageName, payload, schemaVersion, opts!.fencingToken!],
      );
      if (r.rowCount === 0) {
        if (!(await this.ownershipValid(c, namespace, roleId, stageName, mode, opts!.fencingOwner!, opts!.fencingToken!))) {
          await this.rejectFencing(c, namespace, roleId, stageName, opts!.fencingToken!);
        }
        throw new ConflictError(`记录已存在：${namespace}/${roleId}/${stageName}`, "exists");
      }
      return { props, revision: 1, schemaVersion };
    } finally {
      c.release();
    }
  }

  async write(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    opts: WriteOptions,
  ): Promise<StoredProps> {
    const c = await this.client();
    try {
      const mode = this.fencedMode(opts);
      const payload = JSON.stringify(props);
      const fencing =
        mode === "pair"
          ? ` AND EXISTS (
               SELECT 1 FROM ${this.q("ownership")} o
               WHERE o.namespace = props.namespace AND o.role_id = props.role_id AND o.stage_name = props.stage_name
                 AND o.owner_id = $7 AND o.epoch = $8 AND o.lease_until > ${PG_DB_NOW_MS}
             )`
          : mode === "token"
            ? ` AND EXISTS (
               SELECT 1 FROM ${this.q("ownership")} o
               WHERE o.namespace = props.namespace AND o.role_id = props.role_id AND o.stage_name = props.stage_name
                 AND o.epoch = $7 AND o.lease_until > ${PG_DB_NOW_MS}
             )`
            : "";
      const params: unknown[] =
        mode === "pair"
          ? [payload, opts.schemaVersion, namespace, roleId, stageName, opts.expectedRevision, opts.fencingOwner!, opts.fencingToken!]
          : mode === "token"
            ? [payload, opts.schemaVersion, namespace, roleId, stageName, opts.expectedRevision, opts.fencingToken!]
            : [payload, opts.schemaVersion, namespace, roleId, stageName, opts.expectedRevision];
      const r = await c.query(
        `UPDATE ${this.q("props")} SET props_json = $1, revision = revision + 1, schema_version = $2
         WHERE namespace = $3 AND role_id = $4 AND stage_name = $5 AND revision = $6${fencing}`,
        params,
      );
      if (r.rowCount === 0) {
        // 分类顺序（ADR 0002 §7）：资格失败（fencing/lease-expired）优先于 revision 冲突
        if (mode !== null && !(await this.ownershipValid(c, namespace, roleId, stageName, mode, opts.fencingOwner!, opts.fencingToken!))) {
          await this.rejectFencing(c, namespace, roleId, stageName, opts.fencingToken!);
        }
        const cur = await c.query(
          `SELECT revision FROM ${this.q("props")} WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
          [namespace, roleId, stageName],
        );
        if (cur.rows.length === 0) {
          throw new ConflictError(
            `记录不存在（期望 revision=${opts.expectedRevision}）：${namespace}/${roleId}/${stageName}；首次写入应使用 create`,
            "revision",
          );
        }
        throw new ConflictError(
          `CAS 冲突：期望 revision=${opts.expectedRevision}，实际 revision=${cur.rows[0].revision}（${namespace}/${roleId}/${stageName}）`,
          "revision",
        );
      }
      return { props, revision: opts.expectedRevision + 1, schemaVersion: opts.schemaVersion };
    } finally {
      c.release();
    }
  }

  async delete(
    namespace: string,
    roleId: string,
    stageName: string,
    opts?: { fencingToken?: number; fencingOwner?: string },
  ): Promise<void> {
    const c = await this.client();
    try {
      const mode = this.fencedMode(opts);
      if (mode === null) {
        await c.query(
          `DELETE FROM ${this.q("props")} WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
          [namespace, roleId, stageName],
        );
        return;
      }
      const withOwner = mode === "pair";
      const r = await c.query(
        `DELETE FROM ${this.q("props")}
         WHERE namespace = $1 AND role_id = $2 AND stage_name = $3
           AND EXISTS (
             SELECT 1 FROM ${this.q("ownership")} o
             WHERE o.namespace = $1 AND o.role_id = $2 AND o.stage_name = $3
               ${withOwner ? "AND o.owner_id = $4" : ""}
               AND o.epoch = ${withOwner ? "$5" : "$4"} AND o.lease_until > ${PG_DB_NOW_MS}
           )`,
        withOwner
          ? [namespace, roleId, stageName, opts!.fencingOwner!, opts!.fencingToken!]
          : [namespace, roleId, stageName, opts!.fencingToken!],
      );
      if (r.rowCount === 0) {
        await this.rejectFencing(c, namespace, roleId, stageName, opts!.fencingToken!);
      }
    } finally {
      c.release();
    }
  }

  // ---- 所有权（DESIGN §6.5，M3）与目录（ADR 0004，P1-2）----

  /** 目录 claim（原 acquire 语义 + version 单调 + status 维护；tombstone 可重建） */
  async claim(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<DirectoryClaimResult> {
    const c = await this.client();
    try {
      // 单语句原子：插入或（过期顶替 epoch+1 / 本人续租 / tombstone 重建）；租约边界以 PG 时钟为准
      const r = await c.query(
        `INSERT INTO ${this.q("ownership")} (namespace, role_id, stage_name, owner_id, epoch, lease_until, version, status)
         VALUES ($1, $2, $3, $4, 1, ${PG_DB_NOW_MS} + $5, 1, 'active')
         ON CONFLICT (namespace, role_id, stage_name) DO UPDATE SET
           owner_id = CASE WHEN ${this.q("ownership")}.owner_id = EXCLUDED.owner_id
                           OR ${this.q("ownership")}.lease_until <= ${PG_DB_NOW_MS}
                      THEN EXCLUDED.owner_id ELSE ${this.q("ownership")}.owner_id END,
           epoch = CASE WHEN ${this.q("ownership")}.owner_id = EXCLUDED.owner_id
                          THEN ${this.q("ownership")}.epoch
                        WHEN ${this.q("ownership")}.lease_until <= ${PG_DB_NOW_MS}
                          THEN ${this.q("ownership")}.epoch + 1
                        ELSE ${this.q("ownership")}.epoch END,
           lease_until = CASE WHEN ${this.q("ownership")}.owner_id = EXCLUDED.owner_id
                                 OR ${this.q("ownership")}.lease_until <= ${PG_DB_NOW_MS}
                            THEN EXCLUDED.lease_until
                            ELSE ${this.q("ownership")}.lease_until END,
           status = CASE WHEN ${this.q("ownership")}.lease_until <= ${PG_DB_NOW_MS}
                              OR ${this.q("ownership")}.owner_id = EXCLUDED.owner_id
                         THEN 'active' ELSE ${this.q("ownership")}.status END,
           version = ${this.q("ownership")}.version + 1
         RETURNING owner_id, epoch, lease_until, version, status`,
        [namespace, roleId, stageName, ownerId, leaseMs],
      );
      const row = r.rows[0] as {
        owner_id: string;
        epoch: string;
        lease_until: string;
        version: string;
        status: string;
      };
      if (row.owner_id === ownerId) {
        return {
          ok: true,
          epoch: Number(row.epoch),
          leaseUntil: Number(row.lease_until),
          version: Number(row.version),
        };
      }
      return {
        ok: false,
        holder: {
          namespace,
          roleId,
          stageName,
          ownerId: row.owner_id,
          epoch: Number(row.epoch),
          leaseUntil: Number(row.lease_until),
          version: Number(row.version),
          status: row.status as DirectoryRecord["status"],
        },
      };
    } finally {
      c.release();
    }
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
    const { namespace: _n, roleId: _r, stageName: _s, ...holder } = r.holder;
    return { ok: false, holder };
  }

  async lookup(
    namespace: string,
    roleId: string,
    stageName: string,
  ): Promise<DirectoryRecord | null> {
    const c = await this.client();
    try {
      const r = await c.query(
        `SELECT owner_id, epoch, lease_until, version, status FROM ${this.q("ownership")}
         WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
        [namespace, roleId, stageName],
      );
      if (r.rows.length === 0) return null;
      const row = r.rows[0] as {
        owner_id: string;
        epoch: string;
        lease_until: string;
        version: string;
        status: string;
      };
      return {
        namespace,
        roleId,
        stageName,
        ownerId: row.owner_id,
        epoch: Number(row.epoch),
        leaseUntil: Number(row.lease_until),
        version: Number(row.version),
        status: row.status as DirectoryRecord["status"],
      };
    } finally {
      c.release();
    }
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
    const c = await this.client();
    try {
      // 不删行：置空租约 + draining（交接/停服语义）——epoch 必须跨释放单调，version 推进缓存失效
      const r = await c.query(
        `UPDATE ${this.q("ownership")} SET lease_until = 0, status = 'draining', version = version + 1
         WHERE namespace = $1 AND role_id = $2 AND stage_name = $3 AND owner_id = $4 AND epoch = $5`,
        [namespace, roleId, stageName, ownerId, epoch],
      );
      return (r.rowCount ?? 0) === 1;
    } finally {
      c.release();
    }
  }

  async bumpVersion(namespace: string, roleId: string, stageName: string): Promise<number | null> {
    const c = await this.client();
    try {
      const r = await c.query(
        `UPDATE ${this.q("ownership")} SET version = version + 1
         WHERE namespace = $1 AND role_id = $2 AND stage_name = $3
         RETURNING version`,
        [namespace, roleId, stageName],
      );
      if (r.rowCount === 0) return null;
      return Number((r.rows[0] as { version: string }).version);
    } finally {
      c.release();
    }
  }

  async listOwned(ownerIdPrefix: string): Promise<DirectoryRecord[]> {
    const c = await this.client();
    try {
      // owner_id = addr#incarnation：按 addr 前缀匹配（重启即新 incarnation，恢复扫描用）
      const r = await c.query(
        `SELECT namespace, role_id, stage_name, owner_id, epoch, lease_until, version, status
         FROM ${this.q("ownership")} WHERE owner_id LIKE $1 || '#%'`,
        [ownerIdPrefix],
      );
      return (r.rows as Array<Record<string, string>>).map((row) => ({
        namespace: row.namespace,
        roleId: row.role_id,
        stageName: row.stage_name,
        ownerId: row.owner_id,
        epoch: Number(row.epoch),
        leaseUntil: Number(row.lease_until),
        version: Number(row.version),
        status: row.status as DirectoryRecord["status"],
      }));
    } finally {
      c.release();
    }
  }
}
