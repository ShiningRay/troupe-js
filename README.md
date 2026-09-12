# Troupe.js

面向 Node.js/TypeScript 的 **Virtual Actor** 框架。设计见 [DESIGN.md](./DESIGN.md)，开发计划见 [PLAN.md](./PLAN.md)。

> 状态：**M1–M4 已交付**——串行运行时；SQLite/Codec/TCP 集群/信任边界；所有权（租约 + fencing）/成员硬化/production；持久 Cue（至少一次）+ Director/CLI + 指标端点。
> 要求 Node >= 22.13。

## 快速开始（仓库内）

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest（95 例验收；含 M3 所有权/混沌/Postgres、M4 Cue/Director）
npm run build            # 构建 dist/
npm run example          # examples/minimal（DESIGN §3.1 Cart）
npm run demo             # examples/demo（8 段 M1 行为演示，含多 Actor 交互）
npm run demo:m2          # examples/demo-m2（9 段 M2 特性演示：持久化/Codec/组团/错误分类/畸形帧/转发/kill -9/停机/背压）
npm run example:cluster  # 真·多进程集群：3 个 node 进程组团/跨进程路由/真实 SIGKILL 接管/SQLite 恢复 + 进程观察窗口（默认 60s，Ctrl+C 提前结束；可传秒数：npm run example:cluster -- 120）
                            # 每个 Stage 各带一个 Booth 内省面板，观察窗口会打印地址（浏览器打开即用）
npm run example:timers   # 定时/延时任务用法演示：内存 Cue 攒批 / 持久巡检 / 订单超时 / 幂等重试 / 反例
npm run example:chat     # 聊天室（带前端界面）：Room Actor 串行处理 + SQLite 持久化 + SSE 实时推送 + 幂等发送重试；Booth 同步开在 7500
npm run cli               # troupe CLI（status/roster/ps/inspect/call/off/cues/ring，--to host:port --json）
npm run bench:sqlite     # SQLite 写入延迟与事件循环阻塞基准
npm run bench:cluster    # 集群消息处理基准（3 进程真 TCP）：同步直调/async 直调/本地/跨 Stage/落盘/并发吞吐/M3 所有权开销（可传 [秒=5] [payload字节=256] [并发=8]）
```

```typescript
import { Actor, Performs, Intermission, Troupe } from "troupe";

interface CartProps { items: Item[] }

@Performs()
@Intermission("10m")
export class CartActor extends Actor<CartProps> {
  static initialProps = (): CartProps => ({ items: [] });

  async offStage() { await this.saveProps(); }

  async add(item: Item) {
    this.props.items.push(item);
    await this.saveProps();   // 持久成功：提交成功后才返回
  }
  async peek() { return this.props.items.length; }
}

const troupe = await Troupe.form({ actors: [CartActor] });
const cart = troupe.cast(CartActor, userId);
await cart.add(item);
```

测试用 `troupe/testing` 的 Rehearsal（强制 InMemory）；`NODE_ENV=test` 下 `Troupe.form()` 零显式配置。

## M1 交付内容（对照 PLAN §2.M1）

| 能力 | 位置 |
|---|---|
| `Actor<TProps>` 基类、生命周期钩子、`static initialProps()` 工厂 | `src/core/actor.ts` |
| 生命周期状态机（激活中/运行中/排空中/失效）+ 激活 single-flight | `src/core/stage-manager.ts` |
| 排空期间新请求：wait（默认）/ reject（明确拒绝），不静默丢 | `TroupeOptions.drainPolicy` |
| 显式注册 `form({ actors })` + `@Performs` 便利注册（每 Troupe 快照） | `src/core/repertoire.ts`、`src/core/meta.ts` |
| `cast()` → Agent Proxy（类型面仅 RPC 方法；then/Symbol 安全） | `src/core/agent.ts` |
| Actor 互调 `this.cast(OtherActor, stageName)`（§10.1；M1 进程内直连） | `src/core/actor.ts` + `CastHandle` |
| CallBoard 严格串行（`@Improv`/`@ReadOnly` 标注按串行执行并告警） | `src/core/stage-manager.ts` |
| 排队过期不执行；执行中超时只应答不放行（执行占用契约） | 同上 |
| `PropStore` 接口（revision/schemaVersion 分离、create/write CAS 合同） | `src/props/prop-store.ts` |
| `InMemoryPropStore`（读写深拷贝模拟复制边界） | `src/props/memory.ts` |
| 保存失败/CAS 冲突 → 实例失效，重载最后已提交快照 | `src/core/stage-manager.ts` |
| 幂等执行 `this.idempotent(key, fingerprint, fn)`（记录随 Props 原子提交） | `src/core/actor.ts` + 信封 `src/core/envelope.ts` |
| schemaVersion 驱动 `migrateProps`（失败即激活失败） | `src/core/stage-manager.ts` |
| Intermission 空闲回收 + offStage 钩子 | 同上 |
| Rehearsal（`troupe/testing`） | `src/testing/index.ts` |
| 观测埋点与测试注入接口（事件总线、计数器/延迟直方图、注入时钟） | `src/core/events.ts`、`TroupeOptions.now/onEvent` |

验收单测见 `test/`（59 例）：M1 部分（串行性、单飞、排空策略、执行占用、排队过期、背压、保存失败恢复、CAS 冲突、迁移、幂等、Intermission、注册双轨、Agent 表面、Actor 互调、零配置）；M2 部分（Codec 边界语义、SQLite CAS/重开恢复、xxh32 向量与环一致性/分布、TCP 帧解析/畸形帧可控拒绝/in-flight 上限/结果未知、双 Stage 组团透明路由、漂移转发与跳数上限、kill -9 后 SQLite 恢复、优雅停机量化验收、全局背压）。

## M2 交付内容（对照 PLAN §2.M2）

| 能力 | 位置 |
|---|---|
| `SqlitePropStore`（`node:sqlite` 零依赖、懒建库表、WAL、单语句 CAS） | `src/props/sqlite.ts` |
| Codec 边界统一：Date→ISO；BigInt/Map/Set/函数/Agent/循环引用抛错附指引；undefined 按 JSON 语义丢失 | `src/core/codec.ts` |
| 本地调用默认经同一复制边界（`localCallByReference` 可显式关闭） | `src/troupe.ts` |
| TCP 传输：长度前缀 + JSON、帧长度上限、连接 in-flight 上限、坏帧只断不断进程 | `src/cluster/transport.ts` |
| 错误分类：业务异常/请求拒绝/存储冲突/结果未知（`UnknownOutcomeError`）；stack 不上线 | `src/cluster/{transport,cluster}.ts` |
| HashRing：纯 JS xxh32（标准向量验证）+ 160 虚拟节点 + successors | `src/cluster/hash-ring.ts` |
| Playbill 路由 + 误投转发（跳数上限 2） | `src/cluster/playbill.ts`、`cluster.ts` |
| Roster 简化版：seeds join + gossip 反熵（含自身）+ 后继直接探测判死（~3s） | `src/cluster/roster.ts` |
| 信任边界：接收端信封校验 + 方法白名单 + 角色未加载显式拒绝 | `src/cluster/cluster.ts` |
| 全局背压：每 Stage 激活数上限、排队字节预算 | `src/core/stage-manager.ts` |
| 优雅停机 `troupe.shutdown()`：leave → 拒新 → 存量 settle → 全员 offStage+save | `src/troupe.ts` |
| 调度器每 64 Turn 让出事件循环（§5.3，防微任务流饿死定时器） | `src/core/stage-manager.ts` |
| **Booth 预览版**：内省面板（Stage/成员/在场 Actor 状态机/指标/事件流/调用与下场面板），`form({ booth: true })` 启用，默认 `127.0.0.1:7500`；数据经 **SSE 实时推送**（事件驱动 ~250ms 合并 + 1s 保活帧，§11.3） | `src/booth/` |
| SQLite 基准：~1KB 写 p50 0.08ms / p99 0.19ms；5ms 心跳最大间隙 8.81ms | `examples/bench/` |

## M3 交付内容（对照 PLAN §2.M3）

| 能力 | 位置 |
|---|---|
| `OwnershipStore` 契约（acquire/续租/顶替/release/read，epoch 单调） | `src/props/ownership.ts` |
| SQLite 所有权表：单语句原子 CAS；write 携 fencingToken 时同语句校验（同机多进程） | `src/props/sqlite.ts` |
| `PostgresPropStore`（可选 peer `pg`）：行级 CAS + 所有权 + fencing（节点级，多机生产） | `src/props/postgres.ts` |
| 所有权接线：激活前置 acquire、500ms 续租调度（失败即失效）、环漂移主动交接（排空+落盘+释放）、save 携 fencingToken | `src/core/stage-manager.ts` |
| Roster 硬化：incarnation 重启身份、suspect→dead 两阶段、单调合并（dead-wins）、墓碑（旧身份不得借 TTL 清理复活）、被误判者抬升身份反驳 | `src/cluster/roster.ts` |
| production 模式：固定端口（被占即败）、必须 advertiseAddress、必须成功入团、角色集合不一致拒加入、强制所有权 | `src/cluster/cluster.ts` |
| 滚动混跑兼容规范（L3 规范本体，R1–R6 规则 + 部署期检查清单） | [COMPATIBILITY.md](./COMPATIBILITY.md) |
| 混沌验收：SIGSTOP 冻结事件循环 → 判死 → 租约到期接管 → SIGCONT 后旧持有者写入被 fencing 拒绝 | `test/m3-chaos.test.ts` |

M3 验收覆盖（83 例）：所有权并发原子性/epoch 单调/租约过期顶替；kill -9 后租约到期接管（epoch+1、SQLite 恢复）；正常扩容交接（漂移键排空落盘释放、无双活）；Roster 两阶段判死/旧身份不复活/墓碑/反驳；production 严格性 ×3；SIGSTOP 全链路 fencing；Postgres 行级 CAS + fencing（本机 PG 实测，无 PG 自动跳过）。

## M4 交付内容（对照 PLAN §2.M4）

| 能力 | 位置 |
|---|---|
| `CueStore` 契约：upsert/due/原子 claim（租约）/complete（statusVersion CAS）/list | `src/cues/cue-store.ts` |
| InMemory / SQLite（WAL，同机多进程原子 claim）实现 | `src/cues/{memory,sqlite}.ts` |
| Actor API：`scheduleReminder`（every 周期 / at 一次性）/`cancelReminder`/`onCue` 稳定入口 | `src/core/actor.ts` |
| 调度器：仅本 Stage 环归属键、至少一次投递、错过周期合并补发一次、失败退避重试 | `src/cues/scheduler.ts` |
| Director 系统角色：roster/actors/inspect/invoke（白名单）/off/cues/ring；wire `t=dir` 通道 + `TROUPE_ADMIN_TOKEN` | `src/director/director.ts`、`src/cluster/cluster.ts` |
| CLI：status/roster/ps/inspect/call/off/cues/ring（手写参数解析，零依赖） | `cli/troupe.ts` |
| Booth `/healthz` + `/metrics`（Prometheus 文本） | `src/booth/server.ts` |

M4 验收（12 例新增）：CueStore CAS/租约；周期触发进串行 Turn + payload 传递；**下场后由提醒重新登台**；一次性触发后删记录；注销零触发；**执行者宕机（租约滞留）到期重投递**；慢 tick 合并补发（不追赶）；**SQLite 重启后发现**；Director 本地/wire/token；/healthz//metrics。

## 定时器与延时任务用法（速查）

| 场景 | 用法 | 语义 |
|---|---|---|
| 在场才有效的周期任务（攒批 flush、心跳） | `onStage()` 里 `this.registerCue("flush", "300ms", fn)` | 随下场自动清理、重新登台重注册；回调经串行 Turn（不与业务交错）；上一拍未完成跳过本拍 |
| 跨下场/跨重启的业务巡检 | `this.scheduleReminder(name, { every, payload })` + `onCue` | 写入 CueStore，触发即重新登台；至少一次投递（业务按 name+payload 幂等）；错过周期合并补发一次 |
| 延时任务（订单超时取消） | `scheduleReminder(name, { at, payload })`；完成后 `cancelReminder` | 一次性；支付成功即注销（注销竞争由 statusVersion CAS 裁决）；跨重启生效 |
| 失败后延迟重试 | 幂等**受理**（`idempotent`）+ at 提醒驱动内部重试状态机 | 幂等键去重重复提交；重试由提醒触发（注意：不要把"暂不可用"当 idempotent 的最终结果记录，会被重放短路） |
| ⚠ 反例 | 业务方法里 `await sleep(...)` 等待延时 | 占用该 Actor 的串行通道（§5.1），阻塞后续调用——延时逻辑一律用 `at` 提醒登记 |

完整演示：`npm run example:timers`（五段含反例）。

## 基准参考数字（Apple Silicon，loopback，256B 往返）

| 相位 | 吞吐 | 说明 |
|---|---|---|
| 直调·同步（裸对象） | ~20.4M msg/s | 纯 JS 方法调用，无框架无 await |
| 直调·async/await（裸对象） | ~11.1M msg/s | 原生 Promise 机制（≈同步的 1/2） |
| 本地·串行 echo（框架） | ~248k msg/s | Codec×2 + 排队 + 串行 Turn + 超时竞速 |
| 跨 Stage·串行 echo（TCP） | ~13.5k msg/s | + 帧封装/JSON/loopback 往返 |
| 跨 Stage·串行 echoSave（+SQLite） | ~9.4k msg/s | + 归属进程 WAL 写 |
| 跨 Stage·并发×8 echo | ~64k msg/s | 单 Actor 串行通道下的并发在途 |
| 本地 echoSave ± M3 所有权 | ~19k msg/s | 所有权开销 <0.01ms/写 |

派生（每条消息的中位数差）：async/await 机制 ≈0.000ms；框架本地路径 ≈0.004ms；TCP 路由 ≈0.06ms；持久化 ≈0.03ms；**M3 所有权 ≈0.00ms**（fencing 是写语句子查询 + 摊销续租）。
已知特性：单进程持续 ~60k msg/s 饱和压测下成员探测可能饿出瞬时 suspect——M3 反驳机制自愈（抬升 incarnation 重入团），零错误；生产容量规划见 DESIGN §5.3。

## 已知边界（后续里程碑）

- **无所有权的外部副作用保护**：租约挡不住已恢复旧代码的外部副作用（HTTP/消息），需接收方校验 epoch 或 outbox（DESIGN §6.5，指引见 COMPATIBILITY.md）
- **成员分区混沌**：丢包/乱序注入以 Roster 单元测试的对抗性序列覆盖；netem 级网络混沌待专项环境（PLAN M3 验收备注）
- **无传输加密/鉴权**：绑定 loopback（dev）/production 前提为受控网络；传输保护与 join 凭证属后续
- **Cue 计划形态**：M4 支持 every（周期）/at（一次性）；cron 表达式与 timezone 解析、PG 版 CueStore 列为后续
- **Director 跨 Stage 扇出聚合**：CLI/Booth 连单点；集群级聚合视图后续
- **@Improv/@ReadOnly 无交错**：M5
- **Codec 为默认 JSON 语义**：MessagePack 插件后续
