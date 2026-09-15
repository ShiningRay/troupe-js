# 运维手册

## 部署形态

| 形态 | 配置 | 保证 |
|---|---|---|
| 单机开发 | `Troupe.form({ actors })` | loopback，SQLite 进程级持久 |
| 同机多进程 | 各进程共享 `TROUPE_PROPS_DIR` + `cluster: { port, seeds }` + `ownership` | SQLite 兼容多进程写；租约 + fencing 防双活 |
| 多节点生产 | `PostgresPropStore` + `cluster: { mode: "production", port, advertise, seeds }` + `ownership` | 节点级恢复；所有权交接；production 启动强校验 |

production 模式强制：固定端口（被占即败）、显式 `advertise`、必须成功入团、角色/协议/共享存储校验。

## 所有权（防双活）

- 激活前置 acquire（租约），500ms 续期调度；丢失即失效
- 环漂移 → 旧持有者主动交接：排空 → offStage+save → 释放
- `write` 携 fencingToken：暂停后恢复的旧持有者写入被存储拒绝
- ⚠️ 租约不保护**外部副作用**：HTTP/消息接收方需校验 epoch 或用 outbox

## 可观测

- **Booth**：`form({ booth: true })` → `http://127.0.0.1:7500`（SSE 实时；成员/在场 Actor 状态机/指标/事件流/Ring/Live Trace/Cues/详情/调用与下场面板；集群聚合）
- **CLI**（`npm run cli` / `troupe <cmd> --to host:port --json`）：`status roster ps inspect call off cues ring tail top booth deploy rollback dev`
- **端点**：`/healthz`、`/metrics`（Prometheus 文本：calls/errors/rejections/延迟分位数）
- **基准**：`npm run bench:scale`（十万级：88k activations/s、6.3KB/Actor、热点 186k vs 分散 132k msg/s）；`npm run bench:cluster`；`npm run bench:sqlite`

## 生产热替换（L2，独立实验）

```bash
TROUPE_DEPLOY_SECRET=<secret> troupe ...
troupe deploy Emergency ./emergency.bundle.js   # 广播各 Stage：验签 → 兼容检查 → swap 热替换
troupe rollback Emergency                        # 重新部署上一已接受 bundle
```

- bundle = 自包含 JS（data: 求值，无相对导入）；签名 HMAC-SHA256
- swap = quiesce 后 setPrototypeOf：内存保留、不打断流量（排队请求换码后继续）
- 守则（静态扫描强制 + 人工评审）：状态全在 props / 禁 #private / 无实例箭头函数 / 无预 bind / 构造器无副作用 / onCodeSwap 失败自动回滚
- 兼容规则：R1 方法只增不减；R3 schemaVersion 逐级 +1 且必须覆写 migrateProps

## dev 热重载

```typescript
// 进程内策略热替换
const reloader = createDevReloader(troupe, { watch: ["src/actors"], policy: "recycle", onReload: console.log });
```

或 `troupe dev app.ts`（tsx watch 可靠重启路径）。策略：`recycle`（默认，Props 无损）/ `swap`（守则扫描通过后内存保留）/ `keep`。

## 优雅停机

`troupe.shutdown()`：广播 leave → 拒收新 Call → 存量 settle → 全员 offStage+saveProps → 关闭 Booth/BoxOffice。SIGTERM/SIGINT 接此通道。

## 全局背压

- 每 Actor：CallBoard 深度（1024）
- 每 Stage：激活数（10k）、排队字节（64MB）、连接 in-flight
- 超限抛 `CallRejectedError(reason="backpressure", retryable=true)`

## 调用链追踪

```typescript
const troupe = await Troupe.form({
  onSpan: (s) => otelExporter(s),   // s.traceparent = W3C 格式；桥接真实 OTel SDK
});
troupe.traces(50, { roleId: "Cart" });  // 最近 50 条（环形缓冲 1 万，含超时态）
troupe.subscribeTrace({ method: "add" }, fn);  // 实时订阅
```

调用链自动传播：Actor 内 `this.cast` 携带当前 Turn span 作父；跨 Stage 经 wire 信封透传（同 traceId、不同 spanId）。
