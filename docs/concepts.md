# 核心概念

## Virtual Actor 模型

| 概念 | Troupe 命名 | 说明 |
|---|---|---|
| 集群 | Troupe | 整个系统；`Troupe.form()` 组团 |
| 节点/进程 | Stage | 一个 Node 进程 = 一个 Stage |
| 虚拟 Actor | Actor | 逻辑上永远存在；`(roleId, stageName)` 全局寻址 |
| 代理 | Agent | `cast()` 返回的类型安全代理；方法调用即消息（Call） |
| 激活/钝化 | OnStage / OffStage | 首条 Call 自动登台；空闲 Intermission 自动下场 |
| 状态 | Props | Actor 的持久化状态；显式 `saveProps()` 提交 |
| 存储 | PropStore | InMemory / SQLite（进程级）/ Postgres（节点级） |
| 消息信箱 | CallBoard | 每 Actor 一个 FIFO 队列 |
| 定时 | Cue / Reminder | 内存定时器 / 持久提醒 |
| 流 | Show / Audience | 话题化 pub/sub；Audience = Actor 方法引用 |
| 管理 | Director / Booth / CLI | 内省与管理 |

## 执行模型（严格串行 + Turn）

```
Call 到达 → 归属判定（HashRing，跨 Stage 转发 ≤2 跳）
  → 激活（single-flight：并发首调只登台一次）
  → 入 CallBoard（FIFO）
  → 按 Turn 执行：上一 Turn settle 前不取下一 Call
  → 空闲超过 Intermission → 排空 → offStage() → 从在场表移除
```

关键契约：

1. **排队过期不执行**：deadline 已过的排队 Call 直接拒绝（`CallTimeoutError`，`phase="queued"`），零副作用，可安全重试
2. **执行占用**：调用方超时（`phase="executing"`）收到的是"结果未知"——**旧 Turn 继续执行完毕**，串行通道不放行；后续调用在旧 Turn settle 后才执行
3. **生命周期状态机**：未激活 → 激活中 → 运行中 → 排空中 → 失效；激活 single-flight；排空期间新请求等待（`drainPolicy: "wait"` 默认）或明确拒绝（`"reject"`）
4. **保存失败即失效**：`saveProps` 失败/CAS 冲突 → 实例失效，下次调用从最后已提交快照重新加载——不会基于未提交状态继续服务

## 交错执行（opt-in）

默认**严格串行**。`@Improv` / `@ReadOnly` 标注的方法按组合矩阵交错：

| 组合 | 可否交错 |
|---|---|
| 未标注 × 任何 | ❌（独占） |
| `@Improv` × `@Improv` / `@ReadOnly` | ✅ |
| `@ReadOnly` × `@ReadOnly` | ✅ |

防护：strict 方法入队后停止启动新 annotated Turn（写不被读饿死）。

⚠️ **JS 单线程不提供跨 await 的业务原子性**：交错窗口内其它调用可见 Props 中间态（例：扣减已生效、审计未写）。标注前确认方法容忍中间态。

## Codec 边界（本地/远程/测试一致）

所有调用参数与返回值默认经过 JSON 编解码复制边界：

- `Date` → ISO 字符串
- `BigInt` / `Map` / `Set` / 函数 / Agent 引用 / 循环引用 → `SerializationError`（附改写指引）
- `undefined` 字段按 JSON 语义丢失
- 本地调用同样复制（`localCallByReference: true` 可显式关闭，语义分叉自担）

推论：**调用后修改传入对象、或修改拿到的结果对象，都不影响 Actor 内部状态**。

## 错误语义

| 错误 | 含义 | 调用方动作 |
|---|---|---|
| `CallTimeoutError(phase="queued")` | 排队过期，从未执行 | 安全重试 |
| `CallTimeoutError(phase="executing")` / `UnknownOutcomeError` | **结果未知**（执行中/连接断开） | 按幂等键重试；**勿假定失败** |
| `CallRejectedError` | 请求拒绝（背压/排空/停机/白名单/所有权/漂移），带 `reason` 与 `retryable` | 按 reason 决定重试或修复 |
| `ConflictError` | CAS 冲突（存储层被并发写入） | 实例已自动失效；重试从新快照开始 |
| `IdempotencyConflictError` | 同幂等键不同参数指纹 | 修正调用方 bug |
| 业务异常 | Actor 方法 throw，name+message 原样回传 | 业务处理 |

## 持久成功与幂等

- `saveProps()`：**持久成功**语义——提交成功后才应返回业务成功
- `this.idempotent(key, fingerprint, fn)`：幂等执行。同键同指纹重放原结果；同键异指纹抛 `IdempotencyConflictError`；**fn 内只修改内存状态，不要 saveProps**——helper 在 settle 后把状态+幂等记录原子落盘
- 跨 Actor 流程无事务：失败路径显式业务补偿（或 outbox）
