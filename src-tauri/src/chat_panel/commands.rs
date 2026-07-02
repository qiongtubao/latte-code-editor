use std::sync::atomic::{AtomicUsize, Ordering};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use super::config_loader;
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
    let merged = config_loader::load_merged();
    let models: Vec<ModelInfo> = merged
        .models
        .models
        .iter()
        .map(|m| ModelInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            provider: m.provider.clone(),
            max_tokens: m.max_tokens,
            context_window: m.context_window,
            supports_vision: false,
            supports_thinking: m.supports_thinking,
        })
        .collect();
    Ok(models)
}

/// Get merged role + model configuration through the three-layer loader.
/// No editor-internal config — all data sourced from `latte_agent_core`.
#[tauri::command]
pub async fn chat_get_role_config() -> Result<RoleConfigResponse, String> {
    let merged = config_loader::load_merged();

    let roles: Vec<RoleInfo> = merged
        .roles
        .iter()
        .map(|(id, tmpl)| {
            let primary = tmpl
                .model_chain
                .first()
                .cloned()
                .unwrap_or_else(|| merged.default_model.clone());
            RoleInfo {
                id: id.clone(),
                name: tmpl.name.clone(),
                icon: tmpl.icon.clone(),
                category: tmpl.category.clone(),
                default_model_tier: primary,
                model_chain: tmpl.model_chain.clone(),
            }
        })
        .collect();

    // Workflows: still loaded from project files (WorkflowDef format).
    // Path will be updated in a later step.
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

    let models_path = config_loader::global_models_path()
        .to_string_lossy()
        .to_string();
    let agents_dir = config_loader::project_agents_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".latte/agents.d/".to_string());

    Ok(RoleConfigResponse {
        default_model: merged.default_model,
        roles,
        workflows,
        models_path,
        roles_path: agents_dir,
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


/// Set model for a specific role (legacy single-model path).
/// Delegates to `chat_set_role_model_chain` with a one-element chain.
#[tauri::command]
pub async fn chat_set_role_model(
    role_id: String,
    model_id: String,
) -> Result<(), String> {
    let req = super::types::SetRoleModelChainRequest {
        role_id,
        chain: vec![model_id],
    };
    chat_set_role_model_chain(req).await?;
    Ok(())
}

/// Set the priority-ordered model chain for a specific role.
///
/// Writes to `<cwd>/.latte/agents.d/<role_id>.toml` via `config_loader`.
/// Validates that every model id is present in the merged catalog.
#[tauri::command]
pub async fn chat_set_role_model_chain(
    request: SetRoleModelChainRequest,
) -> Result<Vec<String>, String> {
    if request.chain.is_empty() {
        return Err("model chain must contain at least one model".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let chain: Vec<String> = request
        .chain
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    // Validate against merged catalog
    let merged = config_loader::load_merged();
    let unknown: Vec<&String> = chain
        .iter()
        .filter(|m| !merged.models.models.iter().any(|def| &def.id == *m))
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

    config_loader::write_role_model_chain(&request.role_id, &chain)?;
    Ok(chain)
}
/// Set the global default model.
/// Writes `tiers.standard` to `~/.latte/models.yaml` via `config_loader`.
#[tauri::command]
pub async fn chat_set_default_model(model_id: String) -> Result<(), String> {
    config_loader::write_global_default_model(&model_id)?;
    Ok(())
}

/// Open config file in editor. `config_type` may be:
/// - `"models"` → `~/.latte-code-editor/models.yaml`
/// - `"roles"` → `~/.latte-code-editor/roles.yaml`
/// - `"workflow:<id>"` → `~/.latte-code-editor/workflows/<id>.yaml`
/// - `"role:<id>"` → `~/.latte-code-editor/roles/<id>.yaml`
#[tauri::command]
pub async fn chat_open_config(config_type: String) -> Result<String, String> {
    let path = if let Some(id) = config_type.strip_prefix("workflow:") {
        let id = id.trim();
        if id.is_empty() {
            return Err("workflow:<id> 需要 id".to_string());
        }
        let dir = super::global_config::workflows_dir();
        // Don't create the file — just return the path so the editor
        // opens an existing one (or shows "not found" if absent).
        dir.join(format!("{}.yaml", super::global_config::sanitize_workflow_id(id)))
    } else if let Some(id) = config_type.strip_prefix("role:") {
        let id = id.trim();
        if id.is_empty() {
            return Err("role:<id> 需要 id".to_string());
        }
        let dir = super::global_config::roles_dir();
        dir.join(format!("{}.yaml", super::global_config::sanitize_role_id(id)))
    } else {
        match config_type.as_str() {
            "models" => super::global_config::global_models_path(),
            "roles" => super::global_config::roles_config_path(),
            _ => return Err(format!("Unknown config type: {}", config_type)),
        }
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
/// option-button panel.
#[tauri::command]
pub async fn chat_start_manager_session(
    app: AppHandle,
    topic: String,
    workflowId: Option<String>,
    #[allow(non_snake_case)]
    workspace: Option<String>,
) -> Result<usize, String> {
    super::manager::start_manager_session(
        &app,
        &topic,
        workflowId.as_deref(),
        workspace.as_deref(),
    )
    .await
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
        manager_role: p.manager_role.trim().to_string(),
        initial_workers: p.initial_workers.clone(),
        max_total_steps: p.max_total_steps,
        max_user_decisions: p.max_user_decisions,
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
        manager_role: w.manager_role.clone(),
        initial_workers: w.initial_workers.clone(),
        max_total_steps: w.max_total_steps,
        max_user_decisions: w.max_user_decisions,
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

// ─── HIL (Human-In-Loop) Blackboard session ─────────────────────
//
// Tauri commands for the editable, pausable chat session described
// in `latte-rs-agents` HIL v1. Each command is a thin wrapper that
// delegates to `super::hil::*`; the wrapper only handles Tauri
// parameter naming (`taskId` / `roleId` in camelCase from the
// frontend) and converts Result<_, String> for IPC.

/// Start a new HIL session — creates the worktree, writes
/// `plan.md`, instantiates a `SessionManager`, returns the initial
/// snapshot.
#[tauri::command]
pub async fn chat_hil_start(
    app: AppHandle,
    request: HilStartRequest,
) -> Result<HilSessionState, String> {
    super::hil::start_session(&app, request)
}

/// Append a message to a role's history. The "send" path.
#[tauri::command]
pub async fn chat_hil_send(
    app: AppHandle,
    request: HilSendRequest,
) -> Result<HilSessionState, String> {
    super::hil::send_message(&app, request)
}

/// Edit or delete a single message in a role's history. The
/// "可修改聊天内容继续" affordance — the user can fix any message
/// while the session is paused, then press 继续.
#[tauri::command]
pub async fn chat_hil_edit_message(
    app: AppHandle,
    request: HilEditRequest,
) -> Result<HilSessionState, String> {
    super::hil::edit_message(&app, request)
}

/// Inject a message into a role's history from outside the REPL.
/// Equivalent to `latte-agent inject --task-id X --role Y --message M`.
#[tauri::command]
pub async fn chat_hil_inject(
    app: AppHandle,
    request: HilInjectRequest,
) -> Result<HilSessionState, String> {
    super::hil::inject_message(&app, request)
}

/// Resume + send in one call. Empty content just resumes.
#[tauri::command]
pub async fn chat_hil_continue(
    app: AppHandle,
    request: HilContinueRequest,
) -> Result<HilSessionState, String> {
    super::hil::continue_session(&app, request)
}

/// Pause / resume / abort in one command. `request.action` is
/// `"pause" | "resume" | "abort"`.
#[tauri::command]
pub async fn chat_hil_transition(
    app: AppHandle,
    request: HilTransitionRequest,
) -> Result<HilSessionState, String> {
    super::hil::transition(&app, request)
}

/// Fetch a session's full state. `null` if no JSON exists.
#[tauri::command]
pub async fn chat_hil_get_state(
    app: AppHandle,
    task_id: String,
    cwd: Option<String>,
) -> Result<Option<HilSessionState>, String> {
    super::hil::get_state(&app, &task_id, cwd.as_deref())
}

/// List all on-disk HIL sessions. Used to populate the "open
/// existing" dropdown.
#[tauri::command]
pub async fn chat_hil_list_sessions(
    cwd: Option<String>,
) -> Result<Vec<super::hil::HilSessionSummary>, String> {
    super::hil::list_sessions(cwd.as_deref())
}

// ─── ChatController commands ────────────────────────────────────
//
// Event-driven chat session controller. The frontend spawns a
// controller, then sends input / pause / resume / abort via these
// commands. Events flow back through `chat:controller_event`.

/// Spawn a new ChatController session (persisted to SessionStore).
/// Detects the chat type based on request fields:
/// - `task_id` is set → "hil"
/// - `roles.len() > 1` → "multi_role"
/// - otherwise → "single"
#[tauri::command]
pub async fn chat_controller_spawn(
    app: tauri::AppHandle,
    request: super::types::ControllerSpawnRequest,
) -> Result<(), String> {
    use latte_agent_core::config::AgentConfig;
    use latte_agent_core::controller::ControllerConfig;
    use latte_agent_core::model_resolver::{ModelResolver, ModelTier};
    use latte_agent_core::global_config::GlobalConfig;
    use latte_ai::params::GenerateParams;
    use std::sync::Arc;

    // Resolve the working directory.
    let cwd = request.cwd.clone().unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    // Use the same config_loader as chat_stream so models.yaml API keys
    // are properly merged (including global tiers and credentials).
    let merged = super::config_loader::load_merged();

    // Build an AgentConfig from the merged data.
    let mut config = AgentConfig {
        models: merged.models,
        roles: merged.roles,
    };
    let global = GlobalConfig::load_default().unwrap_or_default();
    let global_ids: Vec<String> = global.models.iter().map(|m| m.id.clone()).collect();
    for tmpl in config.roles.values_mut() {
        for id in &global_ids {
            if !tmpl.model_chain.contains(id) {
                tmpl.model_chain.push(id.clone());
            }
        }
    }

    let resolver = ModelResolver::from_config(&config)
        .map_err(|e| format!("resolver: {e}"))?;

    let initial_tier = request
        .initial_tier
        .as_deref()
        .and_then(|s| ModelTier::parse(s).ok());
    let primary_model_id = request.primary_model_id.clone();

    // Detect chat type.
    let chat_type = if request.task_id.is_some() {
        "hil"
    } else if request.roles.len() > 1 {
        "multi_role"
    } else {
        "single"
    };

    let controller_config = ControllerConfig {
        task_id: request.task_id.clone(),
        roles: if request.roles.is_empty() {
            vec!["manager".to_string()]
        } else {
            request.roles.clone()
        },
        initial_prompt: request.initial_prompt.clone(),
        max_rounds: request.max_rounds,
        session_token_budget: request.session_token_budget,
        agent_config: Arc::new(config),
        model_resolver: Arc::new(resolver),
        default_params: GenerateParams::default(),
        primary_model_id,
        initial_tier,
        cwd,
    };

    // Use persistent session spawn.
    super::session_controller::spawn_persistent(
        &app,
        &request.session_id,
        chat_type,
        controller_config.roles.clone(),
        controller_config,
    )
    .await
}

// ─── Session management commands ─────────────────────────────────

/// List all persisted chat sessions.
#[tauri::command]
pub async fn chat_session_list() -> Result<Vec<latte_agent_core::session_store::SessionSummary>, String> {
    super::session_controller::list_sessions().await
}

/// Get a single session by id (includes full message list).
#[tauri::command]
pub async fn chat_session_get(
    session_id: String,
) -> Result<latte_agent_core::session_store::StoredSession, String> {
    super::session_controller::get_session(&session_id).await
}

/// Delete a session by id.
#[tauri::command]
pub async fn chat_session_delete(
    session_id: String,
) -> Result<(), String> {
    super::session_controller::delete_session(&session_id).await
}

/// Edit a message in a session's history.
#[tauri::command]
pub async fn chat_session_edit_message(
    session_id: String,
    index: usize,
    new_content: String,
) -> Result<(), String> {
    super::session_controller::edit_message(&session_id, index, &new_content).await
}

/// Submit user text to an active controller session.
#[tauri::command]
pub async fn chat_controller_submit(
    session_id: String,
    text: String,
) -> Result<(), String> {
    super::controller_adapter::submit_to_controller(&session_id, &text).await
}

/// Pause an active controller session.
#[tauri::command]
pub async fn chat_controller_pause(
    session_id: String,
) -> Result<(), String> {
    super::controller_adapter::pause_controller(&session_id).await
}

/// Resume a paused controller session.
#[tauri::command]
pub async fn chat_controller_resume(
    session_id: String,
) -> Result<(), String> {
    super::controller_adapter::resume_controller(&session_id).await
}

/// Abort an active controller session.
#[tauri::command]
pub async fn chat_controller_abort(
    session_id: String,
) -> Result<(), String> {
    super::controller_adapter::abort_controller(&session_id).await
}
