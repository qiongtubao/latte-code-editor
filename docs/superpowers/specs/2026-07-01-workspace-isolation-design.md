# Workspace-Scoped Panels And Chat Design

## Purpose

Switching workspaces must switch the full product context, not just the file root. Code display, code graph state, document state, chat history, selected chat workflow, and running chat sessions should belong to the workspace that created them.

The user-approved behavior is:

- Each workspace has independent chat UI state: messages, activity, mode, selected workflow, session ids, swarm state, status, and retry context.
- Chat state is persisted and restored across app restarts.
- If a chat is running in workspace A and the user switches to workspace B, A continues in the background. Switching back to A shows the latest progress and results.
- Workflow definitions, roles, model catalog, role model chains, and default model remain global configuration. Only the selected workflow and runtime state are workspace-specific.

## Current Context

The existing workspace system already provides a deterministic `workspaceId`, metadata persistence, window-to-workspace routing, and per-workspace editor and graph stores.

Relevant existing patterns:

- `useWorkspaceStore` owns `activeWorkspaceId` and persists `WorkspaceMeta`.
- `useEditorStore` keeps `byWorkspace` and projects fields for the active workspace.
- `useGraphStore` keeps `byWorkspace` and projects graph data, simulation state, and selection.
- Graph backend commands route through the active workspace for the window and read `.latte/` under that workspace root.

The main gap is chat. `useChatStore` currently stores messages, mode, selected workflow, sessions, and running status as global singleton fields. Chat events are applied without a workspace routing key, so a background session can update whichever workspace is currently visible.

## State Model

Refactor `useChatStore` to follow the editor and graph pattern:

```ts
interface WorkspaceChat {
  mode: ChatMode;
  messages: ChatMessage[];
  activityEvents: ChatActivityEvent[];
  activeRoles: Record<string, ActiveRoleState>;
  roleDisplay: Record<string, RoleDisplayState>;
  status: ChatStatus;
  sessionId: number | null;
  swarmSessionId: number | null;
  activeSwarmId: string | null;
  swarmPlan: SwarmStepSpec[];
  swarmFiles: { path: string; kind: "plan" | "output" | "summary" }[];
  swarmSummary: string | null;
  errorMessage: string | null;
  lastUserTopic: string | null;
  selectedWorkflow: string;
}
```

The store adds `byWorkspace: Record<string, WorkspaceChat>` and keeps the existing public fields as projections of the active workspace. Components such as `ChatPanel` can continue reading `messages`, `status`, `mode`, and `selectedWorkflow` without knowing the storage shape.

Global chat configuration remains outside `WorkspaceChat`:

- `availableWorkflows`
- `availableRoles`
- `availableModels`
- `defaultModel`
- `roleModels`
- `roleChains`
- config file paths
- workflow editor draft state

Keeping workflow editor draft state global avoids surprising the user by hiding or resetting an in-progress workflow configuration edit when switching workspaces.

## Event Routing

Chat events must be routed to the workspace that owns the session.

Backend changes:

- When `chat_start_discussion` resolves the active workspace from the window, pass that `workspace_id` into the controller runtime.
- When `chat_start_swarm` starts a swarm, pass the same workspace id into its runtime path.
- Emit `chat:event` and `chat:swarm_event` payloads with `workspace_id`.

Frontend changes:

- `App.tsx` listener calls `applyChatEvent(event, workspaceId)` and `applySwarmEvent(event, workspaceId)`.
- The store writes to `byWorkspace[workspaceId]` instead of the current active workspace.
- If an older event has no `workspace_id`, fall back to the active workspace for compatibility, but all new runtime events should include it.

This lets workspace A keep receiving background results while workspace B is active.

## Persistence

Persist chat UI state with the workspace metadata. Add a serializable chat state field to `WorkspaceMeta`, for example:

```ts
chat_state?: PersistedWorkspaceChat;
```

and a matching Rust type in `workspace::registry`.

Persisted fields:

- messages
- activity events
- mode
- selected workflow
- swarm plan
- swarm files
- swarm summary
- error message
- last user topic

Runtime-only fields should not resume across process restart:

- `sessionId`
- `swarmSessionId`
- `activeRoles`
- transient role display

If the app restarts while a workspace chat was `running`, restore the visible history but set status to a non-running state. The safest default is `idle` with a readable error or activity entry indicating that the previous runtime ended when the app restarted. This avoids sending follow-up messages to stale in-memory session ids.

Persistence should be best-effort and aligned with the existing workspace persistence flow. Chat mutations should schedule `update_workspace_meta` with the current workspace's serialized chat state, ideally with debouncing to avoid writing state on every streamed event.

## Document And Graph State

Code graph behavior is already close to the desired model:

- Backend graph commands route through the active workspace for the window.
- Frontend graph state is stored per workspace.

Document behavior should follow the same principle:

- `DocPanel` reads from the active workspace `folderRoot/docs` and refreshes when the root changes.
- Any document graph UI state, such as selected document node, expanded groups, loaded graph data, or errors, should live in a per-workspace store if those states exist or are added.
- Doc generation commands that accept `project_root` or `docs_root` must be called with the active workspace root. The UI should not cache a previous workspace's root outside workspace-scoped state.

## Workspace Switching And Closing

Switching workspaces:

- Project editor, graph, document, and chat fields from the target workspace.
- Do not cancel background chat sessions from other workspaces.
- Incoming events continue to update their owning workspace by `workspace_id`.

Closing a workspace:

- Evict frontend state for that workspace from editor, graph, chat, and document stores.
- Cancel running chat sessions owned by that workspace before eviction. This prevents events from writing into a closed workspace and avoids orphaned backend work.
- Persist the remaining registry state after removal.

Opening a previously known workspace:

- Reuse the deterministic `workspaceId`.
- Restore persisted workspace metadata, including persisted chat state.
- Start with non-running chat status after app restart, even if the persisted status was running.

## Testing Strategy

Focused tests should cover the behavior that can regress:

- `useChatStore` projects the correct chat state when `activeWorkspaceId` changes.
- Sending a message in workspace A does not alter workspace B's messages or selected workflow.
- Applying a chat event with workspace A's id updates A even while B is active.
- Persisted chat state restores messages, mode, selected workflow, and swarm summary.
- Persisted running state does not restore stale session ids as active.
- Closing a workspace evicts chat state and cancels its running session.
- Existing global role, model, and workflow configuration still appears the same from every workspace.

## Non-Goals

This design does not make workflow definition files, roles, model catalogs, or role model chains workspace-specific. Those remain global user configuration.

This design also does not guarantee resuming a running in-memory chat after app restart. It restores the visible state and history, then resets runtime-only state to avoid stale session continuation.
