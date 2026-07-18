// CLI 入口：演示 chat 协议层如何与不同渲染器解耦
//
// 真实场景：CLI 进程会监听 Tauri 事件总线（通过 stdio RPC/Unix socket 桥接）
// 这里用 mock 事件流演示：协议层解析 → CLI 渲染器输出
//
// 任何实现 ChatRenderer 接口的 UI（HTML/React/CLI/Slack/...）都可以共用 protocol.ts

import { CliRenderer } from "./renderers/cli";
import {
  parseChatEvent,
  extractControllerRoles,
  deriveStatusFromEvent,
  extractPrompt,
} from "./protocol";
import type { ChatEvent } from "./types";

/**
 * 把"后端 ChatEvent 流"接入渲染器。
 * 真实 CLI 进程里，这里替换成 `tauri::Manager::listen("chat:event", ...)` 的 stdio 桥。
 */
function feedRenderer(renderer: CliRenderer, events: ChatEvent[]): void {
  for (const event of events) {
    const controllerRoles = extractControllerRoles(event);
    if (controllerRoles.length > 0) {
      // 协议层只关心角色名/图标，不需要 modelChain 等
      // 真实场景下可注入到 parseChatEvent 的第二个参数
    }
    const msg = parseChatEvent(event, []);
    if (msg) renderer.onMessage(msg);
    const status = deriveStatusFromEvent(event);
    if (status) renderer.setStatus(status);
    const prompt = extractPrompt(event);
    if (prompt) renderer.setCurrentPrompt(prompt);
    if (typeof event === "object" && event !== null && "Error" in event) {
      renderer.setError(event.Error.message);
    }
  }
}

// ─── Demo: 模拟多角色 chat 流 ──────────────────────────
const demo: ChatEvent[] = [
  { SessionInfo: { task_id: "demo", state: "Running", turn: 0, roles: [] } },
  { Status: { message: "[roles: pm, programmer]" } },
  { Status: { message: "[pm round 1: calling LLM...]" } },
  {
    RoleTurn: {
      role_id: "pm",
      content: "需求分析：用户希望 chat 协议层可对接任意 UI 渲染器。",
      is_complete: true,
    },
  },
  { Status: { message: "[programmer round 1: calling LLM...]" } },
  {
    RoleTurn: {
      role_id: "programmer",
      content: "实现：把 controllerEventMessage 抽到 src/chat/protocol.ts，所有渲染器共用。",
      is_complete: true,
    },
  },
  { RoundStarted: { round: 1 } },
  { RoundEnded: { round: 1 } },
  { Paused: { reason: "用户暂停" } },
  "Resumed",
  { Status: { message: "[继续：触发下一轮]" } },
  { ToolUse: { role_id: "programmer", tool_name: "edit_file", args: '{"path": "src/chat/protocol.ts"}' } },
  { ToolResult: { role_id: "programmer", tool_name: "edit_file", result: "ok" } },
  "Done",
];

const renderer = new CliRenderer({ useColor: true });
feedRenderer(renderer, demo);

console.log("\n— 演示结束 —");
console.log(`共接收 ${renderer.messages.length} 条协议消息，最终状态: ${renderer.status}`);
