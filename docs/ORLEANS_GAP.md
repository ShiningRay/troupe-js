# Troupe.js 与 Orleans 的能力差距

> 基线：Orleans 源码 `8320d257`，版本声明 10.0.0。本文是当前仓库的能力审计，不代表已实现路线图。
> 统一规划：[troupe-planning](https://github.com/ShiningRay/troupe-planning)。

## 当前定位

Troupe.js 已实现较完整的虚拟 Actor 单机核心、TCP 集群、Props CAS 与租约 fencing、持久 Cue、交错调度、实时 Show、Booth、Trace/OTel 适配和实验性热替换。它比“Actor 包装库”走得更远，但不能把 M1–M11 的项目内里程碑等同为 Orleans 级分布式运行时。

## 能力域对照

| 领域 | 当前实现 | 与 Orleans 的主要差距 |
|---|---|---|
| Identity / lifecycle | `(roleId, stageName)`、single-flight、Intermission、drain | 逻辑身份与 activation incarnation 的统一契约、丰富生命周期扩展点 |
| 调度 | strict + annotated 交错；响应超时不释放执行占用 | 缺少贯穿远程调用的协作取消、call-chain reentrancy 和 per-call 调度控制 |
| 目录与放置 | 一致性哈希、漂移转发、本地槽位 | 无版本化分布式目录、资源/能力放置、activation rebalancing |
| 状态 | Memory/SQLite/PostgreSQL，CAS、schemaVersion、fencing | Provider 生态、版本容错类型系统、状态事务和事件溯源 |
| 集群 | gossip 反熵、直接探测、suspect/dead、incarnation | 缺乏持续多机、网络分区、成员表故障与恢复验证 |
| Timer / reminders | 内存 Cue、Memory/SQLite 持久 reminders | 缺共享 PostgreSQL CueStore、跨节点调度 HA 和完整时区语义 |
| Show | 跨 Stage fan-out、SQLite 订阅记录、有界重试 | 不是 Orleans persistent streams：没有事件日志、游标、重放和队列平衡 |
| 可靠性 | 幂等记录、UnknownOutcome、fencing | 缺持久 outbox/inbox、跨 Actor 事务、外部副作用 epoch 协作 |
| 编程与协议 | TypeScript 类型、JSON、私有 TCP 协议 | 无语言中立 IDL/版本化契约；不支持与其他 Troupe 语言混群 |
| 运维 | Booth、CLI、Prometheus、Trace、OTel 回调 | 缺持续 CI、发布/兼容矩阵、生产安全和完整滚动升级证据 |
| 热替换 | recycle/swap、签名 bundle、有限 R1/R3 检查 | 仍是独立实验；并非完整 Orleans 版本兼容与部署体系 |

## 可复现问题与跟踪

- [#1 Show 可靠语义与文档不一致](https://github.com/ShiningRay/troupejs/issues/1)：订阅持久化不是事件持久化，三次失败仍丢弃。
- [#2 Postgres 可选依赖声明不一致](https://github.com/ShiningRay/troupejs/issues/2)：动态加载与 devDependencies/optional peer 契约需统一。
- [#3 PostgreSQL/POSIX 验收门禁](https://github.com/ShiningRay/troupejs/issues/3)：本轮 PostgreSQL 3 项和 SIGSTOP 1 项跳过，不能视为已通过。
- [#4 热替换兼容检查范围](https://github.com/ShiningRay/troupejs/issues/4)：实际自动检查为 R1/R3 子集，并非 R1–R6 全集。

## 实现路线

见 [ROADMAP.md](./ROADMAP.md)。优先修正确性、发布与验证，再补共享 reminders 和可靠消息；目录/放置、跨语言协议与事务须经统一 ADR，而不是在本仓另起不兼容实现。

## 不做简单等价的功能名称

- “至少一次投递”必须有实际恢复语义，不能由有限重试推断。
- “持久订阅”不等于“持久事件”。
- “fencing”只保护配合校验的存储写入，不自动保护 HTTP 等外部副作用。
- “多进程测试”不等于“多机生产验收”。
- “Orleans 对标”不等于复制其 .NET 专属序列化、DI 或事务 API。
