import { Profiler } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore, type WorkspaceMeta } from "../hooks/useWorkspaceStore";
import { WorkspaceTabs } from "./WorkspaceTabs";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const workspace = (overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({
  name: "latte",
  project_root: "/repo/latte",
  open_tabs: ["/repo/latte/a.ts"],
  active_tab: "/repo/latte/a.ts",
  ui_state: {
    sidebar_width: 240,
    outline_width: 180,
    editor_flex: 0.5,
    sidebar_open: true,
    active_panel: "editor",
    sidebar_panel: "explorer",
  },
  last_used_at: 1,
  chat_state: null,
  ...overrides,
});

describe("WorkspaceTabs subscriptions", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: { ws: workspace() },
      activeWorkspaceId: "ws",
      windowMappings: {},
      hydrated: true,
    });
  });

  it("ignores metadata changes that do not affect the displayed tabs", () => {
    let commits = 0;
    render(
      <Profiler id="workspace-tabs" onRender={() => { commits += 1; }}>
        <WorkspaceTabs />
      </Profiler>,
    );
    const initialCommits = commits;

    act(() => useWorkspaceStore.setState({
      workspaces: {
        ws: workspace({
          active_tab: "/repo/latte/other.ts",
          last_used_at: 2,
        }),
      },
    }));
    expect(commits).toBe(initialCommits);

    act(() => useWorkspaceStore.setState({
      workspaces: {
        ws: workspace({
          open_tabs: ["/repo/latte/a.ts", "/repo/latte/b.ts"],
        }),
      },
    }));
    expect(commits).toBeGreaterThan(initialCommits);
  });
});
