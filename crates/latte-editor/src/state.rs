use latte_graph_adapter::GraphDb;
use std::path::PathBuf;
use std::sync::Mutex;

/// Shared app state, managed by Tauri. Populated in `setup()`.
pub struct AppState {
    pub workspace: Mutex<Option<PathBuf>>,
    pub db: Mutex<Option<GraphDb>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Mutex::new(None),
            db: Mutex::new(None),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
