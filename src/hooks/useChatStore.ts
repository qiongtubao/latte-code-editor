import { create } from "zustand";
import {
  listWorkflows,
  listRoles,
  startDiscussion,
  continueDiscussion,
  cancelDiscussion,
} from "../api/chat";
import type { StartDiscussionRequest } from "../api/chat";

export interface ChatTurn {
  agent: string;
  roleId: string;
  icon: string;
  response: string;
  round: number;
  stepId: string;
  turnNumber: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  agentIcon?: string;
  agentName?: string;
  content: string;
  timestamp: number;
}

export type ChatStatus = "idle" | "running" | "completed" | "error";

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  defaultRoles: string[];
  steps: string[];
}

export interface RoleInfo {
  id: string;
  name: string;
  icon: string;
  category: string;
  defaultModelTier: string;
}

interface ChatStore {
  messages: ChatMessage[];
  status: ChatStatus;
  sessionId: number | null;
  errorMessage: string | null;
  selectedWorkflow: string;
  availableWorkflows: WorkflowInfo[];
  availableRoles: RoleInfo[];

  setWorkflow: (id: string) => void;
  loadWorkflows: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  cancelDiscussion: () => Promise<void>;
  clearChat: () => void;
  addTurn: (turn: ChatTurn) => void;
  setComplete: () => void;
  setError: (msg: string) => void;
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
  selectedWorkflow: "default_workflow",
  availableWorkflows: [],
  availableRoles: [],

  setWorkflow: (id) => set({ selectedWorkflow: id }),

  loadWorkflows: async () => {
    try {
      const [wfs, roles] = await Promise.all([listWorkflows(), listRoles()]);
      set({ availableWorkflows: wfs, availableRoles: roles });
    } catch (e) {
      console.error("loadWorkflows failed:", e);
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
        const req: StartDiscussionRequest = {
          topic: trimmed,
          workflow: state.selectedWorkflow,
          customRoles: null,
          maxRounds: 1,
        };
        const sessionId = await startDiscussion(req);
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
    if (sessionId === null) return;
    try {
      await cancelDiscussion(sessionId);
    } catch (e) {
      console.error("cancel failed:", e);
    }
    set({ status: "idle" });
  },

  clearChat: () => set({ messages: [], status: "idle", sessionId: null, errorMessage: null }),

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
}));
