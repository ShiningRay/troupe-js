---
name: troupe
description: Troupe.js Virtual Actor 框架（Node.js/TypeScript）的使用指南。凡是用到或提到 Troupe、troupe、Actor、virtual actor、cast、saveProps、PropStore、Stage、Cue、Reminder、Show/Audience、BoxOffice、热重载、deploy --hot，或用户想在 Node/TS 里做有状态并发（购物车/库存/会话/游戏实体/限流/秒杀/订单超时）、Actor 模型、定时任务、pub/sub、多进程/集群时使用——即使没明说"框架"也要用。
---

# Troupe.js — Virtual Actor 框架使用指南

Node.js/TypeScript 的 Virtual Actor 框架：Actor 按 `(roleId, stageName)` 全局寻址、按需激活、严格串行执行、显式持久化、故障自动重激活。要求 Node >= 22.13。

## 心智模型（30 秒）

- **Actor = (角色, 实例名)**：`troupe.cast(CartActor, "user-1")` 返回类型安全代理；没有就自动创建（登台）
- **一次一条**：同一 Actor 的调用严格串行执行（默认），天然无锁。慢调用会阻塞该 Actor 的后续调用
- **状态在 `this.props`**：显式 `await this.saveProps()` 提交（CAS）；提交成功后才返回业务成功 = 持久成功
- **空闲自动下场**：Props 归还存储；下次调用重新登台（从快照恢复）
- **错误语义**：超时/断连 = **结果未知**（不是失败）——按幂等键重试，勿假定失败

## 最小骨架

```typescript
import { Actor, Performs, Intermission, Troupe } from "troupe";

interface CartProps { items: string[] }

@Performs()                  // roleId 默认 = 类名去 "Actor"；持久业务显式 static roleId
@Intermission("10m")
export class CartActor extends Actor<CartProps> {
  static initialProps = (): CartProps => ({ items: [] }); // 首次登台工厂（结构化 Props 必须给）

  async offStage() { await this.saveProps(); }

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();  // 放在 return 业务成功之前
  }
  async peek() { return this.props.items.length; }
}

const troupe = await Troupe.form({ actors: [CartActor] });
const cart = troupe.cast(CartActor, "user-123");
await cart.add("apple");
```

## 高频操作速查

| 需求 | 写法 |
|---|---|
| 调用 | `troupe.cast(Cart, "user-1").add("x")` — 返回 Promise |
| Actor 内互调 | `this.cast(OtherActor, stageName).method(args)` |
| 持久化 | `await this.saveProps()` |
| 幂等执行 | `this.idempotent(key, fingerprint, fn)` — fn **只改内存，不要 saveProps**（helper 原子提交状态+记录） |
| 定时（cron） | `@Cron("0 9 * * *") async daily() {}`（需 `form({ cues: true })`） |
| 定时（周期，持久） | `@Every("30s")` 或 `this.scheduleReminder(name, { every, payload })` |
| 延时任务（一次性） | `this.scheduleReminder(name, { at: Date.now() + ms, payload })`；完成时 `cancelReminder(name)` |
| 内存定时器（仅在场） | `onStage()` 里 `this.registerCue("flush", "2s", fn)`（下场自动清理；忙则跳拍，计入 `metrics.snapshot()[roleId].cueSkipped`） |
| 订阅事件流 | `this.subscribe("topic")` + `override async onEvent(evt) {}`；发布 `this.publishShow(topic, evt)` |
| 边缘推送（非 Actor 代码收广播） | `const un = await troupe.subscribe("topic", (evt) => {...})`（进程内 callback，快速非阻塞，`await un()` 退订） |
| 最小 RPC 暴露面 | `static rpc = ["a", "b"]`：白名单收窄为清单 ∩ 公开方法，未知名 form 时 fail-fast |
| 强制下场 | `await troupe.off(roleId, stageName)` |
| 优雅停机 | `await troupe.shutdown()` |

## 必守规则（违反即产生真实 bug，均在本仓库验证过）

1. **不要跨调用持有对象引用**：所有参数/返回值经过复制边界（本地也一样）。`Date` 变 ISO 字符串；`BigInt`/`Map`/`Set`/函数/Agent 引用/循环引用直接抛 `SerializationError`。改传出的结果对象不影响 Actor 状态
2. **`idempotent` 的 fn 里不要 saveProps**：helper 在 fn settle 后统一原子提交；fn 内"暂不可用"要**抛出或登记重试提醒**，不要作为结果返回（会被重放短路）
3. **不要在业务方法里 `sleep` 等延时**：Turn 会占住该 Actor 的串行通道，阻塞后续所有调用。延时用 `scheduleReminder(name, { at })` 登记
4. **收到超时/断连 ≠ 失败**：`UnknownOutcomeError` / `CallTimeoutError(phase="executing")` 表示结果未知——用幂等键重试（`idempotent` 自动去重），绝不假定失败后重复做副作用
5. **类改名破坏持久化**：已上线的 Actor 必须声明 `static roleId = "cart"` 固定寻址
6. **结构化 Props 必须给 `static initialProps`**：默认 `{}` 会让 `items.push` 之类当场抛错
7. **`@Cron`/`@Every` 需要 `form({ cues: true })`**，否则 form 直接报错（故意 fail-fast）；`@Local` 不需要
8. **多节点生产必须**：共享 `PostgresPropStore`（或同机 SQLite）+ `ownership: { leaseMs }` + `cluster: { mode: "production", port, advertise, seeds }`。否则是"允许双活的实验性集群"，不要接库存/配额类业务

## 测试模式

```typescript
import { Troupe } from "troupe";

const troupe = await Troupe.form({ actors: [CartActor], defaultIntermission: 0 });
const cart = troupe.cast(CartActor, "test-1");
await Promise.all(Array.from({ length: 100 }, (_, i) => cart.add(`i${i}`))); // 并发压串行性
expect(await cart.peek()).toBe(100);
await troupe.drainAll(); // 每个用例收尾：排空在场 Actor
```

`NODE_ENV=test` 下 form 零配置全内存。测错误语义：`rejects.toMatchObject({ phase: "queued" })`、`reason: "backpressure"` 等。

## 集群与运维速查

```typescript
// 同机多进程：共享 SQLite 目录；多机：PostgresPropStore
const troupe = await Troupe.form({
  actors: [...],
  cluster: { port: 7300, seeds: ["10.0.0.1:7300"], mode: "production", advertise: "10.0.0.2:7300" },
  ownership: { leaseMs: 5000 },   // production 强制；防双活（fencing）
});
```

- production 模式强校验：固定端口/显式 advertise/必须入团/角色集一致，否则启动失败（这是特性）
- 可观测：`form({ booth: true })` → http://127.0.0.1:7500 面板；`troupe.director()` 或 `npm run cli -- status/ps/tail/top/booth`
- 热修复：`troupe.deployCluster({ roleId, source, className, policy: "swap", sig })`（`TROUPE_DEPLOY_SECRET` 验签；兼容检查 R1/R3 强制）；`rollbackDeploy(roleId)` 一键回滚
- dev 热重载：`createDevReloader(troupe, { watch: [...], policy: "recycle" })`（recycle=Props 无损重登台；swap=内存保留，需守则合规源码）

## 深入阅读（按需加载）

- 完整 API 与选项表：`docs/api-reference.md`
- 执行模型/生命周期/错误语义/Codec 规则：`docs/concepts.md`
- 配方（库存秒杀/订单超时/失败重试/补偿编排/攒批/聊天广播/迁移）：`docs/patterns.md`
- 集群/所有权/部署/CLI/Booth/基准数字：`docs/operations.md`
- 设计全文：`DESIGN.md`；里程碑与验收：`PLAN.md`

常见陷阱清单（含"为什么"）：`docs/concepts.md` 错误语义表 + 上方必守规则。
