# Provider 作者指南（存储适配）

面向要为 Troupe.js 新增 PropStore / CueStore / StreamStore 实现的作者。新 Provider
**必须**通过 `test/provider-contract.test.ts` 合同测试（连同其能力专属的补充契约），
并在 `test/provider-contract.test.ts` 的 factories 中注册。

## 1. 接口义务

### PropStore（DESIGN §7.2 + ADR 0002）

| 方法 | 义务 |
|---|---|
| `read` | 返回已提交快照（副本语义） |
| `create` | 不存在才成功（原子）；携带 `{fencingToken, fencingOwner}` 时**在同一原子语句内**校验所有权行 `owner_id + epoch + lease_until > 存储时钟`；失败分类 `fencing` / `lease-expired` / `exists` |
| `write` | 单语句 CAS（`revision` 匹配）；fencing 校验同上；行缺失 → `revision` |
| `delete?` | 携 token 时仅所有权行有效才删除 |
| `capabilities` | 如实声明（见下表）；**声明与行为不一致 = 合同测试失败** |

### OwnershipStore / DirectoryStore（ADR 0002 §6.5 / ADR 0004）

- `acquire/claim`：单语句原子（插入或过期顶替 epoch+1 / 本人续租）；**同地址不同
  incarnation 允许立即顶替**（端口互斥 ⇒ 旧进程必死，ADR 0004 §4）。
- `release`：仅 owner+epoch 匹配；置空租约（不删行）+ `draining` + version+1。
- 租约有效性判定**只用存储时钟**（PG：`clock_timestamp()`；SQLite 同机与系统时钟同源）。
- epoch 跨释放单调（不删行）；version 每次归属/租约变更 +1。

### CueStore（DESIGN §7.5）

`claim` 的租约 CAS、`complete` 的 statusVersion CAS 必须原子；跨节点 Provider 的
`due` 建议 `FOR UPDATE SKIP LOCKED`（参考 `src/cues/postgres.ts`）。

### StreamStore（ADR 0005 §2）

per-topic seq 原子分配（单语句）、`UNIQUE(topic, event_id)` 幂等发布、ack 只前进、
裁剪段显式 `RetentionExceededError`。

## 2. 能力声明（capabilities）

| Provider | crossNodeSafe | supportsFencing | supportsTransactions |
|---|---|---|---|
| InMemoryPropStore / InMemoryCueStore | ✗ | ✗ | — |
| SqlitePropStore / SqliteCueStore | ✗ | ✓ | ✓ |
| PostgresPropStore / PostgresCueStore | ✓ | ✓ | ✓ |
| PostgresStreamStore（stream） | ✓ | — | — |

- `crossNodeSafe=false` 的 Provider 在 `cluster.mode=production` 被拒绝（P0-6 门禁，
  `allowUnsafeProviders` 显式豁免并标 degraded）。
- `supportsFencing=false` 的 Provider 不得声称支持 ADR 0002 I1/I3——合同测试跳过
  fencing 组，但 production + ownership 场景仍会被 crossNodeSafe 门禁拦下。

## 3. 不支持项清单（当前边界）

- SQLite：跨主机共享盘**不安全**（WAL 锁语义仅同机多进程成立）；
- 内存 Provider：无所有权/fencing 语义（Rehearsal/测试用途）；
- Stream：PG 窄流（ADR 0005 方案 A）；NATS/Redis adapter 仅有接口留位；
- 所有 Provider：**不承诺 exactly-once**（至少一次 + 业务幂等是承诺边界）。

## 4. 合同测试接入

1. 在 `test/provider-contract.test.ts` 的 `factories` 中注册（name/caps/make/done）；
2. 有 OwnershipStore/DirectoryStore 语义 → `supportsOwnership: true`（fencing 组启用）；
3. PG 类 Provider 用 `TROUPE_TEST_PG_URL` 门控 + `TROUPE_REQUIRE_PG=1` 时缺失即失败
   （CI pg-required leg 必跑，禁止静默跳过）；
4. 运行：`pnpm vitest run test/provider-contract.test.ts`。
