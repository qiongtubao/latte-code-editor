// Graph auto-update settings API
import { invoke } from "@tauri-apps/api/core";

export interface GraphSettings {
  auto_update_enabled: boolean;
  debounce_ms: number;
  max_files_per_batch: number;
  low_memory_skip_mb: number;
}

export async function getGraphSettings(): Promise<GraphSettings> {
  return invoke<GraphSettings>("get_graph_settings");
}

export async function setGraphSettings(
  settings: GraphSettings,
): Promise<void> {
  return invoke<void>("set_graph_settings", { newGraph: settings });
}
