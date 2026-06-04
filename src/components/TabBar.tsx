import { useEditorStore } from "../hooks/useEditorStore";

export function TabBar() {
  const { tabs, activeIndex, switchTab, closeTab } = useEditorStore();

  if (tabs.length === 0) return null;

  return (
    <div
      className="flex items-center text-xs overflow-x-auto bg-[#252526] border-b border-gray-700 select-none"
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
            className={`flex items-center gap-1 px-3 h-full cursor-pointer border-r border-gray-700 whitespace-nowrap max-w-48 ${
              isActive
                ? "bg-[#1e1e1e] text-white border-t-2 border-t-[#007acc]"
                : "bg-[#2d2d2d] text-gray-400 hover:text-gray-200"
            }`}
            title={tab.result.path}
          >
            <span className="truncate">{fileName}</span>
            {shortDir && (
              <span className="text-gray-600 text-2xs truncate hidden sm:inline">
                {shortDir}
              </span>
            )}
            {tab.result.is_modified && (
              <span className="text-yellow-400 text-xs">●</span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(i);
              }}
              className="ml-0.5 text-gray-500 hover:text-white hover:bg-[#555] rounded-sm px-0.5 leading-none"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
