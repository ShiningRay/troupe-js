# 验证基线（2026-11-14）

环境：Windows、Node.js v24.18.0，工作树 `75d52c4`（文档提交前）。

| 命令 | 结果 | 边界 |
|---|---|---|
| `pnpm test` | 35 文件通过，2 文件跳过；155 测试通过，4 跳过 | PostgreSQL 3 项因本机连接认证失败跳过；SIGSTOP 1 项因 Windows 跳过 |
| `pnpm typecheck` | 通过 | TypeScript 静态检查，不证明分布式行为 |
| `pnpm build` | 通过 | 构建完成，不证明发布包可选依赖安装 |

本轮测试由审计实际执行；不是 CI 结果，未重新执行多机 PostgreSQL 或 POSIX 暂停恢复。历史性能结果属于不同时间/机器，不在本次重新测量。

相关跟踪：[Issues #1–#4](https://github.com/ShiningRay/troupejs/issues)。本文随文档更新，不代表这些 Issues 已解决。
