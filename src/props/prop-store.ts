/**
 * PropStore 合同（DESIGN §7.2）。
 *
 * 三个维度分离：
 * - revision：并发修订号，每次成功写入 +1，CAS 用；首次 create 成功后为 1，0 保留给"记录不存在"
 * - schemaVersion：结构版本，migrateProps 驱动
 * - fencingToken：所有权维度（M3）；Provider 可选校验，拒绝旧 token
 *
 * Provider 合同：create/write 必须原子（单条 CAS 语义）；
 * 写结果不确定（超时）时由调用方 read 校验后决定，不盲目重写。
 */
export interface StoredProps {
  props: unknown;
  revision: number;
  schemaVersion: number;
}

export interface WriteOptions {
  /** CAS：仅当当前 revision 相等才写入 */
  expectedRevision: number;
  schemaVersion: number;
  /** 所有权 fencing token（M3，DESIGN §6.5） */
  fencingToken?: number;
}

export interface PropStore {
  read(namespace: string, roleId: string, stageName: string): Promise<StoredProps | null>;

  /** 仅当记录不存在时成功（原子）；已存在抛 ConflictError(kind="exists") */
  create(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    schemaVersion: number,
  ): Promise<StoredProps>;

  /**
   * 原子 CAS 写。revision 不匹配或记录不存在抛 ConflictError(kind="revision")；
   * 成功返回新 StoredProps（revision +1）。
   */
  write(
    namespace: string,
    roleId: string,
    stageName: string,
    props: unknown,
    opts: WriteOptions,
  ): Promise<StoredProps>;

  delete?(namespace: string, roleId: string, stageName: string): Promise<void>;
}
