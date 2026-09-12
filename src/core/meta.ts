import { Actor } from "./actor.js";
import { captureSource, registerActor } from "./repertoire.js";
import { parseDuration } from "./duration.js";

/** TS5 stage-3 类装饰器签名（内建 ClassDecorator 是 legacy 签名，不适用） */
type Stage3ClassDecorator = (target: Function, context: ClassDecoratorContext) => Function | void;

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
  /** RPC 白名单：原型链上的公开方法（生命周期/基类成员/下划线开头者除外） */
  rpcMethods: ReadonlySet<string>;
  source: string;
}

/** @Improv / @ReadOnly 标注在方法函数上的标记（M1 按严格串行执行并告警，DESIGN §5.4） */
const IMPROV_MARK = Symbol("troupe.improv");
const READONLY_MARK = Symbol("troupe.readOnly");

interface DecoratorClassMeta {
  role?: string;
  intermission?: string | number;
}

const classMeta = new WeakMap<Function, DecoratorClassMeta>();

/**
 * 角色声明（DESIGN §3.1）：默认写入进程级注册表（import 即入团）。
 * roleId 缺省 = 类名去 "Actor" 后缀。
 */
export function Performs(role?: string): (target: Function, context: ClassDecoratorContext) => Function | void {
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

const RESERVED_MEMBERS = new Set([
  "constructor",
  "onStage",
  "offStage",
  "saveProps",
  "idempotent",
  "migrateProps",
  "onCue",
]);

function resolveRoleId(ctor: Function, decoratorRole?: string): string {
  const statics = ctor as { role?: string; roleId?: string };
  return decoratorRole ?? statics.roleId ?? statics.role ?? ctor.name.replace(/Actor$/, "");
}

function collectRpcMethods(ctor: Function): { names: Set<string>; improv: Set<string>; readOnly: Set<string> } {
  const names = new Set<string>();
  const improv = new Set<string>();
  const readOnly = new Set<string>();
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
    }
    proto = Object.getPrototypeOf(proto);
  }
  return { names, improv, readOnly };
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
    timeouts?: Record<string, string | number>;
    schemaVersion?: number;
    initialProps?: () => unknown;
  };

  const roleId = resolveRoleId(ctor, deco.role);
  const intermissionMs = parseDuration(deco.intermission ?? statics.intermission ?? defaults.intermissionMs);
  const { names, improv, readOnly } = collectRpcMethods(ctor);
  for (const n of statics.improv ?? []) improv.add(n);
  for (const n of statics.readOnly ?? []) readOnly.add(n);

  const timeouts = new Map<string, number>();
  for (const [method, v] of Object.entries(statics.timeouts ?? {})) {
    timeouts.set(method, parseDuration(v));
  }

  const warnings: string[] = [];
  for (const m of [...improv, ...readOnly]) {
    warnings.push(
      `M1 严格串行：${roleId}.${m} 的 @Improv/@ReadOnly 标注暂按串行执行（交错执行为后续里程碑，DESIGN §5.4）`,
    );
  }

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
      rpcMethods: names,
      source,
    },
    warnings,
  };
}
