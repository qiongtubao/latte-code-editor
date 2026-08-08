// chatBridge — 编辑器 → chat iframe 的反向调用单例（阶段 3b，design §5.1 LatteUiApi）。
//
// ChatAgentPanel 在 iframe load（latte:init 发出后）register contentWindow+origin，
// url 变化/卸载时 unregister。编辑器各处（选区/图谱节点/文件树）经
// "ask-agent" CustomEvent → App.tsx → 本模块把代码引用打进 chat 输入框。
//
// 缓冲语义：未 register（面板未开过 / server 未就绪 / iframe 重载中）时
// 调用入队，register 时按序 flush；unregister 后回到缓冲态。只插入不发送
// （UI 侧 insertContext 行为），用户确认后自己发。

/** editor → chat 的代码引用（path 相对工作区根）。 */
export interface ContextRef {
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  quote?: string;
}

type UiMethod = "insertContext" | "focus";

interface UiCallMessage {
  type: "latte:ui-call";
  method: UiMethod;
  args: unknown[];
}

/** 缓冲上限：面板一直不开时无界增长没意义，丢弃最旧的。 */
const MAX_QUEUED = 50;

let channel: { win: Window; origin: string } | null = null;
let queue: UiCallMessage[] = [];
/** 最近一次 setSkin 的 chat 变量，register 新通道时补应用。 */
let pendingSkin: Record<string, string> | null = null;

/** iframe 就绪：登记通道并 flush 缓冲。重复 register 以新通道为准。 */
export function register(win: Window, origin: string): void {
  channel = { win, origin };
  const pending = queue;
  queue = [];
  for (const msg of pending) deliver(msg);
  // 换肤先于面板打开/切工作区重挂 iframe 时，把缓存的皮肤补进新文档。
  if (pendingSkin) applySkinTo(channel.win, pendingSkin);
}

/** iframe 离场：回到缓冲态。origin 不匹配（旧 iframe 的迟到清理）则忽略。 */
export function unregister(origin: string): void {
  if (channel && channel.origin === origin) channel = null;
}

function deliver(msg: UiCallMessage): void {
  channel?.win.postMessage(msg, channel.origin);
}

function send(msg: UiCallMessage): void {
  if (!channel) {
    if (queue.length >= MAX_QUEUED) queue.shift(); // 溢出丢弃最旧（保留最新意图）
    queue.push(msg);
    return;
  }
  deliver(msg);
}

/** 同源直写 iframe :root 变量（iframe 与编辑器同源，无需 postMessage）。 */
function applySkinTo(win: Window, vars: Record<string, string>): void {
  try {
    const el = win.document?.documentElement;
    if (!el) return;
    for (const [key, value] of Object.entries(vars)) {
      el.style.setProperty(key, value);
    }
  } catch {
    // iframe 尚在 about:blank / 重载途中拿不到 document，下一帧 register 会补。
  }
}

/**
 * 编辑器换肤 → chat iframe 跟随（皮肤机制的联动半边，见 src/skins.ts）。
 * 未 register 时缓存，register 时补应用；只写变量不触达 chat UI 代码。
 */
export function setSkin(chatVars: Record<string, string>): void {
  pendingSkin = chatVars;
  if (channel) applySkinTo(channel.win, chatVars);
}

/** 把代码引用（含可选 quote）插进 chat 输入框。 */
export function insertContext(ref: ContextRef): void {
  send({ type: "latte:ui-call", method: "insertContext", args: [ref] });
}

/** 聚焦 chat 输入框。 */
export function focus(): void {
  send({ type: "latte:ui-call", method: "focus", args: [] });
}

/**
 * 绝对路径 → 相对工作区根。root 为空、abs 不在 root 下时原样返回
 * （chat UI 收到绝对路径也能原样展示）。
 */
export function toWorkspaceRel(abs: string, root: string | null | undefined): string {
  if (!root) return abs;
  const normRoot = root.replace(/\/+$/, "");
  if (abs === normRoot) return ".";
  const prefix = `${normRoot}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

/** 测试专用：清空通道与缓冲。 */
export function _resetForTests(): void {
  channel = null;
  queue = [];
  pendingSkin = null;
}
