import { defineConfig } from "vitest/config";

// 独立的测试配置：覆盖 vite.config.ts 里 root=src/renderer 的设置，
// 让 vitest 从项目根扫描所有 src/**/*.test.ts（主进程纯函数等）。
export default defineConfig({
  test: {
    root: ".",
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
});
