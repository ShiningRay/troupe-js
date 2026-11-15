/** Troupe 错误分类（DESIGN §6.1：业务异常 / 请求拒绝 / 结果未知 / 存储冲突） */

export class TroupeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * 存储冲突（DESIGN §7.2 CAS 合同；fencing 分类见 ADR 0002 §7）。
 * kind="exists"：create 时记录已存在；kind="revision"：write 时期望 revision 不匹配或记录缺失；
 * kind="fencing"：所有权行缺失 / owner 不匹配 / epoch 不匹配；
 * kind="lease-expired"：所有权行匹配但租约已过期（存储时钟判定）。
 */
export class ConflictError extends TroupeError {
  constructor(
    message: string,
    readonly kind: "exists" | "revision" | "fencing" | "lease-expired",
  ) {
    super(message);
  }
}

/**
 * 调用超时（DESIGN §5.1 响应期限与执行占用分离）。
 * phase="queued"：排队过期，未开始执行、无副作用，可安全重试；
 * phase="executing"：执行中超时，结果未知；执行占用保持到原执行 settle，后续 Turn 不放行。
 */
export class CallTimeoutError extends TroupeError {
  constructor(
    message: string,
    readonly phase: "queued" | "executing",
  ) {
    super(message);
  }
}

/** 请求拒绝（非业务异常）：背压 / 排空 / 失效 / 白名单 / 停机 / 漂移 / 未取得所有权（M3 §6.5） */
export class CallRejectedError extends TroupeError {
  constructor(
    message: string,
    readonly reason:
      | "backpressure"
      | "draining"
      | "invalidated"
      | "whitelist"
      | "shutdown"
      | "drift"
      | "ownership"
      | "cancelled",
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** 执行结果未知（DESIGN §6.1 错误分类）：超时/连接断开/对端停机——勿假定失败，按幂等键重试（§6.5） */
export class UnknownOutcomeError extends TroupeError {}

/** 幂等键冲突：同键不同参数指纹（DESIGN §6.5） */
export class IdempotencyConflictError extends TroupeError {}

/** cast 了未注册的角色（DESIGN §8.5） */
export class UnknownRoleError extends TroupeError {}

/** 角色名冲突：两个类解析出同一 roleId，启动 fail fast（DESIGN §8.5） */
export class RoleConflictError extends TroupeError {}

/** 对已失效实例的操作（保存等，DESIGN §7.3） */
export class InvalidActorStateError extends TroupeError {}

/** Props 无法通过复制/序列化边界 */
export class SerializationError extends TroupeError {}

/** 激活失败：加载、迁移或 onStage() 抛错（DESIGN §5.2 状态机） */
export class ActivationError extends TroupeError {}

/**
 * 流保留裁剪后消费已裁剪段（ADR 0005 §2，P2-2）：
 * 调用方必须显式重置消费位（数据已不可恢复——显式失败，不静默跳读）。
 */
export class RetentionExceededError extends TroupeError {}

/** swap 守则静态检查违规（DESIGN §9.5）：不合规代码拒绝 swap */
export class SwapViolationError extends TroupeError {
  constructor(
    message: string,
    readonly violations: string[],
  ) {
    super(message);
  }
}
