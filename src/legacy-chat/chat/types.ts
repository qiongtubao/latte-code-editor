// chat 协议层入口：导出所有渲染器无关的类型和接口
// 任何 UI（React/CLI/HTML）通过此层即可展示 chat
//
// 设计原则：
// - chat/ 内部定义渲染器无关的协议类型（消息/状态/接口）
// - api/chat.ts 里与具体后端事件相关的类型（SwarmEvent/ManagerStatus 等）由本层 re-export
// - 业务代码只 import "chat/types"，不直接依赖 api/chat
//   这样未来切换协议或新增渲染器都只动这一层

// ─── 协议核心类型 ───────────────────────────────────────
export type {
  ChatProtocolMessage,
  ChatProtocolStatus,
  ChatProtocolState,
  ChatRenderer,
  ChatMessageRole,
  ControllerRoleInfo,
  DecisionOption,
  DecisionRequest,
  ManagerStatus,
} from "./protocol";

export {
  parseChatEvent,
  extractControllerRoles,
  deriveStatusFromEvent,
  extractPrompt,
} from "./protocol";

// ─── 后端原始事件/请求/响应类型（re-export）─────────────
// 这些类型由后端直接产出，协议层负责消费；上层 UI 只通过 chat/types 引用
export type { ChatEvent, SwarmEvent, SwarmStepSpec } from "../api/chat";
export type { ChatTurn } from "../hooks/useChatStore";
