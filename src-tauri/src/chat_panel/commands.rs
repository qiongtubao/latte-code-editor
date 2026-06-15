use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

use super::config::{load_role_metadata, load_workflow_info};
use super::session::{run_stub_discussion, default_role_ids};
use super::types::*;

static NEXT_SESSION_ID: AtomicUsize = AtomicUsize::new(1);

/// List available workflows.
#[tauri::command]
pub async fn chat_list_workflows() -> Result<Vec<WorkflowInfo>, String> {
    let workflows = load_workflow_info();
    let roles = load_role_metadata();
    let mut out = Vec::new();
    for (id, name, _steps_raw) in workflows {
        // Pull the default roles from the workflow step config
        let default_roles = match id.as_str() {
            "default_workflow" => vec![
                "pm".to_string(),
                "architect".to_string(),
                "programmer".to_string(),
                "tester".to_string(),
                "reviewer".to_string(),
                "security".to_string(),
                "manager".to_string(),
            ],
            "workflows.requirements_review" => vec![
                "pm".into(),
                "architect".into(),
                "programmer".into(),
                "tester".into(),
                "manager".into(),
            ],
            "workflows.code_review" => vec![
                "programmer".into(),
                "reviewer".into(),
                "security".into(),
                "tester".into(),
            ],
            "workflows.design_brainstorm" => vec![
                "pm".into(),
                "architect".into(),
                "programmer".into(),
                "designer".into(),
                "reviewer".into(),
                "security".into(),
                "devops".into(),
            ],
            "workflows.bug_triage" => vec![
                "tester".into(),
                "programmer".into(),
                "security".into(),
                "devops".into(),
                "manager".into(),
            ],
            _ => default_role_ids().iter().map(|s| s.to_string()).collect(),
        };
        out.push(WorkflowInfo {
            id: id.clone(),
            name,
            description: format!("Workflow: {}", id),
            default_roles,
            steps: vec![],
        });
    }
    let _ = roles; // not used here, but available
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
/// events as each agent responds. Currently runs in stub mode.
#[tauri::command]
pub async fn chat_start_discussion(
    app: AppHandle,
    request: StartDiscussionRequest,
) -> Result<usize, String> {
    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst);
    let req = request.clone();

    // Stub mode: emit fake but realistic turns. The `chat:turn` events
    // are emitted from inside `run_stub_discussion`.
    let result = run_stub_discussion(&app, &req).await;
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
/// Currently also runs stub mode (one more round) for demo purposes.
#[tauri::command]
pub async fn chat_continue(
    app: AppHandle,
    request: ContinueDiscussionRequest,
) -> Result<(), String> {
    let req = StartDiscussionRequest {
        topic: request.message,
        workflow: "default_workflow".into(),
        custom_roles: None,
        max_rounds: Some(1),
    };
    let result = run_stub_discussion(&app, &req).await;
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

/// Cancel a running discussion. In stub mode this is a no-op since
/// turns complete synchronously. Real-mode would use a CancellationToken.
#[tauri::command]
pub async fn chat_cancel(session_id: usize) -> Result<(), String> {
    // No-op for stub mode
    Ok(())
}
