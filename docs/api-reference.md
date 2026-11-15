# API 参考

## Troupe.form(options)

| 选项 | 默认 | 说明 |
|---|---|---|
| `actors` | `@Performs` 进程注册表快照 | 显式注册（推荐）；每个 Troupe 独立快照 |
| `propStore` | SQLite（test 下 InMemory） | 实现 `PropStore`；所有权另需 `OwnershipStore` |
| `namespace` | `TROUPE_NAMESPACE` / `"default"` | 存储键命名空间 |
| `defaultTimeout` | `"30s"` | Call 超时；可被 `static timeouts` 按方法覆盖 |
| `defaultIntermission` | `"5m"` | 空闲下场时长 |
| `queueDepth` | `1024` | 每 Actor CallBoard 深度上限 |
| `drainPolicy` | `"wait"` | 排空期间新请求：`"wait"` / `"reject"` |
| `idempotencyRetention` | `"7d"` | 幂等记录保留期 |
| `maxActivations` / `maxQueuedBytes` | 10000 / 64MB | Stage 级全局背压 |
| `localCallByReference` | `false` | 关闭本地复制边界（语义分叉自担） |
| `cluster` | 无 | `{ host?, port?, advertise?, seeds?, mode?: "dev"\|"production" }` |
| `ownership` | 未启用 | `{ leaseMs? }`；production 强制启用 |
| `cues` | 未启用 | `true \| { store?: CueStore; tickMs? }`（`@Cron`/`@Every`/持久提醒必需） |
| `show` | 未启用 | `{ persist?: boolean \| { dir? } }` 订阅持久化 + 至少一次投递 |
| `booth` | 未启用 | `true \| { host?, port? }` 内省面板（默认 127.0.0.1:7500） |
| `boxoffice` | 未启用 | `true \| { host?, port?, token? }` WS 网关（默认 7600） |
| `onSpan` | 无 | OTel 桥：每 Turn 回调（W3C traceparent） |
| `onEvent` | 无 | 埋点事件订阅 |
| `now` | `Date.now` | 测试注入时钟 |

方法：`cast` / `publish` / `subscribe` / `unsubscribe` / `off(roleId, stageName)` / `drainAll` / `shutdown` / `destroy`（kill -9 模拟，仅测试）/ `director()` / `traces(n, filter)` / `subscribeTrace` / `repertoire` / `methodsOf` / `slots` / `clusterAddress` / `clusterMembers` / `ownerOf` / `boothAddress` / `boxofficeAddress`。

## Actor 基类

```typescript
abstract class Actor<TProps> {
  props!: TProps;                                  // 运行时注入；只在此对象上改状态
  get stageName(): string;

  // 生命周期
  async onStage(): Promise<void> {}                // 登台后（Props 已就绪；注册内存 Cue 的位置）
  async offStage(): Promise<void> {}               // 下场前（需要持久化在此 saveProps）
  async onCue(name, payload): Promise<void> {}     // 持久提醒入口（默认分派到 @Cron/@Every 方法）
  async onEvent(event): Promise<void> {}           // Show 订阅默认回调
  async onCodeSwap(oldV, newV): Promise<void> {}   // 热替换后（重建模块级单例）

  // 受保护能力
  protected saveProps(): Promise<void>;            // 原子提交（CAS）；失败 → 实例失效
  protected idempotent<T>(key, fingerprint, fn): Promise<T>;
  protected cast<T>(target, stageName): Agent<T>;  // Actor 互调
  protected registerCue(name, every, fn): void;    // 内存 Cue（仅在场有效）
  protected cancelCue(name): void;
  protected scheduleReminder(name, spec): Promise<void>;  // 持久提醒（需 cues: true）
  protected cancelReminder(name): Promise<boolean>;
  protected subscribe(topic, method = "onEvent"): Promise<void>;   // Show 订阅
  protected unsubscribe(topic, method?): Promise<void>;
  protected publishShow(topic, event): Promise<void>;
  protected throwaway?: never; // （示意）非公开成员对 Agent 不可见
}
```

### 静态字段（与装饰器双轨）

```typescript
static role / roleId      // 角色名（持久业务必须显式 roleId，类改名不破坏寻址）
static intermission       // 同 @Intermission
static initialProps       // 初始状态工厂（结构化 Props 必须提供）
static timeouts           // { method: ms } 按方法超时
static improv / readOnly  // string[]，同 @Improv / @ReadOnly
static rpc                // string[] RPC 允许清单（最小暴露面，见下）
static schemaVersion      // 结构版本（迁移驱动）
static codeVersion        // 热重载内部使用
```

**`static rpc`（最小暴露面）**：默认所有公开方法（保留名/`_` 前缀除外）都在 RPC 白名单里；
声明 `static rpc = ["peek", "join"]` 后白名单收窄为清单 ∩ 公开方法，清单外方法——本地 Agent
代理直接不含该成员，wire/集群调用被 `CallRejectedError(reason: "whitelist")` 拒绝。清单里
写出未知方法名在 `form()` 阶段 fail-fast（TypeError）。

## 装饰器

`@Performs(role?)` · `@Intermission(dur)` · `@Improv` · `@ReadOnly` ·
`@Cron(expr)` · `@Every(dur)` · `@Local(dur)`（声明式定时，需 `cues: true`；`@Local` 不需要）

## PropStore 合同

```typescript
interface PropStore {
  readonly capabilities: StoreCapabilities;       // 能力声明（ADR 0002 §8）
  read(ns, roleId, stageName): Promise<StoredProps | null>;
  create(..., opts?: { fencingToken?, fencingOwner? }): Promise<StoredProps>; // 不存在才成功（原子）；带 token 时校验所有权
  write(..., { expectedRevision, schemaVersion, fencingToken?, fencingOwner? }): Promise<StoredProps>;
  delete?(..., opts?: { fencingToken?, fencingOwner? }): Promise<void>;
}
// StoredProps = { props, revision, schemaVersion }
// StoreCapabilities = { crossNodeSafe, supportsFencing, supportsTransactions? }
```

fencing 语义（ADR [0002](./adr/0002-ownership-fencing.md)）：携带 `{fencingToken, fencingOwner}` 时，
Provider 必须在同一原子语句内校验所有权行 `owner_id + epoch + lease_until > now（存储时钟）`；
行缺失 = `ConflictError(kind="fencing")`，租约过期 = `kind="lease-expired"`。
未启用 ownership（token 缺省）时不做校验——该模式不承诺跨节点安全。

实现与能力声明：

| Provider | crossNodeSafe | supportsFencing | 边界 |
|---|---|---|---|
| `InMemoryPropStore` | ✗ | ✗ | 进程内（Rehearsal/测试） |
| `SqlitePropStore` | ✗ | ✓ | 仅**同机**多进程；跨主机共享盘不安全，production 被 P0-6 门禁拒绝（`allowUnsafeProviders` 显式豁免） |
| `PostgresPropStore` | ✓ | ✓ | 多机（peer 依赖 `pg`） |

`CueStore`：`InMemoryCueStore` / `SqliteCueStore`（持久提醒；同样声明 capabilities，PG CueStore 为 P1-5 留位）。
`OwnershipStore`：SQLite（同机多进程）/ Postgres（多机）——租约 + fencing token；
`acquire` 成功返回 `{ ok: true, epoch, leaseUntil }`（leaseUntil 为存储时钟域，ADR 0002 §5）。

## Show / Audience

```typescript
troupe.publish(topic, event);                     // 尽力扇出，至少一次（重试 3 次）
await troupe.subscribe(topic, audience);          // audience = { roleId, stageName, method }
const un = await troupe.subscribe(topic, (evt) => { ... });  // 进程内 callback 订阅者
await un();                                       // 退订；同引用重复订阅幂等
// Actor 内：
this.subscribe(topic, method?); this.publishShow(topic, event);
// 话题归属：HashRing("show:"+topic) 决定 coordinator；form({ show: { persist: true } }) 订阅落盘
```

**callback 订阅者**（`ShowListener = (event) => void | Promise<void>`）面向非 Actor 的边缘代码
（WS/SSE 推送、仪表盘）：发布进程本地直接收到、在 `publish` 的 await 路径上执行——保持快速，
长活逻辑请交给 Actor；不进集群订阅目录、不落盘、Stage 重启失效。单进程场景等价于全局订阅。

## 可观测

`troupe.metrics.snapshot()` → `Record<roleId, RoleMetricsSnapshot>`：
`calls / errors / rejections / cueSkipped / latency{p50,p99,max,samples}`。
`cueSkipped` = 内存 Cue 上一拍未完成而跳拍的次数——游戏循环等周期任务变慢的首要信号，
同时发 `cueSkipped` 埋点事件（detail.cue = Cue 名）。`form({ onEvent })` 或 `troupe.events.on`
可订阅全部埋点（含 `showPublished/showDelivered/showDropped`）。

## Director / CLI

`troupe.director()` → `roster / actors / inspect / invoke / off / cues / ring / cluster`。
CLI：`status roster ps inspect call off cues ring tail top booth deploy rollback dev`（`--to host:port --json --token`）。

## 热更新

```typescript
await troupe.reloadActorClass(NewCtor, { policy: "recycle" | "swap" | "keep", source });
await troupe.deployLocal(bundle);           // { roleId, source, className?, policy: "swap", sig }
await troupe.deployCluster(bundle);         // 广播各 Stage
await troupe.rollbackDeploy(roleId);        // 重新部署上一已接受 bundle
createDevReloader(troupe, { watch: [files], policy, onReload });
scanActorSource(source);                    // swap 守则静态检查
```

L3 兼容规则（部署期强制）：R1 方法只增不减；R3 schemaVersion 逐级 +1 且必须覆写 `migrateProps`。
