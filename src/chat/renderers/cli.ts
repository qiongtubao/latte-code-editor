import type {
  ChatProtocolMessage,
  ChatProtocolStatus,
  ChatRenderer,
} from "../protocol";

/**
 * CLI 渲染器：把协议层消息输出为纯文本/ANSI 颜色。
 * 不依赖 React、DOM、Tauri，纯 stdio 友好。
 * 任何实现了 ChatRenderer 接口的 UI（HTML/Slack/Web）都可以用同样的协议层。
 */
export class CliRenderer implements ChatRenderer {
  private _messages: ChatProtocolMessage[] = [];
  private _status: ChatProtocolStatus = "idle";
  private _errorMessage: string | null = null;
  private _currentPrompt: { icon: string; roleId: string; modelId: string } | null = null;

  private _out: (line: string) => void;
  private _useColor: boolean;

  constructor(opts: { out?: (line: string) => void; useColor?: boolean } = {}) {
    this._out = opts.out ?? ((line) => process.stdout.write(line + "\n"));
    // 简单的 TTY 检测：非 TTY 时关闭颜色（避免破坏日志文件）
    this._useColor = opts.useColor ?? Boolean(process.stdout.isTTY);
  }

  // ─── ChatRenderer 接口 ──────────────────────────────

  onMessage(msg: ChatProtocolMessage): void {
    this._messages = [...this._messages, msg];
    this._printMessage(msg);
  }

  setMessages(msgs: ChatProtocolMessage[]): void {
    this._messages = msgs;
    // 重新打印整段（重连/回放场景）
    this._out(this._color("\n── 重放消息历史 ──", "cyan"));
    for (const m of msgs) {
      this._printMessage(m);
    }
    this._out(this._color("── 历史结束 ──\n", "cyan"));
  }

  setStatus(status: ChatProtocolStatus): void {
    this._status = status;
    const tag = this._color(`[${status}]`, "magenta");
    this._out(`${tag} 状态变更`);
  }

  setError(error: string | null): void {
    this._errorMessage = error;
    if (error) {
      this._out(this._color(`✖ 错误: ${error}`, "red"));
    }
  }

  setCurrentPrompt(prompt: { icon: string; roleId: string; modelId: string } | null): void {
    this._currentPrompt = prompt;
    if (prompt) {
      const line = `${prompt.icon} ${prompt.roleId} · ${this._color(prompt.modelId, "yellow")} ›`;
      this._out(this._color(line, "green"));
    }
  }

  // ─── 消息格式化 ─────────────────────────────

  private _printMessage(m: ChatProtocolMessage): void {
    if (m.role === "user") {
      this._out(this._color(`\n👤 你:`, "blue"));
      this._out(m.content);
    } else if (m.role === "agent") {
      const tag = `${m.agentIcon ?? "💬"} ${m.agentName ?? "agent"}`;
      this._out(this._color(`\n${tag}:`, "cyan"));
      this._out(m.content);
    } else {
      // system
      const tag = `${m.agentIcon ?? "ℹ"} ${m.agentName ?? "system"}`;
      this._out(this._color(`  [${tag}] ${m.content}`, "gray"));
    }
  }

  // ─── 颜色工具 ───────────────────────────────

  private _color(text: string, color: "red" | "green" | "yellow" | "blue" | "cyan" | "magenta" | "gray"): string {
    if (!this._useColor) return text;
    const codes: Record<typeof color, string> = {
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      cyan: "\x1b[36m",
      magenta: "\x1b[35m",
      gray: "\x1b[90m",
    };
    return `${codes[color]}${text}\x1b[0m`;
  }

  // ─── 读访问器（供 CLI 命令循环使用）───────────

  get messages(): readonly ChatProtocolMessage[] {
    return this._messages;
  }

  get status(): ChatProtocolStatus {
    return this._status;
  }

  get errorMessage(): string | null {
    return this._errorMessage;
  }

  get currentPrompt() {
    return this._currentPrompt;
  }
}
