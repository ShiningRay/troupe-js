import { RoleConflictError } from "./errors.js";

export interface RegisteredActor {
  ctor: Function;
  /** 注册来源（尽力从装饰器调用栈解析出的文件路径） */
  source: string;
}

/**
 * 进程级默认注册表：`@Performs` 在类定义时写入（import 即入团，DESIGN §8.3）。
 * `Troupe.form()` 不传 actors 时对它取快照——每个 Troupe 持有自己的副本，
 * 同进程多个 Troupe（测试场景）互不污染。
 */
const processRegistry = new Map<string, RegisteredActor>();

let allowReplace = false;

/** dev 热重载期间允许同 roleId 的新类替换注册（@Performs 重导时不再 fail-fast） */
export function setAllowReplace(v: boolean): void {
  allowReplace = v;
}

export function registerActor(roleId: string, ctor: Function, source: string): void {
  const existing = processRegistry.get(roleId);
  if (existing && existing.ctor !== ctor) {
    if (!allowReplace) {
      throw new RoleConflictError(
        `角色名冲突： "${roleId}" 已由 ${existing.source} 注册，又被 ${source} 重复注册（DESIGN §8.5）`,
      );
    }
    // dev 重载：新类替换旧注册（Troupe 内部 roleMap 由 reloadActorClass 同步）
  }
  processRegistry.set(roleId, { ctor, source });
}

export function snapshotProcessRegistry(): ReadonlyMap<string, RegisteredActor> {
  return new Map(processRegistry);
}

/** 尽力从当前调用栈解析出装饰器调用方的文件路径，用于冲突报错定位 */
export function captureSource(): string {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(2)) {
    const m = /(?:\(|at\s+)([^\s()]+?\.(?:ts|tsx|mts|js|mjs|cjs)):\d+:\d+/.exec(line);
    if (!m) continue;
    const file = m[1];
    // 跳过框架自身帧（源码与构建产物两种路径形态）
    if (/(core[/\\](meta|repertoire)|dist[/\\]core[/\\](meta|repertoire))\.[jt]s$/.test(file)) continue;
    return file;
  }
  return "<unknown>";
}
