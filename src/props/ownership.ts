/**
 * 所有权契约（DESIGN §6.5）：HashRing 只决定"候选归属"，
 * 真正服务前必须持有租约；epoch 为单调递增的 fencing token。
 *
 * 语义：
 * - acquire：无记录 → 建立（epoch=1）；租约过期 → 顶替（epoch+1）；本人 → 续租（epoch 不变）
 * - 失败返回当前持有者（租约未过期且非本人）
 * - release：仅 owner+epoch 匹配时删除（旧持有者不能误删新租约）
 * - PropStore.write 携 fencingToken：存储拒绝 epoch 更旧的写入（旧实例复活保护）
 */
export interface OwnershipRecord {
  ownerId: string;
  epoch: number;
  leaseUntil: number;
}

/**
 * acquire 成功返回 DB 时钟域的 leaseUntil（ADR 0002 §5）：
 * 节点本地 Date.now() 只做续租节拍近似提示，租约有效性判定以存储时钟为准。
 */
export type AcquireResult =
  | { ok: true; epoch: number; leaseUntil: number }
  | { ok: false; holder: OwnershipRecord };

export interface OwnershipStore {
  /** 获取/续租所有权（原子）；leaseMs 为租约时长 */
  acquire(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<AcquireResult>;

  /** 读取当前所有权记录（调试/测试） */
  readOwnership(namespace: string, roleId: string, stageName: string): Promise<OwnershipRecord | null>;

  /** 释放：仅 owner+epoch 匹配时生效 */
  release(
    namespace: string,
    roleId: string,
    stageName: string,
    ownerId: string,
    epoch: number,
  ): Promise<boolean>;
}

export function isOwnershipStore(store: unknown): store is OwnershipStore {
  const s = store as OwnershipStore;
  return (
    typeof s?.acquire === "function" &&
    typeof s?.readOwnership === "function" &&
    typeof s?.release === "function"
  );
}
