# ADR 0004：目录化所有权（Directory-Backed Ownership）

- 状态：已接受（P1-1，ROADMAP §3）
- 日期：2026-11-16
- 关联：[ROADMAP P1-1..P1-4](../ROADMAP.md)、[ADR 0002](./0002-ownership-fencing.md)（fencing 不变量，本文不重复定义）、跨语言统一规划（troupe-planning）
- 编号说明：`0003` 保留给 P3-1 的 wire protocol v2，本 ADR 顺延为 0004

## 1. 决策

**将 ownership 表提升为权威 Actor 目录；HashRing 从"归属裁决者"降级为"候选生成器 / 减载器"。**

现状（M3）：`Playbill.ownerOf` 用 HashRing 回答"归谁"，所有权 acquire 只在**激活**与**续租**
时作为资格检查——环与租约不一致时（扩容交接窗口、探测误判、网络分区），环仍会把 Call
路由到非持有者，后者激活失败（`ownership` 拒绝）才暴露问题。

目标：路由读目录、不读环。环只在两处起作用：

1. **候选生成**：目录无条目（Actor 首次被调用）时，用环选出一个候选节点发起 claim——
   避免所有节点同时抢同一个冷键；
2. **减载（建议性迁移）**：成员变更后，环认为"应归属他者"的条目产生**迁移建议**，
   新 owner claim 成功（epoch+1）后旧 owner 才 drain——环永不直接改变归属。

## 2. 目录模型

沿用 ownership 表（P1-2 扩展，保持兼容），条目即目录记录：

| 字段 | 语义 |
|---|---|
| `namespace / role_id / stage_name` | 键（=现有 Props 三元组） |
| `owner_id` | 持有者 Stage 身份（`addr#incarnation`） |
| `epoch` | fencing token（ADR 0002，严格单调） |
| `lease_until` | 租约到期（DB 时钟域） |
| `version` | 单调版本号（缓存失效依据；每次 owner/epoch/lease/status 变更 +1） |
| `status` | `active`（租约有效）/ `draining`（向新 owner 交接中）/ `tombstone`（已注销，等待清理） |

- **单库范围**：这是 PG-backed directory，**不是分区 DHT**。单 PostgreSQL 的目录容量与
  延迟足够中小型集群；分区（按 namespace 或键段拆库）留到容量证据出现后再做（非目标，
  见 §7）。
- 与 Orleans 的差异：Orleans 用内存目录 + grain directory 随机化多写点 + 消息去重；
  本设计以共享存储为单点权威，用租约续期保活性——牺牲一部分目录写入吞吐，
  换取"谁是 owner"永远只有一个可判定来源。

## 3. 路由算法（伪代码，P1-3 实现）

```
route(key) -> 处理节点:
  e = cache.get(key)
  if e 存在 and e.version 与目录视图一致 and not expired(e.ttl):
      return e.owner                      # 快路径：纯缓存命中
  entry = directory.lookup(key)           # 回源（PG）
  if entry 存在 and entry.status == active and entry.lease_until > DB_NOW:
      cache.put(key, entry)               # 有效条目：缓存并转发
      return entry.owner
  if entry 存在 and entry.status == draining:
      cache.put(key, entry)
      return entry.owner                  # 交接中：仍路由旧 owner（它持有租约与 fencing 资格）
  # 无条目 / 过期 / tombstone → 争取所有权
  candidate = ring.candidates(key).first  # 环只在这里参与：选发起 claim 的候选
  me_first = ring.candidates(key).includes(self)   # 本节点在候选前列则自己先试
  if me_first:
      r = directory.claim(key, self, leaseMs)       # 原 acquire：过期顶替 epoch+1
      if r.ok: cache.put(key, self); return self
  # claim 落败 → 重读目录，以目录为准（不回退到环）
  entry = directory.lookup(key)
  cache.put(key, entry)
  return entry?.owner ?? retry_with_backoff()       # PG 短暂不一致：退避重试，不用环猜
```

要点：

- **缓存 TTL**：默认 `min(leaseMs / 3, 2s)`；条目携带 `version`，目录变更通知/成员变更
  事件按版本失效，TTL 只是兜底——miss 必须回源，不允许"缓存说谁就是谁"。
- **视图版本**：目录读取返回 `(entry, version)`；本地成员视图变更（roster 事件）时
  不猜测新归属，只把**全部缓存条目标记 stale**，下一条消息回源。不实现主动推送失效
  （单库下 LISTEN/NOTIFY 为 P1 后可选优化，非 P1 门禁）。
- **冷启动**：目录无条目 + 候选含自身 → 本节点 claim；落败方重读目录而不是用环继续猜。
- **本地激活不变**：StageManager 的激活/续租/fencing 路径（ADR 0002）完全复用，
  目录只是把 `isRingOwner` 替换为"目录说我是 owner"。

## 4. Handoff 与恢复（P1-4）

- **扩容/缩容**：成员变更 → 环产生迁移建议 → 新 owner `claim`（epoch+1，顶替旧租约需等
  `lease_until` 过期或旧 owner 主动 `release`）→ 旧 owner 下一次续租发现 `!isOwner` →
  drain（quiesce → offStage+save → release）→ 目录条目 owner 更新。旧 owner 在 drain 期间
  的写入被新 epoch fencing 拒（ADR 0002 I3）——交接不会产生双活成功写。
- **启动恢复**：节点重启（新 incarnation）→ 扫描目录 `owner_id` 前缀匹配本节点的条目 →
  `claim`（epoch+1 顶替自己的旧身份，重启即新身份语义不变）。
- **tombstone**：`delete` Props 成功后目录条目置 `tombstone`（保留 epoch 单调历史），
  由后台清理（P1-4 的定期任务）删除超过保留期的 tombstone；防止"删除后旧缓存/旧租约复活"。
- **在飞 Call**：所有权变化窗口内的在飞 Call，旧 owner 的应答仍有效（它当时持有资格）；
  调用方超时按既有 `UnknownOutcome` 语义处理，不新增投递语义。

## 5. 失败模式逐条处理

| 失败模式 | 处理 |
|---|---|
| PG 不可达 | 快路径缓存仍可**转发**（只读决策），但**不得 claim/迁移/续租**；续租失败走 ADR 0002 I4 停服；冷键（无缓存）不可激活——调用方收到 `ownership` 拒绝可重试。禁用"PG 不可达时退回环猜测"——宁可拒绝，不可双活 |
| 缓存过期 | TTL 过期即 stale，下一条消息回源；回源失败按上一行处理 |
| 缓存与目录不一致（版本落后） | 转发到旧 owner：其续租/激活会发现自己已非 owner 而拒绝（资格检查兜底），调用方重试经回源修正路由——版本落后只损失一次往返，不产生双写 |
| 双 owner（网络分区内各自 claim 成功？） | 不可能：claim 是单库行锁原子操作（顶替要求 `lease_until <= DB_NOW`），分区内至多一方拿到更大 epoch；被隔离方的旧 epoch 写被 I3 拒。分区恢复后目录以高 epoch 方为准 |
| 目录条目丢失（误删） | claim 按"无条目"重新建立（epoch 从 1 重计）——fencing 资格重新成立；epoch 单调性仅在"条目存在"期间保证，此为已知边界（记录于 §7 非目标） |
| 慢目录（PG 延迟升高） | 缓存命中率观测（P1-7 指标）+ TTL 上限保护；连续回源超时 → 该键路由拒绝（可重试），不做环回退 |

## 6. 验收映射（对应 ROADMAP 门禁）

- P1-2：`DirectoryStore` 契约测试——claim 竞争、过期顶替、release、version 递增、tombstone（真实 PG）。
- P1-3：`Cluster.ownerOf` 改 async 后——环与目录不一致时路由以目录为准（构造不一致的反例）；
  缓存命中/失效/回源单测；缓存过期不会把 Call 发给已释放 owner。
- P1-4：3 进程 kill 旧 owner → 新 owner 在租约内接管；旧 owner 恢复后不能成功写（复用 F 系反例语义）；
  无重复成功写；handoff 指标可见。

## 7. 非目标

- 分区目录 / 多目录副本 / 目录服务独立进程（单库容量证据出现前不做）；
- 主动失效推送（LISTEN/NOTIFY）作为 P1 门禁项（后续可选优化）；
- 跨语言混群目录协议（P3 前）；epoch 跨"条目删除重建"的全局单调（记录为已知边界）。
