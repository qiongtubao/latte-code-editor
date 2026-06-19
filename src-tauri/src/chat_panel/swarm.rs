//! Swarm-mode runtime for the chat panel.
//!
//! A "swarm" handles open-ended tasks where the steps aren't known up
//! front: a planner role breaks the topic into a small set of worker
//! steps, the workers execute them in order, and a final synthesis step
//! writes the summary. Modeled after `oh-my-pi`'s `swarm-extension`, but
//! reusing the existing `DiscussionOrchestrator` instead of spawning
//! fresh subagents — every step runs in-process against the model
//! resolver / cooldown machinery we already trust for `discuss` /
//! `plan` / `debug`.
//!
//! Output layout (created on first run, reused across runs in the same
//! workspace):
//!
//! ```text
//! <workspace>/.swarm_<name>/
//!   state.json     — last-run state (steps, timings, summary path)
//!   plan.md        — planner's emitted step list
//!   steps/
//!     <step-id>.md — one file per worker step (full prompt + response)
//!   summary.md     — synthesis step's final markdown
//! ```
//!
//! The runtime emits `chat:swarm_event` with `kind` in
//! `{plan, step, summary, file, complete, error}` so the UI can render
//! streamed planner + worker output distinctly from regular chat
//! discussion.
//!
//! Stub mode (no API keys / `LATTE_CHAT_LIVE=0`) reuses the existing
//! `ROLE_TEMPLATES` and a hard-coded planner stub so the UX is testable
//! without LLM access.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::global_config::{
    load_global_models, load_roles_config, RoleConfig, WorkflowKind,
};
use super::session::{build_turn_payload, run_discussion};
use super::types::{
    SwarmEvent, SwarmStepSpec, StartDiscussionRequest, TurnPayload,
};

/// Maximum worker steps the planner may emit. Mirrors
/// `WorkflowDef::max_steps` default but also acts as a hard ceiling
/// during stub planning so the stub can't spin forever.
const HARD_MAX_STEPS: usize = 8;

/// Default planner role when the workflow leaves `planner_role` empty.
/// The `manager` role is shipped by every default config and has the
/// "decide / prioritize" prompt that suits breaking a topic into
/// ordered steps.
const DEFAULT_PLANNER_ROLE: &str = "manager";

/// One persisted run summary. Written on completion so future runs can
/// show last-run state even if the user closes the chat.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmState {
    pub name: String,
    pub topic: String,
    pub workspace: String,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub steps: Vec<SwarmStepSpec>,
    pub summary_path: Option<String>,
}

/// Resolve the workspace root for swarm persistence.
///
/// Priority:
/// 1. `LATTE_WORKSPACE` env var (lets the chat panel pin a workspace
///    without coupling to Tauri window state).
/// 2. Current working directory.
fn swarm_workspace_root() -> PathBuf {
    if let Ok(p) = std::env::var("LATTE_WORKSPACE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// `<workspace>/.swarm_<name>` — created if missing. Returns the
/// canonical path so callers can read it back.
fn ensure_swarm_dir(workspace: &Path, name: &str) -> std::io::Result<PathBuf> {
    let dir = workspace.join(format!(".swarm_{}", sanitize(name)));
    std::fs::create_dir_all(dir.join("steps"))?;
    Ok(dir)
}

/// Strip path separators from a swarm name so the directory can't
/// escape the workspace root. Anything non-alphanumeric becomes `_`.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

/// Plan prompt given to the planner agent. Forces a small, structured
/// response so the runtime can parse it deterministically.
const PLANNER_PROMPT: &str = "\
You are the swarm planner. Break the user's topic into a small, ordered
list of worker steps. Each step is one role doing one concrete thing.

Topic: {{topic}}

Worker roles available:
{{worker_roles}}

Output ONLY a YAML list, no prose before or after, no markdown fence:

steps:
  - id: <short-kebab-id>
    role: <role-id>
    instruction: <one concrete sentence>
  - id: ...
    role: ...
    instruction: ...

Rules:
- Maximum {{max_steps}} steps. Fewer is better; 1 is acceptable.
- Each step's `role` must be one of the worker roles listed above.
- Steps execute sequentially; later steps see earlier outputs.
- If the topic is trivial, return a single step and end.
";

/// Synthesis prompt — runs after all worker steps to produce the final
/// human-readable summary that lands in `.swarm_<name>/summary.md`.
const SYNTHESIS_PROMPT: &str = "\
You are the swarm synthesizer. Read the user's topic and each
worker's output below, then write a concise final answer in markdown.

Topic: {{topic}}

Worker outputs:
{{transcript}}

Write the final answer only — no preamble, no meta-commentary. Use
markdown headings and bullet lists where helpful.";

/// Run a swarm-mode discussion.
///
/// `app` — Tauri handle for emitting `chat:swarm_event`.
/// `name` — swarm id (matches `roles.yaml`'s workflow id when launched
///   from the dropdown; arbitrary when launched ad-hoc).
/// `topic` — the user's task.
/// `workspace` — optional explicit workspace root; defaults to
///   `swarm_workspace_root()`.
pub async fn run_swarm(
    app: &AppHandle,
    name: &str,
    topic: &str,
    workspace: Option<&str>,
) -> Result<SwarmState, String> {
    let workspace_root = workspace
        .map(PathBuf::from)
        .unwrap_or_else(swarm_workspace_root);
    let swarm_dir = ensure_swarm_dir(&workspace_root, name)
        .map_err(|e| format!("create swarm dir {:?}: {e}", swarm_dir_path(&workspace_root, name)))?;

    let roles_config = load_roles_config();
    let wf = roles_config
        .workflows
        .get(name)
        .cloned()
        // Allow launching a swarm by name even if it's not in
        // `roles.yaml` (the UI's "auto" mode does this). The kind
        // defaults to swarm; planner falls back to manager.
        .unwrap_or_else(default_swarm_workflow);

    // Force-kind guard: if someone hands us a planned workflow here we
    // still run it as a swarm — the user explicitly chose swarm mode.
    let planner_role = if wf.planner_role.is_empty() {
        DEFAULT_PLANNER_ROLE.to_string()
    } else {
        wf.planner_role.clone()
    };
    let worker_roles: Vec<String> = if wf.worker_roles.is_empty() {
        roles_config
            .roles
            .keys()
            .filter(|id| id.as_str() != planner_role.as_str())
            .cloned()
            .collect()
    } else {
        wf.worker_roles.clone()
    };
    let max_steps = wf.max_steps.min(HARD_MAX_STEPS).max(1);

    let started_at_ms = now_ms();
    let mut state = SwarmState {
        name: name.to_string(),
        topic: topic.to_string(),
        workspace: workspace_root.to_string_lossy().to_string(),
        started_at_ms,
        finished_at_ms: None,
        steps: Vec::new(),
        summary_path: None,
    };

    // Decide live vs stub. Live requires an API key + planner role
    // available + planner's role has at least one model in its chain.
    let global_config = load_global_models();
    let force_stub = std::env::var("LATTE_CHAT_LIVE")
        .map(|v| v == "0")
        .unwrap_or(false);
    let has_api_key = global_config.has_api_key();
    let planner_registered = roles_config.roles.contains_key(&planner_role);

    let use_stub = force_stub || !has_api_key || !planner_registered;

    let plan_steps = if use_stub {
        stub_plan(topic, &worker_roles, max_steps)
    } else {
        match live_plan(app, topic, &planner_role, &worker_roles, max_steps).await {
            Ok(steps) if !steps.is_empty() => steps,
            Ok(_) => stub_plan(topic, &worker_roles, max_steps),
            Err(e) => {
                emit_swarm_event(
                    app,
                    SwarmEvent {
                        kind: "error".into(),
                        swarm_id: name.to_string(),
                        steps: None,
                        turn: None,
                        content: Some(format!("planner failed: {e}; falling back to stub plan")),
                        path: None,
                        file_kind: None,
                    },
                );
                stub_plan(topic, &worker_roles, max_steps)
            }
        }
    };

    // Persist the plan first — even if a worker fails, the user can
    // inspect what the swarm intended to do.
    let plan_path = swarm_dir.join("plan.md");
    let plan_md = render_plan_md(topic, &plan_steps);
    if let Err(e) = std::fs::write(&plan_path, &plan_md) {
        emit_swarm_event(
            app,
            SwarmEvent {
                kind: "error".into(),
                swarm_id: name.to_string(),
                steps: None,
                turn: None,
                content: Some(format!("write plan.md: {e}")),
                path: None,
                file_kind: None,
            },
        );
    } else {
        emit_swarm_event(
            app,
            SwarmEvent {
                kind: "file".into(),
                swarm_id: name.to_string(),
                steps: None,
                turn: None,
                content: None,
                path: Some(plan_path.to_string_lossy().to_string()),
                file_kind: Some("plan".into()),
            },
        );
    }
    emit_swarm_event(
        app,
        SwarmEvent {
            kind: "plan".into(),
            swarm_id: name.to_string(),
            steps: Some(plan_steps.clone()),
            turn: None,
            content: None,
            path: None,
            file_kind: None,
        },
    );
    state.steps = plan_steps.clone();

    // Execute each step. We always run steps sequentially through the
    // same orchestrator to keep tool-state coherent. Worker prompts
    // include the planner's instruction + previous transcripts.
    let mut transcript = String::new();
    let total_steps = plan_steps.len();
    for (idx, step) in plan_steps.iter().enumerate() {
        let prompt = format!(
            "You are {role}. {instruction}\n\nTopic: {topic}\n\n\
             Previous steps in this swarm:\n{transcript}",
            role = step.role,
            instruction = step.instruction,
            topic = topic,
            transcript = if transcript.is_empty() {
                "(none — you are the first step)".to_string()
            } else {
                transcript.clone()
            },
        );

        let response = if use_stub {
            stub_step_response(&step.role, topic, idx, total_steps)
        } else {
            // Reuse the existing planned-discussion runner with a
            // synthetic single-role workflow so we get the same
            // streaming / cooldown / chain-walking semantics for free.
            let req = StartDiscussionRequest {
                topic: prompt.clone(),
                workflow: format!("__swarm_step_{}", idx),
                custom_roles: Some(vec![step.role.clone()]),
                max_rounds: Some(1),
            };
            match run_discussion(app, &req).await {
                Ok(payload) => payload
                    .rounds
                    .first()
                    .and_then(|r| r.turns.first())
                    .map(|t| t.response.clone())
                    .unwrap_or_else(|| "(empty worker response)".to_string()),
                Err(e) => format!("worker `{}` failed: {}", step.role, e),
            }
        };

        let turn = build_turn_payload(
            0,
            idx,
            &step.role,
            &step.role,
            &icon_for(&roles_config, &step.role),
            response.clone(),
            step.id.clone(),
            idx,
        );
        emit_swarm_event(
            app,
            SwarmEvent {
                kind: "step".into(),
                swarm_id: name.to_string(),
                steps: None,
                turn: Some(turn.clone()),
                content: None,
                path: None,
                file_kind: None,
            },
        );

        // Persist the per-step artifact (prompt + response).
        let step_md = format!(
            "# Step {n}: {role} ({id})\n\n## Instruction\n\n{instruction}\n\n## Response\n\n{response}\n",
            n = idx + 1,
            role = step.role,
            id = step.id,
            instruction = step.instruction,
            response = response,
        );
        let step_path = swarm_dir.join("steps").join(format!("{}.md", step.id));
        let _ = std::fs::write(&step_path, &step_md);
        emit_swarm_event(
            app,
            SwarmEvent {
                kind: "file".into(),
                swarm_id: name.to_string(),
                steps: None,
                turn: None,
                content: None,
                path: Some(step_path.to_string_lossy().to_string()),
                file_kind: Some("output".into()),
            },
        );

        // Build transcript for the next step + synthesis.
        transcript.push_str(&format!("\n[{} / {}]: {}\n", step.role, step.id, response));
        // Cap transcript growth so step N doesn't see step 1 verbatim
        // 5000 tokens in. Truncating the front keeps the most recent
        // context.
        if transcript.len() > 12_000 {
            let drop = transcript.len() - 12_000;
            transcript.drain(..drop);
        }

        // Tiny pacing in stub mode so the streaming UX is observable
        // without a real LLM.
        if use_stub {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    // Synthesis step. Always emits, even in stub mode (so the chat
    // panel has something to land on). For swarm-mode flows the
    // synthesis uses the planner role again — they have the
    // "decide / synthesize" prompt shape.
    let summary_prompt = SYNTHESIS_PROMPT
        .replace("{{topic}}", topic)
        .replace("{{transcript}}", &transcript);
    let summary = if use_stub {
        stub_synthesis(topic, &plan_steps, &transcript)
    } else {
        let req = StartDiscussionRequest {
            topic: summary_prompt,
            workflow: format!("__swarm_synth_{}", name),
            custom_roles: Some(vec![planner_role.clone()]),
            max_rounds: Some(1),
        };
        match run_discussion(app, &req).await {
            Ok(payload) => payload
                .rounds
                .first()
                .and_then(|r| r.turns.first())
                .map(|t| t.response.clone())
                .unwrap_or_else(|| format!("# {topic}\n\n_(no summary produced)_")),
            Err(e) => format!("_synthesis failed: {e}_\n\n## Transcript\n\n{transcript}"),
        }
    };

    let summary_path = swarm_dir.join("summary.md");
    if let Err(e) = std::fs::write(&summary_path, &summary) {
        emit_swarm_event(
            app,
            SwarmEvent {
                kind: "error".into(),
                swarm_id: name.to_string(),
                steps: None,
                turn: None,
                content: Some(format!("write summary.md: {e}")),
                path: None,
                file_kind: None,
            },
        );
    } else {
        state.summary_path = Some(summary_path.to_string_lossy().to_string());
        emit_swarm_event(
            app,
            SwarmEvent {
                kind: "file".into(),
                swarm_id: name.to_string(),
                steps: None,
                turn: None,
                content: None,
                path: Some(summary_path.to_string_lossy().to_string()),
                file_kind: Some("summary".into()),
            },
        );
    }
    emit_swarm_event(
        app,
        SwarmEvent {
            kind: "summary".into(),
            swarm_id: name.to_string(),
            steps: None,
            turn: None,
            content: Some(summary),
            path: None,
            file_kind: None,
        },
    );

    state.finished_at_ms = Some(now_ms());
    let state_path = swarm_dir.join("state.json");
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(&state_path, json);
    }

    emit_swarm_event(
        app,
        SwarmEvent {
            kind: "complete".into(),
            swarm_id: name.to_string(),
            steps: None,
            turn: None,
            content: None,
            path: None,
            file_kind: None,
        },
    );
    Ok(state)
}

fn swarm_dir_path(workspace: &Path, name: &str) -> PathBuf {
    workspace.join(format!(".swarm_{}", sanitize(name)))
}

/// Render the plan as readable markdown for `.swarm_<name>/plan.md`.
fn render_plan_md(topic: &str, steps: &[SwarmStepSpec]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Plan: {}\n\n", topic));
    out.push_str(&format!("Steps: **{}**\n\n", steps.len()));
    for (i, s) in steps.iter().enumerate() {
        out.push_str(&format!(
            "{}. **{}** (`{}`) — {}\n",
            i + 1,
            s.role,
            s.id,
            s.instruction
        ));
    }
    out
}

fn icon_for(roles_config: &RoleConfig, role_id: &str) -> String {
    roles_config
        .roles
        .get(role_id)
        .map(|r| r.icon.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "💬".to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_swarm_event(app: &AppHandle, event: SwarmEvent) {
    let _ = app.emit("chat:swarm_event", &event);
}

/// Default workflow when the swarm is launched ad-hoc (no entry in
/// `roles.yaml` yet). Mirrors the `quick_task` preset shipped in
/// `create_default_roles` — keeping them aligned so the UI dropdown
/// and the ad-hoc "swarm" mode agree on defaults.
fn default_swarm_workflow() -> super::global_config::WorkflowDef {
    super::global_config::WorkflowDef {
        name: "auto-swarm".into(),
        kind: WorkflowKind::Swarm,
        planner_role: DEFAULT_PLANNER_ROLE.into(),
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
    }
}

// ─── Live planner call ───────────────────────────────────────────────
//
// Sends a single role (planner) a structured prompt and parses the
// YAML it returns. Robust to a few real-world LLM quirks: code fences,
// leading prose, comments between steps. Falls back to an empty list
// when nothing parseable comes back so the caller can drop to the
// stub plan.

async fn live_plan(
    _app: &AppHandle,
    topic: &str,
    planner_role: &str,
    worker_roles: &[String],
    max_steps: usize,
) -> Result<Vec<SwarmStepSpec>, String> {
    let worker_list = if worker_roles.is_empty() {
        "(none configured)".to_string()
    } else {
        worker_roles.join(", ")
    };
    let prompt = PLANNER_PROMPT
        .replace("{{topic}}", topic)
        .replace("{{worker_roles}}", &worker_list)
        .replace("{{max_steps}}", &max_steps.to_string());

    let req = StartDiscussionRequest {
        topic: prompt,
        workflow: "__swarm_planner".into(),
        custom_roles: Some(vec![planner_role.to_string()]),
        max_rounds: Some(1),
    };
    // Re-use the discussion runner. We don't care about the typed
    // payload — we only want the planner's first response text.
    let payload = run_discussion(_app, &req).await?;
    let text = payload
        .rounds
        .first()
        .and_then(|r| r.turns.first())
        .map(|t| t.response.clone())
        .unwrap_or_default();
    Ok(parse_plan_yaml(&text, worker_roles, max_steps))
}

/// Parse the planner's response into a list of `SwarmStepSpec`.
///
/// Accepts three forms:
/// - Clean YAML list (`steps: ...`).
/// - YAML fenced in ```yaml ... ``` or ``` ... ```.
/// - YAML list with surrounding prose ("Here's the plan:\n... \nDone.").
///
/// Unknown roles are filtered out (with a warning dropped to the
/// swarm_event error stream) so a hallucinated role doesn't break the
/// runner.
pub(crate) fn parse_plan_yaml(text: &str, worker_roles: &[String], max_steps: usize) -> Vec<SwarmStepSpec> {
    // Strip code fences.
    let stripped = strip_code_fences(text);

    // Find the first YAML list that has `steps:` somewhere.
    let candidate = match extract_steps_block(&stripped) {
        Some(c) => c,
        None => return Vec::new(),
    };

    let parsed: Result<PlanYaml, _> = serde_yaml::from_str(&candidate);
    let plan = match parsed {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    let mut seen_ids: HashMap<String, usize> = HashMap::new();
    for step in plan.steps.into_iter().take(max_steps) {
        if step.role.trim().is_empty() || step.instruction.trim().is_empty() {
            continue;
        }
        if !worker_roles.is_empty() && !worker_roles.iter().any(|r| r == &step.role) {
            // Skip unknown roles silently — the planner will be told
            // the available set on the next run. We don't crash the
            // swarm over a single bad role.
            continue;
        }
        // Disambiguate ids: if two steps share `id`, suffix with -2,
        // -3, etc. Keeps file names safe.
        let base_id = if step.id.trim().is_empty() {
            format!("step-{}", out.len() + 1)
        } else {
            sanitize(&step.id)
        };
        let id = if let Some(n) = seen_ids.get(&base_id).copied() {
            seen_ids.insert(base_id.clone(), n + 1);
            format!("{}-{}", base_id, n + 1)
        } else {
            seen_ids.insert(base_id.clone(), 2);
            base_id.clone()
        };
        out.push(SwarmStepSpec {
            id,
            role: step.role,
            instruction: step.instruction,
        });
    }
    out
}

#[derive(Debug, Deserialize)]
struct PlanYaml {
    #[serde(default)]
    steps: Vec<PlanStep>,
}

#[derive(Debug, Deserialize)]
struct PlanStep {
    #[serde(default)]
    id: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    instruction: String,
}

fn strip_code_fences(s: &str) -> String {
    // If the text contains any ``` fence, return only the contents
    // of the first fence (drop surrounding prose). If no fence is
    // present, return the original text unchanged — most planners
    // emit clean YAML without fences.
    let mut in_fence = false;
    let mut out = String::with_capacity(s.len());
    let mut saw_fence = false;
    for line in s.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            saw_fence = true;
            in_fence = !in_fence;
            continue;
        }
        if !saw_fence || in_fence {
            out.push_str(line);
            out.push('\n');
        }
        // else: prose between / before/after fences when a fence
        // exists — drop it.
    }
    if !saw_fence {
        // No fence found — return the original text unchanged so
        // clean YAML parses directly.
        s.to_string()
    } else {
        out
    }
}

fn extract_steps_block(text: &str) -> Option<String> {
    // Locate the first `steps:` at line start, then return everything
    // from there to EOF (or to the next line that looks like a new
    // top-level YAML key after we've finished the list).
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.trim_start().starts_with("steps:"))?;
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate().skip(start) {
        if i > start && !line.starts_with(' ') && !line.starts_with('\t') && line.contains(':') {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    Some(out)
}

// ─── Stub mode ───────────────────────────────────────────────────────
//
// When no API key is configured (or `LATTE_CHAT_LIVE=0`), produce a
// small deterministic plan from the topic so the UX is fully
// observable. The plan picks the first few worker roles in their
// declared order and emits one instruction per role.

pub(crate) fn stub_plan(topic: &str, worker_roles: &[String], max_steps: usize) -> Vec<SwarmStepSpec> {
    if worker_roles.is_empty() {
        return vec![SwarmStepSpec {
            id: "step-1".into(),
            role: "programmer".into(),
            instruction: format!("Address the topic: {topic}"),
        }];
    }

    // Heuristic: pick a small variety of roles based on the topic.
    // Topics that smell like "design" → pm + architect + programmer;
    // "fix" → programmer + tester; "explain" → tech_writer + pm;
    // otherwise rotate the first N roles from the worker list.
    let lower = topic.to_ascii_lowercase();
    let preferred: Vec<&str> = if lower.contains("design") || lower.contains("architect") {
        vec!["pm", "architect", "programmer"]
    } else if lower.contains("test") || lower.contains("bug") || lower.contains("fix") {
        vec!["tester", "programmer"]
    } else if lower.contains("document") || lower.contains("explain") || lower.contains("summar")
    {
        vec!["tech_writer", "pm"]
    } else if lower.contains("review") {
        vec!["reviewer", "programmer"]
    } else {
        Vec::new()
    };

    let chosen: Vec<String> = if preferred.is_empty() {
        worker_roles.iter().take(max_steps).cloned().collect()
    } else {
        preferred
            .into_iter()
            .filter(|r| worker_roles.iter().any(|w| w == r))
            .take(max_steps)
            .map(String::from)
            .collect()
    };

    let chosen = if chosen.is_empty() {
        worker_roles.iter().take(max_steps).cloned().collect()
    } else {
        chosen
    };

    chosen
        .into_iter()
        .enumerate()
        .map(|(i, role)| SwarmStepSpec {
            id: format!("step-{}", i + 1),
            instruction: stub_step_instruction(&role, topic),
            role,
        })
        .collect()
}

pub(crate) fn stub_step_instruction(role: &str, topic: &str) -> String {
    match role {
        "pm" => format!("Frame the user's need and acceptance criteria for: {topic}"),
        "architect" => format!("Propose an architecture / structure for: {topic}"),
        "programmer" => format!("Implement or describe the code changes for: {topic}"),
        "tester" => format!("Identify edge cases and a test plan for: {topic}"),
        "reviewer" => format!("Review the prior step's output for: {topic}"),
        "security" => format!("Audit the prior step's output for security issues in: {topic}"),
        "devops" => format!("Note deployment / runtime considerations for: {topic}"),
        "designer" => format!("Sketch the UX flow for: {topic}"),
        "tech_writer" => format!("Write the final user-facing explanation of: {topic}"),
        "manager" => format!("Decide scope and priorities for: {topic}"),
        other => format!("Address `{other}` perspective on: {topic}"),
    }
    .to_string()
}

fn stub_step_response(role: &str, topic: &str, idx: usize, total: usize) -> String {
    let instruction = stub_step_instruction(role, topic);
    format!(
        "## Step {n}/{total} — {role}\n\n_{instruction}_\n\n\
         (stub response — no LLM is configured; set DEEPSEEK_API_KEY or \
         LATTE_CHAT_LIVE=0 to force stub mode)\n",
        n = idx + 1,
        total = total,
        role = role,
        instruction = instruction,
    )
}

fn stub_synthesis(topic: &str, steps: &[SwarmStepSpec], transcript: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", topic));
    out.push_str(&format!(
        "_Synthesized from {n} worker step{plural}. Stub mode — no LLM was used._\n\n",
        n = steps.len(),
        plural = if steps.len() == 1 { "" } else { "s" },
    ));
    out.push_str("## Plan executed\n\n");
    for (i, s) in steps.iter().enumerate() {
        out.push_str(&format!(
            "{}. **{}** (`{}`): {}\n",
            i + 1,
            s.role,
            s.id,
            s.instruction
        ));
    }
    out.push_str("\n## Worker transcript\n\n");
    // Trim to a sensible preview in the summary; the full transcript
    // lives in the per-step `.md` files.
    if transcript.len() > 2000 {
        out.push_str("```\n");
        out.push_str(&transcript[transcript.len() - 2000..]);
        out.push_str("\n```\n");
    } else {
        out.push_str("```\n");
        out.push_str(transcript);
        out.push_str("\n```\n");
    }
    out
}

