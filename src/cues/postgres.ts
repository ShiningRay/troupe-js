import type { Pool, PoolClient } from "pg";
import type { CueStore, ReminderKey, ReminderRecord } from "./cue-store.js";
import { cloneReminderPayload } from "./cue-store.js";
import type { StoreCapabilities } from "../props/capabilities.js";

/**
 * 持久提醒的 PostgreSQL 实现（ROADMAP P1-5；DESIGN §7.5）：
 * - `due` 用 `FOR UPDATE SKIP LOCKED` 短事务读候选，跨进程不重复取同一批
 * - `claim` 单语句 CAS（`lease_until <= now`，DB 时钟域，ADR 0002 §5 同源）
 * - `complete` 用 `statusVersion` CAS；nextDue=null 表示一次性完成（删除记录）
 * - capabilities（ADR 0002 §8）：crossNodeSafe=true——production + cues 的合规 Provider
 * 选择：Troupe.form({ cues: { store: new PostgresCueStore("postgres://…") } })
 */
interface CueRow {
  namespace: string;
  role_id: string;
  stage_name: string;
  name: string;
  payload_json: string;
  every_ms: string | number | null;
  at_ms: string | number | null;
  cron: string | null;
  next_due: string | number;
  status_version: string | number;
  lease_until: string | number;
  owner: string | null;
  time_zone: string | null;
}

const num = (v: string | number | null): number | null =>
  v === null || v === undefined ? null : Number(v);

export class PostgresCueStore implements CueStore {
  readonly capabilities: StoreCapabilities = { crossNodeSafe: true, supportsFencing: true };

  private pool: Pool | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly schema = "public",
  ) {}

  private async client(): Promise<PoolClient> {
    if (!this.pool) {
      const { Pool } = await import("pg");
      this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
      const c = await this.pool.connect();
      try {
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await c.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.cues (
            namespace      TEXT    NOT NULL,
            role_id        TEXT    NOT NULL,
            stage_name     TEXT    NOT NULL,
            name           TEXT    NOT NULL,
            payload_json   TEXT    NOT NULL,
            every_ms       BIGINT,
            at_ms          BIGINT,
            cron           TEXT,
            time_zone      TEXT,
            next_due       BIGINT  NOT NULL,
            status_version BIGINT  NOT NULL,
            lease_until    BIGINT  NOT NULL,
            owner          TEXT,
            PRIMARY KEY (namespace, role_id, stage_name, name)
          );
          CREATE INDEX IF NOT EXISTS cues_next_due ON ${this.schema}.cues (next_due);
        `);
      } finally {
        c.release();
      }
    }
    return this.pool.connect();
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private toRecord(row: CueRow): ReminderRecord {
    return {
      namespace: row.namespace,
      roleId: row.role_id,
      stageName: row.stage_name,
      name: row.name,
      payload: JSON.parse(row.payload_json),
      everyMs: num(row.every_ms),
      at: num(row.at_ms),
      cron: row.cron ?? null,
      timeZone: row.time_zone ?? null,
      nextDue: Number(row.next_due),
      statusVersion: Number(row.status_version),
      leaseUntil: Number(row.lease_until),
      owner: row.owner,
    };
  }

  private cols(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): unknown[] {
    return [
      rec.namespace, rec.roleId, rec.stageName, rec.name,
      JSON.stringify(cloneReminderPayload(rec.payload)),
      rec.everyMs, rec.at, rec.cron, rec.timeZone ?? null, rec.nextDue,
    ];
  }

  async upsert(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): Promise<void> {
    const c = await this.client();
    try {
      await c.query(
        `INSERT INTO ${this.schema}.cues
           (namespace, role_id, stage_name, name, payload_json, every_ms, at_ms, cron, time_zone, next_due, status_version, lease_until, owner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, 1, 0, NULL)
         ON CONFLICT (namespace, role_id, stage_name, name) DO UPDATE SET
           payload_json = excluded.payload_json,
           every_ms = excluded.every_ms,
           at_ms = excluded.at_ms,
           cron = excluded.cron,
           time_zone = excluded.time_zone,
           next_due = excluded.next_due,
           status_version = ${this.schema}.cues.status_version + 1,
           lease_until = 0,
           owner = NULL`,
        this.cols(rec),
      );
    } finally {
      c.release();
    }
  }

  async ensure(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): Promise<void> {
    const c = await this.client();
    try {
      await c.query(
        `INSERT INTO ${this.schema}.cues
           (namespace, role_id, stage_name, name, payload_json, every_ms, at_ms, cron, time_zone, next_due, status_version, lease_until, owner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, 1, 0, NULL)
         ON CONFLICT (namespace, role_id, stage_name, name) DO NOTHING`,
        this.cols(rec),
      );
    } finally {
      c.release();
    }
  }

  async delete(key: ReminderKey): Promise<boolean> {
    const c = await this.client();
    try {
      const r = await c.query(
        `DELETE FROM ${this.schema}.cues WHERE namespace=$1 AND role_id=$2 AND stage_name=$3 AND name=$4`,
        [key.namespace, key.roleId, key.stageName, key.name],
      );
      return (r.rowCount ?? 0) === 1;
    } finally {
      c.release();
    }
  }

  /** 到期候选：FOR UPDATE SKIP LOCKED 短事务（行锁随事务结束释放，真仲裁在 claim CAS） */
  async due(now: number, limit: number): Promise<ReminderRecord[]> {
    const c = await this.client();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        `SELECT * FROM ${this.schema}.cues
         WHERE next_due <= $1 AND lease_until <= $1
         ORDER BY next_due
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      await c.query("COMMIT");
      return (r.rows as CueRow[]).map((row) => this.toRecord(row));
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async claim(
    key: ReminderKey,
    owner: string,
    leaseUntil: number,
    now: number,
  ): Promise<ReminderRecord | null> {
    const c = await this.client();
    try {
      const r = await c.query(
        `UPDATE ${this.schema}.cues SET owner=$1, lease_until=$2, status_version = status_version + 1
         WHERE namespace=$3 AND role_id=$4 AND stage_name=$5 AND name=$6 AND lease_until <= $7
         RETURNING *`,
        [owner, leaseUntil, key.namespace, key.roleId, key.stageName, key.name, now],
      );
      if (r.rowCount === 0) return null;
      return this.toRecord(r.rows[0] as CueRow);
    } finally {
      c.release();
    }
  }

  async complete(
    key: ReminderKey,
    expectedStatusVersion: number,
    nextDue: number | null,
  ): Promise<boolean> {
    const c = await this.client();
    try {
      if (nextDue === null) {
        const r = await c.query(
          `DELETE FROM ${this.schema}.cues
           WHERE namespace=$1 AND role_id=$2 AND stage_name=$3 AND name=$4 AND status_version=$5`,
          [key.namespace, key.roleId, key.stageName, key.name, expectedStatusVersion],
        );
        return (r.rowCount ?? 0) === 1;
      }
      const r = await c.query(
        `UPDATE ${this.schema}.cues SET next_due=$1, lease_until=0, owner=NULL
         WHERE namespace=$2 AND role_id=$3 AND stage_name=$4 AND name=$5 AND status_version=$6`,
        [nextDue, key.namespace, key.roleId, key.stageName, key.name, expectedStatusVersion],
      );
      return (r.rowCount ?? 0) === 1;
    } finally {
      c.release();
    }
  }

  async list(namespace: string): Promise<ReminderRecord[]> {
    const c = await this.client();
    try {
      const r = await c.query(
        `SELECT * FROM ${this.schema}.cues WHERE namespace=$1 ORDER BY next_due`,
        [namespace],
      );
      return (r.rows as CueRow[]).map((row) => this.toRecord(row));
    } finally {
      c.release();
    }
  }
}
