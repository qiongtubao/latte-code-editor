use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Represents an open file buffer in memory
#[derive(Debug, Clone, Serialize)]
pub struct Buffer {
    pub path: PathBuf,
    pub content: String,
    pub line_count: usize,
    pub byte_size: usize,
    pub is_modified: bool,
    pub is_large_file: bool,
}

/// Large file threshold: 50MB or 100,000 lines
const LARGE_FILE_SIZE: u64 = 50 * 1024 * 1024;
const LARGE_FILE_LINES: usize = 100_000;

/// In-memory buffer manager
pub struct BufferManager {
    buffers: RwLock<HashMap<PathBuf, Arc<RwLock<Buffer>>>>,
    active: RwLock<Option<PathBuf>>,
}

impl BufferManager {
    pub fn new() -> Self {
        Self {
            buffers: RwLock::new(HashMap::new()),
            active: RwLock::new(None),
        }
    }

    /// Open a file and create a buffer for it.
    pub async fn open(&self, path: &Path) -> Result<Arc<RwLock<Buffer>>, String> {
        let canonical = path.canonicalize().map_err(|e| format!("Cannot resolve path: {}", e))?;

        // Check existing buffer
        {
            let buffers = self.buffers.read().await;
            if let Some(buf) = buffers.get(&canonical) {
                *self.active.write().await = Some(canonical);
                return Ok(buf.clone());
            }
        }

        let metadata = std::fs::metadata(&canonical)
            .map_err(|e| format!("Cannot read metadata: {}", e))?;

        let file_size = metadata.len();
        let is_large_size = file_size > LARGE_FILE_SIZE;

        // Read file content
        let content = if is_large_size {
            format!("[Large file: {} bytes. Opened in read-only large file mode.]", file_size)
        } else {
            tokio::fs::read_to_string(&canonical)
                .await
                .map_err(|e| format!("Cannot read file: {}", e))?
        };

        let line_count = content.lines().count();
        let byte_size = content.len();
        let is_large = is_large_size || line_count > LARGE_FILE_LINES;

        let buffer = Arc::new(RwLock::new(Buffer {
            path: canonical.clone(),
            content,
            line_count,
            byte_size,
            is_modified: false,
            is_large_file: is_large,
        }));

        {
            let mut buffers = self.buffers.write().await;
            buffers.insert(canonical.clone(), buffer.clone());
            *self.active.write().await = Some(canonical);
        }

        Ok(buffer)
    }

    /// Save buffer content to disk
    pub async fn save(&self, path: &Path) -> Result<(), String> {
        let canonical = path.canonicalize().map_err(|e| format!("Cannot resolve path: {}", e))?;
        let buf = {
            let buffers = self.buffers.read().await;
            buffers.get(&canonical).cloned().ok_or_else(|| "Buffer not found".to_string())?
        };

        let content = {
            let reader = buf.read().await;
            if reader.is_large_file {
                return Err("Cannot save large file in read-only mode".to_string());
            }
            reader.content.clone()
        };

        tokio::fs::write(&canonical, &content)
            .await
            .map_err(|e| format!("Cannot write file: {}", e))?;

        {
            let mut writer = buf.write().await;
            writer.is_modified = false;
        }

        Ok(())
    }

    /// Get the active buffer
    pub async fn get_active(&self) -> Option<Arc<RwLock<Buffer>>> {
        let path = self.active.read().await.clone()?;
        let buffers = self.buffers.read().await;
        buffers.get(&path).cloned()
    }

    /// Get a specific buffer by path
    pub async fn get_buffer(&self, path: &Path) -> Option<Arc<RwLock<Buffer>>> {
        let canonical = path.canonicalize().ok()?;
        let buffers = self.buffers.read().await;
        buffers.get(&canonical).cloned()
    }

    /// Close a buffer
    pub async fn close(&self, path: &Path) {
        let mut buffers = self.buffers.write().await;
        if let Ok(canonical) = path.canonicalize() {
            buffers.remove(&canonical);
        }
    }
}
