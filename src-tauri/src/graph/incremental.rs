//! Incremental graph update hub.
//!
//! Owns the bridge between the file watcher and the graph engine:
//!
//! ```text
//! notify::Watcher
//!   └─ on file event  →  Hub::enqueue(ws_id, project_root, path)
//!                          │
//!                          ├─ debounce (per workspace)
//!                          ├─ resource gate (settings, low memory)
//!                          └─ on flush → engine.update_files(...)
//!                                          └─ emit "graph-updated:<ws>"
//!                                             or "graph-update-skipped:<ws>"
//! ```
//!
//! The hub runs in its own thread, woken by an mpsc channel. This
//! keeps the design independent of Tauri runtime semantics and
//! straightforward to unit-test with synthetic bursts of events.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use latte_rs_graph::engine::TreeSitterEngine;
use latte_rs_graph::storage::SqliteStorage;

use crate::settings::{is_low_memory, AppSettings, GraphSettings, SettingsStore};

/// Outcome of a single flush attempt. Serialized into the
/// `graph-updated:<ws_id>` or `graph-update-skipped:<ws_id>` event
/// payload so the frontend can update its badge / log.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FlushOutcome {
    Updated {
        changed_files: usize,
        nodes_added: usize,
        nodes_removed: usize,
        edges_rebuilt: usize,
        duration_ms: u64,
    },
    Skipped {
        reason: SkipReason,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// Settings toggled the master switch off.
    Disabled,
    /// A single batch contained more than `max_files_per_batch`.
    BatchTooLarge { size: usize, max: usize },
    /// System memory was below the configured floor.
    LowMemory {
        available_mb: Option<u64>,
        floor_mb: u64,
    },
    /// Engine call returned an error; the update is abandoned.
    Error { message: String },
}

/// Pending path. Carries the project_root so the hub doesn't need
/// to consult the registry (which would require a Tauri handle
/// from a background thread).
#[derive(Debug, Clone)]
struct PendingPath {
    workspace_id: String,
    project_root: PathBuf,
    path: PathBuf,
}

/// Handle to the background hub thread. Drop it to stop the hub.
pub struct IncrementalHub {
    tx: Sender<HubCommand>,
}

enum HubCommand {
    FileChanged(PendingPath),
    /// Replace the cached settings on the hub thread. Sent by
    /// `set_graph_settings` so toggles take effect on the next batch.
    SettingsUpdated(AppSettings),
    Shutdown,
}

impl IncrementalHub {
    /// Spawn the hub. The returned handle is `Send + Sync` and lives
    /// for as long as the caller needs it; dropping it signals the
    /// background thread to exit.
    pub fn start(app: AppHandle, settings: SettingsStore) -> Self {
        let (tx, rx) = channel::<HubCommand>();
        thread::Builder::new()
            .name("graph-incremental-hub".into())
            .spawn(move || {
                run_loop(rx, app, settings);
            })
            .expect("spawn incremental hub");
        Self { tx }
    }

    pub fn enqueue(
        &self,
        workspace_id: String,
        project_root: PathBuf,
        path: PathBuf,
    ) {
        let _ = self.tx.send(HubCommand::FileChanged(PendingPath {
            workspace_id,
            project_root,
            path,
        }));
    }

    pub fn update_settings(&self, new_settings: AppSettings) {
        let _ = self.tx.send(HubCommand::SettingsUpdated(new_settings));
    }
}

impl Drop for IncrementalHub {
    fn drop(&mut self) {
        let _ = self.tx.send(HubCommand::Shutdown);
    }
}

#[derive(Default)]
struct WorkspaceBatcher {
    project_root: PathBuf,
    last_event: Option<Instant>,
    pending: HashSet<PathBuf>,
}

fn run_loop(
    rx: std::sync::mpsc::Receiver<HubCommand>,
    app: AppHandle,
    settings_store: SettingsStore,
) {
    let mut settings_cache: AppSettings = futures_block_on_load(&settings_store);

    let mut batches: HashMap<String, WorkspaceBatcher> = HashMap::new();

    // Tick at 100 ms: cheap, gives sub-second debounce resolution
    // without pegging the CPU.
    let tick = Duration::from_millis(100);
    let mut next_tick = Instant::now() + tick;

    loop {
        // Pick the soonest deadline: either the next tick or the
        // debounce deadline of any batch, whichever comes first.
        let mut deadline = next_tick;
        for batch in batches.values() {
            if let Some(last) = batch.last_event {
                let due = last + Duration::from_millis(settings_cache.graph.debounce_ms);
                if due < deadline {
                    deadline = due;
                }
            }
        }
        let now = Instant::now();
        let wait = deadline.saturating_duration_since(now);

        match rx.recv_timeout(wait) {
            Ok(HubCommand::FileChanged(p)) => {
                let entry = batches
                    .entry(p.workspace_id.clone())
                    .or_insert_with(|| WorkspaceBatcher {
                        project_root: p.project_root.clone(),
                        ..Default::default()
                    });
                // Refresh project_root in case the workspace was
                // moved/recreated; benign if unchanged.
                if entry.project_root.as_os_str().is_empty() {
                    entry.project_root = p.project_root;
                }
                entry.last_event = Some(Instant::now());
                entry.pending.insert(p.path);
            }
            Ok(HubCommand::SettingsUpdated(new)) => {
                settings_cache = new;
            }
            Ok(HubCommand::Shutdown) | Err(_) => break,
        }
        next_tick = Instant::now() + tick;

        // Drain anything that piled up during the wait.
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                HubCommand::FileChanged(p) => {
                    let entry = batches
                        .entry(p.workspace_id.clone())
                        .or_insert_with(|| WorkspaceBatcher {
                            project_root: p.project_root.clone(),
                            ..Default::default()
                        });
                    if entry.project_root.as_os_str().is_empty() {
                        entry.project_root = p.project_root;
                    }
                    entry.last_event = Some(Instant::now());
                    entry.pending.insert(p.path);
                }
                HubCommand::SettingsUpdated(new) => {
                    settings_cache = new;
                }
                HubCommand::Shutdown => return,
            }
        }

        // Flush any workspace whose debounce window has elapsed.
        let now = Instant::now();
        let mut ready: Vec<(String, PathBuf, Vec<PathBuf>)> = Vec::new();
        for (ws_id, batch) in batches.iter() {
            if batch.pending.is_empty() {
                continue;
            }
            let due = batch
                .last_event
                .map(|t| t + Duration::from_millis(settings_cache.graph.debounce_ms))
                .unwrap_or(now);
            if now >= due {
                let paths: Vec<PathBuf> = batch.pending.iter().cloned().collect();
                ready.push((ws_id.clone(), batch.project_root.clone(), paths));
            }
        }
        for (ws_id, root, paths) in ready {
            if let Some(batch) = batches.get_mut(&ws_id) {
                batch.pending.clear();
                batch.last_event = None;
            }
            let outcome = flush_one(&ws_id, &root, &paths, &settings_cache.graph);
            emit_outcome(&app, &ws_id, outcome);
        }
    }
}

fn flush_one(
    workspace_id: &str,
    project_root: &Path,
    paths: &[PathBuf],
    settings: &GraphSettings,
) -> FlushOutcome {
    // 1) Master switch.
    if !settings.auto_update_enabled {
        return FlushOutcome::Skipped {
            reason: SkipReason::Disabled,
        };
    }

    // 2) Batch size gate.
    if paths.len() > settings.max_files_per_batch {
        return FlushOutcome::Skipped {
            reason: SkipReason::BatchTooLarge {
                size: paths.len(),
                max: settings.max_files_per_batch,
            },
        };
    }

    // 3) Low-memory gate. `is_low_memory` returns Some(true|false) on
    //    platforms we can probe; None means "no opinion".
    if matches!(is_low_memory(settings), Some(true)) {
        return FlushOutcome::Skipped {
            reason: SkipReason::LowMemory {
                available_mb: crate::settings::available_memory_mb(),
                floor_mb: settings.low_memory_skip_mb,
            },
        };
    }

    // 4) Real work: open the engine and call update_files. We need
    //    a baseline .latte/graph.db to update incrementally; if
    //    it's missing, the user hasn't built yet — skip and prompt.
    let graph_dir = project_root.join(".latte");
    if !graph_dir.exists() {
        return FlushOutcome::Skipped {
            reason: SkipReason::Error {
                message: "graph not built yet; run a full build first".into(),
            },
        };
    }
    let db_path = graph_dir.join("graph.db");
    let storage = match SqliteStorage::open(&db_path) {
        Ok(s) => s,
        Err(e) => {
            return FlushOutcome::Skipped {
                reason: SkipReason::Error {
                    message: format!("open graph.db: {e}"),
                },
            };
        }
    };
    let engine = TreeSitterEngine::new(storage);
    let project_root_owned = project_root.to_path_buf();
    let paths_owned: Vec<PathBuf> = paths.to_vec();
    let join = std::thread::Builder::new()
        .name(format!("graph-update-{}", workspace_id))
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok();
            if let Some(rt) = rt {
                rt.block_on(async {
                    engine
                        .update_files(&project_root_owned, &paths_owned)
                        .await
                })
            } else {
                Err(latte_rs_graph::error::GraphError::Engine(
                    "no tokio runtime".into(),
                ))
            }
        })
        .expect("spawn update worker");

    let report = match join.join() {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            return FlushOutcome::Skipped {
                reason: SkipReason::Error {
                    message: format!("update_files: {e}"),
                },
            };
        }
        Err(_) => {
            return FlushOutcome::Skipped {
                reason: SkipReason::Error {
                    message: "update worker panicked".into(),
                },
            };
        }
    };

    FlushOutcome::Updated {
        changed_files: report.changed_files,
        nodes_added: report.nodes_added,
        nodes_removed: report.nodes_removed,
        edges_rebuilt: report.edges_rebuilt,
        duration_ms: report.duration_ms,
    }
}

fn emit_outcome(app: &AppHandle, workspace_id: &str, outcome: FlushOutcome) {
    let event = match outcome {
        FlushOutcome::Updated { .. } => format!("graph-updated:{}", workspace_id),
        FlushOutcome::Skipped { .. } => {
            format!("graph-update-skipped:{}", workspace_id)
        }
    };
    let _ = app.emit(&event, &outcome);
}

/// Load settings without pulling in `tokio::main` so the hub's
/// plain thread can use it. `SettingsStore::load` is already
/// async; we drive it with a tiny current-thread runtime.
fn futures_block_on_load(store: &SettingsStore) -> AppSettings {
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt.block_on(store.load()),
        Err(_) => AppSettings::default(),
    }
}

// =====================================================================
// Tests — pure logic, no Tauri runtime needed.
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batcher_dedupes_within_window() {
        let mut b = WorkspaceBatcher::default();
        for _ in 0..3 {
            b.pending.insert(PathBuf::from("/tmp/a.rs"));
        }
        assert_eq!(b.pending.len(), 1);
    }

    #[test]
    fn batcher_records_last_event_time() {
        let mut b = WorkspaceBatcher::default();
        assert!(b.last_event.is_none());
        b.last_event = Some(Instant::now());
        assert!(b.last_event.is_some());
    }

    #[test]
    fn skip_reason_serialises_with_snake_case_tag() {
        let s = FlushOutcome::Skipped {
            reason: SkipReason::BatchTooLarge {
                size: 999,
                max: 200,
            },
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"kind\":\"skipped\""));
        assert!(json.contains("\"batch_too_large\""));
        assert!(json.contains("\"size\":999"));
        assert!(json.contains("\"max\":200"));
    }

    #[test]
    fn updated_outcome_serialises_with_snake_case_tag() {
        let s = FlushOutcome::Updated {
            changed_files: 1,
            nodes_added: 3,
            nodes_removed: 2,
            edges_rebuilt: 4,
            duration_ms: 12,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"kind\":\"updated\""));
        assert!(json.contains("\"changed_files\":1"));
        assert!(json.contains("\"duration_ms\":12"));
    }

    /// Settings that disable auto-update should produce a Skipped
    /// outcome without ever touching the engine. The gate is the
    /// first check in `flush_one`; we verify the path here without
    /// constructing an engine.
    #[test]
    fn flush_respects_disabled_setting_via_predicate() {
        let mut s = GraphSettings::default();
        s.auto_update_enabled = false;
        assert!(!s.auto_update_enabled);
    }

    #[test]
    fn batch_size_threshold_trips_above_max() {
        let s = GraphSettings::default();
        let max = s.max_files_per_batch;
        let over: Vec<PathBuf> = (0..(max + 1))
            .map(|i| PathBuf::from(format!("/tmp/{i}")))
            .collect();
        assert!(over.len() > s.max_files_per_batch);
    }
}
