# Troupe.js 与 Orleans：经验、差距与目标架构

> 基线：Orleans 源码 `8320d257`，版本声明 10.0.0（`Directory.Build.props:64-67`）。
> 证据：本文基于 2026-11-14 至 11-16 对 `troupejs` 源码、测试与文档的审计，并对照 `troupe.cr` 的 M1–M6 实现与验收记录；代码行号对应 `troupejs` commit `8208823`。
> 配套执行计划：[ROADMAP.md](./ROADMAP.md)。统一跨语言决策仍在 [troupe-planning](https://github.com/ShiningRay/troupe-planning) 协调。

## 0. 一页结论

**Troupe.js 目前不是 Orleans 级分布式运行时，而是一个语义较完整、但分布式权威与生产证据仍不足的单集群 Virtual Actor 运行时。**

它已经明显超出“Actor 包装库”：严格 Turn、single-flight 激活、租约所有权、Props CAS、成员 gossip、持久 Cue、实时 Show、Trace/OTel、热替换都有真实代码与测试。但以下四类问题使它暂时不能承担“生产集群”承诺：

1. **所有权 fencing 存在未覆盖路径**：`create` 不带 fencing token；`create` 冲突后的回退 `write` 也不带 token；Postgres 的 fencing 条件是 `NOT EXISTS(epoch > token)`，所有权记录缺失时会放行旧持有者。旧 epoch 仍可能覆盖新 owner 的 Props。
2. **续租失败不停止服务**：租约续期遇到存储异常只记 warn，实例继续接单，直到租约被他人接管；这会把“可能已失去所有权”的窗口留给业务副作用。
3. **生产模式接受不安全的 Provider**：`production` 只检查 `isOwnershipStore`，不检查是否跨节点安全，因此 SQLite 能通过 production 的 Provider 检查（只要端口/advertise/入团条件满足）；共享盘上的 SQLite 不是跨主机协调存储。
4. **传输没有身份与加密**：`node:net` + 4 字节长度 + JSON；join 只校验协议版本与角色集合，没有加入凭证、TLS 或 per-call 授权。生产网络上的任何可达进程都可以尝试入团/发 Call。

此外还有一类“证据缺口”：本机验证中 PostgreSQL 3 项与 SIGSTOP 1 项被跳过，仓库没有 CI。没有真实多进程、真实 PG、故障注入的持续证据，前面的能力只能算“代码路径存在”，不能算“生产可用”。

**差距的本质不是功能数量，而是三件事：谁是权威（directory/ownership）、失败时谁先停（lease/fencing）、以及如何证明（CI/拓扑/反例）。**

建议分三个交付范围，而不是一次性追求 Orleans 全功能：

| 范围 | 内容 | 估算（1 名熟悉代码的工程师） | 结果 |
|---|---|---|---|
| A. 可信单集群 | P0：fencing、续租、Provider 能力、CI、传输最小安全 | 10–15 pd，约 2–3 周 | 可以诚实地宣称“单集群/同机多进程可用”，不再有已知旧 epoch 覆盖路径 |
| B. 生产 HA（推荐先做） | A + P1：目录化所有权、PG CueStore、TLS/join 凭证、3 节点混沌 | 35–50 pd，约 7–10 周 | 小/中型集群可运维：节点硬杀、租约接管、提醒恢复有实证 |
| C. 可靠消息与互操作 | B + P2/P3：持久流、Outbox、协作取消、协议对齐、滚动升级 | 70–105 pd，约 14–21 周 | Orleans-class 核心语义 + 明确的可靠消息边界；仍不复制 Orleans 全部模块 |

“Orleans-class”在这里指：**单激活、租约/fencing、目录化路由、持久提醒、至少一次消息、可验证的故障恢复**；不包括 Orleans 的分布式 ACID 事务、完整 Provider 生态、.NET 序列化/DI 兼容或跨语言混群。

## 1. 证据、评级与“完成”的定义

### 1.1 证据来源

- `troupejs/src` 全量源码审计，重点：`stage-manager.ts`、`cluster.ts`、`transport.ts`、`props/*`、`show/*`、`cues/*`、`troupe.ts`。
- `troupejs` 35 个测试文件与 `docs/VERIFICATION.md`（2026-11-14：155 passed / 4 skipped）。
- `troupe.cr` 的 `PLAN.md`、`DESIGN.md`、`docs/verification.md`、`docs/persistence.md`、`docs/cluster.md`、`docs/outbox.md`、`docs/security.md`、`docs/ROLLING_UPGRADE.md`。
- `troupe-planning/docs/orleans-baseline.md`、`current-state.md`、`roadmap.md`。

### 1.2 严重度

| 级别 | 含义 | 处理时机 |
|---|---|---|
| P0 | 可能导致数据丢失、双活成功写、未授权访问，或使“生产可用”声明不成立 | 任何生产声明之前必须修复 |
| P1 | Orleans-class 生产集群的必要能力；缺失会导致扩容/故障恢复不可信 | 范围 B 必做 |
| P2 | 重要但可分阶段；影响可运维性、可调试性或互操作 | 范围 C |
| P3 | 差异化能力或生态项；不是 parity 的必要条件 | 按需 |

### 1.3 “完成”的标准

沿用 `troupe.cr/DESIGN.md` 的定义，并把它作为本仓库的验收门槛：

1. 代码与公开语义文档；
2. 正常路径与至少一个关键反例；
3. 资源上限、错误分类与失败恢复；
4. 对应 CI 可执行验证；
5. 分布式能力必须有真实拓扑/Provider 证据。

仅有类、接口、README 或单次 happy-path 调用，不算完成；测试数量、功能名和“历史性能”都不替代拓扑证据。

## 2. troupe.cr 的经验：哪些该学，哪些不该复制

`troupe.cr` 用 M1–M6 把一套 Crystal 版 Virtual Actor 从语义契约做到了目录、持久流、Outbox、OTel、事件溯源和滚动升级。它的价值不在“功能清单”，而在若干可复用的工程约束；它的教训同样明显。

### 2.1 可复用的做法

| 做法 | troupe.cr 的证据 | 对 troupejs 的动作 |
|---|---|---|
| 先写语义契约与反例，再实现 | M1 39 例；激活顺序 acquire→read→migrate→fenced write→on_stage；旧 epoch 的 create/write/migrate/reminder-complete 必须失败 | 把 fencing 不变量写成 ADR + 失败测试，先于代码修复 |
| Provider 显式声明能力 | `cross_node_safe?`：Memory/SQLite=false，PG=true；production 拒绝不满足合同的 Provider | 给 PropStore/CueStore/StreamStore 增加 capability 描述；production 做硬校验 |
| 真实 Provider 与多进程门禁 | M3 验收要求至少 3 个独立进程 + 真实 PG，扩容、kill -9、冻结恢复后无未防护双活写 | 把 3 进程 + PG + kill -9 做成 CI 必跑，而不是本机手工 |
| 版本化目录的字段设计 | `VersionedDirectory`：per-entry version 单调、view_version、reassign 旧版本拒绝 | 借用 version/view 语义，但落到共享存储，不复制进程内实现 |
| 持久流的失败语义 | `StreamReader` 失败即停、游标不越过失败点；ack 只前进；保留裁剪是显式代价 | 作为新 Stream API 的契约参考，不作为生产队列直接移植 |
| Outbox 与 Props 同事务 | Memory 同锁、SQLite/PG 单事务；失败不标记=至少一次 | 移植“同事务 + 至少一次 + 接收方幂等”，补上归属/顺序约束 |
| 公开“未验证边界” | 每轮 verification 都列未验证项，而不是只报通过数 | 继续保留，并让 CI 的 skip 直接失败 |
| 公共协议 golden fixtures | ADR 0001：canonical identity、错误码、信封、TRP1 帧；四份 golden 文件 + 契约测试 | 先对齐身份/错误/信封，再谈跨语言混群 |

### 2.2 必须吸取的教训

1. **“有模块”不等于“分布式”**。`troupe.cr` 的 directory 仍是进程内组件，未跨进程持久化/同步；持久流的 seq 是全局单调而非 per-topic 紧凑，保留只裁到 `min_seq`，没有消费组/分片，也没有多进程 append 压测。把这类实现原样搬到 `troupejs`，只会把“进程内正确”误当成“集群正确”。
2. **自研消息队列的隐藏成本极高**。游标、ack、重放、保留、慢消费者、消费组、分区、顺序、重复、背压，每一项都需要真实故障测试。troupe.cr 的最小流适合做契约样本，不适合作为通用生产队列。
3. **Outbox 的“至少一次”必须配接收方幂等**。troupe.cr 的 dispatcher 进程内运行、没有归属过滤，节点宕机后任意节点可重派；事件顺序只在单 Actor 内保证。搬到 Node 后如果多节点同时派发，重复会放大。
4. **文档会漂移**。troupe.cr README 的状态行仍写 M1–M3，而 PLAN/verification 已到 M1–M6；troupejs 的 Show 注释曾写 at-most-once，代码实际是 3 次重试。状态必须由一个可执行来源生成，或至少在 CI 中做一致性检查。
5. **测试数量不是证据**。troupe.cr 每轮都列“未验证边界”，这是对的；troupejs 当前 155 passed / 4 skipped 也一样，跳过项不能算通过。
6. **TLS“有方案”不等于“有实现”**。troupe.cr 的 token 认证已落地，但 TLS 仍是 OpenSSL 包裹方案；troupejs 连 token 都只在 Director 管理通道上可选。
7. **协作式运行时的 CPU 阻塞是硬边界**。troupe.cr 的 Fiber 与 troupejs 的 event loop 都会因 CPU 密集代码阻塞同进程的其他 Actor；这不是加一个超时就能解决的，需要 worker/process 隔离或明确的容量边界。

### 2.3 取舍原则

- **移植契约，不移植模块**：activation order、fencing 不变量、provider capability、golden fixtures、outbox 原子性可以移植；进程内 directory、全局 seq 流、无归属过滤的 dispatcher 不应照搬。
- **先补权威，再补功能**：没有目录化所有权之前，加持久流只会让“消息可靠了，但 Actor 归属不可靠”更危险。
- **保留 troupejs 的差异点**：TypeScript 零代码生成、L2 热替换、Booth/SSE、单进程低运维成本，这些不是 Orleans 的复制品，也不应为了 parity 丢掉。

## 3. Orleans 基线（只列与差距判断相关的部分）

| 领域 | Orleans 机制 | 为什么重要 |
|---|---|---|
| Identity / lifecycle | `GrainId`（逻辑）与 `ActivationId`（incarnation）分离；activation 创建/销毁有明确生命周期 | 旧消息、旧写入、旧日志必须能按 incarnation 拒绝或关联 |
| Scheduling | Turn-based 串行；reentrant/read-only/MayInterleave/call-chain 可选 | 默认不交错，显式选择并发；避免跨 await 的业务竞态 |
| Messaging | request/response、超时、可传播取消、one-way、失败通知；超时≠失败 | 结果未知时必须靠幂等，而不是盲目重试 |
| Directory | 分区目录、视图版本、handoff/recovery、locator cache | 路由的权威不是哈希环，而是目录 + 成员视图 |
| Placement | compatible silos、random/prefer-local/resource-aware、rebalancing | 扩容/热点/资源倾斜需要可解释的放置策略 |
| Membership | 成员表、IAmAlive、直接/间接探测、suspect/dead | 成员视图是优化与故障检测，不是所有权本身 |
| Persistence | `IGrainStorage`、ETag、显式写、Provider 扩展、CAS/schema migration/fencing | 状态写入必须原子、可版本化、可拒绝旧 owner |
| Timers / reminders | activation timer 与 durable reminder 分离 | 内存 timer 不跨故障；reminder 必须共享存储 + 至少一次 |
| Streams | 持久队列、sequence token、pull agent、订阅握手/平衡 | “订阅持久化”不等于“事件持久化” |
| Serialization | 代码生成、版本容错 | 跨版本/跨语言需要显式契约，不能依赖运行时私有反射 |
| Observability | metrics、ActivitySource、W3C trace | 目录/放置/流/恢复必须可观测，否则无法验收 |

## 4. 差距总表

| 领域 | troupejs 现状（证据） | Orleans 对应机制 | 级别 | 决策 |
|---|---|---|---|---|
| 所有权/写入 fencing | `create` 无 token；create 冲突回退 write 无 token；Postgres 用 `NOT EXISTS(epoch > token)`；续租异常继续服务 | lease + ETag/fencing + membership | **P0** | 立即修，见 §5.1/§5.2 |
| 生产 Provider 安全 | production 只查 `isOwnershipStore`，SQLite 可通过 | Provider 合同与 silo 选择 | **P0** | capability 校验，见 §5.3 |
| 传输身份/加密 | `node:net` + 长度 + JSON；join 只校验协议/角色；无 TLS/加入凭证 | silo-to-silo 安全与成员认证 | **P0** | TLS + join token，见 §5.4 |
| 验证/CI | 本机 155 passed/4 skipped；PG 3 项、SIGSTOP 1 项跳过；无 CI | 持续多 silo/故障测试 | **P0** | CI + 混沌，见 §5.5 |
| 目录/放置 | 纯 HashRing（xxh32/160 vnodes）+ 漂移转发；无注册/视图版本/缓存失效/handoff/恢复 | 分区 grain directory + placement | **P1** | 把 ownership 提升为目录，见 §6.1 |
| Reminders | Memory/SQLite；集群默认本地 SQLite；无内置 PG CueStore | reminder 表 + silo reminder service | **P1** | PG CueStore，见 §6.2 |
| 可靠消息 | Show 仅订阅持久化 + 3 次重试；无事件日志/游标/ack/replay/保留 | persistent streams + pull agent | **P1** | 独立 Stream API，见 §6.3 |
| 外部副作用 | 幂等记录 + UnknownOutcome；无持久 outbox/inbox | outbox/streams/transactions | **P1** | Outbox/Inbox，见 §6.4 |
| 取消/调度 | 只有超时；未发现调用方到 Actor 的取消传播 | cancellation token、reentrancy | **P2** | AbortSignal + wire cancel，见 §6.5 |
| Identity/lifecycle | `(roleId, stageName)` + 内部 epoch；无公开 ActivationId | GrainId vs ActivationId | **P2** | 暴露 activationId，见 §6.6 |
| 协议/互操作 | 私有 JSON；无 IDL/版本协商；与 troupe.cr TRP1 不同 | version-tolerant serialization | **P2** | ADR + golden，见 §7 |
| Provider/事务/ES | 3 个 Provider；无事务/事件溯源 | Provider 生态、事务 | **P3** | 明确非目标，见 §8 |
| 热替换/滚动升级 | L1/L2；自动检查仅 R1/R3 子集 | 版本兼容/滚动升级 | **P3** | 保持实验性，逐步补 R4–R6 |
| Node 运行时 | 单 event loop；CPU 密集会阻塞同进程所有 Actor | silo 调度/线程隔离 | **P1/P2** | worker/process 隔离与容量边界，见 §6.7 |

## 5. P0：必须先修的四个洞

### 5.1 所有权 fencing 没有覆盖所有写入路径

**代码事实**

- `src/props/prop-store.ts:30-36`：`create(namespace, roleId, stageName, props, schemaVersion)` 没有 `fencingToken` 参数；`write` 的 token 是可选（`:18-24`）。
- `src/props/postgres.ts:89-111`：`create` 只是 `INSERT ... ON CONFLICT DO NOTHING`，不检查 ownership epoch/lease。
- `src/props/postgres.ts:122-126`：带 token 的 `write` 追加的是 `AND NOT EXISTS (SELECT 1 FROM ownership ... WHERE epoch > $7)`；如果 ownership 行不存在，子查询为空，`NOT EXISTS` 为真，写入照样成功。
- `src/core/stage-manager.ts:1046-1060`：`revision===0` 时先 `create`；若抛 `ConflictError(kind="exists")`，读取实际 revision 后调用 `store.write(..., { expectedRevision, schemaVersion })`，**没有传 `fencingToken`**。只有 `revision>0` 的正常路径才带 token（`:1066-1072`）。

**可复现的坏序列**

1. A 在 epoch=1 激活，读到无 Props（`revision=0`），准备首 Turn 保存。
2. A 被暂停/分区，租约过期；B 取得 epoch=2，读/写/提交 Props。
3. A 恢复，执行 `create`：若 B 尚未创建记录，A 的 `create` 成功（无 fencing）；若 B 已创建，A 走冲突回退 `write`，同样无 token。
4. 结果：A 以旧 epoch 覆盖 B 的已提交状态，或创建出 B 之后会被覆盖的记录。`revision` CAS 只能防“同一 revision 的并发”，防不住“旧 owner 已经读到新 revision 后写入”。

**必须成立的不变量**

> 启用 ownership 时，任何 Props 变更（create/write/delete）都必须携带当前 epoch，并由存储在**同一条原子语句**中验证：ownership 行存在、`epoch = token`、`lease_until` 仍有效。旧 epoch 的 create/write/delete/migrate/reminder-complete 必须失败。

**修复方向**

- `PropStore.create` 增加可选 `WriteOptions`（至少 `fencingToken`）；启用 ownership 时必传。
- Postgres `create` 改为条件插入，例如：

```sql
INSERT INTO props (...)
SELECT $1, $2, $3, $4, 1, $5
WHERE EXISTS (
  SELECT 1 FROM ownership o
  WHERE o.namespace = $1 AND o.role_id = $2 AND o.stage_name = $3
    AND o.owner_id = $6 AND o.epoch = $7 AND o.lease_until > now()
)
ON CONFLICT (namespace, role_id, stage_name) DO NOTHING
```

- `write` 的 fencing 改为 `AND EXISTS (... owner_id = $8 AND epoch = $7 AND lease_until > now())`；所有权行缺失/过期必须拒绝，而不是放行。
- `StageManager` 的 create 冲突回退要么带 token 重试一次，要么直接失效；绝不能走无 token 的 write。
- `delete`（若实现）同样带 token。
- 用真实 PG 写反例：旧 epoch create、旧 epoch 冲突回退、ownership 行缺失、lease 过期，四种都必须失败且不改变已提交 Props。

### 5.2 续租失败继续服务

**代码事实**

`src/core/stage-manager.ts:195-235`：续租 cadence 为 `max(250, leaseMs/3)`；`slot.lastRenewAt` 在尝试前就更新（`:201-202`），`acquire` 抛异常时只 emit `warn`（`:224-233`），不 invalidate、不停止接单。只有 `res.ok === false`（明确被他人持有）才失效（`:208-217`）。

**后果**

- PG 网络抖动/不可达时，本地租约已过期，B 可能已接管；A 仍在接单、读旧状态、执行外部副作用。
- 即使写入最终被 fencing 拒绝，A 已经返回了旧读、发出了 HTTP 请求或消息，这些副作用无法回滚。
- 这正是 Orleans 里“lease 失效即停止服务”的边界；不能把“存储暂时不可达”当作“可以继续服务”。

**修复方向**

- Slot 记录 `leaseUntil`（本地估算）与连续失败次数；续租失败达到 2 次或 `now > leaseUntil - safetyMargin` 时立即 `invalidate`/`drain`，先停止接新 Call，再等待在飞 Turn settle。
- 续租成功才更新 `lastRenewAt`；失败也要有独立的重试节奏，不能因为提前更新时间而拖到下一个 cadence。
- 租约判定使用数据库时间（`now()`/`clock_timestamp()`），不要用各节点的 `Date.now()` 做权威；本地时钟只用于超时/调度。
- 测试：注入 store 抛错/挂起，fake clock 推进到租约边界，断言实例在租约到期前停止服务；恢复后由新 owner 接管，旧实例的写入被拒绝。
- 文档写明：fencing 保护“配合校验的存储写入”，不保护已发出的外部副作用；外部副作用必须走 Outbox 或接收方 epoch 校验。

### 5.3 生产模式接受不安全 Provider

**代码事实**

- `src/troupe.ts:552-557`：`production` 或显式 `ownership` 时，只检查 `isOwnershipStore(propStore)`；错误文案甚至把 `SqlitePropStore` 描述为“同机多进程”。
- `src/troupe.ts:379-383`：默认 PropStore 是 SQLite；`src/troupe.ts:405-411`：默认 CueStore 也是 SQLite（可用 `cues.store` 注入自定义实现，但仓库没有 PG 实现）。
- 没有 `crossNodeSafe` 之类的 capability 字段；`src/props/sqlite.ts` 的 ownership 用 `Date.now()` 与本地文件锁，适合同机多进程，不适合跨主机共享盘。

**后果**

- 两台主机把同一个 SQLite 文件放在共享盘上，`production` 会启动成功；但 SQLite 的锁/WAL 不保证跨主机正确性，租约与写入可能出现不可预期的错误。
- 即使同机多进程，`production` 的语义也应是“节点级共享存储”；代码没有把“同机”与“跨节点”区分开。

**修复方向**

- 给 `PropStore`/`CueStore`/`StreamStore` 增加 `capabilities: { crossNodeSafe: boolean; supportsFencing: boolean; supportsTransactions?: boolean }`。
- `production` 必须要求 `crossNodeSafe === true` 且 `supportsFencing === true`；SQLite 只能用于 `dev`/`test`/明确的 `allowUnsafeProviders: true`（并在启动日志中高亮）。
- 若 `cues: true` 且 `cluster.mode === "production"`，CueStore 也必须 `crossNodeSafe`；否则拒绝启动。
- 文档写清 SQLite 的适用边界：单进程、同机多进程；不承诺节点丢失、扩缩容、跨主机共享盘。

### 5.4 传输没有身份与加密

**代码事实**

- `src/cluster/transport.ts:1` 只引入 `node:net`；帧是 4 字节小端长度 + JSON（`:367-408`），`maxFrameBytes` 默认 4 MiB（`:107`）。
- `src/cluster/roster.ts:128-139`：join 只校验 `protocol` 与角色集合；没有 token、证书、签名或挑战应答。
- `src/cluster/cluster.ts:399-415`：Director 管理通道的 `TROUPE_ADMIN_TOKEN` 是可选的；未设置时不校验。普通 Call/Show 没有任何授权。
- `production` 只要求固定端口、显式 advertise、成功入团（`cluster.ts:36-40`），不要求传输安全。

**后果**

- 任何能连到端口的进程都可以尝试 join；知道协议版本与角色集合即可进入成员视图，进而接收/转发 Call、订阅 Show、触发管理操作（若未设 admin token）。
- 明文 JSON 暴露业务参数、Props、trace、管理命令；在不可信网络/多租户环境不可接受。

**修复方向**

- 传输层用 `node:tls`（或前置 mTLS 代理），至少服务端证书校验；生产启动必须提供证书/CA 配置。
- join 增加预共享 token 或 HMAC 挑战；`join-nack` 不泄露敏感细节；认证失败计入指标并限速。
- `production` 强制要求 `TROUPE_ADMIN_TOKEN`（或等价的短期凭证）；普通 Call 至少继承连接身份，后续再加 per-method ACL。
- 认证 ack 带 `protocolVersion`，为后续协商留位；密钥轮换要有双钥宽限。
- 测试：无 token join 被拒、错误 token 被拒、TLS 握手失败、过期证书、管理通道未授权。

### 5.5 验证与 CI 缺口

**代码事实**

`docs/VERIFICATION.md`（2026-11-14）：`pnpm test` 35 个文件通过、2 个跳过，155 passed / 4 skipped；PostgreSQL 3 项因本机连接认证失败跳过，SIGSTOP 1 项因 Windows 跳过；typecheck/build 通过；明确“不是 CI 结果，未重跑多机 PG/POSIX”。

**后果**

- 核心的跨进程接管、旧 epoch 拒绝、reminders 重投、POSIX 冻结恢复都没有持续证据；一次本机通过不能防止回归。
- 没有 CI 就没有“合并门禁”，上述 P0 修复很容易被后续改动破坏。

**修复方向**

- GitHub Actions：Linux + Windows，Node 22/24；Postgres 16 service；`TROUPE_REQUIRE_PG=1` 时跳过即失败。
- 至少一个 job 跑 3 个独立进程 + 真实 PG：激活、扩容、kill -9、重启、租约接管、旧 epoch 拒绝、reminder 重投。
- Linux job 跑 SIGSTOP/SIGCONT、`tc netem` 丢包/延迟/分区；Windows 只跑可移植子集，但必须在报告中列出跳过原因。
- 测试报告上传 artifact；README/VERIFICATION 只引用 CI 链接与最新结果，不手写“通过”。

## 6. P1/P2：从“单集群正确”到“Orleans-class 核心”

### 6.1 目录：把 ownership 提升为权威目录

**现状**

`Playbill` 是纯 HashRing：`xxh32(namespace:roleId:stageName)`，160 vnodes；`Cluster.ownerOf` 直接返回环上的节点（`cluster.ts:166-168`）；漂移期用转发（跳数上限 2）兜底。没有 register/lookup/视图版本/缓存失效/handoff/目录恢复。

**为什么这不够**

- 环是“放置提示”，不是“当前 owner”。成员变更时环会立即改变，但在飞激活/租约交接需要时间；只靠环会出现“路由到新节点，但新节点还没拿到所有权”的窗口。
- 没有视图版本，旧节点可能用过期成员视图把 Call 转发给已死节点；跳数上限会丢弃。
- 节点硬杀后没有目录恢复/扫描，只能等环重算与下一次 Call 触发激活。
- 扩容时没有 handoff 计划，只有“环漂移 → 旧 owner drain”的被动路径。

**目标：directory-backed ownership**

不复制 Orleans 的 DHT，而是把现有 ownership 表提升为可查询目录；对 PG 可用的中小集群，这比引入 ZooKeeper/etcd 更简单、更可验证。

```text
directory(
  namespace, role_id, stage_name,
  owner_id, epoch, lease_until,
  version,          -- 每次 claim/handoff/release 单调 +1
  status,           -- active | draining | expired
  updated_at,
  PRIMARY KEY (namespace, role_id, stage_name)
)
```

- **claim**：`INSERT ... ON CONFLICT DO UPDATE ... WHERE lease_until <= now()`，返回新 `epoch` 与 `version`；旧 owner 的 CAS 失败。
- **lookup**：按主键读；缓存条目带 `version` 与短 TTL（例如 1s）。
- **route**：先查缓存/目录；owner 有效则转发；无条目或租约过期则尝试 claim；claim 失败则重读目录并转发，绝不只凭环决定。
- **handoff**：环变化只作为“建议迁移”；新 owner claim 成功（epoch+1）后，旧 owner 的下一次写入被 fencing 拒绝，随后 drain。目录 `version` 递增，缓存按版本失效。
- **recovery**：启动时扫描 `owner_id = self` 的条目，重新 claim/续租；对 `lease_until` 已过期的条目，允许任何节点 claim；定期清理 tombstone。
- **scale**：单表在数万到数十万 Actor 量级可用；超出后按 `hash(namespace, role)` 分区或换 DHT，但保持同一 Store 接口。不要在没有量级证据前先上 DHT。

**与 troupe.cr 的关系**：借用 `VersionedDirectory` 的 per-entry version/view_version 语义；不借用它的进程内 Map 实现。目录必须在共享存储里，否则只是“每个节点各自以为的目录”。

### 6.2 Reminders：PG CueStore + 数据库时间

**现状**

`CueStore` 有 Memory/SQLite 实现；`CueScheduler` 每 1s tick，先 `isRingOwner` 过滤，再 `claim`，`onCue` 成功后 `complete(nextDue)`，失败 `complete(nextDue=now+retryBackoff)` 退避重试（`scheduler.ts:76/99/112/124`）。集群模式默认仍是本地 SQLite（`troupe.ts:405-411`），因此提醒只在注册它的节点可见；节点死亡后不会由其他节点接管。

**目标**

- `PostgresCueStore`：`due` 用 `WHERE next_due <= now() ORDER BY next_due FOR UPDATE SKIP LOCKED LIMIT batch`；claim 写 `lease_until/owner/status_version+1`；complete 以 `status_version + owner` CAS；使用 DB 时间，不用 Node 时间。
- Scheduler 可以在所有节点运行；claim 本身保证单次触发，ring 过滤只作为减载优化（可配置关闭）。
- 时区：`ReminderSpec` 增加显式 `timeZone`（IANA），cron 计算用 `Intl.DateTimeFormat` 或成熟库；默认 UTC，拒绝模糊的本地时间。没有时区的 cron 不允许注册。
- 测试：节点 A 注册、A 被杀、B 在租约到期后 claim 并触发；重复触发由业务幂等兜底；错过周期按契约补发一次；注销与触发竞争用 statusVersion 解决。

### 6.3 可靠消息：Show 保持实时，另设 Stream

**现状**

`ShowBroker` 是内存订阅表 + 可选 SQLite 订阅持久化；`publish` 对每个订阅者最多 3 次（200/400/800ms），3 次失败记 `dropped`（`show.ts:118-141`）。没有事件日志、sequence、游标、ack、replay、保留、消费组、队列平衡。`ShowListener` 只在发布进程本地生效。

**结论**

- Show 的定位应固定为 **ephemeral fan-out**：在线尽力、可能重复、可丢弃；不要把它当 persistent stream，也不要用“订阅持久化”推导“事件持久化”。
- 需要可靠消息时，新增独立 `Stream` API；二者共享 Actor 投递管道，但语义分开。

**Stream 的两条路线**

| 路线 | 适用 | 代价 |
|---|---|---|
| A. PG-backed 最小流 | 已有 PG、吞吐不高、想零新增基础设施 | 自研游标/保留/消费组；必须做多进程 append、慢消费者、保留裁剪测试 |
| B. NATS JetStream / Redis Streams 适配 | 吞吐/保留/消费组要求高，运维可接受新组件 | 新增基础设施与运维；需要 at-least-once 适配、幂等、连接故障处理 |

**建议**：先做 A 的窄契约（per-topic sequence、consumer cursor、ack、retention、replay、backpressure），把接口稳定；一旦吞吐/保留超出 PG 舒适区，再实现 B 的 adapter。不要把 troupe.cr 的全局 seq 流原样搬来：它的 `retain_before` 只裁到 `min_seq`，没有消费组/分片，也没有多进程 append 压测。

**最小契约**

- `append(topic, eventId, payload)` → `seq`（per-topic 单调；同 `eventId` 幂等）。
- `read(topic, consumer, max)` → 事件列表 + 游标；失败不推进游标。
- `ack(topic, consumer, seq)`：只前进；重复 ack 幂等；回退拒绝。
- `replay(topic, consumer, fromSeq)`：显式重置；需要权限。
- `retain(topic, minSeq)`：裁剪；慢消费者收到 `RetentionExceeded`，不是静默丢。
- 投递语义：at-least-once；消费者用 `eventId` 幂等；不承诺 exactly-once。

### 6.4 Outbox / Inbox：外部副作用的恢复语义

**现状**

有幂等记录与 UnknownOutcome，但没有持久 outbox/inbox；跨 Actor 或外部 HTTP/消息副作用在崩溃后没有恢复路径。

**目标**

- `outbox(id, namespace, role_id, stage_name, epoch, event_type, payload, created_at, claimed_by, lease_until, sent_at, attempts)`。
- `emit` 与 Props 写入同一事务（PG 单事务；SQLite 同锁/同事务）。
- dispatcher 用 `FOR UPDATE SKIP LOCKED` claim，`lease_until` 防并发；成功后 `sent_at`，失败退避；超过 N 次进 dead-letter。
- 接收方按 `eventId` 幂等；at-least-once；不承诺顺序，除非按 Actor 分区并单 worker 串行。
- `epoch` 用于观测与排查，不作为“旧 owner 的 outbox 一律丢弃”的硬过滤：外部副作用可能已经发生，丢弃会造成状态不一致；正确做法是接收方幂等 + 业务补偿。
- Inbox：消费者侧的 `(consumer, eventId)` 去重表，与业务写入同事务。

### 6.5 协作取消

**现状**

`runTurn` 用 `Promise.race([exec, timeout])`，超时返回 `CallTimeoutError("executing")`，但仍 `await exec` 到 settle；没有把取消信号传给 Actor。调用方无法说“我不等了，请停止”。

**目标**

- `CallContext` 注入 `AbortSignal`；wire 增加 `cancel` 消息（带 `callId`），接收端把 signal 标记为 aborted。
- Actor 在长任务中检查 `ctx.signal.aborted`；框架不强行 kill Promise/Fiber。
- 取消是协作式的：CPU 密集/阻塞代码仍可能不响应；文档明确边界。
- 测试：取消后不启动后续 strict Turn；在飞 Turn 仍占通道到 settle；取消与超时/断连的组合有确定错误分类。

### 6.6 Identity 与 activationId

**现状**

身份是 `(roleId, stageName)`；epoch 是内部字段，日志/错误里没有稳定的 activation incarnation。调试“这条 Call 是旧实例处理的吗”只能靠时间与 owner 推断。

**目标**

- 增加 `activationId`（可用 `${stageId}#${epoch}#${random}`），在激活时生成，随 Call/Turn/日志/Trace 传播；旧 activation 的消息可被识别。
- Director/健康端点暴露 `activationId`、`epoch`、`leaseUntil`、`ownerId`。
- 不要求改身份模型；这是可观测性/排障能力，P2。

### 6.7 Node 运行时边界

- 单 event loop：CPU 密集/同步阻塞会阻塞同进程所有 Actor；`setTimeout` 超时无法抢占。需要 worker thread/独立进程池，或明确“CPU 密集角色单独 Stage”。
- `Promise` 交错：strict Turn 是逻辑串行，不是抢占式隔离；跨 `await` 的业务原子性仍由开发者负责。
- 时钟：`Date.now()` 可跳变；租约用 DB 时间，超时/延迟用 `performance.now()`。
- 序列化：TS 类型在运行时擦除；跨进程/跨版本必须显式 schema/manifest，不能依赖 `JSON.stringify` 的隐式约定。

## 7. 协议与互操作

`troupe.cr` 的 ADR 0001 已经定义了 canonical identity、错误码、信封、`TRP1` 帧与 golden fixtures；`troupejs` 仍是 4 字节长度 + JSON，没有 magic/CRC/版本协商。两者不能混群。

建议分两步：

1. **先在 troupejs 内部冻结契约**：`WireMessage` 显式 `protocolVersion`；join/auth ack 带版本；方法 ID/错误码/身份编码稳定；生成 golden fixtures。
2. **再与 troupe.cr 对齐**：身份编码（`namespace/role/key`，`%`/`/` 转义）、错误码、信封字段、帧头（magic+version+length，CRC 可选但需 ADR 决定）、traceparent、deadline/cancel。只有 golden fixtures 两边都通过，才宣称“协议兼容”；跨语言混群是更后的目标。

不要为了“跨语言”直接采用 Crystal 的私有 JSON 字段名或 Node 的 `JSON.stringify` 默认行为；公共协议必须是独立规范。

## 8. 范围、非目标与取舍

### 8.1 建议范围

| 范围 | 包含 | 不包含 | 结果 |
|---|---|---|---|
| A | P0：fencing、续租、capability、CI、传输最小安全 | 目录、PG Cue、Stream | 可信单集群；不再有已知旧 epoch 覆盖 |
| B（推荐） | A + P1：目录化所有权、PG Cue、TLS/join、3 节点混沌 | Stream/Outbox/互操作 | 生产 HA 的小/中型集群 |
| C | B + P2/P3：Stream、Outbox、取消、协议、滚动升级 | 事务/Provider 生态/.NET 兼容 | Orleans-class 核心语义 + 明确边界 |

估算见 §0；这些是工程估算，不是日期承诺。范围 B 是“是否敢对外说生产可用”的分界线。

### 8.2 明确非目标

- 不复制 Orleans 的分布式 ACID 事务、`IGrainStorage` 全生态、.NET 序列化/DI 兼容。
- 不在没有真实多机证据前宣称“多机生产”“跨语言混群”“Orleans 等价”。
- 不把 Show 改造成通用消息队列；可靠消息用独立 Stream。
- 不为 parity 引入 ZooKeeper/etcd；PG 是第一阶段协调存储，规模证据不足再换。
- 不追求“Provider 数量”，追求 Provider 合同测试与能力声明。

### 8.3 关键决策（ADR 候选）

| ID | 决策 | 理由 |
|---|---|---|
| D1 | Stage 保持在应用进程内，不引入独立 silo mesh | 与 troupe.cr 一致；Node 运维简单；先解决权威与证据 |
| D2 | ownership 表提升为权威目录，HashRing 只做候选/减载 | 复用现有 schema；避免双写；目录是路由权威 |
| D3 | Show=ephemeral，Stream=durable，两者 API 分离 | 防止“有限重试”冒充持久流 |
| D4 | PG 作为第一阶段协调/状态/提醒/流存储 | 团队已有 PG；避免新组件；单库可验证 |
| D5 | 生产强制 TLS + join 凭证 + admin token | 当前网络边界不成立 |
| D6 | 协议先内部冻结，再与 troupe.cr ADR 对齐 | 避免四语言分叉；golden fixtures 先行 |
| D7 | 事务/ES/Provider 生态列为非目标 | ROI 低；Outbox+幂等覆盖多数场景 |
| D8 | 热替换保持实验性，不阻塞核心 | 差异化能力，但兼容检查未完成 |

## 9. 验收不变量与测试矩阵

### 9.1 不变量

| ID | 不变量 |
|---|---|
| I1 | 同一 Actor 在任意时刻最多一个有效 lease 的 owner；目录 `epoch` 单调 |
| I2 | 启用 ownership 时，所有 Props 变更携带 token，存储原子校验 `epoch + lease`；旧 token 一律失败 |
| I3 | 续租失败在租约到期前停止接单；在飞 Turn 允许 settle，但不再产生新的成功写 |
| I4 | production 拒绝非 `crossNodeSafe`/非 `supportsFencing` 的 Provider；拒绝无 TLS/无 join 凭证的传输 |
| I5 | Reminder 至少一次；同一 `(actor,name)` 同时只有一个 claim；重复由业务幂等兜底 |
| I6 | Stream ack 只前进；失败不越过；保留裁剪显式；重放可验证 |
| I7 | Outbox 与 Props 同事务；dispatcher 至少一次；接收方按 eventId 幂等 |
| I8 | 目录缓存不把过期 lease 的 owner 当作有效路由；miss 必须回源 |
| I9 | 滚动升级期间旧/新节点按 R1–R6 互操作；schema 只前进，回滚有明确禁令 |
| I10 | CI 不允许静默 skip；跳过项必须在报告中列出并使对应 job 失败 |

### 9.2 测试矩阵

| 层 | 内容 | 何时跑 |
|---|---|---|
| 单元/契约 | fencing CAS、错误分类、Codec、调度矩阵、Cue claim | 每次 PR |
| 真实 Provider | PG create/write/acquire/release、Cue claim/complete、Stream append/ack | 每次 PR（Linux + PG service） |
| 多进程 | 3 进程 + PG：激活、扩容、kill -9、重启、接管 | 每次 PR 或 nightly |
| 故障注入 | PG 重启/断连、网络分区/丢包/延迟、SIGSTOP/SIGCONT、时钟偏移 | nightly |
| 安全 | 无 token join、错误 token、TLS 失败、admin 未授权 | 每次 PR |
| 兼容 | 旧/新协议、schema v→v+1、R1–R6 | 发布前 |
| 性能 | 激活/调用/队列/TCP；与旧口径对比 | nightly/发布前 |

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 目录与 ownership 双写不一致 | 路由到错误 owner / 双活 | 目录条目就是 ownership 行；一个 CAS 路径；ring 只做提示 |
| PG 成为单点/瓶颈 | 集群不可用/延迟 | 连接池、超时/重试、目录缓存、容量基准；明确 RPO/RTO；后续再评估 DHT/ broker |
| Stream 范围蔓延 | 自研队列长期不可靠 | 窄契约；先 PG；吞吐不足再 NATS adapter；不承诺 exactly-once |
| 时钟偏差 | 租约误判 | DB 时间做租约权威；本地 monotonic 做超时；文档化假设 |
| Node CPU 阻塞 | 尾延迟/误判死 | worker/process 隔离；容量边界；CPU 密集角色单独 Stage |
| 安全配置复杂 | 部署失败/绕过 | 默认安全、显式 dev 降级；证书/ token 轮换文档；启动自检 |
| 兼容性回归 | 滚动升级失败 | R1–R6 自动检查 + 混合版本测试；schema 只前进 |
| 文档再次漂移 | 错误预期 | 单一状态源；CI 检查 README/VERIFICATION 链接与最新结果 |

## 11. 参考

- [ROADMAP.md](./ROADMAP.md)：分阶段任务、门禁与 30/60/90 天计划。
- [DESIGN.md](../DESIGN.md)：当前语义契约。
- [operations.md](./operations.md)：集群/所有权/运维现状。
- [VERIFICATION.md](./VERIFICATION.md)：本机验证与跳过项。
- `troupe.cr`：`PLAN.md`、`DESIGN.md`、`docs/persistence.md`、`docs/cluster.md`、`docs/outbox.md`、`docs/security.md`、`docs/ROLLING_UPGRADE.md`。
- Orleans：`reference-repos/orleans`（commit `8320d257`），`docs/orleans-baseline.md`。
