import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { CueStore, ReminderKey, ReminderRecord } from "./cue-store.js";
import { cloneReminderPayload } from "./cue-store.js";
import type { StoreCapabilities } from "../props/capabilities.js";

// vitest/vite 尚不识别 node:sqlite 内建，改为运行时 require（类型仍静态检查）
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

interface CueRow {
  namespace: string;
  role_id: string;
  stage_name: string;
  name: string;
  payload_json: string;
  every_ms: number | null;
  at_ms: number | null;
  cron: string | null;
  time_zone: string | null;
  next_due: number;
  status_version: number;
  lease_until: number;
  owner: string | null;
}

/** 持久提醒的 SQLite 实现（DESIGN §7.5；同机多进程经 SQLite 行锁原子 claim；跨主机不安全，ADR 0002 §8） */
export class SqliteCueStore implements CueStore {
  readonly capabilities: StoreCapabilities = { crossNodeSafe: false, supportsFencing: false };

  private db: DatabaseSyncType | null = null;
  private stmts: {
    upsert: ReturnType<DatabaseSyncType["prepare"]>;
    ensure: ReturnType<DatabaseSyncType["prepare"]>;
    del: ReturnType<DatabaseSyncType["prepare"]>;
    due: ReturnType<DatabaseSyncType["prepare"]>;
    get: ReturnType<DatabaseSyncType["prepare"]>;
    claim: ReturnType<DatabaseSyncType["prepare"]>;
    complete: ReturnType<DatabaseSyncType["prepare"]>;
    completeDel: ReturnType<DatabaseSyncType["prepare"]>;
    list: ReturnType<DatabaseSyncType["prepare"]>;
  } | null = null;

  constructor(
    private readonly dir: string = "./.troupe",
    private readonly file: string = "cues.db",
  ) {}

  private openDb(): void {
    if (this.db) return;
    mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(join(this.dir, this.file));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cues (
        namespace      TEXT    NOT NULL,
        role_id        TEXT    NOT NULL,
        stage_name     TEXT    NOT NULL,
        name           TEXT    NOT NULL,
        payload_json   TEXT    NOT NULL,
        every_ms       INTEGER,
        at_ms          INTEGER,
        next_due       INTEGER NOT NULL,
        status_version INTEGER NOT NULL,
        lease_until    INTEGER NOT NULL,
        owner          TEXT,
        PRIMARY KEY (namespace, role_id, stage_name, name)
      );
      CREATE INDEX IF NOT EXISTS cues_next_due ON cues (next_due);
    `);
    // 迁移：早期版本无 cron 列（ALTER 幂等）
    const cols = this.db.prepare("PRAGMA table_info(cues)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "cron")) {
      this.db.exec("ALTER TABLE cues ADD COLUMN cron TEXT");
    }
    if (!cols.some((c) => c.name === "time_zone")) {
      this.db.exec("ALTER TABLE cues ADD COLUMN time_zone TEXT");
    }
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO cues (namespace, role_id, stage_name, name, payload_json, every_ms, at_ms, cron, time_zone, next_due, status_version, lease_until, owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)
        ON CONFLICT (namespace, role_id, stage_name, name) DO UPDATE SET
          payload_json = excluded.payload_json,
          every_ms = excluded.every_ms,
          at_ms = excluded.at_ms,
          cron = excluded.cron,
          time_zone = excluded.time_zone,
          next_due = excluded.next_due,
          status_version = cues.status_version + 1,
          lease_until = 0,
          owner = NULL
      `),
      ensure: this.db.prepare(`
        INSERT INTO cues (namespace, role_id, stage_name, name, payload_json, every_ms, at_ms, cron, time_zone, next_due, status_version, lease_until, owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)
        ON CONFLICT (namespace, role_id, stage_name, name) DO NOTHING
      `),
      del: this.db.prepare(
        "DELETE FROM cues WHERE namespace = ? AND role_id = ? AND stage_name = ? AND name = ?",
      ),
      due: this.db.prepare(
        "SELECT * FROM cues WHERE next_due <= ? AND lease_until <= ? LIMIT ?",
      ),
      get: this.db.prepare(
        "SELECT * FROM cues WHERE namespace = ? AND role_id = ? AND stage_name = ? AND name = ?",
      ),
      claim: this.db.prepare(`
        UPDATE cues SET owner = ?, lease_until = ?, status_version = status_version + 1
        WHERE namespace = ? AND role_id = ? AND stage_name = ? AND name = ? AND lease_until <= ?
      `),
      complete: this.db.prepare(`
        UPDATE cues SET next_due = ?, lease_until = 0, owner = NULL
        WHERE namespace = ? AND role_id = ? AND stage_name = ? AND name = ? AND status_version = ?
      `),
      completeDel: this.db.prepare(
        "DELETE FROM cues WHERE namespace = ? AND role_id = ? AND stage_name = ? AND name = ? AND status_version = ?",
      ),
      list: this.db.prepare("SELECT * FROM cues WHERE namespace = ? ORDER BY next_due"),
    };
  }

  private toRecord(row: CueRow): ReminderRecord {
    return {
      namespace: row.namespace,
      roleId: row.role_id,
      stageName: row.stage_name,
      name: row.name,
      payload: JSON.parse(row.payload_json),
      everyMs: row.every_ms === null ? null : Number(row.every_ms),
      at: row.at_ms === null ? null : Number(row.at_ms),
      cron: row.cron ?? null,
      timeZone: row.time_zone ?? null,
      nextDue: Number(row.next_due),
      statusVersion: Number(row.status_version),
      leaseUntil: Number(row.lease_until),
      owner: row.owner,
    };
  }

  async upsert(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): Promise<void> {
    this.openDb();
    this.stmts!.upsert.run(
      rec.namespace, rec.roleId, rec.stageName, rec.name,
      JSON.stringify(cloneReminderPayload(rec.payload)),
      rec.everyMs, rec.at, rec.cron, rec.timeZone ?? null, rec.nextDue,
    );
  }

  async ensure(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): Promise<void> {
    this.openDb();
    this.stmts!.ensure.run(
      rec.namespace, rec.roleId, rec.stageName, rec.name,
      JSON.stringify(cloneReminderPayload(rec.payload)),
      rec.everyMs, rec.at, rec.cron, rec.timeZone ?? null, rec.nextDue,
    );
  }

  async delete(key: ReminderKey): Promise<boolean> {
    this.openDb();
    return this.stmts!.del.run(key.namespace, key.roleId, key.stageName, key.name).changes === 1;
  }

  async due(now: number, limit: number): Promise<ReminderRecord[]> {
    this.openDb();
    const rows = this.stmts!.due.all(now, now, limit) as unknown as CueRow[];
    return rows.map((r) => this.toRecord(r));
  }

  async claim(key: ReminderKey, owner: string, leaseUntil: number, now: number): Promise<ReminderRecord | null> {
    this.openDb();
    const c = this.stmts!.claim.run(
      owner, leaseUntil,
      key.namespace, key.roleId, key.stageName, key.name, now,
    ).changes;
    if (c === 0) return null;
    return this.toRecord(this.stmts!.get.get(key.namespace, key.roleId, key.stageName, key.name) as unknown as CueRow);
  }

  async complete(key: ReminderKey, expectedStatusVersion: number, nextDue: number | null): Promise<boolean> {
    this.openDb();
    if (nextDue === null) {
      return this.stmts!.completeDel.run(
        key.namespace, key.roleId, key.stageName, key.name, expectedStatusVersion,
      ).changes === 1;
    }
    return this.stmts!.complete.run(
      nextDue,
      key.namespace, key.roleId, key.stageName, key.name, expectedStatusVersion,
    ).changes === 1;
  }

  async list(namespace: string): Promise<ReminderRecord[]> {
    this.openDb();
    const rows = this.stmts!.list.all(namespace) as unknown as CueRow[];
    return rows.map((r) => this.toRecord(r));
  }
}
