use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
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
    /// 每 `LINE_INDEX_STRIDE` 行的字节偏移，只为大文件范围读取服务。
    #[serde(skip)]
    pub line_index: Vec<u64>,
    /// 建索引时的 mtime；范围读取前用它发现同尺寸的外部改动。
    #[serde(skip)]
    pub indexed_modified: Option<SystemTime>,
}

// 大文件按两条独立边界判定：字节过大，或行数过多。进入大文件模式后，
// buffer 只保存元数据与稀疏索引，绝不保存全文；可见内容由范围读取命令提供。
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

/// 稀疏索引每 1024 行记一个字节偏移。即使是 2500 万行的极端文件，
/// 索引也只有约 200KB；任意跳转最多只需再跳过 1023 行。
pub(crate) const LINE_INDEX_STRIDE: usize = 1024;

#[derive(Debug, Clone)]
pub(crate) struct TextFileIndex {
    pub total_lines: usize,
    pub byte_size: u64,
    pub offsets: Vec<u64>,
    pub modified: Option<SystemTime>,
}

#[derive(Debug)]
pub(crate) struct IndexedRange {
    pub lines: Vec<String>,
    pub eof: bool,
}

fn index_bytes(bytes: &[u8]) -> (usize, Vec<u64>) {
    let mut offsets = vec![0];
    let mut newlines = 0usize;
    for (position, &byte) in bytes.iter().enumerate() {
        if byte == b'\n' {
            newlines += 1;
            if newlines % LINE_INDEX_STRIDE == 0 {
                offsets.push(position as u64 + 1);
            }
        }
    }
    let total_lines = if bytes.is_empty() {
        0
    } else if bytes.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    };
    (total_lines, offsets)
}

/// 流式建立稀疏行索引。前后各取一次 fingerprint；扫描期间文件变化时宁可
/// 失败并让前端重试，也不能把一套混合版本的偏移交给后续随机读取。
pub(crate) fn index_text_file(path: &Path) -> Result<TextFileIndex, String> {
    use std::io::Read;

    let before = std::fs::metadata(path).map_err(|e| format!("Cannot read metadata: {}", e))?;
    let before_modified = before.modified().ok();
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open file: {}", e))?;
    let mut reader = std::io::BufReader::new(file);
    let mut buf = [0u8; 64 * 1024];
    let mut offsets = vec![0];
    let mut newlines = 0usize;
    let mut absolute = 0u64;
    let mut last_byte = None;

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Cannot read file: {}", e))?;
        if n == 0 {
            break;
        }
        for (position, &byte) in buf[..n].iter().enumerate() {
            if byte == b'\n' {
                newlines += 1;
                if newlines % LINE_INDEX_STRIDE == 0 {
                    offsets.push(absolute + position as u64 + 1);
                }
            }
        }
        absolute += n as u64;
        last_byte = Some(buf[n - 1]);
    }

    let after = std::fs::metadata(path).map_err(|e| format!("Cannot read metadata: {}", e))?;
    let after_modified = after.modified().ok();
    if before.len() != after.len() || before_modified != after_modified {
        return Err("File changed while it was being indexed; retry".to_string());
    }
    let total_lines = match last_byte {
        None => 0,
        Some(b'\n') => newlines,
        Some(_) => newlines + 1,
    };
    Ok(TextFileIndex {
        total_lines,
        byte_size: after.len(),
        offsets,
        modified: after_modified,
    })
}

const MAX_CAPTURED_LINE_BYTES: usize = 64 * 1024;
const MAX_CAPTURED_RANGE_BYTES: usize = 2 * 1024 * 1024;
const TRUNCATED_LINE_SUFFIX: &str = " … [line truncated in large-file view]";

/// Consume one physical line without ever allocating its full length. `capture_limit`
/// controls how many bytes are retained; the remainder is streamed past until `\n`.
fn read_bounded_line<R: std::io::BufRead>(
    reader: &mut R,
    capture_limit: usize,
) -> std::io::Result<Option<(Vec<u8>, bool)>> {
    let mut captured = Vec::with_capacity(capture_limit.min(4096));
    let mut saw_input = false;
    let mut truncated = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if saw_input {
                Ok(Some((captured, truncated)))
            } else {
                Ok(None)
            };
        }
        saw_input = true;
        let newline = available.iter().position(|&byte| byte == b'\n');
        let payload_len = newline.unwrap_or(available.len());
        let remaining = capture_limit.saturating_sub(captured.len());
        let take = payload_len.min(remaining);
        captured.extend_from_slice(&available[..take]);
        if take < payload_len {
            truncated = true;
        }
        let consumed = newline.map_or(available.len(), |position| position + 1);
        reader.consume(consumed);
        if newline.is_some() {
            break;
        }
    }
    Ok(Some((captured, truncated)))
}

/// 从最近的稀疏锚点读取行区间，而不是为每一页从文件头重新扫描。
/// 每行与整页都有捕获上限；超长压缩产物会显示截断标记，不会把一个 50MB
/// 单行重新塞进内存并穿过 IPC。
pub(crate) fn read_indexed_range(
    path: &Path,
    start_line: usize,
    max_lines: usize,
    index: &TextFileIndex,
) -> Result<IndexedRange, String> {
    use std::io::{BufRead, Seek};

    let metadata = std::fs::metadata(path).map_err(|e| format!("Cannot read metadata: {}", e))?;
    if metadata.len() != index.byte_size || metadata.modified().ok() != index.modified {
        return Err("File changed since it was indexed; refresh and retry".to_string());
    }

    let requested_block = start_line / LINE_INDEX_STRIDE;
    let block = requested_block.min(index.offsets.len().saturating_sub(1));
    let base_line = block * LINE_INDEX_STRIDE;
    let offset = index.offsets.get(block).copied().unwrap_or(0);
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open file: {}", e))?;
    let mut reader = std::io::BufReader::new(file);
    reader
        .seek(std::io::SeekFrom::Start(offset))
        .map_err(|e| format!("Cannot seek file: {}", e))?;

    let skip = start_line.saturating_sub(base_line);
    for relative in 0..skip {
        if read_bounded_line(&mut reader, 0)
            .map_err(|e| format!("Cannot skip line {}: {}", base_line + relative, e))?
            .is_none()
        {
            return Ok(IndexedRange {
                lines: Vec::new(),
                eof: true,
            });
        }
    }

    let mut lines = Vec::with_capacity(max_lines.min(4096));
    let mut captured_bytes = 0usize;
    for offset_in_range in 0..max_lines {
        let capture_limit = MAX_CAPTURED_LINE_BYTES
            .min(MAX_CAPTURED_RANGE_BYTES.saturating_sub(captured_bytes));
        let Some((mut bytes, truncated)) = read_bounded_line(&mut reader, capture_limit)
            .map_err(|e| format!("Cannot read line {}: {}", start_line + offset_in_range, e))?
        else {
            break;
        };
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        let mut line = match std::str::from_utf8(&bytes) {
            Ok(text) => text.to_string(),
            // A byte cap can split the final UTF-8 scalar; retain only the valid
            // prefix in that one case. Invalid UTF-8 inside the captured prefix
            // remains an error, matching read_to_string's text-file contract.
            Err(error) if truncated && error.error_len().is_none() => {
                String::from_utf8(bytes[..error.valid_up_to()].to_vec())
                    .expect("valid_up_to always marks valid UTF-8")
            }
            Err(error) => {
                return Err(format!(
                    "Invalid UTF-8 at line {} byte {}",
                    start_line + offset_in_range,
                    error.valid_up_to()
                ));
            }
        };
        captured_bytes += line.len();
        if truncated {
            line.push_str(TRUNCATED_LINE_SUFFIX);
        }
        lines.push(line);
    }
    let eof = reader
        .fill_buf()
        .map_err(|e| format!("Cannot inspect range end: {}", e))?
        .is_empty();

    let after = std::fs::metadata(path).map_err(|e| format!("Cannot read metadata: {}", e))?;
    if after.len() != index.byte_size || after.modified().ok() != index.modified {
        return Err("File changed during range read; refresh and retry".to_string());
    }
    Ok(IndexedRange { lines, eof })
}

/// `read_with_limits` 的结果。
struct ReadOutcome {
    content: String,
    line_count: usize,
    byte_size: usize,
    is_large: bool,
    line_index: Vec<u64>,
    indexed_modified: Option<SystemTime>,
}

/// 读取普通文件；大文件只保留元数据。按字节已知会退化时立即返回，让 UI
/// 先打开 tab，再由 stat 命令在后台流式建索引，不让 `open_file` 卡在全盘扫描。
async fn read_with_limits(path: &Path, file_size: u64) -> Result<ReadOutcome, String> {
    let byte_size = usize::try_from(file_size).map_err(|_| "File size exceeds this platform".to_string())?;
    if file_size > PLAIN_VIEWER_BYTES {
        return Ok(ReadOutcome {
            content: String::new(),
            line_count: 0,
            byte_size,
            is_large: true,
            line_index: Vec::new(),
            indexed_modified: None,
        });
    }

    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| format!("Cannot read file: {}", e))?;
    let (line_count, line_index) = index_bytes(content.as_bytes());
    let is_large = line_count > PLAIN_VIEWER_LINES;
    if is_large {
        let modified = std::fs::metadata(path).ok().and_then(|m| m.modified().ok());
        Ok(ReadOutcome {
            content: String::new(),
            line_count,
            byte_size,
            is_large: true,
            line_index,
            indexed_modified: modified,
        })
    } else {
        Ok(ReadOutcome {
            content,
            line_count,
            byte_size,
            is_large: false,
            line_index: Vec::new(),
            indexed_modified: None,
        })
    }
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
            line_index,
            indexed_modified,
        } = read_with_limits(&canonical, metadata.len()).await?;

        let buffer = Arc::new(RwLock::new(Buffer {
            path: canonical.clone(),
            content,
            line_count,
            byte_size,
            is_modified: false,
            is_large_file: is_large,
            line_index,
            indexed_modified,
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
            line_index,
            indexed_modified,
        } = read_with_limits(&canonical, metadata.len()).await?;

        // 更新 buffer 内容
        {
            let mut buf = existing.write().await;
            buf.content = content;
            buf.line_count = line_count;
            buf.byte_size = byte_size;
            buf.is_large_file = is_large;
            buf.line_index = line_index;
            buf.indexed_modified = indexed_modified;
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

        // 大文件不驻留全文：用尺寸 + 建索引时的 mtime 检查外部变化。
        if buf.is_large_file {
            let metadata = std::fs::metadata(&canonical)
                .map_err(|e| format!("Cannot read metadata: {}", e))?;
            return Ok(
                metadata.len() != buf.byte_size as u64
                    || buf
                        .indexed_modified
                        .is_some_and(|modified| metadata.modified().ok() != Some(modified)),
            );
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
        assert!(r.is_large_file, "超过字节阈值必须退化，不能只看行数");
        assert!(r.content.is_empty(), "大文件全文不能常驻 buffer 或穿过 IPC");
        assert_eq!(r.byte_size, 9 * 1024 * 1024);
        // 字节阈值已足以判定；行数与索引由 viewer 的 stat 命令异步建立，
        // open_file 不应为了它阻塞扫描整个文件。
        assert_eq!(r.line_count, 0);
        assert!(r.line_index.is_empty());
    }

    /// 行数阈值触发大文件模式后也必须丢弃全文；否则只省了 DOM，Rust
    /// buffer 与 invoke 序列化仍各保留一份完整字符串。
    #[tokio::test]
    async fn line_heavy_file_discards_content_and_keeps_sparse_index() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("big.log");
        let content = "line\n".repeat(500_000); // 约 2.5MB、50 万行
        std::fs::write(&p, &content).unwrap();
        let bm = BufferManager::new();
        let buf = bm.open(&p).await.unwrap();
        let r = buf.read().await;
        assert!(r.is_large_file, "50 万行超过行数阈值");
        assert!(r.content.is_empty(), "大文件全文必须在判定后立即释放");
        assert_eq!(r.line_count, 500_000);
        assert!(r.line_index.len() > 400, "应每 1024 行保留一个稀疏锚点");
    }

    #[test]
    fn sparse_index_counts_line_endings_and_reads_utf8_crlf() {
        let dir = TempDir::new().unwrap();
        let cases: &[(&str, usize)] = &[
            ("", 0),
            ("a", 1),
            ("a\n", 1),
            ("a\nb", 2),
            ("a\nb\n", 2),
            ("\n", 1),
            ("\n\n", 2),
        ];
        for (i, (content, expected)) in cases.iter().enumerate() {
            let path = dir.path().join(format!("case-{i}.txt"));
            std::fs::write(&path, content).unwrap();
            let index = index_text_file(&path).unwrap();
            assert_eq!(index.total_lines, *expected, "content {content:?}");
            assert_eq!(index.byte_size as usize, content.len());
        }

        let path = dir.path().join("utf8-crlf.txt");
        let expected: Vec<String> = (0..3000).map(|i| format!("第 {i} 行 ☕")).collect();
        std::fs::write(&path, expected.join("\r\n")).unwrap();
        let index = index_text_file(&path).unwrap();
        assert!(index.offsets.len() >= 3);
        let range = read_indexed_range(&path, 1023, 4, &index).unwrap();
        assert_eq!(range.lines, expected[1023..1027]);
        assert!(!range.eof);
    }

    #[test]
    fn indexed_ranges_reassemble_the_file_and_handle_bounds() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("many.txt");
        let expected: Vec<String> = (0..5000).map(|i| format!("line {i}")).collect();
        std::fs::write(&path, expected.join("\n")).unwrap();
        let index = index_text_file(&path).unwrap();

        let mut collected = Vec::new();
        let mut start = 0;
        loop {
            let range = read_indexed_range(&path, start, 137, &index).unwrap();
            start += range.lines.len();
            collected.extend(range.lines);
            if range.eof {
                break;
            }
            assert!(start < 10_000, "range loop did not reach eof");
        }
        assert_eq!(collected, expected);

        let past_end = read_indexed_range(&path, 99_999, 10, &index).unwrap();
        assert!(past_end.lines.is_empty());
        assert!(past_end.eof);
    }

    #[test]
    fn indexed_range_bounds_a_very_long_single_line() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("minified.js");
        let long_line = "λ".repeat(512 * 1024);
        std::fs::write(&path, &long_line).unwrap();
        let index = index_text_file(&path).unwrap();
        assert_eq!(index.total_lines, 1);
        let range = read_indexed_range(&path, 0, 1, &index).unwrap();
        assert_eq!(range.lines.len(), 1);
        assert!(range.lines[0].ends_with(TRUNCATED_LINE_SUFFIX));
        assert!(
            range.lines[0].len() <= MAX_CAPTURED_LINE_BYTES + TRUNCATED_LINE_SUFFIX.len(),
            "超长单行不能整行进入内存或 IPC"
        );
        assert!(range.eof);
    }

    #[test]
    fn indexed_range_rejects_same_size_external_changes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("changing.txt");
        std::fs::write(&path, "a\nb\nc\n").unwrap();
        let index = index_text_file(&path).unwrap();
        // APFS exposes sub-second mtimes; a short pause avoids coalescing on other
        // common filesystems while keeping the test inexpensive.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&path, "x\ny\nz\n").unwrap(); // exactly the same byte size
        let error = read_indexed_range(&path, 0, 2, &index).unwrap_err();
        assert!(error.contains("changed"), "error was: {error}");
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
