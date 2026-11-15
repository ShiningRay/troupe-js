# ADR 0003：线协议 v2 与跨语言 golden fixtures

- 状态：已接受（P3-1/P3-2，ROADMAP §5）
- 日期：2026-11-16
- 关联：[ROADMAP P3-1..P3-5](../ROADMAP.md)、[ADR 0004](./0004-directory-ownership.md)、[ADR 0005](./0005-stream-outbox.md)、COMPATIBILITY.md §5（R1–R6）、troupe.cr（Crystal 仓，跨语言一致）
- 编号：本 ADR 即 ROADMAP P3-1 预留的 `0003`

## 1. 现状锚定（v2）

- 帧：**4 字节小端长度前缀 + UTF-8 JSON**，无 magic / 无 CRC（与 ROADMAP 预想的
  "magic + length + CRC" 不同——本 ADR 锚定**实际实现**；CRC 属 P3 后续可选加固，
  引入即 protocolVersion +1）。
- `WIRE_PROTOCOL_VERSION = 2`：join 消息携带 `protocol`，不一致 → `join-nack`（§6.2）；
  roster 应答携带 `protocol`（P1-6），发起方不一致即忽略应答。
- 错误线格式（`WireErr`）：`{ kind: conflict|unknown|rejected|business, name, message,
  reason?, retryable? }`——形状由 golden fixtures 锚定。

## 2. 升级规则（R5 的可执行化）

1. 新增字段：旧版本必须可忽略（JSON 解析天然忽略未知字段；错误分类兜底 `business`）——
   允许混跑。
2. 语义变更/删除字段：**protocolVersion +1** 且 golden fixtures 更新 + 兼容说明；
   旧版本 join 即被拒（显式失败），禁止静默混跑——走全量重启。
3. fixtures 漂移即红：实现变更导致 `test/golden-protocol.test.ts` 失败时，必须显式更新
   `test/golden/protocol-v2.json` 并在提交说明附兼容性结论。

## 3. golden fixtures（跨语言一致）

`test/golden/protocol-v2.json` 锚定：

- `xxh32` 哈希值（目录/环一致性的算术基础）；
- HashRing 成员→键归属（同成员同键同 owner）；
- traceparent 格式（`00-<32hex>-<16hex>-01`）与 traceId 提取；
- 存储信封形状（`__troupe_envelope__`/props/idem——R6 幂等记录结构）；
- `WireErr` 各 kind 的精确形状与往返解码恒等。

troupe.cr 以同一份 JSON 对齐（fixtures 是数据不是代码——两仓各自断言同一锚点）。
CI 漂移检查 = `test/golden-protocol.test.ts`（修改实现不改 fixtures → 红）。

## 4. R1–R6 检查矩阵（P3-4 补全后的状态）

| 规则 | 检查方式 | 位置 |
|---|---|---|
| R1 方法只增不减 | 自动（`compatViolations`） | deploy.ts |
| R2 参数只加可选项 | 自动（`rpcParamCounts`：必选参数个数不增） | deploy.ts（P3-4 新增） |
| R3 schemaVersion 逐级 +1 + migrateProps | 自动（`compatViolations`） | deploy.ts |
| R4 Cue/Show payload 结构 | **人工门禁**（发布说明必含语义评审结论；无静态检查） | COMPATIBILITY.md §6 |
| R5 wire 向后兼容 | 自动（golden fixtures + join protocolVersion 拒绝 + 错误兜底 business） | golden-protocol.test.ts + roster |
| R6 幂等记录指纹结构 | 自动（golden fixtures 信封/idem 形状锚定） | golden-protocol.test.ts |

`compatViolations` 输出含 R4/R5/R6 的可解释状态提示（人工项不静默）。
静态检查是必要条件而非充分条件——语义兼容（R2/R4 的深层语义）仍需发布说明中的人工评审。

## 5. 混合版本与滚动升级（P3-3）

- 混跑窗口内：fencing/租约语义不因版本差异失效（ADR 0002，同 ownership 表）；
- protocolVersion 不一致 → join 拒绝（显式失败，不静默混跑）；
- schema k+1 写入后禁止自动回滚（COMPATIBILITY.md §4：降级 migrateProps 或全量重启 + 人工修复）；
- 升级顺序建议：drain + leave → 升级 → 入环 → 观察 → 下一台。

## 6. 非目标

- 引入帧 magic/CRC（可选加固，留待 protocolVersion 3）；
- 二进制序列化（JSON 保持跨语言零依赖）；
- 强制跨语言混群（golden fixtures 是客户端/目录一致性的基础，混群语义另行立项）。
