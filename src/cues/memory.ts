import { cloneReminderPayload, type CueStore, type ReminderKey, type ReminderRecord } from "./cue-store.js";

/** 进程内 CueStore（Rehearsal / 测试 / M4 单机） */
export class InMemoryCueStore implements CueStore {
  private data = new Map<string, ReminderRecord>();

  private k(key: ReminderKey | ReminderRecord): string {
    return `${key.namespace}\u0000${key.roleId}\u0000${key.stageName}\u0000${key.name}`;
  }

  async upsert(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): Promise<void> {
    const key = this.k(rec);
    const existing = this.data.get(key);
    this.data.set(key, {
      ...rec,
      payload: cloneReminderPayload(rec.payload),
      statusVersion: (existing?.statusVersion ?? 0) + 1,
      leaseUntil: 0,
      owner: null,
    });
  }

  async ensure(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): Promise<void> {
    const key = this.k(rec);
    if (this.data.has(key)) return; // 声明式登记：不重置已存在的 nextDue
    this.data.set(key, {
      ...rec,
      payload: cloneReminderPayload(rec.payload),
      statusVersion: 1,
      leaseUntil: 0,
      owner: null,
    });
  }

  async delete(key: ReminderKey): Promise<boolean> {
    return this.data.delete(this.k(key));
  }

  async due(now: number, limit: number): Promise<ReminderRecord[]> {
    const out: ReminderRecord[] = [];
    for (const rec of this.data.values()) {
      if (out.length >= limit) break;
      if (rec.nextDue <= now && rec.leaseUntil <= now) out.push({ ...rec });
    }
    return out;
  }

  async claim(key: ReminderKey, owner: string, leaseUntil: number, now: number): Promise<ReminderRecord | null> {
    const rec = this.data.get(this.k(key));
    if (!rec || rec.leaseUntil > now) return null;
    rec.owner = owner;
    rec.leaseUntil = leaseUntil;
    rec.statusVersion += 1;
    return { ...rec };
  }

  async complete(key: ReminderKey, expectedStatusVersion: number, nextDue: number | null): Promise<boolean> {
    const rec = this.data.get(this.k(key));
    if (!rec || rec.statusVersion !== expectedStatusVersion) return false;
    if (nextDue === null) {
      this.data.delete(this.k(key));
      return true;
    }
    rec.nextDue = nextDue;
    rec.leaseUntil = 0;
    rec.owner = null;
    return true;
  }

  async list(namespace: string): Promise<ReminderRecord[]> {
    return [...this.data.values()].filter((r) => r.namespace === namespace).map((r) => ({ ...r }));
  }
}
