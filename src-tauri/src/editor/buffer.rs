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

// 大文件的两个阈值此前混成一个，语义被搅在一起。现在分开：
//
// 1) REFUSE_READ_BYTES —— 根本不读内容，只回一句提示。这是内存与 IPC 的
//    硬上限（整个文件会以字符串形式过一次 invoke）。
// 2) PLAIN_VIEWER_* —— 内容照常完整读取，只是渲染退化成只读纯文本
//    viewer，不交给 CodeMirror。
//
// 刻意**不下调** REFUSE_READ_BYTES：8–50MB 的文件目前是「能读、以纯文本
// 查看」，调低会让它们退化成只剩一句提示，从能看变成不能看。

/// 超过此大小不读取内容（内存 / IPC 硬上限）
const REFUSE_READ_BYTES: u64 = 50 * 1024 * 1024;

/// 超过此大小改用只读纯文本 viewer。
///
/// 必须按字节判定，不能只看行数：一个 30MB 的压缩 JS 可能只有几百行，
/// 只看行数会让它直接进 CodeMirror。
const PLAIN_VIEWER_BYTES: u64 = 8 * 1024 * 1024;

/// 超过此行数改用只读纯文本 viewer。
///
/// 从 100_000 放宽到 400_000：CodeMirror 6 的语法解析本就是增量且按视口
/// 驱动的（带时间预算分片、解析到视口边界即让出主线程、未解析区域先不
/// 上色），10 万行对它偏保守。放宽后这一档文件能恢复高亮与编辑，而"只
/// 高亮可见部分"这件事由 CM6 自己完成 —— 且它用从头增量解析的方式绕开了
/// 词法状态问题（孤立地给某个行区间上色无法知道该处是否位于块注释或
/// 多行字符串内部）。
const PLAIN_VIEWER_LINES: usize = 400_000;

/// tmp 文件名去重计数器：同一文件的并发保存不应互相踩踏。
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// `read_with_limits` 的结果。
struct ReadOutcome {
    content: String,
    line_count: usize,
    byte_size: usize,
    is_large: bool,
}

/// 按大小限制读取文件内容并判定是否退化为只读纯文本 viewer。
///
/// 抽成共用函数是因为 `open` 与 `refresh` 各自实现过一遍同样的判定——
/// 两份重复的阈值逻辑迟早漂移（`search_text` / `replace_text` 的 glob 口径
/// 就是这么分叉的）。
async fn read_with_limits(path: &Path, file_size: u64) -> Result<ReadOutcome, String> {
    let refuse_read = file_size > REFUSE_READ_BYTES;

    let content = if refuse_read {
        format!(
            "[Large file: {} bytes. Opened in read-only large file mode.]",
            file_size
        )
    } else {
        tokio::fs::read_to_string(path)
            .await
            .map_err(|e| format!("Cannot read file: {}", e))?
    };

    let line_count = content.lines().count();
    let byte_size = content.len();
    // 三者任一成立即退化为只读纯文本 viewer
    let is_large =
        refuse_read || file_size > PLAIN_VIEWER_BYTES || line_count > PLAIN_VIEWER_LINES;

    Ok(ReadOutcome {
        content,
        line_count,
        byte_size,
        is_large,
    })
}

/// 原子覆写文件：先写同目录临时文件，再 rename 顶掉目标。
///
/// 三个要点：
/// - **tmp 必须与目标同目录**，rename 才落在同一文件系统上，才具备原子性；
///   写到 /tmp 再 rename 跨设备会直接失败。
/// - **rename 会换 inode**，因此要显式把原文件权限复制到 tmp，否则文件模式
///   退化成新建文件的默认权限（可执行脚本会丢掉 +x）。
/// - 任一步失败都清理 tmp，不留垃圾文件在用户仓库里。
async fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| format!("No parent directory for {}", target.display()))?;
    let stem = target
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "buffer".to_string());
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{}.latte-tmp-{}-{}", stem, std::process::id(), seq));

    // 目标已存在时取其权限；不存在则交给系统默认。
    let perms = tokio::fs::metadata(target)
        .await
        .ok()
        .map(|m| m.permissions());

    if let Err(e) = tokio::fs::write(&tmp, bytes).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("Cannot write temp file: {}", e));
    }
    if let Some(p) = perms {
        if let Err(e) = tokio::fs::set_permissions(&tmp, p).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("Cannot preserve file permissions: {}", e));
        }
    }
    if let Err(e) = tokio::fs::rename(&tmp, target).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("Cannot replace file: {}", e));
    }
    Ok(())
}

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

        let ReadOutcome {
            content,
            line_count,
            byte_size,
            is_large,
        } = read_with_limits(&canonical, metadata.len()).await?;

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

        // 原子写：绝不能直接 tokio::fs::write。它先截断再写入，进程被杀、
        // 应用崩溃或磁盘写满时，用户的源文件会留在截断或半写状态——而这里
        // 是 Ctrl+S 的路径，触发频率最高。项目内 persistence.rs 与
        // settings.rs 早已用 tmp+rename 保护自身状态文件，这里对用户代码
        // 却一直没做。
        write_atomic(&canonical, content.as_bytes()).await?;

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

        let ReadOutcome {
            content,
            line_count,
            byte_size,
            is_large,
        } = read_with_limits(&canonical, metadata.len()).await?;

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

    /// 常规文件：交给 CodeMirror，不退化
    #[tokio::test]
    async fn normal_file_is_not_marked_large() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("small.rs");
        std::fs::write(&p, "fn main() {}\n").unwrap();
        let bm = BufferManager::new();
        let buf = bm.open(&p).await.unwrap();
        let r = buf.read().await;
        assert!(!r.is_large_file);
        assert_eq!(r.content, "fn main() {}\n");
    }

    /// 行数在放宽后的阈值之内：仍然交给 CodeMirror。
    /// 旧阈值是 100_000，这个文件会被误判为大文件而丢掉高亮与编辑能力。
    #[tokio::test]
    async fn file_within_raised_line_limit_stays_editable() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("many_lines.rs");
        let content = "x\n".repeat(150_000);
        std::fs::write(&p, &content).unwrap();
        let bm = BufferManager::new();
        let buf = bm.open(&p).await.unwrap();
        let r = buf.read().await;
        assert_eq!(r.line_count, 150_000);
        assert!(
            !r.is_large_file,
            "15 万行应在放宽后的 400_000 阈值内，不该退化"
        );
    }

    /// 字节数超限但行数很少（压缩后的产物形态）：必须按字节判定退化。
    /// 只看行数会让这类文件直接进 CodeMirror。
    #[tokio::test]
    async fn byte_heavy_file_with_few_lines_is_marked_large() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("bundle.min.js");
        // 单行、约 9MB，超过 PLAIN_VIEWER_BYTES(8MB)
        let content = "a".repeat(9 * 1024 * 1024);
        std::fs::write(&p, &content).unwrap();
        let bm = BufferManager::new();
        let buf = bm.open(&p).await.unwrap();
        let r = buf.read().await;
        assert_eq!(r.line_count, 1, "压缩产物通常只有极少行");
        assert!(r.is_large_file, "超过字节阈值必须退化，不能只看行数");
        // 内容仍应完整读取（未达到拒读上限）
        assert_eq!(r.content.len(), 9 * 1024 * 1024);
    }

    /// 未达拒读上限的大文件内容仍完整可读 —— 不能因为"大"就变成一句提示，
    /// 那会让 8–50MB 的文件从能看变成不能看。
    #[tokio::test]
    async fn large_but_readable_file_keeps_its_content() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("big.log");
        let content = "line\n".repeat(500_000); // 约 2.5MB、50 万行
        std::fs::write(&p, &content).unwrap();
        let bm = BufferManager::new();
        let buf = bm.open(&p).await.unwrap();
        let r = buf.read().await;
        assert!(r.is_large_file, "50 万行超过行数阈值");
        assert!(
            !r.content.starts_with("[Large file:"),
            "未超过拒读上限就不该被替换成提示文本"
        );
        assert_eq!(r.line_count, 500_000);
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

    /// 原子写不能留下临时文件在用户仓库里
    #[tokio::test]
    async fn save_leaves_no_temp_file_behind() {
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

        let leftovers: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("latte-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {:?}", leftovers);
    }

    /// rename 会换 inode，若不显式复制权限，可执行文件会丢掉 +x
    #[cfg(unix)]
    #[tokio::test]
    async fn save_preserves_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("script.sh");
        std::fs::write(&p, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();

        let bm = BufferManager::new();
        let buf = bm.open(&p).await.unwrap();
        {
            let mut w = buf.write().await;
            w.content = "#!/bin/sh\necho bye\n".to_string();
        }
        bm.save(&p).await.unwrap();

        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "保存后应保留 0o755，实得 {:o}", mode);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "#!/bin/sh\necho bye\n");
    }
}
