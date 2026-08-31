// useWorkspaceStore 单测
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore, type WorkspaceMeta } from "./useWorkspaceStore";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const sampleMeta = (id: string, name: string): WorkspaceMeta => ({
  name,
  project_root: `/tmp/${name}`,
  open_tabs: [],
  active_tab: null,
  ui_state: {
    sidebar_width: 240,
    outline_width: 180,
    editor_flex: 0.5,
    sidebar_open: true,
    active_panel: "split",
    sidebar_panel: "explorer",
  },
  last_used_at: 0,
});

/** 模拟后端 open_folder 命令的返回（与 Rust OpenFolderResult 字段对齐） */
const openFolderResult = (wsId: string, name: string) => ({
  root: `/tmp/${name}`,
  entries: [],
  has_graph: false,
  graph_node_count: 0,
  workspace_id: wsId,
  workspace_meta: sampleMeta(wsId, name),
});

describe("useWorkspaceStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkspaceStore.setState({
      workspaces: {},
      activeWorkspaceId: null,
      windowMappings: {},
      hydrated: false,
    });
  });

  it("hydrate sets workspaces and picks most recent as active", async () => {
    invokeMock.mockResolvedValueOnce([
      { id: "ws-a", meta: { ...sampleMeta("ws-a", "alpha"), last_used_at: 100 } },
      { id: "ws-b", meta: { ...sampleMeta("ws-b", "beta"), last_used_at: 200 } },
    ]);
    await useWorkspaceStore.getState().hydrate();
    const s = useWorkspaceStore.getState();
    expect(s.hydrated).toBe(true);
    expect(Object.keys(s.workspaces)).toEqual(["ws-a", "ws-b"]);
    expect(s.activeWorkspaceId).toBe("ws-b");
  });

  // 原用例名为 "hydrate handles empty list"，但只用 mockResolvedValueOnce
  // 铺了一次返回值：重试那次拿到 undefined，`for...of` 抛 TypeError 被
  // catch 兜住，而 catch 里设了 hydrated:true、activeWorkspaceId 保持 null，
  // 两个断言恰好都成立 —— 它验的是异常路径，不是空列表路径（假绿）。
  // 这里改成两次都返回空数组，并断言重试确实发生。
  it("hydrate handles empty list and retries exactly once", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockResolvedValue([]);
    try {
      const pending = useWorkspaceStore.getState().hydrate();
      // 跳过 hydrate 内部那 500ms 的真实等待（原用例每跑一次就慢 500ms）
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
    const s = useWorkspaceStore.getState();
    expect(s.activeWorkspaceId).toBeNull();
    expect(s.hydrated).toBe(true);
    expect(Object.keys(s.workspaces)).toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    // 空列表是正常分支，不该走进错误处理
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("hydrate tolerates a non-array response without throwing", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 后端命令未注册 / 序列化失败时 invoke 可能给出 undefined。
    // 修复前这里会抛 "list is not iterable" 并被 catch 吞掉。
    invokeMock.mockResolvedValue(undefined);
    try {
      const pending = useWorkspaceStore.getState().hydrate();
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
    const s = useWorkspaceStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.activeWorkspaceId).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("openFolder writes store and invokes backend", async () => {
    invokeMock.mockResolvedValueOnce(openFolderResult("ws-x", "x"));
    const result = await useWorkspaceStore.getState().openFolder("/tmp/x");
    expect(result.workspace_id).toBe("ws-x");
    expect(result.root).toBe("/tmp/x");
    expect(result.has_graph).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("open_folder", { path: "/tmp/x" });
    const s = useWorkspaceStore.getState();
    expect(s.activeWorkspaceId).toBe("ws-x");
    expect(s.workspaces["ws-x"].name).toBe("x");
    expect(s.workspaces["ws-x"].project_root).toBe("/tmp/x");
  });

  it("openFolder does not leak stale entry when same path opened twice", async () => {
    // 第 1 次打开
    invokeMock.mockResolvedValueOnce(openFolderResult("ws-x", "x"));
    await useWorkspaceStore.getState().openFolder("/tmp/x");
    // 模拟用户又重新打开：第 2 次
    invokeMock.mockResolvedValueOnce(openFolderResult("ws-x", "x"));
    const result2 = await useWorkspaceStore.getState().openFolder("/tmp/x");
    expect(result2.workspace_id).toBe("ws-x");
    // 字典里只有 1 个 key（不是 "/tmp/x" + "ws-x" 两个）
    expect(Object.keys(useWorkspaceStore.getState().workspaces)).toEqual(["ws-x"]);
  });

  it("setActive refuses missing workspace", async () => {
    await useWorkspaceStore.getState().setActive("ghost");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
  });

  it("setActive keeps the current workspace when the backend rejects", async () => {
    useWorkspaceStore.setState({
      workspaces: {
        "ws-a": sampleMeta("ws-a", "a"),
        "ws-b": sampleMeta("ws-b", "b"),
      },
      activeWorkspaceId: "ws-a",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(new Error("backend unavailable"));

    await useWorkspaceStore.getState().setActive("ws-b");

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("setActive switches and calls backend", async () => {
    useWorkspaceStore.setState({
      workspaces: {
        "ws-a": sampleMeta("ws-a", "a"),
        "ws-b": sampleMeta("ws-b", "b"),
      },
      activeWorkspaceId: "ws-a",
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await useWorkspaceStore.getState().setActive("ws-b");
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-b");
    expect(invokeMock).toHaveBeenCalledWith("set_active_workspace", {
      workspaceId: "ws-b",
    });
  });

  it("closeWorkspace removes from map and clears active if needed", async () => {
    useWorkspaceStore.setState({
      workspaces: { "ws-a": sampleMeta("ws-a", "a") },
      activeWorkspaceId: "ws-a",
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await useWorkspaceStore.getState().closeWorkspace("ws-a");
    const s = useWorkspaceStore.getState();
    expect(s.workspaces["ws-a"]).toBeUndefined();
    expect(s.activeWorkspaceId).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("close_workspace", { workspaceId: "ws-a" });
  });

  it("closeWorkspace preserves local state when the backend close fails", async () => {
    useWorkspaceStore.setState({
      workspaces: { "ws-a": sampleMeta("ws-a", "a") },
      activeWorkspaceId: "ws-a",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) =>
      command === "close_workspace"
        ? Promise.reject(new Error("backend unavailable"))
        : Promise.resolve(undefined),
    );

    await useWorkspaceStore.getState().closeWorkspace("ws-a");

    expect(useWorkspaceStore.getState().workspaces["ws-a"]).toBeDefined();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-a");

    // A second attempt must not be blocked by a leaked debug lock.
    invokeMock.mockResolvedValue(undefined);
    await useWorkspaceStore.getState().closeWorkspace("ws-a");
    expect(useWorkspaceStore.getState().workspaces["ws-a"]).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("updateMeta updates local optimistically and invokes backend with snake_case", async () => {
    useWorkspaceStore.setState({
      workspaces: { "ws-a": sampleMeta("ws-a", "a") },
      activeWorkspaceId: "ws-a",
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await useWorkspaceStore
      .getState()
      .updateMeta("ws-a", { open_tabs: ["/a/foo.rs"], active_tab: "/a/foo.rs" });
    const m = useWorkspaceStore.getState().workspaces["ws-a"];
    expect(m.open_tabs).toEqual(["/a/foo.rs"]);
    expect(m.active_tab).toBe("/a/foo.rs");
    expect(invokeMock).toHaveBeenCalledWith("update_workspace_meta", {
      args: {
        workspace_id: "ws-a",
        open_tabs: ["/a/foo.rs"],
        active_tab: "/a/foo.rs",
        ui_state: undefined,
        name: undefined,
      },
    });
  });

  it("updateMeta does not clobber fields omitted from patch", async () => {
    const meta = sampleMeta("ws-a", "a");
    meta.open_tabs = ["/a/x.rs"];
    useWorkspaceStore.setState({ workspaces: { "ws-a": meta } });
    invokeMock.mockResolvedValueOnce(undefined);
    await useWorkspaceStore.getState().updateMeta("ws-a", { name: "renamed" });
    const m = useWorkspaceStore.getState().workspaces["ws-a"];
    expect(m.name).toBe("renamed");
    expect(m.open_tabs).toEqual(["/a/x.rs"]); // 保留
  });

  it("getActive returns null when no active workspace", () => {
    expect(useWorkspaceStore.getState().getActive()).toBeNull();
  });

  it("getActive returns full info when active", () => {
    useWorkspaceStore.setState({
      workspaces: { "ws-a": sampleMeta("ws-a", "a") },
      activeWorkspaceId: "ws-a",
    });
    const active = useWorkspaceStore.getState().getActive();
    expect(active?.id).toBe("ws-a");
    expect(active?.meta.name).toBe("a");
  });

  it("listAll returns all workspaces", () => {
    useWorkspaceStore.setState({
      workspaces: {
        "ws-a": sampleMeta("ws-a", "a"),
        "ws-b": sampleMeta("ws-b", "b"),
      },
    });
    const list = useWorkspaceStore.getState().listAll();
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.id).sort()).toEqual(["ws-a", "ws-b"]);
  });

  it("detachToWindow invokes backend and records window mapping", async () => {
    useWorkspaceStore.setState({
      workspaces: { "ws-a": sampleMeta("ws-a", "a") },
    });
    invokeMock.mockResolvedValueOnce("workspace-ws-a");
    const label = await useWorkspaceStore.getState().detachToWindow("ws-a");
    expect(label).toBe("workspace-ws-a");
    expect(useWorkspaceStore.getState().windowMappings["workspace-ws-a"]).toBe("ws-a");
  });
});
