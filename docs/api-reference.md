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
static schemaVersion      // 结构版本（迁移驱动）
static codeVersion        // 热重载内部使用
```

## 装饰器

`@Performs(role?)` · `@Intermission(dur)` · `@Improv` · `@ReadOnly` ·
`@Cron(expr)` · `@Every(dur)` · `@Local(dur)`（声明式定时，需 `cues: true`；`@Local` 不需要）

## PropStore 合同

```typescript
interface PropStore {
  read(ns, roleId, stageName): Promise<StoredProps | null>;
  create(...): Promise<StoredProps>;              // 不存在才成功（原子）
  write(..., { expectedRevision, schemaVersion, fencingToken? }): Promise<StoredProps>;
  delete?(...): Promise<void>;
}
// StoredProps = { props, revision, schemaVersion }
```

实现：`InMemoryPropStore` / `SqlitePropStore`（进程级）/ `PostgresPropStore`（节点级，peer 依赖 `pg`）。
`CueStore`：`InMemoryCueStore` / `SqliteCueStore`（持久提醒）。
`OwnershipStore`：SQLite（同机多进程）/ Postgres（多机）——租约 + fencing token。

## Show / Audience

```typescript
troupe.publish(topic, event);                     // 尽力扇出，至少一次（重试 3 次）
await troupe.subscribe(topic, audience);          // audience = { roleId, stageName, method }
// Actor 内：
this.subscribe(topic, method?); this.publishShow(topic, event);
// 话题归属：HashRing("show:"+topic) 决定 coordinator；form({ show: { persist: true } }) 订阅落盘
```

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
