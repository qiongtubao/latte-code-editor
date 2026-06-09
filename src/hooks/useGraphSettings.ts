// Graph auto-update settings store.
// Persisted to app_data_dir/settings.json via IPC.
import { create } from "zustand";
import {
  getGraphSettings,
  setGraphSettings,
  type GraphSettings,
} from "../api/graphSettings";

interface GraphSettingsState extends GraphSettings {
  loading: boolean;
  /** Fetch from backend and populate the store. */
  hydrate: () => Promise<void>;
  /** Persist + push to running hub. */
  setAutoUpdateEnabled: (v: boolean) => Promise<void>;
  setDebounceMs: (v: number) => Promise<void>;
  setMaxFilesPerBatch: (v: number) => Promise<void>;
  setLowMemorySkipMb: (v: number) => Promise<void>;
}

export const useGraphSettings = create<GraphSettingsState>((set, get) => ({
  auto_update_enabled: true,
  debounce_ms: 1500,
  max_files_per_batch: 200,
  low_memory_skip_mb: 512,
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    try {
      const s = await getGraphSettings();
      set({ ...s, loading: false });
    } catch {
      // keep defaults on error
      set({ loading: false });
    }
  },

  setAutoUpdateEnabled: async (v) => {
    const next = { ...get(), auto_update_enabled: v };
    set(next);
    await setGraphSettings(next);
  },
  setDebounceMs: async (v) => {
    const next = { ...get(), debounce_ms: v };
    set(next);
    await setGraphSettings(next);
  },
  setMaxFilesPerBatch: async (v) => {
    const next = { ...get(), max_files_per_batch: v };
    set(next);
    await setGraphSettings(next);
  },
  setLowMemorySkipMb: async (v) => {
    const next = { ...get(), low_memory_skip_mb: v };
    set(next);
    await setGraphSettings(next);
  },
}));
