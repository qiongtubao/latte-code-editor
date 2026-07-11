//! Global configuration for latte-code-editor chat panel.
//!
//! Supports ~/.latte/models.yaml in latte-tune array format

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

/// Model definition in latte-tune array format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub api: String,
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    pub api_key: String,
    #[serde(default = "default_context_window")]
    pub context_window: u32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub cost_per_million_input: f64,
    #[serde(default)]
    pub cost_per_million_output: f64,
    /// Tier hint (`"budget"` / `"standard"` / `"premium"`) for the
    /// upstream `ModelResolver`. Mirrors
    /// `latte-rs-agents::config::ModelDef::tier`. When the role
    /// has no explicit `model_chain`, the resolver uses this to
    /// pick the primary model (e.g. programmer + budget → a
    /// budget-tier model). Ignored when `model_chain` is non-empty
    /// (chain head wins for back-compat).
    #[serde(default)]
    pub tier: Option<String>,
}

/// Role definition
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RoleDef {
    pub name: String,
    pub icon: String,
    #[serde(default)]
    pub category: String,
    /// Tier hint for primary model resolution (`"budget"` /
    /// `"standard"` / `"premium"`). The project currently uses the
    /// chain head as primary regardless of tier, but the field is
    /// stored + forwarded to upstream `Role.default_model_tier` so
    /// `ModelResolver` and downstream consumers see the same value
    /// the upstream `agents.toml` would carry.
    #[serde(default = "default_model_tier")]
    pub model_tier: String,
    /// Single-model override (back-compat). If `model_chain` is empty,
    /// this single id is treated as the entire chain.
    #[serde(default)]
    pub model: Option<String>,
    /// Priority-ordered model chain (highest priority first).
    /// The first entry is the primary; the rest are fallbacks tried
    /// in order when earlier models fail (rate-limit, 5xx, network).
    /// Mirrors `latte-rs-agents::role::Role::model_chain`.
    #[serde(default)]
    pub model_chain: Vec<String>,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default)]
    pub tools: Vec<String>,
    /// Optional path to a markdown prompt file (relative to
    /// `roles.yaml` directory or absolute). When set, takes
    /// precedence over the inline `prompt` field. Mirrors
    /// `latte-rs-agents::role::RoleTemplate::prompt_file`.
    #[serde(default)]
    pub prompt_file: String,
    /// Inline system prompt. Used when `prompt_file` is empty.
    pub prompt: String,
}

impl RoleDef {
    /// Resolve the effective priority-ordered model chain for this role.
    ///
    /// Source order:
    /// 1. Explicit `model_chain` if non-empty
    /// 2. Legacy single `model` field wrapped into a one-element chain
    /// 3. Empty chain — caller should fall back to the global default
    pub fn chain(&self) -> Vec<String> {
        if !self.model_chain.is_empty() {
            return self.model_chain.clone();
        }
        self.model.clone().map(|m| vec![m]).unwrap_or_default()
    }

    /// Write the chain, clearing the legacy `model` field so the
    /// serialized form is unambiguous.
    pub fn set_chain(&mut self, chain: Vec<String>) {
        self.model_chain = chain;
        self.model = None;
    }
}

/// Workflow preset
///
/// Two kinds:
/// - `planned` (default): the classic sequential-discussion flow where
///   every role in `roles` speaks in order, `max_rounds` times. Same
///   shape the chat panel has always had.
/// - `swarm`: planner-driven. A single `planner_role` (default
///   `manager`) breaks the topic into a small list of worker tasks,
///   each executed by a role from `worker_roles`, then a final
///   synthesis step writes a summary. Use this for open-ended tasks
///   where the steps aren't known up front — modeled after
///   oh-my-pi's `swarm-extension`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkflowDef {
    pub name: String,
    /// `planned` (sequential, role-by-role rounds) or `swarm`
    /// (planner-driven dynamic step generation).
    #[serde(default = "default_workflow_kind")]
    pub kind: WorkflowKind,
    /// Roles that participate in a `planned` workflow. Kept as the
    /// canonical flat list when `steps` is empty; the runner treats
    /// `roles` as a one-step-per-role pipeline.
    #[serde(default)]
    pub roles: Vec<String>,
    /// Ordered per-step definition. Each step may name one or more
    /// roles (v1 runs them sequentially; the schema already supports
    /// parallel speakers for the future). When non-empty this takes
    /// precedence over `roles`.
    #[serde(default)]
    pub steps: Vec<WorkflowStep>,
    /// Maximum number of rounds for `planned`; ignored for `swarm`.
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
    /// Role that plans + synthesizes the swarm. Defaults to `manager`.
    #[serde(default)]
    pub planner_role: String,
    /// Roles the swarm may pick as workers. If empty, all roles are
    /// eligible.
    #[serde(default)]
    pub worker_roles: Vec<String>,
    /// Cap on worker steps the planner may emit per task.
    #[serde(default = "default_max_steps")]
    pub max_steps: usize,

    // ── Manager-led fields (only used when `kind == ManagerLed`) ──
    /// Role id that drives the manager-led workflow. Defaults to
    /// `"manager"` when empty. The runner uses this role's prompt
    /// template + chain to call the manager LLM (or stub).
    #[serde(default)]
    pub manager_role: String,
    /// Roles the manager may pick as workers — the strict candidate
    /// pool. When empty, falls back to all roles.
    #[serde(default)]
    pub initial_workers: Vec<String>,
    /// Hard cap on total manager turns (questions + worker runs).
    #[serde(default = "default_max_total_steps")]
    pub max_total_steps: u32,
    /// Legacy manager-led cap on how many user decision rounds are allowed.
    #[serde(default = "default_max_user_decisions")]
    pub max_user_decisions: u32,
}

/// One step in a multi-role workflow.
///
/// Multiple `roles` per step are allowed so a future runner can do
/// parallel "round-table" steps; the v1 runner speaks them in order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkflowStep {
    /// Human-readable label shown in the editor (`"设计阶段"` etc.).
    pub name: String,
    /// Role ids that speak in this step, in order.
    pub roles: Vec<String>,
}

impl Default for WorkflowStep {
    fn default() -> Self {
        Self {
            name: String::new(),
            roles: Vec::new(),
        }
    }
}

/// `planned` — original sequential-discussion workflow (default).
/// `swarm` — planner-driven dynamic step generation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowKind {
    Planned,
    Swarm,
}

fn default_workflow_kind() -> WorkflowKind {
    WorkflowKind::Planned
}
fn default_max_steps() -> usize {
    5
}
fn default_max_total_steps() -> u32 {
    8
}
fn default_max_user_decisions() -> u32 {
    5
}

impl Default for WorkflowDef {
    fn default() -> Self {
        Self {
            name: String::new(),
            kind: WorkflowKind::Planned,
            roles: Vec::new(),
            steps: Vec::new(),
            max_rounds: 1,
            planner_role: String::new(),
            worker_roles: Vec::new(),
            max_steps: default_max_steps(),
            manager_role: String::new(),
            initial_workers: Vec::new(),
            max_total_steps: default_max_total_steps(),
            max_user_decisions: default_max_user_decisions(),
        }
    }
}

/// Global models config
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GlobalModelConfig {
    #[serde(default)]
    pub models: Vec<ModelDef>,
    #[serde(default = "default_model")]
    pub default_model: String,
}

/// Roles config
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RoleConfig {
    #[serde(default = "default_model")]
    pub default_model: String,
    #[serde(default)]
    pub roles: HashMap<String, RoleDef>,
    #[serde(default)]
    pub workflows: HashMap<String, WorkflowDef>,
}

fn default_model() -> String { "deepseek-chat".into() }
fn default_max_tokens() -> u32 { 8192 }
fn default_context_window() -> u32 { 32768 }
fn default_temperature() -> f64 { 0.5 }
fn default_model_tier() -> String { "standard".into() }
fn default_max_rounds() -> usize { 1 }

impl GlobalModelConfig {
    pub fn first_model(&self) -> Option<&ModelDef> {
        self.models.first()
    }

    pub fn has_api_key(&self) -> bool {
        self.models.iter().any(|m| {
            let expanded = expand_env_vars(&m.api_key);
            !expanded.starts_with("${") && !expanded.is_empty()
        })
    }

    pub fn get_api_key(&self, provider: &str) -> Option<String> {
        self.models
            .iter()
            .find(|m| m.provider == provider)
            .map(|m| expand_env_vars(&m.api_key))
            .filter(|k| !k.starts_with("${"))
    }
}

/// Convert the upstream `latte_agent_core::config::ModelDef` to the
/// crate's `ModelDef`. Differences:
/// - upstream has `supports_thinking`, crate has `reasoning` (rename)
/// - upstream has `Option<f64>` costs, crate has `f64` (None → 0.0)
fn convert_def_to_project(upstream: &latte_agent_core::config::ModelDef) -> ModelDef {
    ModelDef {
        id: upstream.id.clone(),
        name: upstream.name.clone(),
        api: upstream.api.clone(),
        provider: upstream.provider.clone(),
        base_url: upstream.base_url.clone(),
        api_key: upstream.api_key.clone(),
        context_window: upstream.context_window,
        max_tokens: upstream.max_tokens,
        reasoning: upstream.supports_thinking,
        cost_per_million_input: upstream.cost_per_million_input.unwrap_or(0.0),
        cost_per_million_output: upstream.cost_per_million_output.unwrap_or(0.0),
        tier: upstream.tier.clone(),
    }
}

/// Convert an upstream `RoleTemplate` to the crate's `RoleDef`.
/// The upstream template has no inline `prompt` field — the prompt is
/// resolved from the prompt file or upstream built-in, so we leave it
/// empty (`""`). Callers that need the actual prompt go through
/// `latte_agent_core::prompts::for_role(id)`.
fn convert_role_template_to_def(tmpl: &latte_agent_core::role::RoleTemplate) -> RoleDef {
    let temperature = tmpl.temperature.unwrap_or(0.5);
    let prompt_file = tmpl.prompt_file.clone().unwrap_or_default();
    RoleDef {
        name: tmpl.name.clone(),
        icon: tmpl.icon.clone(),
        category: tmpl.category.clone(),
        model_tier: tmpl.model_tier.clone(),
        model: tmpl.model_chain.first().cloned().or_else(|| Some("deepseek-chat".into())),
        model_chain: tmpl.model_chain.clone(),
        temperature,
        tools: tmpl.tools.clone(),
        prompt_file,
        prompt: String::new(),
    }
}

/// Get models.yaml path
pub fn global_models_path() -> PathBuf {
    if let Ok(p) = env::var("LATTE_MODELS_PATH") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".latte")
        .join("models.yaml")
}

/// Get roles.yaml path
pub fn roles_config_path() -> PathBuf {
    if let Ok(p) = env::var("LATTE_ROLES_PATH") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".latte-code-editor")
        .join("roles.yaml")
}

/// Get the directory that holds per-workflow `.yaml` files.
///
/// Defaults to `~/.latte-code-editor/workflows/`. Can be overridden
/// via `LATTE_WORKFLOWS_DIR` for testing. The dir is created on
/// first read if missing.
pub fn workflows_dir() -> PathBuf {
    if let Ok(p) = env::var("LATTE_WORKFLOWS_DIR") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".latte-code-editor")
        .join("workflows")
}

/// Read a single workflow file by id (`workflows/<id>.yaml`).
/// Returns `Ok(None)` if the file doesn't exist (caller should fall
/// back to a default workflow). Files that fail to parse are
/// logged + treated as missing.
pub fn read_workflow_file(id: &str) -> Result<Option<WorkflowDef>, String> {
    let path = workflows_dir().join(format!("{}.yaml", sanitize_workflow_id(id)));
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_yaml::from_str::<WorkflowDef>(&raw)
        .map(Some)
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Write a workflow file (`workflows/<id>.yaml`). Creates the dir
/// if missing.
pub fn write_workflow_file(id: &str, def: &WorkflowDef) -> std::io::Result<()> {
    let dir = workflows_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.yaml", sanitize_workflow_id(id)));
    let yaml = serde_yaml::to_string(def).unwrap_or_default();
    std::fs::write(path, yaml)
}

/// Delete a workflow file. Returns `true` if the file existed and
/// was removed, `false` if it wasn't there.
pub fn delete_workflow_file(id: &str) -> std::io::Result<bool> {
    let path = workflows_dir().join(format!("{}.yaml", sanitize_workflow_id(id)));
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path)?;
    Ok(true)
}

/// Read every workflow file under `workflows_dir()`. Returns a
/// sorted map (id → def). Files that fail to parse are skipped
/// with a stderr warning — we don't want a single bad workflow to
/// lock the user out of every workflow.
pub fn read_all_workflow_files() -> HashMap<String, WorkflowDef> {
    let dir = workflows_dir();
    let mut out: HashMap<String, WorkflowDef> = HashMap::new();
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.extension().and_then(|s| s.to_str()) != Some("yaml") {
            continue;
        }
        match serde_yaml::from_str::<WorkflowDef>(&fs::read_to_string(&path).unwrap_or_default()) {
            Ok(def) => {
                out.insert(stem.to_string(), def);
            }
            Err(e) => {
                eprintln!(
                    "[chat] failed to parse workflow file {:?}: {e}",
                    path
                );
            }
        }
    }
    out
}

// ─── Per-role file storage ──────────────────────────────────────
//
// Each role lives in its own file under
// `~/.latte-code-editor/roles/<id>.yaml` so users can open a role's
// config from the settings panel without scrolling through a
// monolithic roles.yaml. Workflow files (under `workflows/`) already
// follow this pattern; the same conventions apply here — one file
// per role, auto-migrated from roles.yaml on first load, and fully
// owned by the user once on disk.

/// Directory holding per-role YAML files (`<id>.yaml`). Override
/// with `LATTE_ROLES_DIR` for tests.
pub fn roles_dir() -> PathBuf {
    if let Ok(p) = env::var("LATTE_ROLES_DIR") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".latte-code-editor")
        .join("roles")
}

/// Sanitize a role id for use as a filename. Mirrors
/// `sanitize_workflow_id`.
pub(crate) fn sanitize_role_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Read a single role file by id (`roles/<id>.yaml`). Returns
/// `Ok(None)` when the file is missing — caller should fall back to
/// the inline `roles.yaml` entry. Files that fail to parse are
/// surfaced as `Err`.
pub fn read_role_file(id: &str) -> Result<Option<RoleDef>, String> {
    let path = roles_dir().join(format!("{}.yaml", sanitize_role_id(id)));
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_yaml::from_str::<RoleDef>(&raw)
        .map(Some)
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Write a role file (`roles/<id>.yaml`). Creates the parent dir
/// if missing.
pub fn write_role_file(id: &str, def: &RoleDef) -> std::io::Result<()> {
    let dir = roles_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.yaml", sanitize_role_id(id)));
    let yaml = serde_yaml::to_string(def).unwrap_or_default();
    std::fs::write(path, yaml)
}

/// Delete a role file. Returns `true` if the file existed.
pub fn delete_role_file(id: &str) -> std::io::Result<bool> {
    let path = roles_dir().join(format!("{}.yaml", sanitize_role_id(id)));
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path)?;
    Ok(true)
}

/// Read every role file under `roles_dir()`. Returns a map
/// (id → def). Files that fail to parse are skipped with a stderr
/// warning — a single bad role file must not lock the user out.
pub fn read_all_role_files() -> HashMap<String, RoleDef> {
    let dir = roles_dir();
    let mut out: HashMap<String, RoleDef> = HashMap::new();
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[chat] skip role file {}: {e}", path.display());
                continue;
            }
        };
        match serde_yaml::from_str::<RoleDef>(&raw) {
            Ok(def) => {
                if let Some(id) = path.file_stem().and_then(|s| s.to_str()) {
                    out.insert(id.to_string(), def);
                }
            }
            Err(e) => {
                eprintln!(
                    "[chat] skip malformed role file {}: {e}",
                    path.display()
                );
            }
        }
    }
    out
}

/// Sanitize a workflow id for use as a filename. Mirrors the
/// `validate_workflow_id` rules in commands.rs — only
pub(crate) fn sanitize_workflow_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Load models config from merged layers (config_loader).
/// Returns GlobalModelConfig for back-compat with session.rs.
pub fn load_global_models() -> GlobalModelConfig {
    let merged = crate::chat_panel::config_loader::load_merged();
    GlobalModelConfig {
        models: merged.models.models.iter().map(convert_def_to_project).collect(),
        default_model: merged.default_model.clone(),
    }
}

/// Load roles config from merged layers (config_loader).
/// Returns RoleConfig for back-compat with session.rs and commands.rs.
///
/// When `LATTE_ROLES_PATH` is set (test environment), reads from
/// that legacy path instead of config_loader, then migrates inline
/// workflows into `workflows/<id>.yaml` files (test compat path).
pub fn load_roles_config() -> RoleConfig {
    // Test compat: when LATTE_ROLES_PATH is set, read from that path
    // using the legacy migration path so existing tests pass.
    if let Ok(legacy_path) = std::env::var("LATTE_ROLES_PATH") {
        let path = std::path::PathBuf::from(&legacy_path);
        if path.exists() {
            let raw = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => return load_from_merged(),
            };
            if let Ok(config) = serde_yaml::from_str::<RoleConfig>(&raw) {
                return migrate_inline_workflows_with_dir_override(config, &path);
            }
        }
    }
    load_from_merged()
}

/// Like `migrate_inline_workflows` but also applies file-based role
/// overrides from `LATTE_ROLES_DIR` (test compat).
fn migrate_inline_workflows_with_dir_override(
    mut config: RoleConfig,
    roles_path: &std::path::Path,
) -> RoleConfig {
    // First: migrate inline workflows to per-file layout.
    if !config.workflows.is_empty() {
        let wf_dir = workflows_dir();
        std::fs::create_dir_all(&wf_dir).ok();
        for (id, wf) in &config.workflows {
            let target = wf_dir.join(format!("{}.yaml", sanitize_workflow_id(id)));
            if !target.exists() {
                std::fs::write(
                    &target,
                    serde_yaml::to_string(wf).unwrap_or_default(),
                )
                .ok();
            }
        }
        config.workflows.clear();
        write_roles_config(roles_path, &config).ok();
    }
    // Second: apply per-file role overrides from LATTE_ROLES_DIR.
    if let Ok(dir_str) = std::env::var("LATTE_ROLES_DIR") {
        let dir = std::path::PathBuf::from(&dir_str);
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
                        continue;
                    }
                    if let Ok(raw) = std::fs::read_to_string(&path) {
                        if let Ok(file_def) = serde_yaml::from_str::<RoleDef>(&raw) {
                            if let Some(id) = path.file_stem().and_then(|s| s.to_str()) {
                                config.roles.insert(id.to_string(), file_def);
                            }
                        }
                    }
                }
            }
        }
    }
    config
}

/// Built-in default workflows used when no per-file workflows exist
/// (fresh install or test environment). Same as the old hardcoded
/// defaults — now re-usable by both `load_from_merged` and tests.
fn builtin_workflows() -> HashMap<String, WorkflowDef> {
    let mut wf = HashMap::new();
    wf.insert("default".into(), WorkflowDef {
        name: "💬 默认 — 全员讨论".into(),
        kind: WorkflowKind::Planned,
        roles: vec!["pm".into(), "architect".into(), "programmer".into(), "tester".into(), "reviewer".into(), "devops".into(), "manager".into()],
        max_rounds: 3,
        steps: vec![
            WorkflowStep { name: "需求澄清".into(), roles: vec!["pm".into()] },
            WorkflowStep { name: "方案与架构".into(), roles: vec!["architect".into()] },
            WorkflowStep { name: "实现".into(), roles: vec!["programmer".into()] },
            WorkflowStep { name: "测试与回归".into(), roles: vec!["tester".into(), "reviewer".into()] },
            WorkflowStep { name: "发布与运维".into(), roles: vec!["devops".into()] },
        ],
        ..Default::default()
    });
    wf.insert("plan".into(), WorkflowDef {
        name: "🗺️ 规划 — 设计与架构".into(),
        kind: WorkflowKind::Planned,
        roles: vec!["pm".into(), "architect".into(), "designer".into()],
        max_rounds: 2,
        steps: vec![
            WorkflowStep { name: "需求与目标".into(), roles: vec!["pm".into()] },
            WorkflowStep { name: "架构方案".into(), roles: vec!["architect".into()] },
            WorkflowStep { name: "UX 流程".into(), roles: vec!["designer".into()] },
        ],
        ..Default::default()
    });
    wf.insert("code_review".into(), WorkflowDef {
        name: "🔍 代码审查".into(),
        kind: WorkflowKind::Planned,
        roles: vec!["reviewer".into(), "programmer".into()],
        max_rounds: 1,
        steps: vec![
            WorkflowStep { name: "审查发现".into(), roles: vec!["reviewer".into()] },
            WorkflowStep { name: "作者回应".into(), roles: vec!["programmer".into()] },
        ],
        ..Default::default()
    });
    wf.insert("debug".into(), WorkflowDef {
        name: "🪲 排查与修复".into(),
        kind: WorkflowKind::Planned,
        roles: vec!["tester".into(), "programmer".into(), "devops".into()],
        max_rounds: 1,
        steps: vec![
            WorkflowStep { name: "复现与定位".into(), roles: vec!["tester".into()] },
            WorkflowStep { name: "修复方案".into(), roles: vec!["programmer".into()] },
            WorkflowStep { name: "回归与上线".into(), roles: vec!["devops".into()] },
        ],
        ..Default::default()
    });
    wf.insert("quick_task".into(), WorkflowDef {
        name: "🪄 快速任务 — 智能多角色".into(),
        kind: WorkflowKind::Swarm,
        worker_roles: vec!["pm".into(), "architect".into(), "programmer".into(), "reviewer".into(), "tester".into(), "tech_writer".into()],
        max_steps: 4,
        ..Default::default()
    });
    wf.insert("manager_default".into(), WorkflowDef {
        name: "🧭 通用 — Manager 主导".into(),
        kind: WorkflowKind::Planned,
        manager_role: "tech_director".into(),
        initial_workers: vec!["pm".into(), "architect".into(), "programmer".into(), "tester".into(), "reviewer".into(), "devops".into(), "security".into(), "designer".into(), "tech_writer".into()],
        ..Default::default()
    });
    wf
}

fn load_from_merged() -> RoleConfig {
    let merged = crate::chat_panel::config_loader::load_merged();
    let roles: HashMap<String, RoleDef> = merged
        .roles
        .iter()
        .map(|(id, tmpl)| {
            let mut def = convert_role_template_to_def(tmpl);
            // Apply Chinese-friendly names when no user config overrides
            // are present (built-in fallback names are English).
            if def.name == "Product Manager" { def.name = "产品经理".into(); }
            else if def.name == "System Architect" || def.name == "Architect" { def.name = "系统架构师".into(); }
            else if def.name == "Software Engineer" || def.name == "Programmer" { def.name = "软件工程师".into(); }
            else if def.name == "QA Engineer" || def.name == "Tester" { def.name = "测试工程师".into(); }
            else if def.name == "Code Reviewer" || def.name == "Reviewer" { def.name = "代码审查员".into(); }
            else if def.name == "DevOps" || def.name == "DevOps Engineer" { def.name = "运维工程师".into(); }
            else if def.name == "Security" || def.name == "Security Auditor" { def.name = "安全审计员".into(); }
            else if def.name == "Designer" || def.name == "UI/UX Designer" { def.name = "UI/UX 设计师".into(); }
            else if def.name == "Tech Writer" || def.name == "Technical Writer" { def.name = "技术写作".into(); }
            else if def.name == "Engineering Manager" || def.name == "Manager" { def.name = "工程经理".into(); }
            (id.clone(), def)
        })
        .collect();
    let workflows = {
        let disk = read_all_workflow_files();
        if disk.is_empty() { builtin_workflows() } else { disk }
    };
    // Fall back to built-in defaults when no per-file workflows exist
    // (fresh install or test environment). The migration path in
    // `load_roles_config` will write these to disk on first load.
    let workflows = if workflows.is_empty() { builtin_workflows() } else { workflows };
    RoleConfig {
        default_model: merged.default_model,
        roles,
        workflows,
    }
}


pub fn write_roles_config(path: &std::path::Path, config: &RoleConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_yaml::to_string(config).unwrap_or_default())?;
    Ok(())
}


/// Expand env vars in ${VAR} format
pub fn expand_env_vars(s: &str) -> String {
    let mut result = s.to_string();
    let re = regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}").unwrap();

    for cap in re.captures_iter(s) {
        let full = cap.get(0).unwrap().as_str();
        let var_name = cap.get(1).unwrap().as_str();

        if let Ok(value) = env::var(var_name) {
            result = result.replace(full, &value);
        }
    }
    result
}

pub fn create_default_roles() -> RoleConfig {
    load_from_merged()
}
