# Troupe.js 开发计划

> 状态：v4 · 2026-09-12（按设计审查重构：新增 M0 语义契约；PropStore 合同提前至 M1；所有权交接定在 M3；交错执行与热更新后移）
> 设计与术语以 [DESIGN.md](./DESIGN.md) 为准，本文档只讲怎么落地。

---

## 1. 里程碑总览

| 阶段 | 内容 | 关键验收 |
|---|---|---|
| M0 | 语义与契约 | 每项承诺（执行/失败/持久成功/所有权/兼容）都有反例与防护对应 |
| M1 | 严格串行运行时 + PropStore 合同 | 并发首次调用只激活一次；超时不放行旧任务；保存失败不污染后续调用 |
| M2 | 本地持久化 + 集群基础 + 信任边界 | 本地/远程/Rehearsal 数据行为一致；畸形帧可控拒绝 |
| M3 | 共享持久化 + 成员协议 + 所有权交接 | 正常扩容、失联、暂停恢复不破坏选定一致性级别 |
| M4 | 持久 Cue + Director/CLI + 基础指标 | 下场及集群重启后提醒可发现；重复投递策略可验证 |
| M5 | 交错执行（@Improv/@ReadOnly） | 组合矩阵与写饥饿防护专项测试 |
| M6 | Trace 总线 | `tail`/`top` 可用 |
| M7 | Show + Audience | pub/sub 全链路 |
| M8 | BoxOffice、观测性、压测 | 十万级在场 Actor 基准（含热点倾斜与两种成功语义分别测量） |
| M9 | Booth | 基础版 + 进阶版 |
| M10 | dev 热重载（L1） | recycle 保存即生效；swap 守则静态检查 |
| M11 | 生产热替换（L2，独立实验） | 独立语义与容量预算验收；回滚演练 |

顺序逻辑：M0 先把承诺写成可验收契约，避免实现到一半才改接口与执行模型；PropStore 合同与生命周期相互定义，随 M1 落地（不能晚于运行时）；编解码一致性与信任边界先于任何跨节点部署；所有权交接先于任何"生产集群"宣称；持久 Cue 依赖所有权与调度契约；交错执行改变执行模型，独立成阶段；观测埋点与测试注入接口从 M1 保留，完整管理界面与动画后移；热更新是最后一块增量能力。"核心零 npm 依赖"是交付偏好，不优先于协议正确性与维护成本。

---

## 2. 各里程碑详述

### M0 语义与契约（文档与验收设计，不动代码）✅ 已完成（2026-09-12，随 DESIGN.md v2 修订交付）

范围：评审并冻结 DESIGN.md 五类承诺，为每条写出反例场景与防护：

1. **执行契约**（DESIGN §5）：排队过期不执行；执行占用与响应期限分离；协作取消；生命周期状态机（single-flight、排空语义）
2. **失败契约**（DESIGN §6.5）：调用结果未知语义；幂等记录（业务键 + 参数指纹 + 原始结果）随状态原子提交；保留期限；跨 Actor 补偿/outbox 边界
3. **持久成功契约**（DESIGN §7.3、§10.3）：响应前原子提交 vs 标注丢失窗口；group commit
4. **所有权契约**（DESIGN §6.5）：租约 + fencing token + 排空交接；无协调模式定位实验性、删除强一致无条件保证
5. **兼容性契约**（DESIGN §9.4）：滚动混跑协议/schema 规则（第一个生产集群版本前成文的规范本体）

验收：本文档 §3 横切验收场景表逐行完成场景设计（每行对应具体测试用例与故障注入方式）；`PropStore`/`CueStore`/信封错误分类接口评审冻结。

### M1 严格串行运行时 + PropStore 合同 ✅ 已完成（2026-09-12，验收单测 31 例全绿，含 Actor 互调 this.cast）

范围：`Actor<TProps>` 基类与生命周期钩子、`static initialProps()` 初始状态工厂、生命周期状态机（未激活/激活中/运行中/排空中/失效；激活 single-flight；排空期间新请求等待或明确拒绝）、显式注册 `form({ actors })` + `@Performs` 便利注册（每 Troupe 注册表快照）、`cast()` → Agent（类型面仅 RPC 方法；then/Symbol 访问安全）、StageManager + CallBoard **严格串行**（`@Improv`/`@ReadOnly` 标注按串行执行并告警）、排队过期不执行、`PropStore` 接口（revision/schemaVersion 分离、create/write CAS 合同，DESIGN §7.2）+ `InMemoryPropStore`、保存失败默认实例失效、Intermission 空闲回收、Rehearsal（`troupe/testing`）、观测埋点与测试注入接口（计数器、事件钩子——完整界面后移）、框架仓库脚手架。

验收：

- DESIGN.md §3.1 Cart 最小示例真实运行
- 并发首次调用只激活一次（single-flight）；排空期间新请求等待或明确拒绝（按配置生效）
- 超时后旧异步任务不放行后续 Turn（执行占用验证：A 超时后 B 不与 A 交错、A 结束前 B 不执行）
- 保存失败后实例失效，下次调用从最后已提交快照继续（不基于未提交状态运行）
- CAS 冲突抛 `ConflictError` 且实例失效；同键不同参数的幂等记录被拒绝
- Rehearsal 中 Cart 单测：并发 100 个 `add` 无交错（串行性验证）
- 设置 1s Intermission，验证自动下场 + `offStage` 钩子触发；`NODE_ENV=test` 零显式配置

### M2 本地持久化 + 集群基础 + 信任边界 ✅ 已完成（2026-09-12，累计验收 62 例全绿；附带交付 Booth 预览版——极简内省面板，完整版仍属 M9）

范围：`SqlitePropStore`（`node:sqlite`；懒建库表、`TROUPE_PROPS_DIR`；CAS 以单条 UPDATE 实现；DatabaseSync 同步执行对 Stage 延迟/心跳的影响基准测量）、Codec 边界统一（本地调用默认复制；Date/BigInt/Map/Set/循环引用的默认行为与报错指引）、TCP 传输（长度前缀 + JSON；帧长度上限、连接缓冲上限、in-flight 上限）、方法白名单与信封校验（生命周期钩子/基类成员/构造器不可经普通 RPC 调用）、错误分类（业务异常/请求拒绝/结果未知/存储冲突）、HashRing 移植（参考 `hashring/hash_ring.rb`，纯 JS xxh32，160 虚拟节点）+ 误投转发（跳数上限 2）、基础 Roster（seeds join + gossip 反熵 + 直接探测判死的简化版；完整硬化在 M3）、优雅停机全链路（`quiesce()` 等待所有运行中请求与框架回调）、全局背压（每 Stage 激活数、总排队字节、in-flight RPC；超限显式拒绝）、Node 最低版本启动检查。

验收：

- 本地/远程/Rehearsal 三种模式同一示例数据行为一致（同一编解码/复制边界）
- 畸形帧（超长、坏 JSON、白名单外方法、非法参数）可控拒绝，连接与进程不崩
- 双进程通过 `TROUPE_SEEDS` 组团，互相 `cast` 调用透明；环漂移期 Call 经转发不丢失
- `kill -9` 一个 Stage，后续 Call 在存活 Stage 重激活（进程级：本地 SQLite 同机恢复）
- 优雅停机验收定义量化：停机开始后新 Call 收到拒绝；存量 Call 全部 settle 或超时；全员 offStage+saveProps 完成
- SQLite 写入对 p99 延迟与心跳间隔的影响有基准数字（决定何时该切共享存储）

### M3 共享持久化 + 成员协议 + 所有权交接 ✅ 已完成（2026-09-12，累计验收 83 例全绿；含 SIGSTOP 混沌 fencing 验收与真实 Postgres 验证）

范围：`PostgresPropStore`（可选 peer 依赖 `pg`；行级 CAS + fencing token 校验；`TROUPE_PROPSTORE=postgres://…` 选择）、所有权机制（所有权记录/租约/单调 epoch：获得才激活、租约到期停止接单、存储拒绝旧 token、旧实例排空落盘释放，DESIGN §6.5）、Roster 硬化（直接探测 + ACK、suspect/确认流程、重启新 incarnation、单调版本合并、死亡记录保留与反驳规则）、production 部署模式（固定端口、显式 advertiseAddress、必须成功入团、角色集合/协议版本/共享存储连通校验）、滚动混跑兼容规范成文（L3 规范本体，DESIGN §9.4）。

验收（双节点正常通信不构成验收，需 ≥3 节点 + 混沌注入——丢包、乱序、事件循环暂停、分区恢复）：

- 正常扩容：旧 Stage 有未完成调用时新 Stage 接管；在选定一致性级别内无双活成功响应
- 失联与分区恢复：成员收敛，无误判风暴（注入丢包/乱序下误判率有界并记录）
- 事件循环暂停的旧持有者恢复后，其写入被 fencing token 拒绝
- `kill -9` 后 Actor 在另一 Stage 以完整 Props 重新登台（节点级）
- 混跑兼容规范评审通过（方法只增不减等规则可执行、可检查）

### M4 持久 Cue + Director/CLI + 基础指标 ✅ 已完成（2026-09-13，累计验收 95 例全绿；CLI 实机验证通过）

范围：`CueStore`（到期查询、原子 claim、租约、完成确认，DESIGN §7.5）、持久提醒模型（稳定名称 + 可序列化负载 + 计划/时区/nextDue/statusVersion；`onCue(name, payload)` 分派）、投递语义（至少一次 + 业务幂等；错过周期跳过/合并补发；宕机重复投递；注销竞争以 statusVersion 裁决）、Director 系统角色（roster/actors/inspect/invoke/off/cues/ring；管理扇出携带权限上下文）、Actor 注册表与基础计数器埋点、CLI 骨架与命令（连接协商、loopback 默认、`TROUPE_ADMIN_TOKEN`；`status` `roster` `ps` `inspect` `call` `off` `cues` `ring`；`--json`/`--watch`）、`/healthz` `/metrics` 完善。

验收：

- Actor 下场后持久提醒按时触发并重新登台；集群整体重启后提醒仍可被发现
- 提醒执行一半宕机 → 租约到期重新投递；业务幂等去重可验证（重复投递策略有测试）
- `npx troupe ps` 本地 dev 节点零配置出表；`inspect` 看到 Props 快照；`call` 跨 Stage 返回结果；`off` 后 Actor 从 `ps` 消失

### M5 交错执行（@Improv/@ReadOnly，DESIGN §5.4）

范围：允许组合矩阵（`@ReadOnly`×`@ReadOnly`、`@Improv`×任意 await 点、未标注不交错）、写饥饿防护（写调用入队后读让位/读份额上限）、跨 await 中间态可见性文档与示例、`quiesce()` 扩展（等待全部运行中请求与框架回调）。

验收：组合矩阵专项测试（含 A→B→A 交错序列）；持续读负载下写调用在有限时间内获得执行；交错开启时 quiesce/优雅停机正确等待全部在执行请求。

### M6 Trace 总线

范围：调用事件（调用方→被调方、方法、耗时、结果）+ 每 Stage 1 万条环形缓冲 + Trace 字节预算 + 采样率配置 + `subscribeTrace`；CLI `tail` `top`。

验收：双 Stage 场景 `troupe tail --role Inventory` 实时流出跨节点调用事件；Trace 预算超限时自动降采样，不 OOM。

### M7 Show + Audience

范围：Show（虚拟流：publish/subscribe，隐式订阅管理，首实现进程内 + TCP 转发）、Audience（客户端回调引用）。底层可插拔（NATS JetStream/Redis Streams 后续）。

验收：聊天室示例——`RoomActor` 向 Show 发布，订阅者（含 Audience 回调）实时收到。

### M8 BoxOffice、观测性、压测

范围：BoxOffice（WebSocket 客户端网关，ticket 鉴权，浏览器直拿 Agent）、OpenTelemetry 打通（调用上下文随信封传播）、性能压测与调优。

验收：十万级在场 Actor 内存/调度基准报告；热点倾斜场景（单热点 Actor、大量唯一 stageName、慢接收方）验证全局内存预算与过载拒绝；持久成功与攒批两种语义的吞吐分别测量成文（容量事实：单热点 Actor 只有一个串行通道）；浏览器客户端经 BoxOffice 完成一次 cast 调用。

### M9 Booth

范围：SPA 构建管线（产物打进 npm 包，依赖不进用户 node_modules）、Stage 内嵌静态服务 + SSE、`troupe booth` 命令；基础版页面（Troupe 总览、Actors 浏览器、Actor 详情 + 调用面板 + 强制下场）；进阶（Ring 视图、Live Trace 动画、Metrics 图表）。

验收：dev 模式 `Troupe.form()` 后访问 `/booth` 直接可用；从界面调用一个方法并看到 Props 变化；Live Trace 对接 M6 总线。

### M10 dev 热重载（L1，见 DESIGN.md §9.3）

范围：`troupe dev` 监听与转译管线（esbuild + ESM 版本化重导，依赖子图传递失效；运行时单例保持、旧依赖子图与外部资源释放、反复重载内存测量）、注册表 `codeVersion`、三种在场 Actor 处理策略（`recycle` 默认 / `swap` opt-in / `keep`）、`Actor` 基类 `onCodeSwap()` 钩子与失败回滚、swap 守则静态检查（实例字段、`#private`、实例箭头函数、预 bind 方法）、Edge handler 间接引用原子切换、CLI `ps` 增加代码版本列。

验收：

- dev 模式修改 `inventory.actor.ts` 保存：`recycle` 策略下场重登且 Props 无损（前提成立时；前提清单见 DESIGN §9.1 并在文档列明）
- 守则合规 Actor 用 `swap`：实例与内存状态保留，新方法即时生效（`quiesce()` 等待全部运行中请求后换码）；不合规代码被静态检查拒绝 swap
- 反复重载 1 小时内存无持续增长；Edge 路由文件修改保存后不断连生效

### M11 生产热替换（L2，独立实验，见 DESIGN.md §9.4）

范围：版本签名模块包与 `troupe deploy --hot` 下发通道、Roster `codeVersion` 广播、生产 swap 流程与回滚（含新 schema 已写入时的降级策略）、不兼容变更的部署期静态检查（方法/参数 diff + swap 守则扫描）。定位为独立实验：不作为核心框架的前置交付压力，前提是 L0 滚动重启路径已可靠。

验收：双 Stage 集群不打断流量完成一次 Actor 紧急修复，`ps` 可见版本切换；含不兼容变更的包被部署通道拒绝并输出违反的规则；回滚演练通过。

---

## 3. 横切验收场景

任一相关里程碑的验收都从这里取场景，逐行落实为可执行测试（M0 完成场景设计）：

| 场景 | 要验证的性质 | 主要覆盖 |
|---|---|---|
| 首次同时调用、下场同时来新请求 | 激活单飞与生命周期互斥 | M1 |
| 超时后旧异步任务继续、A→B→A | 执行占用与等待超时的区别 | M1 / M5 |
| 已提交但响应丢失、已响应但尚未提交 | 幂等恢复和成功持久性的边界 | M1 / M2 |
| CAS 冲突、保存结果未知、迁移失败 | 不继续使用失效或未提交状态 | M1 / M3 |
| 正常扩容时旧调用未结束 | 所有权交接与状态快照一致 | M3 |
| 事件循环暂停、网络分区、旧节点恢复 | 误判处理和旧持有者写入保护 | M3 |
| Cue 到期后执行一半宕机 | 重新发现、重复投递与业务幂等 | M4 |
| 新旧代码混跑、升级后回滚 | 协议及状态的兼容性 | M3（规范）/ M10 / M11 |
| 热点 Actor、大量唯一 ID、慢接收方 | 全局内存预算与过载拒绝 | M2 / M8 |

---

## 4. 框架仓库结构（M1 搭建）

单 package + subpath exports，保持用户侧单一依赖：

```
troupejs/
├── package.json            # name: troupe；exports: "." "./edge" "./testing"；engines >= 22.13
├── src/
│   ├── core/               # Actor、注册表、Agent、StageManager、CallBoard、生命周期状态机
│   ├── cluster/            # transport、roster、hash-ring、playbill、所有权
│   ├── props/              # prop-store 接口、memory（M1）、sqlite（M2）、postgres（M3）
│   ├── cues/               # cue-store 接口与实现（M4）
│   ├── director/           # 系统内省角色
│   ├── edge/               # createEdge（/healthz、/metrics）
│   ├── hot/                # dev 热重载管线、swap 机制（M10 起）
│   └── testing/            # Rehearsal
├── bin/troupe              # CLI
├── booth/                  # SPA 源码 → 构建产物打进包
├── examples/
│   ├── minimal/            # Cart 最小示例（M1 验收，对应 DESIGN.md §3.1）
│   └── drop-shop/          # 秒杀示例（按 DESIGN.md §12 布局，M2/M3 验收素材）
├── test/
├── hashring/               # 现有 Ruby 参考实现（移植后归档）
├── DESIGN.md / PLAN.md
└── tsconfig.json
```

---

## 5. 已确认的技术选型

| 项 | 选择 | 备注 |
|---|---|---|
| 语言/运行时 | TypeScript 5 + Node.js >= 22.13 | `node:sqlite` 在 22.x 于 22.13 起无需 `--experimental-sqlite`；按实际使用 API 锁最低小版本 + 启动时版本检查；engines 字段锁版本 |
| 序列化 | JSON（`Codec` 接口预留 MessagePack） | 本地调用默认同边界复制；Date/BigInt/Map/Set/循环引用默认行为见 DESIGN §6.1 |
| 传输 | 自建 TCP + 长度前缀 | loopback 默认 + 方法白名单 + 帧上限；零依赖 |
| 成员管理 | 传播（gossip 反熵）与探测（ping/ACK + suspect/confirm + incarnation）分离 | 非完整 SWIM；生产一致性依赖共享存储租约 + fencing，不自建全量协议 |
| 寻址 | HashRing 候选 + 所有权契约（共享存储租约，M3） | 无全量目录；xxh32 纯 JS 实现 |
| 默认持久化 | `node:sqlite`（InMemory 供测试） | 进程级；DatabaseSync 同步执行，M2 基准测量影响 |
| 共享 PropStore | `PostgresPropStore`（`pg` 为可选 peer 依赖） | M3；节点级持久 + 所有权记录 + fencing，多节点生产必需 |
| 装饰器 | TS 5 stage-3 装饰器 + 静态字段等价物 | 双轨避免 tsconfig 摩擦；注册以 `form({ actors })` 显式为正道 |
| dev 热重载 | esbuild 转译 + ESM 版本化重导 | M10；构建期依赖，不进运行时 |
| 核心 npm 依赖 | 目标为零 | 交付偏好，不优先于协议正确性与维护成本 |

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `node:sqlite` 在低版本 Node 不可用或仍需 flag | engines 锁 >= 22.13 + 启动检查明确报错；必要时出 `better-sqlite3` 可选 Provider |
| `DatabaseSync` 阻塞主线程，影响延迟与心跳 | M2 基准测量；攒批/WAL；写入密集场景给出切共享 Postgres 的量化阈值 |
| 本地 Props 随节点永久丢失 | M3 共享 `PostgresPropStore`；DESIGN.md §7.2 明示 SQLite 仅进程级持久，多节点生产必须切换 |
| 无协调集群双活/脑裂 | 定位实验性（DESIGN §6.5 明示不承诺强一致）；生产走所有权租约 + fencing token；二期仲裁式 Roster（Redis/etcd） |
| 成员误判（事件循环暂停、丢包） | 传播与探测分离 + incarnation 重启身份；M3 混沌验收（≥3 节点 + 丢包/乱序/暂停注入） |
| 成员变更漂移期转发正确性 | 转发跳数上限 + 漂移期专项测试 |
| 持久 Cue 重复投递/错过触发 | 至少一次 + 业务幂等；错过周期策略显式（跳过/合并补发）；M4 验收覆盖宕机重投 |
| 永久挂起的用户任务占住串行通道 | 响应期限与执行占用分离 + 协作取消；恢复靠进程隔离/实例失效/所有权保护（DESIGN §5.1） |
| swap 热替换被滥用 | `recycle` 默认；守则静态检查（M10）；生产部署期再查（M11）；L2 定位独立实验 |
| 单热点 Actor 容量上限被误解 | 容量事实成文（一个串行通道）；压测覆盖热点倾斜（M8） |

---

## 7. 开放问题

1. ~~**Agent 命名**~~ ✅ 已定（2026-09-12，M1 动工时）：保留 `Agent`——与 DESIGN §2 词典一致，`ActorRef` 备选废弃
2. **CLI 实现**：commander 等库 vs 手写参数解析（命令不多，倾向手写保持零依赖）
3. **Booth 前端栈**：构建期自由（倾向 Vite + React），产物体积预算需定（M9 前）
4. **远程 Call 自动重试**：一期不自动重试（结果未知语义，DESIGN §6.5）；是否在 Agent 上加显式 `retry` 选项（幂等方法标注后）？M7 前评估
5. **热重载转译器**：esbuild vs swc（M10 前按转译速度与装饰器兼容实测决定）
6. ~~**外部副作用的 fencing 保护**~~ ✅ 已定（随 DESIGN v2 §6.5）：双轨指导——接收方校验 fencing token，或持久化 outbox + 业务幂等；细化示例随 M3 交付
7. **本地调用性能优化（后续课题，暂不实施）**：基准显示框架本地路径 ≈4μs/条（vs 直调 async ≈0.09μs，见 README 基准表）——候选方向：Codec 快路径（同一序列化上下文复用）、免超时竞速定时器（仅在需要时创建）、入队零拷贝、Turn 结果直通。作为 M8 压测调优阶段的主议题，接口不得为性能破坏 §6.1 边界语义

---

## 8. 下一步（M5 启动清单）

M1–M4 已完成（M4：2026-09-13）。M4 代码骨架：`src/cues/{cue-store,memory,sqlite,scheduler,actor-cues}.ts`、`src/director/director.ts`、wire `t=dir` 通道（token 校验）、`cli/troupe.ts`、Booth `/healthz`+`/metrics`。已知边界：cron 表达式与 timezone 解析未实现（every/at 已覆盖）；PG 版 CueStore 未实现（SQLite 同机多进程可用）；跨 Stage 的 Director 扇出聚合未做（CLI 连单点）。

1. 允许组合矩阵：`@ReadOnly`×`@ReadOnly`、`@Improv`×任意 await 点、未标注不交错（DESIGN §5.4）
2. 写饥饿防护：写调用入队后读让位/读份额上限
3. 跨 await 中间态可见性文档与示例
4. `quiesce()` 扩展：交错开启时等待全部运行中请求与框架回调
5. 专项测试：A→B→A 交错序列、持续读负载下写有限时间获得执行
