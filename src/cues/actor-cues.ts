import type { ReminderSpec } from "./cue-store.js";

/** Actor 侧的提醒 API（由 Troupe.form 组装，StageManager 注入 ctx） */
export interface ActorCueApi {
  schedule(identity: { roleId: string; stageName: string }, name: string, spec: ReminderSpec): Promise<void>;
  cancel(identity: { roleId: string; stageName: string }, name: string): Promise<boolean>;
}
