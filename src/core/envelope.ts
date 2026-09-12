/**
 * 存储信封（DESIGN §6.5 / §7.3）：幂等记录必须随 Props **原子提交**，
 * 因此运行时写入 PropStore 的 props 字段是本信封——用户 Props 与幂等记录同一行落盘。
 * PropStore 只存 blob，信封由运行时解释（Booth/inspect 展示时同样先解包）。
 */

const MARK = "__troupe_envelope__";
const ENVELOPE_VERSION = 1;

export interface IdemRecord {
  /** 参数指纹 */
  fp: string;
  ok: boolean;
  value?: unknown;
  err?: { name: string; message: string };
  /** 过期时间（epoch ms，保留期限见 DESIGN §6.5 默认 7 天） */
  exp: number;
}

export type IdemMap = Record<string, IdemRecord>;

interface EnvelopeShape {
  [MARK]: typeof ENVELOPE_VERSION;
  props: unknown;
  idem?: IdemMap;
}

export function wrapEnvelope(props: unknown, idem: IdemMap): unknown {
  const env: EnvelopeShape = { [MARK]: ENVELOPE_VERSION, props, idem };
  return env;
}

export function unwrapEnvelope(storedProps: unknown): { props: unknown; idem: IdemMap } {
  if (
    storedProps !== null &&
    typeof storedProps === "object" &&
    (storedProps as Record<string, unknown>)[MARK] === ENVELOPE_VERSION
  ) {
    const env = storedProps as EnvelopeShape;
    return { props: env.props, idem: env.idem ?? {} };
  }
  // 非信封形态：视为手工植入的用户 Props（裸对象）
  return { props: storedProps, idem: {} };
}

/** 清除已过保留期限的幂等记录（save/load 时惰性执行，DESIGN §6.5） */
export function pruneIdem(idem: IdemMap, now: number): IdemMap {
  const out: IdemMap = {};
  for (const [k, rec] of Object.entries(idem)) {
    if (rec.exp > now) out[k] = rec;
  }
  return out;
}
