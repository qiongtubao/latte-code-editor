import { create } from "zustand";
import type {
  ChatConfigTarget,
  ChatEvent,
  HilMessage,
  HilRoleHistory,
  HilSessionState,
  HilSessionSummary,
  ModelInfo,
  RoleConfigResponse,
  RoleInfo,
  SwarmEvent,
  SwarmStepSpec,
  WorkflowPayload,
} from "../api/chat";
import {
  continueHilSession as apiContinueHilSession,
  editHilMessage as apiEditHilMessage,
  getHilState as apiGetHilState,
  injectHilMessage as apiInjectHilMessage,
  listHilSessions as apiListHilSessions,
  sendHilMessage as apiSendHilMessage,
  startHilSession as apiStartHilSession,
  transitionHilSession as apiTransitionHilSession,
  listModels,
  getRoleConfig,
  setRoleModel as apiSetRoleModel,
  setRoleModelChain as apiSetRoleModelChain,
  setDefaultModel as apiSetDefaultModel,
  openConfig as apiOpenConfig,
  startDiscussion,
  startSwarm,
  continueDiscussion,
  cancelDiscussion,
  saveWorkflow as apiSaveWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  resetRolesToDefaults as apiResetRolesToDefaults,
  startManagerSession as startManagerSessionApi,
  submitUserDecision as submitUserDecisionApi,
  submitUserContinue as submitUserContinueApi,
  spawnController as apiSpawnController,
  submitControllerInput as apiSubmitControllerInput,
  abortController as apiAbortController,
  pauseController as apiPauseController,
  resumeController as apiResumeController,
  listSessions as apiListSessions,
  deleteSession as apiDeleteSession,
  chatStream as apiChatStream,
} from "../api/chat";
import { useEditorStore } from "./useEditorStore";
import {
  useWorkspaceStore,
  type PersistedWorkspaceChat,
} from "./useWorkspaceStore";
import { openFile } from "../api/commands";

/**
 * Top-level chat mode. `"discuss"` is the original sequential
 * discussion runner; `"swarm"` is the planner-driven flow where the
 * planner breaks the topic into ordered worker steps; `"manager"`
 * is the interactive option-button flow; `"hil"` is the
 * pausable, editable, worktree-backed blackboard session backed by
 * `latte-rs-agents/latte-agent-core::session::SessionManager`.
 * `"controller"` is the event-driven single-role or multi-role mode
 * backed by `latte_agent_core::controller::ChatController`.
 * `"single"` is the stateless single-role chat (request-response),
 * mirroring `latte-agent chat --role <id>`.
 */
export type ChatMode = "discuss" | "swarm" | "manager" | "hil" | "controller" | "single";

export type ChatStatus = "idle" | "running" | "completed" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: number;
  agentIcon?: string;
  agentName?: string;
}

export interface ChatActivityEvent {
  id: string;
  kind:
    | "status"
    | "role_started"
    | "role_finished"
    | "delegate_started"
    | "delegate_finished"
    | "tool_use"
    | "tool_result"
    | "tool_error"
    | "round"
    | "error";
  roleId?: string;
  title: string;
  detail?: string;
  timestamp: number;
}

export interface ActiveRoleState {
  roleId: string;
  detail: string;
  startedAt: number;
}

export interface RoleDisplayState {
  roleId: string;
  icon?: string;
  modelId?: string;
}

export interface ChatTurn {
  agent: string;
  roleId: string;
  icon: string;
  response: string;
  round: number;
  stepId: string;
  turnNumber: number;
}

interface ChatStore {
  byWorkspace: Record<string, WorkspaceChat>;
  /** Active chat mode (planned discussion vs planner-driven swarm). */
  mode: ChatMode;
  messages: ChatMessage[];
  activityEvents: ChatActivityEvent[];
  activeRoles: Record<string, ActiveRoleState>;
  roleDisplay: Record<string, RoleDisplayState>;
  status: ChatStatus;
  /** Session id for the active planned discussion. Swarm uses `swarmSessionId`. */
  sessionId: number | null;
  /** Session id for the active swarm, when `mode === "swarm"`. */
  swarmSessionId: number | null;
  /** Current swarm id (e.g. `"quick_task"`). Echoed by `chat:swarm_event`. */
  activeSwarmId: string | null;
  /** Steps the planner emitted for the active swarm. Cleared on `clearChat`. */
  swarmPlan: SwarmStepSpec[];
  /** Files the swarm runner wrote (plan.md / steps/*.md / summary.md). */
  swarmFiles: { path: string; kind: "plan" | "output" | "summary" }[];
  /** Final markdown synthesis from the active swarm. Cleared on `clearChat`. */
  swarmSummary: string | null;
  errorMessage: string | null;
  /** Last user prompt — saved when the user sends so the retry
   *  button can resend without re-typing. Cleared on success. */
  lastUserTopic: string | null;
  selectedWorkflow: string;
  availableWorkflows: {
    id: string;
    name: string;
    kind: "planned" | "swarm";
    /** Runtime dispatch tag — when `"manager_led"`, selecting the
     *  workflow auto-switches the chat mode to manager. */
    mode: string;
  }[];
  availableRoles: RoleInfo[];

  // Model configuration
  availableModels: ModelInfo[];
  defaultModel: string;
  roleModels: Record<string, string>;
  /** Priority-ordered chain per role id. Roles not present in the
   *  loaded config won't have an entry; consumers should fall back to
   *  `roleModels[id]` (or `defaultModel`) when reading. */
  roleChains: Record<string, string[]>;
  modelsPath: string;
  rolesPath: string;
  configPanelOpen: boolean;

  setMode: (mode: ChatMode) => void;
  setWorkflow: (id: string) => void;
  setError: (msg: string) => void;
  loadWorkflows: () => Promise<void>;
  loadModels: () => Promise<void>;
  loadRoleConfig: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  cancelDiscussion: () => Promise<void>;
  /** Start a new topic: reset runtime session state but keep existing message history. */
  restartDiscussion: () => void;
  createNewTopic: () => void;
  selectTopic: (topicId: string) => void;
  visibleTopics: TopicSummary[];
  activeTopicId: string;
  /** Re-run the last user prompt via the same code path as `sendMessage`.
   *  Used by the retry button after a preflight / orchestrator error. */
  retryLastDiscussion: () => Promise<void>;
  clearChat: () => void;
  addTurn: (turn: ChatTurn) => void;
  setComplete: () => void;
  applyChatEvent: (event: ChatEvent, workspaceId?: string | null) => void;
  /** Apply one `chat:swarm_event` from the backend. */
  applySwarmEvent: (event: SwarmEvent) => void;
  /** Apply one `chat:controller_event` from the backend. */
  applyControllerEvent: (event: import("../api/chat").ControllerEventPayload) => void;
  /** Send a swarm-mode prompt. No-op when `mode !== "swarm"` or
   *  a swarm is already running. */
  sendSwarm: (topic: string) => Promise<void>;
  /** Send a controller-mode prompt. */
  sendController: (content: string) => Promise<void>;
  /** Send a single-role chat message (stateless request-response). */
  sendSingleChat: (content: string) => Promise<void>;
  controllerSessionId: string | null;
  /** Pause the active controller session. */
  pauseController: () => Promise<void>;
  /** Resume the active controller session. */
  resumeController: () => Promise<void>;
  // ─── Manager-led workflow state ──────────────────────────────────
  /** Most recent pending decision request. Non-null while the UI
   *  should show option buttons under the last manager bubble. */
  pendingDecision: import("../api/chat").DecisionRequest | null;
  /** Latest streaming status from `chat:manager_status`. `null`
   *  before the first emission or after `clearChat`. */
  managerStatus: import("../api/chat").ManagerStatus | null;
  /** Currently-active manager session id (assigned by
   *  `chat_start_manager_session`). `null` until first launch. */
  managerSessionId: number | null;
  startManagerSession: (topic: string) => Promise<void>;
  submitManagerDecision: (
    optionId: string,
    freeText?: string | null,
  ) => Promise<void>;
  /** User pushed the session forward without picking an option. */
  managerContinue: (message?: string | null) => Promise<void>;
  /** Apply one `chat:need_decision` event from the backend. */
  applyNeedDecision: (req: import("../api/chat").DecisionRequest) => void;
  applyManagerStatus: (
    status: import("../api/chat").ManagerStatus,
  ) => void;

  // ─── HIL (Human-In-Loop) Blackboard state ─────────────────────
  /** Active HIL session id (the `task_id` from the backend). `null`
   *  when no HIL session is loaded. */
  hilTaskId: string | null;
  /** The full editable session snapshot. Mirrors the JSON on disk;
   *  the editor mutates the per-role histories and posts edits back
   *  through `editHilMessage`. */
  hilSession: HilSessionState | null;
  /** Cached list of on-disk HIL sessions for the "open existing"
   *  dropdown. Populated on first `loadHilSessions` call. */
  hilSessionList: HilSessionSummary[];
  /** Optional cwd override for the HIL commands. When `null`, the
   *  backend uses `std::env::current_dir()` (i.e. the editor
   *  process cwd). The editor should pass the active workspace's
   *  root so the HIL worktree lives next to the user's project. */
  hilCwd: string | null;
  /** When non-null, the user is currently editing this message in
   *  the role transcript. The editor renders the inline editor
   *  for that row. */
  hilEditingMessage:
    | { roleId: string; messageIndex: number; draft: string }
    | null;
  /** In-flight indicator for any HIL command. Used to disable the
   *  input + show a spinner. */
  hilBusy: boolean;
  /** Last HIL error message (e.g. worktree creation failure). */
  hilError: string | null;
  // ─── Unified SessionStore (persistent sessions) ───────────────
  /** Cached list of all persisted sessions. Populated on first load. */
  sessionList: import("../api/chat").SessionSummary[];
  /** Loading flag for session list. */
  sessionListLoading: boolean;
  /** Load session list from the backend. */
  loadSessionList: () => Promise<void>;
  /** Delete a session and refresh the list. */
  deleteSession: (sessionId: string) => Promise<void>;

  /** Load or create an HIL session. When `taskId` is new (and the
   *  worktree doesn't exist yet), this creates the worktree +
   *  plan.md + SessionRecord. When `taskId` already exists, it
   *  loads the latest session JSON. */
  startOrLoadHilSession: (
    taskId: string,
    initialPrompt: string,
  ) => Promise<void>;
  /** Refresh `hilSession` from the on-disk JSON. Useful after
   *  hand-editing the session file in the editor. */
  refreshHilSession: () => Promise<void>;
  /** Pause the active HIL session. */
  pauseHilSession: (reason?: string) => Promise<void>;
  /** Resume the active HIL session. If `message` is non-empty,
   *  it's appended to `roleId`'s history as a synthetic user
   *  message tagged `[HUMAN @ <ts>]`. */
  resumeHilSession: (
    roleId: string,
    message?: string,
  ) => Promise<void>;
  /** Inject a message targeted at a specific role (the
   *  `latte-agent inject` equivalent). */
  injectToHilRole: (roleId: string, message: string) => Promise<void>;
  /** Send a user message to a role (the regular "send" path).
   *  In HIL mode the user explicitly picks the role (defaulting
   *  to `"manager"`); this is how the user "talks" in the
   *  blackboard. */
  sendHilUserMessage: (roleId: string, content: string) => Promise<void>;
  /** Edit or delete one message in a role's history. The
   *  "可修改聊天内容继续" affordance. */
  editHilMessageAction: (
    roleId: string,
    messageIndex: number,
    action: "edit" | "delete",
    newContent?: string,
  ) => Promise<void>;
  /** Mark the session as Done (the "abort" transition). */
  abortHilSession: () => Promise<void>;
  /** Populate `hilSessionList` from the on-disk session index. */
  loadHilSessions: () => Promise<void>;
  /** Open the on-disk session JSON in the editor. Used by the
   *  "在编辑器中打开" affordance for operators who want to
   *  hand-edit the file. */
  openHilSessionJson: () => Promise<void>;
  /** Open `plan.md` in the editor. */
  openHilPlanMd: () => Promise<void>;
  /** Begin editing a message in the HIL transcript. */
  beginHilEditMessage: (
    roleId: string,
    messageIndex: number,
    initialContent: string,
  ) => void;
  /** Update the draft of the in-progress edit. */
  updateHilEditDraft: (draft: string) => void;
  /** Commit the current edit (calls `editHilMessageAction`). */
  commitHilEditMessage: () => Promise<void>;
  /** Cancel the current edit without saving. */
  cancelHilEditMessage: () => void;
  /** Apply one `chat:hil_state` event from the backend. */
  applyHilState: (state: HilSessionState) => void;
  /** Set the cwd override (call this when the user opens a
   *  different workspace). */
  setHilCwd: (cwd: string | null) => void;
  // Config management
  setRoleModel: (roleId: string, modelId: string) => Promise<void>;
  /**
   * Persist a role's full priority-ordered model chain. Empty chains
   * are rejected by the backend. Returns the persisted (deduplicated)
   * chain on success.
   */
  setRoleModelChain: (roleId: string, chain: string[]) => Promise<string[]>;
  setDefaultModel: (modelId: string) => Promise<void>;
  openConfigFile: (type: ChatConfigTarget) => Promise<void>;
  toggleConfigPanel: () => void;
  // ─── Workflow editor state ──────────────────────────────────────
  /** Editable copy of the workflow currently in the editor. `null`
   *  when the editor is closed. The editor mutates this freely; the
   *  on-disk workflow is only updated by `saveEditingWorkflow`. */
  editingWorkflow: WorkflowPayload | null;
  /** True once the editor has any field divergence from `editingOriginal`. */
  editingDirty: boolean;
  /** Mirrors `editingWorkflow` at the time the editor opened. Used
   *  to compute `editingDirty`. */
  editingOriginal: WorkflowPayload | null;
  /** In-flight `saveWorkflow` / `deleteWorkflow` indicator. */
  editingSaving: boolean;
  /** Last save / delete error message, cleared on next successful op. */
  editingError: string | null;

  /** Open the editor on an existing workflow. */
  openWorkflowEditor: (payload: Partial<WorkflowPayload>) => void;
  /** Open the editor on a blank new workflow. */
  openNewWorkflowEditor: () => void;
  /** Close the editor without saving. */
  closeWorkflowEditor: () => void;
  /** Patch one or more top-level fields on the editing workflow. */
  patchEditingWorkflow: (
    patch: Partial<WorkflowPayload>,
  ) => void;
  /** Patch one step in `editingWorkflow.steps`. */
  patchEditingStep: (
    index: number,
    patch: Partial<{ name: string; roles: string[] }>,
  ) => void;
  /** Append a new step with sensible defaults. */
  addEditingStep: () => void;
  /** Remove step at index. */
  removeEditingStep: (index: number) => void;
  /** Reorder steps. */
  moveEditingStep: (index: number, direction: -1 | 1) => void;
  /** Persist `editingWorkflow` to roles.yaml via the backend. */
  saveEditingWorkflow: () => Promise<void>;
  /** Delete the workflow currently being edited. */
  deleteEditingWorkflow: () => Promise<void>;
  /** Wipe the user `roles.yaml` and rebuild it from defaults.
   *  Returns the fresh config so the caller can re-render without
   *  a follow-up `getRoleConfig`. Used as the "重置为中文默认"
   *  button for users with old `roles.yaml` files. */
  resetRolesToDefaults: () => Promise<void>;
  evictWorkspace: (workspaceId: string) => void;
}

interface WorkspaceChat {
  mode: ChatMode;
  messages: ChatMessage[];
  activityEvents: ChatActivityEvent[];
  activeRoles: Record<string, ActiveRoleState>;
  roleDisplay: Record<string, RoleDisplayState>;
  status: ChatStatus;
  sessionId: number | null;
  swarmSessionId: number | null;
  activeSwarmId: string | null;
  swarmPlan: SwarmStepSpec[];
  swarmFiles: { path: string; kind: "plan" | "output" | "summary" }[];
  swarmSummary: string | null;
  errorMessage: string | null;
  lastUserTopic: string | null;
  selectedWorkflow: string;

  activeTopicId: string;
  topicOrder: string[];
  topics: Record<string, TopicSnapshot>;
}

interface TopicSummary {
  id: string;
  title: string;
  createdAt: number;
  workflowId: string;
}

interface TopicSnapshot {
  id: string;
  workflowId: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
  activityEvents: ChatActivityEvent[];
  status: ChatStatus;
  errorMessage: string | null;
  lastUserTopic: string | null;
}

const DEFAULT_TOPIC_ID = "topic_default";

const FALLBACK_WORKSPACE_ID = "__global_chat__";

function emptyChat(): WorkspaceChat {
  return {
    mode: "discuss",
    messages: [],
    activityEvents: [],
    activeRoles: {},
    roleDisplay: {},
    status: "idle",
    sessionId: null,
    swarmSessionId: null,
    activeSwarmId: null,
    swarmPlan: [],
    swarmFiles: [],
    swarmSummary: null,
    errorMessage: null,
    lastUserTopic: null,
    selectedWorkflow: "discuss",

    activeTopicId: DEFAULT_TOPIC_ID,
    topicOrder: [DEFAULT_TOPIC_ID],
    topics: {
      [DEFAULT_TOPIC_ID]: {
        id: DEFAULT_TOPIC_ID,
        workflowId: "discuss",
        title: "新话题",
        createdAt: Date.now(),
        messages: [],
        activityEvents: [],
        status: "idle",
        errorMessage: null,
        lastUserTopic: null,
      },
    },
  };
}

function ensureTopicState(chat: WorkspaceChat): WorkspaceChat {
  const activeTopicId = chat.activeTopicId ?? DEFAULT_TOPIC_ID;
  const topics = chat.topics ?? {};
  const topicOrder =
    chat.topicOrder && chat.topicOrder.length > 0
      ? chat.topicOrder
      : [activeTopicId];

  return {
    ...chat,
    activeTopicId,
    topicOrder: topicOrder.includes(activeTopicId)
      ? topicOrder
      : [...topicOrder, activeTopicId],
    topics,
  };
}

function projectedWorkspaceId(): string {
  return useWorkspaceStore.getState().activeWorkspaceId ?? FALLBACK_WORKSPACE_ID;
}

function targetWorkspaceId(workspaceId?: string | null): string {
  return workspaceId ?? projectedWorkspaceId();
}

function projectFrom(
  byWorkspace: Record<string, WorkspaceChat>,
  workspaceId: string,
): Partial<ChatStore> {
  const ws = byWorkspace[workspaceId] ?? emptyChat();
  const visibleTopics = ws.topicOrder
    .map((id) => ws.topics[id])
    .filter(Boolean)
    .filter((t) => t.workflowId === ws.selectedWorkflow)
    .map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      workflowId: t.workflowId,
    }));
  return { ...ws, visibleTopics };
}

function hydrateChat(persisted: PersistedWorkspaceChat): WorkspaceChat {
  const createdAt = Date.now();
  return {
    mode: persisted.mode,
    messages: persisted.messages ?? [],
    activityEvents: (persisted.activityEvents ?? []).map((event) => ({
      ...event,
      kind: event.kind as ChatActivityEvent["kind"],
    })),
    activeRoles: {},
    roleDisplay: {},
    status: persisted.status === "running" ? "idle" : persisted.status,
    sessionId: null,
    swarmSessionId: null,
    activeSwarmId: persisted.activeSwarmId ?? null,
    swarmPlan: persisted.swarmPlan ?? [],
    swarmFiles: persisted.swarmFiles ?? [],
    swarmSummary: persisted.swarmSummary ?? null,
    errorMessage:
      persisted.status === "running"
        ? "Previous chat runtime ended when the app restarted."
        : persisted.errorMessage ?? null,
    lastUserTopic: persisted.lastUserTopic ?? null,
    selectedWorkflow: persisted.selectedWorkflow || "discuss",

    activeTopicId: DEFAULT_TOPIC_ID,
    topicOrder: [DEFAULT_TOPIC_ID],
    topics: {
      [DEFAULT_TOPIC_ID]: {
        id: DEFAULT_TOPIC_ID,
        workflowId: persisted.selectedWorkflow || "discuss",
        title: "新话题",
        createdAt,
        messages: persisted.messages ?? [],
        activityEvents: (persisted.activityEvents ?? []).map((event) => ({
          ...event,
          kind: event.kind as ChatActivityEvent["kind"],
        })),
        status: persisted.status === "running" ? "idle" : persisted.status,
        errorMessage:
          persisted.status === "running"
            ? "Previous chat runtime ended when the app restarted."
            : persisted.errorMessage ?? null,
        lastUserTopic: persisted.lastUserTopic ?? null,
      },
    },
  };
}

function serializeChat(chat: WorkspaceChat): PersistedWorkspaceChat {
  return {
    mode: chat.mode,
    messages: chat.messages,
    activityEvents: chat.activityEvents,
    status: chat.status,
    selectedWorkflow: chat.selectedWorkflow,
    activeSwarmId: chat.activeSwarmId,
    swarmPlan: chat.swarmPlan,
    swarmFiles: chat.swarmFiles,
    swarmSummary: chat.swarmSummary,
    errorMessage: chat.errorMessage,
    lastUserTopic: chat.lastUserTopic,
  };
}

const persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function scheduleChatPersist(workspaceId: string, chat: WorkspaceChat) {
  if (workspaceId === FALLBACK_WORKSPACE_ID) return;
  if (persistTimers[workspaceId]) clearTimeout(persistTimers[workspaceId]);
  persistTimers[workspaceId] = setTimeout(() => {
    void useWorkspaceStore.getState().updateMeta(workspaceId, {
      chat_state: serializeChat(chat),
    });
    delete persistTimers[workspaceId];
  }, 150);
  (
    persistTimers[workspaceId] as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    }
  ).unref?.();
}

let nextMessageId = 1;
function uid(): string {
  return `m${Date.now()}-${nextMessageId++}`;
}

function extractReadableProtocolJson(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    for (const key of ["content", "message", "text", "summary", "answer", "response"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function readableRoleContent(content: string): string {
  // Backend may emit either `<tool_call>...</tool_call>` or `<toolcall>...</toolcall>`
  // depending on runner/version. Strip both so the UI only shows the human-readable parts.
  const withoutToolCalls = content.replace(
    /<(?:tool_call|toolcall)\b[\s\S]*?<\/(?:tool_call|toolcall)>/gi,
    "",
  );
  const lines = withoutToolCalls
    .split(/\r?\n/)
    .map((line) => extractReadableProtocolJson(line) ?? line.trim())
    .filter((line) => line.length > 0);
  return lines.join("\n").trim() || content.trim();
}

export const useChatStore = create<ChatStore>((set, get) => {
  const updateChat = (
    workspaceId: string | null | undefined,
    updater: (chat: WorkspaceChat) => WorkspaceChat,
  ) => {
    const wsId = targetWorkspaceId(workspaceId);
    let persisted: WorkspaceChat | null = null;
    set((s) => {
      const prev = ensureTopicState(s.byWorkspace[wsId] ?? emptyChat());
      const next = ensureTopicState(updater(prev));
      // Keep the active topic snapshot in sync with the projected fields.
      const activeTopicId = next.activeTopicId ?? DEFAULT_TOPIC_ID;
      const prevSnap = next.topics[activeTopicId];
      const nextSnap: TopicSnapshot = {
        ...(prevSnap ?? {
          id: activeTopicId,
          workflowId: next.selectedWorkflow,
          title: "新话题",
          createdAt: Date.now(),
          messages: [],
          activityEvents: [],
          status: "idle",
          errorMessage: null,
          lastUserTopic: null,
        }),
        id: activeTopicId,
        workflowId: prevSnap?.workflowId ?? next.selectedWorkflow,
        messages: next.messages,
        activityEvents: next.activityEvents,
        status: next.status,
        errorMessage: next.errorMessage,
        lastUserTopic: next.lastUserTopic,
      };
      const byWorkspaceTopic = {
        ...next.topics,
        [activeTopicId]: nextSnap,
      };
      const withTopics: WorkspaceChat = { ...next, activeTopicId, topics: byWorkspaceTopic };
      persisted = withTopics;
      const byWorkspace = { ...s.byWorkspace, [wsId]: withTopics };
      return {
        byWorkspace,
        ...projectFrom(byWorkspace, projectedWorkspaceId()),
      };
    });
    if (persisted) scheduleChatPersist(wsId, persisted);
  };

  useWorkspaceStore.subscribe(() => {
    const wsId = projectedWorkspaceId();
    set((s) => {
      let byWorkspace = s.byWorkspace;
      const meta = useWorkspaceStore.getState().workspaces[wsId];
      if (!byWorkspace[wsId] && meta?.chat_state) {
        byWorkspace = { ...byWorkspace, [wsId]: hydrateChat(meta.chat_state) };
      }
      return { byWorkspace, ...projectFrom(byWorkspace, wsId) };
    });
  });

  return {
  byWorkspace: {},
    ...emptyChat(),
    visibleTopics: [],
  availableWorkflows: [],
  availableRoles: [],
  availableModels: [],
  defaultModel: "deepseek-chat",
  roleModels: {},
  roleChains: {},
  modelsPath: "",
  rolesPath: "",
  configPanelOpen: false,


  // Workflow editor
  editingWorkflow: null,
  editingDirty: false,
  editingOriginal: null,
  editingSaving: false,
  editingError: null,
  setMode: (mode) =>
    updateChat(null, (chat) => ({ ...chat, mode, errorMessage: null })),

  setWorkflow: (id) => {
    const wf = get().availableWorkflows.find((w) => w.id === id);
    // Auto-switch mode when picking a manager-led workflow so the
    // user doesn't have to also flip the discuss/swarm/manager toggle.
    // User can manually switch back to another mode if they want.
    const nextMode =
      wf?.mode === "manager_led"
        ? "manager"
        : wf?.mode === "swarm"
          ? "swarm"
          : "discuss";
    updateChat(null, (chat) => {
      const candidateId =
        chat.topicOrder.find((tid) => chat.topics[tid]?.workflowId === id) ??
        null;

      if (candidateId) {
        const snap = chat.topics[candidateId];
        return {
          ...chat,
          selectedWorkflow: id,
          mode: nextMode,
          activeTopicId: candidateId,
          messages: snap.messages,
          activityEvents: snap.activityEvents,
          status: snap.status,
          errorMessage: snap.errorMessage,
          lastUserTopic: snap.lastUserTopic,
          // runtime ids must reset when switching topic/workflow
          sessionId: null,
          swarmSessionId: null,
          activeSwarmId: null,
          swarmPlan: [],
          swarmFiles: [],
          swarmSummary: null,
          activeRoles: {},
          roleDisplay: {},
        };
      }

      // No existing topic for this workflow: create a new blank topic.
      const now = Date.now();
      const newId = `topic_${now}_${Math.random().toString(16).slice(2)}`;
      return {
        ...chat,
        selectedWorkflow: id,
        mode: nextMode,
        activeTopicId: newId,
        topicOrder: [...chat.topicOrder, newId],
        topics: {
          ...chat.topics,
          [newId]: {
            id: newId,
            workflowId: id,
            title: "新话题",
            createdAt: now,
            messages: [],
            activityEvents: [],
            status: "idle",
            errorMessage: null,
            lastUserTopic: null,
          },
        },
        messages: [],
        activityEvents: [],
        status: "idle",
        errorMessage: null,
        sessionId: null,
        swarmSessionId: null,
        activeSwarmId: null,
        swarmPlan: [],
        swarmFiles: [],
        swarmSummary: null,
        activeRoles: {},
        roleDisplay: {},
        lastUserTopic: null,
      };
    });
  },

  loadWorkflows: async () => {
    try {
      const config = await getRoleConfig();
      set({
        availableWorkflows: config.workflows.map((w) => ({
          id: w.id,
          name: w.name,
          // Server defaults to `"planned"` for old configs that
          // don't set the kind. Keep the narrow union so consumers
          // can pattern-match without a runtime fallback.
          kind: (w.kind ?? "planned") as "planned" | "swarm",
          mode: w.mode ?? w.kind ?? "planned",
        })),
      });
    } catch (e) {
      console.error("loadWorkflows failed:", e);
    }
  },

  loadModels: async () => {
    try {
      const models = await listModels();
      set({ availableModels: models });
    } catch (e) {
      console.error("loadModels failed:", e);
    }
  },

  loadRoleConfig: async () => {
    try {
      const config = await getRoleConfig();
      const roleModels: Record<string, string> = {};
      const roleChains: Record<string, string[]> = {};
      config.roles.forEach((r) => {
        // Prefer the explicit chain; fall back to the back-compat
        // `defaultModelTier` so old single-model configs still
        // surface as a one-element chain in the UI.
        const chain =
          r.modelChain && r.modelChain.length > 0
            ? r.modelChain
            : r.defaultModelTier
              ? [r.defaultModelTier]
              : [];
        roleChains[r.id] = chain;
        // The dropdown's "primary" is the chain head; if the chain
        // is empty, fall back to the global default.
        roleModels[r.id] = chain[0] ?? config.defaultModel;
      });
      set({
        availableRoles: config.roles.map((r) => ({
          id: r.id,
          name: r.name,
          icon: r.icon,
          category: r.category,
          defaultModelTier: r.defaultModelTier,
          // Back-compat fields kept for legacy callers; the editor
          // only needs `id` / `name` / `icon` / `category`.
          model: roleModels[r.id],
          modelChain: roleChains[r.id] ?? [],
        })) as RoleInfo[],
        roleModels,
        roleChains,
        modelsPath: config.modelsPath,
        rolesPath: config.rolesPath,
      });
    } catch (e) {
      console.error("loadRoleConfig failed:", e);
    }
  },

  sendMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    // Swarm keeps its own planner runtime. Planned and manager-led
    // workflows both use the shared controller chat runtime.
    if (get().mode === "swarm") {
      await get().sendSwarm(trimmed);
      return;
    }
    if (get().mode === "manager") {
      await get().startManagerSession(trimmed);
      return;
    }
    if (get().mode === "single") {
      await get().sendSingleChat(trimmed);
      return;
    }
    if (get().mode === "controller") {
      await get().sendController(trimmed);
      return;
    }
    const wsId = projectedWorkspaceId();
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };
    updateChat(wsId, (chat) => ({
      ...chat,
      messages: [...chat.messages, userMsg],
      status: "running",
      errorMessage: null,
      lastUserTopic: trimmed,
    }));
    try {
      const state = get().byWorkspace[wsId] ?? emptyChat();
      if (state.sessionId === null) {
        const sessionId = await startDiscussion({
          topic: trimmed,
          workflow: state.selectedWorkflow,
          customRoles: null,
          maxRounds: 1,
          workspaceId: wsId === FALLBACK_WORKSPACE_ID ? null : wsId,
        });
        // Important: do NOT mark `sessionId` set if the start failed.
        // When the start throws (e.g. all roles are missing API keys),
        // we keep `sessionId === null` so the retry path uses
        // `startDiscussion` again with the same workflow, not
        // `continueDiscussion` (which would need a live session).
        updateChat(wsId, (chat) => ({ ...chat, sessionId, lastUserTopic: trimmed }));
      } else {
        await continueDiscussion({ sessionId: state.sessionId, message: trimmed });
        updateChat(wsId, (chat) => ({ ...chat, lastUserTopic: trimmed }));
      }
    } catch (e) {
      updateChat(wsId, (chat) => ({
        ...chat,
        status: "error",
        errorMessage: String(e),
      }));
    }
  },

  /**
   * Re-run the last user prompt without forcing the user to
   * re-type. Skips a no-op if there's nothing to retry.
   *
   * Drops any stale error bubbles from the previous attempt so the
   * chat list reflects only the current run.
   */
  retryLastDiscussion: async () => {
    const wsId = projectedWorkspaceId();
    const topic = (get().byWorkspace[wsId] ?? emptyChat()).lastUserTopic;
    if (!topic) return;
    updateChat(wsId, (chat) => ({
      ...chat,
      messages: chat.messages.filter((m) => {
        // Keep user prompts + successful agent turns; drop the
        // `⚠️` preflight error bubbles so the retry gets a clean
        // slate (the user prompt stays, the bot's previous
        // failures go).
        const idTag = (m as unknown as { stepId?: string }).stepId ?? "";
        const isErrorTurn =
          idTag.startsWith("__preflight_error__") || m.content.startsWith("⚠️");
        return !isErrorTurn;
      }),
      status: "running",
      errorMessage: null,
    }));
    await get().sendMessage(topic);
  },
  cancelDiscussion: async () => {
    const wsId = projectedWorkspaceId();
    const { sessionId, mode, controllerSessionId } = get();
    if (mode === "controller" && controllerSessionId) {
      try {
        await apiAbortController(controllerSessionId);
      } catch (e) {
        console.error("controller abort failed:", e);
      }
      set({ status: "idle" });
      return;
    }
    if (sessionId !== null) {
      try {
        await cancelDiscussion(sessionId);
      } catch (e) {
        console.error("cancel failed:", e);
      }
      updateChat(wsId, (chat) => ({ ...chat, status: "idle" }));
    }
  },

  restartDiscussion: () => {
    updateChat(null, (chat) => ({
      ...chat,
      status: "idle",
      errorMessage: null,
      // Reset runtime session ids so next sendMessage creates a new controller session.
      sessionId: null,
      swarmSessionId: null,
      activeSwarmId: null,
      swarmPlan: [],
      swarmFiles: [],
      swarmSummary: null,
      pendingDecision: null,
      managerStatus: null,
      managerSessionId: null,
      // HIL: keep `hilTaskId` + `hilSession` (the on-disk JSON
      // is the source of truth; "clear" doesn't drop the user's
      // session). The user can switch modes to start a fresh
      // HIL session or call `startOrLoadHilSession` again.
      controllerSessionId: null,
      hilBusy: false,
      hilError: null,
      hilEditingMessage: null,
    }));
  },
  addTurn: (turn) => {
    const agentMsg: ChatMessage = {
      id: uid(),
      role: "agent",
      agentIcon: turn.icon,
      agentName: turn.agent,
      content: turn.response,
      timestamp: Date.now(),
    };
    updateChat(null, (chat) => ({
      ...chat,
      messages: [...chat.messages, agentMsg],
    }));
  },

  setComplete: () =>
    updateChat(null, (chat) => ({ ...chat, status: "completed" })),

  setError: (msg) =>
    updateChat(null, (chat) => ({ ...chat, status: "error", errorMessage: msg })),

  applyChatEvent: (event, workspaceId) => {
    const addActivity = (
      chat: WorkspaceChat,
      kind: ChatActivityEvent["kind"],
      title: string,
      detail?: string,
      roleId?: string,
    ): WorkspaceChat => {
      const item: ChatActivityEvent = {
        id: uid(),
        kind,
        roleId,
        title,
        detail,
        timestamp: Date.now(),
      };
      return {
        ...chat,
        activityEvents: [...chat.activityEvents, item].slice(-200),
      };
    };

    updateChat(workspaceId, (chat) => {
      if ("RoleTurn" in event) {
        const { role_id, content } = event.RoleTurn;
        const roleInfo = get().availableRoles.find((role) => role.id === role_id);
        const roleDisplay = chat.roleDisplay[role_id];
        const msg: ChatMessage = {
          id: uid(),
          role: "agent",
          agentIcon: roleInfo?.icon ?? roleDisplay?.icon ?? "💬",
          agentName: roleInfo?.name ?? role_id,
          content: readableRoleContent(content),
          timestamp: Date.now(),
        };
        return { ...chat, messages: [...chat.messages, msg] };
      }
      if ("Status" in event) {
        return addActivity(chat, "status", "status", event.Status.message);
      }
      if ("Prompt" in event) {
        const { role_id, icon, model_id } = event.Prompt;
        return addActivity(
          {
            ...chat,
            roleDisplay: {
              ...chat.roleDisplay,
              [role_id]: { roleId: role_id, icon, modelId: model_id },
            },
          },
          "status",
          `${event.Prompt.role_id} ready`,
          event.Prompt.model_id,
          event.Prompt.role_id,
        );
      }
      if ("RoundStarted" in event) {
        return addActivity(chat, "round", `Round ${event.RoundStarted.round} started`);
      }
      if ("RoundEnded" in event) {
        return addActivity(chat, "round", `Round ${event.RoundEnded.round} ended`);
      }
      if ("RoleStarted" in event) {
        const { role_id, detail } = event.RoleStarted;
        return addActivity(
          {
            ...chat,
            activeRoles: {
              ...chat.activeRoles,
              [role_id]: { roleId: role_id, detail, startedAt: Date.now() },
            },
          },
          "role_started",
          `${role_id} started`,
          detail,
          role_id,
        );
      }
      if ("RoleFinished" in event) {
        const { role_id, detail } = event.RoleFinished;
        const next = { ...chat.activeRoles };
        delete next[role_id];
        return addActivity(
          { ...chat, activeRoles: next },
          "role_finished",
          `${role_id} finished`,
          detail,
          role_id,
        );
      }
      if ("DelegateStarted" in event) {
        const { from_role, to_role, task } = event.DelegateStarted;
        return addActivity(
          {
            ...chat,
            activeRoles: {
              ...chat.activeRoles,
              [to_role]: {
                roleId: to_role,
                detail: `delegated by ${from_role}`,
                startedAt: Date.now(),
              },
            },
          },
          "delegate_started",
          `${from_role} → ${to_role}`,
          task,
          to_role,
        );
      }
      if ("DelegateFinished" in event) {
        const { from_role, to_role, status, summary } = event.DelegateFinished;
        return addActivity(
          chat,
          "delegate_finished",
          `${from_role} ← ${to_role} ${status}`,
          summary,
          to_role,
        );
      }
      if ("ToolUse" in event) {
        const { role_id, tool_name, args } = event.ToolUse;
        return addActivity(chat, "tool_use", `${role_id} tool ${tool_name}`, args, role_id);
      }
      if ("ToolResult" in event) {
        const { role_id, tool_name, result } = event.ToolResult;
        return addActivity(chat, "tool_result", `${role_id} ${tool_name} result`, result, role_id);
      }
      if ("ToolError" in event) {
        const { role_id, tool_name, error } = event.ToolError;
        return addActivity(chat, "tool_error", `${role_id} ${tool_name} error`, error, role_id);
      }
      if ("Paused" in event) {
        return addActivity(chat, "status", "paused", event.Paused.reason);
      }
      if ("Resumed" in event) {
        return addActivity(chat, "status", "resumed");
      }
      if ("ContextCleared" in event) {
        return { ...chat, messages: [], activityEvents: [], activeRoles: {}, roleDisplay: {} };
      }
      if ("SessionInfo" in event) {
        const { task_id, state, roles } = event.SessionInfo;
        return addActivity(
          chat,
          "status",
          `session ${state}`,
          `${task_id} · roles: ${roles.map((r) => r.id).join(", ")}`,
        );
      }
      if ("RoleList" in event) {
        return addActivity(
          chat,
          "status",
          "available roles",
          event.RoleList.roles.map((r) => r.id).join(", "),
        );
      }
      if ("Done" in event) {
        return addActivity(
          { ...chat, status: "completed", activeRoles: {}, lastUserTopic: null },
          "status",
          "done",
        );
      }
      if ("Error" in event) {
        return addActivity(
          {
            ...chat,
            status: "error",
            errorMessage: event.Error.message,
            activeRoles: {},
          },
          "error",
          "error",
          event.Error.message,
        );
      }
      return chat;
    });
  },

  /**
   * Launch a swarm-mode prompt. Backend streams events via
   * `chat:swarm_event`; we mirror them into `messages` and the
   * dedicated `swarmPlan` / `swarmFiles` / `swarmSummary` fields so
   * the chat panel can render planner output, worker turns, and the
   * final summary without parsing strings.
   */
  sendSwarm: async (topic) => {
    const trimmed = topic.trim();
    if (!trimmed) return;
    const wsId = projectedWorkspaceId();
    const state = get().byWorkspace[wsId] ?? emptyChat();
    if (state.status === "running") return;
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };
    // Prefer a swarm-mode workflow if one is selected; fall back
    // to the conventional `quick_task` preset. Always preserve the
    // pre-existing discussion workflow for when the user toggles
    // back to discuss mode.
    const wf = state.selectedWorkflow || "quick_task";
    updateChat(wsId, (chat) => ({
      ...chat,
      messages: [...chat.messages, userMsg],
      status: "running",
      errorMessage: null,
      activeSwarmId: wf,
      swarmPlan: [],
      swarmFiles: [],
      swarmSummary: null,
    }));
    try {
      const swarmSessionId = await startSwarm({ topic: trimmed, name: wf });
      updateChat(wsId, (chat) => ({ ...chat, swarmSessionId }));
    } catch (e) {
      updateChat(wsId, (chat) => ({
        ...chat,
        status: "error",
        errorMessage: String(e),
      }));
    }
  },
  sendController: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (get().status === "running") return;
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };
    let sid = get().controllerSessionId;
    if (!sid) {
      // First message: spawn a new controller session.
      sid = `ctrl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((s) => ({
        messages: [...s.messages, userMsg],
        status: "running",
        errorMessage: null,
        controllerSessionId: sid,
      }));
      try {
        await apiSpawnController({
          sessionId: sid,
          taskId: null,
          roles: ["manager"],
          initialPrompt: trimmed,
          maxRounds: 10,
          sessionTokenBudget: 0,
          primaryModelId: null,
          initialTier: null,
          cwd: null,
        });
      } catch (e) {
        set({ status: "error", errorMessage: String(e) });
      }
    } else {
      // Subsequent messages: submit to existing session.
      set((s) => ({
        messages: [...s.messages, userMsg],
        errorMessage: null,
      }));
      try {
        await apiSubmitControllerInput(sid, trimmed);
      } catch (e) {
        set({ status: "error", errorMessage: String(e) });
      }
    }
  },
  pauseController: async () => {
    const sid = get().controllerSessionId;
    if (!sid) return;
    try {
      await apiPauseController(sid);
    } catch (e) {
      console.error("pauseController failed:", e);
    }
  },
  resumeController: async () => {
    const sid = get().controllerSessionId;
    if (!sid) return;
    try {
      await apiResumeController(sid);
    } catch (e) {
      console.error("resumeController failed:", e);
    }
  },
  sendSingleChat: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (get().status === "running") return;
    // Build history from existing messages
    const history = get().messages.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };
    set((s) => ({
      messages: [...s.messages, userMsg],
      status: "running",
      errorMessage: null,
      lastUserTopic: trimmed,
    }));
    try {
      const reply = await apiChatStream({
        roleId: "manager",
        content: trimmed,
        history,
      });
      const agentMsg: ChatMessage = {
        id: uid(),
        role: "agent",
        content: reply.content,
        timestamp: Date.now(),
      };
      set((s) => ({
        messages: [...s.messages, agentMsg],
        status: "completed",
        lastUserTopic: null,
      }));
    } catch (e) {
      set({ status: "error", errorMessage: String(e) });
    }
  },

  /**
   * Apply one `chat:swarm_event` from the backend. Routes by `kind`
   * to keep the dispatch local — UI components only consume the
   * already-typed `swarmPlan` / `swarmFiles` / `swarmSummary` /
   * `messages` slices.
   */
  applySwarmEvent: (event, workspaceId) => {
    switch (event.kind) {
      case "plan": {
        updateChat(workspaceId, (chat) => ({
          ...chat,
          swarmPlan: event.steps ?? [],
          messages: [...chat.messages, {
            id: uid(),
            role: "agent",
            agentIcon: "🪄",
            agentName: "planner",
            content: event.steps && event.steps.length > 0
              ? `**Plan (${event.steps.length} steps):**\n\n` +
                event.steps
                  .map((st, i) => `${i + 1}. **${st.role}** — ${st.instruction}`)
                  .join("\n")
              : "_(planner emitted no steps)_",
            timestamp: Date.now(),
          }],
        }));
        return;
      }
      case "step": {
        if (!event.turn) return;
        const t = event.turn;
        updateChat(workspaceId, (chat) => ({
          ...chat,
          messages: [...chat.messages, {
            id: uid(),
            role: "agent",
            agentIcon: t.icon || "💬",
            agentName: t.agent,
            content: t.response,
            timestamp: Date.now(),
          }],
        }));
        return;
      }
      case "file": {
        if (!event.path || !event.fileKind) return;
        updateChat(workspaceId, (chat) => ({
          ...chat,
          swarmFiles: [
            ...chat.swarmFiles.filter((f) => f.path !== event.path),
            { path: event.path!, kind: event.fileKind! },
          ],
        }));
        return;
      }
      case "summary": {
        updateChat(workspaceId, (chat) => ({
          ...chat,
          swarmSummary: event.content ?? "",
          status: "completed",
          messages: event.content
            ? [
                ...chat.messages,
                {
                  id: uid(),
                  role: "agent" as const,
                  agentIcon: "✨",
                  agentName: "synthesis",
                  content: event.content,
                  timestamp: Date.now(),
                },
              ]
            : chat.messages,
        }));
        return;
      }
      case "complete": {
        updateChat(workspaceId, (chat) => ({ ...chat, status: "completed" }));
        return;
      }
      case "error": {
        updateChat(workspaceId, (chat) => ({
          ...chat,
          status: "error",
          errorMessage: event.content ?? "swarm error",
        }));
        return;
      }
    }
  },

  applyControllerEvent: (event) => {
    const sid = get().controllerSessionId;
    if (event.sessionId !== sid) return; // ignore events for other sessions
    switch (event.kind) {
      case "roleTurn": {
        const content = (event as unknown as { content?: string; isComplete?: boolean }).content;
        if (!content) return;
        set((s) => ({
          messages: [...s.messages, {
            id: uid(),
            role: "agent",
            content,
            timestamp: Date.now(),
          }],
        }));
        return;
      }
      case "paused": {
        set({ status: "completed" });
        return;
      }
      case "resumed": {
        set({ status: "running" });
        return;
      }
      case "contextCleared":
      case "done": {
        set({ status: "completed", lastUserTopic: null });
        return;
      }
      case "error": {
        const message = (event as unknown as { message?: string }).message;
        set({ status: "error", errorMessage: message ?? "controller error" });
        return;
      }
    }
  },

  setRoleModel: async (roleId, modelId) => {
    // setRoleModel is the legacy "set primary only" path. Persist as a
    // one-element chain so the YAML form stays consistent with the
    // explicit-chain UI; `setRoleModelChain` is the full-fidelity
    // API for multi-model configurations.
    try {
      await apiSetRoleModel(roleId, modelId);
      set((s) => ({
        roleModels: { ...s.roleModels, [roleId]: modelId },
        roleChains: { ...s.roleChains, [roleId]: [modelId] },
        availableRoles: s.availableRoles.map((r) =>
          r.id === roleId
            ? { ...r, defaultModelTier: modelId, modelChain: [modelId] }
            : r
        ),
      }));
    } catch (e) {
      console.error("setRoleModel failed:", e);
    }
  },
  setRoleModelChain: async (roleId, chain) => {
    // Normalize locally so the optimistic UI matches what the backend
    // will persist (dedup, drop empties). The backend is the source
    // of truth and returns the canonical chain.
    const dedup: string[] = [];
    const seen = new Set<string>();
    for (const id of chain) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      dedup.push(id);
    }
    if (dedup.length === 0) {
      console.error("setRoleModelChain: empty chain rejected");
      return [];
    }
    try {
      const persisted = await apiSetRoleModelChain(roleId, dedup);
      const primary = persisted[0] ?? "";
      set((s) => ({
        roleChains: { ...s.roleChains, [roleId]: persisted },
        roleModels: primary
          ? { ...s.roleModels, [roleId]: primary }
          : s.roleModels,
        availableRoles: s.availableRoles.map((r) =>
          r.id === roleId
            ? { ...r, defaultModelTier: primary, modelChain: persisted }
            : r
        ),
      }));
      return persisted;
    } catch (e) {
      console.error("setRoleModelChain failed:", e);
      return [];
    }
  },
  setDefaultModel: async (modelId) => {
    try {
      await apiSetDefaultModel(modelId);
      set({ defaultModel: modelId });
    } catch (e) {
      console.error("setDefaultModel failed:", e);
    }
  },

  openConfigFile: async (type) => {
    try {
      const path = await apiOpenConfig(type);
      const file = await openFile(path);
      useEditorStore.getState().openFileOrSwitch(file);
    } catch (e) {
      console.error("openConfigFile failed:", e);
    }
  },

  toggleConfigPanel: () =>
    set((s) => ({ configPanelOpen: !s.configPanelOpen })),

  // ─── Workflow editor ────────────────────────────────────────────

  openWorkflowEditor: (payload) => {
    // Older payloads saved before `managerRole` / `initialWorkers`
    // were added won't have these fields. Fill with defaults so the
    // editor's `ManagerFields` panel can bind to them without
    // conditionals everywhere. `payload` is `Partial<WorkflowPayload>`
    // so older test fixtures can omit the manager-led fields; the
    // cast folds the spread into a full `WorkflowPayload` for the
    // downstream `structuredClone`.
    // Fill defaults first, then layer the (partial) payload on top.
    // `Object.assign` avoids the "specified more than once" lint
    // that a literal `{ ...defaults, ...payload }` triggers when
    // the payload's type union includes keys we also default.
    const normalized = Object.assign(
      {
        managerRole: "",
        initialWorkers: [],
        maxTotalSteps: 8,
        maxUserDecisions: 5,
      } as Partial<WorkflowPayload>,
      payload,
    ) as unknown as WorkflowPayload;
    set({
      editingWorkflow: structuredClone(normalized),
      editingOriginal: structuredClone(normalized),
      editingDirty: false,
      editingError: null,
    });
  },
  openNewWorkflowEditor: () => {
    const id = `custom_${Date.now().toString(36)}`;
    const blank: WorkflowPayload = {
      id,
      name: "新建工作流",
      kind: "planned",
      roles: ["pm", "programmer"],
      steps: [
        {
          name: "需求",
          roles: ["pm"],
        },
        {
          name: "实现",
          roles: ["programmer"],
        },
      ],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
      managerRole: "",
      initialWorkers: [],
      maxTotalSteps: 8,
      maxUserDecisions: 5,
    };
    set({
      editingWorkflow: blank,
      editingOriginal: structuredClone(blank),
      editingDirty: false,
      editingError: null,
    });
  },

  closeWorkflowEditor: () =>
    set({
      editingWorkflow: null,
      editingOriginal: null,
      editingDirty: false,
      editingError: null,
    }),

  patchEditingWorkflow: (patch) =>
    set((s) => {
      if (!s.editingWorkflow) return s;
      const next = { ...s.editingWorkflow, ...patch };
      return {
        editingWorkflow: next,
        editingDirty:
          s.editingOriginal != null &&
          JSON.stringify(next) !== JSON.stringify(s.editingOriginal),
      };
    }),

  patchEditingStep: (index, patch) =>
    set((s) => {
      if (!s.editingWorkflow) return s;
      if (index < 0 || index >= s.editingWorkflow.steps.length) return s;
      const steps = s.editingWorkflow.steps.slice();
      steps[index] = { ...steps[index], ...patch };
      const next = { ...s.editingWorkflow, steps };
      return {
        editingWorkflow: next,
        editingDirty:
          s.editingOriginal != null &&
          JSON.stringify(next) !== JSON.stringify(s.editingOriginal),
      };
    }),

  addEditingStep: () =>
    set((s) => {
      if (!s.editingWorkflow) return s;
      const steps = [
        ...s.editingWorkflow.steps,
        { name: `步骤 ${s.editingWorkflow.steps.length + 1}`, roles: [] },
      ];
      const next = { ...s.editingWorkflow, steps };
      return {
        editingWorkflow: next,
        editingDirty:
          s.editingOriginal != null &&
          JSON.stringify(next) !== JSON.stringify(s.editingOriginal),
      };
    }),

  removeEditingStep: (index) =>
    set((s) => {
      if (!s.editingWorkflow) return s;
      if (index < 0 || index >= s.editingWorkflow.steps.length) return s;
      const steps = s.editingWorkflow.steps.filter((_, i) => i !== index);
      const next = { ...s.editingWorkflow, steps };
      return {
        editingWorkflow: next,
        editingDirty:
          s.editingOriginal != null &&
          JSON.stringify(next) !== JSON.stringify(s.editingOriginal),
      };
    }),

  moveEditingStep: (index, direction) =>
    set((s) => {
      if (!s.editingWorkflow) return s;
      const target = index + direction;
      if (
        index < 0 ||
        index >= s.editingWorkflow.steps.length ||
        target < 0 ||
        target >= s.editingWorkflow.steps.length
      ) {
        return s;
      }
      const steps = s.editingWorkflow.steps.slice();
      const tmp = steps[index];
      steps[index] = steps[target];
      steps[target] = tmp;
      const next = { ...s.editingWorkflow, steps };
      return {
        editingWorkflow: next,
        editingDirty:
          s.editingOriginal != null &&
          JSON.stringify(next) !== JSON.stringify(s.editingOriginal),
      };
    }),

  saveEditingWorkflow: async () => {
    const wf = get().editingWorkflow;
    if (!wf) return;
    set({ editingSaving: true, editingError: null });
    try {
      const result = await apiSaveWorkflow(wf);
      const saved = result.workflow ?? wf;
      // Refresh the workflow list so the dropdown shows the new
      // name / kind. Also clear `editingDirty` by syncing the
      // canonical form.
      await get().loadWorkflows();
      if (saved.kind === "planned") {
        updateChat(null, (chat) => ({ ...chat, selectedWorkflow: saved.id }));
      }
      set({
        editingWorkflow: saved,
        editingOriginal: structuredClone(saved),
        editingDirty: false,
        editingSaving: false,
      });
    } catch (e) {
      set({ editingSaving: false, editingError: String(e) });
    }
  },

  deleteEditingWorkflow: async () => {
    const wf = get().editingWorkflow;
    if (!wf) return;
    set({ editingSaving: true, editingError: null });
    try {
      await apiDeleteWorkflow(wf.id);
      await get().loadWorkflows();
      // If we just deleted the selected workflow, drop back to
      // `discuss` so the dropdown has a valid value.
      if (get().selectedWorkflow === wf.id) {
        updateChat(null, (chat) => ({ ...chat, selectedWorkflow: "discuss" }));
      }
      set({
        editingWorkflow: null,
        editingOriginal: null,
        editingDirty: false,
        editingSaving: false,
      });
    } catch (e) {
      set({ editingSaving: false, editingError: String(e) });
    }
  },

  /**
   * Wipe `roles.yaml` and rebuild it from the embedded defaults
   * (Chinese role names + the `quick_task` swarm preset).
   *
   * Existing users with an old `roles.yaml` only see the migration
   * deltas (new role/workflow entries appended). Their pre-existing
   * English-named roles stay English. This action is the explicit
   * "tear it down and start over" path. The backend returns the
   * fresh `RoleConfigResponse` so we can refresh every dependent
   * field in one setState.
   */
  resetRolesToDefaults: async () => {
    set({ editingSaving: true, editingError: null });
    try {
      const config = await apiResetRolesToDefaults();
      // Rebuild the `availableRoles` shape the store expects.
      const roleModels: Record<string, string> = {};
      const roleChains: Record<string, string[]> = {};
      const availableRoles = config.roles.map((r) => {
        const chain =
          r.modelChain && r.modelChain.length > 0
            ? r.modelChain
            : r.defaultModelTier
              ? [r.defaultModelTier]
              : [];
        roleChains[r.id] = chain;
        roleModels[r.id] = chain[0] ?? config.defaultModel;
        return r;
      });
      set({
        // Workflow / role list re-derived from the reset response.
        availableRoles,
        availableWorkflows: config.workflows.map((w) => ({
          id: w.id,
          name: w.name,
          kind: (w.kind ?? "planned") as "planned" | "swarm",
          mode: w.mode ?? w.kind ?? "planned",
        })),
        roleModels,
        roleChains,
        modelsPath: config.modelsPath,
        rolesPath: config.rolesPath,
        // If the editor was open on a now-reset workflow, close it.
        editingWorkflow: null,
        editingOriginal: null,
        editingDirty: false,
        editingSaving: false,
        editingError: null,
        // Drop the dropdown back to a known preset so the panel
        // doesn't render a stale id after the reset.
      });
      updateChat(null, (chat) => ({ ...chat, selectedWorkflow: "discuss" }));
    } catch (e) {
      set({ editingSaving: false, editingError: String(e) });
    }
  },

  evictWorkspace: (workspaceId) => {
    if (persistTimers[workspaceId]) {
      clearTimeout(persistTimers[workspaceId]);
      delete persistTimers[workspaceId];
    }
    set((s) => {
      const { [workspaceId]: _drop, ...rest } = s.byWorkspace;
      return {
        byWorkspace: rest,
        ...projectFrom(rest, projectedWorkspaceId()),
      };
    });
  },

  /**
   * Launch a new manager-led chat session. The user types a topic, this
   * fires the backend command. The backend then emits `chat:turn`
   * for the manager's first decision + `chat:need_decision` for the
   * option panel.
   */
  startManagerSession: async (topic) => {
    const trimmed = topic.trim();
    if (!trimmed) return;
    if (get().status === "running") return;
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };
    set((s) => ({
      messages: [...s.messages, userMsg],
      status: "running",
      pendingDecision: null,
      managerStatus: null,
    }));
    try {
      const wf = get().selectedWorkflow;
      const sessionId = await startManagerSessionApi(
        trimmed,
        get().mode === "manager" ? wf : null,
      );
      set({ managerSessionId: sessionId });
    } catch (e) {
      set({ status: "idle", errorMessage: String(e) });
    }
  },

  /**

  /**
   * User picked an option. The backend advances the state machine
   * from `AwaitingDecision` → worker dispatch or finalize, and the
   * resulting events come back through the existing `addTurn` /
   * `applyNeedDecision` channels.
   */
  submitManagerDecision: async (optionId, freeText) => {
    const sid = get().managerSessionId;
    if (sid === null) return;
    // Optimistically clear pendingDecision so the user can't double-
    // click; the backend will emit a fresh decision or run a worker.
    set({ pendingDecision: null });
    try {
      await submitUserDecisionApi({
        sessionId: sid,
        optionId,
        freeText: freeText ?? null,
      });
    } catch (e) {
      set({ status: "error", errorMessage: String(e) });
    }
  },

  /**
   * Push the session forward without picking an option. Useful when
   * the user wants to inject their own instruction.
   */
  managerContinue: async (message) => {
    const sid = get().managerSessionId;
    if (sid === null) return;
    set({ pendingDecision: null });
    try {
      await submitUserContinueApi(sid, message ?? null);
    } catch (e) {
      set({ status: "error", errorMessage: String(e) });
    }
  },

  /**
   * Replace the pending decision request. Called when the backend
   * emits `chat:need_decision`. Each new request supersedes the
   * previous one — the UI only shows the latest decision's options.
   */
  applyNeedDecision: (req) => {
    set({ pendingDecision: req });
  },

  /**
   * Replace the cached manager status with the latest emission.
   * The chat panel renders this directly — there's no merge logic,
   * the backend always sends a complete snapshot.
   */
  applyManagerStatus: (status) => {
    set({ managerStatus: status });
  },
  // ─── HIL action implementations ─────────────────────────────────
  applyHilState: (state) => {
    // Backend emits `chat:hil_state` after every mutation. Mirror
    // the snapshot into the store so the chat panel re-renders.
    set({ hilSession: state });
  },

  setHilCwd: (cwd) => set({ hilCwd: cwd }),

  startOrLoadHilSession: async (taskId, initialPrompt) => {
    set({ hilBusy: true, hilError: null, hilTaskId: taskId });
    try {
      // First try to load an existing session; if the worktree
      // exists this short-circuits the create call.
      const cwd = get().hilCwd;
      const existing = await apiGetHilState(taskId, cwd);
      if (existing) {
        set({ hilSession: existing, hilBusy: false });
        return;
      }
      // Otherwise create one. The backend will create the worktree
      // and return the initial snapshot.
      const created = await apiStartHilSession({
        taskId,
        initialPrompt,
        roles: [],
        cwd,
      });
      set({ hilSession: created, hilBusy: false });
    } catch (e) {
      set({ hilBusy: false, hilError: String(e) });
    }
  },

  refreshHilSession: async () => {
    const taskId = get().hilTaskId;
    if (!taskId) return;
    set({ hilBusy: true });
    try {
      const state = await apiGetHilState(taskId, get().hilCwd);
      set({ hilSession: state, hilBusy: false });
    } catch (e) {
      set({ hilBusy: false, hilError: String(e) });
    }
  },

  pauseHilSession: async (reason) => {
    const taskId = get().hilTaskId;
    if (!taskId) return;
    set({ hilBusy: true });
    try {
      const state = await apiTransitionHilSession({
        taskId,
        action: "pause",
        reason: reason ?? "editor: 用户手动暂停",
        cwd: get().hilCwd,
      });
      set({ hilSession: state, hilBusy: false });
    } catch (e) {
      set({ hilBusy: false, hilError: String(e) });
    }
  },

  resumeHilSession: async (roleId, message) => {
    const taskId = get().hilTaskId;
    if (!taskId) return;
    set({ hilBusy: true });
    try {
      const state = await apiTransitionHilSession({
        taskId,
        action: "resume",
        roleId,
        message: message ?? null,
        cwd: get().hilCwd,
      });
      set({ hilSession: state, hilBusy: false, hilEditingMessage: null });
    } catch (e) {
      set({ hilBusy: false, hilError: String(e) });
    }
  },

  injectToHilRole: async (roleId, message) => {
    const taskId = get().hilTaskId;
    if (!taskId) return;
    set({ hilBusy: true });
    try {
      const state = await apiInjectHilMessage({
        taskId,
        roleId,
        message,
        cwd: get().hilCwd,
      });
      set({ hilSession: state, hilBusy: false });
    } catch (e) {
      set({ hilBusy: false, hilError: String(e) });
    }
  },

  sendHilUserMessage: async (roleId, content) => {
    const taskId = get().hilTaskId;
    if (!taskId) return;
    const trimmed = content.trim();
    if (!trimmed) return;
    set({ hilBusy: true });
    try {
      const state = await apiSendHilMessage({
        taskId,
        roleId,
        content: trimmed,
        isUser: true,
        cwd: get().hilCwd,
      });
      set({ hilSession: state, hilBusy: false });
    } catch (e) {
      set({ hilBusy: false, hilError: String(e) });
    }
  },

  editHilMessageAction: async (roleId, messageIndex, action, newContent) => {
    const taskId = get().hilTaskId;
    if (!taskId) return;
    set({ hilBusy: true });
    try {
      const state = await apiEditHilMessage({
        taskId,
        roleId,
        messageIndex,
        action,
        newContent: newContent ?? null,
        cwd: get().hilCwd,
      });
      set({ hilSession: state, hilBusy: false, hilEditingMessage: null });
    } catch (e) {
      set({ hilBusy: false, hilError: String(e) });
    }
  },

  abortHilSession: async () => {
    const taskId = get().hilTaskId;
    if (!taskId) return;
    set({ hilBusy: true });
    try {
      const state = await apiTransitionHilSession({
        taskId,
        action: "abort",
        cwd: get().hilCwd,
      });
      set({ hilSession: state, hilBusy: false });
    } catch (e) {
      set({ hilBusy: false, hilError: String(e) });
    }
  },

  loadHilSessions: async () => {
    try {
      const list = await apiListHilSessions(get().hilCwd);
      set({ hilSessionList: list });
    } catch (e) {
      set({ hilError: String(e) });
    }
  },

  loadSessionList: async () => {
    set({ sessionListLoading: true });
    try {
      const list = await apiListSessions();
      set({ sessionList: list.map(s => ({ ...s, sessionId: s.sessionId })) });
    } catch (e) {
      console.error("loadSessionList failed:", e);
    } finally {
      set({ sessionListLoading: false });
    }
  },

  deleteSession: async (sessionId) => {
    try {
      await apiDeleteSession(sessionId);
      // Refresh the list
      const list = await apiListSessions();
      set({ sessionList: list.map(s => ({ ...s, sessionId: s.sessionId })) });
    } catch (e) {
      console.error("deleteSession failed:", e);
    }
  },
  openHilSessionJson: async () => {
    const session = get().hilSession;
    if (!session) return;
    try {
      const file = await openFile(session.sessionJsonPath);
      useEditorStore.getState().openFileOrSwitch(file);
    } catch (e) {
      set({ hilError: String(e) });
    }
  },

  openHilPlanMd: async () => {
    const session = get().hilSession;
    if (!session) return;
    // The plan lives at `<worktree>/plan.md` per WorktreeSpec.
    const planPath = `${session.worktreeRoot.replace(/[\\/]+$/, "")}/plan.md`;
    try {
      const file = await openFile(planPath);
      useEditorStore.getState().openFileOrSwitch(file);
    } catch (e) {
      set({ hilError: String(e) });
    }
  },

  beginHilEditMessage: (roleId, messageIndex, initialContent) => {
    set({
      hilEditingMessage: { roleId, messageIndex, draft: initialContent },
    });
  },

  updateHilEditDraft: (draft) => {
    const cur = get().hilEditingMessage;
    if (!cur) return;
    set({ hilEditingMessage: { ...cur, draft } });
  },

  commitHilEditMessage: async () => {
    const cur = get().hilEditingMessage;
    if (!cur) return;
    await get().editHilMessageAction(
      cur.roleId,
      cur.messageIndex,
      "edit",
      cur.draft,
    );
  },

  cancelHilEditMessage: () => set({ hilEditingMessage: null }),
  };
});
