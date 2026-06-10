use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 代表内存中一个打开的文件 buffer
#[derive(Debug, Clone, Serialize)]
pub struct Buffer {
    pub path: PathBuf,
    pub content: String,
    pub line_count: usize,
    pub byte_size: usize,
    pub is_modified: bool,
    pub is_large_file: bool,
}

/// 大文件阈值：50MB 或 100,000 行
const LARGE_FILE_SIZE: u64 = 50 * 1024 * 1024;
const LARGE_FILE_LINES: usize = 100_000;

/// Buffer 池管理器
///
/// 内部所有数据用 `Arc<RwLock<...>>` 包装，因此 `BufferManager` 可以 Clone——
/// clone 出来的多个 handle **共享同一份数据**，可以从 registry 的读锁内"借出"handle
/// 然后跨 await 自由使用，不必担心锁生命周期问题。
#[derive(Clone, Default)]
pub struct BufferManager {
    buffers: Arc<RwLock<HashMap<PathBuf, Arc<RwLock<Buffer>>>>>,
    active: Arc<RwLock<Option<PathBuf>>>,
}

impl BufferManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 打开一个文件并创建 buffer。已存在则复用。
    pub async fn open(&self, path: &Path) -> Result<Arc<RwLock<Buffer>>, String> {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {}", e))?;

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

        let content = if is_large_size {
            format!(
                "[Large file: {} bytes. Opened in read-only large file mode.]",
                file_size
            )
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

    /// 把 buffer 内容写回磁盘
    pub async fn save(&self, path: &Path) -> Result<(), String> {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {}", e))?;
        let buf = {
            let buffers = self.buffers.read().await;
            buffers
                .get(&canonical)
                .cloned()
                .ok_or_else(|| "Buffer not found".to_string())?
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

    /// 取当前激活 buffer
    pub async fn get_active(&self) -> Option<Arc<RwLock<Buffer>>> {
        let path = self.active.read().await.clone()?;
        let buffers = self.buffers.read().await;
        buffers.get(&path).cloned()
    }

    /// 按路径取 buffer
    pub async fn get_buffer(&self, path: &Path) -> Option<Arc<RwLock<Buffer>>> {
        let canonical = path.canonicalize().ok()?;
        let buffers = self.buffers.read().await;
        buffers.get(&canonical).cloned()
    }

    /// 关闭 buffer
    pub async fn close(&self, path: &Path) {
        let mut buffers = self.buffers.write().await;
        if let Ok(canonical) = path.canonicalize() {
            buffers.remove(&canonical);
        }
    }

    /// 刷新指定文件的缓存（重新从磁盘加载）
    ///
    /// 如果文件未在缓存中，返回错误
    /// 如果文件已修改未保存，警告用户（但仍刷新）
    pub async fn refresh(&self, path: &Path) -> Result<Arc<RwLock<Buffer>>, String> {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {}", e))?;

        // 检查 buffer 是否存在
        let buffers = self.buffers.read().await;
        let existing = buffers.get(&canonical)
            .ok_or_else(|| format!("Buffer not found for {}", canonical.display()))?;
        
        // 检查是否已修改（警告但不阻止刷新）
        {
            let buf = existing.read().await;
            if buf.is_modified {
                eprintln!("[refresh] Warning: buffer {} has unsaved changes, will be overwritten", canonical.display());
            }
        }

        // 从磁盘重新读取
        let metadata = std::fs::metadata(&canonical)
            .map_err(|e| format!("Cannot read metadata: {}", e))?;

        let file_size = metadata.len();
        let is_large_size = file_size > LARGE_FILE_SIZE;

        let content = if is_large_size {
            format!(
                "[Large file: {} bytes. Opened in read-only large file mode.]",
                file_size
            )
        } else {
            tokio::fs::read_to_string(&canonical)
                .await
                .map_err(|e| format!("Cannot read file: {}", e))?
        };

        let line_count = content.lines().count();
        let byte_size = content.len();
        let is_large = is_large_size || line_count > LARGE_FILE_LINES;

        // 更新 buffer 内容
        {
            let mut buf = existing.write().await;
            buf.content = content;
            buf.line_count = line_count;
            buf.byte_size = byte_size;
            buf.is_large_file = is_large;
            buf.is_modified = false; // 刷新后标记为未修改
        }

        Ok(existing.clone())
    }

    /// 检查文件是否在磁盘上被修改（对比 buffer 和磁盘内容）
    ///
    /// 返回 true 表示磁盘文件已变化
    pub async fn is_file_changed_on_disk(&self, path: &Path) -> Result<bool, String> {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {}", e))?;

        let buffers = self.buffers.read().await;
        let buffer = buffers.get(&canonical)
            .ok_or_else(|| format!("Buffer not found for {}", canonical.display()))?;

        let buf = buffer.read().await;

        // 如果是大文件模式，无法精确对比
        if buf.is_large_file {
            // 检查文件大小是否变化
            let metadata = std::fs::metadata(&canonical)
                .map_err(|e| format!("Cannot read metadata: {}", e))?;
            return Ok(metadata.len() != buf.byte_size as u64);
        }

        // 读取磁盘内容对比
        let disk_content = tokio::fs::read_to_string(&canonical)
            .await
            .map_err(|e| format!("Cannot read file: {}", e))?;

        Ok(buf.content != disk_content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 验证 clone 出来的 BufferManager 共享数据
    #[tokio::test]
    async fn clone_shares_data() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("foo.txt");
        std::fs::write(&p, "hello").unwrap();
        let bm1 = BufferManager::new();
        let bm2 = bm1.clone();
        let _buf = bm1.open(&p).await.unwrap();
        // bm2 应该能看到 bm1 打开的 buffer
        let got = bm2.get_buffer(&p).await;
        assert!(got.is_some());
    }

    /// 验证修改通过 clone handle 可见
    #[tokio::test]
    async fn modification_via_clone_handle() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("foo.txt");
        std::fs::write(&p, "hello").unwrap();
        let bm1 = BufferManager::new();
        let bm2 = bm1.clone();
        let buf = bm1.open(&p).await.unwrap();
        // bm2 拿同一个 buffer
        let buf2 = bm2.get_buffer(&p).await.unwrap();
        assert!(Arc::ptr_eq(&buf, &buf2));
        {
            let mut w = buf2.write().await;
            w.content = "world".to_string();
            w.is_modified = true;
        }
        // bm1 读到的也是修改后
        let r = buf.read().await;
        assert_eq!(r.content, "world");
        assert!(r.is_modified);
    }

    /// 验证 save 落盘
    #[tokio::test]
    async fn save_persists_to_disk() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("foo.txt");
        std::fs::write(&p, "hello").unwrap();
        let bm = BufferManager::new();
        let buf = bm.open(&p).await.unwrap();
        {
            let mut w = buf.write().await;
            w.content = "world".to_string();
        }
        bm.save(&p).await.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "world");
    }
}
