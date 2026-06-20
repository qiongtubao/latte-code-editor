import { create } from "zustand";
import type { ModelInfo, RoleConfigResponse, RoleInfo, SwarmEvent, SwarmStepSpec, WorkflowPayload } from "../api/chat";
import {
  listModels,
  getRoleConfig,
  setRoleModel as apiSetRoleModel,
  setRoleModelChain as apiSetRoleModelChain,
  setDefaultModel as apiSetDefaultModel,
  openConfig as apiOpenConfig,
  startDiscussion,
  continueDiscussion,
  cancelDiscussion,
  startSwarm,
  saveWorkflow as apiSaveWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  resetRolesToDefaults as apiResetRolesToDefaults,
  startManagerSession as startManagerSessionApi,
  submitUserDecision as submitUserDecisionApi,
  submitUserContinue as submitUserContinueApi,
} from "../api/chat";
import { useEditorStore } from "./useEditorStore";
import { openFile } from "../api/commands";
export type ChatStatus = "idle" | "running" | "completed" | "error";

/**
 * Top-level chat mode. `"discuss"` is the original sequential
 * discussion runner; `"swarm"` is the planner-driven flow where the
 * planner breaks the topic into ordered worker steps.
 */
export type ChatMode = "discuss" | "swarm" | "manager";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: number;
  agentIcon?: string;
  agentName?: string;
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
  /** Active chat mode (planned discussion vs planner-driven swarm). */
  mode: ChatMode;
  messages: ChatMessage[];
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
  /** Re-run the last user prompt via the same code path as `sendMessage`.
   *  Used by the retry button after a preflight / orchestrator error. */
  retryLastDiscussion: () => Promise<void>;
  clearChat: () => void;
  addTurn: (turn: ChatTurn) => void;
  setComplete: () => void;
  /** Apply one `chat:swarm_event` from the backend. */
  applySwarmEvent: (event: SwarmEvent) => void;
  /** Send a swarm-mode prompt. No-op when `mode !== "swarm"` or
   *  a swarm is already running. */
  sendSwarm: (topic: string) => Promise<void>;
  // ─── Manager-led workflow state ──────────────────────────────────
  /** Most recent pending decision request. Non-null while the UI
   *  should show option buttons under the last manager bubble. */
  pendingDecision: import("../api/chat").DecisionRequest | null;
  /** Latest streaming status from `chat:manager_status`. `null`
   *  before the first emission or after `clearChat`. */
  managerStatus: import("../api/chat").ManagerStatus | null;
  /** Currently-active manager session id (assigned by
   *  `chat_start_manager_session`). `null` until first launch. */
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

  // Config management
  setRoleModel: (roleId: string, modelId: string) => Promise<void>;
  /**
   * Persist a role's full priority-ordered model chain. Empty chains
   * are rejected by the backend. Returns the persisted (deduplicated)
   * chain on success.
   */
  setRoleModelChain: (roleId: string, chain: string[]) => Promise<string[]>;
  setDefaultModel: (modelId: string) => Promise<void>;
  openConfigFile: (type: "models" | "roles") => Promise<void>;
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
  openWorkflowEditor: (payload: WorkflowPayload) => void;
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
}

let nextMessageId = 1;
function uid(): string {
  return `m${Date.now()}-${nextMessageId++}`;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  mode: "discuss",
  messages: [],
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
  availableWorkflows: [],
  availableRoles: [],
  availableModels: [],
  defaultModel: "deepseek-chat",
  roleModels: {},
  roleChains: {},
  modelsPath: "",
  rolesPath: "",
  configPanelOpen: false,

  // Manager-led workflow
  pendingDecision: null,
  managerStatus: null,
  managerSessionId: null,

  // Workflow editor
  editingWorkflow: null,
  editingDirty: false,
  editingOriginal: null,
  editingSaving: false,
  editingError: null,
  setMode: (mode) => set({ mode, errorMessage: null }),

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
    set({ selectedWorkflow: id, mode: nextMode, errorMessage: null });
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
    // Swarm and Manager modes each have their own send path so the
    // user gets the right event stream for the active workflow.
    if (get().mode === "swarm") {
      await get().sendSwarm(trimmed);
      return;
    }
    if (get().mode === "manager") {
      await get().startManagerSession(trimmed);
      return;
    }
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
      // Save the prompt so the retry button can resend it without
      // the user re-typing. Cleared on success.
      lastUserTopic: trimmed,
    }));
    try {
      const state = get();
      if (state.sessionId === null) {
        const sessionId = await startDiscussion({
          topic: trimmed,
          workflow: state.selectedWorkflow,
          customRoles: null,
          maxRounds: 1,
        });
        // Important: do NOT mark `sessionId` set if the start failed.
        // When the start throws (e.g. all roles are missing API keys),
        // we keep `sessionId === null` so the retry path uses
        // `startDiscussion` again with the same workflow, not
        // `continueDiscussion` (which would need a live session).
        set({ sessionId, lastUserTopic: trimmed });
      } else {
        await continueDiscussion({ sessionId: state.sessionId, message: trimmed });
        set({ lastUserTopic: trimmed });
      }
    } catch (e) {
      // Stay in `idle` so the chat list keeps showing the preflight
      // error bubbles and the retry button — NOT `status: "error"`
      // which would imply a live session is failing.
      set({ status: "idle", errorMessage: String(e) });
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
    const topic = get().lastUserTopic;
    if (!topic) return;
    set((s) => ({
      messages: s.messages.filter((m) => {
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
    const { sessionId } = get();
    if (sessionId !== null) {
      try {
        await cancelDiscussion(sessionId);
      } catch (e) {
        console.error("cancel failed:", e);
      }
      set({ status: "idle" });
    }
  },

  clearChat: () =>
    set({
      messages: [],
      status: "idle",
      sessionId: null,
      swarmSessionId: null,
      activeSwarmId: null,
      swarmPlan: [],
      swarmFiles: [],
      swarmSummary: null,
      errorMessage: null,
      pendingDecision: null,
      managerStatus: null,
      managerSessionId: null,
    }),
  addTurn: (turn) => {
    const agentMsg: ChatMessage = {
      id: uid(),
      role: "agent",
      agentIcon: turn.icon,
      agentName: turn.agent,
      content: turn.response,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, agentMsg] }));
  },

  setComplete: () => set({ status: "completed" }),

  setError: (msg) => set({ status: "error", errorMessage: msg }),

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
    if (get().status === "running") return;
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
    const wf = get().selectedWorkflow || "quick_task";
    set((s) => ({
      messages: [...s.messages, userMsg],
      status: "running",
      errorMessage: null,
      activeSwarmId: wf,
      swarmPlan: [],
      swarmFiles: [],
      swarmSummary: null,
    }));
    try {
      const swarmSessionId = await startSwarm({ topic: trimmed, name: wf });
      set({ swarmSessionId });
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
  applySwarmEvent: (event) => {
    switch (event.kind) {
      case "plan": {
        set((s) => ({
          swarmPlan: event.steps ?? [],
          messages: [...s.messages, {
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
        set((s) => ({
          messages: [...s.messages, {
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
        set((s) => ({
          swarmFiles: [
            ...s.swarmFiles.filter((f) => f.path !== event.path),
            { path: event.path!, kind: event.fileKind! },
          ],
        }));
        return;
      }
      case "summary": {
        set((s) => ({
          swarmSummary: event.content ?? "",
          status: "completed",
          messages: event.content
            ? [
                ...s.messages,
                {
                  id: uid(),
                  role: "agent" as const,
                  agentIcon: "✨",
                  agentName: "synthesis",
                  content: event.content,
                  timestamp: Date.now(),
                },
              ]
            : s.messages,
        }));
        return;
      }
      case "complete": {
        set({ status: "completed" });
        return;
      }
      case "error": {
        set({
          status: "error",
          errorMessage: event.content ?? "swarm error",
        });
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
    // conditionals everywhere.
    const normalized: WorkflowPayload = {
      managerRole: "",
      initialWorkers: [],
      maxTotalSteps: 8,
      maxUserDecisions: 5,
      ...payload,
    };
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
        set({ selectedWorkflow: saved.id });
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
        set({ selectedWorkflow: "discuss" });
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
        selectedWorkflow: "discuss",
      });
    } catch (e) {
      set({ editingSaving: false, editingError: String(e) });
    }
  },


  // ─── Manager-led workflow actions ────────────────────────────────
  /**
   * Start a manager-led interactive session. Drops any stale
   * decisions, records the user's topic as the first message, and
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
}));
