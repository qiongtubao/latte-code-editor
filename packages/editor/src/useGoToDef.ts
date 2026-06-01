import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors the Rust Location struct returned by cmd_definition (see
// crates/latte-editor/src/cmd/graph.rs). camelCase because Tauri 2 IPC
// renames snake_case Rust fields on the wire.
export interface Location { file: string; line: number; col: number }

export function useGoToDef() {
  const [busy, setBusy] = useState(false);
  const onSymbolClick = useCallback(async (symbol: string): Promise<Location | null> => {
    setBusy(true);
    try {
      return await invoke<Location | null>("cmd_definition", { symbol });
    } finally { setBusy(false); }
  }, []);
  return { onSymbolClick, busy };
}
