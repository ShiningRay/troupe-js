import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PostgresPropStore } from "../props/postgres.js";
import type { CreateOptions, StoredProps, WriteOptions } from "../props/prop-store.js";
import { TroupeError } from "../core/errors.js";

/**
 * 事务性 Outbox / Inbox（ADR 0005 §4，ROADMAP P2-4）：
 * - `appendInTx` 在调用方事务内写 outbox 行——与 Props 的 CAS 写组合
 *   （`PostgresPropStore.withTransaction` + `writeWithClient/createWithClient`），
 *   "Props 提交后 outbox 必存在；任一步失败整体回滚"。
 * - dispatcher：`claimBatch` 用 FOR UPDATE SKIP LOCKED + lease 派发；失败退避重试，
 *   超过 maxAttempts 转 dead（显式可查，不静默丢弃）。
 * - Inbox：接收方幂等（`recordIfNew` 与业务写入同事务；同 eventId 只处理一次）。
 * 顺序：单 worker 按 outbox id（≈时间序）派发才承诺 per-topic 顺序；无全局顺序（ADR §4）。
 * epoch 不参与硬丢弃（派出方身份与数据无关，仅观测）。
 */
export interface OutboxMessage {
  id: string;
  topic: string;
  eventId: string;
  event: unknown;
}

export interface OutboxClaimed extends OutboxMessage {
  attempts: number;
}

export interface OutboxStats {
  pending: number;
  leased: number;
  dead: number;
}

export interface OutboxPublishOptions {
  /** Props CAS 写参数（可选：纯发布不落 Props） */
  props?: {
    namespace: string;
    roleId: string;
    stageName: string;
    props: unknown;
    /** 已存在记录：CAS 写（必填 expectedRevision/schemaVersion） */
    write?: WriteOptions;
    /** 首次创建：schemaVersion + 可选 fencing */
    create?: CreateOptions & { schemaVersion: number };
  };
  eventId?: string;
}

/** 退避：attempts 次失败后 next_attempt = now + min(1s * 2^(attempts-1), 60s) */
function backoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), 60_000);
}

export class PostgresOutboxStore {
  private pool: import("pg").Pool | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly schema = "public",
    /** maxAttempts 次失败后转 dead（默认 8） */
    private readonly maxAttempts = 8,
  ) {}

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private async poolReady(): Promise<NonNullable<typeof this.pool>> {
    if (!this.pool) {
      const { Pool } = await import("pg");
      this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
      const c = await this.pool.connect();
      try {
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await c.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.outbox (
            id          TEXT PRIMARY KEY,
            topic       TEXT NOT NULL,
            event_id    TEXT NOT NULL,
            payload     TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'pending',
            attempts    INT  NOT NULL DEFAULT 0,
            next_attempt_at BIGINT NOT NULL DEFAULT 0,
            lease_until BIGINT NOT NULL DEFAULT 0,
            owner       TEXT,
            created_at  BIGINT NOT NULL,
            UNIQUE (topic, event_id)
          );
          CREATE INDEX IF NOT EXISTS outbox_pending ON ${this.schema}.outbox (next_attempt_at) WHERE status = 'pending';
          CREATE TABLE IF NOT EXISTS ${this.schema}.inbox (
            topic     TEXT NOT NULL,
            event_id  TEXT NOT NULL,
            processed_at BIGINT NOT NULL,
            PRIMARY KEY (topic, event_id)
          );
        `);
      } finally {
        c.release();
      }
    }
    return this.pool;
  }

  private q(table: "outbox" | "inbox"): string {
    return `${this.schema}.${table}`;
  }

  /** 独立发布（无 Props 耦合；eventId 缺省 UUID） */
  async append(topic: string, event: unknown, opts?: { eventId?: string }): Promise<string> {
    const p = await this.poolReady();
    const c = await p.connect();
    try {
      return await this.appendInTx(c, topic, event, opts);
    } finally {
      c.release();
    }
  }

  /**
   * 调用方事务内写 outbox 行（P2-4 核心）：与 `PostgresPropStore.withTransaction`
   * 组合实现同事务提交。eventId 冲突 → 幂等（返回既有 eventId，不报错）。
   */
  async appendInTx(
    c: PoolClient,
    topic: string,
    event: unknown,
    opts?: { eventId?: string },
  ): Promise<string> {
    const eventId = opts?.eventId ?? randomUUID();
    await c.query(
      `INSERT INTO ${this.q("outbox")} (id, topic, event_id, payload, status, attempts, next_attempt_at, lease_until, owner, created_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, 0, 0, NULL, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
       ON CONFLICT (topic, event_id) DO NOTHING`,
      [randomUUID(), topic, eventId, JSON.stringify(event ?? null)],
    );
    return eventId;
  }

  /**
   * Props + Outbox 同事务（P2-4 验收："Props 提交后 outbox 必存在"）：
   * Props CAS 写（含 fencing，ADR 0002 I1/I3）与 outbox 行原子提交；
   * 任一步失败整体回滚（outbox 失败则 Props 不落盘）。
   */
  async publishWithProps(
    propStore: PostgresPropStore,
    topic: string,
    event: unknown,
    opts: OutboxPublishOptions = {},
  ): Promise<{ props: StoredProps | null; eventId: string }> {
    if (!propStore.withTransaction) {
      throw new TroupeError("publishWithProps 需要 PostgresPropStore（withTransaction 支持，ADR 0005 §4）");
    }
    const eventId = opts.eventId ?? randomUUID();
    await this.poolReady(); // DDL 先行：事务内用的是 propStore 的连接
    return propStore.withTransaction(async (c) => {
      await this.appendInTx(c, topic, event, { eventId });
      let props: StoredProps | null = null;
      const p = opts.props;
      if (p) {
        props =
          p.write !== undefined
            ? await propStore.writeWithClient(c, p.namespace, p.roleId, p.stageName, p.props, p.write)
            : await propStore.createWithClient(c, p.namespace, p.roleId, p.stageName, p.props, p.create!.schemaVersion, p.create);
      }
      return { props, eventId };
    });
  }

  /** dispatcher 派发：FOR UPDATE SKIP LOCKED + lease（宕机后租约到期自动重派） */
  async claimBatch(workerId: string, limit: number, leaseMs: number): Promise<OutboxClaimed[]> {
    const p = await this.poolReady();
    const c = await p.connect();
    try {
      await c.query("BEGIN");
      const now = `(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint`;
      // 派发资格只由租约判定（ADR 0005 §4 宕机重派）：pending（lease=0）可派；
      // leased 且租约到期（worker 不 markDone 即宕机）→ 重新可派。status 由 UPDATE 重置。
      const r = await c.query(
        `SELECT id, topic, event_id, payload, attempts FROM ${this.q("outbox")}
         WHERE next_attempt_at <= ${now} AND lease_until <= ${now}
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const ids = (r.rows as Array<{ id: string }>).map((row) => row.id);
      let claimed: OutboxClaimed[] = [];
      if (ids.length > 0) {
        const u = await c.query(
          `UPDATE ${this.q("outbox")} SET status = 'leased', lease_until = ${now} + $1, owner = $2
           WHERE id = ANY($3::text[])
           RETURNING id, topic, event_id, payload, attempts`,
          [leaseMs, workerId, ids],
        );
        claimed = (u.rows as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id),
          topic: String(row.topic),
          eventId: String(row.event_id),
          event: JSON.parse(String(row.payload)),
          attempts: Number(row.attempts),
        }));
      }
      await c.query("COMMIT");
      return claimed;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** 派发成功 */
  async markDone(id: string): Promise<void> {
    const p = await this.poolReady();
    const c = await p.connect();
    try {
      await c.query(`UPDATE ${this.q("outbox")} SET status = 'done' WHERE id = $1`, [id]);
    } finally {
      c.release();
    }
  }

  /** 派发失败：退避重试；超过 maxAttempts 转 dead */
  async markRetry(id: string, error: unknown): Promise<{ dead: boolean; attempts: number }> {
    const p = await this.poolReady();
    const c = await p.connect();
    try {
      const r = await c.query(
        `UPDATE ${this.q("outbox")}
         SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= $2 THEN 'dead' ELSE 'pending' END,
             next_attempt_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + $3,
             lease_until = 0,
             owner = NULL
         WHERE id = $1
         RETURNING status, attempts`,
        [id, this.maxAttempts, backoffMs(1)],
      );
      const row = r.rows[0] as { status: string; attempts: string | number } | undefined;
      if (!row) throw new TroupeError(`outbox markRetry：行不存在 id=${id}`);
      void error;
      return { dead: row.status === "dead", attempts: Number(row.attempts) };
    } finally {
      c.release();
    }
  }

  /** 观测：backlog（pending+leased）、重试中、dead */
  async stats(): Promise<OutboxStats> {
    const p = await this.poolReady();
    const c = await p.connect();
    try {
      const r = await c.query(
        `SELECT status, COUNT(*) AS n FROM ${this.q("outbox")} GROUP BY status`,
      );
      const by = new Map<string, number>(
        (r.rows as Array<{ status: string; n: string | number }>).map((row) => [row.status, Number(row.n)]),
      );
      return { pending: by.get("pending") ?? 0, leased: by.get("leased") ?? 0, dead: by.get("dead") ?? 0 };
    } finally {
      c.release();
    }
  }

  /** Inbox 幂等（接收方）：返回 true = 首次（应处理）；false = 重复（跳过）。与业务写入同事务时传入 c */
  async recordIfNew(topic: string, eventId: string, c?: PoolClient): Promise<boolean> {
    const p = await this.poolReady();
    const conn = c ?? (await p.connect());
    try {
      const r = await conn.query(
        `INSERT INTO ${this.q("inbox")} (topic, event_id, processed_at)
         VALUES ($1, $2, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
         ON CONFLICT (topic, event_id) DO NOTHING
         RETURNING topic`,
        [topic, eventId],
      );
      return (r.rowCount ?? 0) === 1;
    } finally {
      if (!c) conn.release();
    }
  }
}
