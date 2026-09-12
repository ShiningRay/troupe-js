/**
 * CueStore（持久提醒，DESIGN §7.5）：
 * - 记录 = Actor 身份 + 稳定名称 + 可序列化负载 + 计划（every 周期 / at 一次性）+ nextDue + statusVersion
 * - 投递语义：至少一次 + 业务幂等；执行中宕机 → 租约到期重新 claim、重复投递
 * - 错过多个周期：跳过并立即补发一次（complete 时 nextDue = now + every，不追赶）
 * - 注销竞争：claim/cancel 并发时以 statusVersion CAS 裁决
 * 计划形态：every（周期）、at（一次性绝对时间）、cron（5 字段表达式，服务器本地时间）。
 */
export interface ReminderSpec {
  every?: string | number;
  at?: number | Date;
  /** cron 表达式（"0 9 * * *"，服务器本地时间；@Cron 装饰器使用） */
  cron?: string;
  payload?: unknown;
}

export interface ReminderRecord {
  namespace: string;
  roleId: string;
  stageName: string;
  name: string;
  payload: unknown;
  /** 周期（ms）；非周期提醒为 null */
  everyMs: number | null;
  /** 一次性绝对时间（epoch ms）；非一次性提醒为 null */
  at: number | null;
  /** cron 表达式（服务器本地时间）；非 cron 提醒为 null（M4 装饰器交付） */
  cron: string | null;
  nextDue: number;
  /** CAS 版本：claim/complete/upsert 递增 */
  statusVersion: number;
  /** 执行租约（epoch ms）；0 = 未持有 */
  leaseUntil: number;
  owner: string | null;
}

import { nextCronTime, parseCronExpression } from "./cron.js";

export type ReminderKey = Pick<ReminderRecord, "namespace" | "roleId" | "stageName" | "name">;

export interface CueStore {
  /** 插入或更新计划与负载（statusVersion+1：撤销在途 complete 的竞争） */
  upsert(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): Promise<void>;
  /** 声明式登记（@Cron/@Every 自动注册用）：仅当不存在时插入，不重置已存在的 nextDue */
  ensure(rec: Omit<ReminderRecord, "statusVersion" | "leaseUntil" | "owner">): Promise<void>;
  /** 注销；返回是否存在 */
  delete(key: ReminderKey): Promise<boolean>;
  /** 到期查询（nextDue <= now 且租约已过期） */
  due(now: number, limit: number): Promise<ReminderRecord[]>;
  /**
   * 原子认领（租约未过期时失败）：statusVersion+1、置 owner/leaseUntil，
   * 返回认领后的记录（含新 statusVersion）。
   */
  claim(key: ReminderKey, owner: string, leaseUntil: number, now: number): Promise<ReminderRecord | null>;
  /**
   * 完成确认（CAS）：statusVersion 匹配才生效；nextDue=null 表示一次性完成（删除记录）；
   * 同时清空租约。
   */
  complete(key: ReminderKey, expectedStatusVersion: number, nextDue: number | null): Promise<boolean>;
  /** 全量列表（Director.cues / 调试） */
  list(namespace: string): Promise<ReminderRecord[]>;
}

export function reminderKey(
  namespace: string,
  roleId: string,
  stageName: string,
  name: string,
): ReminderKey {
  return { namespace, roleId, stageName, name };
}

/** 计算下次到期：cron → 解析下次触发；周期 → now+every（错过跳过补发一次，不追赶）；一次性 → null（完成即删） */
export function nextDueAfter(rec: Pick<ReminderRecord, "everyMs" | "cron">, now: number): number | null {
  if (rec.cron !== null) return nextCronTime(parseCronExpression(rec.cron), now);
  return rec.everyMs !== null ? now + rec.everyMs : null;
}

/** 深拷贝经 JSON 边界（负载必须可序列化，§6.1 语义） */
export function cloneReminderPayload(payload: unknown): unknown {
  return JSON.parse(JSON.stringify(payload)) as unknown;
}
