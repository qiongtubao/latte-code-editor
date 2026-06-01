import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface FsEntry { name: string; path: string; is_dir: boolean }

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
            onClick={() => e.is_dir ? null : onOpen(e.path)}>
          {e.is_dir ? "📁" : "📄"} {e.name}
        </li>
      ))}
    </ul>
  );
}
