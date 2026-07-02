//! ChatController adapter — spawns and manages `ChatController` sessions
//! from Tauri commands. Mirrors the `hil.rs` cache + emit pattern.
//!
//! Each session is identified by a `session_id` (a UUID string returned by
//! `spawn`). The caller keeps the session_id and passes it to subsequent
//! commands (`submit_input`, `pause`, `resume`, `abort`).

use std::collections::HashMap;
use std::sync::Arc;

use latte_agent_core::controller::{ChatController, ChatEvent, ControllerConfig};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::types::ControllerEventPayload;

// ─── In-memory cache ──────────────────────────────────────────────

type CacheMap = HashMap<String, CachedEntry>;

static CACHE: std::sync::LazyLock<Mutex<CacheMap>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

struct CachedEntry {
    controller: Arc<ChatController>,
    _handle: tokio::task::JoinHandle<()>,
}

// ─── Public API (called from commands.rs) ─────────────────────────

/// Spawn a new ChatController session and start forwarding events to
/// the Tauri window via `chat:controller_event`. Stores the session
/// under the given `session_id` in the cache.
///
/// The caller (commands.rs) builds the `ControllerConfig` and passes
/// it in; we only handle the cache + event loop wiring.
pub async fn spawn_controller(
    app: &AppHandle,
    session_id: &str,
    config: ControllerConfig,
) -> Result<(), String> {
    let controller = Arc::new(ChatController::new(128));

    // `spawn()` starts the driver loop and returns a broadcast receiver.
    let mut rx = controller.spawn(config).await;

    // Forward events from the broadcast channel to the Tauri window.
    let app_clone = app.clone();
    let sid = session_id.to_string();
    let handle = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let payload = convert_event(&sid, event);
                    let _ = app_clone.emit("chat:controller_event", &payload);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[controller_adapter] lagged by {n} events for {sid}");
                    continue;
                }
            }
        }
    });

    let mut cache = CACHE.lock();
    cache.insert(
        session_id.to_string(),
        CachedEntry {
            controller,
            _handle: handle,
        },
    );

    Ok(())
}

/// Submit text input to a running session.
pub async fn submit_to_controller(session_id: &str, text: &str) -> Result<(), String> {
    let controller = {
        let cache = CACHE.lock();
        cache
            .get(session_id)
            .map(|e| e.controller.clone())
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };
    controller.submit_input(text).await;
    Ok(())
}

/// Pause a running session.
pub async fn pause_controller(session_id: &str) -> Result<(), String> {
    let controller = {
        let cache = CACHE.lock();
        cache
            .get(session_id)
            .map(|e| e.controller.clone())
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };
    controller.pause().await;
    Ok(())
}

/// Resume a paused session.
pub async fn resume_controller(session_id: &str) -> Result<(), String> {
    let controller = {
        let cache = CACHE.lock();
        cache
            .get(session_id)
            .map(|e| e.controller.clone())
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };
    controller.resume().await;
    Ok(())
}

/// Abort (cancel) a running session and remove it from the cache.
pub async fn abort_controller(session_id: &str) -> Result<(), String> {
    let controller = {
        let cache = CACHE.lock();
        cache
            .get(session_id)
            .map(|e| e.controller.clone())
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };
    controller.abort().await;

    let mut cache = CACHE.lock();
    cache.remove(session_id);
    Ok(())
}

// ─── Internals ────────────────────────────────────────────────────

/// Convert a `ChatEvent` from the agent core into our Tauri-side
/// `ControllerEventPayload` for IPC serialization.
fn convert_event(session_id: &str, event: ChatEvent) -> ControllerEventPayload {
    use super::types::ControllerEventKind;
    ControllerEventPayload {
        session_id: session_id.to_string(),
        kind: ControllerEventKind::from(&event),
        event,
    }
}