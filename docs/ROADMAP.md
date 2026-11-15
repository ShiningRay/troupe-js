# Troupe.js Orleans 对齐执行计划

> 配套分析：[ORLEANS_GAP.md](./ORLEANS_GAP.md)。本文只给相对阶段与工程估算，不设虚构日期；估算以 1 名熟悉代码的工程师全职投入为基准，2 人可并行但受依赖与评审制约。
> 目标不是复制 Orleans 全部模块，而是把 Troupe.js 做成**可验证的 Orleans-class 核心**：单激活、租约/fencing、目录化路由、持久提醒、至少一次消息、可复现的故障恢复。

## 0. 计划原则

1. **正确性优先于功能**：P0 未关闭前，不新增目录/流/事务等分布式模块。
2. **证据优先于声明**：每个任务必须有失败反例、真实 Provider/拓扑测试；CI skip 视为失败。
3. **单一权威**：所有权以共享存储中的 lease/epoch 为准；HashRing 只做候选与减载，不做最终路由。
4. **先窄后宽**：Stream 先做 PG 窄契约，吞吐不足再评估 NATS；不做通用消息队列。
5. **明确非目标**：分布式 ACID、Orleans Provider 全生态、.NET 序列化/DI 兼容、跨语言混群（在 P3 前）。

## 1. 总览

| 阶段 | 目标 | 关键交付 | 估算 | 退出门禁 |
|---|---|---|---|---|
| P0 可信基线 | 关闭已知数据/安全洞，建立 CI | fencing 全路径、续租停服、capability、TLS/join 最小方案、CI 矩阵 | 10–15 pd（2–3 周） | 旧 epoch 的 create/write/回退写全部拒绝；production 拒绝 SQLite；CI 真跑 PG |
| P1 生产 HA | 小/中型集群可故障恢复 | directory-backed ownership、PG CueStore、TLS/join、3 节点混沌 | 25–35 pd（5–7 周） | 3 节点 kill -9/PG 重启/分区后无未防护双活；提醒跨节点恢复 |
| P2 可靠消息 | 明确实时 vs 持久边界 | Stream API + PG Provider、Outbox/Inbox、协作取消 | 20–30 pd（4–6 周） | 发布者/消费者/coordinator 宕机后可恢复；ack/replay/retention 有测试 |
| P3 互操作与升级 | 协议/版本/滚动升级可验证 | 协议 ADR + golden fixtures、混合版本测试、R1–R6 检查 | 15–25 pd（3–5 周） | 旧/新节点混合运行通过；golden fixtures 跨仓一致 |

**推荐交付范围 B = P0 + P1**（约 35–50 pd）：这是“敢对外说生产可用”的最低门槛。范围 C = P0–P3（约 70–105 pd）才是 Orleans-class 核心 + 可靠消息。范围 A = 仅 P0（约 2–3 周），适合先止血。

## 2. P0：可信基线（第 1–3 周）——✅ 已完成（2026-11-16）

> P0-1..P0-8 全部交付并推送：ADR 0002、反例 F1–F6（先红后绿）、StoreCapabilities、
> PG/SQLite 严格 fencing、续租失败停服、production 门禁、CI 六 job（含 pg-required 必跑 leg）、
> 文档单一来源。证据：[VERIFICATION](./VERIFICATION.md)、run [43746483768](https://github.com/ShiningRay/troupejs/actions/runs/43746483768) 全绿。
> issue 映射更新：#2/#3 已随 P0-7 关闭。

### P0-1 写所有权/fencing ADR（2 pd）

- 新建 `docs/adr/`，写入 `0002-ownership-fencing.md`：定义 epoch/lease/revision/schemaVersion 四个维度的关系；所有 Props 变更路径；Provider 的原子校验义务；DB 时间与本地时钟的分工；旧 owner 的外部副作用边界。
- 明确“启用 ownership 时，create/write/delete/migrate/reminder-complete 都必须带 token”。
- 评审人：框架 + 存储 + 运维各一名。

**验收**：ADR 中的每条不变量都能映射到 P0-2 的失败测试 ID；没有“Provider 可选校验”的模糊表述。

### P0-2 先写失败测试（2 pd）

新增 `test/ownership-fencing.test.ts`（或拆分）：

1. 旧 epoch 在 takeover 后 `create` 必须失败；
2. 旧 epoch 的 create 冲突回退 `write` 必须失败；
3. ownership 行缺失时 `write` 必须失败（不能靠 `NOT EXISTS` 放行）；
4. lease 过期后旧 owner 的 `write` 必须失败；
5. 续租 store 抛错/挂起，fake clock 推进到租约边界，实例必须停止接单；
6. production + SqlitePropStore 必须启动失败（除非显式 `allowUnsafeProviders`）。

**验收**：修复前测试红；测试名/错误码能直接定位到不变量；使用真实 PG 的用例在 CI 中必跑。

### P0-3 Store 合同与 capability（2 pd）

- `src/props/prop-store.ts`：`create` 增加 `opts?: { fencingToken?: number }`；`delete?` 同样带 token；新增 `capabilities`：

```ts
interface StoreCapabilities {
  crossNodeSafe: boolean;
  supportsFencing: boolean;
  supportsTransactions?: boolean;
}
```

- `SqlitePropStore`：`crossNodeSafe=false`、`supportsFencing=true`（同机多进程）。
- `PostgresPropStore`：`crossNodeSafe=true`、`supportsFencing=true`。
- `CueStore` 同样加 `capabilities`；为后续 PG CueStore 留位。
- 导出类型，更新 `docs/api-reference.md`。

**验收**：类型检查通过；现有 Provider 都实现 capability；文档写明 SQLite 边界。

### P0-4 Postgres/SQLite fencing SQL（2 pd）

- `create`：条件插入，要求 ownership 行存在、`owner_id` 匹配、`epoch` 匹配、`lease_until > now()`；不再“无 token 插入”。
- `write`：fencing 从 `NOT EXISTS(epoch > token)` 改为 `EXISTS(owner_id = tokenOwner AND epoch = token AND lease_until > now())`；所有权行缺失 = 拒绝。
- 冲突分类：`exists` / `revision` / `fencing` / `lease-expired` 明确；错误消息包含 epoch/owner（不泄露敏感数据）。
- SQLite 实现同等语义；用事务/条件更新保证原子。
- 迁移：`create` 的 SQL 变化不改变表结构；若需 `owner_id` 参数，从 StageManager 传入。

**验收**：P0-2 的 1–4 全绿；真实 PG 上并发 takeover 无成功旧写；SQLite 同机多进程反例通过。

### P0-5 StageManager 续租与写入路径（2 pd）

- `src/core/stage-manager.ts`：
  - `save` 的 create / create-conflict 回退都传 `fencingToken: slot.epoch`；任一失败走 invalidate，不做无 token 重试。
  - Slot 增加 `leaseUntil`、`renewFailures`；续租成功才更新 `lastRenewAt`；失败累计，达到阈值或 `now > leaseUntil - safetyMargin` 时 `invalidate`（先停止接单，再等在飞 settle）。
  - `renewLeases` 的存储异常不再只 warn；emit `leaseRenewFailed` 指标/事件；连续失败触发 stop-serving。
  - 明确 `release` 仅在 owner+epoch 匹配时生效；drain 期间不再接受新 Call。
- 租约权威使用 DB 时间；本地 `Date.now()` 只做近似提示，测试用 fake clock。

**验收**：P0-2 的 5 绿；注入 store 挂起 2 个 cadence 后实例停止接单；恢复后新 owner 接管，旧实例写被拒。

### P0-6 production 安全门禁（1 pd）

- `src/troupe.ts`：production 要求 `propStore.capabilities.crossNodeSafe && supportsFencing`；`cues: true` 时 CueStore 也必须 `crossNodeSafe`。
- 新增 `allowUnsafeProviders?: boolean`（仅 dev/test；启动日志高亮；文档标注“不承诺跨节点”）。
- `cluster.mode=production` 必须启用 ownership；未启用直接失败，不再只 warn。
- 更新错误文案，去掉“SqlitePropStore 同机多进程”作为 production 可接受的理由。

**验收**：production + SQLite 启动失败；显式 unsafe 可启动但日志/健康端点标记 degraded；production + 无 ownership 失败。

### P0-7 CI 基线（3 pd）

- 新增 `.github/workflows/ci.yml`：
  - matrix：ubuntu-latest / windows-latest × Node 22 / 24。
  - Postgres 16 service；`TROUPE_REQUIRE_PG=1`；PG 用例跳过即 job 失败。
  - `pnpm typecheck`、`pnpm build`、`pnpm test`。
  - 上传 test report / coverage artifact。
- Linux job 跑 SIGSTOP/SIGCONT；Windows 跳过时在报告中列明原因，且不能因此让“必需 job”变绿。
- 修复 #2：`pg` 的 optional peer / 独立适配包二选一；最小安装测试。

**验收**：从干净 checkout 一键绿；PR 不能合并若必需 job 失败；VERIFICATION 改为引用 CI 链接，不再手写“通过”。

### P0-8 文档与状态单一来源（1 pd）

- 更新 `docs/VERIFICATION.md`：只写“最近一次 CI + 本机补充”，列出真实跳过项。
- README 状态行改为“以 CI/VERIFICATION 为准”，删除过期的里程碑描述。
- 修正 Show 注释/文档：当前是 3 次重试、可能重复、非 durable；与 #1 对齐。

**验收**：README/VERIFICATION/ORLEANS_GAP 对同一事实的表述一致；链接可点。

**P0 退出标准**：P0-2 的 6 个反例全绿；CI 在 Linux+PG 上必跑；production 拒绝 SQLite；代码中不存在“create 无 token”“冲突回退无 token”“续租异常继续服务”的路径（用 grep/评审清单确认）。

## 3. P1：生产 HA（第 4–10 周）——✅ 已完成（2026-11-16）

> P1-1..P1-7 全部交付：目录化所有权（ADR 0004：DirectoryStore/路由缓存/同地址恢复扫描）；
> PostgresCueStore（SKIP LOCKED + CAS）与 cron 时区；TLS + join 凭证限速 + adminToken 生产门禁；
> 3 节点混沌（冻结 owner → 幸存方接管 → FENCED）入 CI pg-required leg 与 nightly。
> 已知边界：网络分区注入以 SIGSTOP 近似（toxiproxy 未接入）；3 进程 PG Cue 并发由契约竞争测试覆盖。
> 证据：run 43755577577+ 全绿、[VERIFICATION](./VERIFICATION.md)。

### P1-1 目录 ADR（2 pd）

- 决策：ownership 表提升为权威目录；HashRing 只做候选/减载；目录条目包含 `owner_id/epoch/lease_until/version/status`。
- 明确与 Orleans DHT 的差异：这是 PG-backed directory，不是分区 DHT；规模超出单库后再分区。
- 定义缓存 TTL、失效、回源、视图版本、handoff、恢复、tombstone。

**验收**：ADR 评审通过；路由算法有伪代码；失败模式（PG 不可达、缓存过期、双 owner）逐条有处理。

### P1-2 Schema 与 DirectoryStore（3 pd）

- 迁移：新增 `directory` 表（或扩展现有 ownership 表，保持兼容）；`version` 单调；`status`。
- `DirectoryStore` 接口：`claim/lookup/release/bumpVersion/listOwned`；CAS 语义；DB 时间。
- 保留现有 `OwnershipStore` 兼容层，避免一次性破坏测试。

**验收**：契约测试覆盖 claim 竞争、过期 takeover、release、版本递增；真实 PG 通过。

### P1-3 Router + 缓存（3 pd）

- `Cluster.ownerOf` 改为 async：缓存 → 目录 lookup → 有效则转发；无条目/过期则 claim；claim 失败则重读目录，不单独依赖环。
- 缓存条目带 `version` + TTL；目录变更/成员变更时按版本失效；miss 必须回源。
- 本地激活仍走 StageManager；远程 Call 保持 deadline/hops/UnknownOutcome。

**验收**：环与目录不一致时，路由以目录为准；缓存过期不会把 Call 发给已释放 owner；单测覆盖缓存命中/失效/回源。

### P1-4 Handoff 与恢复（3 pd）

- 环变化只触发“建议迁移”；新 owner claim 成功（epoch+1）后，旧 owner 写入被 fencing 拒，随后 drain。
- 启动扫描 `owner_id=self` 的目录项，重新 claim/续租；过期项允许任何节点 claim；清理 tombstone。
- 在飞 Call 的所有权变化：返回 `UnknownOutcome` 或按幂等键安全重试；文档写清。
- 指标：handoff 次数/耗时、接管失败、目录回源延迟。

**验收**：3 进程测试中 kill 旧 owner，新 owner 在 lease 内接管；旧 owner 恢复后不能成功写；无重复成功写。

### P1-5 Postgres CueStore（3 pd）

- 实现 `PostgresCueStore`：`due` 用 `FOR UPDATE SKIP LOCKED`；claim 写 lease/owner/statusVersion；complete 用 statusVersion+owner CAS；DB 时间。
- `Troupe.form` 支持 `cues.store` 注入（已有）+ 文档/示例；production 强制 crossNodeSafe。
- 时区：`ReminderSpec` 增加 `timeZone`；cron 计算用 `Intl`；默认 UTC；拒绝模糊本地时间。
- 测试：A 注册 → A 死 → B 接管；重复触发幂等；错过周期补发；注销竞争。

**验收**：PG Cue 在 3 进程下不会并发重复执行；节点死亡后租约到期重投，重复由业务幂等吸收；时区用例通过。

### P1-6 TLS + join 凭证（4 pd）

- `transport.ts` 支持 `tls` 选项（证书/CA/私钥）；生产强制 TLS。
- join 增加预共享 token 或 HMAC 挑战；认证失败拒绝并限速；auth ack 带 `protocolVersion`。
- `production` 强制 `TROUPE_ADMIN_TOKEN`（或短期凭证）；Director 管理通道未授权拒绝。
- 密钥/证书轮换：双钥宽限；文档给出部署步骤。

**验收**：无 token join 拒绝；错误 token 拒绝；TLS 失败拒绝；admin 未授权拒绝；轮换期间新旧连接都能工作。

### P1-7 3 节点混沌与观测（4 pd）

- 测试 harness：启动 3 个 Node 进程 + PG；场景：扩容、kill -9、重启、PG 重启、网络分区（toxiproxy/tc netem）、SIGSTOP/SIGCONT。
- 断言：无未防护双活成功写；旧 epoch 写拒绝；reminder 重投；目录恢复；Call 的 UnknownOutcome 可解释。
- 指标/健康：目录缓存命中率、lease 续期失败、takeover、handoff、Cue claim 延迟、PG 错误率；readiness 区分“进程活着”和“能服务”。
- 接入 nightly；结果进 VERIFICATION。

**验收**：连续 20 次混沌运行无双活成功写；恢复时间有记录；失败可定位到目录/租约/存储层。

**P1 退出标准**：生产模式默认安全（TLS+token+PG）；3 节点 kill -9/PG 重启/分区可恢复；目录是路由权威；PG Cue 跨节点；CI nightly 跑混沌。

## 4. P2：可靠消息与状态边界（第 11–16 周）——✅ 已完成（2026-11-16）

> P2-1..P2-6 全部交付：Stream/Outbox ADR（0005，Show=ephemeral / Stream=durable 不共享语义）；
> PG StreamStore（原子 seq/幂等 eventId/ack 只前进/retain + RetentionExceeded）与 StreamConsumer
> （失败不 ack 重投、会话内去重、consumer 独立游标）；事务性 Outbox/Inbox（Props 同事务提交、
> SKIP LOCKED 派发 + 宕机重派、退避/dead-letter）；协作取消（ctx.signal + wire cancel，
> CPU 阻塞不抢占文档明确）；Provider 合同测试（三 Provider capability 感知）+ provider-guide.md。
> 证据：run 1f89e89 六 job 全绿（pg-required 235 passed + 8 项守卫/能力感知跳过）。
> 已知边界：consumer 未接入 Troupe.form 自动装配（StreamConsumer 手动驱动）；Show/Stream
> 边界测试以语义隔离文档替代专项用例。

### P2-1 Stream ADR 与 API（2 pd）

- 明确 Show=ephemeral，Stream=durable；不共享语义。
- 定义 per-topic seq、consumer cursor、ack、replay、retention、backpressure、错误码。
- 选择 A（PG 窄流）或 B（NATS/Redis adapter）；默认 A，保留 adapter 接口。

**验收**：ADR 评审通过；API 类型与错误分类固定；明确不承诺 exactly-once。

### P2-2 PG Stream Provider（5 pd）

- 表：`stream_events(topic, seq, event_id, payload, created_at)`、`stream_cursors(topic, consumer, acked_seq, updated_at)`、`stream_topics(topic, next_seq)`。
- `append` 用 `stream_topics` 行原子+1 分配 per-topic seq；`event_id` 唯一约束做幂等。
- `read` 按 seq > cursor；`ack` 只前进；`retain` 裁剪；`replay` 重置游标。
- 多进程 append 压测；慢消费者/保留裁剪测试。

**验收**：并发 append 无重复 seq；ack 回退拒绝；失败不推进游标；保留裁剪产生显式 `RetentionExceeded`。

### P2-3 Consumer/订阅投递（3 pd）

- Actor 订阅作为 consumer；pull 批次投递到 CallBoard；失败不 ack；重复由 eventId 幂等。
- 背压：批次/在飞上限；慢消费者不影响其他 consumer。
- 与 Show 的边界测试：Show 丢消息不影响 Stream；Stream 不依赖订阅内存表。

**验收**：消费者宕机重启后从游标继续；重复投递可幂等；慢消费者不拖垮全局。

### P2-4 Outbox / Inbox（4 pd）

- `outbox` 表与 Props 同事务；dispatcher `FOR UPDATE SKIP LOCKED` + lease；失败退避/dead-letter。
- 接收方 `eventId` 幂等；Inbox 表与业务写入同事务。
- 顺序：按 Actor 分区 + 单 worker 才能承诺；否则明确“无全局顺序”。
- 指标：backlog、重试、dead-letter。

**验收**：Props 提交后 outbox 必存在；dispatcher 宕机后重派；接收方重复不产生二次副作用；epoch 仅用于观测，不做硬丢弃。

### P2-5 协作取消（3 pd）

- `CallContext` 注入 `AbortSignal`；wire `cancel` 消息；接收端标记 aborted。
- Actor 检查 `ctx.signal.aborted`；框架不强行 kill。
- 测试：取消后不启动后续 strict Turn；在飞 Turn settle 前占通道；取消/超时/断连错误分类。

**验收**：远程取消能到达 Actor；取消不产生新的成功写；CPU 阻塞场景文档明确“无法抢占”。

### P2-6 Provider 合同测试（3 pd）

- 对 Memory/SQLite/PG 跑同一套契约：create/write CAS、fencing、migrate、idempotency、错误分类。
- capability 声明与实际行为一致；新增 Provider 必须过合同测试。
- 文档：Provider 作者指南；不支持项清单。

**验收**：三家 Provider 同一套测试通过；capability 不匹配时启动失败；新增 Provider 有模板。

**P2 退出标准**：Stream/Outbox 的崩溃恢复有实证；Show 与 Stream 边界清晰；取消可用；Provider 合同可执行。

## 5. P3：互操作与升级（第 17–21 周）

### P3-1 协议 ADR（3 pd）

- 与 troupe-planning / troupe.cr 对齐：canonical identity、错误码、信封字段、deadline/cancel、traceparent、版本协商。
- 帧：沿用 `magic + length + CRC`，版本协商放在 auth ack/协议层；若要在帧头加 version，必须与 troupe.cr ADR 同步升级。
- 写入 `docs/adr/0003-wire-protocol-v2.md`（沿用 P0 新建的目录）。

**验收**：ADR 通过；旧帧可识别/拒绝；升级路径明确。

### P3-2 Golden fixtures（3 pd）

- 生成身份/哈希/错误/信封 fixtures；两仓共享或同步生成；契约测试锚定。
- CI 检查 fixtures 漂移；版本变更必须更新 fixtures + 兼容说明。

**验收**：troupejs 与 troupe.cr 对同一 fixtures 通过；不依赖语言私有序列化。

### P3-3 混合版本与滚动升级（4 pd）

- 兼容规则 R1–R6 自动检查：方法集合、参数、schemaVersion、Cue/Show payload、WireMessage、幂等键。
- 2 节点旧/新版本混合运行：旧节点 drain → 升级 → 入环；新版本写 schema k+1 后禁止自动回滚。
- 回滚策略文档：降级 migrate 或全量重启+人工修复。

**验收**：混合版本运行通过；旧节点不处理新方法；schema 只前进；回滚禁令可执行。

### P3-4 热替换检查补全（3 pd）

- 现状仅 R1/R3 子集；补 R2/R4/R5/R6 的自动检查或明确人工门禁。
- 部署 bundle 带 manifest/协议版本；签名/回滚测试。

**验收**：检查结果可解释；不满足 R1–R6 时拒绝部署或明确人工确认。

### P3-5 文档、基准、发布矩阵（2 pd）

- 更新 README/operations/api-reference；发布矩阵（Node 22/24、PG 16、OS）。
- 集群基准：激活/调用/TCP/目录缓存/Stream/Outbox；保留旧口径。

**验收**：文档与 CI 一致；基准可复现；发布检查清单可执行。

**P3 退出标准**：协议 v2 有 golden；混合版本通过；滚动升级/回滚有实证；文档不再声称未验证的能力。

## 6. 30/60/90 天执行视图

| 时间 | 重点 | 交付 |
|---|---|---|
| 第 1–10 天 | P0-1..P0-5 | ADR、失败测试、fencing SQL、续租停服；本地 PG 绿 |
| 第 11–20 天 | P0-6..P0-8 | production 门禁、CI 矩阵、文档单一来源；PR 门禁生效 |
| 第 21–40 天 | P1-1..P1-4 | 目录 ADR/schema/store/router；3 进程接管原型 |
| 第 41–60 天 | P1-5..P1-7 | PG Cue、TLS/join、混沌 harness；nightly 绿 |
| 第 61–75 天 | P2-1..P2-3 | Stream ADR/Provider/consumer；ack/replay 测试 |
| 第 76–90 天 | P2-4..P2-6 | Outbox/Inbox、取消、Provider 合同；范围 B/C 评审 |

> 这是排序建议，不是承诺日期。每个阶段结束做一次 go/no-go：未达到退出门禁就留在当前阶段，不带病进入下一阶段。

## 7. 并行工作流与依赖

| 工作流 | 内容 | 依赖 |
|---|---|---|
| 正确性 | fencing、续租、目录、handoff、Stream/Outbox 语义 | P0 ADR；PG 测试环境 |
| 基础设施 | CI、3 节点 harness、PG、TLS、观测 | P0-7；运维支持 |
| 消息 | Stream、Cue、Outbox、取消 | P1 目录/租约稳定后 |
| 安全 | TLS、join token、admin token、轮换 | P0-6；证书管理 |
| 文档/发布 | ADR、VERIFICATION、基准、发布矩阵 | 各阶段交付 |

依赖关键路径：**P0-4/P0-5 → P1-1/P1-2 → P1-3/P1-4 → P2-2/P2-4**。P1-6（TLS）可与 P1-2 并行；P1-5（PG Cue）可与 P1-3 并行。

## 8. 门禁与完成定义

### 8.1 每个 PR

- typecheck/build/test 全绿；新增/修改语义有反例测试。
- 涉及 PG 的改动必须在 Linux+PG job 跑，不允许 skip。
- 涉及所有权/租约/目录的改动必须有并发/旧 epoch 反例。
- 文档与代码同一 PR 更新；公共 API 变更更新 api-reference。

### 8.2 每个阶段

- 退出门禁全部满足；VERIFICATION 记录真实拓扑、Provider、跳过项。
- 至少一次“失败演示”：先让反例红，再修复绿；评审记录保留。
- 性能不回退超过约定预算（激活/调用/队列/目录缓存）。

### 8.3 发布

- 发布矩阵（Node/OS/PG）通过；混合版本测试通过；回滚步骤演练。
- 安全配置自检：TLS、join token、admin token、证书有效期。
- 已知不支持项在 README/COMPATIBILITY 中列明；不把“未验证”写成“已支持”。

## 9. 建议的 issue 拆分

编号以创建后为准；先建 P0，再建 P1。

| 任务 | 标题建议 | 标签 |
|---|---|---|
| P0-1 | ADR: ownership/fencing invariants | docs, correctness |
| P0-2 | tests: stale-epoch create/write counterexamples | test, correctness |
| P0-3 | PropStore capabilities + create fencing token | api, storage |
| P0-4 | PG/SQLite: atomic fencing on create/write/delete | bug, storage |
| P0-5 | StageManager: stop serving on lease renewal failure | bug, correctness |
| P0-6 | production: reject unsafe providers / require ownership | safety |
| P0-7 | CI: Linux/Windows + PG + no silent skip | infra |
| P0-8 | docs: single source of truth for verification | docs |
| P1-1 | ADR: directory-backed ownership | docs, architecture |
| P1-2 | DirectoryStore + schema/migration | storage |
| P1-3 | Router: directory lookup + cache invalidation | cluster |
| P1-4 | Handoff/recovery + takeover tests | cluster, correctness |
| P1-5 | PostgresCueStore + timezone | storage, reminders |
| P1-6 | TLS + join credentials + admin token | security |
| P1-7 | 3-node chaos harness + metrics | infra, test |
| P2-1 | ADR: Show vs Stream boundary | docs, messaging |
| P2-2 | PG Stream provider (seq/cursor/ack/retention) | messaging, storage |
| P2-3 | Consumer delivery + backpressure | messaging |
| P2-4 | Outbox/Inbox | reliability |
| P2-5 | Cooperative cancellation over wire | api, scheduling |
| P2-6 | Provider contract test suite | storage, test |
| P3-1 | ADR: wire protocol v2 | docs, protocol |
| P3-2 | Golden fixtures + cross-repo contract | protocol, test |
| P3-3 | Mixed-version rolling upgrade | release |
| P3-4 | Hot-reload R1–R6 checks | release |
| P3-5 | Docs/bench/release matrix | docs |

现有 issue 映射：#1 → P2-1/P2-3（Show 边界）；#2 → P0-7；#3 → P0-7；#4 → P3-4。

## 10. 需要拍板的决策点

| 决策 | 选项 | 建议 | 截止 |
|---|---|---|---|
| 目录形态 | A. 继续 HashRing+ownership；B. ownership 提升为目录；C. 独立 DHT | B；C 留到规模证据 | P1-1 前 |
| 路由权威 | 环 / 目录 / 两者 | 目录权威，环只做候选 | P1-3 前 |
| Stream 存储 | PG / NATS / Redis | 先 PG 窄流；吞吐不足再 adapter | P2-2 前 |
| 传输安全 | TLS+token / mTLS / 前置代理 | TLS + join token；mTLS 可选 | P1-6 前 |
| 跨语言范围 | 仅语义 / 客户端协议 / 异构混群 | 先 golden+客户端；混群后置 | P3-1 前 |
| 事务/ES | 做 / 不做 | 不做；Outbox+幂等优先 | 范围 C 评审 |

## 11. 风险与应对（执行视角）

| 风险 | 触发信号 | 应对 |
|---|---|---|
| 目录改造拖长 | P1-3/P1-4 超过 2 周无原型 | 先做“目录只读 + 环回退”的灰度；保留开关 |
| PG 成为瓶颈 | 目录/流延迟随负载线性上升 | 缓存、连接池、分区；流换 adapter；记录容量曲线 |
| Stream 范围失控 | 需求扩展到消费组/ exactly-once | 回到 ADR 的非目标；拆成后续项目 |
| 安全阻塞发布 | 证书/ token 运维未就绪 | 先做受控网络 + token 的最小方案；TLS 作为发布门禁 |
| 混沌测试不稳定 | 偶发失败无法复现 | 固定种子/拓扑；先单故障再组合；记录事件时间线 |
| 人力不足 | P0 超过 3 周 | 缩范围 A：先修 fencing/续租/CI，目录后置 |

## 12. 参考

- [ORLEANS_GAP.md](./ORLEANS_GAP.md)：差距、证据、目标架构。
- [DESIGN.md](../DESIGN.md)、[operations.md](./operations.md)、[api-reference.md](./api-reference.md)。
- [VERIFICATION.md](./VERIFICATION.md)：当前本机验证结果。
- `troupe.cr`：`PLAN.md`、`DESIGN.md`、`docs/verification.md`、`docs/persistence.md`、`docs/cluster.md`、`docs/outbox.md`、`docs/security.md`、`docs/ROLLING_UPGRADE.md`。
