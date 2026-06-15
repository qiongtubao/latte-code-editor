use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

use super::config::{load_role_metadata, load_workflow_info};
use super::global_config::{load_global_models, load_roles_config, global_models_path, roles_config_path};
use super::session::{default_role_ids, run_discussion, WORKFLOW_PRESETS};
use super::types::*;

static NEXT_SESSION_ID: AtomicUsize = AtomicUsize::new(1);

/// List available models from ~/.latte/models.yaml
#[tauri::command]
pub async fn chat_list_models() -> Result<Vec<ModelInfo>, String> {
    let global_config = load_global_models();
    
    let models: Vec<ModelInfo> = global_config
        .models
        .iter()
        .map(|(id, m)| ModelInfo {
            id: id.clone(),
            name: m.name.clone(),
            provider: m.provider.clone(),
            max_tokens: m.max_tokens,
            context_window: m.context_window,
            supports_vision: m.supports_vision,
            supports_thinking: m.supports_thinking,
        })
        .collect();
    
    Ok(models)
}

/// Get current role configuration from ~/.latte-code-editor/roles.yaml
#[tauri::command]
pub async fn chat_get_role_config() -> Result<RoleConfigResponse, String> {
    let role_config = load_roles_config();
    let global_config = load_global_models();
    
    let roles: Vec<RoleInfo> = role_config
        .roles
        .iter()
        .map(|(id, r)| RoleInfo {
            id: id.clone(),
            name: r.name.clone(),
            icon: r.icon.clone(),
            category: r.category.clone(),
            default_model_tier: r.model.clone().unwrap_or_else(|| role_config.default_model.clone()),
        })
        .collect();
    
    let workflows: Vec<WorkflowInfo> = role_config
        .workflows
        .iter()
        .map(|(id, w)| WorkflowInfo {
            id: id.clone(),
            name: w.name.clone(),
            description: format!("Roles: {}", w.roles.join(", ")),
            default_roles: w.roles.clone(),
            steps: vec![],
        })
        .collect();
    
    Ok(RoleConfigResponse {
        default_model: role_config.default_model,
        roles,
        workflows,
        models_path: global_models_path().to_string_lossy().to_string(),
        roles_path: roles_config_path().to_string_lossy().to_string(),
    })
}

/// Set model for a specific role
#[tauri::command]
pub async fn chat_set_role_model(
    role_id: String,
    model_id: String,
) -> Result<(), String> {
    let mut role_config = load_roles_config();
    
    if let Some(role) = role_config.roles.get_mut(&role_id) {
        role.model = Some(model_id);
    } else {
        return Err(format!("Role '{}' not found", role_id));
    }
    
    // Save back to file
    let path = roles_config_path();
    let content = serde_yaml::to_string(&role_config)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write {:?}: {}", path, e))?;
    
    Ok(())
}

/// Set default model
#[tauri::command]
pub async fn chat_set_default_model(model_id: String) -> Result<(), String> {
    let mut role_config = load_roles_config();
    role_config.default_model = model_id;
    
    let path = roles_config_path();
    let content = serde_yaml::to_string(&role_config)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write {:?}: {}", path, e))?;
    
    Ok(())
}

/// Open config file in editor
#[tauri::command]
pub async fn chat_open_config(config_type: String) -> Result<String, String> {
    let path = match config_type.as_str() {
        "models" => global_models_path(),
        "roles" => roles_config_path(),
        _ => return Err(format!("Unknown config type: {}", config_type)),
    };
    
    Ok(path.to_string_lossy().to_string())
}

/// List the user-facing workflow presets (Plan / Code / Debug / Discuss).
#[tauri::command]
pub async fn chat_list_workflows() -> Result<Vec<WorkflowInfo>, String> {
    // Try loading from global config first
    let role_config = load_roles_config();
    
    if !role_config.workflows.is_empty() {
        let workflows: Vec<WorkflowInfo> = role_config
            .workflows
            .iter()
            .map(|(id, w)| WorkflowInfo {
                id: id.clone(),
                name: w.name.clone(),
                description: format!("Roles: {}", w.roles.join(", ")),
                default_roles: w.roles.clone(),
                steps: vec![],
            })
            .collect();
        return Ok(workflows);
    }
    
    // Fallback to presets
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
    
    // Also include any workflows defined in discussion.toml that aren't already covered
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
    // Try loading from global config first
    let role_config = load_roles_config();
    
    if !role_config.roles.is_empty() {
        let mut roles: Vec<RoleInfo> = role_config
            .roles
            .iter()
            .map(|(id, r)| RoleInfo {
                id: id.clone(),
                name: r.name.clone(),
                icon: r.icon.clone(),
                category: r.category.clone(),
                default_model_tier: r.model.clone().unwrap_or_else(|| role_config.default_model.clone()),
            })
            .collect();
        roles.sort_by(|a, b| a.id.cmp(&b.id));
        return Ok(roles);
    }
    
    // Fallback to embedded config
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
