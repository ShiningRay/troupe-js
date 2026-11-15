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

- 传输层无 TLS/加入凭证（P1-6）；目录化路由未实现（P1-1..P1-4）；PG CueStore 未实现（P1-5）。
- Show 为实时尽力投递 + 3 次退避重试，**非 durable**；持久流未实现（P2）。
- 3 节点混沌 harness 未建立（P1-7）；当前多进程证据仅限 m3-chaos 的双 Stage 场景。

相关跟踪：[Issues #1–#4](https://github.com/ShiningRay/troupejs/issues)。#2/#3 已由 P0-7
关闭（optional peer + CI 禁静默跳过）；#1/#4 分别对应 P2-1 / P3-4，未关闭。
