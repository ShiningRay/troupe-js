/**
 * StreamStore 契约（ADR 0005 §2，ROADMAP P2-2）：PG 窄流的持久 at-least-once 流。
 *
 * 语义（固定，P2-6 合同测试锚定）：
 * - append：per-topic seq 由 `stream_topics` 行原子 +1 分配（单调，允许间隙——幂等
 *   eventId 冲突时分配号作废）；eventId 唯一约束做幂等发布：同 eventId 重复 append
 *   返回原 seq，不新增行、不视为错误。
 * - read：按 seq 升序返回 `seq > afterSeq` 的消息；涉及已被 retain 裁剪的段 →
 *   `RetentionExceededError`（显式失败，不静默跳读——调用方必须重置消费位）。
 * - ack：游标只前进；回退拒绝 `ConflictError(kind="revision")`，同值 ack 幂等成功。
 * - replay：显式回拨游标到 toSeq（只允许向后；向前用 ack）。
 * - retain：裁剪旧事件（保留最近 keepSeqs 条），返回裁剪数量。
 *
 * 不承诺 exactly-once（ADR 0005 §6）：至少一次 + 业务幂等（eventId）是承诺边界。
 */
export interface StreamMessage {
  seq: number;
  eventId: string;
  event: unknown;
  /** 入库时刻（DB 时钟域 epoch ms） */
  createdAt: number;
}

export interface StreamAppendResult {
  seq: number;
  eventId: string;
}

export interface StreamCursor {
  topic: string;
  consumer: string;
  ackedSeq: number;
}

export interface StreamStore {
  /** 幂等发布（eventId 缺省 UUID）：返回分配（或既有）的 seq */
  append(topic: string, event: unknown, opts?: { eventId?: string }): Promise<StreamAppendResult>;

  /** 读取 seq > afterSeq 的消息（升序，至多 limit 条）；涉及已裁剪段抛 RetentionExceededError */
  read(topic: string, afterSeq: number, limit: number): Promise<StreamMessage[]>;

  /** 推进消费游标：只前进（同值幂等；回退抛 ConflictError kind="revision"） */
  ack(topic: string, consumer: string, seq: number): Promise<void>;

  /** 查询消费游标；从未 ack 过返回 null */
  cursor(topic: string, consumer: string): Promise<StreamCursor | null>;

  /** 显式回拨游标到 toSeq（重放）；向前（toSeq > 当前）抛 ConflictError kind="revision" */
  replay(topic: string, consumer: string, toSeq: number): Promise<void>;

  /** 裁剪旧事件（保留最近 keepSeqs 条），返回裁剪数量 */
  retain(topic: string, keepSeqs: number): Promise<{ trimmed: number }>;

  /** 全部流主题 */
  topics(): Promise<string[]>;

  close?(): Promise<void>;
}

export function isStreamStore(store: unknown): store is StreamStore {
  const s = store as StreamStore;
  return (
    typeof s?.append === "function" &&
    typeof s?.read === "function" &&
    typeof s?.ack === "function" &&
    typeof s?.replay === "function" &&
    typeof s?.retain === "function"
  );
}
