//! 多 workspace 状态持久化
//!
//! 落盘位置：`app_data_dir()/state.json`
//! 写入时机：
//! - 新增 / 移除 workspace
//! - workspace 的 tabs / active_tab / ui_state 变化
//! - 窗口关闭（兜底落盘）
//!
//! 读取时机：
//! - 应用启动时（`setup` 钩子）一次性加载
//!
//! 容错：JSON 解析失败时记录错误但不阻断启动（空注册表启动）。

use std::path::PathBuf;

use tokio::fs;

use crate::workspace::registry::RegistrySnapshot;

const STATE_FILE: &str = "state.json";

/// 持久化器：把 RegistrySnapshot 落盘到 app_data_dir
pub struct Persistence {
    state_path: PathBuf,
}

impl Persistence {
    /// 构造持久化器
    /// - `app_data_dir`: tauri 提供的应用数据目录
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            state_path: app_data_dir.join(STATE_FILE),
        }
    }

    /// 落盘快照（原子写：先写临时文件，再 rename）
    pub async fn save(&self, snap: &RegistrySnapshot) -> Result<(), String> {
        if let Some(parent) = self.state_path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Cannot create app data dir: {}", e))?;
        }
        let json = serde_json::to_vec_pretty(snap)
            .map_err(|e| format!("Cannot serialize state: {}", e))?;
        let tmp = self.state_path.with_extension("json.tmp");
        fs::write(&tmp, &json)
            .await
            .map_err(|e| format!("Cannot write tmp state: {}", e))?;
        // 原子 rename（同一文件系统上）
        fs::rename(&tmp, &self.state_path)
            .await
            .map_err(|e| format!("Cannot rename state: {}", e))?;
        Ok(())
    }

    /// 读取快照（文件不存在或解析失败返回空快照）
    pub async fn load(&self) -> RegistrySnapshot {
        match fs::read(&self.state_path).await {
            Ok(bytes) => match serde_json::from_slice::<RegistrySnapshot>(&bytes) {
                Ok(snap) => snap,
                Err(e) => {
                    eprintln!(
                        "[workspace/persistence] state.json parse error: {} — using empty snapshot",
                        e
                    );
                    RegistrySnapshot::default()
                }
            },
            Err(_) => RegistrySnapshot::default(),
        }
    }

    /// 状态文件路径（调试用）
    pub fn state_path(&self) -> &PathBuf {
        &self.state_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry::{UiState, WindowMapping, WorkspaceMeta};
    use std::collections::HashMap;
    use tempfile::TempDir;

    fn make_snap() -> RegistrySnapshot {
        let mut workspaces = HashMap::new();
        workspaces.insert(
            "ws-a".to_string(),
            WorkspaceMeta {
                name: "alpha".to_string(),
                project_root: PathBuf::from("/tmp/alpha"),
                open_tabs: vec!["/tmp/alpha/src/main.rs".to_string()],
                active_tab: Some("/tmp/alpha/src/main.rs".to_string()),
                ui_state: UiState {
                    sidebar_width: 300,
                    active_panel: "editor".to_string(),
                    ..Default::default()
                },
                last_used_at: 1234,
                chat_state: None,
            },
        );
        let mut windows = WindowMapping::default();
        windows
            .active
            .insert("main".to_string(), "ws-a".to_string());
        RegistrySnapshot {
            workspaces,
            windows,
            lru_order: vec!["ws-a".to_string()],
        }
    }

    #[tokio::test]
    async fn save_then_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let pers = Persistence::new(dir.path().to_path_buf());
        let snap = make_snap();
        pers.save(&snap).await.unwrap();
        let loaded = pers.load().await;
        assert_eq!(loaded, snap);
    }

    #[tokio::test]
    async fn load_returns_empty_when_no_file() {
        let dir = TempDir::new().unwrap();
        let pers = Persistence::new(dir.path().to_path_buf());
        let loaded = pers.load().await;
        assert!(loaded.workspaces.is_empty());
        assert!(loaded.lru_order.is_empty());
    }

    #[tokio::test]
    async fn load_returns_empty_on_corrupt_file() {
        let dir = TempDir::new().unwrap();
        let pers = Persistence::new(dir.path().to_path_buf());
        // 写入非 JSON 内容
        tokio::fs::write(pers.state_path(), b"not json")
            .await
            .unwrap();
        let loaded = pers.load().await;
        assert!(loaded.workspaces.is_empty());
    }

    #[tokio::test]
    async fn save_creates_parent_directory() {
        let dir = TempDir::new().unwrap();
        let nested = dir.path().join("a").join("b").join("c");
        let pers = Persistence::new(nested);
        pers.save(&make_snap()).await.unwrap();
        assert!(pers.state_path().exists());
    }
}
