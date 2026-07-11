import type {
  ChatProtocolMessage,
  ChatProtocolStatus,
  ChatRenderer,
} from "../protocol";
import type { ChatEvent, ChatTurn, SwarmEvent } from "../types";
import {
  parseChatEvent,
  extractControllerRoles,
  deriveStatusFromEvent,
  extractPrompt,
} from "../protocol";

/**
 * React 适配器：把后端各种事件源（chat:event 联合体 / chat:turn 单条
 * / chat:swarm_event）转为统一的协议层消息。
 *
 * 不关心调用方是 React、CLI、HTML 还是测试 — 调用方只需实现
 * ChatRenderer 接口即可接收协议消息。store 通过 setState 回调消费
 * 内部状态实现 React 集成。
 */
export class ReactChatEventAdapter implements ChatRenderer {
  private _messages: ChatProtocolMessage[] = [];
  private _status: ChatProtocolStatus = "idle";
  private _errorMessage: string | null = null;
  private _currentPrompt: { icon: string; roleId: string; modelId: string } | null = null;
  private _unknownRoles: { id: string; name: string; icon: string }[] = [];

  private _onStateChange: (state: {
    messages: ChatProtocolMessage[];
    status: ChatProtocolStatus;
    errorMessage: string | null;
    currentPrompt: { icon: string; roleId: string; modelId: string } | null;
    unknownRoles: { id: string; name: string; icon: string }[];
  }) => void;

  constructor(
    onStateChange: (state: {
      messages: ChatProtocolMessage[];
      status: ChatProtocolStatus;
      errorMessage: string | null;
      currentPrompt: { icon: string; roleId: string; modelId: string } | null;
      unknownRoles: { id: string; name: string; icon: string }[];
    }) => void,
  ) {
    this._onStateChange = onStateChange;
  }

  // ─── ChatRenderer 接口实现 ─────────────────────────────

  onMessage(msg: ChatProtocolMessage): void {
    this._messages = [...this._messages, msg];
    this._emit();
  }

  setMessages(msgs: ChatProtocolMessage[]): void {
    this._messages = msgs;
    this._emit();
  }

  setStatus(status: ChatProtocolStatus): void {
    this._status = status;
    this._emit();
  }

  setError(error: string | null): void {
    this._errorMessage = error;
    this._emit();
  }

  setCurrentPrompt(prompt: { icon: string; roleId: string; modelId: string } | null): void {
    this._currentPrompt = prompt;
    this._emit();
  }

  // ─── 高等级方法：把各种后端事件接入协议层 ─────────────

  /** 应用一个 chat:event 联合体事件（兼容老协议） */
  applyChatEvent(event: ChatEvent): void {
    this._applyCommon(event);
    const msg = parseChatEvent(event, this._unknownRoles);
    if (msg) this._messages = [...this._messages, msg];

    const status = deriveStatusFromEvent(event);
    if (status !== null) this._status = status;

    if (typeof event === "object" && event !== null && "Error" in event) {
      this._errorMessage = event.Error.message;
    }

    const prompt = extractPrompt(event);
    if (prompt) this._currentPrompt = prompt;

    this._emit();
  }

  /** 应用一条 chat:turn 单条事件（pi-dev 当前协议） */
  applyTurn(turn: ChatTurn): void {
    this._messages = [
      ...this._messages,
      {
        id: `turn-${Date.now()}-${this._messages.length}`,
        role: "agent",
        agentIcon: turn.icon,
        agentName: turn.agent,
        content: turn.response,
        timestamp: Date.now(),
        // 带出 ChatTurn 的角色/轮次信息
        roleId: turn.roleId,
        round: turn.round,
        stepId: turn.stepId,
      },
    ];
    this._status = "running";
    this._emit();
  }

  /** 应用一个 chat:swarm_event */
  applySwarmEvent(event: SwarmEvent): void {
    // Swarm 事件有多种 kind：plan/step/summary/file/complete/error
    // 协议层只关心能映射成展示消息的 kind
    const ts = Date.now();
    if (event.kind === "plan") {
      const steps = event.steps ?? [];
      const content = steps.length > 0
        ? `**Plan (${steps.length} steps):**\n\n` +
          steps.map((st, i) => `${i + 1}. **${st.role}** — ${st.instruction}`).join("\n")
        : "_(planner emitted no steps)_";
      this._messages = [...this._messages, {
        id: `plan-${ts}-${this._messages.length}`,
        role: "agent",
        agentIcon: "🪄",
        agentName: "planner",
        content,
        timestamp: ts,
      }];
    } else if (event.kind === "step" && event.turn) {
      const t = event.turn;
      this._messages = [...this._messages, {
        id: `step-${ts}-${this._messages.length}`,
        role: "agent",
        agentIcon: t.icon || "💬",
        agentName: t.agent,
        content: t.response,
        timestamp: ts,
        // 带出 TurnPayload 的全部结构化字段
        roleId: t.roleId,
        round: t.round,
        stepId: t.stepId,
        messageId: t.messageId,
        weight: t.weight,
        pinned: t.pinned,
      }];
    } else if (event.kind === "summary" && event.content) {
      this._messages = [...this._messages, {
        id: `summary-${ts}-${this._messages.length}`,
        role: "agent",
        agentIcon: "✨",
        agentName: "synthesis",
        content: event.content,
        timestamp: ts,
      }];
      this._status = "completed";
    } else if (event.kind === "complete") {
      this._status = "completed";
    } else if (event.kind === "error") {
      this._status = "error";
      this._errorMessage = event.content ?? "swarm error";
    }
    this._emit();
  }

  /** 重置 adapter 状态 */
  reset(): void {
    this._messages = [];
    this._status = "idle";
    this._errorMessage = null;
    this._currentPrompt = null;
    this._unknownRoles = [];
    this._emit();
  }

  get messages(): ChatProtocolMessage[] {
    return this._messages;
  }

  get status(): ChatProtocolStatus {
    return this._status;
  }

  get errorMessage(): string | null {
    return this._errorMessage;
  }

  // ─── 内部 ────────────────────────────────────

  private _applyCommon(event: ChatEvent): void {
    const controllerRoles = extractControllerRoles(event);
    if (controllerRoles.length > 0) {
      this._unknownRoles = controllerRoles;
    }
  }

  private _emit(): void {
    this._onStateChange({
      messages: this._messages,
      status: this._status,
      errorMessage: this._errorMessage,
      currentPrompt: this._currentPrompt,
      unknownRoles: this._unknownRoles,
    });
  }
}
