//! LLM-backed manager decision logic.
//!
//! Split out from `manager.rs` so the stubs / state-machine /
//! persistence concerns stay easy to follow, and so this file can
//! grow with the live-LLM path without bloating the hot stub path.
//!
//! The contract:
//! - `live_manager_decide(app, state)` is async; calls the manager
//!   role's chain via `run_discussion` and parses the response as a
//!   `ManagerAction`.
//! - On any failure (missing API key, parse error, missing JSON
//!   block), returns `Err(String)` with a short reason so the
//!   caller can fall back to `stub_action_for_topic`.
//! - The response format is JSON matching `ManagerAction`. The
//!   manager role's `prompt` field tells the model to emit strict
//!   JSON, but we also strip ```json fences + leading prose in case
//!   the model misbehaves.
//!
//! Caller flow (`manager.rs::start_manager_session`):
//! 1. Try `live_manager_decide` first.
//! 2. If it returns `Ok(action)`, use that.
//! 3. If it returns `Err(_)` (no API key, model garbage, etc.), fall
//!    back to `stub_action_for_topic` so the user can still click
//!    through the UX.

use tauri::AppHandle;

use super::global_config::load_roles_config;
use super::manager::{render_context_summary, take_manager_turn};
use super::session::run_discussion;
use super::types::{ManagerAction, ManagerSessionState, StartDiscussionRequest};

/// Build the user-turn prompt that goes to the manager role when
/// calling the LLM. Kept intentionally short — the manager's own
/// `prompt` field already carries the role description + JSON
/// schema; we only inject runtime state here.
///
/// Format (≈ 400 Chinese chars typical):
/// ```text
/// 话题：{topic}
///
/// 可用 worker 候选池：{candidates}
/// 已派：{steps} 步（上限 {max_steps}）；已决策：{decisions} 次（上限 {max_decisions}）
///
/// # 已发生的对话
/// {transcript_summary}
///
/// # 你的下一动作（严格按 schema 输出 JSON，禁止其他文字）
/// ```
pub(crate) fn build_manager_decision_prompt(state: &ManagerSessionState) -> String {
    let candidates = if state.available_roles.is_empty() {
        "（所有角色）".to_string()
    } else {
        state.available_roles.join("、")
    };
    let transcript_summary = render_context_summary(&state.turns);
    format!(
        "话题：{topic}\n\n可用 worker 候选池：{candidates}\n已派：{steps} 步（上限 {max_steps}）；已决策：{decisions} 次（上限 {max_decisions}）\n\n# 已发生的对话\n{transcript}\n\n# 你的下一动作（严格按 schema 输出 JSON，禁止其他文字）",
        topic = state.topic,
        candidates = candidates,
        steps = state.steps_taken,
        max_steps = state.max_total_steps,
        decisions = state.decisions_taken,
        max_decisions = state.max_user_decisions,
        transcript = transcript_summary,
    )
}

/// Extract the first top-level JSON object from `text`. Handles
/// responses wrapped in ```json ... ``` fences or prefixed with
/// prose like "Sure! Here's the plan:". Used before parsing the
/// manager's response into a `ManagerAction`.
fn extract_json_object(text: &str) -> Option<String> {
    let mut depth: i32 = 0;
    let mut start: Option<usize> = None;
    for (i, ch) in text.char_indices() {
        match ch {
            '{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(s) = start {
                        return Some(text[s..=i].to_string());
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// Ask the manager role's LLM chain for a decision. Returns the
/// parsed `ManagerAction` on success or an error string describing
/// why we couldn't get a usable response.
///
/// The caller (`start_manager_session`) treats any error as
/// "fall back to stub" — so this function never panics, never
/// returns partial actions, and surfaces short error messages.
pub(crate) async fn live_manager_decide(
    app: &AppHandle,
    state: &ManagerSessionState,
) -> Result<ManagerAction, String> {
    let roles_config = load_roles_config();
    let role_def = roles_config
        .roles
        .get(&state.manager_role_id)
        .ok_or_else(|| {
            format!(
                "manager role `{}` not in roles.yaml",
                state.manager_role_id
            )
        })?;
    if role_def.chain().is_empty() {
        return Err(format!(
            "manager role `{}` has no model chain",
            state.manager_role_id
        ));
    }

    let prompt = build_manager_decision_prompt(state);
    let req = StartDiscussionRequest {
        topic: prompt,
        workflow: format!("__manager_decide_{}", state.session_id),
        custom_roles: Some(vec![state.manager_role_id.clone()]),
        max_rounds: Some(1),
    };
    let payload = run_discussion(app, &req).await?;
    let response_text = payload
        .rounds
        .first()
        .and_then(|r| r.turns.first())
        .map(|t| t.response.clone())
        .ok_or_else(|| "manager LLM returned empty response".to_string())?;

    let json = extract_json_object(&response_text).ok_or_else(|| {
        format!(
            "manager LLM response had no JSON object: {}",
            response_text
        )
    })?;
    let action: ManagerAction = serde_json::from_str(&json).map_err(|e| {
        format!(
            "manager LLM response didn't match ManagerAction schema: {e}\n--- raw ---\n{response_text}"
        )
    })?;
    Ok(action)
}

/// Re-export so callers in `manager.rs` can call `take_manager_turn`
/// from this module without re-importing. (Avoids the borrow-checker
/// fighting when both modules reach into each other.)
pub(super) use super::manager::take_manager_turn as _take_manager_turn;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_panel::types::{ManagerSessionState, ManagerState};

    #[test]
    fn extract_json_strips_fences_and_prose() {
        let raw = "Sure! Here's the plan:\n```json\n{\"NeedDecision\":{\"branch_label\":\"x\",\"question\":\"y\",\"reason\":\"z\",\"options\":[]}}\n```\n";
        let j = extract_json_object(raw).expect("should find json");
        assert!(j.starts_with('{') && j.ends_with('}'));
        assert!(j.contains("NeedDecision"));
    }

    #[test]
    fn extract_json_returns_none_for_garbage() {
        assert!(extract_json_object("no json here").is_none());
    }

    #[test]
    fn build_prompt_includes_topic_and_candidates() {
        let state = ManagerSessionState {
            session_id: 1,
            state: ManagerState::Planning,
            topic: "设计一个登录页".into(),
            manager_role_id: "tech_director".into(),
            available_roles: vec!["pm".into(), "architect".into()],
            max_total_steps: 8,
            max_user_decisions: 5,
            steps_taken: 0,
            decisions_taken: 0,
            turns: Vec::new(),
            started_at_ms: 0,
            finished_at_ms: None,
            summary: None,
        };
        let p = build_manager_decision_prompt(&state);
        assert!(p.contains("设计一个登录页"));
        assert!(p.contains("pm") || p.contains("产品经理"));
        assert!(p.contains("architect") || p.contains("架构师"));
        assert!(p.contains("JSON"));
    }
}
