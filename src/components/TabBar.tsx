import { useEditorStore } from "../hooks/useEditorStore";

export function TabBar() {
  const { tabs, activeIndex, switchTab, closeTab } = useEditorStore();

  if (tabs.length === 0) return null;

  return (
    <div
      className="flex items-center text-xs overflow-x-auto bg-surface-2 border-b border-edge select-none"
      style={{ height: "32px" }}
    >
      {tabs.map((tab, i) => {
        const isActive = i === activeIndex;
        const fileName = tab.result.path.split("/").pop() || tab.result.path;
        const dir = tab.result.path.split("/").slice(0, -1).join("/");
        const shortDir = dir.split("/").pop() || "";

        return (
          <div
            key={tab.result.path}
            onClick={() => switchTab(i)}
            className={`flex items-center gap-1 px-3 h-full cursor-pointer border-r border-edge whitespace-nowrap max-w-48 ${
              isActive
                ? "bg-surface text-fg border-t-2 border-t-accent"
                : "bg-surface-3 text-fg-2 hover:text-fg"
            }`}
            title={tab.result.path}
          >
            <span className="truncate">{fileName}</span>
            {shortDir && (
              <span className="text-fg-3 text-2xs truncate hidden sm:inline">
                {shortDir}
              </span>
            )}
            {tab.result.is_modified && (
              <span className="text-warn text-xs">●</span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
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
