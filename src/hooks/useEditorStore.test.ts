// useEditorStore 单测
//
// 测试目标：
// - openFileOrSwitch 添加 tab + 切换到新 tab
// - 切换 activeWorkspaceId 后 tabs 派生切换、状态不丢
// - 同一 workspace 内 setContent 改 currentContent
// - closeTab 调整 activeIndex
// - evictWorkspace 清理数据
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useEditorStore } from "./useEditorStore";
import { useWorkspaceStore } from "./useWorkspaceStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const makeFile = (path: string, content = "hello") => ({
  path,
  content,
  line_count: 1,
  is_large_file: false,
  is_modified: false,
});

describe("useEditorStore", () => {
  beforeEach(() => {
    useEditorStore.setState({
      byWorkspace: {},
      tabs: [],
      activeIndex: 0,
      openFile: null,
      currentContent: "",
      tabState: "empty",
      modified: false,
      filePath: null,
      cursorWord: "",
      targetLine: null,
    });
    useWorkspaceStore.setState({
      workspaces: {},
      activeWorkspaceId: null,
      windowMappings: {},
      hydrated: true,
    });
  });

  it("openFileOrSwitch without active workspace is a no-op", () => {
    useEditorStore.getState().openFileOrSwitch(makeFile("/a.rs"));
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  it("openFileOrSwitch adds a new tab and updates derived fields", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useEditorStore.getState().openFileOrSwitch(makeFile("/a.rs", "alpha"));
    const s = useEditorStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.filePath).toBe("/a.rs");
    expect(s.currentContent).toBe("alpha");
    expect(s.tabState).toBe("code");
    expect(s.modified).toBe(false);
  });

  it("re-opening same file path does not duplicate tab", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useEditorStore.getState().openFileOrSwitch(makeFile("/a.rs", "v1"));
    useEditorStore.getState().openFileOrSwitch(makeFile("/a.rs", "v2"));
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().currentContent).toBe("v2");
  });

  it("switching workspace exposes different tabs without losing prior data", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useEditorStore.getState().openFileOrSwitch(makeFile("/a/foo.rs"));
    expect(useEditorStore.getState().filePath).toBe("/a/foo.rs");

    // 切到另一个 workspace
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-b" });
    // 派生字段应该变空（ws-b 还没打开文件）
    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(useEditorStore.getState().filePath).toBeNull();
    expect(useEditorStore.getState().tabState).toBe("empty");

    // 切回 ws-a，数据还在
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    expect(useEditorStore.getState().filePath).toBe("/a/foo.rs");
    expect(useEditorStore.getState().tabs).toHaveLength(1);
  });

  it("setContent marks tab as modified and updates currentContent", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useEditorStore.getState().openFileOrSwitch(makeFile("/a.rs", "alpha"));
    useEditorStore.getState().setContent("beta");
    const s = useEditorStore.getState();
    expect(s.currentContent).toBe("beta");
    expect(s.modified).toBe(true);
    // tab 上的 is_modified 也被设置
    expect(s.tabs[0].result.is_modified).toBe(true);
  });

  it("closeTab adjusts activeIndex correctly", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useEditorStore.getState().openFileOrSwitch(makeFile("/a/1.rs"));
    useEditorStore.getState().openFileOrSwitch(makeFile("/a/2.rs"));
    useEditorStore.getState().openFileOrSwitch(makeFile("/a/3.rs"));
    // active = 2 (/a/3.rs)
    expect(useEditorStore.getState().filePath).toBe("/a/3.rs");
    // 关闭索引 0（/a/1.rs）
    useEditorStore.getState().closeTab(0);
    const s = useEditorStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs.map((t) => t.result.path)).toEqual(["/a/2.rs", "/a/3.rs"]);
    // active 之前在 2，关闭 0 后变 1（指向 /a/3.rs）
    expect(s.filePath).toBe("/a/3.rs");
  });

  it("closeTab when no tabs left clears derived state", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useEditorStore.getState().openFileOrSwitch(makeFile("/a.rs"));
    useEditorStore.getState().closeTab(0);
    const s = useEditorStore.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.filePath).toBeNull();
    expect(s.tabState).toBe("empty");
  });

  it("evictWorkspace removes workspace's data", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useEditorStore.getState().openFileOrSwitch(makeFile("/a/foo.rs"));
    useEditorStore.getState().evictWorkspace("ws-a");
    // 派生字段清空
    expect(useEditorStore.getState().tabs).toHaveLength(0);
    // 内部 map 也清空
    expect(useEditorStore.getState().byWorkspace["ws-a"]).toBeUndefined();
  });

  it("setTargetLine and setCursorWord follow active workspace", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useEditorStore.getState().setTargetLine(42);
    useEditorStore.getState().setCursorWord("foo");
    expect(useEditorStore.getState().targetLine).toBe(42);
    expect(useEditorStore.getState().cursorWord).toBe("foo");
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-b" });
    // ws-b 没有数据
    expect(useEditorStore.getState().targetLine).toBeNull();
    expect(useEditorStore.getState().cursorWord).toBe("");
    // 切回 ws-a 还在
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    expect(useEditorStore.getState().targetLine).toBe(42);
  });

  it("large_file flag maps tabState to large-file", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    const f = makeFile("/big.bin", "x");
    f.is_large_file = true;
    useEditorStore.getState().openFileOrSwitch(f);
    expect(useEditorStore.getState().tabState).toBe("large-file");
  });
});
