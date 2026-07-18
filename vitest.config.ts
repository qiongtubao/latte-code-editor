/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // 旧 chat 模块已退役到 src/legacy-chat/（损坏状态，不修），不再跑它的测试。
    exclude: ["src/legacy-chat/**", "**/node_modules/**"],
    setupFiles: [],
  },
});
