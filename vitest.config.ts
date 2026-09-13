import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 集群/混沌测试对事件循环时序敏感（SIGSTOP、kill -9、租约到期）：
    // 文件间串行执行，避免并行负载导致时序判据抖动；文件内用例仍并行。
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
