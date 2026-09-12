# Troupe.js 设计文档

> 状态：v2 · 2026-09-12（已并入设计审查结论：定稿执行、所有权与持久化语义；交错执行与热更新后移，见 [PLAN.md](./PLAN.md)）
> 本文档是 Troupe.js 的完整设计/架构说明。开发计划见 [PLAN.md](./PLAN.md)。

---

## 1. 概述

### 1.1 定位

Troupe.js 是一个面向 Node.js/TypeScript 的 **Virtual Actor** 框架，思想对标 Microsoft Orleans 与 EA Orbit，但命名、API 与默认值全面围绕"剧团（Troupe）"隐喻重新设计，并以**零配置开箱即用**为一级原则。

### 1.2 Virtual Actor 模型核心语义

- **永远存在**：Actor 无需显式创建，用 `(role, stageName)` 全局寻址
- **按需激活**：第一条 Call 到达时，由运行时在集群某 Stage 上激活（OnStage）；生产集群中激活前置所有权检查（§6.5）
- **自动钝化**：空闲超过 Intermission 后自动下场（OffStage），Props 归还 PropStore
- **位置透明**：调用方持有 Agent（代理），不关心目标在哪个 Stage
- **Turn-based 并发**：每个在场 Actor 一次只处理一条 Call，天然无锁——与 Node 事件循环天然契合。**严格串行是唯一执行模式**；交错执行（`@Improv`/`@ReadOnly`）是后续独立阶段（§5.4）
- **故障即重激活**：Stage 死亡后，下一条 Call 会让 Actor 在健康 Stage 重新登台，Props 从 PropStore 恢复（生产集群须先获得所有权，§6.5）

### 1.3 设计原则

1. **简单优先**：一期全部取最简方案，集群元数据零外部依赖
2. **零配置启动，渐进式披露**：每个旋钮都有默认值，用户只为"偏离默认"付费
3. **剧团隐喻命名**：领域概念一律用剧团词；纯修饰性标记不硬凑（ownership/lease/fencing token/revision 等纯技术概念保留英文原词）
4. **约定优于配置，但错误必须响**：默认值可以猜，错误信息必须明确指出问题
5. **无代码生成**：`Proxy` 动态派发 + TS 类型推导，不需要 Orleans 式 source generator
6. **承诺必须可验证**：每个一致性/可靠性承诺都写明语义、反例与验收场景（见 PLAN.md 横切验收场景表）；做不到的（如无协调集群的强一致）明说不承诺

---

## 2. 命名体系：剧团词典

| 概念 | Troupe 命名 | 剧团含义 |
|---|---|---|
| 集群 | **Troupe** | 整个剧团 |
| 节点/进程 | **Stage** | 舞台 |
| 虚拟 Actor | **Actor** | 演员，永远"存在" |
| Actor 接口契约 | **Role**（`IRole`） | 角色 |
| 代理引用 | **Agent** | 经纪人，知道演员在哪个舞台 |
| 激活 | **OnStage** | 登台 |
| 钝化 | **OffStage** | 下场 |
| 类型注册表 | **Repertoire** | 保留剧目表 |
| 寻址路由 | **Playbill** | 节目单：哪个角色谁在哪个舞台演 |
| 成员管理 | **Roster** | 剧团花名册 |
| 激活决策 | **Casting** | 选角 |
| 消息调度器 | **StageManager** | 舞台监督 |
| 邮箱 | **CallBoard** | 后台公告栏 |
| 消息 | **Call** | 通告 |
| 持久化状态 | **Props** | 道具，登台取、下场还 |
| 存储 Provider | **PropStore** | 道具间 |
| 持久提醒存储 | **CueStore** | 提词存档 |
| 无状态工人 | **Extra** | 群众演员，可互换 |
| 可重入 | **Improv** | 即兴表演，允许被打断 |
| 空闲超时 | **Intermission** | 中场休息，超时自动下场 |
| 定时器/提醒 | **Cue** | 到点触发，不在场先请上台 |
| 观察者 | **Audience** | 观众 |
| 流 | **Show** | 演出，可演可看 |
| 客户端网关 | **BoxOffice** | 售票处，观众持 ticket 进场 |
| 测试集群 | **Rehearsal** | 排练 |
| 管理内省角色 | **Director** | 导演，系统级，掌控全局 |
| Web 管理界面 | **Booth** | 灯光音控室，俯瞰全场 |

Orleans 对照：Grain→Actor、Grain Interface→Role、Grain Reference→Agent、Silo→Stage、Activation→OnStage、Grain Directory→Playbill、Membership→Roster、Placement→Casting、Grain State→Props、Storage Provider→PropStore、Stateless Worker→Extra、Reentrant→Improv、Reminder/Timer→Cue、Observer→Audience、Stream→Show、TestCluster→Rehearsal。

---

## 3. 开发者 API

### 3.1 定义演员

```typescript
import { Actor, Performs, Intermission } from "troupe";

// Props 类型与 actor 同文件，不导出（私有状态形状）
interface CartProps {
  items: Item[];
}

@Performs()                    // 角色名默认 = 类名去 "Actor" 后缀 → "Cart"
@Intermission("10m")           // 可选，默认 5m
export class CartActor extends Actor<CartProps> {
  // 首次登台的初始状态（PropStore 无记录时使用）
  // 默认为 {}——需要结构的 Props（如 items 数组）必须提供工厂
  static initialProps = (): CartProps => ({ items: [] });

  async onStage()  { /* this.props 已就绪：已提交快照或 initialProps() */ }
  async offStage() { await this.saveProps(); }

  async add(item: Item) {
    this.props.items.push(item);
    await this.saveProps();    // 持久成功：提交成功后才返回（语义见 §7.3）
  }

  async peek() { return this.props.items.length; }
}
```

**装饰器以外的等价物**（避免 tsconfig 摩擦，二选一）：

```typescript
export class CartActor extends Actor<CartProps> {
  static role = "Cart";
  static intermission = "10m";
  static initialProps = (): CartProps => ({ items: [] });
}
```

注意：静态字段本身**没有注册副作用**——无装饰器的类必须经 `Troupe.form({ actors: [...] })` 显式入表（见 §3.2）。

其余修饰：

| 修饰 | 语义 |
|---|---|
| `@Extra({ perStage: 4 })` | 群众演员：每 Stage 池化多实例、无固定身份，用于扇出计算 |
| `@Improv` | 可重入：`await` 点允许下一条 Call 插入。语义与交付阶段见 §5.4——M1 起标注了也按严格串行执行并告警 |
| `@ReadOnly` | 只读方法（不改 Props），可与其它读操作交错（§5.4） |
| `@Intermission("10m")` | 空闲超时自动下场 |

### 3.2 组团与选角

```typescript
import { Troupe } from "troupe";
import { CartActor } from "./actors";

// 显式注册（推荐）：无全局副作用，每个 Troupe 一份注册表快照
const troupe = await Troupe.form({ actors: [CartActor /*, … */] });

const cart = troupe.cast(CartActor, userId);  // 传类引用，返回 Agent<CartActor>
await cart.add(item);                         // 方法签名编译期检查
```

- `cast(ClassRef, stageName)` 是默认路径，类型自动推导，零字符串；`cast("Cart", stageName)` 字符串形式保留为逃生舱（跨语言/契约先行场景）
- **注册双轨**：`form({ actors })` 显式注册优先；`@Performs` 装饰器在类定义时写入进程级默认注册表，`form()` 不传 `actors` 时取该注册表**快照**——装饰器是便利语法，不是唯一入口；同进程多个 Troupe（测试场景）互不污染
- 集群 join 校验各 Stage 的**角色集合与协议版本**：Call 被路由到未加载该角色的 Stage 时显式报错，不静默
- Agent 是 `Proxy`，**类型面只暴露 RPC 方法**：Props、生命周期钩子（`onStage`/`offStage`）、运行时成员（`saveProps` 等）对调用方不可见；所有方法统一返回 Promise；Proxy 对 `then`/`Symbol`/调试访问安全（不被误当 Promise、不误发 RPC）。编译期类型过滤不是安全边界——接收端方法白名单见 §6.1
- **Actor 互调**（§10.1）：Actor 内部同样可获取其它角色的 Agent——`this.cast(OtherActor, stageName)`（protected，经当前 Troupe 的 Repertoire 校验）；M1 为进程内直连，M2 起经 Playbill 路由
- **身份与命名空间**：存储键为 `(namespace, roleId, stageName)`。roleId 默认由类名派生（原型便利），但类重命名/构建产物改名会让旧状态无法寻址——持久业务应声明稳定 `static roleId = "cart"`；namespace 默认取应用名，避免多环境共用后端时串数据

### 3.3 Cue（定时器）与持久提醒

两类机制，边界明确：

```typescript
async onStage() {
  // 内存 Cue：随实例下场消失，仅在场期间有效（闭包回调即可）
  this.registerCue("flush", "2s", () => this.flush());

  // 持久提醒：写入 CueStore，下场后仍触发，触发即重新登台（M4）
  // 不持久化闭包——以稳定名称 + 可序列化负载记录，经 onCue(name, payload) 分派
  await this.scheduleReminder("daily-report", { cron: "0 9 * * *", payload: { kind: "daily" } });
}

async onCue(name: string, payload: unknown) {   // 持久提醒的稳定入口
  if (name === "daily-report") await this.report(payload);
}
```

- 持久提醒的执行模型：到期 → CueStore 查询/认领（§7.5）→（不在场则）重新登台 → 以 `onCue(name, payload)` 作为一条 Call 进入 CallBoard，**受同一调度约束**（§5.2）
- 投递语义（至少一次 + 幂等）、错过周期策略、注销竞争：见 §7.5

### 3.4 HTTP 接入

```typescript
import { createEdge } from "troupe/edge";

const app = new Hono();
app.route("/", createEdge(troupe));   // 白送 /healthz、/metrics、优雅停机联动
app.post("/drops/:skuId/orders", async (c) => { /* 鉴权 → 校验 → cast → 调用 */ });
serve({ fetch: app.fetch, port: 8080 });
```

鉴权与校验住在 Edge；TCP 业务信封不得绕过这层校验（信任边界见 §6.1）。

---

## 4. 架构总览

```
┌──────────────────────────────────────────────┐
│ Application（Actor 定义、edge 路由、业务调用） │
├──────────────────────────────────────────────┤
│ Runtime Core                                  │
│  · Repertoire     类型注册表（显式/装饰器注册） │
│  · StageManager   每 Actor 的 CallBoard 调度   │
│  · 生命周期        OnStage/OffStage 状态机 + Intermission GC │
│  · Agent Factory  cast() → typed Proxy         │
├──────────────────────────────────────────────┤
│ Cluster Services                              │
│  · Roster         成员管理（gossip 传播 + 直接探测）│
│  · Playbill       寻址路由（HashRing 候选 + 所有权确认）│
│  · Casting        激活策略                     │
├─────────────────────────────┬────────────────┤
│ Transport                   │ Director       │
│  TCP + 长度前缀 + JSON       │  系统内省角色   │
├─────────────────────────────┴────────────────┤
│ Providers（PropStore / CueStore / Show …）    │
└──────────────────────────────────────────────┘
        工具链：troupe CLI、Booth（均为 Director 瘦客户端）
```

**进程模型**：一个 Node 进程 = 一个 Stage。多核扩展就跑多个进程；worker_threads 不进一期。

---

## 5. 运行时设计（Stage 内部）

### 5.1 执行模型

```
Call 到达（本地 Agent 或远程 TCP）
  │
  ▼
Playbill (HashRing) ── 不归我 ──▶ 按当前环视图转发给归属 Stage（跳数上限 2）
  │ 归我（或我是 Extra 池目标）
  ▼
该 (role, stageName) 在场？
  ├─ 否 → OnStage：所有权检查（生产集群，§6.5）→ new Actor
  │        → PropStore 取 Props（或 initialProps()）→ onStage() → 挂 Intermission 计时
  ▼
deadline 检查：排队中已过期的 Call 不开始执行，直接返回超时拒绝
  ▼
StageManager 把 Call 投入该 Actor 的 CallBoard（FIFO）
  ▼
按 Turn 执行（严格串行）：上一 Turn 的 promise settle 前不取下一 Call
  · 超时/异常 → 封装为错误响应沿调用链返回（执行占用的释放见下）
  ▼
空闲超过 Intermission → 排空 → offStage() → saveProps → 从在场表移除
```

**响应期限与执行占用分离**（核心契约）：

- **排队过期**：deadline 已到的排队 Call 不开始执行——未产生任何副作用，可安全拒绝
- **执行中过期**：可向调用方返回超时，但该 Actor 的**独占执行资格保持到原执行 settle**——不能因调用方放弃而放行下一条 Call 与未结束的旧任务交错修改 Props
- **协作取消**：Call 可携带取消信号（注入方法的可选上下文参数），用户代码自愿检查；框架**不提供**对任意用户代码的强制中断
- **永久挂起任务**的恢复只能靠进程隔离：Stage 重启、实例失效与所有权保护（§6.5）——向调用方抛超时错误救不回已卡死的执行

### 5.2 生命周期状态机

| 状态 | 含义 | 转移 |
|---|---|---|
| 未激活 | 无实例 | → 激活中（首条 Call / 持久提醒到期） |
| 激活中 | 加载 Props、执行 onStage | → 运行中；→ 失效（加载或 onStage 抛错） |
| 运行中 | 在场服务 CallBoard | → 排空中（Intermission 到期 / 管理下场 / 失去所有权） |
| 排空中 | 等待在执行 Turn 与框架回调结束 | → 未激活（保存成功）；→ 失效（保存失败/冲突） |
| 失效 | 不再接受调度，等待移除 | → 未激活（下次调用重新加载） |

- **激活 single-flight**：第一次并发调用共享同一个激活 Promise，只激活一次
- **排空期间新请求**：等待排空完成后重新激活，或在明确配置下直接拒绝——不能静默丢弃
- 生命周期钩子、Cue、管理操作（`inspect`/`off`/`invoke`）都经调度约束，**不旁路串行规则**
- `quiesce()` 等待**所有**运行中请求与框架回调（保存、Cue）结束——不是只等"当前 turn"（交错执行启用后尤其如此）

### 5.3 背压与资源保护

- CallBoard 深度上限（默认 1024/Actor，可配）只保护**单个热点 Actor**
- **全局预算**（每 Stage）：激活数上限、总排队字节数、in-flight RPC 上限、连接写缓冲上限、Trace 字节预算；超限拒绝并显式报错
- 调度器周期性让出事件循环（每 N 个 Turn / 每 X ms），防止大参数或热点 Actor 饿死心跳与 IO
- 每个 Actor 元数据入注册表：登台时间、最后调用、CallBoard 深度、Props 字节数（Director/CLI/Booth 数据源）
- **容量事实**：单个热点 Actor 只有一个串行执行通道，增加 Stage 只能分摊**不同** Actor 的负载；压测必须覆盖热点倾斜场景（PLAN M8）

### 5.4 超时、死锁与交错

- 所有 Call 带 deadline（默认 30s，可按方法覆盖），跨 Stage 传播；语义见 §5.1（排队过期不执行；执行中过期不放行）
- 环状等待靠超时打破；文档引导拆分调用或使用交错（见下）
- **交错执行（`@Improv`/`@ReadOnly`）为后续独立阶段（PLAN M5）**：M1 起标注了这两个装饰器的方法一律按严格串行执行并输出告警。语义预定义：
  - **允许组合**：`@ReadOnly`×`@ReadOnly` 可交错；`@Improv` 可在 await 点与任意标注方法交错；未标注方法与任何调用不交错
  - **写饥饿防护**：写调用入队后，新到的 `@ReadOnly` 排到其后（读占比上限可配）
  - JS 单线程**不提供**跨 await 的业务原子性：交错窗口内其它调用可见 Props 中间态，文档必须明示

---

## 6. 集群设计

### 6.1 传输协议

- Node `net` 模块自建 TCP，4 字节小端长度前缀 + JSON payload
- **单机默认绑定 loopback（`127.0.0.1`）**；开放监听是集群模式的显式行为（§8.2 部署模式）
- 信封（Call）：

```json
{ "v": 1, "callId": "ulid", "from": "stageAddr",
  "to": { "role": "Cart", "stageName": "user-123" },
  "method": "add", "args": [ ... ], "deadline": 1726051200000 }
```

- 响应错误**分类**（不是单一 error 结构）：
  - **业务异常**：用户方法 throw（`{ ok: false, error: { name, message } }`）
  - **请求拒绝**：校验失败、背压超限、白名单外方法
  - **执行结果未知**：超时、连接断开——调用方不得假定失败（§6.5）
  - **存储冲突**：CAS 失败（`ConflictError`）
  - `stack` 默认只进内部诊断通道，不回传普通调用方
- 序列化经 `Codec` 接口（默认 JSON），MessagePack 后续以插件进入。**Codec 边界约定**：Date→ISO 字符串；BigInt、Map/Set、循环引用、Agent 引用默认抛错并指引改用可序列化 DTO；undefined 字段按 JSON 语义丢失——文档明示
- **本地调用走同一编解码/复制边界**：本地、远程、Rehearsal 三种模式数据行为一致，测试不掩盖部署差异；`form({ localCallByReference: true })` 可显式关闭复制换性能（语义分叉自担）

**信任边界（集群模式部署前提，进入跨节点部署前必须实现）**：

- 部署前提写成要求：受控网络隔离，或传输层保护 + 节点加入验证（clusterId + join 凭证）
- **接收端始终校验信封与参数**：方法必须在角色的方法白名单内——生命周期钩子（`onStage`/`offStage`）、基类成员（`saveProps` 等）、构造器与内部管理入口**不可经普通 RPC 调用**；不按任意字符串访问实例属性。Edge 的鉴权不能被 TCP 信封绕过
- **解码前限制**：最大帧长度、每连接缓冲上限、未完成请求数上限
- 管理操作（Director 跨 Stage 扇出）在首个入口鉴权后，扇出携带**已验证的权限上下文**

### 6.2 Roster（成员管理）

传播与探测分离，非完整 SWIM：

**状态传播（反熵 gossip）**：周期与随机已知 Stage 交换 Roster 摘要合并。合并规则单调：成员记录带 incarnation 与状态，仅接受 incarnation 更大、或同 incarnation 下状态优先级更高（alive > suspect > dead）的记录——反复转发的旧 alive 状态不能复活已确认死亡的 incarnation。

**故障探测（直接探测）**：每 Stage 周期向探测目标（环序相邻的 k 个）发 ping 并**等待 ACK**；超时进入 suspect（可经间接探测确认）；suspect 超时未被反驳 → confirmed dead → 摘环并广播。节点重启以**新 incarnation** 加入（新身份），旧 incarnation 的消息一律过期。死亡记录保留一个期限后才允许同地址新身份复用。

**部署模式**：

- `dev`：保留便利默认（端口被占自动换、seeds 不可达时明确提示后自成一团）
- `production`：固定端口、显式 advertiseAddress、必须成功入团（`--require-cluster` 语义并入模式）、入团校验角色集合/协议版本/共享 PropStore 连通性

一期自建协议不承诺完整 SWIM 语义；生产一致性依赖共享存储的所有权机制（§6.5）而非探测协议本身。Redis/etcd 仲裁式 Roster 为后续可选 Provider。

### 6.3 Playbill（寻址路由）

- **纯一致性哈希，无目录**：`xxh32(namespace + ":" + roleId + ":" + stageName)` → HashRing（每 Stage 160 虚拟节点）→ 归属 Stage
- 参考实现：`hashring/hash_ring.rb`（移植为 TS，xxhash 用纯 JS 实现，不引入原生依赖）
- 成员变更漂移期：收到不属于自己（按当前环视图）的 Call → **转发**给正确归属；转发跳数上限 2，防环
- 无注册、无目录查询、无缓存失效——这是"简单"的最大红利
- **HashRing 只回答"候选归谁"**；是否真正拥有该 Actor 由所有权契约（§6.5）决定。所有权是按需惰性创建的记录，不是全量目录——红利不因此消失

### 6.4 Casting（激活策略）

- 一期仅 **HashCasting**（由 Playbill 直接决定），外加 **Extra**（每 Stage 本地池化）
- `PreferLocal`/`Random`/负载感知 Casting 依赖目录式 Playbill，二期解锁。补所有权协议**不需要**同时实现任意放置策略和完整目录

### 6.5 所有权与故障恢复

**所有权契约（生产集群，依赖共享 PropStore）**

- 所有权记录：`(namespace, roleId, stageName) → { ownerId, epoch, leaseUntil }`，存于共享存储，epoch 为单调递增的 fencing token
- **激活前置**：CAS 取得所有权（新 epoch > 旧）→ 才 OnStage；取不到就等待或让位
- **失去所有权**（租约到期被顶替）：立即停止接单与新 Cue → 排空在执行调用 → 以当前 epoch 保存（存储拒绝旧 epoch 写入）→ 释放/失效
- **正常扩容交接** = 上述流程的有序版：新 Stage 取得所有权后，旧实例的后续保存会被 fencing 拒绝，旧实例据此失效；交接包含旧实例排空、落盘、释放三步
- **fencing 的局限**：租约挡不住"暂停后恢复的旧代码"继续产生外部副作用——HTTP/消息等接收方需校验 token，或使用持久化 outbox + 业务幂等；框架提供 token 传递，不替业务消灭副作用

**无协调服务模式（一期默认，实验性定位）**

单机与无共享存储的集群定位为**允许重复激活的实验性集群**：分区/扩缩容期间同一 Actor 可能双活；Props revision CAS 使冲突写入可检测（防静默丢更新），不提供合并，也**不对强一致业务做无条件保证**。强一致场景（库存、配额）必须部署共享 PropStore 并启用所有权。Redis/etcd 仲裁式 Roster 为后续可选 Provider。

**调用结果未知与幂等恢复**

超时、连接重置只说明**结果未知**，不等于失败：

- Agent 不自动重试（避免非幂等重复执行；显式 `retry` 选项后续评估）
- 需要安全重试的业务：操作键（requestId）+ **参数指纹** + 原始结果随 Props **原子提交**；重放同键同参数返回原结果；同键不同参数拒绝；记录保留期限明确（默认 7 天，可配，Cue 清理）
- 跨 Actor 流程（如订单创建 + 库存扣减）需业务补偿或 outbox——单 Actor 串行不能推导跨 Actor 事务

**持久级别与恢复范围**

- Stage 死亡 → Roster 标记 → 环上摘除 → 后续 Call 由新归属 Stage 在所有权确认后重新激活
- Props 恢复范围取决于 PropStore 持久级别（§7.2）：共享存储任一 Stage 可恢复；本地 SQLite 仅同机进程重启可恢复。持久成功语义（§7.3）下已确认的操作不丢；攒批模式明示丢失窗口（RPO = flush 间隔）

---

## 7. 持久化设计

### 7.1 Props 模型

- `Actor<TProps>` 泛型基类；`onStage` 前自动读入 `this.props`：已提交快照，或首次登台取 `static initialProps()` 工厂（默认 `{}`——需要结构的 Props 必须提供工厂，否则 `items.push` 这类操作会当场抛错）
- 显式写：`await this.saveProps()`——语义清晰，无隐式拦截魔法
- JSON 可解析 ≠ 满足 TypeScript 接口：结构演进由 schemaVersion 主动驱动（§7.4），并提供运行时验证入口（`validateProps` 钩子，可挂 Zod）
- 存储键：`(namespace, roleId, stageName)`；roleId 默认类名派生，持久业务应声明稳定 roleId（§3.2）

### 7.2 PropStore 接口与实现

并发修订号（revision：每次成功写入 +1）与结构版本（schemaVersion：状态形状演进时 +1）是**两个维度**；所有权 fencing token 是第三个维度（§6.5）。

```typescript
interface StoredProps {
  props: unknown;
  revision: number;        // 并发修订号，CAS 用
  schemaVersion: number;   // 结构版本，migrateProps 用
}

interface PropStore {
  read(namespace: string, roleId: string, stageName: string): Promise<StoredProps | null>;
  create(namespace: string, roleId: string, stageName: string,
         props: unknown, schemaVersion: number): Promise<StoredProps>;  // 仅当不存在时成功（原子）
  write(namespace: string, roleId: string, stageName: string,
        props: unknown, opts: {
          expectedRevision: number;   // CAS：仅当当前 revision 相等才写入
          schemaVersion: number;
          fencingToken?: number;      // Provider 可选校验：拒绝旧 token
        }): Promise<StoredProps>;     // 返回新 revision；冲突抛 ConflictError
  delete?(namespace: string, roleId: string, stageName: string): Promise<void>;
}
```

**Provider 合同**：`create`/`write` 必须原子（如单条 `UPDATE … WHERE revision = ?`）；写结果不确定（网络超时）时，调用方以 `read` 校验实际 revision 后决定，不盲目重写。

| 实现 | 持久级别 | 用途 |
|---|---|---|
| `InMemoryPropStore` | 无 | Rehearsal / 测试（M1） |
| `SqlitePropStore`（`node:sqlite`，零 npm 依赖） | 进程级 | 默认，存 `./.troupe/props.db`，首次用到才建库建表（M2） |
| `PostgresPropStore`（可选 peer 依赖 `pg`） | 节点级 | M3 交付；多节点生产必需，承载所有权记录与 fencing |
| `RedisPropStore` / Mongo 等 | 节点级 | M3 后按需补充 |

**持久级别的界限（重要）**：

- **进程级**（本地 SQLite）：担保进程崩溃/重启后恢复；**不担保**节点丢失（整机/磁盘损毁）与扩缩容再平衡——Props 在原 Stage 磁盘上跟不过去，Actor 会在新节点以空 Props 登台。适用单机部署、dev、可丢弃状态
- **节点级**（共享 Postgres/Redis）：Props 与 Stage 解耦，任意 Stage 都可让 Actor 重新登台恢复——多节点生产、无痛扩缩容与所有权机制的前提。经 `TROUPE_PROPSTORE=postgres://…` 一键切换，无需改代码
- SQLite 注意：`DatabaseSync` 同步执行，Promise 包装不能消除主线程阻塞——磁盘写入对 Stage 延迟与心跳的影响必须测量（PLAN M2）

### 7.3 写策略与失败语义

**成功语义二选一，业务层必须显式选择**：

- **持久成功**（默认语义；库存/订单类必选）：`saveProps()` 原子提交（业务变更 + 幂等记录）成功后**才**返回业务成功——响应即已落盘
- **攒批 + 丢失窗口**：响应先返回、周期/阈值 flush；此时必须承认 RPO = flush 间隔的丢失窗口，并在接口与文档标注。要兼顾吞吐用 **group commit**：一批请求共同等待同一次持久化完成，全部一起成功/失败——不允许"先各自返回成功、后统一刷盘"
- 性能宣传在两种语义下分别测量（PLAN M8）

**失败处理**（保存时内存 Props 已被业务修改）：

- 保存失败/CAS 冲突：默认**实例失效**——从在场表移除，下次调用重新加载最后已提交快照；显式 opt-in 才用"恢复上次已提交快照继续跑"策略
- 排空/offStage 期间的保存冲突（旧实例）：**不得无条件重写**，失效让位给新所有者（§6.5）
- 保存结果未知：`read` 校验实际 revision 后决定

### 7.4 演进与迁移

- schemaVersion 驱动：读出的 schemaVersion < 类声明版本 → 逐级调用 `migrateProps(stored, fromVersion)`；迁移失败明确报错（角色名 + stageName + schemaVersion），实例进失效，不得以半迁移状态服务
- 用户可挂 `validateProps` 运行时验证（推荐 Zod）：JSON 解析成功不代表满足 TS 接口

### 7.5 CueStore（持久提醒）

记录：`{ namespace, roleId, stageName, name, payload(可序列化), schedule(cron/interval), timezone, nextDue, statusVersion }`

```typescript
interface CueStore {
  due(now: number, limit: number): Promise<ReminderRecord[]>;                       // 到期查询
  claim(id: string, opts: { owner: string; leaseUntil: number }): Promise<boolean>;  // 原子认领
  complete(id: string, opts: { expectedStatusVersion: number; nextDue: number }): Promise<void>;
  cancel(namespace: string, roleId: string, stageName: string, name: string): Promise<void>;
}
```

**投递语义（显式选择并文档化，不承诺恰好一次）**：

- **至少一次投递 + 业务幂等**：执行中宕机 → 租约到期后被重新认领、重复投递；不能仅凭"持久化记录 + 启动扫描"承诺执行恰好一次
- 错过多个周期：默认跳过并立即补发一次（可按提醒配置为合并补发）
- 注销竞争：下场/删除与到期触发并发时，以 statusVersion CAS 裁决
- Actor 已下场或集群重启时，框架在激活之前经 `due()` 发现提醒，并在多个 Stage 间以 `claim()` 分配执行责任
- 参照：Orleans Reminders 区分持久定义与单次触发并明确错过行为；Troupe 选择"持久定义 + 至少一次"，错过策略如上

---

## 8. 零配置设计

### 8.1 优先级链

```
显式传参  >  环境变量  >  约定默认值
```

### 8.2 默认值表

| 旋钮 | 默认值 | 环境变量 |
|---|---|---|
| 部署模式 | `dev`（便利默认）；`production`：固定端口、必须 advertiseAddress、必须成功入团、校验共享存储与角色集合 | `TROUPE_MODE` |
| Stage 监听 | dev：`127.0.0.1:7300`，被占自动换空闲端口并日志提示（仅 dev）；production：监听 `0.0.0.0` + 显式 advertiseAddress | `TROUPE_HOST` / `TROUPE_PORT` / `TROUPE_ADVERTISE` |
| seeds | 空 = 自成一团（单机开发默认） | `TROUPE_SEEDS`（逗号分隔） |
| Repertoire | `form({ actors })` 显式优先；`@Performs` 进程级默认注册表为便利（每 Troupe 快照） | — |
| 角色名 | 类名去 `Actor` 后缀（原型便利）；持久业务建议显式 `static roleId` | — |
| 存储命名空间 | 应用名（多环境共用后端不串数据） | `TROUPE_NAMESPACE` |
| PropStore | `SqlitePropStore`，`./.troupe/props.db`；生产经连接串切共享实现（§7.2） | `TROUPE_PROPS_DIR` / `TROUPE_PROPSTORE` |
| 本地调用 | 经 Codec 复制边界（本地/远程/Rehearsal 一致）；`localCallByReference` 显式关闭 | — |
| 幂等记录保留 | 7 天（业务可调，Cue 清理） | — |
| `NODE_ENV=test` | 全部自动 InMemory = Rehearsal 模式 | — |
| Intermission | 5 分钟 | — |
| 序列化 | JSON | — |
| Cue tick | 1s | — |
| Call 超时 | 30s | — |
| 优雅停机 | SIGTERM/SIGINT 自动：拒收新 Call → 排干 CallBoard → 全员 offStage+saveProps → 退出 Roster；宽限 10s | `TROUPE_SHUTDOWN_GRACE` |
| Director 访问 | 仅 loopback；远程需 token（扇出携带权限上下文） | `TROUPE_ADMIN_TOKEN` |
| Node 最低版本 | 22.13（`node:sqlite` 于 22.x 在 22.13 起无需 flag；启动检查，不满足明确报错） | — |

### 8.3 注册

推荐显式：`Troupe.form({ actors: [CartActor, …] })`——每个 Troupe 持有自己的注册表快照，同进程多实例（测试）互不污染。`@Performs` 装饰器在类定义时写入进程级默认注册表，`form()` 不传 `actors` 时取快照——装饰器是便利语法，不是唯一入口（静态字段等价物没有注册副作用）。项目布局仍用 `actors/index.ts` barrel 收口 import。

### 8.4 集群零配置阶梯

```
单机开发   Troupe.form()                                  → 自成一团（loopback）
双机互联   TROUPE_SEEDS=node1:7300 启动第二台              → 自动入团（dev 模式）
生产部署   TROUPE_MODE=production + 编排注入 TROUPE_SEEDS  → 固定端口/advertiseAddress/必须入团/共享 PropStore/角色与协议版本校验
LAN 自动发现（mDNS）                                       → 二期可选
```

### 8.5 显式报错（不做魔法的清单）

- 角色名冲突 → 启动 fail fast，指出两个文件路径
- `cast()` 未注册的 Actor → 报错并列出当前 Repertoire
- Props 反序列化/迁移失败 → 报角色 + stageName + schemaVersion，提示迁移钩子
- seeds 全连不上 → dev 明确提示"自成一团"还是"配置有误"；production 直接启动失败
- 调用超时/断连 → 错误明确标注**结果未知**，指引按幂等键重试而非假定失败（§6.5）
- 白名单外方法/非法信封 → 请求拒绝类错误（§6.1），不触碰实例

---

## 9. 热更新设计

### 9.1 架构前提：为什么 Troupe 有条件做热更新

四个既有设计使热更新成为增量能力而非重构：

1. **生命周期静止点**：OffStage 时 Props 已落盘——"换代码"可退化为"下场 + 用新类重新登台"。这是兜底路径，但**不是无条件绝对安全**：前提是排空成功、Props 兼容、钩子成功，且用户自起的异步任务/事件监听器/保存到其它模块的闭包已自行了结——框架暂停 CallBoard 不会替用户回收这些
2. **Props 外置**：状态可序列化且由框架托管，Actor 实例约等于"代码 + 框架持有的状态"的壳
3. **Turn 边界**：turn 之间无用户代码执行，StageManager 天然掌握安全换码点，无需抢占式中断
4. **JS 原型机制**（独有红利）：方法在原型上动态查找，`Object.setPrototypeOf` 可在两次 turn 之间替换活体实例的整个方法表，实例与内存状态原封不动——CLR/JVM 不具备此能力，Orleans/Orbit 只有滚动重启一档

### 9.2 能力分层

| 层级 | 名称 | 说明 | 落地阶段 |
|---|---|---|---|
| L0 | 滚动重启 | 优雅停机 + 所有权交接（§6.5）+ 按需重激活，逐台替换 Stage | M2 即具备（生产语义在 M3 补齐） |
| L1 | 开发态热重载 | `troupe dev`：文件变更 → 转译重导 → 按策略处理在场 Actor | M10 |
| L2 | 生产原地热替换 | swap 机制 + 版本签名模块包下发，紧急修复免滚动；**独立实验，非核心框架前置** | M11 |
| L3 | 版本化滚动升级 | 混跑兼容规则 + version-aware Casting | 兼容规范在第一个生产集群版本前成文（M3）；Casting 依赖目录式 Playbill，二期 |

### 9.3 L1：开发态热重载

`troupe dev` 监听源文件 → esbuild/swc 转译 → ESM 版本化重导（import specifier 携带版本查询串，依赖子图传递失效）→ 注册表 `codeVersion` 升级 → 按 role 策略处理在场 Actor：

| 策略 | 行为 | 适用 |
|---|---|---|
| `recycle`（默认） | 在场 Actor 走正常 offStage（saveProps），下次 Call 用新类登台。任意代码的**兜底路径**，前提见 §9.1；dev 下亦可直接重启进程，属同级可靠手段 | 任意代码 |
| `swap`（opt-in） | quiesce → `setPrototypeOf` 换方法表 → 继续服务，实例与内存状态保留 | 遵守 §9.5 守则的 Actor |
| `keep` | 旧实例运行到自然下场，仅新激活用新代码 | 进行中的会话类 Actor（房间等） |

ESM 版本化重导的边界：import 查询串能产生新的模块实例，但不等于完整的可回收热加载方案——还需要**稳定的运行时单例**（框架对象不随用户模块重载）、旧依赖子图与外部资源（定时器、监听器、连接）的释放、以及反复重载的内存驻留测量。这三项是 `troupe dev` 的交付验收内容。

Edge 层：HTTP handler 外包一层间接引用（`fetch: (req) => currentApp.fetch(req)`），路由模块重载后原子切换，连接不断。

### 9.4 L2/L3：生产热替换与版本兼容

- **L2（后期独立实验）**：新版 Actor 类经带版本签名的模块包下发（`troupe deploy --hot <pkg>`），Roster 广播 `codeVersion`，各 Stage 在 turn 边界完成换码。机制与 L1 swap 完全复用，仅适用于紧急修复；前提是 L0 滚动重启路径已可靠，**不作为核心框架的前置交付压力**
- **L3 混跑兼容规则**（规范本体在第一个生产集群版本前成文，先于任何混跑部署）：
  - 方法只增不减（一个兼容窗口期内）
  - 参数只加可选项，不改已有语义
  - Props 结构变更必须 `schemaVersion+1` 且提供 `migrateProps`
  - Cue/Show 消息格式同理
  - 二期 version-aware Casting：新激活落到新版本 Stage，旧版本在场 Actor 自然耗尽后退役（对标 Orleans grain versioning）
- 方法/参数 diff 只能验证结构兼容，无法验证业务语义兼容——部署期静态检查是必要条件，不是充分条件

### 9.5 swap 用户代码守则

L2 级热替换要求 Actor 代码遵守以下规则（`recycle` 策略不受限制，故为默认；`swap` 是显式声明遵守守则后的优化）：

1. **状态全在 props**：实例字段不存业务状态（新类字段初始化器不会重跑，旧实例上为 `undefined`）
2. **禁用 `#private`**：私有字段/方法按词法作用域绑定，新模块副本的方法访问不到旧实例私有槽；原型上的普通方法无此问题
3. **模块级可变单例在 `onCodeSwap()` 钩子中重建**（对标 OTP `code_change`）
4. **不捕获旧闭包**：Cue 回调与 Show 订阅由框架在换码时用新版本重新注册
5. **实例形态固定**：不用实例箭头函数属性、不预 `bind` 方法、不依赖装饰器生成的包装函数身份、继承链稳定——swap 只替换原型方法表
6. **构造器无副作用**：新类构造器不承担资源分配（资源进 `onStage`/`onCodeSwap`）
7. **失败即回滚**：`onCodeSwap` 抛错或换码失败 → 恢复旧原型、`codeVersion` 不变；若新 schema 已写入，`migrateProps` 必须能以 schemaVersion 判断并提供降级路径，否则禁止自动回滚、提示走重启

### 9.6 对运行时的增量需求

全部为新增、不改既有设计：

- 注册表与 Actor 元数据携带 `codeVersion`（Director/CLI/Booth 可见"谁在跑旧码"）
- StageManager `quiesce()`：等待所有运行中请求与框架回调结束、暂停取新 Call（与优雅停机复用同一机制，§5.2）
- `Actor` 基类可选钩子 `onCodeSwap()`
- dev 模块重载管线（esbuild + 版本化 import，或基于 vite-node module runner）
- CLI：`ps` 增加代码版本列；`troupe deploy --hot <pkg>`（L2）

---

## 10. HTTP 应用模式

### 10.1 分层形态

```
 LB ──▶ Stage A (HTTP + Troupe)   Stage B   Stage C
              └────── Playbill 路由（Actor 互调）──────┘
                            │
                      PropStore (SQLite/…)
```

- 每个 Stage 内嵌同一 HTTP 服务；任意节点接任意请求（位置透明），前置任意 LB，无 sticky session
- Edge handler 只做三件事：**鉴权、参数校验、URL 实体 ID → `(role, stageName)` 映射**
- 业务规则（限购、扣减）只住在 Actor 里

### 10.2 三问方法论

1. URL 里有明确实体 ID？ → 有 stageName
2. 该实体上的操作需要严格串行/强一致？ → 是 Actor
3. 状态热吗？ → 热，内存收益巨大

三问皆是：房间、协同会话、设备影子、限流配额、购物车/订单流。反之无状态 CRUD、多表 join、报表 → Edge 直接查 DB（CQRS 味：一期 flush 时双写业务表，二期 Show 流出建读模型）。

### 10.3 参考示例：限量发售（秒杀）

```typescript
@Performs()
@Intermission("5m")
export class InventoryActor extends Actor<InventoryProps> {
  static initialProps = (): InventoryProps => ({ remaining: 0, reservedBy: {}, dirtyOps: 0 });

  async onStage() {
    this.registerCue("flush", "2s", () => this.flush());     // 攒批冲刷（可选模式，见下）
    this.registerCue("gc", "1h", () => this.gcReserved());   // 幂等记录保留期限清理
  }

  async reserve(requestId: string, qty: number) {
    const seen = this.props.reservedBy[requestId];
    if (seen !== undefined) {
      if (seen !== qty) throw new Error(`requestId=${requestId} 已用于不同参数`); // 同键不同参数拒绝
      return { ok: true, remaining: this.props.remaining };                       // 幂等重放
    }
    if (this.props.remaining < qty)
      return { ok: false, remaining: this.props.remaining };
    this.props.remaining -= qty;
    this.props.reservedBy[requestId] = qty;
    await this.saveProps();   // 持久成功：库存变更 + 幂等记录原子提交后才返回成功
    return { ok: true, remaining: this.props.remaining };
  }

  async available() { return this.props.remaining; }

  // 攒批模式（可选，吞吐优先）：接受 RPO = flush 间隔的丢失窗口并显式标注，
  // 或改用 group commit——一批 reserve 共同等待一次持久化完成，绝不"先成功后刷盘"
  private async flush() {
    if (!this.props.dirtyOps) return;
    await this.saveProps();
    this.props.dirtyOps = 0;
  }

  private async gcReserved() { /* 删除超过保留期限（默认 7 天）的 requestId 记录 */ }
}
```

价值对比：热点 SKU 扣减从"DB 行锁 / Redis Lua"变为"单 Actor 串行内存操作"；库存读零 IO；SKU 按环分片天然水平扩展。宕机恢复语义：**持久成功模式下已确认的扣减不丢**（响应前已原子提交），重试靠 requestId + 参数指纹幂等去重；跨 Actor 的"订单创建 + 库存扣减"需业务补偿或 outbox——单 Actor 串行不能推导跨 Actor 事务。

---

## 11. 调试与管理

### 11.1 Director 系统角色

每个 Stage 自动注册的系统 Actor（不在用户 Repertoire，无 Props/Intermission，不可 cast）。**CLI 与 Booth 都是它的瘦客户端**，集群级查询由它向其他 Stage 的 Director 扇出聚合（扇出携带已验证的权限上下文，§6.1），客户端永远只连一个点。

```typescript
interface IDirector extends IRole {
  roster(): Promise<StageInfo[]>;
  actors(filter?: ActorFilter): Promise<ActorInfo[]>;
  inspect(role: string, stageName: string): Promise<ActorDetail>;  // 含 Props 快照
  invoke(role: string, stageName: string, method: string, args: unknown[]): Promise<unknown>;
  cues(): Promise<CueInfo[]>;
  off(role: string, stageName: string): Promise<void>;
  ring(): Promise<RingInfo>;
  subscribeTrace(filter?: TraceFilter): AsyncIterator<TraceEvent>;
}
```

安全：默认仅响应 loopback；远程访问要求 `TROUPE_ADMIN_TOKEN`（dev 启动时自动生成并打印）。Director 的管理操作同样受 Actor 调度约束（§5.2），不旁路串行规则。

### 11.2 CLI：`troupe`

`npx troupe <cmd>`；连接：`--to host:port` / `TROUPE_ADMIN` / 默认 `localhost:7300`。列表命令支持 `--json`、`--watch`。

| 命令 | 作用 |
|---|---|
| `status` | 集群总览：Stage 数、在场演员数、calls/s、环健康度 |
| `roster` | Stage 列表：地址、启动时间、演员数、心跳 |
| `ps [--role R] [--stage S]` | 在场演员：角色、stageName、Stage、空闲、CallBoard 深度、Props 大小、代码版本 |
| `inspect <role> <stageName>` | 详情：Props JSON、CallBoard、Cue、Intermission 倒计时、最近调用 |
| `call <role> <stageName> <method> [args-json]` | 命令行直接调用演员方法 |
| `tail [--role R] [--method M]` | 实时调用事件流（分布式 tail -f） |
| `top` | 动态刷新：最热演员、最深 CallBoard、最慢方法 |
| `cues` | 全部 Cue 及下次触发时间 |
| `off <role> <stageName>` | 强制下场，验证生命周期 |
| `ring` | 哈希环虚拟节点分布与均衡度 |
| `booth` | 启动 Web 界面并打开浏览器 |
| `dev` | 开发模式：热重载管线（见 §9.3，M10） |
| `deploy --hot <pkg>` | 生产热替换下发（见 §9.4，M11） |

### 11.3 Booth（Web 管理界面）

- **预览版已随 M2 交付**：`form({ booth: true })` 启用，独立 loopback 端口（默认 7500），单文件页面零构建——展示本 Stage 的成员、在场 Actor 状态机、每角色指标（调用/错误/拒绝/p50/p99/max）、事件流（最近 200 条），并提供白名单校验的调用面板与强制下场
- 完整版（本节下述形态）：SPA 预构建打进 npm 包，用户零构建；`troupe booth` 一键起；dev 模式自动挂在 Stage 端口 `/booth` 并在启动日志打印地址；跨 Stage 聚合经 Director（M4）
- 页面：Troupe 总览 / Ring 视图 / Actors 浏览器 / Actor 详情（Props 实时视图 + 方法调用面板：挂 Zod schema 自动生成表单，否则 JSON 编辑器 + 强制下场）/ Live Trace 动画 / Cues / Metrics 图表
- 实时推送用 SSE；方法调用走 POST；前端构建期技术栈自由（产物静态文件，依赖不进用户 node_modules）

### 11.4 运行时内省需求（核心内置，非事后补）

1. **Actor 注册表**：在场元数据（登台/最后调用时间、CallBoard 深度、Props 字节数、`codeVersion`）
2. **计数器**：每角色/每演员调用数、错误数、延迟直方图（环形缓冲，固定内存）
3. **Trace 事件总线**：每次调用产事件（调用方→被调方、方法、耗时、结果），本地环形缓冲 1 万条 + 订阅接口，采样率可调、字节预算受控——`tail` 与 Booth Live Trace 的数据源
4. **方法元数据**：方法名与参数个数（Booth 调用面板）；用户挂 Zod schema 则一并暴露

---

## 12. 用户项目布局约定

```
project/
├── package.json / tsconfig.json
├── .env.example              # TROUPE_SEEDS / TROUPE_PORT / TROUPE_ADMIN_TOKEN
├── .gitignore                # 含 .troupe/ 与 .env
├── src/
│   ├── main.ts               # import "./actors" → Troupe.form({ actors }) → startEdge(troupe)
│   ├── actors/               # 一个文件一个演员，*.actor.ts
│   │   ├── index.ts          # barrel：export * from 每个 actor
│   │   ├── inventory.actor.ts
│   │   └── user-order.actor.ts
│   ├── edge/                 # 只做映射：鉴权、校验、cast 调用
│   │   ├── app.ts
│   │   └── routes/*.ts
│   └── domain/               # 跨边界共享类型（方法签名里的类型）
│       └── types.ts
├── test/                     # Rehearsal 单测/流程测试
└── .troupe/                  # 运行时生成（props.db），gitignored
```

约定要点：

- Props 类型与 actor 同文件且**不导出**；出现在方法签名（参数/返回值）的类型进 `domain/`
- `IRole` 接口文件默认不建，`cast(ClassRef)` 有完整类型；仅契约跨仓库/跨语言共享时建 `src/roles/`
- 无 `troupe.config.ts`：偏离默认写进 `form({...})`（代码即配置），部署差异走环境变量
- 规模增长后从"按层分"演进到"按域分"（`src/modules/<domain>/`），规则不变；纯查询域只有 routes 直接查 DB——不强迫万物皆 Actor

反模式：export Props 类型给外部；actors/ 里放工具函数；每 actor 深目录嵌套；过早拆多 package；提交 `.troupe/`。

---

## 13. 边界与非目标（一期）

- 不做代码生成（Proxy + 类型推导已够）
- 不做目录式 Playbill 与任意 Casting（二期）
- **交错执行（`@Improv`/`@ReadOnly`）不在一期运行时交付**：M1 起严格串行，交错为后续独立阶段（PLAN M5）
- **无协调服务集群定位为实验性**：允许重复激活，不承诺强一致业务语义；生产强一致需共享 PropStore 所有权（§6.5）
- 不做 BoxOffice 客户端网关、Show 流、Audience 观察者（后续里程碑）
- 不做多语言（JSON 协议保留了可能性）
- 不做 worker_threads 内部分片（多进程即扩展）
- 不做完整 SWIM / mDNS（二期可选）
- 不自动重试远程 Call：超时/断连只代表**结果未知**；幂等由业务键 + 参数指纹 + 原子提交的幂等记录保证（§6.5），显式 retry 选项后续评估
- 生产热替换（L2）为后期独立实验（M11）；dev 热重载（L1）后移至 M10；滚动混跑兼容规范提前成文（§9.4）

---

## 14. 术语表

见 §2 剧团词典。开放命名问题：`Agent` 与当下 "AI agent" 撞词，备选 `ActorRef`，定稿前需确认（见 PLAN.md 开放问题）。
