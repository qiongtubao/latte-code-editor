use latte_graph_adapter::GraphDb;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::search::{Embedder, EmbeddingStore};

/// Shared app state, managed by Tauri. Populated in `setup()`.
pub struct AppState {
    pub workspace: Mutex<Option<PathBuf>>,
    pub db: Mutex<Option<GraphDb>>,
    // T22 cache slot for the (expensive) embedder + open embedding store.
    //
    // `Embedder::new` re-inits the ONNX session and can take seconds on the
    // first call (model download + libonnxruntime load). Re-opening the
    // SQLite store on every IPC round-trip is also wasteful — it parses
    // the schema and re-`CREATE VIRTUAL TABLE` every time.
    //
    // The slot is `None` until `cmd_semantic_search` is first invoked;
    // from then on the embedder is reused across calls. We hold both
    // together under one mutex so the store's connection lifetime is
    // tied to the embedder that produced its vectors (and so the lock
    // order is consistent).
    pub semantic: Mutex<Option<SemanticCache>>,
}

/// Cached embedder + store, lazily populated by `cmd_semantic_search`.
pub struct SemanticCache {
    pub embedder: Embedder,
    pub store: EmbeddingStore,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Mutex::new(None),
            db: Mutex::new(None),
            semantic: Mutex::new(None),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
