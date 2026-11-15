import type { StreamMessage, StreamStore } from "./stream-store.js";

/**
 * Stream 消费者（ADR 0005 §3，ROADMAP P2-3）：
 * 拉取批次 → 逐条投递（默认串行，保证 per-consumer 顺序）→ 成功才 ack。
 *
 * 语义：
 * - **失败不 ack**：deliver 抛错 → 本批次中止、游标不推进 → 下次 poll 从游标重投
 *   （at-least-once；重复由 eventId/业务幂等吸收）。
 * - **会话内去重**：`lastDeliveredSeq` 拦截 ack 丢失窗口内的重投（跨会话重复仍可能
 *   ——deliver 成功后、ack 前宕机——由业务幂等兜底，框架不承诺 exactly-once）。
 * - **背压**：批次上限（batchSize）+ 单消费者串行投递；游标按 consumer 独立，
 *   慢消费者只拖慢自己，不影响同 topic 的其他 consumer。
 * - 轮询驱动（pollIntervalMs）；`pollOnce()` 公开供测试/自定义驱动确定性推进。
 */
export interface StreamConsumerOptions {
  store: StreamStore;
  topic: string;
  /** 消费者 id（游标持久化键；同一逻辑消费者重启后复用） */
  consumer: string;
  /** 批次大小（默认 32） */
  batchSize?: number;
  /** 轮询间隔 ms（默认 250；0 = 仅手动 pollOnce 驱动） */
  pollIntervalMs?: number;
  /** 投递回调：抛错 = 本条未消费（不 ack） */
  deliver: (msg: StreamMessage) => Promise<void>;
}

export interface StreamConsumerStats {
  polls: number;
  delivered: number;
  duplicates: number;
  failures: number;
  lastDeliveredSeq: number;
}

export class StreamConsumer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inPoll = false;
  private lastDeliveredSeq = 0;
  private readonly batchSize: number;
  private readonly statsData: StreamConsumerStats = {
    polls: 0,
    delivered: 0,
    duplicates: 0,
    failures: 0,
    lastDeliveredSeq: 0,
  };

  constructor(private readonly opts: StreamConsumerOptions) {
    this.batchSize = Math.max(1, opts.batchSize ?? 32);
  }

  start(): void {
    if (this.timer !== null) return;
    const interval = this.opts.pollIntervalMs ?? 250;
    if (interval <= 0) return; // 仅手动驱动
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => {}); // 失败已计数；下一拍从游标重投
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 单次拉取-投递：返回本批投递条数（失败抛出——游标停在失败条之前，
   * 调用方可恢复 deliver 后重试；测试以此确定性驱动）。
   */
  async pollOnce(): Promise<number> {
    if (this.inPoll) return 0; // 单飞：上一批未完不重叠
    this.inPoll = true;
    try {
      this.statsData.polls++;
      const cur = await this.opts.store.cursor(this.opts.topic, this.opts.consumer);
      const after = Math.max(cur?.ackedSeq ?? 0, this.lastDeliveredSeq);
      const batch = await this.opts.store.read(this.opts.topic, after, this.batchSize);
      let delivered = 0;
      for (const msg of batch) {
        if (msg.seq <= this.lastDeliveredSeq) {
          // 会话内重复（ack 丢失窗口）：跳过并补 ack
          this.statsData.duplicates++;
          await this.opts.store.ack(this.opts.topic, this.opts.consumer, msg.seq);
          continue;
        }
        await this.opts.deliver(msg);
        this.lastDeliveredSeq = msg.seq;
        this.statsData.delivered++;
        await this.opts.store.ack(this.opts.topic, this.opts.consumer, msg.seq);
        delivered++;
      }
      return delivered;
    } catch (e) {
      this.statsData.failures++;
      throw e;
    } finally {
      this.inPoll = false;
      this.statsData.lastDeliveredSeq = this.lastDeliveredSeq;
    }
  }

  stats(): StreamConsumerStats {
    return { ...this.statsData };
  }
}
