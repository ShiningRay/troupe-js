import type { Actor } from "./actor.js";

const decorated = new WeakMap<Function, Set<string>>();

/** @internal 注册某类带 @Cron/@Every 的方法名（describeRole 收集时调用） */
export function registerDecoratedCues(ctor: Function, names: Iterable<string>): void {
  const existing = decorated.get(ctor);
  if (existing) {
    for (const n of names) existing.add(n);
    return;
  }
  decorated.set(ctor, new Set(names));
}

/** 查询某类是否有同名声明式提醒处理器（Actor.onCue 默认分派用） */
export function decoratedCueHandler(ctor: Function, name: string): string | null {
  return decorated.get(ctor)?.has(name) ? name : null;
}

export type { Actor };
