# 陷阱与反模式（每条都来自真实 bug 或验收反例）

## 状态与引用

**症状**：调用方修改传入参数/返回值后，Actor 状态"莫名"变化或毫无变化。

原因：参数与返回值默认经过 JSON 复制边界（本地也复制）。教训：
- 让所有方法签名只携带可序列化 DTO
- 需要"写回"就再调一次方法，不要 hack 引用
- `localCallByReference: true` 只在性能专项时考虑，且写明语义分叉

**症状**：`SerializationError: BigInt/Map/Set/函数/Agent 引用`。
修复：改用 string/number/普通对象/数组；要传 Actor 引用就传 `(roleId, stageName)` 让对端 cast。

**症状**：`items.push is not a function`。
原因：首次登台 Props 是 `{}`。修复：`static initialProps` 工厂。

## 持久化与幂等

**症状**：客户端收到成功但崩溃后操作丢失。
原因：返回成功在 `saveProps` 之前（攒批模式）。修复：持久成功语义——先 `await saveProps()` 再 return；或明示 RPO 窗口用 group commit。

**症状**：`idempotent` 重试永远拿到同一个"暂不可用"结果。
原因：把失败当结果记录了（helper 会重放）。修复：失败要么 throw（helper 记录错误也会重放——同样不行），**要么把失败路径移出 idempotent**：受理幂等（记录 requestId）+ at 提醒驱动的内部重试状态机。

**症状**：同 requestId 重复扣款。
原因：没有幂等键，或升级后指纹算法变了（R6：指纹算法不得变更）。

**症状**：CAS 冲突后 Actor 数据"回退"。
这是设计行为：保存失败/冲突 → 实例失效 → 重载最后已提交快照。业务侧用幂等键重试即可。

## 执行模型

**症状**：某个调用慢，整个 Actor 所有后续调用排队。
这是严格串行的本义。缓解：拆分 Actor 粒度、`@Improv/@ReadOnly`（确认容忍中间态）、缩短单 Turn 耗时。

**症状**：在方法里 `await sleep(超时)` 做轮询，Actor 卡死。
修复：延时一律 `scheduleReminder(name, { at })`；轮询改为事件驱动。

**症状**：并发下出现"扣减已生效但后续步骤未做"的中间状态被别的调用读到。
原因：开了 `@Improv/@ReadOnly` 交错。这不是 bug——标注前必须确认方法容忍中间态；不能容忍就别标注。

**症状**：`CallRejectedError(reason="backpressure")`。
单 Actor 队列满（1024）或 Stage 全局预算超限。处理：背压是特性——调用方退避重试；容量规划见 bench:scale。

## 定时与提醒

**症状**：`@Cron` 不触发。
检查：`form({ cues: true })` 是否开启（未开时 form 直接报错）；表达式是 5 字段本地时间。

**症状**：提醒重复执行了业务动作。
至少一次投递的固有语义：`onCue` 里按 `(name, payload)` 幂等。

**症状**：错过多个周期后"连发"。
设计为合并补发一次（不追赶）。需要精确调度就用一次性 `at`。

## 集群与所有权

**症状**：多节点出现双活/互相覆盖。
原因：未启用所有权。修复：共享存储（SQLite 同机 / Postgres 多机）+ `form({ ownership })`；production 模式强制。

**症状**：`deployLocal` 报"角色未在本 Stage 注册"。
每个 Stage 只加载自己的 actors——广播部署前确保目标角色在所有成员的 form({actors}) 里。

**症状**：暂停很久（SIGSTOP/GC 停顿）的进程恢复后写入被拒。
这是 fencing 生效（租约已被接管、epoch 已递增）。该 Stage 实例已失效重载——正确行为。

## 热重载

**症状**：`SwapViolationError`。
守则扫描命中：去 #private 字段、实例箭头函数属性、预 bind 方法；或改用 recycle（Props 无损）。

**症状**：swap 后新方法访问不到某些字段。
新类字段初始化器不会重跑——状态必须在 props（守则 1）。

**症状**：reload 后 cast 旧类引用报"未注册"。
已修复的行为：按 roleId 解析。若仍出现，检查两个类 `static role` 是否一致。

## 编解码

**症状**：拿到的时间是字符串。
`Date` 过边界变 ISO 字符串——接口签名用 string，对端 `new Date(s)`。

**症状**：`undefined` 字段消失。
JSON 语义。可选字段用 `null` 表达显式空。
