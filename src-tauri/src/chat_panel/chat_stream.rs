//! Single-role chat REPL — mirrors `latte-agent chat --role <id>`.
//!
//! When a `session_id` is provided, history is persisted to
//! `~/.latte/chat-sessions/<session_id>.json` via `SessionStore`.
//! The frontend only needs to send the new message; the backend loads
//! prior turns from the store. Without a session_id the legacy
//! stateless path (frontend sends full history) is preserved.
//!
//! Tool calls made by the model during a turn are forwarded to the
//! frontend as `chat:tool_event` Tauri events so users see which
//! tools fired and what they returned.

use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use serde::{Deserialize, Serialize};
use latte_agent_core::agent::{Agent, AgentRunner};
use latte_agent_core::model_resolver::ModelTier;
use latte_agent_core::session_store::{SessionStore, StoredMessage};
use latte_agent_core::trace::{ToolStatus, TraceEvent, TraceSink};
use latte_ai::models::{ContentPart, Message, Role};

use latte_rs_agent_tools::prelude::*;
use super::config_loader;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatHistoryEntry {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamRequest {
    #[serde(rename = "roleId")]
    pub role_id: String,
    pub content: String,
    #[serde(rename = "sessionId", default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub history: Vec<ChatHistoryEntry>,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub primary_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamReply {
    pub role_id: String,
    pub session_id: Option<String>,
    pub model_id: String,
    pub tier: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolEventPayload {
    pub name: String,
    pub args_json: String,
    pub latency_ms: u64,
    pub status: String,
    pub result_preview: String,
    pub session_id: Option<String>,
    pub role_id: String,
}

struct TauriToolSink {
    app: AppHandle,
    session_id: Option<String>,
    role_id: String,
}

impl TraceSink for TauriToolSink {
    fn emit(&self, event: TraceEvent) {
        if let TraceEvent::ToolExec {
            name,
            args_json,
            latency_ms,
            status,
            ..
        } = event
        {
            let (label, value) = match status {
                ToolStatus::Ok(s) => ("ok", s),
                ToolStatus::Err(s) => ("err", s),
            };
            let preview = if value.chars().count() > 240 {
                let cut = value
                    .char_indices()
                    .nth(240)
                    .map(|(i, _)| i)
                    .unwrap_or(value.len());
                format!("{}…", &value[..cut])
            } else {
                value
            };
            let payload = ToolEventPayload {
                name: name.clone(),
                args_json: args_json.clone(),
                latency_ms,
                status: label.to_string(),
                result_preview: preview,
                session_id: self.session_id.clone(),
                role_id: self.role_id.clone(),
            };
            let _ = self.app.emit("chat:tool_event", &payload);
        }
    }
}

fn store() -> Arc<SessionStore> {
    use std::sync::OnceLock;
    static STORE: OnceLock<Arc<SessionStore>> = OnceLock::new();
    STORE.get_or_init(|| Arc::new(SessionStore::new_sync(None))).clone()
}

pub(crate) fn build_tool_manager(allowed: &[String]) -> Result<Arc<dyn latte_rs_agent_tools::types::ToolManager>, String> {
    let mgr = create_tool_manager();
    let rt = tokio::runtime::Handle::current();
    for p in builtin_tool_packages() {
        rt.block_on(mgr.register_package(p)).map_err(|e| format!("register_package: {e}"))?;
    }
    let mut keep: std::collections::HashSet<String> = allowed.iter().flat_map(|s| vec![s.to_lowercase(), s.clone()]).collect();
    if keep.contains("bash") || keep.contains("bash") { keep.insert("exec".to_string()); }
    for tool_id in mgr.get_tool_names() {
        let short = tool_id.rsplit_once('.').map(|(_, s)| s.to_string()).unwrap_or_else(|| tool_id.clone());
        if !(keep.contains(&short) || keep.contains(&tool_id)) { mgr.unregister(&tool_id); }
    }
    Ok(mgr)
}

pub(crate) fn tool_usage_prompt(allowed: &[String]) -> String {
    let _tool_list = allowed.iter().map(|s| match s.as_str() {
        "bash" => "exec".to_string(),
        other => other.to_string(),
    }).collect::<Vec<_>>().join(", ");
    format!(
        r#"

## Tool calling protocol

Use this exact raw format on its own line -- no markdown, no code fences:

When you need a tool, emit:

Plain text -- the markers are literal, copy them character-for-character.

End with a plain text response when done.
"#
    )
}

fn iso_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let s = d.as_secs() as i64;
    let days = s / 86400;
    let t = s % 86400;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        1970 + (days as f64 / 365.25) as u64,
        1 + ((days as f64 / 30.44) as u64 % 12),
        1 + (days as u64 % 28),
        t / 3600, (t % 3600) / 60, t % 60)
}

fn stored_to_msg(sm: &StoredMessage) -> Option<Message> {
    match sm {
        StoredMessage::User { content, .. } => Some(Message { role: Role::User, content: vec![ContentPart::text(content.clone())], tool_call_id: None, tool_calls: None }),
        StoredMessage::Assistant { content, .. } => Some(Message { role: Role::Assistant, content: vec![ContentPart::text(content.clone())], tool_call_id: None, tool_calls: None }),
        _ => None,
    }
}

#[tauri::command]
pub async fn chat_stream(app: AppHandle, request: StreamRequest) -> Result<StreamReply, String> {
    let role_id = request.role_id.trim().to_string();
    if role_id.is_empty() { return Err("role_id cannot be empty".to_string()); }

    let merged = config_loader::load_merged();
    let role_template = merged.roles.get(&role_id).ok_or_else(|| {
        format!("role '{role_id}' not found in merged config. Available: {}", merged.roles.keys().cloned().collect::<Vec<_>>().join(", "))
    })?;
    let allowed_tools = role_template.tools.clone();

    let resolver = config_loader::build_resolver(&merged)
        .ok_or_else(|| "failed to build model resolver from merged config".to_string())?;

    let chain = role_template.model_chain.clone();
    let tier = request.tier.as_deref()
        .and_then(|t| ModelTier::parse(t).ok())
        .unwrap_or_else(|| ModelTier::parse(&role_template.model_tier).unwrap_or(ModelTier::Standard));
    let mut chain_tail: Vec<String> = Vec::with_capacity(1 + chain.len());
    if let Some(ref mid) = request.primary_model_id {
        if !mid.is_empty() && chain.first().map(|s| s.as_str()) != Some(mid.as_str()) {
            chain_tail.push(mid.clone());
        }
    }
    chain_tail.extend(chain.iter().skip(1).cloned());
    let resolved_models = resolver.resolve_chain(&role_id, tier, &chain_tail)
        .map_err(|e| format!("model chain for '{role_id}': {e}"))?;
    if resolved_models.is_empty() { return Err(format!("no usable model for role '{role_id}'.")); }
    let model_id = resolved_models.first().map(|m| m.id.clone()).unwrap_or_default();
    let tier_label = tier.label().to_string();

    // Build the role via RoleTemplate::resolve (replaces build_upstream_role)
    let mut role = role_template
        .resolve(&latte_ai::params::GenerateParams::default())
        .await
        .map_err(|e| format!("failed to resolve role '{role_id}': {e}"))?;
    if !allowed_tools.is_empty() { role.system_prompt.push_str(&tool_usage_prompt(&allowed_tools)); }
    let agent = Agent::new_with_chain(role_id.clone(), role, resolved_models, latte_ai::params::GenerateParams::default())
        .map_err(|e| format!("build agent '{role_id}': {e}"))?;
    let mut runner: AgentRunner = if !allowed_tools.is_empty() {
        AgentRunner::new_with_tools(agent, build_tool_manager(&allowed_tools)?, 0)
    } else {
        AgentRunner::new(agent)
    };
    // Forward every ToolExec as a Tauri event so the UI shows the
    // trace inline (mirrors the CLI's on-stdout ToolExec print).
    let sink: Arc<dyn TraceSink> = Arc::new(TauriToolSink {
        app: app.clone(),
        session_id: request.session_id.clone(),
        role_id: role_id.clone(),
    });
    runner = runner.with_sink(sink);

    // Build messages: from session store or request history.
    let mut messages: Vec<Message> = Vec::new();
    if let Some(ref sid) = request.session_id {
        if let Ok(session) = store().get(sid).await {
            for sm in &session.messages {
                if let Some(msg) = stored_to_msg(sm) { messages.push(msg); }
            }
        }
    } else {
        for entry in &request.history {
            messages.push(Message {
                role: if entry.role == "assistant" { Role::Assistant } else { Role::User },
                content: vec![ContentPart::text(entry.content.clone())],
                tool_call_id: None,
                tool_calls: None,
            });
        }
    }
    messages.push(Message { role: Role::User, content: vec![ContentPart::text(request.content.clone())], tool_call_id: None, tool_calls: None });

    let response = runner.run_turn(&messages, None).await
        .map_err(|e| format!("model call failed for '{role_id}': {e}"))?;

    if let Some(ref sid) = request.session_id {
        if store().get(sid).await.is_err() {
            let _ = store().create(sid, "single", vec![role_id.clone()]).await;
        }
        let _ = store().append_message(sid, StoredMessage::User { content: request.content.clone(), timestamp: iso_now() }).await;
        let _ = store().append_message(sid, StoredMessage::Assistant { role_id: role_id.clone(), content: response.clone(), timestamp: iso_now(), tokens: None }).await;
    }

    let reply = StreamReply {
        role_id: role_id.clone(),
        session_id: request.session_id.clone(),
        model_id,
        tier: tier_label,
        content: response.clone(),
    };
    let _ = app.emit("chat:stream_done", &reply);
    Ok(reply)
}