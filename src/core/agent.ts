import type { Actor } from "./actor.js";

type FunctionKeys<T> = {
  [K in keyof T]-?: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T];

/** RPC 面显式排除的基类成员（private/protected 已因 keyof 外部视图排除，这里兜底） */
type ExcludedMembers =
  | "onStage"
  | "offStage"
  | "saveProps"
  | "idempotent"
  | "migrateProps"
  | "props"
  | "stageName";

export type AgentRpcMethodNames<T extends Actor<any>> = Exclude<FunctionKeys<T>, ExcludedMembers>;

/**
 * Agent<T>（DESIGN §3.2）：类型面只暴露 RPC 方法，统一 Promise 返回；
 * Props、生命周期钩子与运行时成员对调用方不可见。
 */
export type Agent<T extends Actor<any>> = {
  [K in AgentRpcMethodNames<T>]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * Proxy 实现（DESIGN §3.2）：
 * - then/Symbol/调试访问不触发 RPC（不被误当 thenable）
 * - 白名单外属性一律 undefined
 * - 编译期类型过滤不是安全边界——接收端白名单见 StageManager（§6.1）
 */
/** 已创建 Agent 的注册表：Codec 检测 Agent 引用跨界（DESIGN §6.1） */
const agentRegistry = new WeakSet<object>();

export function isAgent(value: unknown): boolean {
  return typeof value === "object" && value !== null && agentRegistry.has(value);
}

export function createAgent<T extends Actor<any>>(
  roleId: string,
  stageName: string,
  rpcMethods: ReadonlySet<string>,
  dispatch: (method: string, args: unknown[]) => Promise<unknown>,
): Agent<T> {
  const cache = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const target: Record<string, unknown> = { roleId, stageName };
  const proxy = new Proxy(target, {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") return undefined;
      if (!rpcMethods.has(prop)) return undefined;
      let fn = cache.get(prop);
      if (!fn) {
        fn = (...args: unknown[]) => dispatch(prop, args);
        cache.set(prop, fn);
      }
      return fn;
    },
    has(_t, prop) {
      return typeof prop === "string" && rpcMethods.has(prop);
    },
  });
  agentRegistry.add(proxy);
  return proxy as unknown as Agent<T>;
}
