/**
 * Show 订阅持久化（M11+ 收尾，升级投递语义的存储侧）：
 * - 订阅记录 = (namespace, topic, roleId, stageName, method)
 * - coordinator 侧持久化：Stage 重启后重载订阅（归属 Stage 变更时按 isShowOwner 重放）
 * - 投递升级为至少一次（可能重复）——订阅方按业务幂等
 */
export interface SubscriptionRecord {
  namespace: string;
  topic: string;
  roleId: string;
  stageName: string;
  method: string;
}

export interface SubscriptionStore {
  upsert(rec: SubscriptionRecord): Promise<void>;
  delete(topic: string, roleId: string, stageName: string, method: string): Promise<boolean>;
  list(namespace: string): Promise<SubscriptionRecord[]>;
}
