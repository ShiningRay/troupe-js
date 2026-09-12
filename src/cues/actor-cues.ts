import type { ReminderSpec } from "./cue-store.js";

/** Actor 侧的提醒 API（由 Troupe.form 组装，StageManager 注入 ctx） */
export interface ActorCueApi {
  schedule(identity: { roleId: string; stageName: string }, name: string, spec: ReminderSpec): Promise<void>;
  /** 声明式登记（@Cron/@Every 自动注册）：不存在才插入，不重置 nextDue */
  ensure(identity: { roleId: string; stageName: string }, name: string, spec: ReminderSpec): Promise<void>;
  cancel(identity: { roleId: string; stageName: string }, name: string): Promise<boolean>;
}
