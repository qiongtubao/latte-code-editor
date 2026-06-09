// Listens to Tauri events emitted by the incremental hub and
// dispatches requests to re-load graph data when the hub reports
// an update.
import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useGraphStore } from "./useGraphStore";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { useGraphSettings } from "./useGraphSettings";

/**
 * Mount once near the root of the app. Subscribes to:
 * - `graph-updated:<ws_id>` → triggers graph reload for that workspace
 * Each event is namespaced so only the active workspace's graph
 * refreshes when data changes.
 */
export function useGraphEvents() {
  const unlisteners = useRef<UnlistenFn[]>([]);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const settings = useGraphSettings((s) => s.auto_update_enabled);

  // Subscribe to graph-updated for the active workspace. When the
  // active workspace changes, we swap listeners.
  useEffect(() => {
    // Clear stale listeners.
    for (const u of unlisteners.current) u();
    unlisteners.current = [];

    if (!activeId) return;

    const updatedEvent = `graph-updated:${activeId}`;
    let mounted = true;

    listen<{ nodes_added: number; nodes_removed: number }>(
      updatedEvent,
      () => {
        if (!mounted) return;
        // Request a frontend graph reload — GraphPanel's loadVersion
        // watcher will pick this up.
        useGraphStore.getState().requestReload();
      },
    ).then((u) => {
      if (mounted) unlisteners.current.push(u);
    });

    return () => {
      mounted = false;
    };
    // settings is read only; we re-sub when activeId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    // Hydrate settings once on mount.
    useGraphSettings.getState().hydrate();
  }, []);
}
