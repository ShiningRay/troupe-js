/**
 * PropStore 合同（DESIGN §7.2；fencing 语义见 docs/adr/0002-ownership-fencing.md）。
 *
 * 四个维度分离：
 * - revision：并发修订号，每次成功写入 +1，CAS 用；首次 create 成功后为 1，0 保留给"记录不存在"
 * - schemaVersion：结构版本，migrateProps 驱动；只前进不回退
 * - fencingToken：所有权维度（M3/ADR 0002）；epoch 单调，租约顶替 +1
 * - fencingOwner：token 持有者节点身份；与 fencingToken 成对出现
 *
 * Provider 合同（ADR 0002 §4，无"可选校验"）：
 * - create/write 必须原子（单条语句 CAS 语义）；
 * - 携带 {fencingToken, fencingOwner} 时，必须在同一原子语句内校验所有权行：
 *   `owner_id = fencingOwner AND epoch = fencingToken AND lease_until > now(存储时钟)`；
 *   所有权行缺失 = 拒绝（kind="fencing"），行匹配但租约过期 = 拒绝（kind="lease-expired"）；
 * - 未启用 ownership（token 缺省）时不做所有权校验——该模式不承诺跨节点安全；
 * - 能力必须如实声明：capabilities（ADR §8），声明与行为不一致由合同测试（P2-6）兜底；
 * - 写结果不确定（超时）时由调用方 read 校验后决定，不盲目重写。
 */
import type { StoreCapabilities } from "./capabilities.js";

export interface StoredProps {
  props: unknown;
  revision: number;
  schemaVersion: number;
}

/** 所有权 fencing 参数（成对出现；ADR 0002 I1/I3） */
export interface FencingOptions {
  /** 所有权 fencing token（epoch） */
  fencingToken?: number;
  /** token 持有者（Stage 身份 addr#incarnation）；与 fencingToken 成对 */
  fencingOwner?: string;
}

export interface WriteOptions extends FencingOptions {
  /** CAS：仅当当前 revision 相等才写入 */
  expectedRevision: number;
  schemaVersion: number;
}

export interface CreateOptions extends FencingOptions {}

export interface PropStore {
  /** 能力声明（ADR 0002 §8）：production 门禁依据，必须与实际行为一致 */
  readonly capabilities: StoreCapabilities;

  read(namespace: string, roleId: string, stageName: string): Promise<StoredProps | null>;

  /**
   * 仅当记录不存在时成功（原子）；已存在抛 ConflictError(kind="exists")。
   * 携带 fencing 参数时（ADR 0002 I1）：仅当所有权行有效才允许插入；
   * 所有权无效抛 ConflictError(kind="fencing" | "lease-expired")。
   */
  create(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    schemaVersion: number,
    opts?: CreateOptions,
  ): Promise<StoredProps>;

  /**
   * 原子 CAS 写。revision 不匹配或记录不存在抛 ConflictError(kind="revision")；
   * 所有权校验失败抛 kind="fencing" / "lease-expired"；
   * 成功返回新 StoredProps（revision +1）。
   */
  write(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    opts: WriteOptions,
  ): Promise<StoredProps>;

  /** 携带 fencing 参数时仅当所有权行有效才删除（ADR 0002 §4 变更路径矩阵） */
  delete?(namespace: string, roleId: string, stageName: string, opts?: FencingOptions): Promise<void>;
}
