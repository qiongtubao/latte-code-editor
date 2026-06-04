use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;
use tauri::{AppHandle, Emitter};


pub async fn start_watcher(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();

    let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
        Ok(w) => w,
        Err(_) => return,
    };

    // Watch the project root if it exists
    let project_root = Path::new(".");
    if project_root.exists() {
        let _ = watcher.watch(project_root, RecursiveMode::Recursive);
    }

    // Keep watcher alive
    let _watcher = watcher;

    // Process events
    while let Ok(Ok(event)) = rx.recv() {
        if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
            for path in event.paths {
                let _ = app.emit("file-changed", path.to_string_lossy().to_string());
            }
        }
    }
}
