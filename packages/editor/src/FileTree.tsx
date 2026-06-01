import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Field names match the camelCase shape Tauri 2 IPC delivers from the Rust
// `FsEntry` struct (see `#[serde(rename_all = "camelCase")]` in cmd/fs.rs).
export interface FsEntry { name: string; path: string; isDir: boolean }

export function FileTree({ onOpen }: { onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  useEffect(() => {
    invoke<FsEntry[]>("list_dir", { path: "." })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, []);
  return (
    <ul className="text-xs font-mono py-1">
      {entries.map(e => (
        <li key={e.path}
            className="px-2 py-0.5 hover:bg-zinc-800 cursor-pointer"
            onClick={() => e.isDir ? null : onOpen(e.path)}>
          {e.isDir ? "📁" : "📄"} {e.name}
        </li>
      ))}
    </ul>
  );
}
