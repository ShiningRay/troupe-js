# API 速查（Skill 参考）

> 形参签名以 `docs/api-reference.md` 为准；此处按使用频率组织。

## Troupe.form(options) — 常用选项

```typescript
const troupe = await Troupe.form({
  actors: [CartActor, OrderActor],      // 显式注册（推荐）；省略 = @Performs 全量快照
  propStore,                            // 默认 SqlitePropStore；NODE_ENV=test → InMemory
  namespace: "prod",                    // 存储键命名空间（多环境共库防串）
  defaultTimeout: "30s",                // Call 超时
  defaultIntermission: "5m",            // 空闲下场
  queueDepth: 1024,                     // 每 Actor 队列上限
  drainPolicy: "wait",                  // 排空中新请求：wait | reject
  idempotencyRetention: "7d",
  maxActivations: 10_000,               // Stage 级背压
  maxQueuedBytes: 64 * 1024 * 1024,
  localCallByReference: false,          // true = 本地调用不复制（语义分叉自担）
  cluster: { port: 7300, seeds: [], mode: "production", advertise: "10.0.0.2:7300" },
  ownership: { leaseMs: 5_000 },
  cues: true,                           // 或 { store?: CueStore, tickMs?: 1000 }
  show: { persist: true },              // 或 { dir?: "./.troupe" }
  booth: true,                          // 或 { host, port }（默认 7500）
  boxoffice: { token: "..." },          // 或 { host, port }（默认 7600）
  onSpan: (s) => exporter(s),           // OTel 桥：s.traceparent (W3C)
  onEvent: (e) => logger(e),            // 埋点事件
  now: () => Date.now(),                // 测试时钟注入
});
```

错误（form 阶段）：Node < 22.13、角色名冲突、`cast` 未注册、production 缺 advertise/port/seeds、
`@Cron/@Every` 未开 cues、ownership 但存储不支持 —— 全部 fail fast。

## Actor 静态字段与装饰器（双轨二选一）

```typescript
@Performs("cart") @Intermission("10m")
class C extends Actor<P> {
  static roleId = "cart";              // 装饰器与静态字段可互相覆盖
  static initialProps = () => ({...}); // 结构化 Props 必须提供
  static timeouts = { slow: "5s" };
  static improv = ["m1"];  static readOnly = ["m2"];
  static schemaVersion = 2;
}
// 装饰器：@Performs @Intermission(dur) @Improv @ReadOnly
// 声明式定时：@Cron("0 9 * * *") @Every("30s") @Local("300ms")  （前两个需 cues: true）
```

## Actor 受保护成员

| 成员 | 说明 |
|---|---|
| `this.props` | 状态；**只在此对象上改**（本地复制边界） |
| `this.stageName` | 实例名 |
| `saveProps()` | CAS 原子提交；失败/冲突 → 实例失效（重载快照） |
| `idempotent(key, fp, fn)` | fn 只改内存；同键同指纹重放、异指纹抛错；helper settle 后原子提交 |
| `cast(ctor\|roleId, stageName)` | Actor 互调；自动携带调用链 span |
| `registerCue(name, every, fn)` / `cancelCue` | 内存 Cue（onStage 注册；下场清理；忙跳拍） |
| `scheduleReminder(name, { every \| at, payload })` / `cancelReminder` | 持久提醒（触发即重登台；至少一次） |
| `subscribe(topic, method="onEvent")` / `unsubscribe` | Show 订阅（事件走串行 Turn） |
| `publishShow(topic, event)` | 发布（至少一次，重试 3 次） |
| `onStage / offStage / onCue / onEvent / onCodeSwap / migrateProps` | 钩子（全部可选，覆写即可） |

## Troupe 实例方法

```typescript
troupe.cast(ctor | roleId, stageName): Agent<T>
troupe.publish(topic, event); troupe.subscribe(topic, audience); troupe.unsubscribe(...)
troupe.off(roleId, stageName);          // 管理下场（排空→offStage→save）
troupe.drainAll();                       // 测试收尾
troupe.shutdown();                       // 优雅停机全链路
troupe.destroy();                        // kill -9 模拟（仅测试）
troupe.director();                       // roster/actors/inspect/invoke/off/cues/ring/cluster/deploy/rollback
troupe.traces(n, filter); troupe.subscribeTrace(filter, fn);
troupe.slots(); troupe.repertoire(); troupe.methodsOf(roleId);
troupe.clusterAddress(); troupe.clusterMembers(); troupe.ownerOf(role, stage);
troupe.deployLocal(bundle); troupe.deployCluster(bundle); troupe.rollbackDeploy(roleId);
```

## 错误类型与调用方动作

```typescript
CallTimeoutError    // phase: "queued"（未执行，安全重试）| "executing"（结果未知）
UnknownOutcomeError // 连接断开/对端不可达——结果未知
CallRejectedError   // reason: backpressure | draining | invalidated | whitelist | shutdown | drift | ownership（retryable 标志）
ConflictError       // 存储层 CAS 冲突（kind: exists | revision）
IdempotencyConflictError
SwapViolationError  // 热替换守则违规（violations: string[]）
ActivationError / SerializationError / RoleConflictError / UnknownRoleError
```

## PropStore / CueStore / OwnershipStore / SubscriptionStore

见 `docs/api-reference.md` 的合同段。内置：InMemory×4、SqlitePropStore、SqliteCueStore、SqliteSubscriptionStore、PostgresPropStore（peer `pg`）。

## Show 协议要点

- 话题归属：`HashRing("show:"+topic)` 选 coordinator；订阅/发布路由到它
- 投递 = 向 Audience (roleId, stageName, method) 发 Call：订阅者不在场 → 重新登台
- 至少一次：失败退避重试 3 次（200/400/800ms）后记 `showDropped`；超时类可能重复 → 订阅方幂等
- `form({ show: { persist: true } })`：订阅落盘，coordinator 重启/漂移自动重载
