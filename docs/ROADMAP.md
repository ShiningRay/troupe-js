# Troupe.js Orleans 对标路线图

> 本文按验收门禁排列，不给未实现的分布式能力标注完成日期。跨语言共同契约由 [troupe-planning](https://github.com/ShiningRay/troupe-planning) 协调。

## 0. 建立可信基线（优先）

- [ ] 修复 [#2](https://github.com/ShiningRay/troupejs/issues/2)：明确 `pg` 的 optional peer 或独立适配包；测试最小安装与启用 Provider 安装。
- [ ] 建立 CI：typecheck、build、Vitest、Linux PostgreSQL、POSIX SIGSTOP/SIGCONT；必需环境缺失时失败，不静默跳过 [#3](https://github.com/ShiningRay/troupejs/issues/3)。
- [ ] 修正 [#1](https://github.com/ShiningRay/troupejs/issues/1) 的 Show 文档和代码注释，明确当前有界重试与丢失窗口。
- [ ] 明确 [#4](https://github.com/ShiningRay/troupejs/issues/4) 的 R1–R6 自动/人工检查边界。

**门禁**：从干净 checkout 安装可复现；测试报告列出拓扑、Provider 和跳过原因，不再以单数字代替生产证据。

## 1. 生产容错闭环

- [ ] 为 CueStore 提供 PostgreSQL 实现：原子 due claim、租约、statusVersion、时钟约定与所有权一致。
- [ ] 用至少三个独立进程和真实 PostgreSQL 验证扩容交接、硬杀、租约到期接管、旧 epoch 拒绝、reminders 重投。
- [ ] 明确续租失败时的 stop-serving 策略和租约时钟偏差假设，覆盖存储不可达场景。
- [ ] 引入分区/丢包/乱序故障注入，测量收敛时间、重复激活防护和 pending-call 结果。
- [ ] 制定传输认证、加密和密钥轮换；不能以“受控网络”替代最终的生产安全方案。

**门禁**：真实共享存储、多进程/多机拓扑下，同一 Actor 不出现未防护的双活成功写；进程冻结恢复后的旧写均被拒绝；提醒恢复经幂等测试。

## 2. 明确可靠消息边界

- [ ] 按 [#1](https://github.com/ShiningRay/troupejs/issues/1) 选择 Show 语义：保留实时通知并明确丢弃，或实现真正的持久流。
- [ ] 若选择可靠模式：定义事件 ID、持久 outbox、订阅游标、ack/nack、保留策略、重放、背压和幂等消费。
- [ ] 评估复用 NATS JetStream / Redis Streams 等队列，而不是在 SQLite 订阅表上叠加不完整协议。
- [ ] 统一普通 RPC 的超时、取消、重试与 UnknownOutcome，添加协作取消传播，禁止框架默认盲目重试副作用调用。

**门禁**：发布者/coordinator/消费者分别宕机后的恢复有实证；重放顺序、重复、保留和慢消费者均有定义，不承诺 exactly-once。

## 3. 目录、放置与弹性

- [ ] 在统一规划 ADR 决定继续 HashRing+ownership 还是引入版本化 grain directory。
- [ ] 设计注册/注销、缓存失效、视图版本、交接和目录恢复；StatelessWorker 另作多实例语义。
- [ ] 加入 capabilities、资源指标和 placement policy 扩展点，逐步支持 prefer-local、resource-aware 与 activation rebalancing。
- [ ] 对热点、冷启动、资源倾斜和大规模目录进行统一基准，保留旧基准口径以便比较。

**门禁**：目录视图变更和崩溃恢复不会静默产生多 owner；放置可解释、可观测、可回退到简单策略。

## 4. 版本化编程模型与互操作

- [ ] 与统一规划定义 namespace/type/key、activation incarnation、方法 ID、payload schema、错误、deadline/cancellation、trace context。
- [ ] 保持 TypeScript 的强类型开发体验，以显式 manifest/生成器替代私有反射约定进入线协议。
- [ ] 先完成协议兼容测试与 golden fixtures，再决定与其他语言实际混群。
- [ ] 将热替换兼容元数据与版本协商关联，完善 [#4](https://github.com/ShiningRay/troupejs/issues/4)。

**门禁**：协议升级有 backward/forward 兼容用例；不同类型系统不依赖语言私有序列化；不回传敏感堆栈。

## 5. 按需的高级能力

- 持久状态快照与事件溯源分离；先证明 Outbox，再评估事务。
- 分布式 ACID 事务需要独立设计参与方、恢复、隔离级别和存储协议，不能由单机 CAS 推导。
- Booth/OTel 扩展到目录、放置、流和恢复指标；发布流程包含包签名、迁移、回滚和版本矩阵。
