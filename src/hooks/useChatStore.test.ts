// useChatStore 单测 — 角色模型优先级 (chain) 持久化路径
//
// 覆盖 setRoleModelChain 的 store 行为：
// 1. 前端去重 + 丢空（与后端行为一致）
// 2. 持久化成功后 store 同步更新 roleChains / roleModels / availableRoles
// 3. 后端返回 canonical chain 时，store 用 backend 的形式覆盖本地
// 4. 旧 setRoleModel 兼容路径也会把 chain 写成单元素数组
//
// 不覆盖：Tauri IPC 本身、backend 的写入、YAML 序列化（这些是 Rust 测试范围）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RoleConfigResponse, WorkflowPayload } from "../api/chat";
import { useChatStore } from "./useChatStore";

// 拦截 Tauri invoke；每个测试在 beforeEach 里 reset。
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const baseConfig: RoleConfigResponse = {
  defaultModel: "deepseek-chat",
  modelsPath: "/tmp/models.yaml",
  rolesPath: "/tmp/roles.yaml",
  workflows: [],
  roles: [
    {
      id: "programmer",
      name: "Software Engineer",
      icon: "💻",
      category: "execution",
      defaultModelTier: "claude-sonnet-4",
      modelChain: ["claude-sonnet-4", "deepseek-chat"],
    },
    {
      id: "pm",
      name: "Product Manager",
      icon: "📋",
      category: "planning",
      // Pre-chain config: only the legacy `defaultModelTier` is set.
      defaultModelTier: "gpt-4o",
      modelChain: [],
    },
  ],
};

function workflowPayload(
  payload: Omit<
    WorkflowPayload,
    "managerRole" | "initialWorkers" | "maxTotalSteps" | "maxUserDecisions"
  > &
    Partial<
      Pick<
        WorkflowPayload,
        "managerRole" | "initialWorkers" | "maxTotalSteps" | "maxUserDecisions"
      >
    >,
): WorkflowPayload {
  return {
    managerRole: "",
    initialWorkers: [],
    maxTotalSteps: 8,
    maxUserDecisions: 5,
    ...payload,
  };
}

describe("useChatStore — 角色模型优先级 (chain)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    // Reset the store to a known empty state before each test.
    useChatStore.setState({
      messages: [],
      status: "idle",
      sessionId: null,
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
    });
  });

  it("loadRoleConfig 解析 model_chain 并回填到 roleChains/roleModels/availableRoles", async () => {
    invokeMock.mockResolvedValueOnce(baseConfig);
    await useChatStore.getState().loadRoleConfig();

    const state = useChatStore.getState();
    // Explicit chain survives
    expect(state.roleChains["programmer"]).toEqual([
      "claude-sonnet-4",
      "deepseek-chat",
    ]);
    // Primary is the chain head
    expect(state.roleModels["programmer"]).toBe("claude-sonnet-4");
    // availableRoles mirrors both fields
    const programmer = state.availableRoles.find((r) => r.id === "programmer");
    expect(programmer?.modelChain).toEqual(["claude-sonnet-4", "deepseek-chat"]);
    expect(programmer?.defaultModelTier).toBe("claude-sonnet-4");

    // Legacy `default_model_tier` is wrapped into a one-element chain
    // so the UI editor has a non-empty starting point.
    expect(state.roleChains["pm"]).toEqual(["gpt-4o"]);
    expect(state.roleModels["pm"]).toBe("gpt-4o");
  });

  it("setRoleModelChain 前端去重 + 丢空，并把 backend canonical 写回 store", async () => {
    invokeMock.mockResolvedValueOnce(baseConfig);
    await useChatStore.getState().loadRoleConfig();

    // Simulate the backend returning a deduplicated chain in priority
    // order. The frontend sent [a, b, a, "", c]; backend keeps [a, b, c].
    invokeMock.mockResolvedValueOnce(["a", "b", "c"]);
    const persisted = await useChatStore
      .getState()
      .setRoleModelChain("programmer", ["a", "b", "a", "", "c"]);

    expect(persisted).toEqual(["a", "b", "c"]);
    const state = useChatStore.getState();
    expect(state.roleChains["programmer"]).toEqual(["a", "b", "c"]);
    expect(state.roleModels["programmer"]).toBe("a");
    const programmer = state.availableRoles.find((r) => r.id === "programmer");
    expect(programmer?.modelChain).toEqual(["a", "b", "c"]);
    expect(programmer?.defaultModelTier).toBe("a");

    // Make sure we actually called the right Tauri command with the
    // pre-dedup payload (drop empty + dedup BEFORE the IPC call).
    expect(invokeMock).toHaveBeenCalledWith("chat_set_role_model_chain", {
      request: { roleId: "programmer", chain: ["a", "b", "c"] },
    });
  });

  it("setRoleModelChain 拒绝空链", async () => {
    invokeMock.mockResolvedValueOnce(baseConfig);
    await useChatStore.getState().loadRoleConfig();

    const result = await useChatStore
      .getState()
      .setRoleModelChain("programmer", []);
    expect(result).toEqual([]);
    // No IPC call for an empty chain — store short-circuits.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "chat_set_role_model_chain",
      expect.anything()
    );
  });

  it("setRoleModelChain 后端失败时 store 保留旧 chain", async () => {
    invokeMock.mockResolvedValueOnce(baseConfig);
    await useChatStore.getState().loadRoleConfig();

    const original = useChatStore.getState().roleChains["programmer"];

    invokeMock.mockRejectedValueOnce(new Error("backend down"));
    const result = await useChatStore
      .getState()
      .setRoleModelChain("programmer", ["x", "y"]);

    expect(result).toEqual([]);
    expect(useChatStore.getState().roleChains["programmer"]).toEqual(original);
  });

  it("setRoleModel（legacy 路径）把 chain 写成一元素数组", async () => {
    invokeMock.mockResolvedValueOnce(baseConfig);
    await useChatStore.getState().loadRoleConfig();

    invokeMock.mockResolvedValueOnce(undefined); // chat_set_role_model
    await useChatStore.getState().setRoleModel("programmer", "gpt-4o-mini");

    const state = useChatStore.getState();
    expect(state.roleChains["programmer"]).toEqual(["gpt-4o-mini"]);
    expect(state.roleModels["programmer"]).toBe("gpt-4o-mini");
  });
});

describe("useChatStore — controller ChatEvent display", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useChatStore.setState({
      mode: "discuss",
      messages: [],
      activityEvents: [],
      activeRoles: {},
      status: "idle",
      sessionId: null,
      errorMessage: null,
      lastUserTopic: null,
      selectedWorkflow: "discuss",
      availableWorkflows: [],
      availableRoles: [
        {
          id: "manager",
          name: "工程经理",
          icon: "👔",
          category: "coordination",
          defaultModelTier: "deepseek-chat",
          modelChain: ["deepseek-chat"],
        },
      ],
      availableModels: [],
      defaultModel: "deepseek-chat",
      roleModels: {},
      roleChains: {},
      modelsPath: "",
      rolesPath: "",
      configPanelOpen: false,
    });
  });

  it("renders controller RoleTurn events as agent messages", () => {
    useChatStore.getState().applyChatEvent({
      RoleTurn: {
        role_id: "manager",
        content: "Use the controller runtime.",
        is_complete: true,
      },
    });

    const message = useChatStore.getState().messages[0];
    expect(message.role).toBe("agent");
    expect(message.agentName).toBe("工程经理");
    expect(message.agentIcon).toBe("👔");
    expect(message.content).toBe("Use the controller runtime.");
  });

  it("uses Prompt metadata for unknown role avatars", () => {
    useChatStore.getState().applyChatEvent({
      Prompt: {
        icon: "💻",
        role_id: "programmer",
        model_id: "glm-5.2",
      },
    });
    useChatStore.getState().applyChatEvent({
      RoleTurn: {
        role_id: "programmer",
        content: "我会检查项目结构。",
        is_complete: true,
      },
    });

    const message = useChatStore.getState().messages[0];
    expect(message.agentName).toBe("programmer");
    expect(message.agentIcon).toBe("💻");
  });

  it("renders readable conversation instead of tool protocol", () => {
    useChatStore.getState().applyChatEvent({
      RoleTurn: {
        role_id: "manager",
        content:
          '我先查看项目。\n<tool_call>read {"path":"Cargo.toml"}</tool_call>\n{"type":"assistant_message","content":"已经看完了，接下来我会分析 chat 流程。"}',
        is_complete: true,
      },
    });

    const message = useChatStore.getState().messages[0];
    expect(message.content).toBe(
      "我先查看项目。\n已经看完了，接下来我会分析 chat 流程。",
    );
  });

  it("maps Done and Error events to display status", () => {
    useChatStore.getState().applyChatEvent({ Done: null });
    expect(useChatStore.getState().status).toBe("completed");

    useChatStore.getState().applyChatEvent({
      Error: { message: "turn failed" },
    });
    expect(useChatStore.getState().status).toBe("error");
    expect(useChatStore.getState().errorMessage).toBe("turn failed");
  });

  it("tracks tool and delegate activity events", () => {
    useChatStore.getState().applyChatEvent({
      DelegateStarted: {
        from_role: "manager",
        to_role: "programmer",
        task: "Read the project structure",
      },
    });
    useChatStore.getState().applyChatEvent({
      ToolUse: {
        role_id: "programmer",
        tool_name: "read",
        args: "{\"path\":\"Cargo.toml\"}",
      },
    });

    const state = useChatStore.getState();
    expect(state.activeRoles.programmer.detail).toBe("delegated by manager");
    expect(state.activityEvents.map((e) => e.kind)).toEqual([
      "delegate_started",
      "tool_use",
    ]);
  });
});

// ─── Workflow editor tests ────────────────────────────────────────
//
// Covers the in-memory editing pipeline: open → patch → dirty flag →
// step reorder → save (mocked IPC) → error surface. Doesn't touch
// Tauri — same `invokeMock` pattern as the swarm tests.

describe("useChatStore — workflow editor", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useChatStore.setState({
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
      availableWorkflows: [
        { id: "plan", name: "🗺️ 规划", kind: "planned", mode: "planned" },
      ],
      availableRoles: [
        {
          id: "pm",
          name: "产品经理",
          icon: "📋",
          category: "规划",
          defaultModelTier: "deepseek-chat",
          modelChain: [],
        },
        {
          id: "programmer",
          name: "软件工程师",
          icon: "💻",
          category: "执行",
          defaultModelTier: "deepseek-chat",
          modelChain: [],
        },
      ],
      availableModels: [],
      defaultModel: "deepseek-chat",
      roleModels: {},
      roleChains: {},
      modelsPath: "",
      rolesPath: "",
      configPanelOpen: false,
      editingWorkflow: null,
      editingDirty: false,
      editingOriginal: null,
      editingSaving: false,
      editingError: null,
    });
  });

  it("openWorkflowEditor clones the payload and clears dirty/error", () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "plan",
      name: "🗺️ 规划",
      kind: "planned",
      roles: ["pm"],
      steps: [{ name: "需求", roles: ["pm"] }],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));
    const s = useChatStore.getState();
    expect(s.editingWorkflow?.id).toBe("plan");
    expect(s.editingDirty).toBe(false);
    expect(s.editingError).toBe(null);
    // Mutating the editing copy must not affect the saved original.
    expect(s.editingOriginal).not.toBe(s.editingWorkflow);
  });

  it("patchEditingWorkflow sets dirty when the value changes", () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "plan",
      name: "🗺️ 规划",
      kind: "planned",
      roles: [],
      steps: [],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));
    expect(useChatStore.getState().editingDirty).toBe(false);

    useChatStore.getState().patchEditingWorkflow({ name: "新名字" });
    expect(useChatStore.getState().editingDirty).toBe(true);

    // Resetting to the original clears the dirty flag.
    useChatStore.getState().patchEditingWorkflow({ name: "🗺️ 规划" });
    expect(useChatStore.getState().editingDirty).toBe(false);
  });

  it("addEditingStep / removeEditingStep / moveEditingStep maintain order", () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "plan",
      name: "x",
      kind: "planned",
      roles: [],
      steps: [{ name: "A", roles: ["pm"] }],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));

    useChatStore.getState().addEditingStep();
    useChatStore.getState().addEditingStep();
    expect(useChatStore.getState().editingWorkflow?.steps.map((s) => s.name)).toEqual([
      "A",
      "步骤 2",
      "步骤 3",
    ]);

    useChatStore.getState().removeEditingStep(0);
    expect(useChatStore.getState().editingWorkflow?.steps.map((s) => s.name)).toEqual([
      "步骤 2",
      "步骤 3",
    ]);

    useChatStore.getState().moveEditingStep(1, -1);
    expect(useChatStore.getState().editingWorkflow?.steps.map((s) => s.name)).toEqual([
      "步骤 3",
      "步骤 2",
    ]);
  });

  it("patchEditingStep updates roles for the targeted step only", () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "plan",
      name: "x",
      kind: "planned",
      roles: [],
      steps: [
        { name: "A", roles: ["pm"] },
        { name: "B", roles: ["programmer"] },
      ],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));

    useChatStore.getState().patchEditingStep(1, { roles: ["pm", "programmer"] });
    const steps = useChatStore.getState().editingWorkflow!.steps;
    expect(steps[0].roles).toEqual(["pm"]);
    expect(steps[1].roles).toEqual(["pm", "programmer"]);
  });

  it("saveEditingWorkflow calls chat_save_workflow and surfaces errors", async () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "myflow",
      name: "新流程",
      kind: "planned",
      roles: [],
      steps: [],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));

    invokeMock.mockRejectedValueOnce("工作流 id 不能为空");
    await useChatStore.getState().saveEditingWorkflow();
    expect(invokeMock).toHaveBeenCalledWith("chat_save_workflow", {
      payload: expect.objectContaining({ id: "myflow" }),
    });
    expect(useChatStore.getState().editingError).toBe("工作流 id 不能为空");
    expect(useChatStore.getState().editingSaving).toBe(false);
  });

  it("saveEditingWorkflow success clears dirty + syncs canonical form", async () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "myflow",
      name: "新流程",
      kind: "planned",
      roles: [],
      steps: [],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));
    useChatStore.getState().patchEditingWorkflow({ name: "改了" });
    expect(useChatStore.getState().editingDirty).toBe(true);

    invokeMock.mockResolvedValueOnce({
      workflow: {
        id: "myflow",
        name: "改了",
        kind: "planned",
        roles: [],
        steps: [],
        maxRounds: 1,
        plannerRole: "",
        workerRoles: [],
        maxSteps: 4,
      },
      deleted: false,
    });
    await useChatStore.getState().saveEditingWorkflow();
    expect(useChatStore.getState().editingError).toBe(null);
    expect(useChatStore.getState().editingDirty).toBe(false);
  });

  it("deleteEditingWorkflow refuses backend errors and keeps the editor open", async () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "myflow",
      name: "x",
      kind: "planned",
      roles: [],
      steps: [],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));

    invokeMock.mockRejectedValueOnce("工作流 `default` 是内置预设，不能删除");
    await useChatStore.getState().deleteEditingWorkflow();
    expect(useChatStore.getState().editingError).toContain("内置");
    expect(useChatStore.getState().editingWorkflow).not.toBe(null);
  });

  it("closeWorkflowEditor resets all editing fields", () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "plan",
      name: "x",
      kind: "planned",
      roles: [],
      steps: [],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));
    useChatStore.getState().patchEditingWorkflow({ name: "改了" });

    useChatStore.getState().closeWorkflowEditor();
    const s = useChatStore.getState();
    expect(s.editingWorkflow).toBe(null);
    expect(s.editingOriginal).toBe(null);
    expect(s.editingDirty).toBe(false);
    expect(s.editingError).toBe(null);
  });
});

// ─── resetRolesToDefaults ──────────────────────────────────────────
//
// Verifies the store action that wipes roles.yaml and rebuilds it
// from the embedded Chinese defaults. The IPC call is mocked — we
// only check the resulting store state, not the on-disk file.

describe("useChatStore — resetRolesToDefaults", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useChatStore.setState({
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
      editingWorkflow: null,
      editingDirty: false,
      editingOriginal: null,
      editingSaving: false,
      editingError: null,
    });
  });

  it("dispatches chat_reset_roles_to_defaults and surfaces the fresh config", async () => {
    invokeMock.mockResolvedValueOnce({
      defaultModel: "deepseek-chat",
      roles: [
        {
          id: "programmer",
          name: "软件工程师",
          icon: "💻",
          category: "执行",
          defaultModelTier: "deepseek-chat",
          modelChain: ["deepseek-chat"],
        },
        {
          id: "pm",
          name: "产品经理",
          icon: "📋",
          category: "规划",
          defaultModelTier: "deepseek-chat",
          modelChain: [],
        },
      ],
      workflows: [
        { id: "plan", name: "🗺️ 规划 — 设计与架构", kind: "planned", mode: "planned" },
        { id: "quick_task", name: "🪄 快速任务 — 智能多角色", kind: "swarm", mode: "swarm" },
      ],
    });

    await useChatStore.getState().resetRolesToDefaults();
    expect(invokeMock).toHaveBeenCalledWith("chat_reset_roles_to_defaults");
    const s = useChatStore.getState();
    expect(s.availableRoles.find((r) => r.id === "programmer")?.name).toBe("软件工程师");
    expect(s.availableRoles.find((r) => r.id === "pm")?.name).toBe("产品经理");
    expect(
      s.availableWorkflows.find((w) => w.id === "quick_task"),
    ).toEqual({
      id: "quick_task",
      name: "🪄 快速任务 — 智能多角色",
      kind: "swarm",
      mode: "swarm",
    });
    expect(s.editingError).toBe(null);
    expect(s.editingSaving).toBe(false);
  });

  it("captures backend errors and keeps the editor state intact", async () => {
    useChatStore.getState().openWorkflowEditor(workflowPayload({
      id: "myflow",
      name: "我的流程",
      kind: "planned",
      roles: [],
      steps: [],
      maxRounds: 1,
      plannerRole: "",
      workerRoles: [],
      maxSteps: 4,
    }));

    invokeMock.mockRejectedValueOnce("写入 roles.yaml 失败：permission denied");
    await useChatStore.getState().resetRolesToDefaults();

    const s = useChatStore.getState();
    expect(s.editingError).toContain("permission denied");
    expect(s.editingSaving).toBe(false);
    expect(s.editingWorkflow?.id).toBe("myflow");
  });

  it("populates roleChains from the response so the chain editor has data", async () => {
    invokeMock.mockResolvedValueOnce({
      defaultModel: "deepseek-chat",
      roles: [
        {
          id: "programmer",
          name: "软件工程师",
          icon: "💻",
          category: "执行",
          defaultModelTier: "claude-sonnet-4",
          modelChain: ["claude-sonnet-4", "deepseek-chat"],
        },
      ],
      workflows: [],
      modelsPath: "",
      rolesPath: "",
    });

    await useChatStore.getState().resetRolesToDefaults();

    const s = useChatStore.getState();
    expect(s.roleChains["programmer"]).toEqual(["claude-sonnet-4", "deepseek-chat"]);
    expect(s.roleModels["programmer"]).toBe("claude-sonnet-4");
  });
});

// ─── Avatar + retry path tests ─────────────────────────────────────
//
// These cover the new behavior added to handle per-role preflight
// errors: each broken role gets its own chat:turn (avatar + name +
// `⚠️` prefix), the user prompt is remembered for retry, and
// `retryLastDiscussion` drops error bubbles and re-sends.

describe("useChatStore — retry path", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useChatStore.setState({
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
      editingWorkflow: null,
      editingDirty: false,
      editingOriginal: null,
      editingSaving: false,
      editingError: null,
    });
  });

  it("sendMessage 记住 lastUserTopic 以便重试", async () => {
    invokeMock.mockResolvedValueOnce(1);
    await useChatStore.getState().sendMessage("设计登录页");
    expect(useChatStore.getState().lastUserTopic).toBe("设计登录页");
  });

  it("sendMessage 失败时 sessionId 保持 null（不进 session）", async () => {
    invokeMock.mockRejectedValueOnce(
      "1 个角色缺少 API key，已在上方列出",
    );
    useChatStore.getState().addTurn({
      agent: "软件工程师",
      roleId: "programmer",
      icon: "💻",
      response: "⚠️ `软件工程师` 缺少 API key：deepseek-chat",
      round: 0,
      stepId: "__preflight_error__programmer",
      turnNumber: 0,
    });

    await useChatStore.getState().sendMessage("设计登录页");

    const s = useChatStore.getState();
    expect(s.sessionId, "sessionId must stay null on failure").toBeNull();
    expect(s.status).toBe("error");
    expect(s.errorMessage).toContain("缺少 API key");
    expect(s.lastUserTopic).toBe("设计登录页");
  });

  it("retryLastDiscussion 清除错误气泡并重发上一个话题", async () => {
    invokeMock.mockRejectedValueOnce(
      "1 个角色缺少 API key，已在上方列出",
    );
    await useChatStore.getState().sendMessage("设计登录页");

    useChatStore.getState().addTurn({
      agent: "软件工程师",
      roleId: "programmer",
      icon: "💻",
      response: "⚠️ `软件工程师` 缺少 API key",
      round: 0,
      stepId: "__preflight_error__programmer",
      turnNumber: 0,
    });

    invokeMock.mockResolvedValueOnce(7);
    await useChatStore.getState().retryLastDiscussion();

    const s = useChatStore.getState();
    const lastCall =
      invokeMock.mock.calls[invokeMock.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe("chat_start_discussion");
    expect(lastCall?.[1]).toMatchObject({
      request: { topic: "设计登录页" },
    });
    expect(s.lastUserTopic).toBe("设计登录页");
  });

  it("retryLastDiscussion 没有 lastUserTopic 时是 no-op", async () => {
    await useChatStore.getState().retryLastDiscussion();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("addTurn 接收来自 chat:turn 的 avatar 信息（图标 + 角色名）", () => {
    useChatStore.getState().addTurn({
      agent: "软件工程师",
      roleId: "programmer",
      icon: "💻",
      response: "先做 API 草案",
      round: 0,
      stepId: "design",
      turnNumber: 0,
    });
    const m = useChatStore.getState().messages[0];
    expect(m.role).toBe("agent");
    expect(m.agentIcon).toBe("💻");
    expect(m.agentName).toBe("软件工程师");
    expect(m.content).toBe("先做 API 草案");
  });
});

