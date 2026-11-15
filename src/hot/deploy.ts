/**
 * 生产热替换部署（M11，DESIGN §9.4，独立实验）：
 * - DeployBundle = { roleId, source（自包含 JS，plain build 产物）, className?, policy, sig }
 * - sig = HMAC-SHA256(roleId:source, secret)：接收 Stage 验签（防篡改的完整性证据；
 *   传输保护由 TROUPE_ADMIN_TOKEN + 受控网络承担，§6.1）
 * - 求值：`data:text/javascript` 动态导入——bundle 必须自包含（无相对导入），
 *   内容即模块标识（同源重导天然去重）
 * - 部署期静态检查（L3 规则落地，COMPATIBILITY.md §5）：
 *   R1 方法只增不减；R3 schemaVersion 逐级 +1 且必须挂 migrateProps
 */
import { createHmac } from "node:crypto";
import type { RoleMeta } from "../core/meta.js";
import { Actor } from "../core/actor.js";

export interface DeployBundle {
  roleId: string;
  /** 自包含 JS 模块源码（build 产物；必须导出目标类） */
  source: string;
  /** 导出的类名（缺省取唯一导出） */
  className?: string;
  policy: "swap";
  /** HMAC-SHA256(roleId:source, secret) 的 hex */
  sig: string;
}

export function signBundle(roleId: string, source: string, secret: string): string {
  return createHmac("sha256", secret).update(`${roleId}:${source}`).digest("hex");
}

export function verifyBundle(bundle: DeployBundle, secret: string): boolean {
  return signBundle(bundle.roleId, bundle.source, secret) === bundle.sig;
}

/** 求值 bundle：data URL 动态导入，返回目标类（className 或唯一类导出） */
export async function evaluateBundle(bundle: DeployBundle): Promise<Function> {
  const versioned = `${bundle.source}\n//deploy:${Date.now()}:${Math.random()}`; // 内容即标识：确保重导
  const b64 = Buffer.from(versioned, "utf8").toString("base64");
  const mod = (await import(`data:text/javascript;base64,${b64}`)) as Record<string, unknown>;
  const classes = Object.entries(mod).filter(
    ([, v]) => typeof v === "function" && (v as { prototype?: unknown }).prototype !== undefined,
  );
  if (bundle.className) {
    const hit = classes.find(([name]) => name === bundle.className);
    if (!hit) throw new Error(`bundle 未导出类 "${bundle.className}"（导出：${classes.map(([n]) => n).join(", ")}）`);
    return hit[1] as Function;
  }
  if (classes.length === 1) return classes[0][1] as Function;
  throw new Error(`bundle 导出了 ${classes.length} 个类，需指定 className`);
}

/**
 * 兼容静态检查（COMPATIBILITY.md §5 的可执行子集）：
 * - R1 方法只增不减（移除/改名即违规）
 * - R3 schemaVersion 只允许 +1 或不变；递增必须覆写 migrateProps
 * 返回违规列表（空 = 通过）。
 */
export function compatViolations(oldMeta: RoleMeta, newCtor: Function, newMeta: RoleMeta): string[] {
  const out: string[] = [];
  const removed = [...oldMeta.rpcMethods].filter((m) => !newMeta.rpcMethods.has(m));
  // R2（P3-4 补全）：必选参数个数不增（新增参数必须带默认值 → function.length 不变或减少）
  for (const m of [...oldMeta.rpcMethods].filter((m) => newMeta.rpcMethods.has(m))) {
    const before = oldMeta.rpcParamCounts.get(m);
    const after = newMeta.rpcParamCounts.get(m);
    if (before !== undefined && after !== undefined && after > before) {
      out.push(`R2 违规：方法 ${m} 必选参数 ${before} → ${after}（新增参数必须有默认值，旧调用方省略时行为不变）`);
    }
  }
  // R4/R5/R6 的可解释状态行（ROADMAP P3-4：自动检查或明确人工门禁）：
  // - R4（Cue/Show payload 结构）：无静态检查——人工语义评审必填（发布说明）
  // - R5（wire 向后兼容）：golden fixtures（test/golden/protocol-v2.json）+ join protocolVersion 校验承担
  // - R6（幂等记录指纹结构）：golden fixtures 的 envelope/idem 形状锚定承担
  if (removed.length > 0) {
    out.push(`R1 违规：方法被移除/改名：${removed.join(", ")}`);
  }
  if (newMeta.schemaVersion > oldMeta.schemaVersion + 1) {
    out.push(
      `R3 违规：schemaVersion 从 ${oldMeta.schemaVersion} 跳到 ${newMeta.schemaVersion}（只允许 +1，逐级迁移）`,
    );
  } else if (newMeta.schemaVersion > oldMeta.schemaVersion) {
    const own = (newCtor.prototype as unknown as Record<string, unknown>)?.migrateProps;
    if (typeof own !== "function" || own === (Actor.prototype as unknown as Record<string, unknown>).migrateProps) {
      out.push(`R3 违规：schemaVersion 递增但未覆写 migrateProps（逐级迁移）`);
    }
  }
  return out;
}

/** 部署历史（每 Stage 内存）：一键回滚用 */
export class DeployHistory {
  private entries = new Map<string, Array<DeployBundle>>();

  push(roleId: string, bundle: DeployBundle): void {
    let list = this.entries.get(roleId);
    if (!list) {
      list = [];
      this.entries.set(roleId, list);
    }
    list.push(bundle);
  }

  /** 上一版本（用于回滚）；无上一版本返回 null */
  previous(roleId: string): DeployBundle | null {
    const list = this.entries.get(roleId);
    if (!list || list.length < 2) return null;
    return list[list.length - 2];
  }
}
