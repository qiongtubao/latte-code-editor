import { useEditorStore } from "../hooks/useEditorStore";
import { useGraphSettings } from "../hooks/useGraphSettings";

export function StatusBar({
  onToggleSettings,
}: {
  onToggleSettings: () => void;
}) {
  const { openFile, modified, tabState, filePath } = useEditorStore();
  const autoUpdate = useGraphSettings((s) => s.auto_update_enabled);

  const getLanguageLabel = (path: string | null): string => {
    if (!path) return "";
    const ext = path.split(".").pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      ts: "TypeScript",
      tsx: "TypeScript JSX",
      js: "JavaScript",
      jsx: "JavaScript JSX",
      rs: "Rust",
      py: "Python",
      json: "JSON",
      md: "Markdown",
      css: "CSS",
      html: "HTML",
    };
    return langMap[ext || ""] || ext?.toUpperCase() || "";
  };

  const getLineInfo = (): string => {
    if (!openFile) return "";
    return `${openFile.line_count} lines`;
  };

  return (
    <div
      className="flex items-center justify-between px-4 py-0.5 text-xs select-none"
      style={{
        background: "#007acc",
        color: "#fff",
        height: "24px",
      }}
    >
      <div className="flex items-center gap-4">
        {filePath && <span>{getLanguageLabel(filePath)}</span>}
        {modified && <span className="opacity-80">● Modified</span>}
      </div>
      <div className="flex items-center gap-4">
        {tabState === "large-file" && (
          <span className="opacity-90">⚠ Large File</span>
        )}
        {openFile && <span className="opacity-80">{getLineInfo()}</span>}
        <button
          onClick={onToggleSettings}
          title={
            autoUpdate
              ? "Graph auto-update: ON — click to configure"
              : "Graph auto-update: OFF — click to configure"
          }
          className="flex items-center gap-1 opacity-80 hover:opacity-100 cursor-pointer"
        >
          <span>{autoUpdate ? "⚡" : "⏸"}</span>
          <span>{autoUpdate ? "Auto" : "Manual"}</span>
        </button>
      </div>
    </div>
  );
}