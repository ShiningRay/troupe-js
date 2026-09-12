# Troupe.js 开发计划

> 状态：v3 · 2026-09-12（共享 PropStore 提前至 M3，明确持久级别界限）
> 设计与术语以 [DESIGN.md](./DESIGN.md) 为准，本文档只讲怎么落地。

---

## 1. 里程碑总览

| 阶段 | 内容 | 关键验收 |
|---|---|---|
| M1 | 单机运行时 | 最小示例跑通；Rehearsal 单测通过 |
| M2 | 集群化 | 双 Stage 互调；杀节点自动重激活 |
| M2.5 | Director + CLI 基础 | `status`/`roster`/`ps`/`inspect` 可用 |
| M2.6 | CLI 扩展 | `call`/`off`/`cues`/`ring` 可用 |
| M3 | Props + Cue | 状态跨下场存活；节点级恢复（共享 PropStore）；持久 Cue 触发重登台 |
| M3.5 | Trace 总线 | `tail`/`top` 可用 |
| M3.6 | dev 热重载（L1） | 保存即生效，swap/recycle 策略可用 |
| M4 | Show（流）+ Audience（观察者） | pub/sub 全链路 |
| M4.5 | Booth 基础版 | 总览、Actors 浏览器、详情+调用面板 |
| M5 | BoxOffice、观测性、压测 | 十万级在场 Actor 基准 |
| M5.5 | Booth 进阶版 | Ring 视图、Live Trace 动画、Metrics 图表 |
| M6 | 生产热替换（L2）与升级兼容规范 | `deploy --hot` 无滚动修复；L3 兼容规则成文 |

顺序逻辑：CLI 依赖 M2 的跨 Stage 通道所以紧随其后；Trace 依赖稳定的调用链；Booth 等 Director API 稳定后纯消费，风险最低；dev 热重载依赖 M3 的 Props 兜底路径（recycle 策略）故列 M3.6；生产热替换依赖 Roster 版本广播与部署工具链，列 M6。共享 PropStore 定在 M3：多节点生产的韧性与扩缩容都以它为前提，不能晚于第一个真实集群部署。

---

## 2. 各里程碑详述

### M1 单机运行时

范围：`Actor<TProps>` 基类与生命周期（`onStage`/`offStage`）、`@Performs` + 进程级注册表（含静态字段等价物）、`cast()` → Agent（Proxy 动态派发 + 类型推导）、StageManager + CallBoard（严格串行 turn；`@Improv` 交错）、Intermission 空闲回收、Rehearsal 模式（`troupe/testing`）、框架仓库脚手架。

验收：

- DESIGN.md §3 的 Greeter 最小示例真实运行
- Rehearsal 中 Cart 单测：并发 100 个 `add` 无交错（串行性验证）
- 设置 1s Intermission，验证自动下场 + `offStage` 钩子触发
- `NODE_ENV=test` 下零显式配置

### M2 集群化

范围：TCP 传输（长度前缀 + JSON 信封）、Roster（seeds join + 1s 心跳 + 反熵合并 + 5s 死亡判定）、HashRing 移植（参考 `hashring/hash_ring.rb`，纯 JS xxh32，160 虚拟节点）、Playbill 路由 + 误投转发（跳数上限 2）、Stage 死亡重激活、优雅停机全链路（`quiesce()` 机制在此建立，热更新复用）。

验收：

- 双进程通过 `TROUPE_SEEDS` 组团，互相 `cast` 调用透明
- `kill -9` 一个 Stage，后续 Call 在存活 Stage 重激活并返回正确结果
- 环上摘除/新增的漂移期内 Call 经转发不丢失
- 优雅停机后环在 1 个心跳周期内收敛

### M2.5 Director + CLI 基础

范围：Director 系统角色（roster/actors/inspect/ring）、Actor 注册表与基础计数器埋点、`troupe` CLI 骨架（连接协商、loopback 默认、`TROUPE_ADMIN_TOKEN`）、四命令：`status` `roster` `ps` `inspect`，含 `--json`。

验收：本地 dev 节点 `npx troupe ps` 零配置出表；`inspect` 能看到 Props 快照。

### M2.6 CLI 扩展

范围：`invoke`（Director 方法调用通道）+ `call` `off` `cues` `ring` 命令、`--watch`。

验收：`troupe call Inventory sku-1 available` 跨 Stage 返回结果；`off` 后 Actor 从 `ps` 消失。

### M3 Props + Cue

范围：`PropStore` 接口、`InMemoryPropStore`、`SqlitePropStore`（`node:sqlite`，懒建库表、`TROUPE_PROPS_DIR`）、**`PostgresPropStore`（节点级持久，可选 peer 依赖 `pg`；经 `TROUPE_PROPSTORE=postgres://…` 选择，多节点生产必需）**、`saveProps()`/版本号/`migrateProps` 钩子、内存 Cue 与持久 Cue（触发即重登台）。

验收：

- 秒杀示例 `InventoryActor` 写 Props 后强杀进程，重启 `cast` 同 stageName 状态恢复（进程级）
- **双 Stage + `PostgresPropStore`：强杀一个 Stage，Actor 在另一 Stage 以完整 Props 重新登台（节点级）**
- 持久 Cue 在 Actor 下场后按时触发并重新登台

### M3.5 Trace 总线

范围：调用事件（调用方→被调方、方法、耗时、结果）+ 每 Stage 1 万条环形缓冲 + 采样率配置 + `subscribeTrace`；CLI `tail` `top`。

验收：双 Stage 场景 `troupe tail --role Inventory` 实时流出跨节点调用事件。

### M3.6 dev 热重载（L1，见 DESIGN.md §9.3）

范围：`troupe dev` 监听与转译管线（esbuild + ESM 版本化重导，依赖子图传递失效）、注册表 `codeVersion`、三种在场 Actor 处理策略（`recycle` 默认 / `swap` opt-in / `keep`）、`Actor` 基类 `onCodeSwap()` 钩子、Edge handler 间接引用原子切换、CLI `ps` 增加代码版本列。

验收：

- dev 模式修改 `inventory.actor.ts` 保存：`recycle` 策略下场重登且 Props 无损
- 守则合规 Actor 用 `swap`：实例与内存状态保留，新方法即时生效（`quiesce()` 在 turn 边界换码）
- Edge 路由文件修改保存后不断连生效

### M4 Show + Audience

范围：Show（虚拟流：publish/subscribe，隐式订阅管理，首实现进程内 + TCP 转发）、Audience（客户端回调引用）。底层可插拔（NATS JetStream/Redis Streams 后续）。

验收：聊天室示例——`RoomActor` 向 Show 发布，订阅者（含 Audience 回调）实时收到。

### M4.5 Booth 基础版

范围：SPA 构建管线（产物打进 npm 包）、Stage 内嵌静态服务 + SSE、`troupe booth` 命令；页面：Troupe 总览、Actors 浏览器、Actor 详情（Props 实时视图、调用面板、强制下场）。

验收：dev 模式 `Troupe.form()` 后访问 `/booth` 直接可用；从界面调用一个方法并看到 Props 变化。

### M5 BoxOffice、观测性、压测

范围：BoxOffice（WebSocket 客户端网关，ticket 鉴权，浏览器直拿 Agent）、OpenTelemetry 打通（调用上下文随信封传播）、`/metrics` 完善、性能压测与调优。

验收：十万级在场 Actor 内存/调度基准报告；浏览器客户端经 BoxOffice 完成一次 cast 调用。

### M5.5 Booth 进阶版

范围：Ring 视图（圆环 + 漂移动画）、Live Trace 实时动画、Metrics 图表页。

### M6 生产热替换与升级兼容规范（L2/L3，见 DESIGN.md §9.4）

范围：版本签名模块包与 `troupe deploy --hot` 下发通道、Roster `codeVersion` 广播、生产 swap 流程与一键回滚、L3 混跑兼容规则成文（方法只增不减、参数向后兼容、Props `migrateProps`、version-aware Casting 规划）、不兼容变更的部署期静态检查（方法/参数 diff + swap 守则扫描：实例字段、`#private`）。

验收：双 Stage 集群不打断流量完成一次 Actor 紧急修复，`ps` 可见版本切换；含不兼容变更的包被部署通道拒绝并输出违反的规则。

---

## 3. 框架仓库结构（M1 搭建）

单 package + subpath exports，保持用户侧单一依赖：

```
troupejs/
├── package.json            # name: troupe；exports: "." "./edge" "./testing"
├── src/
│   ├── core/               # Actor、注册表、Agent、StageManager、CallBoard、生命周期
│   ├── cluster/            # transport、roster、hash-ring、playbill
│   ├── props/              # prop-store 接口、memory、sqlite、postgres
│   ├── director/           # 系统内省角色
│   ├── edge/               # createEdge（/healthz、/metrics）
│   ├── hot/                # dev 热重载管线、swap 机制（M3.6 起）
│   └── testing/            # Rehearsal
├── bin/troupe              # CLI
├── booth/                  # SPA 源码 → 构建产物打进包
├── examples/
│   ├── minimal/            # Greeter（M1 验收）
│   └── drop-shop/          # 秒杀示例（按 DESIGN.md §12 布局，M3 验收素材）
├── test/
├── hashring/               # 现有 Ruby 参考实现（移植后归档）
├── DESIGN.md / PLAN.md
└── tsconfig.json
```

---

## 4. 已确认的技术选型

| 项 | 选择 | 备注 |
|---|---|---|
| 语言/运行时 | TypeScript 5 + Node.js（>= 22.5，因 `node:sqlite`） | engines 字段锁版本 |
| 序列化 | JSON（`Codec` 接口预留 MessagePack） | 零依赖优先 |
| 传输 | 自建 TCP + 长度前缀 | 无第三方依赖 |
| 成员管理 | seeds + 轻量 gossip | 非完整 SWIM，一期接受脑裂风险 |
| 寻址 | 纯一致性哈希（HashRing）+ 误投转发 | 无目录；xxh32 纯 JS 实现 |
| 默认持久化 | `node:sqlite`（InMemory 供测试） | 进程级；零 npm 依赖目标 |
| 共享 PropStore | `PostgresPropStore`（`pg` 为可选 peer 依赖） | M3；节点级持久，多节点生产必需，`TROUPE_PROPSTORE` 选择 |
| 装饰器 | TS 5 stage-3 装饰器 + 静态字段等价物 | 双轨避免 tsconfig 摩擦 |
| dev 热重载 | esbuild 转译 + ESM 版本化重导 | M3.6；构建期依赖，不进运行时 |
| 核心 npm 依赖 | 目标为零 | 构建期依赖与可选 Provider 的 peer 依赖除外 |

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| `node:sqlite` 在低版本 Node 不可用 | engines 锁 >=22.5；必要时出 `better-sqlite3` 可选 Provider |
| 本地 Props 随节点永久丢失 | M3 起提供共享 `PostgresPropStore`（节点级）；DESIGN.md §7.2 明示 SQLite 仅进程级持久，多节点生产必须切换 |
| gossip 脑裂/弱一致边界（分区双活） | 一期 Props `version` 乐观并发保证冲突可检测；二期 fencing token + 仲裁式 Roster（Redis/etcd）升级为可防止 |
| 成员变更漂移期转发正确性 | 转发跳数上限 + M2 专项混沌测试（杀节点、网络延迟注入） |
| stage-3 装饰器与用户构建链兼容性 | 静态字段等价物全程一等公民，文档双示例 |
| 持久 Cue 与 Stage 宕机叠加的触发丢失 | Cue 记录持久化 + 启动时扫描补触发（M3 验收覆盖） |
| swap 热替换被滥用（违反 §9.5 守则的 Actor 换码出错） | `recycle` 为默认；`swap` 仅 opt-in；dev 模式做守则静态检查（实例字段/`#private` 扫描，M3.6），生产部署期再查一遍（M6） |

---

## 6. 开放问题

1. **Agent 命名**：与 "AI agent" 撞词，是否改 `ActorRef`？（影响全部公开 API，M1 动工前定）
2. **CLI 实现**：commander 等库 vs 手写参数解析（命令不多，倾向手写保持零依赖）
3. **Booth 前端栈**：构建期自由（倾向 Vite + React），产物体积预算需定
4. **远程 Call 自动重试**：一期不自动重试，是否在 Agent 上加显式 `retry` 选项（幂等方法标注后）？M4 前评估
5. **热重载转译器**：esbuild vs swc（M3.6 前按转译速度与装饰器兼容实测决定）

---

## 7. 下一步（M1 启动清单）

1. 定 Agent/ActorRef 命名（开放问题 1）
2. 脚手架：package.json（subpath exports、engines）、tsconfig、目录结构
3. `core/`：Actor 基类 + 注册表 + `@Performs`
4. `core/`：Agent Proxy + StageManager + CallBoard 串行调度
5. `testing/`：Rehearsal
6. 最小示例 + 串行性/下场两组验收单测
