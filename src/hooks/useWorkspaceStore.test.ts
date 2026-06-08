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

  it("hydrate handles empty list", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await useWorkspaceStore.getState().hydrate();
    const s = useWorkspaceStore.getState();
    expect(s.activeWorkspaceId).toBeNull();
    expect(s.hydrated).toBe(true);
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
