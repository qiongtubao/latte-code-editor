import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 显式钉 127.0.0.1：本机 `localhost` 先解析到 ::1，而 vite 只监听 IPv4。
    // WKWebView 的 HTTP 请求会回退到 IPv4，但 HMR WebSocket 不回退，
    // 表现为 `ws://localhost:1420/?token=... The request timed out`。
    host: host || "127.0.0.1",
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : { protocol: "ws", host: "127.0.0.1", port: 1420 },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
