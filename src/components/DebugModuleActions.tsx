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
    <div className="flex flex-col gap-1 text-[11px] mt-1 pt-1 border-t border-gray-700">
      <div className="flex items-center gap-1">
        <span className="w-20 text-gray-400">LSP</span>
        <button
          onClick={() => void debugEmit("lsp.start", { language: "rust" })}
          className="px-1 bg-blue-800 rounded hover:bg-blue-700"
        >
          ▶ start(rust)
        </button>
        <button
          onClick={() => void debugEmit("lsp.stop", { language: "rust" })}
          className="px-1 bg-red-800 rounded hover:bg-red-700"
        >
          ⏹ stop
        </button>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-20 text-gray-400">Graph</span>
        <button
          onClick={() => reloadGraph()}
          className="px-1 bg-blue-800 rounded hover:bg-blue-700"
        >
          🔄 reload
        </button>
        <button
          onClick={() => void debugEmit("graph.rebuild", {})}
          className="px-1 bg-red-800 rounded hover:bg-red-700"
        >
          ▶ rebuild ⚠
        </button>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-20 text-gray-400">Workspace</span>
        <button
          onClick={() => void hydrateWs()}
          className="px-1 bg-blue-800 rounded hover:bg-blue-700"
        >
          ↻ hydrate
        </button>
        <button
          onClick={() => startLsp("rust")}
          className="px-1 bg-blue-800 rounded hover:bg-blue-700"
        >
          ▶ direct lsp.start
        </button>
      </div>
    </div>
  );
}
