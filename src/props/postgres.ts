import { ConflictError } from "../core/errors.js";
import type { PropStore, StoredProps, WriteOptions } from "./prop-store.js";
import type { AcquireResult, OwnershipRecord, OwnershipStore } from "./ownership.js";
// pg 为可选 peer 依赖：仅在选用 PostgresPropStore 时需要安装（PLAN §5）
import { Pool, type PoolClient } from "pg";

/**
 * 节点级共享持久化（DESIGN §7.2，M3）：PostgresPropStore。
 * - 行级 CAS（单条 UPDATE ... WHERE revision = ?）
 * - write 携 fencingToken 时在同一语句内校验所有权 epoch（§6.5，旧持有者写入被拒）
 * - 所有权 acquire/续租/顶替/释放均为单语句原子操作（依赖行锁）
 * 选择：Troupe.form({ propStore: new PostgresPropStore("postgres://…") })
 */
export class PostgresPropStore implements PropStore, OwnershipStore {
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

  async create(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    schemaVersion: number,
  ): Promise<StoredProps> {
    const c = await this.client();
    try {
      const r = await c.query(
        `INSERT INTO ${this.q("props")} (namespace, role_id, stage_name, props_json, revision, schema_version)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (namespace, role_id, stage_name) DO NOTHING`,
        [namespace, roleId, stageName, JSON.stringify(props), schemaVersion],
      );
      if (r.rowCount === 0) {
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
      const fencing = opts.fencingToken !== undefined
        ? ` AND NOT EXISTS (
             SELECT 1 FROM ${this.q("ownership")} o
             WHERE o.namespace = $3 AND o.role_id = $4 AND o.stage_name = $5 AND o.epoch > $7
           )`
        : "";
      const params: unknown[] = [
        JSON.stringify(props),
        opts.schemaVersion,
        namespace,
        roleId,
        stageName,
        opts.expectedRevision,
      ];
      if (opts.fencingToken !== undefined) {
        params.push(opts.fencingToken);
      }
      const r = await c.query(
        `UPDATE ${this.q("props")} SET props_json = $1, revision = revision + 1, schema_version = $2
         WHERE namespace = $3 AND role_id = $4 AND stage_name = $5 AND revision = $6${fencing}`,
        params,
      );
      if (r.rowCount === 0) {
        if (opts.fencingToken !== undefined) {
          const own = await c.query(
            `SELECT owner_id, epoch FROM ${this.q("ownership")} WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
            [namespace, roleId, stageName],
          );
          const o = own.rows[0] as { owner_id: string; epoch: string } | undefined;
          if (o && Number(o.epoch) > opts.fencingToken) {
            throw new ConflictError(
              `fencing 拒绝：所有权 epoch=${o.epoch}（owner=${o.owner_id}）> 写入 token=${opts.fencingToken}——旧持有者的写入被拒（DESIGN §6.5）`,
              "revision",
            );
          }
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

  async delete(namespace: string, roleId: string, stageName: string): Promise<void> {
    const c = await this.client();
    try {
      await c.query(
        `DELETE FROM ${this.q("props")} WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
        [namespace, roleId, stageName],
      );
    } finally {
      c.release();
    }
  }

  // ---- 所有权（DESIGN §6.5，M3）----

  async acquire(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<AcquireResult> {
    const c = await this.client();
    try {
      const now = Date.now();
      const until = now + leaseMs;
      // 单语句原子：插入或（过期顶替 epoch+1 / 本人续租）
      const r = await c.query(
        `INSERT INTO ${this.q("ownership")} (namespace, role_id, stage_name, owner_id, epoch, lease_until)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (namespace, role_id, stage_name) DO UPDATE SET
           owner_id = CASE WHEN ${this.q("ownership")}.owner_id = EXCLUDED.owner_id
                           OR ${this.q("ownership")}.lease_until <= $6
                      THEN EXCLUDED.owner_id ELSE ${this.q("ownership")}.owner_id END,
           epoch = CASE WHEN ${this.q("ownership")}.owner_id = EXCLUDED.owner_id
                          THEN ${this.q("ownership")}.epoch
                        WHEN ${this.q("ownership")}.lease_until <= $6
                          THEN ${this.q("ownership")}.epoch + 1
                        ELSE ${this.q("ownership")}.epoch END,
           lease_until = CASE WHEN ${this.q("ownership")}.owner_id = EXCLUDED.owner_id
                                 OR ${this.q("ownership")}.lease_until <= $6
                            THEN EXCLUDED.lease_until
                            ELSE ${this.q("ownership")}.lease_until END
         RETURNING owner_id, epoch, lease_until`,
        [namespace, roleId, stageName, ownerId, until, now],
      );
      const row = r.rows[0] as { owner_id: string; epoch: string; lease_until: string };
      if (row.owner_id === ownerId) {
        return { ok: true, epoch: Number(row.epoch) };
      }
      return {
        ok: false,
        holder: { ownerId: row.owner_id, epoch: Number(row.epoch), leaseUntil: Number(row.lease_until) },
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
    const c = await this.client();
    try {
      const r = await c.query(
        `SELECT owner_id, epoch, lease_until FROM ${this.q("ownership")}
         WHERE namespace = $1 AND role_id = $2 AND stage_name = $3`,
        [namespace, roleId, stageName],
      );
      if (r.rows.length === 0) return null;
      const row = r.rows[0] as { owner_id: string; epoch: string; lease_until: string };
      return { ownerId: row.owner_id, epoch: Number(row.epoch), leaseUntil: Number(row.lease_until) };
    } finally {
      c.release();
    }
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
      // 不删行：置空租约——epoch 必须跨释放单调（否则旧持有者的 token 可通过 fencing）
      const r = await c.query(
        `UPDATE ${this.q("ownership")} SET lease_until = 0
         WHERE namespace = $1 AND role_id = $2 AND stage_name = $3 AND owner_id = $4 AND epoch = $5`,
        [namespace, roleId, stageName, ownerId, epoch],
      );
      return (r.rowCount ?? 0) === 1;
    } finally {
      c.release();
    }
  }
}
