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
import type { RoleConfigResponse } from "../api/chat";
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

describe("useChatStore — 角色模型优先级 (chain)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    // Reset the store to a known empty state before each test.
    useChatStore.setState({
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
    expect(programmer?.model).toBe("claude-sonnet-4");

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
    expect(programmer?.model).toBe("a");

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
