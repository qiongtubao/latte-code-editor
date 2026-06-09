//! Workspace 管理命令（暴露给前端 + tauri command handler）

use crate::workspace::persistence::Persistence;
use crate::workspace::registry::{
    RegistrySnapshot, UiState, WindowMapping, Workspace, WorkspaceId, WorkspaceMeta,
    WorkspaceRegistry,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

/// 前端可见的 workspace 列表项
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorkspaceInfo {
    pub id: WorkspaceId,
    pub meta: WorkspaceMeta,
}

#[tauri::command]
pub async fn list_workspaces(
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Vec<WorkspaceInfo>, String> {
    let mut out = Vec::new();
    for id in registry.ids().await {
        if let Some(snap) = registry.snapshot_workspace(&id).await {
            out.push(WorkspaceInfo {
                id: snap.id,
                meta: snap.meta,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn set_active_workspace(
    workspace_id: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    registry
        .set_active(window.label(), &workspace_id)
        .await?;
    registry.touch(&workspace_id).await;
    Ok(())
}

#[tauri::command]
pub async fn close_workspace(
    workspace_id: String,
    app: tauri::AppHandle,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let _ = registry.detach_watcher(&workspace_id).await;
    registry.remove(&workspace_id).await;
    persist_async(registry.inner().clone(), app).await;
    Ok(())
}

/// 更新元数据（tabs / active_tab / ui_state / name）
#[derive(Deserialize)]
pub struct UpdateMetaArgs {
    pub workspace_id: String,
    pub open_tabs: Option<Vec<String>>,
    pub active_tab: Option<Option<String>>,
    pub ui_state: Option<UiState>,
    pub name: Option<String>,
}

#[tauri::command]
pub async fn update_workspace_meta(
    args: UpdateMetaArgs,
    app: tauri::AppHandle,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let UpdateMetaArgs {
        workspace_id,
        open_tabs,
        active_tab,
        ui_state,
        name,
    } = args;
    registry
        .update_meta(&workspace_id, |m| {
            if let Some(tabs) = open_tabs {
                m.open_tabs = tabs;
            }
            if let Some(active) = active_tab {
                m.active_tab = active;
            }
            if let Some(ui) = ui_state {
                m.ui_state = ui;
            }
            if let Some(n) = name {
                m.name = n;
            }
        })
        .await?;
    persist_async(registry.inner().clone(), app).await;
    Ok(())
}

#[tauri::command]
pub async fn new_workspace(
    project_root: String,
    window: Window,
    app: tauri::AppHandle,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<WorkspaceInfo, String> {
    let p = PathBuf::from(&project_root);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", project_root));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    let id = crate::workspace::registry::derive_workspace_id(&canonical);
    let name = crate::workspace::registry::derive_workspace_name(&canonical);

    if registry.snapshot_workspace(&id).await.is_none() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let meta = WorkspaceMeta {
            name,
            project_root: canonical.clone(),
            open_tabs: vec![],
            active_tab: None,
            ui_state: UiState::default(),
            last_used_at: now,
        };
        registry
            .add(id.clone(), Workspace::new(meta.clone()))
            .await
            .map_err(|e| format!("Cannot add workspace: {}", e))?;
        let hub: tauri::State<Arc<crate::graph::incremental::IncrementalHub>> = app.state();
        match crate::workspace::watcher::WorkspaceWatcher::start(
            &canonical,
            hub.inner().clone(),
            id.clone(),
        ) {
            Ok(w) => {
                let _ = registry.attach_watcher(&id, w).await;
            }
            Err(e) => eprintln!("[new_workspace] start watcher failed: {}", e),
        }
    }

    registry.set_active(window.label(), &id).await?;
    registry.touch(&id).await;
    persist_async(registry.inner().clone(), app).await;

    let snap = registry.snapshot_workspace(&id).await.unwrap();
    Ok(WorkspaceInfo {
        id: snap.id,
        meta: snap.meta,
    })
}

#[tauri::command]
pub async fn detach_workspace_to_window(
    workspace_id: String,
    app: tauri::AppHandle,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<String, String> {
    if registry.snapshot_workspace(&workspace_id).await.is_none() {
        return Err(format!("Workspace not found: {}", workspace_id));
    }
    let new_label = format!("workspace-{}", workspace_id);
    if app.get_webview_window(&new_label).is_some() {
        return Err(format!("Window '{}' already exists", new_label));
    }
    registry.set_active(&new_label, &workspace_id).await?;
    registry.touch(&workspace_id).await;

    let url = WebviewUrl::App("index.html".into());
    WebviewWindowBuilder::new(&app, &new_label, url)
        .title(format!("Latte — {}", workspace_id))
        .inner_size(1200.0, 800.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Cannot create window: {}", e))?;

    persist_async(registry.inner().clone(), app).await;
    Ok(new_label)
}

/// 把当前 registry 状态落盘（最佳努力：失败仅记日志，不阻断命令返回）
async fn persist_async(registry: Arc<WorkspaceRegistry>, app: tauri::AppHandle) {
    let snap = registry.snapshot().await;
    match app.path().app_data_dir() {
        Ok(dir) => {
            let pers = Persistence::new(dir);
            if let Err(e) = pers.save(&snap).await {
                eprintln!("[persist_async] save failed: {}", e);
            }
        }
        Err(e) => eprintln!("[persist_async] cannot resolve app_data_dir: {}", e),
    }
}

#[allow(dead_code)]
fn _snapshot_unused() -> RegistrySnapshot {
    RegistrySnapshot::default()
}

#[allow(dead_code)]
fn _windowmapping_unused() -> WindowMapping {
    WindowMapping::default()
}
