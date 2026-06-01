use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;
use crate::index::Debouncer;

pub struct FileIndexService {
    dirty: HashSet<PathBuf>,
    watcher: Option<RecommendedWatcher>,
    debouncer: Debouncer,
}

impl Default for FileIndexService {
    fn default() -> Self {
        Self { dirty: HashSet::new(), watcher: None, debouncer: Debouncer::new(Duration::from_millis(300)) }
    }
}

impl FileIndexService {
    pub fn new() -> Self { Self { debouncer: Debouncer::new(Duration::from_millis(300)), ..Default::default() } }

    pub fn watch(&mut self, root: &Path) -> Result<(), String> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res { let _ = tx.send(ev); }
        }).map_err(|e| e.to_string())?;
        w.watch(root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
        self.watcher = Some(w);

        let dirty = std::sync::Arc::new(std::sync::Mutex::new(HashSet::<PathBuf>::new()));
        let dirty2 = dirty.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                for p in ev.paths {
                    if p.is_file() { dirty2.lock().unwrap().insert(p); }
                }
            }
        });
        Ok(())
    }

    pub fn mark_dirty(&mut self, path: PathBuf) { self.dirty.insert(path); }
    pub fn dirty_paths(&self) -> Vec<PathBuf> {
        let mut v: Vec<_> = self.dirty.iter().cloned().collect();
        v.sort(); v
    }
    pub fn clear_dirty(&mut self) { self.dirty.clear(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mark_and_clear_dirty() {
        let mut s = FileIndexService::new();
        s.mark_dirty("a.ts".into());
        s.mark_dirty("b.ts".into());
        assert_eq!(s.dirty_paths().len(), 2);
        s.clear_dirty();
        assert!(s.dirty_paths().is_empty());
    }
}
