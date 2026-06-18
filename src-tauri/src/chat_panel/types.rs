use serde::{Deserialize, Serialize};

/// A single agent turn, sent as a streaming event.
#[derive(Clone, Serialize)]
pub struct TurnPayload {
    pub agent: String,
    pub role_id: String,
    pub icon: String,
    pub response: String,
    pub round: usize,
    pub step_id: String,
    pub turn_number: usize,
}

/// Final result after discussion completes.
#[derive(Clone, Serialize)]
pub struct DiscussionPayload {
    pub rounds: Vec<RoundPayload>,
    pub consensus_reached: bool,
    pub summary: Option<String>,
    pub total_input_tokens: u32,
    pub total_output_tokens: u32,
    pub stub: bool,
}

#[derive(Clone, Serialize)]
pub struct RoundPayload {
    pub number: usize,
    pub turns: Vec<TurnPayload>,
    pub consensus_reached: bool,
}

/// Request from frontend to start a discussion.
#[derive(Clone, Deserialize)]
pub struct StartDiscussionRequest {
    pub topic: String,
    pub workflow: String,
    pub custom_roles: Option<Vec<String>>,
    pub max_rounds: Option<usize>,
}

/// Request to continue with a follow-up question.
#[derive(Clone, Deserialize)]
pub struct ContinueDiscussionRequest {
    pub session_id: usize,
    pub message: String,
}

/// Available workflows list item.
#[derive(Clone, Serialize)]
pub struct WorkflowInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_roles: Vec<String>,
    pub steps: Vec<String>,
}

/// Role info for display in UI.
#[derive(Clone, Serialize)]
pub struct RoleInfo {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub category: String,
    /// Legacy single-model id (deprecated, kept for back-compat in UI).
    /// Equals the first entry of `model_chain` for display.
    pub default_model_tier: String,
    /// Priority-ordered model chain (highest priority first).
    /// The first entry is the primary; the rest are fallbacks tried
    /// in order when earlier models fail.
    pub model_chain: Vec<String>,
}

/// Model info for display in UI.
#[derive(Clone, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub max_tokens: u32,
    pub context_window: u32,
    pub supports_vision: bool,
    pub supports_thinking: bool,
}

/// Response for chat_get_role_config
#[derive(Clone, Serialize)]
pub struct RoleConfigResponse {
    pub default_model: String,
    pub roles: Vec<RoleInfo>,
    pub workflows: Vec<WorkflowInfo>,
    pub models_path: String,
    pub roles_path: String,
}

/// Request from frontend to update a role's priority-ordered model chain.
///
/// `chain[0]` is the primary; the rest are fallbacks tried in order
/// when earlier models fail. An empty chain is rejected by the backend.
#[derive(Clone, Deserialize)]
pub struct SetRoleModelChainRequest {
    pub role_id: String,
    pub chain: Vec<String>,
}
