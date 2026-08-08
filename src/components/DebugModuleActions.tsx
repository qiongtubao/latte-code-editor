import { useDebugStore } from "../utils/debug/store";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { useGraphStore } from "../hooks/useGraphStore";
import { useLspStore } from "../hooks/useLspStore";
import { debugEmit } from "../utils/debug/inject";

export function DebugModuleActions() {
  const isOn = useDebugStore((s) => s.isOn);
  const hydrateWs = useWorkspaceStore((s) => s.hydrate);
  const reloadGraph = useGraphStore((s) => s.requestReload);
  const startLsp = useLspStore((s) => s.startLsp);
  if (!isOn) return null;

  return (
    <div className="flex flex-col gap-1 text-[11px] mt-1 pt-1 border-t border-edge">
      <div className="flex items-center gap-1">
        <span className="w-20 text-fg-2">LSP</span>
        <button
          onClick={() => void debugEmit("lsp.start", { language: "rust" })}
          className="px-1 bg-info rounded hover:bg-accent"
        >
          ▶ start(rust)
        </button>
        <button
          onClick={() => void debugEmit("lsp.stop", { language: "rust" })}
          className="px-1 bg-err rounded hover:bg-err"
        >
          ⏹ stop
        </button>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-20 text-fg-2">Graph</span>
        <button
          onClick={() => reloadGraph()}
          className="px-1 bg-info rounded hover:bg-accent"
        >
          🔄 reload
        </button>
        <button
          onClick={() => void debugEmit("graph.rebuild", {})}
          className="px-1 bg-err rounded hover:bg-err"
        >
          ▶ rebuild ⚠
        </button>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-20 text-fg-2">Workspace</span>
        <button
          onClick={() => void hydrateWs()}
          className="px-1 bg-info rounded hover:bg-accent"
        >
          ↻ hydrate
        </button>
        <button
          onClick={() => startLsp("rust")}
          className="px-1 bg-info rounded hover:bg-accent"
        >
          ▶ direct lsp.start
        </button>
      </div>
    </div>
  );
}
