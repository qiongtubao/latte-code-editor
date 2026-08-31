// 多工作区 Tab 栏
//
// 显示位置：顶部 panel switcher 上方
// 每个 tab：workspace 名称（来自 project_root basename）+ 打开 tab 数量
// 右键菜单：关闭、关闭其他、拆出到新窗口
// "+" 按钮：打开文件夹对话框
import { useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

export function WorkspaceTabs() {
  const workspaceIds = useWorkspaceStore(
    useShallow((state) => Object.keys(state.workspaces)),
  );
  const workspaceNames = useWorkspaceStore(
    useShallow((state) =>
      Object.values(state.workspaces).map((workspace) => workspace.name),
    ),
  );
  const workspaceTabCounts = useWorkspaceStore(
    useShallow((state) =>
      Object.values(state.workspaces).map((workspace) => workspace.open_tabs.length),
    ),
  );
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const openFolder = useWorkspaceStore((s) => s.openFolder);
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace);
  const detachToWindow = useWorkspaceStore((s) => s.detachToWindow);

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    workspaceId: string;
  } | null>(null);

  const handleAdd = useCallback(async () => {
    const selected = await dialogOpen({ multiple: false, directory: true });
    if (typeof selected === "string") {
      try {
        await openFolder(selected);
      } catch (e) {
        console.error("openFolder failed:", e);
      }
    }
  }, [openFolder]);

  const items = workspaceIds.map((id, index) => ({
    id,
    name: workspaceNames[index],
    tabCount: workspaceTabCounts[index],
  }));

  const buildMenuItems = (wsId: string): ContextMenuItem[] => [
    {
      label: "Close",
      onClick: () => {
        void closeWorkspace(wsId);
      },
    },
    {
      label: "Close Others",
      onClick: async () => {
        const others = workspaceIds.filter((id) => id !== wsId);
        for (const id of others) {
          await closeWorkspace(id);
        }
      },
    },
    { label: "", separator: true, onClick: () => {} },
    {
      label: "Detach to New Window",
      onClick: async () => {
        try {
          await detachToWindow(wsId);
        } catch (e) {
          console.error("detachToWindow failed:", e);
        }
      },
    },
  ];

  return (
    <div
      className="flex items-center text-xs bg-surface-2 border-b border-edge select-none"
      style={{ height: "32px" }}
    >
      {items.map((it) => {
        const isActive = it.id === activeId;
        return (
          <div
            key={it.id}
            onClick={() => setActive(it.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, workspaceId: it.id });
            }}
            className={`flex items-center gap-1.5 px-3 h-full cursor-pointer border-r border-edge whitespace-nowrap max-w-48 ${
              isActive
                ? "bg-surface text-fg border-t-2 border-t-accent"
                : "bg-surface-3 text-fg-2 hover:text-fg"
            }`}
            title={it.name}
          >
            <span>📁</span>
            <span className="truncate">{it.name}</span>
            {it.tabCount > 0 && (
              <span className="text-fg-3 text-2xs">{it.tabCount}</span>
            )}
          </div>
        );
      })}
      <button
        onClick={handleAdd}
        className="px-3 h-full text-fg-3 hover:text-fg hover:bg-surface-3 cursor-pointer border-r border-edge"
        title="Open Folder (Ctrl+K Ctrl+O)"
      >
        +
      </button>
      {menu && (
        <ContextMenu
          items={buildMenuItems(menu.workspaceId)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
