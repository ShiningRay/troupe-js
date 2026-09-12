# Troupe.js 设计审查

审查日期：2026-09-12。范围仅为 DESIGN.md 与 PLAN.md，不包含 HashRing 及其实现。本文是设计审查，指出的是规范缺口、承诺矛盾和实施风险，不代表这些问题已经存在于尚未实现的 TypeScript 运行时中。原设计及计划未修改。

整体判断：Virtual Actor、显式保存状态、单进程 Stage、Provider 扩展及统一管理接口构成了清晰的方向；应先把执行、归属和持久化语义定下来，再扩展热替换、流和管理界面。目前“设计定稿”的状态偏早。

优先级：P1 表示进入对应实现阶段前应解决；P2 表示应补入设计或调整排期。接受某项风险也是可行选择，但必须同步缩小对外承诺与适用场景。

**1. [P1] 一致性哈希决定路由，尚未定义 Actor 所有权交接**

位置：[DESIGN.md:249](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:249)、[DESIGN.md:264](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:264)、[PLAN.md:50](/Users/shiningray/projects/__playground__/troupejs/PLAN.md:50)。

风险不只发生在已明确接受的网络分区中。正常扩容时，旧 Stage 仍可能在执行一个未完成的调用，新 Stage 根据新环接收请求并加载同一 Actor；共享 PropStore 中此时可能只有旧快照。文档没有说明旧实例何时停止接单、停止 Cue、保存并释放所有权，也没有说明新实例必须等待什么条件。

Props 的乐观并发控制可以拒绝过期快照写入，但无法撤回已返回成功的业务响应、已发出的外部请求或双活期间的陈旧读取。它还需要在写入冲突后明确处理旧实例。把所有权问题全部推到二期，会直接限制一期所宣传的库存、配额等严格一致场景。

建议保留 HashRing 作为候选节点选择算法，在其后增加独立的所有权契约。生产集群可利用已计划引入的共享 Postgres 实现所有权记录、租约和单调递增的 fencing token；获得所有权后才激活，失去所有权后停止接单，存储拒绝旧 token。租约本身不能阻止暂停后恢复的旧代码继续执行，外部副作用还需接收方校验 token，或使用持久化 outbox 与业务幂等。交接流程应包含旧实例排空、落盘和释放。

如果一期坚持无协调服务，可以明确定位为允许重复激活的实验性集群，但需要删除强一致业务的无条件保证。无需为了补所有权协议，同时实现任意放置策略和完整目录。

**2. [P1] 库存示例先返回成功、后刷盘，不能保证“不丢单”**

位置：[DESIGN.md:451](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:451)、[DESIGN.md:472](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:472)、[DESIGN.md:263](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:263)。

反例：持久库存为 1；请求 A 扣为 0 并收到成功；尚未达到 100 次或周期 flush 时进程崩溃；重新激活后恢复库存 1；请求 B 又成功。A 的 requestId 同样没有落盘，幂等键无法恢复这次已确认的操作。客户端既然已收到成功，也未必会重试。

对示例批处理规则的最小 JavaScript 模型已经复现：初始库存 1，崩溃前后两个不同订单均收到成功。这是文档算法模型验证，不是项目运行时测试。

建议将成功语义明确为两种选择：持久成功须在响应前原子提交库存变更和幂等结果；可丢失更新则明确标注容许的数据丢失窗口。若要批量提交，多个请求可以共同等待一次持久化完成后再返回。性能宣传应在这两种语义下分别测量。

“Call 失败可安全重试”也应修改：超时和断连只能说明调用结果未知。需要记录业务操作键、参数指纹及原始结果，并与状态原子提交；同键不同参数应拒绝，记录保留期限应明确。订单创建与库存扣减跨 Actor 时，还需要补偿流程或 outbox，不能从单 Actor 串行推导出跨 Actor 事务。

**3. [P1] 随机心跳与固定失联时间的组合缺少有效故障探测规则**

位置：[DESIGN.md:240](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:240)、[PLAN.md:44](/Users/shiningray/projects/__playground__/troupejs/PLAN.md:44)。

每秒随机选一个节点通信，不能保证 5 秒内与每个健康节点都有直接心跳。如果按“5 秒没有直接交换就判死”理解，在 N 个节点独立均匀抽样、双向任一发起都算交换的简化模型中，某一对健康节点 5 轮没有交换的概率为 `(1 - 1/(N-1))^10`；10 节点约 30.8%，100 节点约 90.3%。这不是完整协议的误判率，而是说明当前字面规则不足以定义协议。

若间接 gossip 也能续期，则需要定义新鲜度证据；不能让反复转发的旧 alive 状态一直复活死节点。当前还缺节点重启身份、incarnation、suspect 状态、反驳规则、死亡记录保留与合并优先级。

建议把“传播成员状态”和“检测某节点失效”分开：对实际发出的探测等待 ACK，再进入怀疑和确认流程；为重启分配新的身份代次，使用单调版本合并成员记录。若生产一致性依赖共享存储，优先采用其协调能力，减少自建协议的范围。验收需要健康多节点、丢包、乱序、事件循环暂停和分区恢复，双节点正常通信不足以证明正确性。

**4. [P1] 超时、交错执行与生命周期尚未形成完整调度契约**

位置：[DESIGN.md:195](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:195)、[DESIGN.md:215](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:215)、[DESIGN.md:413](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:413)。

调用方超时不等于 Actor 方法停止。若实现通过超时 Promise 释放串行队列，旧方法之后仍可能继续修改 Props，与新调用交错；若继续等待原方法，则不能承诺超时一定解除执行阻塞。最小 JavaScript 实验已确认 `Promise.race` 返回超时后原任务仍继续执行。

建议将调用响应期限与执行占用分开：排队中过期的请求不开始执行；已经开始的请求允许向调用方返回超时，但原执行结束前不能释放独占资格。提供协作取消信号，并明确不支持强制取消任意用户代码。永久挂起任务的恢复需要进程隔离、实例失效及所有权保护策略，不能靠抛出超时错误解决。

同时补一张运行时状态表：未激活、激活中、运行中、排空中、失效。第一次并发调用共享一个激活 Promise；下场期间的新请求等待或得到明确拒绝；生命周期钩子、Cue、管理操作均受调度约束。

`@Improv` 需要定义当前调用和待调度调用之间的允许组合，`@ReadOnly` 需要明确是否只允许读与读交错以及如何防止写调用饥饿。JS 单线程并不能提供跨 await 的业务原子性。启用交错后，quiesce 必须等待所有运行中请求及框架回调结束，不能只等待一个“当前 turn”。建议 M1 先实现严格串行，将交错调度作为独立阶段。

**5. [P1] PropStore 将并发修订号和数据结构版本混在一起**

位置：[DESIGN.md:272](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:272)、[DESIGN.md:279](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:279)、[DESIGN.md:305](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:305)、[DESIGN.md:395](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:395)。

并发修订号应在每次成功写入时变化，schemaVersion 应在状态结构演进时变化。用一个 version 同时做 CAS 和 migrateProps 的输入，无法清晰表达“写了很多次，但结构仍是第一版”。接口也未约定 version 是期望值还是新值、首次创建如何竞争、冲突如何返回及写入结果不确定时如何恢复。

建议拆成 `{ props, revision, schemaVersion }`，写入显式接收 `expectedRevision` 并返回新 revision，首次创建使用明确的不存在条件；所有权 token 是另一个维度。即使仍使用数字 revision，也应写出原子比较更新的 Provider 合同。

保存失败时，内存 Props 已经被业务修改。简单抛错会让下一次调用继续基于未提交状态运行；明确采用恢复上次已提交快照，或将实例失效后重新加载等策略。冲突时尤其不能让旧实例在 offStage 中无条件再保存。

首次 Props 为 `{}` 与 Cart 的 `items.push`、Inventory 的 `reservedBy[requestId]` 不兼容。需要初始化工厂或显式初始状态钩子。JSON 能成功解析也不代表满足 TypeScript 接口，迁移应由 schemaVersion 主动驱动，并提供运行时验证入口。

**6. [P1] 持久 Cue 的发现、争抢和执行恢复缺少接口支撑**

位置：[DESIGN.md:134](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:134)、[DESIGN.md:279](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:279)、[PLAN.md:175](/Users/shiningray/projects/__playground__/troupejs/PLAN.md:175)。

PropStore 只有按 Actor 键 read/write，无法支撑“扫描全部到期 Cue”。Actor 已下场或整个集群重启时，框架还需要在激活之前发现提醒，并在多个 Stage 中分配执行责任。`onStage` 注册的任意闭包不能作为可恢复记录直接持久化；即使通过重新运行注册逻辑绑定回调，也需要约定稳定名称、调度记录和代码绑定方式。

建议区分随实例消失的内存定时器与独立持久提醒。后者保存 Actor 身份、提醒名、可序列化负载、计划、时区、nextDue 和状态版本，以 `onCue(name, payload)` 等稳定入口分派。增加 CueStore 的到期查询、原子 claim、租约与完成确认接口。

明确处理过程中宕机时的重复投递、错过多个周期时跳过还是合并补发、重入与续期、注销竞争。可采用至少一次投递并要求幂等，但不能仅凭“持久化记录 + 启动扫描”承诺执行恰好一次。[Orleans 的提醒文档](https://learn.microsoft.com/en-us/dotnet/orleans/grains/timers-and-reminders#reminders)也区分持久定义与单次触发，并明确错过触发的行为；Troupe 可以选择不同策略，但必须定义。

**7. [P1，开放跨节点部署前] TCP 业务调用的信任边界与方法白名单缺失**

位置：[DESIGN.md:224](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:224)、[DESIGN.md:322](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:322)、[DESIGN.md:432](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:432)、[DESIGN.md:495](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:495)。

默认监听所有网卡，TCP 信封可以直接指定 role、method 和 args，但鉴权只写在 Edge 与 Director 部分。如果网络可达且实现直接接收这种业务信封，调用方即可绕过 HTTP Edge 的校验和授权。Director token 不能自动保护普通 Actor 通道。

建议单机默认绑定 loopback；集群模式定义可信节点加入验证、clusterId、传输保护与角色/方法白名单。允许依赖受控网络提供隔离，但应将其写成部署前提。接收端始终验证信封和参数，不按任意字符串直接访问实例属性；生命周期、基类方法、构造器及内部管理入口不能被普通 RPC 调用。

还需在解码前限制帧长度、连接缓冲和未完成请求数。错误协议区分业务异常、请求拒绝、执行结果未知与存储冲突，stack 默认只进入内部诊断通道。管理授权在首个入口验证后，跨 Stage 扇出仍需保留已验证的权限上下文。

**8. [P2] 类型代理、本地调用与注册机制需要保持边界一致**

位置：[DESIGN.md:96](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:96)、[DESIGN.md:123](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:123)、[DESIGN.md:234](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:234)、[DESIGN.md:337](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:337)。

Agent<T> 的类型应仅暴露 RPC 方法，屏蔽 Props、生命周期和运行时成员，并统一远程方法的 Promise 返回类型；Proxy 需处理 then、Symbol 和调试访问，避免被当成 Promise 或误发 RPC。编译期类型过滤不能替代接收端的方法白名单。

默认 JSON 需要说明 Date、BigInt、Map、undefined、循环引用与 Actor 引用的处理。尤其应约定本地调用是否也经过同样的编解码/复制边界；否则本地调用传入对象可能和 Actor 共享引用，远程调用却不会，Rehearsal 也可能掩盖部署后的差异。

静态 role 字段本身不会把类自动加入进程注册表，因此“无装饰器等价物”的注册入口需要补全。建议允许 `form({ actors: [CartActor] })`，装饰器作为便利语法；每个 Troupe 使用自己的注册表快照，便于同进程测试多个实例。集群 join 至少校验角色集合和协议版本，避免将调用哈希到未加载该角色的 Stage。

类名默认可服务于原型开发，但它同时影响持久化身份；类重命名或构建产物改名可能使旧状态无法寻址。持久业务应能声明稳定 roleId；存储键还应有 cluster/application namespace，避免多个环境共用后端时串数据。

**9. [P2] 热替换的安全承诺过强，优先级高于基础兼容性**

位置：[DESIGN.md:363](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:363)、[DESIGN.md:383](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:383)、[DESIGN.md:403](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:403)、[PLAN.md:115](/Users/shiningray/projects/__playground__/troupejs/PLAN.md:115)。

“recycle 对任意代码绝对安全”缺少前提：需要成功排空、状态兼容、钩子成功以及所有外部资源被释放。用户 fire-and-forget 任务、事件监听器或被保存到其他模块的闭包，不会因为框架暂停 CallBoard 而自动消失。

swap 守则还应覆盖实例箭头函数、已 bind 的方法、装饰器生成包装、继承链和构造器副作用。onCodeSwap 失败后如何回退，以及代码回滚能否读取新 schema，都没有定义。方法和参数 diff 也无法验证业务语义兼容。

ESM 查询串能产生新的模块实例，但不能单独等同于完整的可回收热加载方案；需要稳定保留运行时单例、处理旧依赖/资源释放并测量反复重载的内存变化。这一判断基于 [Node 的 ESM URL 缓存规则](https://nodejs.org/api/esm.html#urls)。

建议把滚动混跑的协议/schema 兼容规范提前至第一个生产集群版本，dev 优先使用可靠的重启或 recycle。生产 setPrototypeOf 热替换保留为后期独立实验，不应成为核心框架的前置交付压力。

**10. [P2] 默认值、容量边界与里程碑需要围绕可验证语义重排**

位置：[DESIGN.md:210](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:210)、[DESIGN.md:322](/Users/shiningray/projects/__playground__/troupejs/DESIGN.md:322)、[PLAN.md:31](/Users/shiningray/projects/__playground__/troupejs/PLAN.md:31)、[PLAN.md:153](/Users/shiningray/projects/__playground__/troupejs/PLAN.md:153)。

每 Actor 队列 1024 只能限制单个热点。大量不同 Actor ID、大参数、未完成 RPC 和 Trace 结果仍可耗尽进程内存。应增加每 Stage 的激活数、总排队字节数、in-flight RPC、连接写缓冲和 Trace 字节预算，并让调度定期让出事件循环。单个热点 Actor 仍只有一个串行执行通道，增加 Stage 只能扩展不同 Actor 的负载；压测应覆盖热点倾斜。

端口冲突自动换端口及 seeds 不可达后自成一团适合开发，生产却可能产生被路由配置遗漏的节点或意外独立集群。建议增加明确的部署模式：开发保留便利默认值，生产固定端口、明确 advertiseAddress、显式要求入团，并验证共享存储和配置一致性。

`Node >=22.5` 不满足“默认 SQLite 无额外启动参数”的完整承诺：22.5 引入该模块，22.13 才在 22.x 移除 `--experimental-sqlite` 要求。应按实际使用 API 定最低小版本并加入最低版本启动检查。[Node 官方版本记录](https://nodejs.org/api/sqlite.html)支持这一点。另外 DatabaseSync 同步执行，Promise 包装不能消除主线程阻塞，需测量磁盘写入对整个 Stage 延迟和心跳的影响。[Node DatabaseSync 文档](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html#class-databasesync)。

M1 已依赖 Props 加载/下场保存，PropStore 合同却到 M3 才定义；应把接口、InMemory 实现、初始化和冲突语义提前。M2 的“正确结果”“漂移期不丢失”“一个心跳内收敛”需补故障条件与可测定义，不能把随机传播的目标时间写成无条件保证。PLAN 引用的 DESIGN §3 Greeter 实际是 Cart 示例，应同步修正验收指向。

建议采用以下实施顺序：

| 顺序 | 交付内容 | 关键验收 |
|---|---|---|
| M0 | 执行、失败、持久成功、所有权和兼容性契约 | 对每个承诺能写出反例及对应防护 |
| M1 | 严格串行运行时、生命周期状态机、显式注册、PropStore 合同与内存实现 | 并发首次调用只激活一次；超时不放行旧任务；保存失败不污染后续调用 |
| M2 | 本地持久化、编解码一致性、TCP、全局背压与信任边界 | 本地/远程/测试模式数据行为一致；畸形帧可控拒绝 |
| M3 | 共享持久化、成员协议与所有权交接 | 正常扩容、失联、暂停恢复均不破坏选定一致性级别 |
| M4 | 持久 Cue、最小 Director/CLI、基础指标 | 下场及集群重启后可发现提醒；重复投递策略可验证 |
| 后续 | 交错执行、Show/Audience、Booth、dev 热加载、生产热替换 | 每项以独立语义和容量预算验收 |

观测埋点与测试注入接口从 M1 开始保留；完整管理界面和动画可以后移。“核心零 npm 依赖”可作为交付偏好，不宜优先于协议正确性和维护成本。

值得补入验收计划的场景：

| 场景 | 要验证的性质 |
|---|---|
| 首次同时调用、下场同时来新请求 | 激活单飞与生命周期互斥 |
| 超时后旧异步任务继续、A→B→A | 执行占用与等待超时的区别 |
| 已提交但响应丢失、已响应但尚未提交 | 幂等恢复和成功持久性的边界 |
| CAS 冲突、保存结果未知、迁移失败 | 不继续使用失效或未提交状态 |
| 正常扩容时旧调用未结束 | 所有权交接与状态快照一致 |
| 事件循环暂停、网络分区、旧节点恢复 | 误判处理和旧持有者写入保护 |
| Cue 到期后执行一半宕机 | 重新发现、重复投递与业务幂等 |
| 新旧代码混跑、升级后回滚 | 协议及状态的兼容性 |
| 热点 Actor、大量唯一 ID、慢接收方 | 全局内存预算与过载拒绝 |

建议第一步是补齐前六项的语义与反例验收，再更新 PLAN 的先后关系。这样可以保留现有产品方向，同时减少后续实现到一半才需要改接口和执行模型的风险。
