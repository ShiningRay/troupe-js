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

/** 经编解码边界的深拷贝（本地调用/Props 进出边界统一走这里） */
export function codecCopy<T>(value: T): T {
  const text = defaultJsonCodec.encode(value);
  if (text === undefined) return undefined as T;
  return defaultJsonCodec.decode(text) as T;
}
