import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function usePersistWorkspace(path: string | null) {
  useEffect(() => { if (path) invoke("cmd_set_last_workspace", { path }); }, [path]);
}

export async function loadLastWorkspace(): Promise<string | null> {
  return await invoke<string | null>("cmd_get_last_workspace");
}
