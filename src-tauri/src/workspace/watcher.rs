//! Per-workspace 文件监听器
//!
//! 每个 workspace 独立持有一个 notify 监听器，监听项目根目录的文件变化。
//! 事件以 `file-changed:<workspace_id>` 的形式 emit 到前端，前端按 workspace id 路由。
//!
//! 生命周期：
//! - `WorkspaceWatcher::start(root, app, workspace_id)` 启动监听，返回持有句柄
//! - 句柄 drop 时调用 `stop()`，自动取消监听
//!
//! 设计权衡：
//! - 旧的 `project/watcher.rs` 硬编码 `Path::new(".")`，不能多 workspace。新设计替代之。
//! - 监听器在独立线程中运行（notify::RecommendedWatcher + mpsc channel），不阻塞 tauri runtime。

use std::path::Path;
use std::sync::mpsc::{channel, Sender};
use std::thread;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// 单 workspace 监听器句柄。drop 时停止监听线程。
pub struct WorkspaceWatcher {
    stop_tx: Option<Sender<()>>,
    /// 显式持有 watcher，防止 drop 后立即停止
    _watcher: Option<RecommendedWatcher>,
}

impl WorkspaceWatcher {
    /// 启动监听器
    /// - `root`: 项目根目录
    /// - `app`: tauri AppHandle，用于 emit 事件
    /// - `workspace_id`: workspace 唯一标识（用于事件命名）
    pub fn start(root: &Path, app: AppHandle, workspace_id: String) -> Result<Self, String> {
        if !root.exists() {
            return Err(format!("Watch root does not exist: {}", root.display()));
        }

        let (event_tx, event_rx) = channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(event_tx, Config::default())
            .map_err(|e| format!("Cannot create watcher: {}", e))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| format!("Cannot watch root: {}", e))?;

        let (stop_tx, stop_rx) = channel::<()>();
        let app_for_thread = app.clone();
        let workspace_id_for_thread = workspace_id.clone();

        thread::Builder::new()
            .name(format!("ws-watcher-{}", workspace_id))
            .spawn(move || {
                loop {
                    // select 风格：定期检查 stop，同时处理事件
                    match event_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                        Ok(Ok(event)) => {
                            if matches!(
                                event.kind,
                                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                            ) {
                                for path in event.paths {
                                    let event_name =
                                        format!("file-changed:{}", workspace_id_for_thread);
                                    let _ = app_for_thread.emit(
                                        event_name.as_str(),
                                        path.to_string_lossy().to_string(),
                                    );
                                }
                            }
                        }
                        Ok(Err(_))
                        | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            // 忽略超时（用于定期检查 stop）
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            // channel 断了，退出
                            break;
                        }
                    }
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                }
            })
            .map_err(|e| format!("Cannot spawn watcher thread: {}", e))?;

        Ok(Self {
            stop_tx: Some(stop_tx),
            _watcher: Some(watcher),
        })
    }

    /// 主动停止监听（drop 时也会调用）
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        self._watcher = None;
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证 Drop 语义不会 panic。
    /// start() 需要 AppHandle（用于 emit），不在单测范围内覆盖。
    /// Drop + stop 路径是纯本地状态切换，不依赖 tauri runtime。
    #[test]
    fn drop_does_not_panic() {
        let (tx, _rx) = channel::<()>();
        let mut w = WorkspaceWatcher {
            stop_tx: Some(tx),
            _watcher: None,
        };
        w.stop();
        // 再次 stop 是幂等的
        w.stop();
    }
}
