import { create } from "zustand";
import type { ModelInfo, RoleConfigResponse } from "../api/chat";
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
} from "../api/chat";
import { openFile } from "../api/commands";
import { useEditorStore } from "./useEditorStore";

export type ChatStatus = "idle" | "running" | "completed" | "error";

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
  role_id: string;
  icon: string;
  response: string;
  round: number;
  step_id: string;
  turn_number: number;
}

interface ChatStore {
  messages: ChatMessage[];
  status: ChatStatus;
  sessionId: number | null;
  errorMessage: string | null;
  selectedWorkflow: string;
  availableWorkflows: { id: string; name: string }[];
  availableRoles: {
    id: string;
    name: string;
    icon: string;
    /** Back-compat: equals `model_chain[0]` or the global default. */
    model: string;
    /** Priority-ordered model chain. Empty when the role has no chain yet. */
    model_chain: string[];
  }[];

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

  setWorkflow: (id: string) => void;
  loadWorkflows: () => Promise<void>;
  loadModels: () => Promise<void>;
  loadRoleConfig: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  cancelDiscussion: () => Promise<void>;
  clearChat: () => void;
  addTurn: (turn: ChatTurn) => void;
  setComplete: () => void;
  setError: (msg: string) => void;

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
}

let nextMessageId = 1;
function uid(): string {
  return `m${Date.now()}-${nextMessageId++}`;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  status: "idle",
  sessionId: null,
  errorMessage: null,
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

  setWorkflow: (id) => set({ selectedWorkflow: id }),

  loadWorkflows: async () => {
    try {
      const config = await getRoleConfig();
      set({
        availableWorkflows: config.workflows.map((w) => ({
          id: w.id,
          name: w.name,
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
        // `default_model_tier` so old single-model configs still
        // surface as a one-element chain in the UI.
        const chain =
          r.model_chain && r.model_chain.length > 0
            ? r.model_chain
            : r.default_model_tier
              ? [r.default_model_tier]
              : [];
        roleChains[r.id] = chain;
        // The dropdown's "primary" is the chain head; if the chain
        // is empty, fall back to the global default.
        roleModels[r.id] = chain[0] ?? config.default_model;
      });
      set({
        availableRoles: config.roles.map((r) => ({
          id: r.id,
          name: r.name,
          icon: r.icon,
          model: roleModels[r.id],
          model_chain: roleChains[r.id] ?? [],
        })),
        defaultModel: config.default_model,
        roleModels,
        roleChains,
        modelsPath: config.models_path,
        rolesPath: config.roles_path,
      });
    } catch (e) {
      console.error("loadRoleConfig failed:", e);
    }
  },

  sendMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
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
    }));
    try {
      const state = get();
      if (state.sessionId === null) {
        const sessionId = await startDiscussion({
          topic: trimmed,
          workflow: state.selectedWorkflow,
          custom_roles: null,
          max_rounds: 1,
        });
        set({ sessionId });
      } else {
        await continueDiscussion({ sessionId: state.sessionId, message: trimmed });
      }
    } catch (e) {
      set({ status: "error", errorMessage: String(e) });
    }
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
    set({ messages: [], status: "idle", sessionId: null, errorMessage: null }),

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
            ? { ...r, model: modelId, model_chain: [modelId] }
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
            ? { ...r, model: primary, model_chain: persisted }
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
}));
