/**
 * Show（流，DESIGN §2/§10.2）/ Audience（观察者）——M6。
 *
 * - Audience = Actor 方法引用：投递即向 (roleId, stageName).method 发一条 Call，
 *   复用整条调用管道（Playbill 路由、串行 Turn、deadline、错误分类）
 * - Show = 话题化 pub/sub：话题按 HashRing 归属一个 coordinator Stage（"show:"+topic，
 *   延续无目录哲学）；订阅注册与发布都路由到 coordinator，由它 fan-out
 * - 投递语义（M6 首实现，明示）：**尽力而为（at-most-once）**——订阅者不在场会重新登台
 *   处理，但投递失败（角色未加载/超时）只记事件不重试；持久订阅/outbox 属后续
 * - 订阅目录存于 coordinator 内存：Stage 重启后订阅丢失，需客户端重订阅（文档边界）
 */
export interface Audience {
  roleId: string;
  stageName: string;
  /** 回调方法名，默认 "onEvent"（基类提供的默认入口） */
  method: string;
}

export function audienceKey(a: Audience): string {
  return `${a.roleId}\u0000${a.stageName}\u0000${a.method}`;
}

interface Deps {
  namespace: string;
  /** 话题归属判定（cluster 注入；无集群恒为本 Stage） */
  isShowOwner(topic: string): boolean;
  /** 转发订阅/发布到话题归属 Stage */
  forward(topic: string, msg: "sub" | "unsub" | "pub", audience?: Audience, event?: unknown): void;
  /** 投递一条 Call 给 Audience（经完整调用管道） */
  deliver(audience: Audience, topic: string, event: unknown): Promise<void>;
  onEvent?(type: "published" | "delivered" | "dropped", topic: string, detail?: Record<string, unknown>): void;
}

/** 每个 coordinator Stage 内存中的订阅目录 + fan-out */
export class ShowBroker {
  private topics = new Map<string, Map<string, { audience: Audience; topic: string }>>();

  constructor(private readonly deps: Deps) {}

  /** 订阅（幂等去重）；非归属 Stage 由调用方先转发 */
  subscribe(topic: string, audience: Audience): void {
    let subs = this.topics.get(topic);
    if (!subs) {
      subs = new Map();
      this.topics.set(topic, subs);
    }
    subs.set(audienceKey(audience), { audience, topic });
  }

  unsubscribe(topic: string, audience: Audience): boolean {
    const subs = this.topics.get(topic);
    if (!subs) return false;
    return subs.delete(audienceKey(audience));
  }

  /** Actor 失效/离场时的批量清理（按 audience 的 roleId+stageName 前缀） */
  unsubscribeActor(roleId: string, stageName: string): number {
    let n = 0;
    for (const [topic, subs] of this.topics) {
      for (const [key, entry] of subs) {
        if (entry.audience.roleId === roleId && entry.audience.stageName === stageName) {
          subs.delete(key);
          n++;
        }
      }
      if (subs.size === 0) this.topics.delete(topic);
    }
    return n;
  }

  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  /** 发布：fan-out 给全部订阅者；单个投递失败不影响其它订阅者 */
  async publish(topic: string, event: unknown): Promise<void> {
    const subs = this.topics.get(topic);
    this.deps.onEvent?.("published", topic, { subscribers: subs?.size ?? 0 });
    if (!subs || subs.size === 0) return;
    await Promise.allSettled(
      [...subs.values()].map(async ({ audience }) => {
        try {
          await this.deps.deliver(audience, topic, event);
          this.deps.onEvent?.("delivered", topic, { audience: audienceKey(audience) });
        } catch (e) {
          // 尽力而为：失败记事件不重试（at-most-once，§边界）
          this.deps.onEvent?.("dropped", topic, {
            audience: audienceKey(audience),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );
  }
}
