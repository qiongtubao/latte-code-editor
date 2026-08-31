import { useShallow } from "zustand/react/shallow";
import { useEditorStore } from "../hooks/useEditorStore";

export function TabBar() {
  // TabFile contains currentContent, so selecting `tabs` directly creates a new
  // active TabFile on every keystroke. Primitive arrays + shallow comparison
  // rerender only when a path or modified marker actually changes.
  const tabPaths = useEditorStore(useShallow((state) =>
    state.tabs.map((tab) => tab.result.path),
  ));
  const modifiedFlags = useEditorStore(useShallow((state) =>
    state.tabs.map((tab) => tab.result.is_modified),
  ));
  const activeIndex = useEditorStore((state) => state.activeIndex);
  const switchTab = useEditorStore((state) => state.switchTab);
  const closeTab = useEditorStore((state) => state.closeTab);

  if (tabPaths.length === 0) return null;

  return (
    <div
      className="flex items-center text-xs overflow-x-auto bg-surface-2 border-b border-edge select-none"
      style={{ height: "32px" }}
    >
      {tabPaths.map((path, i) => {
        const isActive = i === activeIndex;
        const fileName = path.split("/").pop() || path;
        const dir = path.split("/").slice(0, -1).join("/");
        const shortDir = dir.split("/").pop() || "";

        return (
          <div
            key={path}
            onClick={() => switchTab(i)}
            className={`flex items-center gap-1 px-3 h-full cursor-pointer border-r border-edge whitespace-nowrap max-w-48 ${
              isActive
                ? "bg-surface text-fg border-t-2 border-t-accent"
                : "bg-surface-3 text-fg-2 hover:text-fg"
            }`}
            title={path}
          >
            <span className="truncate">{fileName}</span>
            {shortDir && (
              <span className="text-fg-3 text-2xs truncate hidden sm:inline">
                {shortDir}
              </span>
            )}
            {modifiedFlags[i] && (
              <span className="text-warn text-xs">●</span>
            )}
            <button
              onClick={(event) => {
                event.stopPropagation();
                closeTab(i);
              }}
              className="ml-0.5 text-fg-3 hover:text-fg hover:bg-control-hover rounded-sm px-0.5 leading-none"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
