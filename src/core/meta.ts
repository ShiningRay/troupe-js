import { Actor } from "./actor.js";
import { captureSource, registerActor } from "./repertoire.js";
import { parseDuration } from "./duration.js";
import { parseCronExpression, validateTimeZone } from "../cues/cron.js";
import { registerDecoratedCues } from "./cue-dispatch.js";

/** TS5 stage-3 类装饰器签名。实现都是原地标注（返回 void）——声明为 Function | void
 *  会让带 static 成员的类在 strict 下报 TS1270，故收紧为 void。 */
type Stage3ClassDecorator = (target: Function, context: ClassDecoratorContext) => void;

/** 角色元数据：注册与调度所需的全部静态信息 */
export interface RoleMeta {
  ctor: Function;
  roleId: string;
  intermissionMs: number;
  improv: ReadonlySet<string>;
  readOnly: ReadonlySet<string>;
  timeouts: ReadonlyMap<string, number>;
  schemaVersion: number;
  initialProps: () => unknown;
  /** 代码版本（M10 热重载）：初始 1，reloadActorClass 递增 */
  codeVersion: number;
  /** RPC 白名单：原型链上的公开方法（生命周期/基类成员/下划线开头者除外） */
  rpcMethods: ReadonlySet<string>;
  /** 方法名 → 必选参数个数（function.length；P3-4 R2 参数兼容检查依据） */
  rpcParamCounts: ReadonlyMap<string, number>;
  /** 声明式持久提醒（@Cron/@Every）：方法名 → 计划 */
  persistentCues: ReadonlyMap<string, { everyMs?: number; cron?: string; timeZone?: string }>;
  /** 声明式内存 Cue（@Local）：方法名 → 周期 ms */
  localCues: ReadonlyMap<string, number>;
  source: string;
}

/** @Improv / @ReadOnly 标注在方法函数上的标记（M1 按严格串行执行并告警，DESIGN §5.4） */
const IMPROV_MARK = Symbol("troupe.improv");
const READONLY_MARK = Symbol("troupe.readOnly");
/** @Cron/@Every/@Local 定时任务标注（声明式 Cue，§3.3/§7.5） */
const CRON_MARK = Symbol("troupe.cron");
const EVERY_MARK = Symbol("troupe.every");
const LOCAL_MARK = Symbol("troupe.local");

interface DecoratorClassMeta {
  role?: string;
  intermission?: string | number;
}

const classMeta = new WeakMap<Function, DecoratorClassMeta>();

/**
 * 角色声明（DESIGN §3.1）：默认写入进程级注册表（import 即入团）。
 * roleId 缺省 = 类名去 "Actor" 后缀。
 */
export function Performs(role?: string): (target: Function, context: ClassDecoratorContext) => void {
  return (target: Function, _context: ClassDecoratorContext): void => {
    classMeta.set(target, { ...classMeta.get(target), role });
    registerActor(resolveRoleId(target, role), target, captureSource());
  };
}

/** 空闲超时自动下场（DESIGN §3.1 修饰表），如 @Intermission("10m") */
export function Intermission(duration: string | number): Stage3ClassDecorator {
  return (target: Function, _context: ClassDecoratorContext): void => {
    classMeta.set(target, { ...classMeta.get(target), intermission: duration });
  };
}

/**
 * 可重入标注（DESIGN §5.4）。M1 语义：标注了也按严格串行执行并告警；
 * 交错执行在后续里程碑（PLAN M5）交付。
 */
export function Improv(target: Function, _context: ClassMethodDecoratorContext<any, any>): void {
  (target as any)[IMPROV_MARK] = true;
}

/** 只读标注（DESIGN §5.4）。M1 语义同 @Improv：严格串行执行并告警。 */
export function ReadOnly(target: Function, _context: ClassMethodDecoratorContext<any, any>): void {
  (target as any)[READONLY_MARK] = true;
}

/** 声明式 Cue 装饰器工厂的返回类型 */
type CueDecoratorFactory = (target: Function, ctx: ClassMethodDecoratorContext<any, any>) => void;

/**
 * 声明式持久提醒（cron）：`@Cron("0 9 * * *")` —— 每天 09:00（服务器本地时间）。
 * 方法即处理器：激活时自动登记（不存在才插入，不重置已排期）；触发经 onCue 进串行 Turn；
 * 装饰的方法仍可经 RPC 手动触发（CLI/Booth 调试）。表达式在装饰期解析，非法即报错。
 */
export function Cron(expr: string, opts?: { timeZone?: string }): CueDecoratorFactory {
  parseCronExpression(expr); // 装饰期 fail-fast
  if (opts?.timeZone !== undefined) validateTimeZone(opts.timeZone);
  return (target: Function, _ctx: ClassMethodDecoratorContext<any, any>): void => {
    (target as any)[CRON_MARK] = { cron: expr, timeZone: opts?.timeZone };
  };
}

/** 声明式持久提醒（周期）：`@Every("30s")` —— 语义同 scheduleReminder({ every }) */
export function Every(every: string | number): CueDecoratorFactory {
  const ms = parseDuration(every);
  if (!(ms > 0)) throw new TypeError(`@Every 时长必须为正：${String(every)}`);
  return (target: Function, _ctx: ClassMethodDecoratorContext<any, any>): void => {
    (target as any)[EVERY_MARK] = ms;
  };
}

/** 声明式内存 Cue：`@Local("300ms")` —— 仅在场时有效，随下场清理（§3.3） */
export function Local(every: string | number): CueDecoratorFactory {
  const ms = parseDuration(every);
  if (!(ms > 0)) throw new TypeError(`@Local 时长必须为正：${String(every)}`);
  return (target: Function, _ctx: ClassMethodDecoratorContext<any, any>): void => {
    (target as any)[LOCAL_MARK] = ms;
  };
}

const RESERVED_MEMBERS = new Set([
  "constructor",
  "onStage",
  "offStage",
  "saveProps",
  "idempotent",
  "migrateProps",
  "onCue",
  "onCodeSwap",
]);

function resolveRoleId(ctor: Function, decoratorRole?: string): string {
  const statics = ctor as { role?: string; roleId?: string };
  return decoratorRole ?? statics.roleId ?? statics.role ?? ctor.name.replace(/Actor$/, "");
}

function collectRpcMethods(ctor: Function): {
  names: Set<string>;
  improv: Set<string>;
  readOnly: Set<string>;
  persistentCues: Map<string, { everyMs?: number; cron?: string; timeZone?: string }>;
  localCues: Map<string, number>;
} {
  const names = new Set<string>();
  const improv = new Set<string>();
  const readOnly = new Set<string>();
  const persistentCues = new Map<string, { everyMs?: number; cron?: string }>();
  const localCues = new Map<string, number>();
  let proto: object | null = (ctor as { prototype: object }).prototype;
  const baseProto = (Actor as { prototype: object }).prototype;
  while (proto && proto !== baseProto) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (RESERVED_MEMBERS.has(name) || name.startsWith("_") || names.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (typeof desc?.value !== "function") continue;
      names.add(name);
      if ((desc.value as any)[IMPROV_MARK]) improv.add(name);
      if ((desc.value as any)[READONLY_MARK]) readOnly.add(name);
      if ((desc.value as any)[CRON_MARK] !== undefined) {
        const mark = (desc.value as any)[CRON_MARK] as string | { cron: string; timeZone?: string };
        const plan = typeof mark === "string" ? { cron: mark } : mark; // 兼容旧标记形态
        persistentCues.set(name, plan);
      }
      if ((desc.value as any)[EVERY_MARK] !== undefined) persistentCues.set(name, { everyMs: (desc.value as any)[EVERY_MARK] });
      if ((desc.value as any)[LOCAL_MARK] !== undefined) localCues.set(name, (desc.value as any)[LOCAL_MARK]);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return { names, improv, readOnly, persistentCues, localCues };
}

export interface DescribeRoleResult {
  meta: RoleMeta;
  /** M1 告警：@Improv/@ReadOnly 暂按严格串行执行 */
  warnings: string[];
}

/** 解析一个 Actor 类的角色元数据（装饰器与静态字段双轨合并，DESIGN §3.1） */
export function describeRole(
  ctor: Function,
  defaults: { intermissionMs: number },
  source = "<explicit actors[]>",
): DescribeRoleResult {
  const deco = classMeta.get(ctor) ?? {};
  const statics = ctor as {
    role?: string;
    roleId?: string;
    intermission?: string | number;
    improv?: string[];
    readOnly?: string[];
    /** RPC 允许清单：声明后仅列出的方法可被远程调用（默认全公开方法可调用） */
    rpc?: readonly string[];
    timeouts?: Record<string, string | number>;
    schemaVersion?: number;
    initialProps?: () => unknown;
    codeVersion?: number;
  };

  const roleId = resolveRoleId(ctor, deco.role);
  const intermissionMs = parseDuration(deco.intermission ?? statics.intermission ?? defaults.intermissionMs);
  const { names, improv, readOnly, persistentCues, localCues } = collectRpcMethods(ctor);
  for (const n of statics.improv ?? []) improv.add(n);
  for (const n of statics.readOnly ?? []) readOnly.add(n);

  // static rpc 允许清单（§8.2 最小暴露面）：声明后白名单 = 清单 ∩ 公开方法。
  // 列出未知方法名按拼错处理，注册期 fail-fast。
  let rpcMethods = names;
  if (statics.rpc) {
    for (const n of statics.rpc) {
      if (!names.has(n)) {
        throw new TypeError(
          `static rpc 含未知方法 "${n}"（角色 ${resolveRoleId(ctor, deco.role)}）——公开方法集：[${[...names].join(", ")}]`,
        );
      }
    }
    rpcMethods = new Set(statics.rpc);
  }

  const timeouts = new Map<string, number>();
  for (const [method, v] of Object.entries(statics.timeouts ?? {})) {
    timeouts.set(method, parseDuration(v));
  }

  const warnings: string[] = [];

  registerDecoratedCues(ctor, persistentCues.keys());

  return {
    meta: {
      ctor,
      roleId,
      intermissionMs,
      improv,
      readOnly,
      timeouts,
      schemaVersion: statics.schemaVersion ?? 1,
      initialProps: statics.initialProps?.bind(ctor) ?? (() => ({})),
      codeVersion: statics.codeVersion ?? 1,
      rpcMethods,
      rpcParamCounts: buildParamCounts(ctor, rpcMethods),
      persistentCues,
      localCues,
      source,
    },
    warnings,
  };
}

/** 方法名 → 必选参数个数（P3-4 R2：新增参数必须带默认值 → function.length 不增） */
function buildParamCounts(ctor: Function, methods: ReadonlySet<string>): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const proto = ctor.prototype as Record<string, unknown>;
  for (const m of methods) {
    const fn = proto[m];
    if (typeof fn === "function") out.set(m, fn.length);
  }
  return out;
}
