import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { SubscriptionRecord, SubscriptionStore } from "./subscription-store.js";

// vitest/vite 尚不识别 node:sqlite 内建，改为运行时 require（类型仍静态检查）
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

interface SubRow {
  namespace: string;
  topic: string;
  role_id: string;
  stage_name: string;
  method: string;
}

/** Show 订阅的 SQLite 持久化（coordinator 重启后重载；同机多进程共享库文件） */
export class SqliteSubscriptionStore implements SubscriptionStore {
  private db: DatabaseSyncType | null = null;
  private stmts: {
    upsert: ReturnType<DatabaseSyncType["prepare"]>;
    del: ReturnType<DatabaseSyncType["prepare"]>;
    list: ReturnType<DatabaseSyncType["prepare"]>;
  } | null = null;

  constructor(
    private readonly dir: string = "./.troupe",
    private readonly file: string = "shows.db",
  ) {}

  private openDb(): void {
    if (this.db) return;
    mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(join(this.dir, this.file));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS show_subs (
        namespace  TEXT NOT NULL,
        topic      TEXT NOT NULL,
        role_id    TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        method     TEXT NOT NULL,
        PRIMARY KEY (namespace, topic, role_id, stage_name, method)
      );
    `);
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO show_subs (namespace, topic, role_id, stage_name, method)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (namespace, topic, role_id, stage_name, method) DO NOTHING
      `),
      del: this.db.prepare(
        "DELETE FROM show_subs WHERE topic = ? AND role_id = ? AND stage_name = ? AND method = ?",
      ),
      list: this.db.prepare("SELECT * FROM show_subs WHERE namespace = ?"),
    };
  }

  private toRecord(row: SubRow): SubscriptionRecord {
    return {
      namespace: row.namespace,
      topic: row.topic,
      roleId: row.role_id,
      stageName: row.stage_name,
      method: row.method,
    };
  }

  async upsert(rec: SubscriptionRecord): Promise<void> {
    this.openDb();
    this.stmts!.upsert.run(rec.namespace, rec.topic, rec.roleId, rec.stageName, rec.method);
  }

  async delete(topic: string, roleId: string, stageName: string, method: string): Promise<boolean> {
    this.openDb();
    return this.stmts!.del.run(topic, roleId, stageName, method).changes === 1;
  }

  async list(namespace: string): Promise<SubscriptionRecord[]> {
    this.openDb();
    const rows = this.stmts!.list.all(namespace) as unknown as SubRow[];
    return rows.map((r) => this.toRecord(r));
  }
}
