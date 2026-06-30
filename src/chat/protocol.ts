import type { ChatEvent } from "../api/chat";

// ─── 协议层消息类型 ─────────────────────────────────────────────
// 与 UI 框架无关，任何渲染器（React/CLI/HTML）都消费此类型

export type ChatMessageRole = "user" | "agent" | "system";

/** 协议层统一消息：后端原始 ChatEvent 解析后的结构化结果 */
export interface ChatProtocolMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  agentIcon?: string;
  agentName?: string;
  timestamp: number;
}

export type ChatProtocolStatus = "idle" | "running" | "completed" | "error";

// ─── Renderer 接口 ────────────────────────────────────────────
// 任何 UI 展示器实现此接口即可接入 chat 协议层

export interface ChatRenderer {
  /** 收到一条新消息 */
  onMessage(msg: ChatProtocolMessage): void;
  /** 批量设置消息列表（初始加载 / 清空） */
  setMessages(msgs: ChatProtocolMessage[]): void;
  /** 更新运行状态 */
  setStatus(status: ChatProtocolStatus): void;
  /** 设置错误消息 */
  setError(error: string | null): void;
  /** 设置当前 prompt 信息（角色/模型） */
  setCurrentPrompt(prompt: { icon: string; roleId: string; modelId: string } | null): void;
}

// ─── 暂停决策相关 ─────────────────────────────────────────────

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  workerRole: string | null;
  estimatedCostUsd: number;
}

export interface DecisionRequest {
  sessionId: number;
  branchLabel: string;
  question: string;
  reason: string;
  options: DecisionOption[];
  contextSummary: string;
}

export interface ManagerStatus {
  sessionId: number;
  state: string;
  phaseLabel: string;
  managerRoleId: string;
  managerRoleName: string;
  managerIcon: string;
  currentModel: string;
  modelChain: string[];
  isStubMode: boolean;
  availableWorkers: string[];
  stepsTaken: number;
  maxTotalSteps: number;
  decisionsTaken: number;
  maxUserDecisions: number;
  transcriptBytes: number;
  summaryBytes: number;
  tokensEstimated: number;
  elapsedMs: number;
  lastStepAtMs: number;
}

export interface ChatProtocolState {
  messages: ChatProtocolMessage[];
  status: ChatProtocolStatus;
  sessionId: number | null;
  currentPrompt: { icon: string; roleId: string; modelId: string } | null;
  errorMessage: string | null;
  lastUserTopic: string | null;
  pendingDecision: DecisionRequest | null;
  managerStatus: ManagerStatus | null;
  managerSessionId: number | null;
}

// ─── 渲染器函数 ───────────────────────────────────────────────
// 纯函数，从 ChatEvent 解析为协议消息

let _nextId = 1;
function uid(): string {
  return `pm${Date.now()}-${_nextId++}`;
}

export interface ControllerRoleInfo {
  id: string;
  name: string;
  icon: string;
}

function roleNameAndIcon(
  roleId: string,
  knownRoles: { id: string; name: string; icon: string }[],
  controllerRoles: ControllerRoleInfo[],
): { name: string; icon: string } {
  const fromUi = knownRoles.find((r) => r.id === roleId);
  if (fromUi) return { name: fromUi.name || roleId, icon: fromUi.icon || "💬" };
  const fromController = controllerRoles.find((r) => r.id === roleId);
  if (fromController) {
    return { name: fromController.name || roleId, icon: fromController.icon || "💬" };
  }
  return { name: roleId, icon: "💬" };
}

/** 将后端原始 ChatEvent 解析为协议层消息，返回 null 表示该事件不需展示 */
export function parseChatEvent(
  event: ChatEvent,
  knownRoles: { id: string; name: string; icon: string }[],
): ChatProtocolMessage | null {
  if (typeof event === "string") {
    if (event === "Done") {
      return {
        id: uid(),
        role: "system",
        content: "Chat session completed.",
        timestamp: Date.now(),
        agentIcon: "✓",
        agentName: "system",
      };
    }
    if (event === "ContextCleared") {
      return {
        id: uid(),
        role: "system",
        content: "Context cleared.",
        timestamp: Date.now(),
        agentIcon: "⟲",
        agentName: "system",
      };
    }
    if (event === "Resumed") {
      return {
        id: uid(),
        role: "system",
        content: "Session resumed.",
        timestamp: Date.now(),
        agentIcon: "▶",
        agentName: "system",
      };
    }
    return null;
  }

  if ("RoleTurn" in event) {
    const info = roleNameAndIcon(event.RoleTurn.role_id, knownRoles, []);
    return {
      id: uid(),
      role: "agent",
      agentIcon: info.icon,
      agentName: info.name,
      content: event.RoleTurn.content,
      timestamp: Date.now(),
    };
  }

  if ("Status" in event) {
    return {
      id: uid(),
      role: "system",
      agentIcon: "ℹ",
      agentName: "status",
      content: event.Status.message,
      timestamp: Date.now(),
    };
  }

  if ("Paused" in event) {
    return {
      id: uid(),
      role: "system",
      agentIcon: "Ⅱ",
      agentName: "paused",
      content: event.Paused.reason,
      timestamp: Date.now(),
    };
  }

  if ("RoundStarted" in event) {
    return {
      id: uid(),
      role: "system",
      agentIcon: "#",
      agentName: "round",
      content: `Round ${event.RoundStarted.round} started.`,
      timestamp: Date.now(),
    };
  }

  if ("RoundEnded" in event) {
    return {
      id: uid(),
      role: "system",
      agentIcon: "#",
      agentName: "round",
      content: `Round ${event.RoundEnded.round} ended.`,
      timestamp: Date.now(),
    };
  }

  if ("Error" in event) {
    return {
      id: uid(),
      role: "system",
      agentIcon: "!",
      agentName: "error",
      content: event.Error.message,
      timestamp: Date.now(),
    };
  }

  if ("ToolUse" in event) {
    return {
      id: uid(),
      role: "system",
      agentIcon: "⌘",
      agentName: event.ToolUse.role_id,
      content: `Tool: ${event.ToolUse.tool_name}\n${event.ToolUse.args}`,
      timestamp: Date.now(),
    };
  }

  if ("ToolResult" in event) {
    return {
      id: uid(),
      role: "system",
      agentIcon: "⌘",
      agentName: event.ToolResult.role_id,
      content: `Tool result: ${event.ToolResult.tool_name}\n${event.ToolResult.result}`,
      timestamp: Date.now(),
    };
  }

  return null;
}

/** 提取事件中携带的 controllerRoles 信息 */
export function extractControllerRoles(event: ChatEvent): ControllerRoleInfo[] {
  if (typeof event === "object" && event !== null) {
    if ("SessionInfo" in event) return event.SessionInfo.roles;
    if ("RoleList" in event) return event.RoleList.roles;
  }
  return [];
}

/** 根据 ChatEvent 推导状态变化 */
export function deriveStatusFromEvent(event: ChatEvent): ChatProtocolStatus | null {
  if (event === "Done") return "completed";
  if (event === "Resumed") return "running";
  if (event === "ContextCleared") return "idle";
  if (typeof event === "object" && event !== null) {
    if ("Error" in event) return "error";
    if ("Paused" in event) return "idle";
    if ("SessionInfo" in event) return "running";
  }
  return null;
}

/** 根据 ChatEvent 提取当前 prompt 信息 */
export function extractPrompt(event: ChatEvent): { icon: string; roleId: string; modelId: string } | null {
  if (typeof event === "object" && event !== null && "Prompt" in event) {
    return {
      icon: event.Prompt.icon,
      roleId: event.Prompt.role_id,
      modelId: event.Prompt.model_id,
    };
  }
  return null;
}