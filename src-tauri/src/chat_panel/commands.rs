use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

use super::config::{load_role_metadata, load_workflow_info};
use super::session::{default_role_ids, run_discussion, WORKFLOW_PRESETS};
use super::types::*;

static NEXT_SESSION_ID: AtomicUsize = AtomicUsize::new(1);

/// List the user-facing workflow presets (Plan / Code / Debug / Discuss).
#[tauri::command]
pub async fn chat_list_workflows() -> Result<Vec<WorkflowInfo>, String> {
    let mut out: Vec<WorkflowInfo> = WORKFLOW_PRESETS
        .iter()
        .map(|(id, _wf_id, default_roles, _rounds, label)| WorkflowInfo {
            id: id.to_string(),
            name: label.to_string(),
            description: match *id {
                "plan" => "Multi-perspective design and architecture discussion".to_string(),
                "code" => "Code review, refactoring, and security/style checks".to_string(),
                "debug" => "Triage, root-cause analysis, and fix proposals".to_string(),
                "discuss" => "Full team discussion: requirements → design → review → decide"
                    .to_string(),
                _ => String::new(),
            },
            default_roles: default_roles.iter().map(|s| s.to_string()).collect(),
            steps: vec![],
        })
        .collect();
    // Also include any workflows defined in discussion.toml that aren't
    // already covered by the presets, so users can pick the raw ids.
    for (raw_id, _name, _) in load_workflow_info() {
        if !out.iter().any(|w| w.id == raw_id) {
            out.push(WorkflowInfo {
                id: raw_id.clone(),
                name: raw_id.clone(),
                description: format!("Raw workflow from discussion.toml: {}", raw_id),
                default_roles: default_role_ids().iter().map(|s| s.to_string()).collect(),
                steps: vec![],
            });
        }
    }
    Ok(out)
}

/// List available roles (id + name + icon + category).
#[tauri::command]
pub async fn chat_list_roles() -> Result<Vec<RoleInfo>, String> {
    let roles = load_role_metadata();
    let mut out: Vec<RoleInfo> = roles
        .into_iter()
        .map(|(id, (name, icon, category))| RoleInfo {
            id: id.clone(),
            name,
            icon,
            category,
            default_model_tier: "standard".into(),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Start a new discussion. Returns the session id and emits `chat:turn`
/// events as each agent responds. Uses real LLM if API keys are present.
#[tauri::command]
pub async fn chat_start_discussion(
    app: AppHandle,
    request: StartDiscussionRequest,
) -> Result<usize, String> {
    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst);
    let req = request.clone();

    let result = run_discussion(&app, &req).await;
    match result {
        Ok(payload) => {
            let _ = app.emit("chat:complete", &payload);
        }
        Err(e) => {
            let _ = app.emit("chat:error", e);
        }
    }
    Ok(session_id)
}

/// Send a follow-up message in an existing discussion.
#[tauri::command]
pub async fn chat_continue(
    app: AppHandle,
    request: ContinueDiscussionRequest,
) -> Result<(), String> {
    let req = StartDiscussionRequest {
        topic: request.message,
        // Follow-ups default to "discuss" (full team) — users can switch
        // via the workflow selector before sending.
        workflow: "discuss".into(),
        custom_roles: None,
        max_rounds: Some(1),
    };
    let result = run_discussion(&app, &req).await;
    match result {
        Ok(payload) => {
            let _ = app.emit("chat:complete", &payload);
        }
        Err(e) => {
            let _ = app.emit("chat:error", e);
        }
    }
    Ok(())
}

/// Cancel a running discussion. Currently a no-op stub.
#[tauri::command]
pub async fn chat_cancel(session_id: usize) -> Result<(), String> {
    Ok(())
}
