# 集群、运维与部署（Skill 参考）

## 三种部署形态

```typescript
// 1) 单机开发
const troupe = await Troupe.form({ actors });

// 2) 同机多进程（共享 SQLite 目录 + 租约）
const troupe = await Troupe.form({
  actors,
  cluster: { port: 7300, seeds: ["127.0.0.1:7300"] },
  ownership: { leaseMs: 5000 },
}); // PropStore 默认 ./.troupe/props.db（各进程一致）

// 3) 多节点生产
const troupe = await Troupe.form({
  actors,
  propStore: new PostgresPropStore("postgres://…"),
  cluster: { mode: "production", port: 7300, advertise: "10.0.0.2:7300", seeds: ["10.0.0.1:7300"] },
  ownership: { leaseMs: 5000 },
});
```

production 强校验（缺失即启动失败）：固定端口、advertise、必须入团、角色集/协议一致、共享存储连通。

## 所有权语义（§6.5）

- 激活前 acquire 租约（epoch 单调递增 = fencing token）；续期失败/被顶替 → 实例失效
- 环漂移 → 旧持有者排空 → offStage+save → 释放
- 存储层拒收旧 epoch 写入（暂停恢复的旧进程无法污染数据）
- 边界：外部副作用（HTTP/消息）不受租约保护——接收方校验 epoch 或 outbox

## 优雅停机

```typescript
process.on("SIGTERM", () => troupe.shutdown());
// 顺序：广播 leave → 拒收新 Call → 存量 settle → 全员 offStage+save → 关面板/网关
```

## 可观测

| 工具 | 用法 |
|---|---|
| Booth 面板 | `form({ booth: true })` → http://127.0.0.1:7500（成员/Ring/Actor 状态机/指标/Live Trace/Cues/调用面板；集群聚合） |
| CLI | `npm run cli -- status\|roster\|ps\|inspect\|call\|off\|cues\|ring\|tail\|top\|booth\|deploy\|rollback [--to host:port --json]` |
| 端点 | `/healthz`、`/metrics`（Prometheus） |
| Trace | `troupe.traces(n, filter)` / `subscribeTrace`；`form({ onSpan })` 桥 OTel |
| 事件 | `form({ onEvent })`：turnStarted/turnEnded/saveFailed/membershipChanged/showDropped/codeSwapped… |

## 生产热替换（deploy）

```bash
export TROUPE_DEPLOY_SECRET=<secret>
troupe deploy Emergency ./emergency.bundle.js   # 广播所有成员：验签→兼容检查→swap
troupe rollback Emergency                        # 重新部署上一已接受 bundle
```

```typescript
const bundle = { roleId: "Emergency", source: jsString, className: "EmergencyActor", policy: "swap",
                 sig: signBundle(roleId, source, secret) };
await troupe.deployCluster(bundle);   // 汇总各 Stage 结果 { stage, ...| error }
```

- bundle：自包含 JS（data: 求值，无相对导入），导出目标类
- swap：quiesce 后 setPrototypeOf——**不打断流量**（排队请求换码后继续），内存保留
- 兼容检查强制：R1 方法只增不减；R3 schemaVersion 逐级 +1 且覆写 migrateProps；违规输出规则清单
- 回滚 = 重新部署上一已接受 bundle（可往复）

## dev 热重载

```typescript
const reloader = createDevReloader(troupe, {
  watch: ["src/actors/cart.actor.ts"],
  policy: "recycle",            // 或 (roleId) => policy
  onReload: (r) => console.log(r),
});
```

- `recycle`（默认）：下场重登台，Props 无损
- `swap`：内存保留；需守则合规源码（`scanActorSource` 扫描 #private/实例箭头函数/预 bind；违规抛 SwapViolationError）；onCodeSwap 失败自动回滚旧原型
- `keep`：旧实例自然耗尽
- 或 `troupe dev app.ts`：tsx watch 可靠重启路径

## 基准参考（Apple Silicon, loopback, 256B）

| 项 | 数字 |
|---|---|
| 激活 100k Actor | 88,299/s；6.3KB/Actor |
| 单热点 Actor 串行 | ~186k msg/s |
| 跨 Stage 单路 TCP | ~13.5k msg/s（p50 0.07ms） |
| 跨 Stage 并发×8 | ~64k msg/s |
| 本地 saveProps（SQLite WAL） | +0.03ms/写（p99 0.19ms） |
| M3 所有权每写开销 | ≈0（fencing 子查询 + 摊销续租） |

复现：`npm run bench:scale / bench:cluster / bench:sqlite`
