//! WorkspaceRegistry: 多 workspace 注册表 + 窗口路由
//!
//! 所有读写方法都是 async 的（用 `tokio::sync::RwLock` 保护内部状态）。
//! 单测使用 `#[tokio::test]` 即可，无需 trait 抽象。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::editor::buffer::BufferManager;

/// workspace 唯一标识（字符串）。来源：项目根路径的 hash，保证确定性 + 唯一性。
pub type WorkspaceId = String;

/// workspace 的可序列化元数据。包含恢复会话所需的全部信息。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceMeta {
    pub name: String,
    pub project_root: PathBuf,
    #[serde(default)]
    pub open_tabs: Vec<String>,
    #[serde(default)]
    pub active_tab: Option<String>,
    #[serde(default)]
    pub ui_state: UiState,
    #[serde(default)]
    pub last_used_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UiState {
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,
    #[serde(default = "default_outline_width")]
    pub outline_width: u32,
    #[serde(default = "default_editor_flex")]
    pub editor_flex: f32,
    #[serde(default = "default_true")]
    pub sidebar_open: bool,
    #[serde(default = "default_active_panel")]
    pub active_panel: String,
    #[serde(default = "default_sidebar_panel")]
    pub sidebar_panel: String,
}

fn default_sidebar_width() -> u32 { 240 }
fn default_outline_width() -> u32 { 180 }
fn default_editor_flex() -> f32 { 0.5 }
fn default_true() -> bool { true }
fn default_active_panel() -> String { "split".to_string() }
fn default_sidebar_panel() -> String { "explorer".to_string() }

pub struct Workspace {
    pub meta: WorkspaceMeta,
    pub buffers: BufferManager,
    pub watcher: Option<crate::workspace::watcher::WorkspaceWatcher>,
    /// LSP 管理器
    pub lsp_manager: Arc<RwLock<crate::editor::lsp::LspManager>>,
}

impl Workspace {
    pub fn new(meta: WorkspaceMeta) -> Self {
        let project_root = meta.project_root.clone();
        Self {
            meta,
            buffers: BufferManager::new(),
            watcher: None,
            lsp_manager: Arc::new(RwLock::new(
                crate::editor::lsp::LspManager::new(project_root)
            )),
        }
    }

    pub fn name(&self) -> &str {
        &self.meta.name
    }

    pub fn project_root(&self) -> &Path {
        &self.meta.project_root
    }
}

/// 窗口与 workspace 的激活关系
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WindowMapping {
    pub active: HashMap<String, WorkspaceId>,
}

impl WindowMapping {
    pub fn active_for(&self, window_label: &str) -> Option<&WorkspaceId> {
        self.active.get(window_label)
    }
}

/// 注册表内部保护数据
#[derive(Default)]
pub struct RegistryData {
    pub workspaces: HashMap<WorkspaceId, Workspace>,
    pub windows: WindowMapping,
    pub lru_order: Vec<WorkspaceId>,
}

/// 工作区注册表
pub struct WorkspaceRegistry {
    inner: RwLock<RegistryData>,
}

impl Default for WorkspaceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 取一个 workspace 元数据的快照（克隆，不持锁）
#[derive(Debug, Clone)]
pub struct WorkspaceSnapshot {
    pub id: WorkspaceId,
    pub meta: WorkspaceMeta,
}

impl WorkspaceRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(RegistryData::default()),
        }
    }

    /// 从快照恢复（保留现有 workspace，合并 LRU 顺序和窗口映射）
    pub async fn restore(&self, snap: RegistrySnapshot) -> Result<(), String> {
        let mut guard = self.inner.write().await;
        for (id, meta) in snap.workspaces {
            if !guard.workspaces.contains_key(&id) {
                guard.workspaces.insert(id, Workspace::new(meta));
            }
        }
        for id in snap.lru_order {
            if !guard.lru_order.contains(&id) && guard.workspaces.contains_key(&id) {
                guard.lru_order.push(id);
            }
        }
        for (k, v) in snap.windows.active {
            guard.windows.active.entry(k).or_insert(v);
        }
        Ok(())
    }

    pub async fn add(&self, id: WorkspaceId, ws: Workspace) -> Result<(), String> {
        let mut guard = self.inner.write().await;
        if guard.workspaces.contains_key(&id) {
            return Err(format!("workspace already exists: {}", id));
        }
        guard.workspaces.insert(id.clone(), ws);
        guard.lru_order.push(id);
        Ok(())
    }

    pub async fn remove(&self, id: &str) -> Option<Workspace> {
        let mut guard = self.inner.write().await;
        let ws = guard.workspaces.remove(id)?;
        guard.lru_order.retain(|x| x != id);
        for active in guard.windows.active.values_mut() {
            if active == id {
                *active = String::new();
            }
        }
        Some(ws)
    }

    /// 取一个 workspace 的元数据快照（克隆，**不持锁**，调用方可以跨 await 使用）
    pub async fn snapshot_workspace(&self, id: &str) -> Option<WorkspaceSnapshot> {
        let guard = self.inner.read().await;
        let ws = guard.workspaces.get(id)?;
        Some(WorkspaceSnapshot {
            id: id.to_string(),
            meta: ws.meta.clone(),
        })
    }

    /// 取一个 workspace 的 project_root 路径（克隆，**不持锁**）
    pub async fn project_root(&self, id: &str) -> Option<PathBuf> {
        let guard = self.inner.read().await;
        guard.workspaces.get(id).map(|w| w.meta.project_root.clone())
    }

    /// 在持有写锁的同一作用域内访问 workspace 缓冲与元数据。
    /// 由于 BufferManager 内部也是 RwLock，这里用闭包把"锁保护"和"业务逻辑"分两层。
    /// 注：闭包返回时锁已释放，因此内部不应跨 await 持有 buffer 引用。
    pub async fn with_workspace<F, R>(&self, id: &str, f: F) -> Result<R, String>
    where
        F: FnOnce(&Workspace) -> R,
    {
        let guard = self.inner.read().await;
        let ws = guard
            .workspaces
            .get(id)
            .ok_or_else(|| format!("workspace not found: {}", id))?;
        Ok(f(ws))
    }

    pub async fn ids(&self) -> Vec<WorkspaceId> {
        let guard = self.inner.read().await;
        guard
            .lru_order
            .iter()
            .filter(|id| guard.workspaces.contains_key(*id))
            .cloned()
            .collect()
    }

    pub async fn touch(&self, id: &str) {
        let mut guard = self.inner.write().await;
        guard.lru_order.retain(|x| x != id);
        guard.lru_order.push(id.to_string());
        if let Some(ws) = guard.workspaces.get_mut(id) {
            ws.meta.last_used_at = now_secs();
        }
    }

    pub async fn update_meta<F>(&self, id: &str, f: F) -> Result<(), String>
    where
        F: FnOnce(&mut WorkspaceMeta),
    {
        let mut guard = self.inner.write().await;
        let ws = guard
            .workspaces
            .get_mut(id)
            .ok_or_else(|| format!("workspace not found: {}", id))?;
        f(&mut ws.meta);
        Ok(())
    }

    pub async fn set_active(&self, window_label: &str, workspace_id: &str) -> Result<(), String> {
        let mut guard = self.inner.write().await;
        if !guard.workspaces.contains_key(workspace_id) {
            return Err(format!("workspace not found: {}", workspace_id));
        }
        guard
            .windows
            .active
            .insert(window_label.to_string(), workspace_id.to_string());
        Ok(())
    }

    pub async fn clear_window(&self, window_label: &str) {
        let mut guard = self.inner.write().await;
        guard.windows.active.remove(window_label);
    }

    pub async fn attach_watcher(
        &self,
        id: &str,
        watcher: crate::workspace::watcher::WorkspaceWatcher,
    ) -> Result<(), String> {
        let mut guard = self.inner.write().await;
        let ws = guard
            .workspaces
            .get_mut(id)
            .ok_or_else(|| format!("workspace not found: {}", id))?;
        ws.watcher = Some(watcher);
        Ok(())
    }

    pub async fn detach_watcher(&self, id: &str) -> Result<(), String> {
        let mut guard = self.inner.write().await;
        let ws = guard
            .workspaces
            .get_mut(id)
            .ok_or_else(|| format!("workspace not found: {}", id))?;
        ws.watcher = None;
        Ok(())
    }

    pub async fn active_for_window(&self, window_label: &str) -> Option<WorkspaceId> {
        let guard = self.inner.read().await;
        let id = guard.windows.active.get(window_label)?;
        if id.is_empty() || !guard.workspaces.contains_key(id) {
            return None;
        }
        Some(id.clone())
    }

    pub async fn window_mappings(&self) -> WindowMapping {
        self.inner.read().await.windows.clone()
    }

    pub async fn snapshot(&self) -> RegistrySnapshot {
        let guard = self.inner.read().await;
        RegistrySnapshot {
            workspaces: guard
                .workspaces
                .iter()
                .map(|(k, v)| (k.clone(), v.meta.clone()))
                .collect(),
            windows: guard.windows.clone(),
            lru_order: guard.lru_order.clone(),
        }
    }
}

pub type SharedRegistry = Arc<WorkspaceRegistry>;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn derive_workspace_id(project_root: &Path) -> WorkspaceId {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let canonical = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());
    let mut h = DefaultHasher::new();
    canonical.hash(&mut h);
    format!("ws-{:016x}", h.finish())
}

pub fn derive_workspace_name(project_root: &Path) -> String {
    let canonical = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());
    canonical
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| canonical.to_string_lossy().to_string())
}

/// 注册表的"纯数据视图"，用于序列化与单测断言
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RegistrySnapshot {
    pub workspaces: HashMap<WorkspaceId, WorkspaceMeta>,
    pub windows: WindowMapping,
    pub lru_order: Vec<WorkspaceId>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_meta(name: &str, path: &str) -> WorkspaceMeta {
        WorkspaceMeta {
            name: name.to_string(),
            project_root: PathBuf::from(path),
            open_tabs: vec![],
            active_tab: None,
            ui_state: UiState::default(),
            last_used_at: 0,
        }
    }

    #[tokio::test]
    async fn add_and_get_workspace() {
        let reg = WorkspaceRegistry::new();
        let id = "ws-1".to_string();
        reg.add(id.clone(), Workspace::new(make_meta("alpha", "/tmp/alpha")))
            .await
            .unwrap();
        let snap = reg.snapshot_workspace(&id).await.unwrap();
        assert_eq!(snap.meta.name, "alpha");
    }

    #[tokio::test]
    async fn duplicate_add_returns_error() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap();
        let err = reg
            .add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[tokio::test]
    async fn remove_cleans_lru_and_window_mapping() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap();
        reg.add("b".into(), Workspace::new(make_meta("b", "/b")))
            .await
            .unwrap();
        reg.set_active("main", "a").await.unwrap();
        reg.set_active("detached", "b").await.unwrap();

        reg.remove("a").await;
        assert!(reg.snapshot_workspace("a").await.is_none());
        let snap = reg.snapshot().await;
        assert_eq!(snap.lru_order, vec!["b".to_string()]);
        assert_eq!(snap.windows.active.get("main").map(|s| s.as_str()), Some(""));
    }

    #[tokio::test]
    async fn touch_moves_to_lru_end() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap();
        reg.add("b".into(), Workspace::new(make_meta("b", "/b")))
            .await
            .unwrap();
        reg.touch("a").await;
        assert_eq!(reg.ids().await, vec!["b".to_string(), "a".to_string()]);
    }

    #[tokio::test]
    async fn set_active_requires_existing_workspace() {
        let reg = WorkspaceRegistry::new();
        let err = reg.set_active("main", "ghost").await.unwrap_err();
        assert!(err.contains("not found"));
    }

    #[tokio::test]
    async fn active_for_window_returns_workspace_id() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap();
        reg.set_active("main", "a").await.unwrap();
        assert_eq!(reg.active_for_window("main").await.as_deref(), Some("a"));
        assert!(reg.active_for_window("nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn active_for_window_skips_orphan_mappings() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap();
        reg.set_active("win1", "a").await.unwrap();
        reg.remove("a").await;
        assert!(reg.active_for_window("win1").await.is_none());
    }

    #[tokio::test]
    async fn clear_window_removes_active_mapping() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap();
        reg.set_active("win1", "a").await.unwrap();
        reg.clear_window("win1").await;
        assert!(reg.active_for_window("win1").await.is_none());
    }

    #[tokio::test]
    async fn update_meta_persists_changes() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap();
        reg.update_meta("a", |m| {
            m.open_tabs.push("/a/foo.rs".to_string());
            m.active_tab = Some("/a/foo.rs".to_string());
        })
        .await
        .unwrap();
        let snap = reg.snapshot_workspace("a").await.unwrap();
        assert_eq!(snap.meta.open_tabs, vec!["/a/foo.rs".to_string()]);
        assert_eq!(snap.meta.active_tab.as_deref(), Some("/a/foo.rs"));
    }

    #[tokio::test]
    async fn snapshot_roundtrip_via_restore() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a")))
            .await
            .unwrap();
        reg.add("b".into(), Workspace::new(make_meta("b", "/b")))
            .await
            .unwrap();
        reg.set_active("main", "a").await.unwrap();
        reg.touch("a").await;
        let snap = reg.snapshot().await;

        let reg2 = WorkspaceRegistry::new();
        reg2.restore(snap.clone()).await.unwrap();
        let snap2 = reg2.snapshot().await;
        assert_eq!(snap2.lru_order, snap.lru_order);
        assert_eq!(snap2.workspaces.get("a").unwrap().name, "a");
        assert_eq!(snap2.workspaces.get("b").unwrap().name, "b");
        assert_eq!(snap2.windows.active.get("main").unwrap(), "a");
    }

    #[tokio::test]
    async fn restore_does_not_overwrite_existing() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a-old", "/a")))
            .await
            .unwrap();
        let snap = RegistrySnapshot {
            workspaces: [("a".into(), make_meta("a-new", "/a"))]
                .into_iter()
                .collect(),
            windows: WindowMapping::default(),
            lru_order: vec!["a".into()],
        };
        reg.restore(snap).await.unwrap();
        let h = reg.snapshot_workspace("a").await.unwrap();
        assert_eq!(h.meta.name, "a-old");
    }

    #[tokio::test]
    async fn project_root_returns_pathbuf() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("a", "/a/b/c")))
            .await
            .unwrap();
        let root = reg.project_root("a").await.unwrap();
        assert_eq!(root, PathBuf::from("/a/b/c"));
    }

    #[tokio::test]
    async fn with_workspace_runs_closure() {
        let reg = WorkspaceRegistry::new();
        reg.add("a".into(), Workspace::new(make_meta("alpha", "/a")))
            .await
            .unwrap();
        let name = reg
            .with_workspace("a", |ws| ws.name().to_string())
            .await
            .unwrap();
        assert_eq!(name, "alpha");
    }

    #[test]
    fn derive_workspace_id_is_deterministic_and_unique() {
        let id1 = derive_workspace_id(Path::new("/tmp/foo"));
        let id2 = derive_workspace_id(Path::new("/tmp/foo"));
        let id3 = derive_workspace_id(Path::new("/tmp/bar"));
        assert_eq!(id1, id2);
        assert_ne!(id1, id3);
        assert!(id1.starts_with("ws-"));
    }

    #[test]
    fn derive_workspace_name_uses_basename() {
        assert_eq!(derive_workspace_name(Path::new("/a/b/c")), "c");
    }
}
