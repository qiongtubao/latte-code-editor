import { invoke } from "@tauri-apps/api/core";

export function TopBar({
  workspace,
  onWorkspace,
}: {
  workspace: string | null;
  onWorkspace: (path: string) => void;
}) {
  return (
    <div className="h-9 px-3 flex items-center gap-3 bg-zinc-800 border-b border-zinc-700 text-xs">
      <button
        data-testid="open-folder-btn"
        className="px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600"
        onClick={async () => {
          try {
            const picked = await invoke<string | null>("cmd_pick_folder");
            if (picked) {
              await invoke("cmd_set_workspace", { path: picked });
              onWorkspace(picked);
            }
          } catch (err) {
            console.error("open folder failed:", err);
          }
        }}
      >
        Open Folder
      </button>
      <span className="text-zinc-400 truncate">
        {workspace ?? "no workspace"}
      </span>
    </div>
  );
}
