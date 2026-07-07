# Workspace Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspace switching isolate editor-adjacent panel state and chat runtime state so each workspace keeps its own context.

**Architecture:** Reuse the existing `byWorkspace` projection pattern from `useEditorStore` and `useGraphStore` for chat. Add a serializable chat snapshot to `WorkspaceMeta`, route backend chat events with `workspaceId`, and cancel/evict workspace-owned chat state when a workspace is closed.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri v2 IPC/events, Rust, serde, Vitest, Cargo tests.

---

## File Structure

- Modify `src/hooks/useChatStore.ts`: split runtime chat state into `WorkspaceChat`, project active workspace fields, persist serializable chat snapshots, route events by workspace id, and expose `evictWorkspace`.
- Modify `src/hooks/useChatStore.test.ts`: add focused tests for workspace projection, event routing, persistence hydration, and stale session reset.
- Modify `src/App.tsx`: listen for workspace-tagged chat events and pass `workspaceId` to chat store event handlers.
- Modify `src/api/chat.ts`: add workspace-tagged event wrapper types.
- Modify `src/hooks/useWorkspaceStore.ts`: include `chat_state` in `WorkspaceMeta`; evict chat state on close.
- Modify `src-tauri/src/workspace/registry.rs`: add serializable `PersistedWorkspaceChat` and related metadata fields.
- Modify `src-tauri/src/workspace/commands.rs`: accept and persist `chat_state` through `update_workspace_meta`.
- Modify `src-tauri/src/editor/commands.rs`: initialize new workspaces with empty `chat_state`.
- Modify `src-tauri/src/chat_panel/types.rs`: add `WorkspaceChatEvent<T>` wrapper.
- Modify `src-tauri/src/chat_panel/controller_runtime.rs`: accept `workspace_id` in `start`, wrap emitted events with that id, and expose helper to cancel sessions by workspace id.
- Modify `src-tauri/src/chat_panel/commands.rs`: resolve active workspace id for chat starts and pass it to runtime.
- Modify `src-tauri/src/chat_panel/*_test.rs` or add controller runtime tests where practical: verify event wrapper serialization and workspace cancellation helpers.

## Task 1: Type The Persisted Workspace Chat Snapshot

**Files:**
- Modify: `src-tauri/src/workspace/registry.rs`
- Modify: `src-tauri/src/workspace/commands.rs`
- Modify: `src-tauri/src/editor/commands.rs`
- Test: `src-tauri/src/workspace/registry.rs`

- [ ] **Step 1: Add failing Rust metadata roundtrip test**

Add a test in `src-tauri/src/workspace/registry.rs` under the existing `tests` module:

```rust
#[test]
fn workspace_meta_roundtrips_chat_state() {
    let meta = WorkspaceMeta {
        name: "alpha".to_string(),
        project_root: PathBuf::from("/tmp/alpha"),
        open_tabs: vec![],
        active_tab: None,
        ui_state: UiState::default(),
        last_used_at: 0,
        chat_state: Some(PersistedWorkspaceChat {
            mode: "manager".to_string(),
            messages: vec![PersistedChatMessage {
                id: "m1".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                timestamp: 123,
                agent_icon: None,
                agent_name: None,
            }],
            activity_events: vec![],
            status: "idle".to_string(),
            selected_workflow: "manager_default".to_string(),
            active_swarm_id: None,
            swarm_plan: vec![],
            swarm_files: vec![],
            swarm_summary: None,
            error_message: None,
            last_user_topic: Some("hello".to_string()),
        }),
    };

    let json = serde_json::to_string(&meta).unwrap();
    let decoded: WorkspaceMeta = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.chat_state.unwrap().selected_workflow, "manager_default");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test workspace_meta_roundtrips_chat_state --manifest-path src-tauri/Cargo.toml`

Expected: compile failure because `chat_state`, `PersistedWorkspaceChat`, and `PersistedChatMessage` do not exist.

- [ ] **Step 3: Add serializable Rust types**

In `src-tauri/src/workspace/registry.rs`, add these public structs above `WorkspaceMeta`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: u64,
    #[serde(default)]
    pub agent_icon: Option<String>,
    #[serde(default)]
    pub agent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedChatActivityEvent {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub role_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub detail: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSwarmStepSpec {
    pub id: String,
    pub role: String,
    pub instruction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSwarmFile {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspaceChat {
    pub mode: String,
    #[serde(default)]
    pub messages: Vec<PersistedChatMessage>,
    #[serde(default)]
    pub activity_events: Vec<PersistedChatActivityEvent>,
    pub status: String,
    pub selected_workflow: String,
    #[serde(default)]
    pub active_swarm_id: Option<String>,
    #[serde(default)]
    pub swarm_plan: Vec<PersistedSwarmStepSpec>,
    #[serde(default)]
    pub swarm_files: Vec<PersistedSwarmFile>,
    #[serde(default)]
    pub swarm_summary: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub last_user_topic: Option<String>,
}
```

Then add this field to `WorkspaceMeta`:

```rust
#[serde(default)]
pub chat_state: Option<PersistedWorkspaceChat>,
```

- [ ] **Step 4: Update workspace constructors**

Set `chat_state: None` in every `WorkspaceMeta` literal in:

- `src-tauri/src/workspace/commands.rs`
- `src-tauri/src/editor/commands.rs`
- tests in `src-tauri/src/workspace/registry.rs`
- tests in `src-tauri/src/workspace/persistence.rs`

- [ ] **Step 5: Persist chat state from update command**

In `src-tauri/src/workspace/commands.rs`, import `PersistedWorkspaceChat`, add the field to `UpdateMetaArgs`, destructure it, and update metadata:

```rust
pub chat_state: Option<Option<PersistedWorkspaceChat>>,
```

```rust
if let Some(chat) = chat_state {
    m.chat_state = chat;
}
```

- [ ] **Step 6: Run Rust workspace tests**

Run: `cargo test workspace --manifest-path src-tauri/Cargo.toml`

Expected: all workspace tests pass.

## Task 2: Refactor Chat Store Into Workspace Projections

**Files:**
- Modify: `src/hooks/useChatStore.ts`
- Modify: `src/hooks/useWorkspaceStore.ts`
- Test: `src/hooks/useChatStore.test.ts`

- [ ] **Step 1: Add failing projection tests**

Add tests to `src/hooks/useChatStore.test.ts` that create two workspaces through `useWorkspaceStore.setState`, send or apply messages to each, switch `activeWorkspaceId`, and assert the projected `messages` differ per workspace:

```ts
it("projects chat state for the active workspace", () => {
  useWorkspaceStore.setState({
    workspaces: {
      "ws-a": { name: "a", project_root: "/a", open_tabs: [], active_tab: null, ui_state: defaultUiState(), last_used_at: 1 },
      "ws-b": { name: "b", project_root: "/b", open_tabs: [], active_tab: null, ui_state: defaultUiState(), last_used_at: 2 },
    },
    activeWorkspaceId: "ws-a",
    hydrated: true,
  });

  useChatStore.getState().appendLocalMessageForTest("ws-a", "hello from a");
  useChatStore.getState().appendLocalMessageForTest("ws-b", "hello from b");

  expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(["hello from a"]);
  useWorkspaceStore.setState({ activeWorkspaceId: "ws-b" });
  expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(["hello from b"]);
});
```

If a test-only helper is not desired, use `applyChatEvent({ RoleTurn: ... }, "ws-a")` and `applyChatEvent(..., "ws-b")` instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/hooks/useChatStore.test.ts`

Expected: compile failure or assertion failure because chat state is still global and event handlers do not accept workspace ids.

- [ ] **Step 3: Define workspace chat state helpers**

In `src/hooks/useChatStore.ts`, add `WorkspaceChat`, `PersistedWorkspaceChat`, `emptyChat()`, `projectFrom(byWorkspace, wsId)`, `mutateChat(byWorkspace, wsId, next)`, `serializeChat(chat)`, and `hydrateChat(persisted)`.

`hydrateChat` must convert persisted `status: "running"` to `status: "idle"`, and must not restore `sessionId` or `swarmSessionId`.

- [ ] **Step 4: Update ChatStore interface**

Add:

```ts
byWorkspace: Record<string, WorkspaceChat>;
applyChatEvent: (event: ChatEvent, workspaceId?: string | null) => void;
applySwarmEvent: (event: SwarmEvent, workspaceId?: string | null) => void;
evictWorkspace: (workspaceId: string) => void;
```

Keep global config and workflow editor fields as top-level store fields.

- [ ] **Step 5: Subscribe to workspace changes**

At store creation time, subscribe to `useWorkspaceStore`. When active workspace changes, project the matching `WorkspaceChat`. If a workspace has `meta.chat_state` but no in-memory chat state yet, hydrate from metadata before projecting.

- [ ] **Step 6: Convert all chat mutations to workspace-aware mutations**

Update `setMode`, `setWorkflow`, `sendMessage`, `sendSwarm`, `cancelDiscussion`, `retryLastDiscussion`, `clearChat`, `addTurn`, `setComplete`, `setError`, `applyChatEvent`, and `applySwarmEvent` so runtime fields mutate the active workspace or the event-provided workspace id.

Global config methods remain global.

- [ ] **Step 7: Persist serialized chat snapshots**

After workspace chat mutations, call:

```ts
useWorkspaceStore.getState().updateMeta(workspaceId, {
  chat_state: serializeChat(nextWorkspaceChat),
});
```

The implementation may debounce this call with `setTimeout` keyed by workspace id to keep streaming events from causing excessive writes.

- [ ] **Step 8: Run frontend chat tests**

Run: `pnpm test src/hooks/useChatStore.test.ts`

Expected: all chat store tests pass.

## Task 3: Route Backend Chat Events By Workspace

**Files:**
- Modify: `src-tauri/src/chat_panel/types.rs`
- Modify: `src-tauri/src/chat_panel/controller_runtime.rs`
- Modify: `src-tauri/src/chat_panel/commands.rs`
- Modify: `src/api/chat.ts`
- Modify: `src/App.tsx`
- Test: Rust unit tests where possible and TypeScript typecheck

- [ ] **Step 1: Add wrapper type in Rust**

In `src-tauri/src/chat_panel/types.rs`, add:

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChatEvent<T: Serialize + Clone> {
    pub workspace_id: String,
    pub event: T,
}
```

- [ ] **Step 2: Change controller runtime start signature**

In `src-tauri/src/chat_panel/controller_runtime.rs`, change:

```rust
pub async fn start(
    app: AppHandle,
    request: StartDiscussionRequest,
    project_root: Option<PathBuf>,
    workspace_id: Option<String>,
) -> Result<usize, String>
```

Store `workspace_id.clone()` alongside the session in a new session metadata map or struct.

- [ ] **Step 3: Emit workspace-wrapped events**

Replace direct event emit with:

```rust
if let Some(workspace_id) = workspace_id_for_events.as_ref() {
    let payload = WorkspaceChatEvent {
        workspace_id: workspace_id.clone(),
        event: event.clone(),
    };
    let _ = app_for_events.emit("chat:event", &payload);
} else {
    let _ = app_for_events.emit("chat:event", &event);
}
```

This preserves compatibility for any older caller without a workspace id.

- [ ] **Step 4: Resolve workspace id in command**

In `chat_start_discussion`, keep the current project root lookup, but also keep the id:

```rust
let workspace_id = registry.active_for_window(window.label()).await;
let project_root = if let Some(id) = workspace_id.as_ref() {
    registry.project_root(id).await
} else {
    None
};
super::controller_runtime::start(app, request, project_root, workspace_id).await
```

- [ ] **Step 5: Type workspace event wrapper in frontend**

In `src/api/chat.ts`, add:

```ts
export interface WorkspaceChatEvent<T> {
  workspaceId: string;
  event: T;
}

export function unwrapWorkspaceEvent<T>(
  payload: T | WorkspaceChatEvent<T>,
): { workspaceId: string | null; event: T } {
  if (
    payload &&
    typeof payload === "object" &&
    "workspaceId" in payload &&
    "event" in payload
  ) {
    const wrapped = payload as WorkspaceChatEvent<T>;
    return { workspaceId: wrapped.workspaceId, event: wrapped.event };
  }
  return { workspaceId: null, event: payload as T };
}
```

- [ ] **Step 6: Route event listener in App**

In `src/App.tsx`, listen to `ChatEvent | WorkspaceChatEvent<ChatEvent>` and call:

```ts
const { workspaceId, event } = unwrapWorkspaceEvent(e.payload);
applyChatEvent(event, workspaceId);
```

Do the same for `SwarmEvent` if a `chat:swarm_event` listener is present or added.

- [ ] **Step 7: Run checks**

Run: `pnpm typecheck`

Expected: TypeScript passes.

Run: `cargo test controller_runtime --manifest-path src-tauri/Cargo.toml`

Expected: controller runtime tests pass.

## Task 4: Close Workspace Cleanup And Cancellation

**Files:**
- Modify: `src/hooks/useWorkspaceStore.ts`
- Modify: `src/hooks/useChatStore.ts`
- Modify: `src-tauri/src/chat_panel/controller_runtime.rs`
- Modify: `src-tauri/src/chat_panel/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src/hooks/useChatStore.test.ts` and Rust runtime helper tests

- [ ] **Step 1: Add frontend close cleanup test**

In `src/hooks/useChatStore.test.ts`, assert `evictWorkspace("ws-a")` removes A state while B remains:

```ts
it("evicts only the requested workspace chat state", () => {
  useWorkspaceStore.setState({
    workspaces: {
      "ws-a": { name: "a", project_root: "/a", open_tabs: [], active_tab: null, ui_state: defaultUiState(), last_used_at: 1 },
      "ws-b": { name: "b", project_root: "/b", open_tabs: [], active_tab: null, ui_state: defaultUiState(), last_used_at: 2 },
    },
    activeWorkspaceId: "ws-b",
    hydrated: true,
  });
  useChatStore.getState().appendLocalMessageForTest("ws-a", "a");
  useChatStore.getState().appendLocalMessageForTest("ws-b", "b");

  useChatStore.getState().evictWorkspace("ws-a");
  expect(useChatStore.getState().byWorkspace["ws-a"]).toBeUndefined();
  expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(["b"]);
});
```

- [ ] **Step 2: Add backend cancellation command**

In `controller_runtime.rs`, store session metadata:

```rust
struct SessionEntry {
    controller: Arc<ChatController>,
    workspace_id: Option<String>,
}
```

Change `SESSIONS` to `HashMap<usize, SessionEntry>`.

Add:

```rust
pub async fn cancel_workspace(workspace_id: &str) -> Result<(), String> {
    let sessions = {
        let guard = SESSIONS.lock().await;
        guard
            .iter()
            .filter_map(|(id, entry)| {
                (entry.workspace_id.as_deref() == Some(workspace_id)).then_some(*id)
            })
            .collect::<Vec<_>>()
    };

    for id in sessions {
        cancel(id).await?;
    }
    Ok(())
}
```

- [ ] **Step 3: Expose command**

In `src-tauri/src/chat_panel/commands.rs`, add:

```rust
#[tauri::command]
pub async fn chat_cancel_workspace(workspace_id: String) -> Result<(), String> {
    super::controller_runtime::cancel_workspace(&workspace_id).await
}
```

Register it in `src-tauri/src/lib.rs`.

- [ ] **Step 4: Add frontend API wrapper**

In `src/api/chat.ts`, add:

```ts
export async function cancelWorkspaceDiscussion(workspaceId: string): Promise<void> {
  return invoke("chat_cancel_workspace", { workspaceId });
}
```

- [ ] **Step 5: Call cancellation and evictions on close**

In `useWorkspaceStore.closeWorkspace`, before or after the backend `close_workspace` call:

```ts
await cancelWorkspaceDiscussion(workspaceId).catch((e) =>
  console.error("[useWorkspaceStore] cancel workspace chat failed:", e),
);
useEditorStore.getState().evictWorkspace(workspaceId);
useGraphStore.getState().evictWorkspace(workspaceId);
useChatStore.getState().evictWorkspace(workspaceId);
```

Use dynamic imports if direct imports create store cycles.

- [ ] **Step 6: Run close cleanup tests**

Run: `pnpm test src/hooks/useChatStore.test.ts`

Expected: frontend cleanup tests pass.

Run: `cargo test cancel_workspace --manifest-path src-tauri/Cargo.toml`

Expected: backend cancellation helper tests pass if added; otherwise command compiles in full cargo test.

## Task 5: Final Verification

**Files:**
- Verify all changed files

- [ ] **Step 1: Run frontend tests**

Run: `pnpm test`

Expected: all Vitest tests pass.

- [ ] **Step 2: Run TypeScript check**

Run: `pnpm typecheck`

Expected: no TypeScript errors.

- [ ] **Step 3: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests pass.

- [ ] **Step 4: Manual behavior check in dev app**

Run: `pnpm dev`

Expected manual checks:

- Open workspace A and B.
- In A, start a chat and observe messages.
- Switch to B and verify B has independent chat history and selected workflow.
- Switch back to A and verify A state is preserved.
- Restart app and verify chat history/mode/selected workflow restore, while running sessions do not restore as active.
- Close a workspace and verify its chat state is removed and no further events appear for it.
