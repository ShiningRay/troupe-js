# ADR 0002：Props 所有权与 Fencing 不变量

- 状态：已接受
- 日期：2026-11-16
- 关联：[ROADMAP P0-1](../ROADMAP.md)、[ORLEANS_GAP](../ORLEANS_GAP.md)、DESIGN §6.5 / §7.2、跨语言统一规划（troupe-planning）
- 评审：框架 / 存储 / 运维各一名（本仓单人维护期间以 CI 反例 + 代码评审替代多角色评审，见 §9）

## 1. 背景

Troupe.js 在 `ownership` 启用后以「租约 + epoch（fencing token）」防止同一 Actor 的双活写。
但当前实现存在四条已识别的未覆盖路径（证据见 ORLEANS_GAP §1）：

1. `PropStore.create` 不携带 fencing token：旧持有者可在 takeover 后重新 create 记录；
2. `create` 冲突后的回退 `write` 不携带 token（stage-manager `save` 的竞态兜底分支）；
3. PG/SQLite 的 fencing 条件是 `NOT EXISTS(epoch > token)`：所有权行**缺失**时放行，且不校验
   `owner_id` 与租约有效期；
4. 续租遇到存储异常只记 warn，实例继续接单，直到租约被他人接管。

本 ADR 给出修正后的不变量集合；每条不变量映射到 `test/ownership-fencing.test.ts` 的失败反例
（P0-2），并在 P0-3～P0-6 落地。

## 2. 四个维度的关系

| 维度 | 语义 | 权威位置 | 单调性 |
|---|---|---|---|
| `revision` | 并发修订号，CAS 依据；create 成功后从 1 起，每次成功写 +1 | props 行 | 单调 +1 |
| `schemaVersion` | 结构版本，`migrateProps` 驱动；只前进不回退 | props 行 + 角色 meta | 只增不减 |
| `epoch` | 所有权 fencing token；租约顶替时 +1，本人续租不变 | ownership 行 | 严格单调（跨释放保留：release 置 `lease_until=0` 不删行） |
| `lease_until` | 当前租约到期时刻（epoch-ms，DB 时间域） | ownership 行 | 可延长/置 0（释放） |

规则：

- **epoch 是唯一仲裁维度**。`revision` 只解决并发写交错，不解决"谁有资格写"。
- epoch 严格单调：新 owner 拿到的 token 恒大于所有历史 token。因此"当前 ownership 行
  `epoch = token` 且 `owner = token 持有者` 且 `lease_until > now`" 是写入资格的充要条件。
- release 不删行、只置空租约（防旧 token 借"行缺失"复活；也防旧持有者误删新租约）。

## 3. 不变量（每条可映射到反例测试）

**I1（create 带 token）**：启用 ownership 时，`create` 必须携带 `{fencingToken, fencingOwner}`，
且仅当 ownership 行存在、`owner_id` 匹配、`epoch` 匹配、`lease_until > now` 时插入成功。
→ 反例 F1（旧 epoch takeover 后 create 被拒）。

**I2（回退 write 带 token）**：`create` 冲突（`kind="exists"`）后的回退 `write` 与常规 `write`
同等携带 `{fencingToken, fencingOwner}`；不允许任何"无 token 重试"路径。
→ 反例 F2（旧 epoch 回退写被拒）。

**I3（所有权行缺失 = 拒绝）**：fencing 校验从 `NOT EXISTS(epoch > token)` 改为
`EXISTS(owner_id = fencingOwner AND epoch = fencingToken AND lease_until > now)`。
ownership 行缺失、owner 不匹配、epoch 不匹配、租约过期，四者全部拒绝。
→ 反例 F3（行缺失拒绝）、F4（租约过期拒绝）。

**I4（续租失败停止接单）**：租约续期存储异常不再"忽略本轮"。失败累计达到阈值，或本地时钟
推进越过 `lease_until - safetyMargin`，实例必须 invalidate：先停止接单（新 Call 被拒），
再等在飞 Turn settle。恢复后新 owner 接管，旧实例的后续写被 I1–I3 拒绝。
→ 反例 F5（续租挂起 → 推进到租约边界 → 停止接单）。

**I5（production 拒绝不安全 Provider）**：`cluster.mode=production` 要求
`propStore.capabilities.crossNodeSafe && supportsFencing`；`cues` 启用且未注入自定义 store 时
同样要求 CueStore `crossNodeSafe`。显式 `allowUnsafeProviders` 可绕过（仅 dev/test 语义），
但启动日志与事件流必须标记 degraded。
→ 反例 F6（production + SQLite 启动失败）。

**I6（release 竞争安全）**：`release` 仅在 `owner_id` 与 `epoch` 同时匹配时置空租约；
不删除行。

## 4. Props 变更路径矩阵（启用 ownership 时）

| 路径 | 携带 token | 原子校验 | 失败分类 |
|---|---|---|---|
| `create`（首次落盘） | 必带 | 条件插入 ∧ 所有权行有效（I1） | `fencing` / `lease-expired` / `exists` |
| `create` 冲突回退 `write` | 必带（I2） | CAS ∧ 所有权行有效（I3） | `fencing` / `lease-expired` / `revision` |
| `write`（常规 CAS 写） | 必带 | 同上 | 同上 |
| `delete` | 必带 | 条件删除 ∧ 所有权行有效 | `fencing` / `lease-expired` |
| `migrate`（schemaVersion 前进） | 经激活后的首次 `save` 落盘，继承 I1/I2/I3 | 同上 | 同上 |
| reminder-complete（Cue 完成） | P1 的 PG CueStore 用 `statusVersion + owner` CAS；P0 内 Cue 声明不做硬校验（SQLite CueStore 仅 dev/test） | — | — |

**Provider 义务（无模糊表述）**：实现了 `OwnershipStore` 的 Provider，在收到
`fencingToken` + `fencingOwner` 时**必须**在同一原子语句内校验 I1/I3；不支持原子校验的
Provider 必须声明 `capabilities.supportsFencing = false`，并因此在 production 被 I5 拒绝。
"Provider 可选校验"不再存在。

未启用 ownership（单进程 / dev）时，token 缺省，Provider 不做所有权校验——该模式在文档中
明确标注"不承诺跨节点安全"。

## 5. DB 时间与本地时钟的分工

- **租约有效性判定只用 DB 时间**：Provider 在 SQL 内以数据库时钟求值
  （PG：`clock_timestamp()`；SQLite：`strftime` 当前时刻），不依赖调用方传入的 now。
  好处：多节点时钟偏差不再进入资格判定，租约边界只有一个权威。
- **节点本地 `Date.now()`** 只用于：续租节拍调度（leaseMs/3）、safetyMargin 判断的近似提示、
  日志/事件时间戳。本地时钟回拨/漂移不产生资格，也不直接判死（判死由 I4 的失败阈值 + 边界
  近似触发，误杀方向安全）。
- `acquire` 返回值包含 DB 域 `leaseUntil`，供 StageManager 维护 `slot.leaseUntil`。
- 可测试性：反例 F5 用注入 fake clock 的 fake store，不依赖真实墙钟。

## 6. 旧 owner 的外部副作用边界

fencing 只保护**存储层**。旧持有者在失去所有权后仍可能已发出的外部副作用（HTTP 调用、
Show 广播、内存 Cue 已触发的 Turn）不受存储拒绝影响。边界约定：

1. 失去所有权（续租失败 / acquire 失败 / 环漂移交接）→ **先停止接单**（I4），在飞 Turn
   自然 settle，不强行中断；
2. settle 期间产生的 `save` 会被 I2/I3 拒绝并触发 invalidate——数据面不产生双活成功写；
3. 外部副作用由业务层收敛：`ctx.idem` 幂等键 + 至少一次投递语义（DESIGN §6.5）；框架
   不承诺 exactly-once，文档不写"副作用被撤销"。

## 7. 冲突分类

| kind | 触发 |
|---|---|
| `exists` | create 时 props 行已存在（且所有权有效） |
| `revision` | write 时期望 revision 不匹配或 props 行缺失 |
| `fencing` | 所有权行缺失 / owner 不匹配 / epoch 不匹配 |
| `lease-expired` | 所有权行匹配但 `lease_until <= now` |

错误消息包含 epoch/owner 标识（owner_id 是节点身份，非敏感数据；不含 props 内容）。

## 8. 能力声明（capabilities）

```ts
interface StoreCapabilities {
  /** 多节点共享同一存储时语义安全（PG：true；SQLite/内存：false） */
  crossNodeSafe: boolean;
  /** 支持上述 I1/I3 原子校验 */
  supportsFencing: boolean;
  supportsTransactions?: boolean;
}
```

- `InMemoryPropStore`：`crossNodeSafe=false, supportsFencing=false`（无 ownership 实现）。
- `SqlitePropStore`：`crossNodeSafe=false, supportsFencing=true`（同机多进程可共享库文件，
  跨主机共享盘不安全）。
- `PostgresPropStore`：`crossNodeSafe=true, supportsFencing=true`。
- `CueStore` 同样暴露 capabilities，为 P1 PG CueStore 留位。

## 9. 验收与证据

- 每条不变量 I1–I5 对应 `test/ownership-fencing.test.ts` 反例 F1–F6（先红后绿，见 ROADMAP
  §8.2）；涉及真实 PG 的反例在 CI Linux+PG job 必跑，skip 视为失败（P0-7）。
- 代码评审清单：`grep -n "create(" src/core/stage-manager.ts` / 回退 write 分支不存在无 token
  路径；`renewLeases` 异常分支不再是"仅 warn 继续"。
- 本 ADR 单人维护期的评审替代：CI 反例矩阵 + ROADMAP 门禁（不引入"评审人签名"的形式主义）。

## 10. 非目标

- 不在本 ADR 定义目录化路由（P1-1/P1-2 的 `DirectoryStore` ADR 承接）；
- 不定义 Cue 的跨节点 CAS（P1-5）；
- 不处理传输层身份/加密（P1-6）；
- 不承诺 exactly-once 或外部副作用撤销（§6 明确边界）。
