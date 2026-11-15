/**
 * 目录化所有权契约（ADR 0004，ROADMAP P1-2）：
 * ownership 表提升为权威 Actor 目录——路由读目录、不读环；
 * HashRing 只做候选生成与减载建议（Cluster 层职责，P1-3）。
 *
 * 语义（在 OwnershipStore.acquire 基础上扩展，完全兼容；参数与 OwnershipStore
 * 同为扁平三元组，两类实现共用同一方法）：
 * - claim：无记录 → 建立（epoch=1, status=active）；租约过期 → 顶替（epoch+1）；
 *   本人 → 续租（epoch 不变）；tombstone 可被重新 claim（ADR 0004 §5：目录条目丢失 = 重建）。
 *   失败返回当前持有者。每次归属/租约变更 version +1（单调，缓存失效依据）。
 * - release：仅 owner+epoch 匹配时置空租约、status='draining'（交接/停服语义）、version+1。
 * - bumpVersion：无条件 version+1（缓存失效驱动/观测用）。
 * - listOwned：owner_id 前缀扫描（节点重启恢复——重启即新 incarnation，按 addr 前缀匹配）。
 *
 * status：active（租约有效）/ draining（持有者交接/排空中，租约可能仍有效）/
 * tombstone（已注销，等待清理——P1-4 delete 路径写入）。
 * 租约有效性判定以存储时钟为准（ADR 0002 §5）；缓存与路由语义见 ADR 0004 §3。
 */

export type DirectoryStatus = "active" | "draining" | "tombstone";

export interface DirectoryRecord {
  namespace: string;
  roleId: string;
  stageName: string;
  ownerId: string;
  epoch: number;
  leaseUntil: number;
  version: number;
  status: DirectoryStatus;
}

export type DirectoryClaimResult =
  | { ok: true; epoch: number; leaseUntil: number; version: number }
  | { ok: false; holder: DirectoryRecord };

export interface DirectoryStore {
  /** claim/续租/顶替（原子）；返回 DB 时钟域 leaseUntil 与单调 version */
  claim(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<DirectoryClaimResult>;

  /** 读取目录条目（含 version/status；调试、路由回源） */
  lookup(
    namespace: string,
    roleId: string,
    stageName: string,
  ): Promise<DirectoryRecord | null>;

  /** 释放：仅 owner+epoch 匹配时生效（置空租约 + draining + version+1） */
  release(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    epoch: number,
  ): Promise<boolean>;

  /** 无条件 version+1（返回新 version；条目不存在返回 null） */
  bumpVersion(namespace: string, roleId: string, stageName: string): Promise<number | null>;

  /** 按持有者身份前缀列出条目（节点重启恢复扫描） */
  listOwned(ownerIdPrefix: string): Promise<DirectoryRecord[]>;
}

export function isDirectoryStore(store: unknown): store is DirectoryStore {
  const s = store as DirectoryStore;
  return (
    typeof s?.claim === "function" &&
    typeof s?.lookup === "function" &&
    typeof s?.release === "function" &&
    typeof s?.bumpVersion === "function" &&
    typeof s?.listOwned === "function"
  );
}
