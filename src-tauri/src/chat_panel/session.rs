//! Manages a running chat discussion session.
//!
//! Two modes:
//! - Live mode: uses real LLMs via latte-ai. Each agent turn is streamed.
//! - Stub mode: emits templated responses (no LLM required).
//!
//! Set LATTE_CHAT_LIVE=0 to force stub mode.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use parking_lot::Mutex;

use super::global_config::{self, GlobalModelConfig, ModelDef, RoleConfig};
use super::types::*;

use latte_ai::client::AiClient;
use latte_ai::error::AiError;
use latte_ai::models::{ApiType, Completion, Message, Model, Role as MessageRole};
use latte_ai::params::GenerateParams;

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
/// One priority-ordered (model_def, client) pair in an agent's fallback chain.
struct ChainEntry {
    def: Arc<ModelDef>,
    client: AiClient,
}

/// A configured role backed by a priority-ordered model chain.
///
/// `chat_with_fallback` walks the chain top-to-bottom: on a retryable
/// error (rate-limit, 5xx, transient network) the failing model is
/// put on cooldown and the next model in the chain is tried. This
/// mirrors `latte-agent-core::agent::Agent` but stays local so the
/// chat panel runner doesn't depend on the orchestrator's role
/// rendering pipeline.
struct RoleAgent {
    id: String,
    name: String,
    icon: String,
    system_prompt: String,
    temperature: f64,
    /// Priority-ordered chain (highest priority first). Always non-empty
    /// once `build_chain_for_role` succeeds.
    chain: Vec<ChainEntry>,
    /// Per-model cooldown deadlines (model_id -> cooldown_until). Held in
    /// a `Mutex` so `chat_with_fallback` can take `&self`.
    cooldown: Mutex<HashMap<String, Instant>>,
}

impl RoleAgent {
    /// Walk `chain` in priority order, skipping models on cooldown.
    /// Returns the first successful completion.
    ///
    /// On a retryable error the failing model is put on cooldown and
    /// the next model in the chain is tried. Non-retryable errors
    /// (auth, config, caller-fault 4xx other than 429) propagate
    /// immediately so the user sees the underlying cause.
    async fn chat_with_fallback(
        &self,
        messages: &[Message],
        params: &GenerateParams,
    ) -> Result<Completion, String> {
        let now = Instant::now();
        let mut tried: Vec<String> = Vec::new();
        let mut last_err: Option<String> = None;

        for entry in &self.chain {
            // Skip models currently on cooldown.
            {
                let cooldowns = self.cooldown.lock();
                if let Some(until) = cooldowns.get(&entry.def.id) {
                    if *until > now {
                        continue;
                    }
                }
            }
            tried.push(entry.def.id.clone());
            match entry.client.chat(messages, params).await {
                Ok(completion) => return Ok(completion),
                Err(e) => {
                    if let Some(cd) = cooldown_for_error(&e) {
                        self.cooldown
                            .lock()
                            .insert(entry.def.id.clone(), now + cd);
                    }
                    last_err = Some(format!("{}: {}", entry.def.id, e));
                    // Continue to the next model in the chain.
                }
            }
        }

        Err(format!(
            "LLM call failed (role: {})\nTried: {}\nLast error: {}\n\nCommon causes:\n- Invalid or expired API key\n- Network connection issue\n- Model service unavailable",
            self.id,
            if tried.is_empty() {
                "<all on cooldown>".to_string()
            } else {
                tried.join(", ")
            },
            last_err.as_deref().unwrap_or("n/a"),
        ))
    }
}

/// Map an `AiError` to a suggested cooldown duration.
///
/// Returns `None` for non-retryable errors (auth, config, serialization,
/// caller-fault 4xx other than 429) — these surface immediately so the
/// user sees the underlying cause. Mirrors the upstream helper in
/// `latte-agent-core::agent::cooldown_for_error`.
fn cooldown_for_error(e: &AiError) -> Option<Duration> {
    match e {
        // Vendor told us how long to wait — respect it (floor 1s).
        AiError::RateLimited { retry_after, .. } => {
            let secs = retry_after.max(1.0);
            Some(Duration::from_secs_f64(secs))
        }
        // HTTP status codes from the upstream provider.
        AiError::Api { status, .. } => match *status {
            429 => Some(Duration::from_secs(60)),
            500..=599 => Some(Duration::from_secs(30)),
            // 4xx other than 429 = caller error (bad request, not found,
            // etc.) — same model will keep failing.
            _ => None,
        },
        // Transient network / reqwest errors — short cooldown.
        AiError::Http(_) => Some(Duration::from_secs(10)),
        // Everything else is non-retryable: vendor config, serde,
        // auth, unsupported provider, etc.
        _ => None,
    }
}

/// Run a real LLM-backed discussion.
async fn run_live_discussion(
    app: &AppHandle,
    req: &StartDiscussionRequest,
    global_config: &GlobalModelConfig,
    roles_config: &RoleConfig,
) -> Result<DiscussionPayload, String> {
    // Resolve roles from workflow
    let (default_roles, default_max_rounds) = resolve_workflow_roles(roles_config, req);
    let roles_to_use = req.custom_roles.clone().unwrap_or(default_roles);
    let max_rounds = req.max_rounds.unwrap_or(default_max_rounds).max(1);

    // Build role agents with their priority-ordered model chains.
    // `build_chain_for_role` resolves the chain ids to live `AiClient`s,
    // skipping any chain entry whose model id isn't in `models.yaml`
    // (so a stale chain never poisons the whole discussion).
    let mut agents: Vec<RoleAgent> = Vec::new();
    for role_id in &roles_to_use {
        let (agent_name, icon, system_prompt, temperature) = get_role_info(roles_config, role_id);
        let chain = build_chain_for_role(global_config, roles_config, role_id)?;
        agents.push(RoleAgent {
            id: role_id.clone(),
            name: agent_name,
            icon,
            system_prompt,
            temperature,
            chain,
            cooldown: Mutex::new(HashMap::new()),
        });
    }

    if agents.is_empty() {
        return Err("没有可用的角色".to_string());
    }

    // Run rounds
    let mut turns: Vec<TurnPayload> = Vec::new();
    let mut total_input_tokens = 0u32;
    let mut total_output_tokens = 0u32;

    for round in 0..max_rounds {
        for (idx, agent) in agents.iter().enumerate() {
            let transcript: String = turns
                .iter()
                .map(|t| format!("**{} ({})**: {}", t.agent, t.role_id, t.response))
                .collect::<Vec<_>>()
                .join("\n\n");

            let user_message = if turns.is_empty() {
                format!("{}\n\nTopic: {}\n\nPlease share your perspective.", agent.system_prompt, req.topic)
            } else {
                format!(
                    "{}\n\nTopic: {}\n\nPrevious discussion:\n{}\n\nPlease continue based on the above discussion.",
                    agent.system_prompt, req.topic, transcript
                )
            };

            let messages = vec![Message {
                role: MessageRole::User,
                content: user_message.into(),
            }];

            let params = GenerateParams {
                temperature: Some(agent.temperature),
                max_tokens: Some(8192),
                ..Default::default()
            };
            let completion: Completion = agent.chat_with_fallback(&messages, &params).await?;

            total_input_tokens += completion.usage.input_tokens;
            total_output_tokens += completion.usage.output_tokens;

            let turn = TurnPayload {
                agent: agent.name.clone(),
                role_id: agent.id.clone(),
                icon: agent.icon.clone(),
                response: completion.content.clone(),
                round,
                step_id: format!("step_{}", idx),
                turn_number: turns.len(),
            };

            let _ = app.emit("chat:turn", &turn);
            turns.push(turn);
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    let max_round_seen = turns.iter().map(|t| t.round).max().unwrap_or(0);
    let rounds: Vec<RoundPayload> = (0..=max_round_seen)
        .map(|round| RoundPayload {
            number: round,
            turns: turns.iter().filter(|t| t.round == round).cloned().collect(),
            consensus_reached: true,
        })
        .collect();

    Ok(DiscussionPayload {
        rounds,
        consensus_reached: true,
        summary: Some(format!("Discussion complete: {}", req.topic)),
        total_input_tokens,
        total_output_tokens,
        stub: false,
    })
}

fn resolve_workflow_roles(roles_config: &RoleConfig, req: &StartDiscussionRequest) -> (Vec<String>, usize) {
    if let Some(wf) = roles_config.workflows.get(&req.workflow) {
        return (wf.roles.clone(), wf.max_rounds);
    }
    if let Some((_, _, roles, rounds, _)) = WORKFLOW_PRESETS.iter().find(|(id, _, _, _, _)| *id == req.workflow) {
        return (roles.iter().map(|s| s.to_string()).collect(), *rounds);
    }
    (default_role_ids().iter().map(|s| s.to_string()).collect(), 1)
}

fn get_role_info(roles_config: &RoleConfig, role_id: &str) -> (String, String, String, f64) {
    if let Some(role_def) = roles_config.roles.get(role_id) {
        return (role_def.name.clone(), role_def.icon.clone(), role_def.prompt.clone(), role_def.temperature);
    }
    let template = ROLE_TEMPLATES.iter().find(|(id, _, _)| *id == role_id);
    match template {
        Some((id, icon, tmpl)) => (id.to_string(), icon.to_string(), tmpl.to_string(), 0.5),
        None => (role_id.to_string(), "💬".to_string(), "You are a helpful assistant.".to_string(), 0.5),
    }
}

/// Build the priority-ordered `(ModelDef, AiClient)` chain for a role.
///
/// Resolution order:
/// 1. `RoleDef::chain()` (explicit `model_chain`, or the legacy
///    single `model` field wrapped as a one-element chain)
/// 2. `global_config.default_model` as a last-resort fallback
///
/// Chain entries whose id is missing from the global catalog are
/// silently skipped (a stale config must not poison the whole
/// discussion). Returns an error only if no usable model can be
/// resolved at all.
fn build_chain_for_role(
    global_config: &GlobalModelConfig,
    roles_config: &RoleConfig,
    role_id: &str,
) -> Result<Vec<ChainEntry>, String> {
    // 1. Resolve the chain id list for this role.
    let mut ids: Vec<String> = roles_config
        .roles
        .get(role_id)
        .map(|r| r.chain())
        .unwrap_or_default();

    // 2. Fall back to the global default if the role has no chain.
    if ids.is_empty() {
        ids.push(global_config.default_model.clone());
    }

    // 3. Map ids → (ModelDef, AiClient) pairs, preserving order and
    //    skipping any id that isn't in the global catalog.
    let mut entries: Vec<ChainEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue; // dedup
        }
        let Some(def) = global_config.models.iter().find(|m| m.id == id).cloned() else {
            eprintln!(
                "[chat] role '{}' chain references unknown model '{}' — skipping",
                role_id, id
            );
            continue;
        };
        let client = build_client(&def)?;
        entries.push(ChainEntry {
            def: Arc::new(def),
            client,
        });
    }

    if entries.is_empty() {
        return Err(format!(
            "Role '{}' has no usable model (chain entries all unknown and no default model configured)",
            role_id
        ));
    }
    Ok(entries)
}

fn build_client(model_def: &super::global_config::ModelDef) -> Result<AiClient, String> {
    let api_key = global_config::expand_env_vars(&model_def.api_key);
    if api_key.starts_with("${") || api_key.is_empty() {
        return Err(format!(
            "API key for model '{}' not configured.\nPlease set api_key for provider '{}' in ~/.latte/models.yaml.",
            model_def.id, model_def.provider
        ));
    }

    let api_type = match model_def.api.as_str() {
        "anthropic" => ApiType::AnthropicMessages,
        _ => ApiType::OpenAiCompletions,
    };

    let base_url = if model_def.base_url.is_empty() {
        match model_def.provider.as_str() {
            "anthropic" => "https://api.anthropic.com".to_string(),
            "deepseek" => "https://api.deepseek.com".to_string(),
            "openai" => "https://api.openai.com".to_string(),
            _ => String::new(),
        }
    } else {
        model_def.base_url.clone()
    };

    let model = Model {
        id: model_def.id.clone(),
        name: model_def.name.clone(),
        api: api_type,
        provider: model_def.provider.clone(),
        base_url,
        api_key,
        context_window: model_def.context_window,
        max_tokens: model_def.max_tokens,
        supports_thinking: model_def.reasoning,
        cost_per_million_input: model_def.cost_per_million_input,
        cost_per_million_output: model_def.cost_per_million_output,
    };

    AiClient::new(model).map_err(|e| format!("Failed to create AI client: {}", e))
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

    let preset = WORKFLOW_PRESETS.iter().find(|(name, _, _, _, _)| *name == req.workflow);
    let roles: Vec<String> = match preset {
        Some((_, _, default_roles, _, _)) => req
            .custom_roles
            .clone()
            .unwrap_or_else(|| default_roles.iter().map(|s| s.to_string()).collect()),
        None => req
            .custom_roles
            .clone()
            .unwrap_or_else(|| default_role_ids().iter().map(|s| s.to_string()).collect()),
    };

    let total_rounds = req.max_rounds.unwrap_or(1).max(1);
    let mut rounds: Vec<RoundPayload> = Vec::new();
    let mut total_input_tokens: u32 = 0;
    let mut total_output_tokens: u32 = 0;

    for round_num in 0..total_rounds {
        let mut turns: Vec<TurnPayload> = Vec::new();
        for (idx, role_id) in roles.iter().enumerate() {
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

            let turn = TurnPayload {
                agent: rid.to_string(),
                role_id: rid.to_string(),
                icon: icon.to_string(),
                response: response.clone(),
                round: round_num,
                step_id: format!("step_{}", idx),
                turn_number: turns.len(),
            };
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
    use latte_ai::error::AiError;

    /// `cooldown_for_error` 决定一个失败的模型要冷却多久（None = 不冷却、
    /// 立即把错误原样抛给用户）。这套语义是 chat panel 整条 fallback 链路的
    /// 基础，所以每个分支都得有专门的测试：
    /// - 429 / 5xx / RateLimited 是供应商告诉我们的"等一会就好"
    /// - 4xx (除 429) 是用户配置写错了——同一模型再试也还是失败
    /// - Auth/Config/Serialization 等内部错不能因为换模型就消失

    #[test]
    fn rate_limited_respects_retry_after_floored_at_1s() {
        let e = AiError::RateLimited {
            retry_after: 0.1, // 极小值 — floor 1s 必须生效
            message: "slow down".into(),
        };
        assert_eq!(
            cooldown_for_error(&e),
            Some(Duration::from_secs(1)),
            "retry_after < 1s should be floored to 1s, never 0"
        );

        let e = AiError::RateLimited {
            retry_after: 12.5,
            message: "x".into(),
        };
        assert_eq!(
            cooldown_for_error(&e),
            Some(Duration::from_millis(12_500)),
            "retry_after should be passed through verbatim"
        );
    }

    #[test]
    fn api_429_is_cooldown_60s() {
        let e = AiError::Api {
            status: 429,
            message: "rate limit".into(),
        };
        assert_eq!(cooldown_for_error(&e), Some(Duration::from_secs(60)));
    }

    #[test]
    fn api_5xx_is_cooldown_30s() {
        for status in [500u16, 502, 503, 504, 599] {
            let e = AiError::Api {
                status,
                message: "upstream down".into(),
            };
            assert_eq!(
                cooldown_for_error(&e),
                Some(Duration::from_secs(30)),
                "status {status} should be 30s cooldown"
            );
        }
    }

    #[test]
    fn api_4xx_other_than_429_is_not_cooldown() {
        // 400/401/403/404 — caller-fault. Same model will keep failing
        // for the same reason, so putting it on cooldown just hides the
        // error from the user.
        for status in [400u16, 401, 403, 404, 422] {
            let e = AiError::Api {
                status,
                message: "client error".into(),
            };
            assert_eq!(
                cooldown_for_error(&e),
                None,
                "status {status} must not be cooled down"
            );
        }
    }

    #[test]
    fn non_retryable_errors_are_not_cooldown() {
        // Auth / Config / Serialization / etc. — the problem is in our
        // config or credentials, not the model. Rotating to a fallback
        // model won't help; the user needs to see the error.
        let cases = [
            AiError::Auth("bad key".into()),
            AiError::Config("missing field".into()),
            AiError::UnsupportedProvider("foo".into()),
            AiError::ModelNotFound("foo".into()),
            AiError::Stream("interrupted".into()),
            AiError::Other("oops".into()),
        ];
        for e in cases {
            assert_eq!(
                cooldown_for_error(&e),
                None,
                "{e:?} must not be cooled down"
            );
        }
    }
}
