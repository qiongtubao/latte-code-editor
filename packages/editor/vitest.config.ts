import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "monaco-editor": new URL("./node_modules/monaco-editor/esm/vs/editor/editor.api.js", import.meta.url).pathname,
    },
  },
});
