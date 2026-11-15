/**
 * 存储能力声明（ROADMAP P0-3，ADR 0002 §8）：
 * production 门禁（troupe.ts）按能力判定，不再按类型名猜测。
 * 声明必须与实际行为一致——Provider 合同测试（P2-6）会校验声明与实现的匹配。
 */
export interface StoreCapabilities {
  /**
   * 多节点共享同一存储时语义安全：
   * - Postgres：true（行锁 + 事务 + DB 时钟）
   * - SQLite：false（仅同机多进程；跨主机共享盘的锁语义不成立）
   * - 内存：false（进程内）
   */
  crossNodeSafe: boolean;
  /**
   * 支持 ADR 0002 的原子 fencing 校验：
   * create/write/delete 在同一原子语句内校验
   * `owner_id = fencingOwner AND epoch = fencingToken AND lease_until > now`。
   * 声明 false 的 Provider 在 ownership + production 下被拒绝。
   */
  supportsFencing: boolean;
  /** 存储层支持事务（P2 Outbox 同事务写依赖此声明） */
  supportsTransactions?: boolean;
}
