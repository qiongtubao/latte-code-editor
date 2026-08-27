// ESLint 配置（flat config）。
//
// 取向：**只管正确性，不管风格**。格式化交给编辑器，这里的规则要能抓住真实
// bug。选型的决定性因素是 react-hooks/exhaustive-deps —— 之前修过的
// CodeMirrorEditor 过期闭包（订阅回调空依赖，永久持有首次渲染的 buildEditor）
// 正是它能直接指出来的类别。
//
// 排除 src/legacy-chat：它已被 tsconfig exclude，不参与类型检查也不参与测试，
// 纳入 lint 只会产生一堆无人处理的噪音。

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "target/**",
      "src-tauri/**",
      "src/legacy-chat/**",
      "public/**",
      "node_modules/**",
      "apps/**",
      "packages/**",
      "crates/**",
      "tests/**",
      "test-results/**",
      ".latte/**",
      ".omc/**",
      "*.config.ts",
      "*.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: { ...globals.browser, ...globals.es2024 },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // ---- 本轮实际踩到过的 bug 类别 ----
      // 过期闭包 / 依赖缺项（CodeMirrorEditor 的 buildEditor）
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
      // 不可达的 else-if 分支（App.tsx 的 Ctrl+Alt+Shift+S 被抢占）
      "no-unreachable": "error",
      "no-dupe-else-if": "error",
      // 空的 catch / 空分支（App.tsx 的空 Ctrl+Shift+M、被吞掉的错误）
      // 注意 allowEmptyCatch: false —— 静默 catch 是这个项目的高发问题
      "no-empty": ["error", { allowEmptyCatch: false }],
      // await 漏写导致的竞态（refreshCurrentFile 那类）
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "require-atomic-updates": "warn",

      // ---- 降噪：这些在本项目里属于有意为之或价值不高 ----
      // 大量 invoke<T>() 的 IPC 边界需要 as 断言
      "@typescript-eslint/no-explicit-any": "warn",
      // 测试与调试代码里 _ 前缀参数是约定
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 类型感知规则需要 TS project 信息
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
