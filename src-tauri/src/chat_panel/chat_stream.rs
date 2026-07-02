//! Single-role chat REPL — mirrors `latte-agent chat --role <id>`.
//!
//! The caller (frontend) sends one user message + conversation history
//! and receives the model's full response string. No stub, no orchestrator,
//! no manager protocol — just the role's system prompt + LLM chain.
//!
//! Architecture:
//!   1. `chat_stream` command loads the project's `roles.yaml` +
//!      `models.yaml`, builds an `AgentRunner` for the target role,
//!      feeds history + the new message to `AgentRunner::run_turn`,
//!      and returns the response text.
//!   2. The frontend maintains the message list (user + assistant turns)
//!      and posts the full history on each send — the backend is stateless.
//!   3. Streaming is intentionally omitted for v1; the CLI is also
//!      non-streaming (spinner → full result). Future work can add
//!      Tauri-event-based chunking if latency becomes a problem.

use tauri::{AppHandle, Emitter};
use serde::{Deserialize, Serialize};
use latte_agent_core::agent::{Agent, AgentRunner};
use latte_agent_core::model_resolver::{ModelResolver, ModelTier};
use latte_ai::models::{Message, Role};

use super::session::{build_agent_config, build_upstream_role};

/// One chat message in the history sent from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatHistoryEntry {
    pub role: String,   // "user" | "assistant"
    pub content: String,
}

/// Payload for the `chat_stream` command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamRequest {
    /// Role id from `roles.yaml` (e.g. `"manager"`, `"programmer"`, `"architect"`).
    #[serde(rename = "roleId")]
    pub role_id: String,
    /// The latest user message content.
    pub content: String,
    /// Previous conversation turns. Each entry is `{role, content}`.
    #[serde(default)]
    pub history: Vec<ChatHistoryEntry>,
}

/// Streamed reply payload — the model's response in full.
/// Sent as `chat:stream_done` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamReply {
    pub role_id: String,
    pub content: String,
}

/// Run one turn of a single-role chat. Returns the model's full response.
/// The frontend manages conversation history and sends it with each turn.
///
/// This mirrors `latte-agent chat --role <role>` — no orchestrator, no
/// stub mode, no manager protocol. If the API key is missing or the
/// model is unreachable, returns an error string the frontend can display.
#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    request: StreamRequest,
) -> Result<StreamReply, String> {
    let role_id = request.role_id.trim().to_string();
    if role_id.is_empty() {
        return Err("role_id cannot be empty".to_string());
    }

    // 1. Load config via config_loader (merged).
    let merged = super::config_loader::load_merged();
    let roles_config = super::global_config::RoleConfig {
        default_model: merged.default_model.clone(),
        roles: merged.roles.iter().map(|(id, tmpl)| (id.clone(), super::session::convert_role_template_to_def(tmpl))).collect(),
        workflows: super::global_config::read_all_workflow_files(),
    };
    let global_config = super::global_config::GlobalModelConfig {
        models: merged.models.models.iter().map(super::session::convert_upstream_to_project_model).collect(),
        default_model: merged.default_model.clone(),
    };

    // 2. Validate the role exists.
    let role_def = roles_config.roles.get(&role_id).ok_or_else(|| {
        let known: Vec<String> = roles_config.roles.keys().cloned().collect();
        format!(
            "role '{}' not found in roles.yaml. Available: {}",
            role_id,
            known.join(", ")
        )
    })?;

    // 3. Build the AgentConfig + ModelResolver (reuses session.rs helpers).
    let agent_config = build_agent_config(
        &global_config,
        &roles_config,
        &[role_id.clone()],
    );
    let resolver = ModelResolver::from_config(&agent_config)
        .map_err(|e| format!("model resolver: {e}"))?;

    // 4. Resolve the model chain. Single-role = only "standard" tier,
    //    chain tail = role_def.chain()[1..].
    let chain = role_def.chain();
    let chain_tail: Vec<String> = chain.iter().skip(1).cloned().collect();
    let resolved_models = resolver
        .resolve_chain(&role_id, ModelTier::Standard, &chain_tail)
        .map_err(|e| format!("model chain for '{role_id}': {e}"))?;
    if resolved_models.is_empty() {
        return Err(format!(
            "no usable model for role '{role_id}'. Check ~/.latte/models.yaml \
             and that the role's chain or default_model_tier resolves to a valid model."
        ));
    }

    // 5. Build the upstream Role (with system prompt) and AgentRunner.
    let role = build_upstream_role(&role_id, role_def, &chain);
    let agent = Agent::new_with_chain(
        role_id.clone(),
        role,
        resolved_models,
        latte_ai::params::GenerateParams::default(),
    )
    .map_err(|e| format!("build agent '{role_id}': {e}"))?;
    let mut runner = AgentRunner::new(agent);

    // 6. Convert history + new message into upstream Message list.
    let mut messages: Vec<Message> = Vec::with_capacity(request.history.len() + 1);
    for entry in &request.history {
        let msg_role = match entry.role.as_str() {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            _ => Role::User, // fallback
        };
        messages.push(Message {
            role: msg_role,
            content: entry.content.clone(),
        });
    }
    // Append the new user message.
    messages.push(Message {
        role: Role::User,
        content: request.content.clone(),
    });

    // 7. Run the model turn.
    let response = runner.run_turn(&messages, None).await.map_err(|e| {
        format!("model call failed for '{role_id}': {e}")
    })?;

    // 8. Emit the full response as a `chat:stream_done` event so the
    //    frontend's listener can route it.
    let reply = StreamReply {
        role_id: role_id.clone(),
        content: response.clone(),
    };
    let _ = app.emit("chat:stream_done", &reply);

    Ok(reply)
}
