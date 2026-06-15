//! Manages a running chat discussion session.
//!
//! Currently in **stub mode** by default — it emits realistic-looking
//! responses for each role without actually calling any LLM. This lets
//! the UI be developed and demoed without API keys.
//!
//! To enable real LLM calls, set `LATTE_CHAT_LIVE=1` and ensure API
//! keys are configured in `latte-rs-agents/config/models.toml`.

use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::types::*;

/// A role stub response. Multi-paragraph, includes a `<file_edit>`
/// tag at the bottom so the UI can demo the clickable file link.
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
        "## Implementation Plan\n\nFor **{topic}**, here's the rough implementation:\n\n```ts\n// src/lib/{slug}.ts\nexport function implement() {{\n  // 1. Add a Zustand store action\n  // 2. Wire up the Tauri command\n  // 3. Update the React component to subscribe\n}}\n```\n\n**Effort estimate**: ~2-3 hours for a clean implementation including tests.\n\n**Modules to touch**:\n- `src/hooks/use{Topic}Store.ts` — new store\n- `src/api/{slug}.ts` — Tauri invoke wrapper\n- `src/components/{Topic}Panel.tsx` — UI\n\n<file_edit path=\"src/lib/{slug}.ts\">Implement {topic}</file_edit>",
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
        "## Security Review\n\nFor **{topic}**:\n\n- **Input validation**: any user-typed message flows into the AI prompt — needs length cap and content sanitization\n- **Command injection risk**: the file paths in `<file_edit>` tags come from AI output; must validate they don't escape `folderRoot`\n- **PII risk**: agent responses may include snippets of user code — don't log full responses to a third-party service\n\n**Recommendations**:\n- Add a 4KB cap on `topic` and follow-up `message`\n- Resolve `file_edit` paths via `Path::join` + canonicalize + assert `starts_with(folderRoot)`\n- Use Tauri's built-in command argument validation\n\n<file_edit path=\"src/chat_panel/validation.ts\">Add input validation for chat</file_edit>",
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

/// Run a discussion in stub mode — emit fake but realistic turns.
pub async fn run_stub_discussion(
    app: &AppHandle,
    req: &StartDiscussionRequest,
) -> Result<DiscussionPayload, String> {
    let slug = slugify(&req.topic);
    let topic = req.topic.clone();
    let topic_pretty = if topic.is_empty() {
        "the topic".to_string()
    } else {
        topic.clone()
    };
    let roles = req
        .custom_roles
        .clone()
        .unwrap_or_else(|| default_role_ids().iter().map(|s| s.to_string()).collect());

    let total_rounds = req.max_rounds.unwrap_or(1).max(1);
    let mut rounds: Vec<RoundPayload> = Vec::new();
    let mut total_input_tokens: u32 = 0;
    let mut total_output_tokens: u32 = 0;

    for round_num in 0..total_rounds {
        let mut turns: Vec<TurnPayload> = Vec::new();
        for (idx, role_id) in roles.iter().enumerate() {
            // Find the template for this role
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
            // Estimate token counts (very rough): 1 token ≈ 4 chars
            total_input_tokens += (topic.len() / 4) as u32 + 200;
            total_output_tokens += (response.len() / 4) as u32;
            // Emit the streaming event to the frontend
            let _ = app.emit("chat:turn", &turn);
            turns.push(turn);
            // Small artificial delay so the streaming UX is visible
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
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
