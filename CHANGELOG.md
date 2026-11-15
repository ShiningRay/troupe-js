# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循语义化版本。
本文件与 [docs/VERIFICATION.md](./docs/VERIFICATION.md)（验收证据单一来源）配套阅读。

## [0.2.0] - 2026-11-16

Orleans 对齐执行计划（ROADMAP P0–P3 四阶段）全部交付。相对 0.1.0 的语义变化集中在
**分布式正确性、生产安全与可靠消息**；破坏性变更集中在 production 模式门禁（见下）。

### Added

- **目录化所有权（P1）**：`DirectoryStore`（PG/SQLite）+ `DirectoryRouter`——路由以目录为权威，
  HashRing 降级候选/减载（[ADR 0004](./docs/adr/0004-directory-ownership.md)）；同地址重启恢复
  扫描（`ownershipRecovered` 事件）。
- **PG StreamStore + StreamConsumer（P2）**：持久 at-least-once 流（原子 per-topic seq、
  幂等 eventId、ack 只前进、replay/retain + `RetentionExceededError`）；拉取投递
  （失败不 ack 重投、会话内去重、consumer 独立游标）（[ADR 0005](./docs/adr/0005-stream-outbox.md)）。
- **事务性 Outbox/Inbox（P2）**：`publishWithProps` 与 Props 同事务提交（outbox 必存在）；
  dispatcher SKIP LOCKED + lease 宕机重派；退避/dead-letter；Inbox 接收方幂等。
- **协作取消（P2）**：`ctx.signal`（per-Turn AbortSignal）+ wire `cancel` 消息 +
  `troupe.abortCall(callId)`；排队期取消直接拒绝、执行期 Actor 自主提前返回
  （框架不强行 kill，CPU 阻塞语义见 [operations.md](./docs/operations.md)）。
- **PG CueStore（P1）**：SKIP LOCKED due + CAS claim/complete；cron `timeZone` 支持
  （`@Cron(expr, { timeZone })`，Intl wall clock，无效名显式拒绝）。
- **存储能力声明（P0）**：`StoreCapabilities`（crossNodeSafe / supportsFencing /
  supportsTransactions）+ Provider 合同测试（[provider-guide.md](./docs/provider-guide.md)）。
- **TLS 与集群凭证（P1）**：`cluster.tls`（PEM cert/key/ca）；join 预共享 token
  （`joinToken`/`TROUPE_JOIN_TOKEN`）+ 按地址限速；Director `adminToken`。
- **协议 golden fixtures（P3）**：`test/golden/protocol-v2.json` 锚定 xxh32/环归属/信封/
  WireErr（跨语言一致，troupe.cr 对齐）；漂移即红（[ADR 0003](./docs/adr/0003-wire-protocol-v2.md)）。
- **R1–R6 兼容检查矩阵（P3）**：compatViolations 补 R2（必选参数不增）；R4 人工门禁、
  R5/R6 由 fixtures 承担（COMPATIBILITY.md §5 全覆盖）。
- **观测（P1/P2）**：`leaseRenewFailures` / `handovers` 指标、`ownershipRecovered` /
  `leaseRenewFailed` 事件、`Cluster.routerStats()`。
- **CI/nightly**：ubuntu/windows × Node 22/24 矩阵 + PostgreSQL 16 必需 leg（跳过即失败）+
  minimal-install leg + 每日 nightly 混沌。

### Changed

- **production 集群门禁（破坏性）**：必须跨节点安全 Provider（PostgresPropStore）+
  显式 TLS（`cluster.tls`）+ Director 凭证（`adminToken`/`TROUPE_ADMIN_TOKEN`）；
  SQLite/内存 Provider 需显式 `allowUnsafeProviders: true` 豁免（启动标记 degraded）。
- **fencing 全路径收紧（破坏性）**：启用 ownership 时 `create`/回退写/`delete` 全部携带
  fencing token；所有权行缺失/租约过期即拒绝（`ConflictError` 新增 kind
  `fencing` / `lease-expired`）；不再存在无 token 写路径。
- **续租失败停止接单（破坏性）**：续租存储异常累计达阈值或越过租约边界 → invalidate
  （先停止接单再等在飞 settle），不再"仅 warn 继续"。
- Show 投递语义文档对齐：实时尽力投递 + 3 次退避重试、可能重复、**非 durable**
  （持久流请使用 Stream）。

### Fixed

- fencing SQL：所有权行缺失不再被 `NOT EXISTS` 放行；租约判定改存储时钟（ADR 0002 §5）。
- TLS 客户端等待 `secureConnect` 再写帧；自签证书需含 IP SAN（部署注意）。
- `pg` 依赖声明为 optional peer + exports 暴露 `troupe/props/postgres`（最小安装可用，
  安装 pg 后 Provider 可达）。

### 验收证据

CI 六 job（ubuntu/windows × Node 22/24 + pg-required + minimal-install）全绿；
235+ 测试（含真实 PG 契约、3 节点混沌冻结/接管/FENCED）。详见 VERIFICATION.md。
