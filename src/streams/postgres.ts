import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ConflictError, RetentionExceededError, TroupeError } from "../core/errors.js";
import type {
  StreamAppendResult,
  StreamCursor,
  StreamMessage,
  StreamStore,
} from "./stream-store.js";

/**
 * Stream 的 PostgreSQL 实现（ADR 0005 §2，ROADMAP P2-2）：
 * - `stream_topics(topic, next_seq)`：append 用单语句 `INSERT … ON CONFLICT DO UPDATE
 *   SET next_seq = next_seq + 1 RETURNING next_seq - 1` 原子分配 per-topic seq；
 * - `stream_events(topic, seq, event_id, payload, created_at)`：`UNIQUE(topic, event_id)`
 *   做幂等发布（冲突时读回既有行）；created_at 为 DB 时钟域；
 * - `stream_cursors(topic, consumer, acked_seq)`：ack/replay 的游标 CAS（只前进/只后退）。
 * 三表 DDL 幂等（CREATE TABLE IF NOT EXISTS）；时区/时钟与 CueStore 同为 DB 域（ADR 0002 §5）。
 */
interface EventRow {
  seq: string | number;
  event_id: string;
  payload: string;
  created_at: string | number;
}

export class PostgresStreamStore implements StreamStore {
  private pool: Pool | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly schema = "public",
  ) {}

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private async client(): Promise<PoolClient> {
    if (!this.pool) {
      const { Pool } = await import("pg");
      this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
      const c = await this.pool.connect();
      try {
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await c.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.stream_topics (
            topic    TEXT   NOT NULL PRIMARY KEY,
            next_seq BIGINT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS ${this.schema}.stream_events (
            topic      TEXT   NOT NULL,
            seq        BIGINT NOT NULL,
            event_id   TEXT   NOT NULL,
            payload    TEXT   NOT NULL,
            created_at BIGINT NOT NULL,
            PRIMARY KEY (topic, seq),
            UNIQUE (topic, event_id)
          );
          CREATE TABLE IF NOT EXISTS ${this.schema}.stream_cursors (
            topic     TEXT   NOT NULL,
            consumer  TEXT   NOT NULL,
            acked_seq BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (topic, consumer)
          );
        `);
      } finally {
        c.release();
      }
    }
    return this.pool.connect();
  }

  private q(table: "stream_topics" | "stream_events" | "stream_cursors"): string {
    return `${this.schema}.${table}`;
  }

  async append(topic: string, event: unknown, opts?: { eventId?: string }): Promise<StreamAppendResult> {
    const eventId = opts?.eventId ?? randomUUID();
    const c = await this.client();
    try {
      // 单语句：原子分配 seq + 插入；eventId 冲突 → 无返回行 → 读回既有
      const r = await c.query(
        `WITH s AS (
           INSERT INTO ${this.q("stream_topics")} (topic, next_seq) VALUES ($1, 2)
           ON CONFLICT (topic) DO UPDATE SET next_seq = ${this.q("stream_topics")}.next_seq + 1
           RETURNING next_seq - 1 AS seq
         )
         INSERT INTO ${this.q("stream_events")} (topic, seq, event_id, payload, created_at)
         SELECT $1, s.seq, $2, $3, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint FROM s
         ON CONFLICT (topic, event_id) DO NOTHING
         RETURNING seq, event_id`,
        [topic, eventId, JSON.stringify(event ?? null)],
      );
      if (r.rowCount !== 0) {
        const row = r.rows[0] as { seq: string | number; event_id: string };
        return { seq: Number(row.seq), eventId: row.event_id };
      }
      // 幂等：同 eventId 已存在 → 返回原 seq
      const existing = await c.query(
        `SELECT seq, event_id FROM ${this.q("stream_events")} WHERE topic = $1 AND event_id = $2`,
        [topic, eventId],
      );
      if (existing.rowCount === 0) {
        throw new TroupeError(`stream append 异常：eventId=${eventId} 冲突但读回为空（${topic}）`);
      }
      const row = existing.rows[0] as { seq: string | number; event_id: string };
      return { seq: Number(row.seq), eventId: row.event_id };
    } finally {
      c.release();
    }
  }

  async read(topic: string, afterSeq: number, limit: number): Promise<StreamMessage[]> {
    const c = await this.client();
    try {
      const bounds = await c.query(
        `SELECT MIN(seq) AS min_seq, COUNT(*) AS cnt FROM ${this.q("stream_events")} WHERE topic = $1`,
        [topic],
      );
      const row = bounds.rows[0] as { min_seq: string | number | null; cnt: string | number };
      const cnt = Number(row.cnt);
      if (cnt > 0) {
        const minSeq = Number(row.min_seq);
        if (afterSeq + 1 < minSeq) {
          // 请求区间含已裁剪段：显式失败（不静默跳读，ADR 0005 §2）
          throw new RetentionExceededError(
            `stream ${topic}：请求 afterSeq=${afterSeq} 落入已裁剪段（最早保留 seq=${minSeq}）——请显式重置消费位`,
          );
        }
      }
      const r = await c.query(
        `SELECT seq, event_id, payload, created_at FROM ${this.q("stream_events")}
         WHERE topic = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
        [topic, afterSeq, limit],
      );
      return (r.rows as EventRow[]).map((row) => ({
        seq: Number(row.seq),
        eventId: row.event_id,
        event: JSON.parse(row.payload),
        createdAt: Number(row.created_at),
      }));
    } finally {
      c.release();
    }
  }

  async ack(topic: string, consumer: string, seq: number): Promise<void> {
    const c = await this.client();
    try {
      // 只前进：acked_seq < seq 才更新；同值幂等；回退 → 读回当前 → ConflictError
      const r = await c.query(
        `INSERT INTO ${this.q("stream_cursors")} (topic, consumer, acked_seq, updated_at)
         VALUES ($1, $2, $3, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
         ON CONFLICT (topic, consumer) DO UPDATE SET
           acked_seq = EXCLUDED.acked_seq,
           updated_at = EXCLUDED.updated_at
         WHERE ${this.q("stream_cursors")}.acked_seq < $3`,
        [topic, consumer, seq],
      );
      if ((r.rowCount ?? 0) !== 0) return; // 插入或推进成功
      const cur = await this.cursor(topic, consumer);
      if (cur && cur.ackedSeq === seq) return; // 同值 ack：幂等
      if (cur && cur.ackedSeq > seq) {
        throw new ConflictError(
          `stream ack 回退拒绝：${topic}/${consumer} 当前 ackedSeq=${cur.ackedSeq} < 请求 seq=${seq}（游标只前进，ADR 0005 §2）`,
          "revision",
        );
      }
      throw new TroupeError(`stream ack 异常：${topic}/${consumer} seq=${seq} 未推进（当前=${cur?.ackedSeq ?? "null"}）`);
    } finally {
      c.release();
    }
  }

  async cursor(topic: string, consumer: string): Promise<StreamCursor | null> {
    const c = await this.client();
    try {
      const r = await c.query(
        `SELECT topic, consumer, acked_seq FROM ${this.q("stream_cursors")}
         WHERE topic = $1 AND consumer = $2`,
        [topic, consumer],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0] as { topic: string; consumer: string; acked_seq: string | number };
      return { topic: row.topic, consumer: row.consumer, ackedSeq: Number(row.acked_seq) };
    } finally {
      c.release();
    }
  }

  async replay(topic: string, consumer: string, toSeq: number): Promise<void> {
    const c = await this.client();
    try {
      // 只允许向后回拨（向前推进用 ack）；同值视为幂等
      const r = await c.query(
        `INSERT INTO ${this.q("stream_cursors")} (topic, consumer, acked_seq, updated_at)
         VALUES ($1, $2, $3, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
         ON CONFLICT (topic, consumer) DO UPDATE SET
           acked_seq = EXCLUDED.acked_seq,
           updated_at = EXCLUDED.updated_at
         WHERE ${this.q("stream_cursors")}.acked_seq > $3`,
        [topic, consumer, toSeq],
      );
      if ((r.rowCount ?? 0) !== 0) return;
      const cur = await this.cursor(topic, consumer);
      if (cur && cur.ackedSeq === toSeq) return; // 同值幂等
      throw new ConflictError(
        `stream replay 只允许向后回拨：${topic}/${consumer} 当前 ackedSeq=${cur?.ackedSeq ?? "null"}，请求 toSeq=${toSeq}（ADR 0005 §2）`,
        "revision",
      );
    } finally {
      c.release();
    }
  }

  async retain(topic: string, keepSeqs: number): Promise<{ trimmed: number }> {
    if (!(keepSeqs >= 0)) throw new TroupeError(`retain keepSeqs 必须非负：${keepSeqs}`);
    const c = await this.client();
    try {
      const r = await c.query(
        `DELETE FROM ${this.q("stream_events")}
         WHERE topic = $1 AND seq <= (SELECT COALESCE(MAX(seq), 0) - $2 FROM ${this.q("stream_events")} WHERE topic = $1)
         RETURNING seq`,
        [topic, keepSeqs],
      );
      return { trimmed: r.rowCount ?? 0 };
    } finally {
      c.release();
    }
  }

  async topics(): Promise<string[]> {
    const c = await this.client();
    try {
      const r = await c.query(`SELECT topic FROM ${this.q("stream_topics")} ORDER BY topic`);
      return (r.rows as Array<{ topic: string }>).map((row) => row.topic);
    } finally {
      c.release();
    }
  }
}
