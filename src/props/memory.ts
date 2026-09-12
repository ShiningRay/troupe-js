import { ConflictError } from "../core/errors.js";
import type { PropStore, StoredProps, WriteOptions } from "./prop-store.js";

/**
 * 进程内实现（DESIGN §7.2）：Rehearsal / 测试 / M1 默认。
 * 读写均做深拷贝，模拟复制边界（完整的 Codec 边界语义在 M2 交付）。
 */
export class InMemoryPropStore implements PropStore {
  private data = new Map<string, StoredProps>();

  private key(namespace: string, roleId: string, stageName: string): string {
    return `${namespace}\u0000${roleId}\u0000${stageName}`;
  }

  async read(namespace: string, roleId: string, stageName: string): Promise<StoredProps | null> {
    const v = this.data.get(this.key(namespace, roleId, stageName));
    return v ? structuredClone(v) : null;
  }

  async create(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    schemaVersion: number,
  ): Promise<StoredProps> {
    const k = this.key(namespace, roleId, stageName);
    if (this.data.has(k)) {
      throw new ConflictError(`记录已存在：${k}`, "exists");
    }
    const rec: StoredProps = { props: structuredClone(props), revision: 1, schemaVersion };
    this.data.set(k, rec);
    return structuredClone(rec);
  }

  async write(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    opts: WriteOptions,
  ): Promise<StoredProps> {
    const k = this.key(namespace, roleId, stageName);
    const cur = this.data.get(k);
    if (!cur) {
      throw new ConflictError(`记录不存在（期望 revision=${opts.expectedRevision}）：${k}；首次写入应使用 create`, "revision");
    }
    if (cur.revision !== opts.expectedRevision) {
      throw new ConflictError(
        `CAS 冲突：期望 revision=${opts.expectedRevision}，实际 revision=${cur.revision}（${k}）`,
        "revision",
      );
    }
    const rec: StoredProps = { props: structuredClone(props), revision: cur.revision + 1, schemaVersion: opts.schemaVersion };
    this.data.set(k, rec);
    return structuredClone(rec);
  }

  async delete(namespace: string, roleId: string, stageName: string): Promise<void> {
    this.data.delete(this.key(namespace, roleId, stageName));
  }
}
