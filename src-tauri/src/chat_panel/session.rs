//! Manages a running chat discussion session.
//!
//! Two modes:
//! - Live mode: uses real LLMs via latte-ai. Each agent turn is streamed.
//! - Stub mode: emits templated responses (no LLM required).
//!
//! Set LATTE_CHAT_LIVE=0 to force stub mode.

use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use serde_json::json;

use super::global_config::{
    self, expand_env_vars, GlobalModelConfig, ModelDef as ProjectModelDef, RoleConfig, RoleDef,
    WorkflowDef,
};
use super::types::*;

use latte_agent_core::agent::{Agent, AgentRunner};
use latte_agent_core::config::{AgentConfig, ModelCatalog, ModelDef as UpstreamModelDef};
use latte_agent_core::model_resolver::{ModelResolver, ModelTier};
use latte_agent_core::role::{Role, RoleCategory};

use latte_agent_orchestrator::consensus::ConsensusMethod;
use latte_agent_orchestrator::orchestrator::{DiscussionConfig, DiscussionOrchestrator};
use latte_agent_orchestrator::workflow::{DiscussionWorkflow, WorkflowStep};

/// Workflow presets
pub const WORKFLOW_PRESETS: &[(&str, &str, &[&str], usize, &str)] = &[
    ("plan", "design_brainstorm", &["pm", "architect", "programmer", "designer", "manager"], 2, "🗺️ Plan — design and architect"),
    ("code", "code_review", &["programmer", "reviewer", "security", "tester"], 1, "💻 Code — review and refactor"),
    ("debug", "bug_triage", &["tester", "programmer", "security", "devops", "manager"], 2, "🪲 Debug — triage and fix"),
    ("discuss", "default_workflow", &["pm", "architect", "programmer", "tester", "reviewer", "devops", "manager"], 3, "💬 Discuss — full team discussion"),
];

/// Returns the list of role IDs we ship by default.
pub fn default_role_ids() -> &'static [&'static str] {
    &["pm", "architect", "programmer", "tester", "reviewer", "devops", "security", "designer", "tech_writer", "manager"]
}

/// Construct a `TurnPayload` with default weight + pinned=false +
/// a stable `message_id` derived from `(session_id, turn_number)`.
/// Centralizes the defaults so call sites don't have to repeat them
/// — and gives every message a deterministic id the frontend can
/// target for delete / edit / weight-adjust.
pub fn build_turn_payload(
    session_id: usize,
    turn_number: usize,
    role_id: &str,
    agent: &str,
    icon: &str,
    response: String,
    step_id: String,
    round: usize,
) -> TurnPayload {
    TurnPayload {
        agent: agent.to_string(),
        role_id: role_id.to_string(),
        icon: icon.to_string(),
        response,
        round,
        step_id,
        turn_number,
        weight: 1.0,
        message_id: format!("{session_id}:{turn_number}"),
        pinned: false,
    }
}
/// Run a discussion — uses real LLM if API keys are configured, else stub.
pub async fn run_discussion(
    app: &AppHandle,
    req: &StartDiscussionRequest,
) -> Result<DiscussionPayload, String> {
    let force_stub = std::env::var("LATTE_CHAT_LIVE")
        .map(|v| v == "0")
        .unwrap_or(false);

    if force_stub {
        return run_stub_discussion(app, req).await;
    }

    let global_config = global_config::load_global_models();
    let roles_config = global_config::load_roles_config();

    if !global_config.has_api_key() {
        let models_path = global_config::global_models_path();
        return Err(format!(
            "未配置 API 密钥。\n\n配置文件: {}\n\n请在配置文件中设置 API 密钥:\n1. 打开 ~/.latte/models.yaml\n2. 在模型定义中填入 api_key:\n\n   models:\n     - id: deepseek-chat\n       api_key: YOUR_API_KEY_HERE\n\n或强制使用 stub 模式:\nexport LATTE_CHAT_LIVE=0",
            models_path.display()
        ));
    }

    run_live_discussion(app, req, &global_config, &roles_config).await
}
/// Bridge the project's `RoleDef` / `ModelDef` types into the upstream
/// `latte-agent-core` types used by `DiscussionOrchestrator`.
///
/// The upstream has its own `Role` (with handlebars prompt rendering,
/// `default_model_tier`, `model_chain`) and `ModelDef` (with `api: String`
/// and `cost_*` fields). The project keeps a lighter-weight config-only
/// view in YAML; these helpers do the one-shot conversion when a
/// discussion is launched.
// ─── Type bridges (project → upstream) ───────────────────────────────
//
// The upstream `latte-agent-core` has its own `Role` (with handlebars
// prompt rendering, `default_model_tier`, `model_chain`) and `ModelDef`
// (with `api: String` and `cost_*` fields). The project keeps a lighter
// config-only view in YAML; these helpers do the one-shot conversion
// when a discussion is launched.

/// Convert the project's `ModelDef` (lives in `~/.latte/models.yaml`)
/// to the upstream `ModelDef` consumed by `ModelResolver`.
///
/// Field differences:
/// - project has `reasoning`, upstream has `supports_thinking` (rename)
/// - project has `f64` cost fields, upstream has `Option<f64>` (0.0 → None)
/// - API key `${ENV_VAR}` references are expanded here so the resolver
///   gets a usable key even if a caller forgot to expand.
fn convert_model_def(m: &ProjectModelDef) -> UpstreamModelDef {
    let api_key = expand_env_vars(&m.api_key);
    UpstreamModelDef {
        id: m.id.clone(),
        name: m.name.clone(),
        // The project omits `api` in many configs; fall back to
        // `provider` so `parse_api_type` can still classify it.
        api: if m.api.is_empty() {
            m.provider.clone()
        } else {
            m.api.clone()
        },
        provider: m.provider.clone(),
        base_url: m.base_url.clone(),
        api_key,
        context_window: m.context_window,
        max_tokens: m.max_tokens,
        supports_thinking: m.reasoning,
        cost_per_million_input: if m.cost_per_million_input > 0.0 {
            Some(m.cost_per_million_input)
        } else {
            None
        },
        cost_per_million_output: if m.cost_per_million_output > 0.0 {
            Some(m.cost_per_million_output)
        } else {
            None
        },
        tier: m.tier.clone(),
    }
}

/// Build an upstream `Role` from the project's `RoleDef`.
///
/// `effective_chain` is the chain that `build_agent_config` will hand
/// to the resolver (chain head = tier override, rest = fallbacks).
fn build_upstream_role(role_id: &str, role_def: &RoleDef, effective_chain: &[String]) -> Role {
    // `model_tier` is a free-form String in the project's `RoleDef`
    // (matches `agents.toml` schema). The upstream runtime uses a
    // `ModelTier` enum, so parse + fall back to `Standard` on
    // unknown / missing values — keeping chain head as primary.
    let default_model_tier = ModelTier::parse(&role_def.model_tier)
        .unwrap_or(ModelTier::Standard);
    // Prompt resolution order:
    // 1. Upstream's built-in `latte_agent_core::prompts::for_role(id)`
    //    — returns the markdown from the upstream workspace
    //    (`latte-rs-agents/prompts/<id>.md`) embedded at build time
    //    via `include_str!`. No file I/O, no copy into the project tree.
    // 2. `load_role_prompt` — reads a custom `prompt_file` from
    //    disk (for roles that aren't in the upstream catalog, or
    //    for users who want to override the upstream template).
    //    Falls back to the inline `prompt` field on read error.
    // 3. Inline `prompt` (last resort, via `load_role_prompt`).
    let roles_dir = super::global_config::roles_config_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let system_prompt = latte_agent_core::prompts::for_role(role_id)
        .map(String::from)
        .unwrap_or_else(|| load_role_prompt(role_id, role_def, &roles_dir));
    Role {
        id: role_id.to_string(),
        name: role_def.name.clone(),
        category: RoleCategory::parse(&role_def.category)
            .unwrap_or(RoleCategory::Discussion),
        system_prompt,
        default_model_tier,
        model_chain: effective_chain.to_vec(),
        default_params: latte_ai::params::GenerateParams {
            temperature: Some(role_def.temperature),
            max_tokens: Some(8192),
            ..Default::default()
        },
        // Forward the role's tool whitelist. The chat panel runner
        // doesn't yet wire tool calls, but the upstream `Agent`
        // reads `allowed_tools` when constructed.
        allowed_tools: role_def.tools.clone(),
        icon: role_def.icon.clone(),
    }
}

/// Load a role's system prompt from `prompt_file` (relative to
/// `roles_dir` or absolute), falling back to the inline `prompt`
/// field on any read error. Mirrors the file-loading half of
/// upstream `RoleTemplate::resolve`; handlebars rendering is
/// intentionally not done here — the orchestrator's per-turn
/// rendering already substitutes `{{topic}}` / `{{role_name}}` /
/// `{{step}}` in the workflow prompt, and per-role template
/// variables (e.g. `{{temperature}}`) are a future addition.
fn load_role_prompt(
    role_id: &str,
    role_def: &RoleDef,
    roles_dir: &std::path::Path,
) -> String {
    if role_def.prompt_file.is_empty() {
        return role_def.prompt.clone();
    }
    let path = std::path::Path::new(&role_def.prompt_file);
    let full_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        roles_dir.join(path)
    };
    match std::fs::read_to_string(&full_path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!(
                "[chat] role '{role_id}' prompt_file '{}' read failed: {e} — falling back to inline prompt",
                full_path.display()
            );
            role_def.prompt.clone()
        }
    }
}

/// Build the upstream `AgentConfig` from the project's model catalog +
/// per-role tier overrides derived from each role's chain head.
fn build_agent_config(
    global_config: &GlobalModelConfig,
    roles_config: &RoleConfig,
    role_ids: &[String],
) -> AgentConfig {
    // Upstream `ModelCatalog.role_tiers` uses serde strings as tier keys
    // (e.g. "standard", "premium", "budget") — not the `ModelTier` enum.
    let mut role_tiers: HashMap<String, HashMap<String, String>> = HashMap::new();
    for role_id in role_ids {
        let Some(role_def) = roles_config.roles.get(role_id) else {
            continue;
        };
        // Primary resolution order (matches upstream
        // `ModelResolver::resolve` step 1+2 semantics):
        // 1. Chain head (chain[0]) — explicit override, always wins
        // 2. First model in catalog with `tier == role.model_tier`
        //    — the role declares "I prefer budget / standard / premium"
        // 3. Global default model — ultimate fallback
        let chain = role_def.chain();
        let primary = chain
            .first()
            .cloned()
            .or_else(|| resolve_primary_by_tier(global_config, &role_def.model_tier))
            .unwrap_or_else(|| global_config.default_model.clone());
        let mut tier_map = HashMap::new();
        tier_map.insert("standard".to_string(), primary);
        role_tiers.insert(role_id.clone(), tier_map);
    }

    AgentConfig {
        models: ModelCatalog {
            models: global_config.models.iter().map(convert_model_def).collect(),
            tiers: None,
            role_tiers: Some(role_tiers),
        },
        // The project loads its own role YAML; the orchestrator's role
        // catalog isn't used.
        roles: HashMap::new(),
    }
}

/// Find the first model in the catalog whose `tier` matches the given
/// string. Mirrors the upstream `ModelResolver::resolve` step 3
/// (scan catalog for `model.tier == tier`). Returns the model id or
/// `None` if no match.
fn resolve_primary_by_tier(global_config: &GlobalModelConfig, tier: &str) -> Option<String> {
    global_config
        .models
        .iter()
        .find(|m| m.tier.as_deref() == Some(tier))
        .map(|m| m.id.clone())
}

/// Build `HashMap<role_id, AgentRunner>` for the orchestrator.
///
/// For each role:
/// - resolve its chain through `ModelResolver` (primary via
///   `role_tiers[role_id][Standard]`, fallbacks = `chain[1..]`)
/// - the resolver drops duplicates and unknown ids
/// - construct `Agent::new_with_chain` and wrap in `AgentRunner`
fn build_agent_runners(
    resolver: &ModelResolver,
    roles_config: &RoleConfig,
    role_ids: &[String],
) -> Result<HashMap<String, AgentRunner>, String> {
    let mut agents: HashMap<String, AgentRunner> = HashMap::new();
    for role_id in role_ids {
        let role_def = roles_config.roles.get(role_id).ok_or_else(|| {
            format!("role '{role_id}' not found in roles.yaml")
        })?;
        let chain = role_def.chain();
        let role = build_upstream_role(role_id, role_def, &chain);
        // Snapshot `role.id` so we can use it after `new_with_chain` moves the role.
        let role_id_owned = role.id.clone();
        // The resolver picks the primary via `role_tiers`; pass the rest
        // of the chain as the fallback list. An empty tail is fine — the
        // resolver will still return the primary.
        let chain_tail: Vec<String> = chain.iter().skip(1).cloned().collect();
        let resolved_models = resolver
            .resolve_chain(&role.id, ModelTier::Standard, &chain_tail)
            .map_err(|e| format!("resolve chain for role '{role_id}': {e}"))?;
        let agent = Agent::new_with_chain(
            role_id_owned.clone(),
            role,
            resolved_models,
            // `Role.default_params` already carries temperature/max_tokens;
            // the runner uses those, not this one. Pass default to be safe.
            latte_ai::params::GenerateParams::default(),
        )
        .map_err(|e| format!("build agent '{role_id}': {e}"))?;
    agents.insert(role_id_owned, AgentRunner::new(agent));
    }
    Ok(agents)
}

/// Per-role result of the pre-flight check. Emitted to the frontend as
/// one synthetic `chat:turn` per broken role so the user sees the
/// avatar + role name + which models are missing keys, and can retry
/// without re-typing the topic.
#[derive(Clone, Debug)]
pub(crate) struct PreflightRoleError {
    pub role_id: String,
    pub role_name: String,
    pub icon: String,
    pub missing_models: Vec<String>,
    /// Human-readable summary in Chinese — what the chat bubble shows.
    pub message: String,
}

/// Walk each role's resolved chain and surface roles whose every model
/// is missing an API key. Returns `Ok(())` when every role has at
/// least one usable model, otherwise `Err(Vec<PreflightRoleError>)`.
///
/// This is the per-role "you forgot to set the API key" report. The
/// orchestrator's run-time error lumps all failures together; this
/// pre-check gives the user one bubble per broken role (with the
/// role's icon) so they can fix the right thing.
pub(crate) fn preflight_check(
    resolver: &ModelResolver,
    roles_config: &RoleConfig,
    role_ids: &[String],
) -> Result<(), Vec<PreflightRoleError>> {
    let mut errors = Vec::new();
    for role_id in role_ids {
        let role_def = match roles_config.roles.get(role_id) {
            Some(r) => r,
            None => {
                errors.push(PreflightRoleError {
                    role_id: role_id.clone(),
                    role_name: role_id.clone(),
                    icon: "❓".into(),
                    missing_models: vec![],
                    message: format!("role `{role_id}` 未在 roles.yaml 中定义"),
                });
                continue;
            }
        };
        let chain = role_def.chain();
        let chain_tail: Vec<String> = chain.iter().skip(1).cloned().collect();
        let resolved = match resolver.resolve_chain(role_id, ModelTier::Standard, &chain_tail) {
            Ok(v) => v,
            Err(e) => {
                errors.push(PreflightRoleError {
                    role_id: role_id.clone(),
                    role_name: role_def.name.clone(),
                    icon: role_def.icon.clone(),
                    missing_models: vec![],
                    message: format!("无法解析 `{}` 的模型链：{}", role_id, e),
                });
                continue;
            }
        };
        if resolved.is_empty() {
            errors.push(PreflightRoleError {
                role_id: role_id.clone(),
                role_name: role_def.name.clone(),
                icon: role_def.icon.clone(),
                missing_models: vec![],
                message: format!("`{}` 的模型链为空，请检查 roles.yaml", role_id),
            });
            continue;
        }
        let missing: Vec<String> = resolved
            .iter()
            .filter(|m| m.api_key.trim().is_empty())
            .map(|m| m.id.clone())
            .collect();
        if missing.len() == resolved.len() {
            // Every model in the chain is missing — no way to run
            // this role at all.
            let role_name = &role_def.name;
            let message = format!(
                "`{}` 缺少 API key：{}（请在 ~/.latte/models.yaml 中设置）",
                role_name,
                if missing.is_empty() {
                    "无可用模型".to_string()
                } else {
                    missing.join("、")
                }
            );
            errors.push(PreflightRoleError {
                role_id: role_id.clone(),
                role_name: role_def.name.clone(),
                icon: role_def.icon.clone(),
                missing_models: missing,
                message,
            });
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Build the orchestrator's `DiscussionWorkflow` from the project's
/// workflow request.
///
/// Each role becomes one step; the prompt injects `{{role_name}}` and
/// `{{topic}}` so the orchestrator can substitute at run time. The
/// upstream `default_workflow` in `discussion.toml` uses the same
/// Build the upstream `DiscussionWorkflow` from the project-side
/// `StartDiscussionRequest` + the resolved role list.
///
/// If `step_plan` is non-empty, we emit one upstream step per
/// `step_plan` entry, with `speakers = entry` (in order). This is
/// how the project's `WorkflowDef::steps` shape maps onto the
/// orchestrator's "ordered step with multiple speakers" model —
/// without it every role speaks in parallel regardless of `steps`.
///
/// Otherwise we fall back to one step per flat role id (the legacy
/// "round-robin per role" behaviour for workflows with empty
/// `steps`, e.g. user-curated custom workflows).
fn build_workflow(
    req: &StartDiscussionRequest,
    role_ids: &[String],
    step_plan: Option<&[Vec<String>]>,
) -> DiscussionWorkflow {
    let steps: Vec<WorkflowStep> = match step_plan {
        Some(plan) if !plan.is_empty() => plan
            .iter()
            .enumerate()
            .map(|(i, speakers)| WorkflowStep {
                id: format!("step_{i}"),
                description: format!("step {i}"),
                speakers: speakers.clone(),
                prompt: "Step {{step}}: speakers are {{{{speakers}}}}. Topic: {{{{topic}}}}."
                    .to_string(),
                hooks: vec![],
                output_key: None,
            })
            .collect(),
        _ => role_ids
            .iter()
            .map(|role_id| WorkflowStep {
                id: format!("{role_id}_speak"),
                description: format!("{role_id} speaks"),
                speakers: vec![role_id.clone()],
                prompt: "You are {{{{role_name}}}}. Topic: {{{{topic}}}}. Share your perspective."
                    .to_string(),
                hooks: vec![],
                output_key: None,
            })
            .collect(),
    };
    DiscussionWorkflow {
        name: req.workflow.clone(),
        description: String::new(),
        steps,
        max_rounds: req.max_rounds.unwrap_or(1).max(1),
        context_token_budget: 32_000,
    }
}
/// `steps` is `Some(Vec<Vec<String>>)` when the workflow defines an
/// ordered step list (project `WorkflowDef::steps`). Each inner vec
/// is the set of role ids that should speak during that step, in
/// order. Callers should:
/// - emit one upstream `WorkflowStep` per inner vec, with
///   `speakers = inner_vec`, when `steps` is `Some`;
/// - else fall back to one step per flat `roles`.
///
/// Lookup order: `roles.yaml` workflow → `WORKFLOW_PRESETS` → all defaults.
fn resolve_workflow_roles(
    roles_config: &RoleConfig,
    req: &StartDiscussionRequest,
) -> (Vec<String>, usize, Option<Vec<Vec<String>>>) {
    if let Some(wf) = roles_config.workflows.get(&req.workflow) {
        let steps = if wf.steps.is_empty() {
            None
        } else {
            Some(
                wf.steps
                    .iter()
                    .map(|s| s.roles.clone())
                    .collect::<Vec<_>>(),
            )
        };
        return (wf.roles.clone(), wf.max_rounds, steps);
    }
    if let Some((_, _, roles, rounds, _)) = WORKFLOW_PRESETS
        .iter()
        .find(|(id, _, _, _, _)| *id == req.workflow)
    {
        return (
            roles.iter().map(|s| s.to_string()).collect(),
            *rounds,
            None,
        );
    }
    (
        default_role_ids().iter().map(|s| s.to_string()).collect(),
        1,
        None,
    )
}
// ─── Live discussion (upstream `DiscussionOrchestrator`) ─────────────
//
// The runner no longer hand-rolls chain walking / cooldown / round
// orchestration. All of that lives in `latte-agent-orchestrator`:
// - `Agent::chat` walks the priority-ordered chain, tracking per-model
//   cooldown (429/5xx → cooldown, 4xx → propagate immediately)
// - `AgentRunner::run_turn` renders the role's handlebars prompt and
//   carries the conversation context across turns
// - `DiscussionOrchestrator::run_with_events` drives the round/step/
//   turn loop and yields each completed turn via a callback — this is
//   how the Tauri `chat:turn` events stay in lock-step with the user.

/// Run a real LLM-backed discussion via the upstream orchestrator.
async fn run_live_discussion(
    app: &AppHandle,
    req: &StartDiscussionRequest,
    global_config: &GlobalModelConfig,
    roles_config: &RoleConfig,
) -> Result<DiscussionPayload, String> {
    // 1. Which roles participate? (workflow → custom → defaults).
    //    `steps` is the workflow's ordered step list (when set) so
    //    the orchestrator runs pm → architect → programmer … in
    //    sequence instead of every role speaking in parallel.
    let (default_roles, _preset_rounds, step_plan) =
        resolve_workflow_roles(roles_config, req);
    let roles_to_use: Vec<String> = req.custom_roles.clone().unwrap_or(default_roles);
    if roles_to_use.is_empty() {
        return Err("No roles selected for discussion".to_string());
    }

    // 2. Build resolver with per-role tier overrides (chain head = primary)
    let agent_config = build_agent_config(global_config, roles_config, &roles_to_use);
    let resolver = ModelResolver::from_config(&agent_config)
        .map_err(|e| format!("model resolver init: {e}"))?;

    // 2.5. Pre-flight: report broken roles BEFORE the orchestrator
    //      runs. Each broken role gets its own synthetic `chat:turn`
    //      so the chat list shows an avatar + role name + the
    //      specific missing keys. This is what the user wanted —
    //      they should never see a single opaque "未配置 API 密钥"
    //      line and have no idea which role failed.
    if let Err(broken_roles) = preflight_check(&resolver, roles_config, &roles_to_use) {
        for broken in &broken_roles {
            let payload = build_turn_payload(
                0, // preflight errors predate session creation
                broken_roles.iter().position(|b| std::ptr::eq(b, broken)).unwrap_or(0),
                &broken.role_id,
                &broken.role_name,
                &broken.icon,
                format!("⚠️ {}\n\n（无需手动解决：检查 ~/.latte/models.yaml 中 {} 的 API key）",
                    broken.message,
                    broken.missing_models.join("、")),
                format!("__preflight_error__{}", broken.role_id),
                0,
            );
        }
        return Err(format!(
            "{} 个角色缺少 API key，已在上方列出",
            broken_roles.len()
        ));
    }
    let workflow = build_workflow(req, &roles_to_use, step_plan.as_deref());

    // 5. Variables used by the orchestrator's handlebars rendering.
    //    injected per turn by the orchestrator itself.
    let mut variables = HashMap::new();
    variables.insert("topic".into(), req.topic.clone());
    let config = DiscussionConfig {
        workflow,
        // `NoConsensus` means `consensus_reached = true` every round,
        // so the orchestrator runs the full `max_rounds` without
        // short-circuiting. Matches the project's previous "always run
        // N rounds" behavior.
        consensus: ConsensusMethod::NoConsensus,
        max_rounds: req.max_rounds,
        context_token_budget: 32_000,
        variables,
    };

    // 3. Build agent runners (resolver + per-role chain are already
    //    validated by the pre-flight above; the runner build itself
    //    shouldn't fail unless a role id is unknown to the resolver).
    let agents = build_agent_runners(&resolver, roles_config, &roles_to_use)?;

    // 6. Construct + run the orchestrator with per-turn Tauri emission
    let mut orchestrator = DiscussionOrchestrator::new(agents, config)
        .map_err(|e| format!("orchestrator init: {e}"))?;
    let result = orchestrator
        .run_with_events(|turn| {
            let icon = roles_config
                .roles
                .get(&turn.role_id)
                .map(|r| r.icon.clone())
                .unwrap_or_else(|| "💬".to_string());
            let payload = build_turn_payload(
                0, // session_id assigned by frontend when calling startDiscussion
                turn.turn_number,
                &turn.role_id,
                &turn.agent,
                &roles_config
                    .roles
                    .get(&turn.role_id)
                    .map(|r| r.icon.clone())
                    .unwrap_or_else(|| "💬".to_string()),
                turn.response.clone(),
                turn.step_id.clone(),
                turn.round,
            );
            let _ = app.emit("chat:turn", &payload);
        })
        .await
        .map_err(|e| format!("discussion failed: {e}"))?;

    // 7. Map `DiscussionResult` → `DiscussionPayload`
    let rounds: Vec<RoundPayload> = result
        .rounds
        .iter()
        .map(|r| RoundPayload {
            number: r.number,
            turns: r
                .turns
                .iter()
                .map(|t| build_turn_payload(
                    0,
                    t.turn_number,
                    &t.role_id,
                    &t.agent,
                    &roles_config
                        .roles
                        .get(&t.role_id)
                    .map(|rd| rd.icon.clone())
                    .unwrap_or_else(|| "💬".to_string()),
                    t.response.clone(),
                    t.step_id.clone(),
                    t.round,
                ))
                .collect(),
            consensus_reached: r.consensus_reached,
        })
        .collect();

    Ok(DiscussionPayload {
        rounds,
        consensus_reached: result.consensus_reached,
        summary: Some(format!("Discussion complete: {}", req.topic)),
        total_input_tokens: result.total_usage.input_tokens as u32,
        total_output_tokens: result.total_usage.output_tokens as u32,
        stub: false,
    })
}
// ─────────────────────────────────────────────────────────────────────────────
// Stub mode
// ─────────────────────────────────────────────────────────────────────────────
const ROLE_TEMPLATES: &[(&str, &str, &str)] = &[
    ("pm", "📋", "## Requirements Analysis\n\nAs **PM**, I've analyzed **{topic}**.\n\n<file_edit path=\"docs/{slug}.md\">Add requirements doc for {topic}</file_edit>"),
    ("architect", "🏗️", "## Architecture Review\n\nLooking at **{topic}** from a system-design perspective.\n\n<file_edit path=\"docs/architecture/{slug}.md\">Add architecture notes for {topic}</file_edit>"),
    ("programmer", "💻", "## Implementation Plan\n\nFor **{topic}**.\n\n<file_edit path=\"src/lib/{slug}.ts\">Implement {topic}</file_edit>"),
    ("tester", "🧪", "## Test Strategy\n\nFor **{topic}**.\n\n<file_edit path=\"src/lib/{slug}.test.ts\">Add tests for {topic}</file_edit>"),
    ("reviewer", "🔍", "## Code Review\n\nReviewing **{topic}**."),
    ("devops", "🚀", "## Operational Notes\n\nFor **{topic}**."),
    ("security", "🛡️", "## Security Review\n\nFor **{topic}**."),
    ("designer", "🎨", "## UX Considerations\n\nFor **{topic}**."),
    ("tech_writer", "📝", "## Documentation\n\nFor **{topic}**."),
    ("manager", "👔", "## Decision\n\n**Verdict on {topic}**: ✅ proceed."),
];

async fn run_stub_discussion(
    app: &AppHandle,
    req: &StartDiscussionRequest,
) -> Result<DiscussionPayload, String> {
    let slug = slugify(&req.topic);
    let topic_pretty = if req.topic.is_empty() {
        "the topic".to_string()
    } else if req.topic.chars().count() > 80 {
        let truncated: String = req.topic.chars().take(77).collect();
        format!("{}...", truncated)
    } else {
        req.topic.clone()
    };

    // Mirror `run_live_discussion`: prefer the workflow's ordered step
    // list when the workflow file defines one, so the stub speaks
    // PM → architect → programmer → … in order rather than every role
    // at once. Falls back to the flat role list when `step_plan` is
    // empty (user-curated custom workflows or legacy presets).
    let roles_config = global_config::load_roles_config();
    let (default_roles, _preset_rounds, step_plan) =
        resolve_workflow_roles(&roles_config, req);
    let roles: Vec<String> = req.custom_roles.clone().unwrap_or(default_roles);

    let total_rounds = req.max_rounds.unwrap_or(1).max(1);
    let mut rounds: Vec<RoundPayload> = Vec::new();
    let mut total_input_tokens: u32 = 0;
    let mut total_output_tokens: u32 = 0;

    let speakers_per_round: Vec<Vec<String>> = match step_plan {
        Some(plan) if !plan.is_empty() => plan.clone(),
        _ => roles.iter().map(|r| vec![r.clone()]).collect(),
    };

    for round_num in 0..total_rounds {
        let mut turns: Vec<TurnPayload> = Vec::new();
        for (idx, role_id) in speakers_per_round
            .iter()
            .flat_map(|step| step.iter())
            .enumerate()
        {
            let template = ROLE_TEMPLATES
                .iter()
                .find(|(id, _, _)| *id == role_id)
                .or_else(|| ROLE_TEMPLATES.first());

            let (rid, icon, tmpl) = match template {
                Some(t) => t,
                None => continue,
            };

            let response = tmpl
                .replace("{topic}", &topic_pretty)
                .replace("{slug}", &slug)
                .replace("{Slug}", &capitalize(&slug))
                .replace("{Topic}", &capitalize(&topic_pretty));

            let turn = build_turn_payload(
                0,
                turns.len(),
                rid,
                rid,
                icon,
                response.clone(),
                format!("step_{}", idx),
                round_num,
            );
            total_input_tokens += (topic_pretty.len() / 4) as u32 + 200;
            total_output_tokens += (response.len() / 4) as u32;
            let _ = app.emit("chat:turn", &turn);
            turns.push(turn);
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        rounds.push(RoundPayload {
            number: round_num,
            turns,
            consensus_reached: true,
        });
    }

    Ok(DiscussionPayload {
        rounds,
        consensus_reached: true,
        summary: Some(format!("Stub discussion on: {}", topic_pretty)),
        total_input_tokens,
        total_output_tokens,
        stub: true,
    })
}

fn slugify(s: &str) -> String {
    let raw: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let cleaned: String = raw
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if cleaned.is_empty() {
        "topic".to_string()
    } else if cleaned.chars().count() > 48 {
        cleaned.chars().take(48).collect()
    } else {
        cleaned
    }
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_panel::global_config::{WorkflowDef, WorkflowKind, WorkflowStep};
    use std::collections::HashMap;

    fn req(workflow: &str) -> StartDiscussionRequest {
        StartDiscussionRequest {
            topic: "设计一个登录页".into(),
            workflow: workflow.into(),
            custom_roles: None,
            max_rounds: None,
        }
    }

    #[test]
    fn resolve_returns_step_plan_when_workflow_has_steps() {
        let mut workflows = HashMap::new();
        workflows.insert(
            "default".into(),
            WorkflowDef {
                name: "默认".into(),
                kind: WorkflowKind::Planned,
                roles: vec!["pm".into(), "architect".into(), "programmer".into()],
                steps: vec![
                    WorkflowStep {
                        name: "需求澄清".into(),
                        roles: vec!["pm".into()],
                    },
                    WorkflowStep {
                        name: "架构".into(),
                        roles: vec!["architect".into()],
                    },
                    WorkflowStep {
                        name: "实现".into(),
                        roles: vec!["programmer".into()],
                    },
                ],
                ..Default::default()
            },
        );
        let rc = RoleConfig {
            roles: HashMap::new(),
            default_model: String::new(),
            workflows,
        };
        let (roles, rounds, steps) = resolve_workflow_roles(&rc, &req("default"));
        assert_eq!(roles, vec!["pm", "architect", "programmer"]);
        assert_eq!(rounds, 1);
        let plan = steps.expect("default workflow should have a step plan");
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0], vec!["pm"]);
        assert_eq!(plan[1], vec!["architect"]);
        assert_eq!(plan[2], vec!["programmer"]);
    }

    #[test]
    fn resolve_returns_none_when_steps_empty() {
        let mut workflows = HashMap::new();
        workflows.insert(
            "legacy".into(),
            WorkflowDef {
                name: "Legacy".into(),
                kind: WorkflowKind::Planned,
                roles: vec!["pm".into()],
                steps: vec![],
                ..Default::default()
            },
        );
        let rc = RoleConfig {
            roles: HashMap::new(),
            default_model: String::new(),
            workflows,
        };
        let (_roles, _rounds, steps) = resolve_workflow_roles(&rc, &req("legacy"));
        assert!(steps.is_none(), "empty steps must fall back to flat");
    }

    #[test]
    fn build_workflow_emits_one_step_per_project_step() {
        let r = req("default");
        let plan = vec![
            vec!["pm".to_string()],
            vec!["architect".to_string(), "reviewer".to_string()],
        ];
        let flat = vec!["pm".to_string(), "architect".to_string()];
        let wf = build_workflow(&r, &flat, Some(&plan));
        assert_eq!(wf.steps.len(), 2);
        assert_eq!(wf.steps[0].speakers, vec!["pm"]);
        assert_eq!(wf.steps[1].speakers, vec!["architect", "reviewer"]);
    }

    #[test]
    fn build_workflow_falls_back_to_flat_roles() {
        let r = req("legacy");
        let flat = vec!["pm".to_string(), "architect".to_string()];
        let wf = build_workflow(&r, &flat, None);
        assert_eq!(wf.steps.len(), 2);
        assert_eq!(wf.steps[0].speakers, vec!["pm"]);
        assert_eq!(wf.steps[1].speakers, vec!["architect"]);
    }
}
