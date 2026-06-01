import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors the Rust Location struct returned by cmd_definition (see
// crates/latte-editor/src/cmd/graph.rs). camelCase because Tauri 2 IPC
// renames snake_case Rust fields on the wire. Renamed from `Location`
// to `GoToLocation` to avoid colliding with the DOM `Location` type when
// imported into apps that include DOM lib types.
export interface GoToLocation { file: string; line: number; col: number }

export function useGoToDef() {
  const [busy, setBusy] = useState(false);
  const onSymbolClick = useCallback(async (symbol: string): Promise<GoToLocation | null> => {
    setBusy(true);
    try {
      return await invoke<GoToLocation | null>("cmd_definition", { symbol });
    } finally { setBusy(false); }
  }, []);
  return { onSymbolClick, busy };
}
