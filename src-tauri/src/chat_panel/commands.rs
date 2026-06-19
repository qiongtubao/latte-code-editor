use std::sync::atomic::{AtomicUsize, Ordering};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use super::global_config::{load_global_models, load_roles_config, write_roles_config, global_models_path, roles_config_path, WorkflowDef, WorkflowKind, WorkflowStep};
use super::session::{default_role_ids, run_discussion, WORKFLOW_PRESETS};
use super::types::*;
static NEXT_SESSION_ID: AtomicUsize = AtomicUsize::new(1);

/// Map a workflow id + kind to the runtime dispatch tag used by the
/// chat panel. Workflows whose id starts with `manager_` always run
/// in manager-led mode (regardless of `kind`); other workflows
/// dispatch on `kind`. This lets us keep `WorkflowKind` enum
/// unchanged while still surfacing the new mode to the UI.
pub fn derive_mode(id: &str, kind: &str) -> String {
    if id.starts_with("manager_") {
        "manager_led".to_string()
    } else {
        kind.to_string()
    }
}

/// Convert a `WorkflowKind` to its serialized string form. Used
/// both as `kind` and as the input to `derive_mode`.
pub fn kind_to_str(kind: super::global_config::WorkflowKind) -> String {
    match kind {
        super::global_config::WorkflowKind::Planned => "planned".to_string(),
        super::global_config::WorkflowKind::Swarm => "swarm".to_string(),
    }
}
#[tauri::command]
pub async fn chat_list_models() -> Result<Vec<ModelInfo>, String> {
    let global_config = load_global_models();

    let models: Vec<ModelInfo> = global_config
        .models
        .iter()
        .map(|m| ModelInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            provider: m.provider.clone(),
            max_tokens: m.max_tokens,
            context_window: m.context_window,
            supports_vision: false,
            supports_thinking: m.reasoning,
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
        .map(|(id, r)| {
            let chain = r.chain();
            // For UI back-compat: surface the primary model as
            // `default_model_tier` so existing dropdowns still work.
            let primary = chain
                .first()
                .cloned()
                .unwrap_or_else(|| role_config.default_model.clone());
            RoleInfo {
                id: id.clone(),
                name: r.name.clone(),
                icon: r.icon.clone(),
                category: r.category.clone(),
                default_model_tier: primary,
                model_chain: chain,
            }
        })
        .collect();

    // Workflows live in their own files under `~/.latte-code-editor/workflows/`.
    // We don't read them out of `roles.yaml` anymore — that's reserved
    // for roles + default model. `read_all_workflow_files` returns a
    // sorted map so the chat panel dropdown order is deterministic.
    let workflows: Vec<WorkflowInfo> = super::global_config::read_all_workflow_files()
        .iter()
        .map(|(id, w)| WorkflowInfo {
            id: id.clone(),
            mode: derive_mode(id, &kind_to_str(w.kind)),
            name: w.name.clone(),
            description: match w.kind {
                super::global_config::WorkflowKind::Swarm => {
                    format!(
                        "🪄 Swarm — planner-driven ({}). Workers: {}",
                        if w.planner_role.is_empty() { "manager" } else { w.planner_role.as_str() },
                        if w.worker_roles.is_empty() { "all".to_string() } else { w.worker_roles.join(", ") }
                    )
                }
                super::global_config::WorkflowKind::Planned => {
                    format!("Roles: {}", w.roles.join(", "))
                }
            },
            default_roles: w.roles.clone(),
            steps: vec![],
            kind: kind_to_str(w.kind),
            planner_role: w.planner_role.clone(),
            worker_roles: w.worker_roles.clone(),
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
/// Fetch the full editable payload for one workflow, by id. The
/// `chat_get_role_config` summary returns only the flat roles list;
/// the editor needs the per-step breakdown.
pub async fn chat_get_workflow_full(id: String) -> Result<WorkflowPayload, String> {
    super::global_config::read_workflow_file(&id)?
        .map(|wf| workflow_def_to_payload(&id, &wf))
        .ok_or_else(|| format!("未找到工作流 `{id}`（workflows/ 下没有同名 .yaml 文件）"))
}

/// List full editable payloads for every workflow. Used when the
/// editor wants to show the full picture (e.g. "duplicate this
/// workflow" action). The dropdown uses `chat_get_role_config`'s
/// slimmer summary.
#[tauri::command]
pub async fn chat_list_workflows_full() -> Result<Vec<WorkflowPayload>, String> {
    Ok(super::global_config::read_all_workflow_files()
        .iter()
        .map(|(id, w)| workflow_def_to_payload(id, w))
        .collect())
}


/// Set model for a specific role
#[tauri::command]
pub async fn chat_set_role_model(
    role_id: String,
    model_id: String,
) -> Result<(), String> {
    let mut role_config = load_roles_config();

    if let Some(role) = role_config.roles.get_mut(&role_id) {
        // Persist as a single-element chain so the YAML form is unambiguous.
        role.set_chain(vec![model_id]);
    } else {
        return Err(format!("Role '{}' not found", role_id));
    }

    let path = roles_config_path();
    let content = serde_yaml::to_string(&role_config)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write {:?}: {}", path, e))?;

    Ok(())
}

/// Set the priority-ordered model chain for a specific role.
///
/// `chain[0]` becomes the primary; the rest are fallbacks tried in
/// order when earlier models fail. Empty chains are rejected.
/// Validates that every model id is present in the global catalog.
#[tauri::command]
pub async fn chat_set_role_model_chain(
    request: SetRoleModelChainRequest,
) -> Result<Vec<String>, String> {
    if request.chain.is_empty() {
        return Err("model chain must contain at least one model".to_string());
    }
    // Deduplicate while preserving order — the runner dedups again, but
    // a stable, minimal YAML form is friendlier to read by hand.
    let mut seen = std::collections::HashSet::new();
    let chain: Vec<String> = request
        .chain
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    let global_config = load_global_models();
    let unknown: Vec<&String> = chain
        .iter()
        .filter(|m| !global_config.models.iter().any(|def| &def.id == *m))
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "unknown model(s) in chain: {}",
            unknown
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let mut role_config = load_roles_config();
    let role = role_config
        .roles
        .get_mut(&request.role_id)
        .ok_or_else(|| format!("Role '{}' not found", request.role_id))?;
    role.set_chain(chain.clone());

    let path = roles_config_path();
    let content = serde_yaml::to_string(&role_config)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write {:?}: {}", path, e))?;

    Ok(chain)
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

/// List workflows
#[tauri::command]
pub async fn chat_list_workflows() -> Result<Vec<WorkflowInfo>, String> {
    let role_config = load_roles_config();

    if !role_config.workflows.is_empty() {
        let workflows: Vec<WorkflowInfo> = role_config
            .workflows
            .iter()
            .map(|(id, w)| WorkflowInfo {
                id: id.clone(),
                mode: derive_mode(&id, &kind_to_str(w.kind)),
                name: w.name.clone(),
                description: match w.kind {
                    super::global_config::WorkflowKind::Swarm => {
                        format!(
                            "🪄 Swarm — planner `{}`, max {} steps",
                            if w.planner_role.is_empty() { "manager" } else { w.planner_role.as_str() },
                            w.max_steps
                        )
                    }
                    super::global_config::WorkflowKind::Planned => {
                        format!("Roles: {}", w.roles.join(", "))
                    }
                },
                default_roles: w.roles.clone(),
                steps: vec![],
                kind: kind_to_str(w.kind),
                planner_role: w.planner_role.clone(),
                worker_roles: w.worker_roles.clone(),
            })
            .collect();
        return Ok(workflows);
    }

    // Fallback to built-in presets (all planned; no swarm preset here)
    let out: Vec<WorkflowInfo> = WORKFLOW_PRESETS
        .iter()
        .map(|(id, _wf_id, default_roles, _rounds, label)| WorkflowInfo {
            id: id.to_string(),
            mode: derive_mode(id, "planned"),
            name: label.to_string(),
            description: match *id {
                "plan" => "Multi-perspective design and architecture discussion".to_string(),
                "code" => "Code review, refactoring, and security/style checks".to_string(),
                "debug" => "Triage, root-cause analysis, and fix proposals".to_string(),
                "discuss" => "Full team discussion: requirements → design → review → decide".to_string(),
                _ => String::new(),
            },
            default_roles: default_roles.iter().map(|s| s.to_string()).collect(),
            steps: vec![],
            kind: "planned".into(),
            planner_role: String::new(),
            worker_roles: Vec::new(),
        })
        .collect();
    Ok(out)
}

/// List available roles
#[tauri::command]
pub async fn chat_list_roles() -> Result<Vec<RoleInfo>, String> {
    let role_config = load_roles_config();

    if !role_config.roles.is_empty() {
        let mut roles: Vec<RoleInfo> = role_config
            .roles
            .iter()
            .map(|(id, r)| {
                let chain = r.chain();
                let primary = chain
                    .first()
                    .cloned()
                    .unwrap_or_else(|| role_config.default_model.clone());
                RoleInfo {
                    id: id.clone(),
                    name: r.name.clone(),
                    icon: r.icon.clone(),
                    category: r.category.clone(),
                    default_model_tier: primary,
                    model_chain: chain,
                }
            })
            .collect();
        roles.sort_by(|a, b| a.id.cmp(&b.id));
        return Ok(roles);
    }

    // Fallback: use defaults (no chain yet)
    let mut roles: Vec<RoleInfo> = default_role_ids()
        .iter()
        .map(|id| RoleInfo {
            id: id.to_string(),
            name: id.to_string(),
            icon: "💬".to_string(),
            category: "general".to_string(),
            default_model_tier: "standard".into(),
            model_chain: vec![],
        })
        .collect();
    roles.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(roles)
}

/// Start a new discussion
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

/// Send a follow-up message
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

/// Request from frontend to launch a swarm-mode discussion.
///
/// `name` matches `roles.yaml`'s workflow id when set; otherwise
/// defaults to `quick_task`. `topic` is the user's task.
/// `workspace` is an optional override for the swarm persistence root
/// (defaults to the env-var-pinned / cwd workspace).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSwarmRequest {
    pub topic: String,
    #[serde(default = "default_swarm_name")]
    pub name: String,
    #[serde(default)]
    pub workspace: Option<String>,
}

fn default_swarm_name() -> String {
    "quick_task".to_string()
}

/// Start a swarm-mode discussion. Returns the session id immediately;
/// progress is streamed via `chat:swarm_event` (`plan` / `step` /
/// `summary` / `file` / `complete` / `error`).
#[tauri::command]
pub async fn chat_start_swarm(
    app: AppHandle,
    request: StartSwarmRequest,
) -> Result<usize, String> {
    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst);
    let name = request.name.clone();
    let topic = request.topic.clone();
    let workspace = request.workspace.clone();
    // Spawn on the Tauri runtime so the IPC reply goes back fast and
    // streamed `chat:swarm_event`s reach the UI in lock-step.
    let app_for_task = app.clone();
    tokio::spawn(async move {
        match super::swarm::run_swarm(
            &app_for_task,
            &name,
            &topic,
            workspace.as_deref(),
        )
        .await
        {
            Ok(_state) => {
                // `run_swarm` already emits the `complete` event;
                // nothing left to do here.
            }
            Err(e) => {
                app_for_task
                    .emit(
                        "chat:swarm_event",
                        &super::types::SwarmEvent {
                            kind: "error".into(),
                            swarm_id: name,
                            steps: None,
                            turn: None,
                            content: Some(e),
                            path: None,
                            file_kind: None,
                        },
                    )
                    .ok();
            }
        }
    });
    Ok(session_id)
}

/// Cancel a running discussion
#[tauri::command]
pub async fn chat_cancel(session_id: usize) -> Result<(), String> {
    Ok(())
}

/// Start a manager-led interactive workflow. The manager role reads
/// the topic, decides what to do next, and either asks the user
/// (via `chat:need_decision`) or dispatches a worker (via `chat:turn`).
///
/// Returns the new session_id immediately. Progress streams via
/// `chat:turn` for manager / worker bubbles and `chat:need_decision`
/// for the option-button panel.
#[tauri::command]
pub async fn chat_start_manager_session(
    app: AppHandle,
    topic: String,
    #[allow(non_snake_case)]
    workspace: Option<String>,
) -> Result<usize, String> {
    super::manager::start_manager_session(&app, &topic, workspace.as_deref()).await
}
/// Backend advances the state machine from `AwaitingDecision` to
/// `AssigningWorker` / `Finalizing` and emits the resulting turn.
#[tauri::command]
pub async fn chat_user_decision(
    app: AppHandle,
    decision: UserDecision,
) -> Result<(), String> {
    super::manager::submit_user_decision(&app, decision).await
}

/// User pushed the session forward without picking an option, or
/// supplied their own instruction. Forces the manager to re-plan
/// with the user's context note appended.
#[tauri::command]
pub async fn chat_user_continue(
    app: AppHandle,
    session_id: usize,
    message: Option<String>,
) -> Result<(), String> {
    super::manager::submit_user_continue(&app, session_id, message).await
}

/// Snapshot a manager session by id. Returns `null` if the session
/// has never been started in this process (e.g. after a Tauri
/// restart — caller should re-issue `chat_start_manager_session`).
#[tauri::command]
pub async fn chat_get_manager_state(
    session_id: usize,
) -> Result<Option<ManagerSessionState>, String> {
    Ok(super::manager::get_session_state(session_id))
}

/// List all live manager session ids in this process.
#[tauri::command]
pub async fn chat_list_manager_sessions() -> Result<Vec<usize>, String> {
    Ok(super::manager::list_sessions())
}

/// Force-stop a manager session.
#[tauri::command]
pub async fn chat_abort_manager_session(
    session_id: usize,
    reason: String,
) -> Result<(), String> {
    super::manager::abort_session(session_id, &reason)
}

/// Validate a workflow id.
/// Validate a workflow id. Must be a stable identifier usable as a
/// YAML map key and a workflow dropdown value. Keeps users from
/// injecting whitespace or path-traversal characters.
pub(crate) fn validate_workflow_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("工作流 id 不能为空".into());
    }
    if id.len() > 64 {
        return Err("工作流 id 过长（最多 64 字符）".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
    {
        return Err(format!(
            "工作流 id 含有非法字符 `{}`，仅允许字母数字、`-`、`_`、`:`",
            id
        ));
    }
    Ok(())
}

/// Convert a `WorkflowPayload` into the persisted `WorkflowDef`.
///
/// Validation lives here so the UI can surface the same error
/// messages verbatim. Returns `Err` with a Chinese message on bad
/// input; the frontend shows it directly.
pub(crate) fn workflow_payload_to_def(p: &WorkflowPayload) -> Result<WorkflowDef, String> {
    validate_workflow_id(&p.id)?;
    if p.name.trim().is_empty() {
        return Err("工作流名称不能为空".into());
    }
    let kind = match p.kind.as_str() {
        "planned" | "" => WorkflowKind::Planned,
        "swarm" => WorkflowKind::Swarm,
        other => return Err(format!("未知的工作流类型 `{other}`（期望 `planned` 或 `swarm`）")),
    };
    if p.max_rounds == 0 {
        return Err("轮数（max_rounds）必须 ≥ 1".into());
    }
    if p.max_steps == 0 {
        return Err("最大步骤数（max_steps）必须 ≥ 1".into());
    }
    // Validate every step has at least one role.
    let mut steps = Vec::with_capacity(p.steps.len());
    for (i, s) in p.steps.iter().enumerate() {
        if s.roles.is_empty() {
            return Err(format!("第 {} 步「{}」至少需要一个角色", i + 1, s.name));
        }
    }
    for s in &p.steps {
        steps.push(WorkflowStep {
            name: s.name.clone(),
            roles: s.roles.clone(),
        });
    }
    Ok(WorkflowDef {
        name: p.name.trim().to_string(),
        kind,
        roles: p.roles.clone(),
        steps,
        max_rounds: p.max_rounds,
        planner_role: p.planner_role.trim().to_string(),
        worker_roles: p.worker_roles.clone(),
        max_steps: p.max_steps,
    })
}

/// Convert a stored `WorkflowDef` back to the editor-friendly
/// `WorkflowPayload`. Used so the UI gets a populated editor after
/// reload, and as the post-save echo.
pub(crate) fn workflow_def_to_payload(id: &str, w: &WorkflowDef) -> WorkflowPayload {
    WorkflowPayload {
        id: id.to_string(),
        name: w.name.clone(),
        kind: match w.kind {
            WorkflowKind::Planned => "planned".into(),
            WorkflowKind::Swarm => "swarm".into(),
        },
        roles: w.roles.clone(),
        steps: w
            .steps
            .iter()
            .map(|s| WorkflowStepPayload {
                name: s.name.clone(),
                roles: s.roles.clone(),
            })
            .collect(),
        max_rounds: w.max_rounds,
        planner_role: w.planner_role.clone(),
        worker_roles: w.worker_roles.clone(),
        max_steps: w.max_steps,
    }
}

/// Upsert (create or update) one workflow. Returns the updated
/// payload so the frontend can re-render immediately. Triggers a
/// `workflows:changed` event so other panels stay in sync.
#[tauri::command]
pub async fn chat_save_workflow(
    app: AppHandle,
    payload: WorkflowPayload,
) -> Result<WorkflowMutationResult, String> {
    let def = workflow_payload_to_def(&payload)?;
    let id = payload.id.clone();
    super::global_config::write_workflow_file(&id, &def)
        .map_err(|e| format!("写入 workflows/{id}.yaml 失败：{e}"))?;
    let updated = workflow_def_to_payload(&id, &def);
    let _ = app.emit("workflows:changed", &id);
    Ok(WorkflowMutationResult {
        workflow: Some(updated),
        deleted: false,
    })
}

/// Delete a workflow by id. Refuses to remove built-in presets so
/// the user can't lock themselves out of every workflow.
#[tauri::command]
pub async fn chat_delete_workflow(
    app: AppHandle,
    id: String,
) -> Result<WorkflowMutationResult, String> {
    validate_workflow_id(&id)?;
    let protected: &[&str] = &["default", "plan", "code_review", "debug"];
    if protected.contains(&id.as_str()) {
        return Err(format!(
            "工作流 `{id}` 是内置预设，不能删除（可以新建一个同名变体来覆盖）"
        ));
    }
    let removed = super::global_config::delete_workflow_file(&id)
        .map_err(|e| format!("删除 workflows/{id}.yaml 失败：{e}"))?;
    if !removed {
        return Err(format!("未找到工作流 `{id}`"));
    }
    let _ = app.emit("workflows:changed", &id);
    Ok(WorkflowMutationResult {
        workflow: None,
        deleted: true,
    })
}
/// defaults (Chinese-named roles + 5 workflow presets including
/// `quick_task` swarm). Use as the "reset to defaults" button in the
/// workflow editor for users whose existing `roles.yaml` predates
/// the Chinese-name migration — `migrate_roles_config` is
/// non-destructive (it only ADDS missing roles/workflows), so the
/// only way to surface the new Chinese names to existing users is
/// an explicit reset.
#[tauri::command]
pub async fn chat_reset_roles_to_defaults() -> Result<RoleConfigResponse, String> {
    let path = roles_config_path();
    let config = crate::chat_panel::global_config::create_default_roles();
    // Write roles.yaml (roles + default_model only — workflows moved
    // out into per-file storage).
    let mut roles_only = config.clone();
    roles_only.workflows = std::collections::HashMap::new();
    write_roles_config(&path, &roles_only)
        .map_err(|e| format!("写入 roles.yaml 失败：{e}"))?;

    // Write each default workflow as its own file under
    // `~/.latte-code-editor/workflows/<id>.yaml`. Re-running reset
    // overwrites cleanly — no migration noise.
    for (id, wf) in &config.workflows {
        super::global_config::write_workflow_file(id, wf)
            .map_err(|e| format!("写入 workflows/{id}.yaml 失败：{e}"))?;
    }

    let global_config = load_global_models();
    // Re-read workflows from the files we just wrote so the
    // response reflects what's actually on disk.
    let workflows: Vec<WorkflowInfo> = super::global_config::read_all_workflow_files()
        .iter()
        .map(|(id, w)| WorkflowInfo {
            id: id.clone(),
            mode: derive_mode(id, &kind_to_str(w.kind)),
            name: w.name.clone(),
            description: match w.kind {
                super::global_config::WorkflowKind::Swarm => {
                    format!(
                        "🪄 Swarm — planner `{}`，最多 {} 步",
                        if w.planner_role.is_empty() { "manager" } else { w.planner_role.as_str() },
                        w.max_steps
                    )
                }
                super::global_config::WorkflowKind::Planned => {
                    format!("角色：{}", w.roles.join("、"))
                }
            },
            default_roles: w.roles.clone(),
            steps: vec![],
            kind: kind_to_str(w.kind),
            planner_role: w.planner_role.clone(),
            worker_roles: w.worker_roles.clone(),
        })
        .collect();
    let roles: Vec<RoleInfo> = config
        .roles
        .iter()
        .map(|(id, r)| {
            let chain = r.chain();
            let primary = chain
                .first()
                .cloned()
                .unwrap_or_else(|| config.default_model.clone());
            RoleInfo {
                id: id.clone(),
                name: r.name.clone(),
                icon: r.icon.clone(),
                category: r.category.clone(),
                default_model_tier: primary,
                model_chain: chain,
            }
        })
        .collect();
    Ok(RoleConfigResponse {
        default_model: config.default_model,
        roles,
        workflows,
        models_path: global_models_path().to_string_lossy().to_string(),
        roles_path: roles_config_path().to_string_lossy().to_string(),
    })
}
