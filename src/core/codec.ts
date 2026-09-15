import { SerializationError } from "./errors.js";
import { isAgent } from "./agent.js";

/**
 * Codec 边界（DESIGN §6.1，M2）：
 * - Date → ISO 字符串
 * - BigInt / Map / Set / 函数 / Agent 引用 / 循环引用 → 抛 SerializationError 并指引改用可序列化 DTO
 * - undefined 字段按 JSON 语义丢失；NaN/Infinity → null
 * 本地调用默认经同一编解码/复制边界（local/远程/Rehearsal 行为一致）；
 * `form({ localCallByReference: true })` 可显式关闭复制换性能（语义分叉自担）。
 */
export interface Codec {
  encode(value: unknown): string | undefined;
  decode(text: string): unknown;
}

function guard(key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    throw new SerializationError(
      `BigInt 不可序列化（默认 JSON 语义，DESIGN §6.1）：字段 "${key}" 请改用 string/number`,
    );
  }
  if (value instanceof Map || value instanceof Set) {
    throw new SerializationError(
      `Map/Set 不可序列化（默认 JSON 语义，DESIGN §6.1）：字段 "${key}" 请改用普通对象/数组`,
    );
  }
  if (typeof value === "function") {
    throw new SerializationError(
      `函数不可跨调用边界（DESIGN §6.1）：字段 "${key}" 请改用可序列化 DTO`,
    );
  }
  if (isAgent(value)) {
    throw new SerializationError(
      `Agent 引用不可跨调用边界（DESIGN §6.1）：字段 "${key}" 请传 (roleId, stageName)，由对端重新 cast`,
    );
  }
  return value;
}

class JsonCodec implements Codec {
  encode(value: unknown): string | undefined {
    try {
      return JSON.stringify(value, guard);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/circular/i.test(msg)) {
        throw new SerializationError("检测到循环引用（DESIGN §6.1）：请改用可序列化的树形结构");
      }
      if (e instanceof SerializationError) throw e;
      throw new SerializationError(`无法序列化：${msg}`);
    }
  }

  decode(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new SerializationError(`无法反序列化：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const defaultJsonCodec: Codec = new JsonCodec();

/**
 * 快路径判定（性能专项，开放问题 7）：原始值与"原始值数组"对 JSON round-trip
 * 恒等——免去 stringify/parse。语义保持：
 * - NaN/±Infinity 不走快路径（JSON 语义归为 null，走慢路径保真）
 * - -0 归一为 +0（JSON 语义）
 * - 对象/嵌套结构一律走慢路径（JSON 的整数键重排使浅拷贝不等价）
 */
function fastPathValue(v: unknown): { ok: boolean; value: unknown } {
  if (v === null) return { ok: true, value: null };
  const t = typeof v;
  if (t === "string" || t === "boolean") return { ok: true, value: v };
  if (t === "number") {
    if (!Number.isFinite(v as number)) return { ok: false, value: null };
    return { ok: true, value: v === 0 ? 0 : v };
  }
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) {
      const e = fastPathValue(v[i]);
      if (!e.ok) return { ok: false, value: null };
      out[i] = e.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, value: null };
}

/** 经编解码边界的深拷贝（本地调用/Props 进出边界统一走这里） */
export function codecCopy<T>(value: T): T {
  const fast = fastPathValue(value);
  if (fast.ok) return fast.value as T; // 快路径：与 JSON round-trip 恒等（§6.1 语义不变）
  const text = defaultJsonCodec.encode(value);
  if (text === undefined) return undefined as T;
  return defaultJsonCodec.decode(text) as T;
}
