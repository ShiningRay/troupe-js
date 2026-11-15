# ADR 0005：Stream（持久流）与 Outbox 边界

- 状态：已接受（P2-1，ROADMAP §4）
- 日期：2026-11-16
- 关联：[ROADMAP P2-1..P2-6](../ROADMAP.md)、[ADR 0002](./0002-ownership-fencing.md)（fencing 语义沿用）、issue #1（Show 边界）
- 编号说明：`0003` 保留给 P3-1 wire protocol v2

## 1. 决策

**Show 与 Stream 是两个通道，不共享语义：**

| | Show（现状，M6/M11） | Stream（P2 新增） |
|---|---|---|
| 语义 | 实时尽力投递 + 3 次退避重试 | 持久 at-least-once（业务幂等吸收重复） |
| 事件落盘 | 不落盘，coordinator 重启丢在途 | 落盘（PG），可重放 |
| 订阅恢复 | 持久订阅只恢复订阅关系 | 游标持久化，断点续传 |
| 保留 | 无 | retention 策略裁剪 |
| 不承诺 | — | **exactly-once（明确不承诺）** |

**存储选型：方案 A（PG 窄流）**。理由：P0/P1 已确立 PG 为唯一 crossNodeSafe Provider，
Stream 的仲裁需求（seq 分配、游标推进）与 ownership 同源；NATS/Redis 引入第二存储系统
违背"单一权威"原则。保留 `StreamStore` 接口（adapter 位），吞吐证据不足时再评估 B。

## 2. 数据模型与 API（P2-2 实现锚点）

三张表（PG，`stream_topics` / `stream_events` / `stream_cursors`）：

```
StreamStore（接口，P2-2 落地）:
  append(topic, event, opts?: { eventId?: string }): Promise<{ seq: number; eventId: string }>
    // seq 由 stream_topics 行原子 +1 分配（per-topic 单调）；eventId 缺省 UUID
    // eventId 唯一约束 → 幂等发布（重复 append 同 eventId 返回原 seq，不新增行）
  read(topic, afterSeq: number, limit: number): Promise<Array<{ seq, eventId, event, createdAt }>>
    // 按 seq 升序，seq > afterSeq
  ack(topic, consumer, seq): Promise<void>
    // 游标只前进；回退拒绝（ConflictError kind="revision"，消息含 current/attempted）
  cursor(topic, consumer): Promise<{ ackedSeq: number } | null>
  replay(topic, consumer, toSeq: number): Promise<void>
    // 游标回拨到 toSeq（重放语义显式；不删除已 ack 记录）
  retain(topic, keepSeqs: number): Promise<{ trimmed: number }>
    // 裁剪 seq <= (maxSeq - keepSeqs) 之外的事件；被裁剪段的消费尝试 → RetentionExceeded
  topics(): Promise<string[]>
```

**错误分类（固定，P2-6 合同测试锚定）：**

| 错误 | 触发 | 语义 |
|---|---|---|
| `RetentionExceeded` | read/ack 涉及已被裁剪的 seq | 调用方必须重置消费位（数据已不可恢复——显式失败，不静默跳读） |
| `ConflictError(kind="revision")` | ack 回退 / 并发游标竞争 | 游标只前进 |
| 幂等重复 append | 同 eventId | 返回原 seq（不视为错误） |

## 3. Consumer 投递（P2-3）

- Actor 订阅 = consumer（`(topic, consumerId)`）；拉取批次 → 投递为串行 Turn（复用调用管道）。
- **失败不 ack**：Turn 抛错 → 游标不推进 → 重启/重试后重新投递（at-least-once）。
- **重复由 eventId 幂等**：消费方按 `ctx.idem` 或业务键吸收；框架不隐藏重复。
- 背压：批次上限（默认 32）+ 在飞 Turn 上限；慢 consumer 只拖慢自己，不阻塞其他 consumer
  （每 consumer 独立游标）。
- 与 Show 边界：Show 丢消息不影响 Stream；Stream 不读 Show 订阅内存表（P2-3 边界测试）。

## 4. Outbox / Inbox（P2-4）

- `outbox` 表与 Props **同事务**写入（`supportsTransactions` 能力，ADR 0002 §8）——
  "Props 提交后 outbox 必存在"；dispatcher 用 `FOR UPDATE SKIP LOCKED` + lease 派发。
- 接收方 `eventId` 幂等（Inbox 表与业务写入同事务）。
- 顺序：单 Actor 分区 + 单 worker 才承诺 per-actor 顺序；**无全局顺序**（文档明确）。
- epoch 仅观测（Outbox 行不因 ownership 变化丢弃——派出方身份与数据无关）。

## 5. 协作取消（P2-5）

- `CallContext` 注入 `signal: AbortSignal`；wire 增加 `cancel` 控制消息（复用 dir 通道形态）。
- Actor 自主检查 `ctx.signal.aborted`；框架**不强行 kill** Turn。
- 取消后不启动后续 strict Turn；在飞 Turn settle 前占通道（与 §5.1 执行占用一致）。
- CPU 阻塞场景无法抢占——文档明确；取消/超时/断连错误分类映射 `CallRejectedError`/
  `UnknownOutcomeError` 既有分类。

## 6. 非目标

- exactly-once（至少一次 + 幂等是承诺边界）；
- 消费组/分区再平衡（单 consumer per (topic, consumerId) 起步）；
- 事务性 Stream append 与 Props（Outbox 承担该职责，Stream append 独立）；
- NATS/Redis adapter 实现（接口留位）。

## 7. 验收映射

- P2-2：并发 append 无重复 seq；幂等 eventId；ack 回退拒绝；retention 裁剪显式
  `RetentionExceeded`（真实 PG，CI 必跑）。
- P2-3：consumer 宕机重启从游标续传；重复投递幂等吸收；慢 consumer 不拖垮他人。
- P2-4：Props 提交后 outbox 必存在（同事务）；dispatcher 宕机重派；Inbox 幂等。
- P2-5：远程取消到达 Actor；取消不产生新成功写；CPU 阻塞文档明确。
- P2-6：Memory/SQLite/PG PropStore 同套合同测试；capability 声明与行为一致。
