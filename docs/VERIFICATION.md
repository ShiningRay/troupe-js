# 验证基线

> 本文是**验证结果的单一来源**：只记录"最近一次 CI + 本机补充"，列出真实跳过项。
> README/文档不得声称本文未记录的能力。能力声明以 CI 与本文为准。

## CI（权威证据）

- 工作流：[.github/workflows/ci.yml](../.github/workflows/ci.yml)，推送/PR 触发，历史见 [Actions](https://github.com/ShiningRay/troupejs/actions)。
- 矩阵：ubuntu-latest / windows-latest × Node 22 / 24（typecheck + build + vitest 全量）。
- **pg-required leg**（Linux + Node 22 + PostgreSQL 16 service）：`TROUPE_REQUIRE_PG=1`，
  任何用例跳过即 job 失败；SIGSTOP/SIGCONT 混沌用例在此 leg 必跑。
- **minimal-install leg**：`npm pack` 产物在无 `pg` 环境安装——`troupe` 核心可导入；
  安装 `pg` 后 `troupe/props/postgres` 可达（issue #2：pg 为 optional peer）。
- 跳过项自动写入 job summary（`scripts/ci-skip-summary.mjs`），不以静默跳过换绿。

## 最近一次 CI 结果

**Run [43746483768](https://github.com/ShiningRay/troupejs/actions/runs/43746483768)（P0-8 文档提交前）：6/6 job 全绿**。
后续以 [Actions 首页](https://github.com/ShiningRay/troupejs/actions)最新 run 为准——本文不复制会过期的数字。P0 完成时的构成：

- 所有权/fencing 反例 F1–F6（`test/ownership-fencing.test.ts`）全绿；
  PG 变体（F1-PG/F3-PG/F4-PG）在 pg-required leg 于真实 PostgreSQL 上执行。
- pg-required leg：168 passed + 1 项"PG 门禁"守卫按设计跳过（URL 已提供时守卫不触发）。

## P1 完成摘要（2026-11-16）

- **目录是路由权威**（P1-1..P1-4）：`DirectoryStore`（PG/SQLite 契约测试）、DirectoryRouter
  （缓存→回源→claim→重读，环只做候选/减载）、同地址重启恢复扫描、handover/renewFailures 指标。
- **PG CueStore 跨节点**（P1-5）：SKIP LOCKED due + CAS claim/complete；契约竞争唯一胜者
  （CI pg-required 真实 PG 必跑）；cron timeZone（Intl，无效名显式拒绝）。
- **生产默认安全**（P1-6）：production 强制 TLS（cluster.tls）+ adminToken；join 预共享
  token + 限速；dir 通道鉴权（wire 级测试）。
- **3 节点混沌**（P1-4/P1-7）：冻结 owner → 判死 → 幸存方接管（epoch+1）→ 恢复后 FENCED；
  at-least-once 重放语义显式断言。nightly（每日 UTC 03:00）跑全矩阵 + PG 必需 leg。

## 本机补充（Windows 11 / Node 24，commit `63d20c9`）

| 命令 | 结果 | 边界 |
|---|---|---|
| `pnpm typecheck` | 通过 | 静态检查，不证明分布式行为 |
| `pnpm build` | 通过 | 构建完成 |
| `pnpm test` | 38 文件通过；160+ 通过 / 8 跳过（见下） | 本机 PG 有密码认证（凭据不可用），PG 用例交给 CI 必跑 |

本机真实跳过项（CI 中为必跑）：

1. `postgres.test.ts` 3 项——本机 PG 连接认证失败（不重试凭据，交由 pg-required leg）；
2. `ownership-fencing.test.ts` PG 反例 3 项（F1-PG/F3-PG/F4-PG）+ 门禁守卫 1 项——同上；
3. `m3-chaos.test.ts` SIGSTOP/SIGCONT 1 项——Windows 无该信号（pg-required leg 必跑）。

## 已知边界（不是"已验证"）

- 网络分区注入以 SIGSTOP 近似（toxiproxy/tc netem 未接入 nightly；P1-7 余项）。
- Show 为实时尽力投递 + 3 次退避重试，**非 durable**；持久流未实现（P2）。
- cron 未显式 timeZone 时保持服务器本地时间（ROADMAP 曾建议默认 UTC——兼容性取舍，显式
  timeZone + validateTimeZone 已实现，见 P1-5）。
- 密钥/证书轮换为文档约定（双钥宽限未自动化，P1-6 部署步骤见 README ops 节）。
- P3（协议 golden fixtures、混合版本滚动升级、热替换 R1–R6 检查补全）未开始。

相关跟踪：[Issues #1–#4](https://github.com/ShiningRay/troupejs/issues)。#2/#3 已由 P0-7
关闭；#1/#4 分别对应 P2-1 / P3-4，未关闭。
