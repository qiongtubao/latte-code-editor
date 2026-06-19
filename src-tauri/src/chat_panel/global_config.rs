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

/// Load models config
pub fn load_global_models() -> GlobalModelConfig {
    let path = global_models_path();

    if !path.exists() {
        let config = create_default_models();
        write_models_config(&path, &config);
        return config;
    }

    let mut config: GlobalModelConfig = match fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str(&content).unwrap_or_else(|e| {
            eprintln!("[chat] Failed to parse {:?}: {}. Using defaults.", path, e);
            create_default_models()
        }),
        Err(e) => {
            eprintln!("[chat] Failed to read {:?}: {}. Using defaults.", path, e);
            create_default_models()
        }
    };

    // Forward-migrate: add default tier placeholders the user's
    // catalog is missing (gpt-4o-mini / claude-sonnet-4 / claude-opus-4).
    // Non-destructive — the user's own models are preserved; only
    // missing placeholder entries are added so `model_tier` routing
    // actually has something to pick from.
    if migrate_models_config(&mut config) {
        eprintln!(
            "[chat] models.yaml updated with new tier placeholders at {:?}",
            path
        );
        write_models_config(&path, &config);
    }

    config
}

/// Add any default model the user's catalog is missing by id.
/// Returns `true` if anything was added.
fn migrate_models_config(config: &mut GlobalModelConfig) -> bool {
    let defaults = create_default_models();
    let mut changed = false;
    for default_model in defaults.models {
        if !config.models.iter().any(|m| m.id == default_model.id) {
            config.models.push(default_model);
            changed = true;
        }
    }
    changed
}

fn write_models_config(path: &std::path::Path, config: &GlobalModelConfig) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, serde_yaml::to_string(config).unwrap_or_default());
}

/// Load roles config
pub fn load_roles_config() -> RoleConfig {
    let path = roles_config_path();
    if !path.exists() {
        let config = create_default_roles();
        let _ = write_roles_config(&path, &config);
        return config;
    }

    let mut config: RoleConfig = match fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str(&content).unwrap_or_else(|e| {
            eprintln!("[chat] Failed to parse {:?}: {}. Using defaults.", path, e);
            create_default_roles()
        }),
        Err(e) => {
            eprintln!("[chat] Failed to read {:?}: {}. Using defaults.", path, e);
            create_default_roles()
        }
    };

    if migrate_roles_config(&mut config) {
        eprintln!(
            "[chat] roles.yaml updated with new defaults (multi-role + workflows) at {:?}",
            path
        );
        let _ = write_roles_config(&path, &config);
    }

    config
}

pub fn write_roles_config(path: &std::path::Path, config: &RoleConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_yaml::to_string(config).unwrap_or_default())?;
    Ok(())
}

fn migrate_roles_config(config: &mut RoleConfig) -> bool {
    let defaults = create_default_roles();
    let mut changed = false;

    for (id, default_role) in defaults.roles {
        if !config.roles.contains_key(&id) {
            config.roles.insert(id, default_role);
            changed = true;
        }
    }

    for (id, default_wf) in defaults.workflows {
        if !config.workflows.contains_key(&id) {
            config.workflows.insert(id, default_wf);
            changed = true;
        }
    }

    changed
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

fn create_default_models() -> GlobalModelConfig {
    GlobalModelConfig {
        models: vec![
            // ─── Real model (works out of the box if DEEPSEEK_API_KEY is set) ───
            ModelDef {
                id: "deepseek-chat".into(),
                name: "DeepSeek Chat V3".into(),
                api: "openai".into(),
                provider: "deepseek".into(),
                base_url: "https://api.deepseek.com".into(),
                api_key: "${DEEPSEEK_API_KEY}".into(),
                context_window: 65536,
                max_tokens: 8192,
                reasoning: false,
                cost_per_million_input: 0.27,
                cost_per_million_output: 1.10,
                tier: Some("budget".into()),
            },
            // ─── Placeholders ─────────────────────────────────────────────
            // These exist so `model_tier` actually picks something
            // out of the box. They're keyed on env vars that the
            // user may or may not have set:
            //   - GPT-4o mini / GPT-4o → OPENAI_API_KEY
            //   - Claude Sonnet / Opus    → ANTHROPIC_API_KEY
            // If the env var is empty, the role will fail at runtime
            // with an auth error; users can either set the env var,
            // or remove / replace the entry in their
            // `~/.latte/models.yaml`.
            ModelDef {
                id: "gpt-4o-mini".into(),
                name: "GPT-4o mini (budget placeholder)".into(),
                api: "openai".into(),
                provider: "openai".into(),
                base_url: "https://api.openai.com".into(),
                api_key: "${OPENAI_API_KEY}".into(),
                context_window: 128000,
                max_tokens: 16384,
                reasoning: false,
                cost_per_million_input: 0.15,
                cost_per_million_output: 0.60,
                tier: Some("budget".into()),
            },
            ModelDef {
                id: "claude-sonnet-4".into(),
                name: "Claude Sonnet 4.5 (standard placeholder)".into(),
                api: "anthropic".into(),
                provider: "anthropic".into(),
                base_url: "https://api.anthropic.com".into(),
                api_key: "${ANTHROPIC_API_KEY}".into(),
                context_window: 200000,
                max_tokens: 8192,
                reasoning: true,
                cost_per_million_input: 3.00,
                cost_per_million_output: 15.00,
                tier: Some("standard".into()),
            },
            ModelDef {
                id: "claude-opus-4".into(),
                name: "Claude Opus 4 (premium placeholder)".into(),
                api: "anthropic".into(),
                provider: "anthropic".into(),
                base_url: "https://api.anthropic.com".into(),
                api_key: "${ANTHROPIC_API_KEY}".into(),
                context_window: 200000,
                max_tokens: 8192,
                reasoning: true,
                cost_per_million_input: 15.00,
                cost_per_million_output: 75.00,
                tier: Some("premium".into()),
            },
        ],
        default_model: "deepseek-chat".into(),
    }
}

pub fn create_default_roles() -> RoleConfig {
    let mut roles = HashMap::new();

    // Mirror `latte-rs-agents/config/agents.toml` (10 roles). Each role
    // carries the same `model_tier` / `tools` / `prompt_file` as upstream
    // so users can drop in their own `prompts/<id>.md` files without
    // editing the YAML. Inline `prompt` is a fallback for missing files
    // — `load_role_prompt` only reads the file when it exists.
    roles.insert("pm".into(), RoleDef {
        name: "产品经理".into(),
        icon: "📋".into(),
        category: "规划".into(),
        model_tier: "standard".into(),
        model_chain: vec![],
        temperature: 0.7,
        tools: vec!["read".into(), "search".into()],
        prompt_file: "prompts/pm.md".into(),
        prompt: "你是一名产品经理，负责澄清需求、范围与验收标准。".into(),
        ..Default::default()
    });
    roles.insert("architect".into(), RoleDef {
        name: "系统架构师".into(),
        icon: "🏗️".into(),
        category: "规划".into(),
        model_tier: "premium".into(),
        model_chain: vec![],
        temperature: 0.5,
        tools: vec!["read".into(), "search".into()],
        prompt_file: "prompts/architect.md".into(),
        prompt: "你是一名系统架构师，负责给出模块、接口与数据流方案。".into(),
        ..Default::default()
    });
    roles.insert("programmer".into(), RoleDef {
        name: "软件工程师".into(),
        icon: "💻".into(),
        category: "执行".into(),
        model_tier: "budget".into(),
        model: None,
        model_chain: vec!["deepseek-chat".into()],
        temperature: 0.3,
        tools: vec!["read".into(), "write".into(), "bash".into(), "search".into()],
        prompt_file: "prompts/programmer.md".into(),
        prompt: "你是一名软件工程师，负责写出可运行、可测试的代码。".into(),
    });
    roles.insert("tester".into(), RoleDef {
        name: "测试工程师".into(),
        icon: "🧪".into(),
        category: "验证".into(),
        model_tier: "budget".into(),
        model_chain: vec![],
        temperature: 0.4,
        tools: vec!["read".into(), "bash".into(), "search".into()],
        prompt_file: "prompts/tester.md".into(),
        prompt: "你是一名测试工程师，负责列出边界条件、构造测试用例与回归清单。".into(),
        ..Default::default()
    });
    roles.insert("reviewer".into(), RoleDef {
        name: "代码审查员".into(),
        icon: "🔍".into(),
        category: "验证".into(),
        model_tier: "standard".into(),
        model_chain: vec![],
        temperature: 0.4,
        tools: vec!["read".into(), "search".into()],
        prompt_file: "prompts/reviewer.md".into(),
        prompt: "你是一名代码审查员，关注正确性、可读性与潜在缺陷。".into(),
        ..Default::default()
    });
    roles.insert("devops".into(), RoleDef {
        name: "运维工程师".into(),
        icon: "🚀".into(),
        category: "执行".into(),
        model_tier: "budget".into(),
        model_chain: vec![],
        temperature: 0.3,
        tools: vec!["read".into(), "bash".into(), "write".into()],
        prompt_file: "prompts/devops.md".into(),
        prompt: "你是一名运维工程师，关注部署、监控、回滚与运行成本。".into(),
        ..Default::default()
    });
    roles.insert("security".into(), RoleDef {
        name: "安全审计员".into(),
        icon: "🛡️".into(),
        category: "验证".into(),
        model_tier: "standard".into(),
        model_chain: vec![],
        temperature: 0.4,
        tools: vec!["read".into(), "search".into()],
        prompt_file: "prompts/security.md".into(),
        prompt: "你是一名安全审计员，关注输入校验、权限、注入与信息泄露。".into(),
        ..Default::default()
    });
    roles.insert("designer".into(), RoleDef {
        name: "UI/UX 设计师".into(),
        icon: "🎨".into(),
        category: "规划".into(),
        model_tier: "standard".into(),
        model_chain: vec![],
        temperature: 0.7,
        tools: vec!["read".into()],
        prompt_file: "prompts/designer.md".into(),
        prompt: "你是一名 UI/UX 设计师，关注信息层级、交互路径与可访问性。".into(),
        ..Default::default()
    });
    roles.insert("tech_writer".into(), RoleDef {
        name: "技术写作".into(),
        icon: "📝".into(),
        category: "执行".into(),
        model_tier: "budget".into(),
        model_chain: vec![],
        temperature: 0.5,
        tools: vec!["read".into(), "write".into()],
        prompt_file: "prompts/tech_writer.md".into(),
        prompt: "你是一名技术写作，负责把方案浓缩成对用户友好的中文说明。".into(),
        ..Default::default()
    });
    roles.insert("manager".into(), RoleDef {
        name: "工程经理".into(),
        icon: "👔".into(),
        category: "规划".into(),
        model_tier: "premium".into(),
        model_chain: vec![],
        temperature: 0.5,
        tools: vec!["read".into()],
        prompt_file: "prompts/manager.md".into(),
        prompt: "你是一名工程经理，负责拆分任务、排序依赖、决定谁来做。".into(),
        ..Default::default()
    });

    // Default workflows — same naming as upstream `discussion.toml` so
    // the `loadRoleConfig` consumers see consistent ids.
    let mut workflows = HashMap::new();
    workflows.insert("default".into(), WorkflowDef {
        name: "💬 默认 — 全员讨论".into(),
        kind: WorkflowKind::Planned,
        roles: vec![
            "pm".into(),
            "architect".into(),
            "programmer".into(),
            "tester".into(),
            "reviewer".into(),
            "devops".into(),
            "manager".into(),
        ],
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
    workflows.insert("plan".into(), WorkflowDef {
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
    workflows.insert("code_review".into(), WorkflowDef {
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
    workflows.insert("debug".into(), WorkflowDef {
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
    // Swarm-mode workflow: planner-driven. Use when the user just
    // drops a topic into the chat and the system has to figure out
    // which roles to involve and in what order. Cap of 4 worker
    // steps keeps small tasks small.
    workflows.insert("quick_task".into(), WorkflowDef {
        name: "🪄 快速任务 — 智能多角色".into(),
        kind: WorkflowKind::Swarm,
        worker_roles: vec![
            "pm".into(),
            "architect".into(),
            "programmer".into(),
            "reviewer".into(),
            "tester".into(),
            "tech_writer".into(),
        ],
        max_steps: 4,
        ..Default::default()
    });
    RoleConfig {
        default_model: "deepseek-chat".into(),
        roles,
        workflows,
    }
}

#[cfg(test)]
mod migration_tests {
    //! Tests for the forward-migration that runs on every
    //! `load_roles_config` / `load_global_models` call. Without this
    //! migration, users running an older `roles.yaml` (1 role + 1
    //! workflow) would never see the new 10 roles / 4 workflows /
    //! 3 tier placeholders, because `create_default_roles` /
    //! `create_default_models` only run when the file doesn't exist.

    use super::*;

    // ─── roles migration ──────────────────────────────────────────

    #[test]
    fn old_single_role_gets_10_roles_and_5_workflows() {
        // Simulate a v1 config: 1 role (programmer) + 1 workflow (debug)
        let mut cfg = RoleConfig {
            default_model: "deepseek-chat".into(),
            roles: HashMap::from([(
                "programmer".into(),
                RoleDef {
                    name: "Custom Programmer".into(),
                    ..Default::default()
                },
            )]),
            workflows: HashMap::from([(
                "debug".into(),
                WorkflowDef {
                    name: "🪲 Debug".into(),
                    kind: WorkflowKind::Planned,
                    roles: vec!["programmer".into()],
                    max_rounds: 1,
                    ..Default::default()
                },
            )]),
        };
        assert!(migrate_roles_config(&mut cfg));
        // 10 default roles total
        assert_eq!(cfg.roles.len(), 10);
        // 5 default workflows total (default, plan, code_review, debug, quick_task)
        assert_eq!(cfg.workflows.len(), 5);
        // User's custom programmer override is preserved (not
        // overwritten by the default)
        assert_eq!(cfg.roles["programmer"].name, "Custom Programmer");
    }

    #[test]
    fn migration_is_noop_when_all_defaults_present() {
        let defaults = create_default_roles();
        let mut cfg = defaults.clone();
        assert!(!migrate_roles_config(&mut cfg));
        // Same role count, same workflow count — no additions
        assert_eq!(cfg.roles.len(), defaults.roles.len());
        assert_eq!(cfg.workflows.len(), defaults.workflows.len());
    }

    #[test]
    fn users_custom_role_preserved_through_migration() {
        // User has a custom role "my_specialist" that isn't in defaults
        let mut cfg = RoleConfig {
            default_model: "deepseek-chat".into(),
            roles: HashMap::from([(
                "my_specialist".into(),
                RoleDef {
                    name: "Custom Specialist".into(),
                    icon: "🎯".into(),
                    category: "custom".into(),
                    model_tier: "premium".into(),
                    model: None,
                    model_chain: vec!["claude-opus-4".into()],
                    temperature: 0.4,
                    tools: vec!["read".into(), "write".into()],
                    prompt_file: "prompts/custom.md".into(),
                    prompt: "You are a specialist.".into(),
                },
            )]),
            workflows: HashMap::new(),
        };
        migrate_roles_config(&mut cfg);
        // Custom role still there with all fields preserved
        assert!(cfg.roles.contains_key("my_specialist"));
        let r = &cfg.roles["my_specialist"];
        assert_eq!(r.name, "Custom Specialist");
        assert_eq!(r.model_chain, vec!["claude-opus-4".to_string()]);
    }

    // ─── models migration ─────────────────────────────────────────

    #[test]
    fn old_single_model_gets_3_tier_placeholders() {
        // v1 catalog: just deepseek-chat
        let mut cfg = GlobalModelConfig {
            default_model: "deepseek-chat".into(),
            models: vec![ModelDef {
                id: "deepseek-chat".into(),
                name: "DeepSeek".into(),
                api: "openai".into(),
                provider: "deepseek".into(),
                base_url: "".into(),
                api_key: "x".into(),
                context_window: 0,
                max_tokens: 0,
                reasoning: false,
                cost_per_million_input: 0.0,
                cost_per_million_output: 0.0,
                tier: Some("budget".into()),
            }],
        };
        assert!(migrate_models_config(&mut cfg));
        // 4 total: deepseek + 3 placeholders
        assert_eq!(cfg.models.len(), 4);
        assert!(cfg.models.iter().any(|m| m.id == "gpt-4o-mini"));
        assert!(cfg.models.iter().any(|m| m.id == "claude-sonnet-4"));
        assert!(cfg.models.iter().any(|m| m.id == "claude-opus-4"));
    }

    #[test]
    fn users_custom_model_preserved_through_migration() {
        let mut cfg = GlobalModelConfig {
            default_model: "my-custom-model".into(),
            models: vec![ModelDef {
                id: "my-custom-model".into(),
                name: "My Custom".into(),
                api: "openai".into(),
                provider: "custom".into(),
                base_url: "https://my.api".into(),
                api_key: "secret".into(),
                context_window: 32000,
                max_tokens: 4096,
                reasoning: false,
                cost_per_million_input: 0.0,
                cost_per_million_output: 0.0,
                tier: None,
            }],
        };
        migrate_models_config(&mut cfg);
        // Custom model preserved with its fields intact
        let m = cfg.models.iter().find(|m| m.id == "my-custom-model").unwrap();
        assert_eq!(m.base_url, "https://my.api");
        assert_eq!(m.api_key, "secret");
    }
}
