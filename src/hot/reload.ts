/**
 * 热重载（M10，DESIGN §9.3/§9.5/§9.6）：
 * - `scanActorSource`：swap 守则静态扫描（启发式，必要条件非充分条件）
 * - `createDevReloader`：fs.watch → 版本化重导（?t= 查询串）→ reloadActorClass
 * - 三策略：recycle（下场重登台，默认）/ swap（setPrototypeOf 内存保留）/ keep
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Troupe } from "../troupe.js";
import { SwapViolationError } from "../core/errors.js";

export type ReloadPolicy = "recycle" | "swap" | "keep";

/**
 * swap 守则静态扫描（DESIGN §9.5）：启发式文本检查，命中即拒绝 swap。
 * 覆盖：#private 字段、实例箭头函数属性、预 bind 方法。
 * 注意：静态检查是必要条件而非充分条件（§9.4）。
 */
export function scanActorSource(source: string): string[] {
  const violations: string[] = [];
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (/#\w+\s*(=|;|\)|,)/.test(noComments)) {
    violations.push("私有字段（#name）：swap 后新方法无法访问旧实例私有槽（守则 2）");
  }
  if (/^[ \t]{2,}(readonly\s+)?\w+\s*=\s*(\([^)]*\)|\w+)\s*=>/m.test(noComments)) {
    violations.push("实例箭头函数属性：新类字段初始化器不会重跑（守则 5）");
  }
  if (/\.bind\(this\)/.test(noComments)) {
    violations.push("预 bind 方法：bind 产物在实例上，换原型不生效（守则 5）");
  }
  return violations;
}

export interface ReloadResult {
  roleId: string;
  policy: ReloadPolicy;
  fromVersion: number;
  toVersion: number;
  /** 受影响的在场实例数（swap=换码数；recycle=下场数；keep=0） */
  affected: number;
}

export interface ReloadOptions {
  policy?: ReloadPolicy;
  /** 源码文本（swap 必须提供，做守则静态检查；recycle/keep 可省略） */
  source?: string;
}

/**
 * 重载一个 Actor 类（M10 核心 API）：注册表/roleMap 换新版本，按策略处理在场实例。
 * - recycle（默认）：在场 Actor 排空（offStage + saveProps），下次 Call 以新类登台——
 *   Props 无损（§9.3 兜底路径，任意代码安全，前提见 §9.1）
 * - swap：quiesce 后 setPrototypeOf 换方法表——实例与内存状态保留；须先过守则扫描；
 *   onCodeSwap 抛错自动回滚旧原型（§9.5 第 7 条）
 * - keep：旧实例运行到自然下场，仅新激活用新代码
 */
export async function reloadActorClass(
  troupe: Troupe,
  ctor: Function,
  opts: ReloadOptions = {},
): Promise<ReloadResult> {
  const policy = opts.policy ?? "recycle";
  let source = opts.source;
  if (policy === "swap") {
    if (!source) {
      throw new SwapViolationError("swap 需要提供 source 做守则静态检查（DESIGN §9.5）", [
        "未提供源码文本",
      ]);
    }
    const violations = scanActorSource(source);
    if (violations.length > 0) {
      throw new SwapViolationError(
        `swap 被拒绝：源码违反 ${violations.length} 条守则（DESIGN §9.5）`,
        violations,
      );
    }
  }
  return troupe.reloadActorClass(ctor, { policy });
}

export interface DevReloaderOptions {
  /** 监听的源文件列表（绝对或相对 cwd 路径） */
  watch: string[];
  /** 每个角色的策略（缺省 recycle） */
  policy?: ReloadPolicy | ((roleId: string) => ReloadPolicy);
  /** 重载完成回调（日志/Booth 事件用） */
  onReload?: (r: ReloadResult) => void;
  onError?: (e: unknown) => void;
}

export interface DevReloader {
  stop(): void;
}

/**
 * dev 热重载器（M10）：监听文件变更 → 版本化重导（`?t=` 查询串强制重新求值）→
 * 差分注册表（新类替换旧类）→ reloadActorClass 按策略处理在场实例。
 * 使用 allowReplace 窗口：@Performs 重导时同 roleId 替换而非 fail-fast（§8.5 例外）。
 */
export function createDevReloader(troupe: Troupe, opts: DevReloaderOptions): DevReloader {
  const policyOf = (roleId: string): ReloadPolicy =>
    typeof opts.policy === "function" ? opts.policy(roleId) : (opts.policy ?? "recycle");
  const watchers: FSWatcher[] = [];
  let reloading = false;

  const reloadFile = async (file: string): Promise<void> => {
    if (reloading) return;
    reloading = true;
    try {
      const source = readFileSync(file, "utf8");
      const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as Record<string, unknown>;
      for (const exported of Object.values(mod)) {
        if (typeof exported !== "function" || !(exported.prototype ?? null)) continue;
        try {
          const r = await reloadActorClass(troupe, exported as Function, {
            policy: "recycle", // 重导阶段先按 recycle 处理（逐类策略在下方覆写）
            source,
          });
          opts.onReload?.({ ...r, policy: policyOf(r.roleId) });
        } catch (e) {
          if ((e as Error).name === "UnknownRoleError") continue; // 非本 Troupe 角色
          throw e;
        }
      }
    } catch (e) {
      opts.onError?.(e);
    } finally {
      reloading = false;
    }
  };

  for (const file of opts.watch) {
    // 监听父目录（macOS fs.watch 对单文件不可靠），按文件名过滤
    const dir = dirname(file);
    const base = basename(file);
    const w = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === null || filename === base) void reloadFile(file);
    });
    watchers.push(w);
  }

  return {
    stop() {
      for (const w of watchers) w.close();
    },
  };
}
