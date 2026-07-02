//! Session-aware ChatController management.
//!
//! Extends `controller_adapter` with persistence to `SessionStore`.
//! Every event from the ChatController's broadcast channel is persisted
//! to `~/.latte/chat-sessions/<session_id>.json` alongside being forwarded
//! to the Tauri window via `chat:controller_event`.
//!
//! Key design:
//! - Each spawn creates (or continues) a `StoredSession` in the store.
//! - The event-forwarding loop also persists events as `StoredMessage`s.
//! - `SessionStore` handles atomic writes and caching.
//!
//! This module also provides session listing/deletion commands for the UI.

use std::sync::Arc;
use latte_agent_core::controller::{ChatController, ChatEvent, ControllerConfig};
use latte_agent_core::session_store::{
    SessionStore, SessionStoreError, SessionState as SsState,
    StoredSession, StoredMessage, SessionSummary,
};
use latte_agent_core::session::SessionState;
use parking_lot::Mutex as ParkingMutex;
use tauri::{AppHandle, Emitter};

use super::types::ControllerEventPayload;

// Re-use the existing cache for active controller handles.
use super::controller_adapter;

/// Path to the session store relative to latte home.
const SESSIONS_DIR: &str = "chat-sessions";

/// Get-or-create the global SessionStore.
fn store() -> Arc<SessionStore> {
    static STORE: std::sync::OnceLock<Arc<SessionStore>> = std::sync::OnceLock::new();
    STORE.get_or_init(|| {
        let dir = latte_home().join(SESSIONS_DIR);
        // Synchronous creation is fine during startup since we're in OnceLock.
        std::fs::create_dir_all(&dir).ok();
        Arc::new(SessionStore::new_sync(Some(dir)))
    }).clone()
}

/// Resolve latte home (matches existing trace_store pattern).
fn latte_home() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("LATTE_HOME") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(".latte")
}

// ─── Session-aware spawn ────────────────────────────────────────────

/// Spawn a new controller session and persist it to the session store.
/// Creates (or continues) a `StoredSession` before delegating to
/// `controller_adapter::spawn_controller`.
pub async fn spawn_persistent(
    app: &AppHandle,
    session_id: &str,
    chat_type: &str,
    roles: Vec<String>,
    config: ControllerConfig,
) -> Result<(), String> {
    let store = store();

    // Create a new session record if it doesn't exist yet.
    match store.create(session_id, chat_type, roles).await {
        Ok(_) => {}
        Err(SessionStoreError::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Session already exists — we're continuing.
        }
        Err(e) => return Err(format!("session store: {e}")),
    }

    // Set initial state to Running.
    store.set_state(session_id, SsState::Running).await.map_err(|e| format!("store state: {e}"))?;

    // Persist SessionInfo as a system event.
    let now = iso8601_now();
    store.append_message(session_id, StoredMessage::SystemEvent {
        event_type: "session_start".into(),
        message: format!("chat_type={} roles={:?}", chat_type, config.roles),
        timestamp: now,
    }).await.map_err(|e| format!("store append: {e}"))?;

    // Let the existing adapter handle the forwarder loop.
    controller_adapter::spawn_controller(app, session_id, config).await?;

    Ok(())
}

/// Persist a ChatEvent into the session store.
pub async fn persist_event(session_id: &str, event: &ChatEvent) {
    let store = store();
    let ts = iso8601_now();
    let msg: Option<StoredMessage> = match event {
        ChatEvent::RoleTurn { role_id, content, .. } => {
            Some(StoredMessage::Assistant {
                role_id: role_id.clone(),
                content: content.clone(),
                timestamp: ts,
                tokens: None,
            })
        }
        ChatEvent::Paused { reason } => {
            Some(StoredMessage::Paused {
                reason: reason.clone(),
                timestamp: ts,
            })
        }
        ChatEvent::Resumed => {
            Some(StoredMessage::Resumed { timestamp: ts })
        }
        ChatEvent::Status { .. } => None,
        ChatEvent::Done => {
            Some(StoredMessage::SystemEvent {
                event_type: "session_end".into(),
                message: "session completed".into(),
                timestamp: ts,
            })
        }
        ChatEvent::Error { message } => {
            Some(StoredMessage::SystemEvent {
                event_type: "error".into(),
                message: message.clone(),
                timestamp: ts,
            })
        }
        ChatEvent::ToolUse { role_id, tool_name, args } => {
            Some(StoredMessage::ToolCall {
                role_id: role_id.clone(),
                tool_name: tool_name.clone(),
                args: args.clone(),
                timestamp: ts,
            })
        }
        ChatEvent::ToolResult { role_id, tool_name, result } => {
            Some(StoredMessage::ToolResult {
                role_id: role_id.clone(),
                tool_name: tool_name.clone(),
                result: result.clone(),
                timestamp: ts,
            })
        }
        ChatEvent::RoundStarted { round } => {
            Some(StoredMessage::RoundStart {
                round: *round,
                timestamp: ts,
            })
        }
        ChatEvent::RoundEnded { round } => {
            Some(StoredMessage::RoundEnd {
                round: *round,
                timestamp: ts,
            })
        }
        _ => None,
    };

    if let Some(msg) = msg {
        let _ = store.append_message(session_id, msg).await;
        // Update state on Done
        if matches!(event, ChatEvent::Done) {
            let _ = store.set_state(session_id, SsState::Done).await;
        }
    }
}

// ─── Session store queries (used by Tauri commands) ────────────────

/// List all sessions in the store.
pub async fn list_sessions() -> Result<Vec<SessionSummary>, String> {
    store().list().await.map_err(|e| format!("list sessions: {e}"))
}

/// Get a single session by id (includes full message list).
pub async fn get_session(session_id: &str) -> Result<StoredSession, String> {
    store().get(session_id).await.map_err(|e| format!("get session: {e}"))
}

/// Delete a session by id.
pub async fn delete_session(session_id: &str) -> Result<(), String> {
    store().delete(session_id).await.map_err(|e| format!("delete session: {e}"))
}

/// Append a user message to a session (for the "continue session" flow).
/// Called when the controller isn't active but we want to log input.
pub async fn append_user_message(session_id: &str, content: &str) -> Result<(), String> {
    let ts = iso8601_now();
    store().append_message(session_id, StoredMessage::User {
        content: content.to_string(),
        timestamp: ts,
    }).await.map_err(|e| format!("append user msg: {e}"))
}

/// Edit a message at the given index in the session's message list.
pub async fn edit_message(session_id: &str, idx: usize, new_content: &str) -> Result<(), String> {
    let store = store();
    let mut session = store.get(session_id).await.map_err(|e| format!("get session: {e}"))?;
    if idx >= session.messages.len() {
        return Err(format!("message index {idx} out of range (max {})", session.messages.len()));
    }
    // Only allow editing User and Assistant messages.
    match &mut session.messages[idx] {
        StoredMessage::User { content, .. } => {
            *content = new_content.to_string();
        }
        StoredMessage::Assistant { content, .. } => {
            *content = new_content.to_string();
        }
        _ => return Err("can only edit user/assistant messages".into()),
    }
    session.updated_at = iso8601_now();
    store.save(&session).await.map_err(|e| format!("save session: {e}"))
}

// ─── Helpers ─────────────────────────────────────────────────────────

fn iso8601_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let s = secs as i64;
    let days = s / 86400;
    let time_secs = s % 86400;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let sec = time_secs % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        1970 + (days as f64 / 365.25) as u64,
        1 + ((days as f64 / 30.44) as u64 % 12),
        1 + (days as u64 % 28),
        h, m, sec,
    )
}