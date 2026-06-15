//! Manages a running chat discussion session.
//!
//! **Two modes**:
//! - **Live mode** (default when API keys are present): uses real LLMs via
//!   `latte-agent-orchestrator`. Each agent turn is streamed to the
//!   frontend as a `chat:turn` event.
//! - **Stub mode** (fallback when no API keys): emits realistic per-role
//!   templated responses. Useful for UI development without LLM credentials.
//!
//! Use `LATTE_CHAT_LIVE=0` env var to force stub mode for testing.

use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use latte_agent_core::agent::{Agent, AgentRunner};
use latte_agent_core::config::AgentConfig;
use latte_agent_core::model_resolver::{ModelResolver, ModelTier};
use latte_agent_orchestrator::orchestrator::{DiscussionConfig, DiscussionOrchestrator};
use latte_agent_orchestrator::{ConsensusMethod, DiscussionWorkflow, WorkflowStep};
use latte_ai::params::GenerateParams;

use super::config::agents_config_root;
use super::types::*;

/// Workflow presets. Maps a friendly name → (workflow_id, default roles,
/// max_rounds, display label). The user picks one of these in the UI.
pub const WORKFLOW_PRESETS: &[(&str, &str, &[&str], usize, &str)] = &[
    (
        "plan",
        "design_brainstorm",
        &["pm", "architect", "programmer", "designer", "manager"],
        2,
        "🗺️ Plan — design and architect",
    ),
    (
        "code",
        "code_review",
        &["programmer", "reviewer", "security", "tester"],
        1,
        "💻 Code — review and refactor",
    ),
    (
        "debug",
        "bug_triage",
        &["tester", "programmer", "security", "devops", "manager"],
        2,
        "🪲 Debug — triage and fix",
    ),
    (
        "discuss",
        "default_workflow",
        &[
            "pm",
            "architect",
            "programmer",
            "tester",
            "reviewer",
            "devops",
            "manager",
        ],
        3,
        "💬 Discuss — full team discussion",
    ),
];

/// A role stub response (used in stub mode only).
const ROLE_TEMPLATES: &[(&str, &str, &str)] = &[
    (
        "pm",
        "📋",
        "## Requirements Analysis\n\nAs **PM**, I've analyzed **{topic}** and identified the following:\n\n- **User story**: As a developer, I want {topic} so that the workflow is more efficient.\n- **Acceptance criteria**:\n  - [ ] The feature works without disrupting existing flows\n  - [ ] Documentation is updated\n  - [ ] Tests cover the main path\n- **Out of scope**: Performance optimization, multi-tenant support (v1)\n\nKey open question: do we need backward compatibility?\n\n<file_edit path=\"docs/{slug}.md\">Add requirements doc for {topic}</file_edit>",
    ),
    (
        "architect",
        "🏗️",
        "## Architecture Review\n\nLooking at **{topic}** from a system-design perspective:\n\n1. **Module layout** — separate `core/` (logic) from `ui/` (presentation) to keep the dependency graph acyclic.\n2. **State management** — use the existing Zustand store pattern; don't introduce new state libs.\n3. **Async boundaries** — long-running ops go through Tauri commands (Rust), not browser fetches.\n\n**Risks**:\n- Tight coupling between the workflow engine and the file-system layer\n- Missing error boundaries in the React tree\n\n**Tradeoffs**: We could over-engineer with a plugin system now, but YAGNI — defer until we have 3+ use cases.\n\n<file_edit path=\"docs/architecture/{slug}.md\">Add architecture notes for {topic}</file_edit>",
    ),
    (
        "programmer",
        "💻",
        "## Implementation Plan\n\nFor **{topic}**, here's the rough implementation:\n\n```ts\n// src/lib/{slug}.ts\nexport function implement() {\n  // 1. Add a Zustand store action\n  // 2. Wire up the Tauri command\n  // 3. Update the React component to subscribe\n}\n```\n\n**Effort estimate**: ~2-3 hours for a clean implementation including tests.\n\n**Modules to touch**:\n- `src/hooks/use{Topic}Store.ts` — new store\n- `src/api/{slug}.ts` — Tauri invoke wrapper\n- `src/components/{Topic}Panel.tsx` — UI\n\n<file_edit path=\"src/lib/{slug}.ts\">Implement {topic}</file_edit>",
    ),
    (
        "tester",
        "🧪",
        "## Test Strategy\n\nFor **{topic}**, I see the following test surface:\n\n| Area | Type | Coverage |\n|------|------|----------|\n| Store state transitions | Unit | 100% |\n| Tauri command error paths | Integration | All error codes |\n| UI render paths | Component | Smoke + key states |\n\n**Edge cases to cover**:\n- Empty input\n- Concurrent updates (race conditions)\n- Workspace detachment during operation\n- Network failure mid-call\n\n**Regression risk**: The existing `useEditorStore` is heavily used; any change to it touches every open file.\n\n<file_edit path=\"src/lib/{slug}.test.ts\">Add tests for {topic}</file_edit>",
    ),
    (
        "reviewer",
        "🔍",
        "## Code Review\n\nReviewing **{topic}**:\n\n**Positives**:\n- Good separation of concerns\n- Tests are co-located with the code\n- Naming is consistent with the rest of the codebase\n\n**Concerns**:\n- ⚠️ The `onClick` handler is inline and re-created on every render — extract to `useCallback`\n- ⚠️ Magic numbers in the style values — pull out to a const at the top\n- ⚠️ Missing `key` prop warning if we ever map over this list\n\n**Nitpicks**:\n- Prefer `as const` over `as TypeName` for literal types\n- Add a `displayName` for forwardRef compatibility\n\n<file_edit path=\"src/components/{Slug}Panel.tsx\">Apply review feedback for {topic}</file_edit>",
    ),
    (
        "devops",
        "🚀",
        "## Operational Notes\n\nFor **{topic}** in production:\n\n- **Build time**: should not add >2s to `cargo build`\n- **Bundle size**: keep Tauri command count under 30 (currently at ~25)\n- **Logging**: emit a `chat:started` / `chat:completed` event pair for tracing\n\n**CI impact**: low — the new module is in `src/` only, no Rust changes.\n\n**Rollout**: feature-flag behind `LATTE_CHAT=1` so we can disable in the field if needed.\n\n<file_edit path=\".github/workflows/ci.yml\">Add CI step for chat feature</file_edit>",
    ),
    (
        "security",
        "🛡️",
        "## Security Review\n\nFor **{topic}**:\n\n- **Input validation**: any user-typed message flows into the AI prompt — needs length cap and content sanitization\n- **Command injection risk**: the file paths in `<file_edit>` tags come from AI output; must validate they don't escape `folderRoot`\n- **PII risk**: agent responses may include snippets of user code — don't log full responses to a third-party service\n\n**Recommendations**:\n- Add a 4KB cap on `topic` and follow-up `message`\n- Resolve file_edit paths via `Path::join` + canonicalize + assert `starts_with(folderRoot)`\n- Use Tauri's built-in command argument validation\n\n<file_edit path=\"src/chat_panel/validation.ts\">Add input validation for chat</file_edit>",
    ),
    (
        "designer",
        "🎨",
        "## UX Considerations\n\nFor **{topic}**:\n\n- **Discoverability**: the chat panel toggle should be in a visible button, not buried in a menu\n- **Loading state**: streaming responses need a clear \"typing...\" indicator per role\n- **Color coding**: use the role icons as visual anchors — emoji + name + colored border\n- **Keyboard nav**: `Ctrl+Shift+L` to toggle, `Enter` to send, `Shift+Enter` for newline\n\n**Mock wireframe**:\n\n```\n┌─────────────────────────┐\n│ 💬 Chat  [workflow ▼]   │\n├─────────────────────────┤\n│ 👤 User: design the API │\n│ 📋 PM: requirements...  │\n│ 🏗️ Architect: design...  │\n│ [💻 Programmer typing..]│\n├─────────────────────────┤\n│ [input........] [Send]  │\n└─────────────────────────┘\n```\n\n<file_edit path=\"docs/ux/chat-wireframe.md\">Wireframe for chat panel</file_edit>",
    ),
    (
        "tech_writer",
        "📝",
        "## Documentation\n\nFor **{topic}**, the following docs need updating:\n\n- `README.md` — new \"Chat with AI agents\" section\n- `docs/chat-panel.md` — new file: usage, configuration, troubleshooting\n- `docs/superpowers/specs/` — design spec if significant\n\n**Style notes**:\n- Use the existing tone (terse, code-first)\n- Include a 30-second quickstart at the top\n- Link to the role catalog so users know what's available\n\n<file_edit path=\"docs/chat-panel.md\">Document chat panel</file_edit>",
    ),
    (
        "manager",
        "👔",
        "## Decision\n\n**Verdict on {topic}**: ✅ proceed.\n\n**Reasoning**:\n- High user value, moderate implementation cost\n- No blocking dependencies (other than the AI model config)\n- Aligns with the Q3 roadmap\n\n**Timeline**: target 1 week for the full feature, with stub mode shipping first for early feedback.\n\n**Risks accepted**:\n- AI response quality varies by model — we ship with a default and let users override in `models.toml`\n- The 10-role catalog is fixed for v1; custom roles can come in v2\n\n**Next steps**:\n1. Merge the chat panel PR\n2. Demo to the team on Friday\n3. Plan iteration based on feedback\n\n<file_edit path=\"docs/manager-decision-{slug}.md\">Record decision on {topic}</file_edit>",
    ),
];

/// Returns the list of role IDs we ship by default.
pub fn default_role_ids() -> &'static [&'static str] {
    &[
        "pm",
        "architect",
        "programmer",
        "tester",
        "reviewer",
        "devops",
        "security",
        "designer",
        "tech_writer",
        "manager",
    ]
}

/// Run a discussion — uses real LLM if API keys are configured, else stub.
pub async fn run_discussion(
    app: &AppHandle,
    req: &StartDiscussionRequest,
) -> Result<DiscussionPayload, String> {
    // Check whether we have API keys available
    let has_keys = has_any_api_key();
    let force_stub = std::env::var("LATTE_CHAT_LIVE")
        .map(|v| v == "0")
        .unwrap_or(false);

    if has_keys && !force_stub {
        // Try real mode; if it fails, fall back to stub
        match run_live_discussion(app, req).await {
            Ok(payload) => Ok(payload),
            Err(e) => {
                eprintln!("[chat] live mode failed: {e}; falling back to stub");
                run_stub_discussion(app, req).await
            }
        }
    } else {
        run_stub_discussion(app, req).await
    }
}

/// Check if any of the supported API keys is in the environment.
fn has_any_api_key() -> bool {
    ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"]
        .iter()
        .any(|k| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false))
}

/// Resolve workflow id + roles from the user-friendly workflow name.
fn resolve_workflow(req: &StartDiscussionRequest) -> (String, Vec<String>) {
    let preset = WORKFLOW_PRESETS
        .iter()
        .find(|(name, _, _, _, _)| *name == req.workflow)
        .or_else(|| {
            // Also accept the raw discussion.toml id
            if [
                "default_workflow",
                "workflows.design_brainstorm",
                "workflows.code_review",
                "workflows.bug_triage",
            ]
            .contains(&req.workflow.as_str())
            {
                Some(&WORKFLOW_PRESETS[3]) // discuss
            } else {
                None
            }
        });
    if let Some((_, wf_id, default_roles, _, _)) = preset {
        let roles = req
            .custom_roles
            .clone()
            .unwrap_or_else(|| default_roles.iter().map(|s| s.to_string()).collect());
        (wf_id.to_string(), roles)
    } else {
        // Fallback: use custom roles or all defaults
        let roles = req
            .custom_roles
            .clone()
            .unwrap_or_else(|| default_role_ids().iter().map(|s| s.to_string()).collect());
        ("default_workflow".to_string(), roles)
    }
}

/// Build a workflow definition that drives each selected role to speak
/// once per round. We synthesize a simple "all roles speak" workflow
/// rather than parsing discussion.toml — this gives a predictable
/// structure for streaming and avoids depending on the TOML shape.
fn build_workflow(roles: &[String], max_rounds: usize) -> DiscussionWorkflow {
    let steps = roles
        .iter()
        .enumerate()
        .map(|(i, role)| WorkflowStep {
            id: format!("step_{}", i),
            description: format!("{} speaks", role),
            speakers: vec![role.clone()],
            prompt: format!(
                "You are a **{role}** in a multi-agent team discussion.\n\
                 Topic: {{topic}}\n\
                 Previous discussion:\n{{transcript}}\n\n\
                 Share your perspective as the {role}. Be concrete: list decisions, \
                 file paths to edit, or risks. When you propose code changes, wrap them \
                 in <file_edit path=\"...\">description</file_edit> tags so the UI can \
                 render them as clickable links.",
                role = role
            ),
            hooks: vec![],
            output_key: None,
        })
        .collect();
    DiscussionWorkflow {
        name: "code-editor-chat".into(),
        description: "In-editor multi-agent chat".into(),
        steps,
        max_rounds,
        context_token_budget: 32000,
    }
}

/// Run a real LLM-backed discussion. Loads configs from
/// `latte-rs-agents/config/` and streams turns via `chat:turn` events.
async fn run_live_discussion(
    app: &AppHandle,
    req: &StartDiscussionRequest,
) -> Result<DiscussionPayload, String> {
    let config_root = agents_config_root();
    let agents_path = config_root.join("agents.toml");
    let models_path = config_root.join("models.toml");

    if !agents_path.exists() {
        return Err(format!(
            "agents.toml not found at {}",
            agents_path.display()
        ));
    }

    // Load and merge configs
    let mut agent_config =
        AgentConfig::load(agents_path.to_str().unwrap()).map_err(|e| e.to_string())?;
    if models_path.exists() {
        let models_config =
            AgentConfig::load(models_path.to_str().unwrap()).map_err(|e| e.to_string())?;
        agent_config.models = models_config.models;
    } else {
        return Err("models.toml not found".to_string());
    }

    // Build resolver
    let resolver = ModelResolver::from_config(&agent_config).map_err(|e| e.to_string())?;

    // Resolve roles and create agents
    let default_params = GenerateParams::default();
    let (workflow_id, roles) = resolve_workflow(req);
    let max_rounds = req.max_rounds.unwrap_or(1).max(1);
    let mut agents: HashMap<String, AgentRunner> = HashMap::new();
    for role_name in &roles {
        let template = agent_config
            .roles
            .get(role_name)
            .ok_or_else(|| format!("role '{}' not in config", role_name))?;
        let role = template.resolve(&default_params).await.map_err(|e| e.to_string())?;
        let model = resolver
            .resolve(&role.id, ModelTier::Standard)
            .map_err(|e| e.to_string())?;
        let agent = Agent::new(role_name.clone(), role, model, default_params.clone())
            .map_err(|e| e.to_string())?;
        agents.insert(role_name.clone(), AgentRunner::new(agent));
    }

    // Build orchestrator config
    let mut variables = HashMap::new();
    variables.insert("topic".into(), req.topic.clone());
    let config = DiscussionConfig {
        workflow: build_workflow(&roles, max_rounds),
        consensus: ConsensusMethod::NoConsensus,
        max_rounds: Some(max_rounds),
        context_token_budget: 32000,
        variables,
    };
    // Stash workflow_id for debugging
    let _ = workflow_id;

    // Run with streaming callback
    let mut orchestrator = DiscussionOrchestrator::new(agents, config).map_err(|e| e.to_string())?;
    let result = orchestrator
        .run_with_events(|turn| {
            // Emit each turn as it completes
            let payload = TurnPayload {
                agent: turn.agent.clone(),
                role_id: turn.role_id.clone(),
                // Look up the icon from the role metadata we have
                icon: lookup_icon(&turn.role_id),
                response: turn.response.clone(),
                round: turn.round,
                step_id: turn.step_id.clone(),
                turn_number: turn.turn_number,
            };
            let _ = app.emit("chat:turn", &payload);
        })
        .await
        .map_err(|e| e.to_string())?;

    // Convert DiscussionResult → DiscussionPayload
    let rounds: Vec<RoundPayload> = result
        .rounds
        .iter()
        .map(|r| RoundPayload {
            number: r.number,
            turns: r
                .turns
                .iter()
                .map(|t| TurnPayload {
                    agent: t.agent.clone(),
                    role_id: t.role_id.clone(),
                    icon: lookup_icon(&t.role_id),
                    response: t.response.clone(),
                    round: t.round,
                    step_id: t.step_id.clone(),
                    turn_number: t.turn_number,
                })
                .collect(),
            consensus_reached: r.consensus_reached,
        })
        .collect();

    Ok(DiscussionPayload {
        rounds,
        consensus_reached: result.consensus_reached,
        summary: None,
        total_input_tokens: result.total_usage.input_tokens,
        total_output_tokens: result.total_usage.output_tokens,
        stub: false,
    })
}

fn lookup_icon(role_id: &str) -> String {
    ROLE_TEMPLATES
        .iter()
        .find(|(id, _, _)| *id == role_id)
        .map(|(_, icon, _)| icon.to_string())
        .unwrap_or_else(|| "💬".to_string())
}

/// Run a discussion in stub mode — emit fake but realistic turns.
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
    let (_, roles) = resolve_workflow(req);

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
