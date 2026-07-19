// uiTransport — chat UI 的 Tauri IPC transport（契约 C1，阶段 2）。
//
// 取代阶段 0/1 的 HttpSseTransport + 内嵌 HTTP server：同源 iframe 经
// __LATTE_HOST__.transport 拿到本对象，api.ts 的全部 REST 调用按
// docs/bridge-api.ts 的 1:1 映射落到 src-tauri `ui_*` 命令；事件走
// `listen("ui:chat_event" / "ui:self_loop_event")`。
//
// workspaceRoot 每次调用时现取（useWorkspaceStore），切工作区不用重建
// transport——后端按 workspaceRoot get-or-spawn 各自的 UiBackend。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";

/** 契约 C1 的本地镜像（UI 仓 transport.ts 的 ChatTransport；dist 产物
 * 无法 import 类型，结构上保持一致即可——注入时 UI 只做结构消费）。 */
export interface UiTransport {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  subscribeEvents(sessionId: string, onEvent: (ev: unknown) => void): () => void;
  subscribeSelfLoop(onEvent: (ev: unknown) => void): () => void;
}

function workspaceRootArg(): string | null {
  const ws = useWorkspaceStore.getState();
  const id = ws.activeWorkspaceId;
  return (id && ws.workspaces[id]?.project_root) || null;
}

/** invoke 失败转换为 Error。Rust 侧 ApiError 的 status 在命令边界被
 * 压平成 message 文本，这里把 "… not found" 映射回 404，并包装成与
 * UI transport.ts HttpError 相同的 shape（name/status/method/path）——
 * api.ts ensureSession 的"session 不存在则新建"依赖它（跨 realm
 * instanceof 失效，UI 侧用 duck-type 判定）。其它错误原样抛出
 * （等价网络失败：ensureSession 会视为 fatal 而不是误建新 session）。 */
function rethrowAsHttpShaped(method: string, path: string, e: unknown): never {
  const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) {
    const err = new Error(`${method} ${path} 404: ${msg}`);
    err.name = "HttpError";
    Object.assign(err, { method, path, status: 404 });
    throw err;
  }
  throw e instanceof Error ? e : new Error(msg);
}

function asRecord(body: unknown): Record<string, unknown> {
  return (body ?? {}) as Record<string, unknown>;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const m = method.toUpperCase();
  // path 可能带 query string（/api/session?id=…）；挂个假 base 解析。
  const u = new URL(path, "http://local");
  const p = u.pathname;
  const q = (name: string): string | null => u.searchParams.get(name);
  const b = asRecord(body);
  const workspaceRoot = workspaceRootArg();
  try {
    // ─── sessions ───
    if (m === "GET" && p === "/api/sessions") {
      return (await invoke("ui_sessions_list", { workspaceRoot })) as T;
    }
    if (m === "POST" && p === "/api/sessions") {
      return (await invoke("ui_sessions_create", { workspaceRoot })) as T;
    }
    if (m === "GET" && p === "/api/session") {
      return (await invoke("ui_sessions_get", { workspaceRoot, sessionId: q("id") })) as T;
    }
    // api.ts deleteSession 用的是复数路径 /api/sessions?id=…。
    if (m === "DELETE" && (p === "/api/sessions" || p === "/api/session")) {
      return (await invoke("ui_sessions_delete", { workspaceRoot, sessionId: q("id") })) as T;
    }
    if (m === "POST" && p === "/api/session/label") {
      return (await invoke("ui_sessions_set_label", {
        workspaceRoot,
        sessionId: b.session_id ?? null,
        label: b.label ?? null,
      })) as T;
    }
    if (m === "GET" && p === "/api/session/history") {
      return (await invoke("ui_sessions_history", { workspaceRoot, sessionId: q("id") })) as T;
    }
    // ─── roles ───
    if (m === "GET" && p === "/api/roles") {
      return (await invoke("ui_roles_list", { workspaceRoot })) as T;
    }
    if (m === "GET" && p === "/api/roles/config") {
      return (await invoke("ui_roles_config_get", { workspaceRoot })) as T;
    }
    if (m === "POST" && p === "/api/roles/config") {
      return (await invoke("ui_roles_config_save", { workspaceRoot, config: body })) as T;
    }
    // ─── chat（body 由 api.ts chatBody 打上 session_id）───
    if (m === "POST" && p === "/api/chat/send") {
      return (await invoke("ui_chat_send", {
        workspaceRoot,
        sessionId: b.session_id ?? null,
        message: b.message ?? null,
      })) as T;
    }
    if (m === "POST" && p === "/api/chat/command") {
      return (await invoke("ui_chat_command", {
        workspaceRoot,
        sessionId: b.session_id ?? null,
        command: b.command ?? null,
      })) as T;
    }
    if (m === "POST" && p === "/api/chat/role") {
      return (await invoke("ui_chat_role", {
        workspaceRoot,
        sessionId: b.session_id ?? null,
        roleId: b.role_id ?? null,
      })) as T;
    }
    // ─── traces / subsessions / role graph ───
    if (m === "GET" && p === "/api/traces") {
      return (await invoke("ui_traces_list", { workspaceRoot })) as T;
    }
    if (m === "GET" && p.startsWith("/api/traces/")) {
      const sessionId = decodeURIComponent(p.slice("/api/traces/".length));
      return (await invoke("ui_traces_get", { workspaceRoot, sessionId })) as T;
    }
    if (m === "GET" && p === "/api/subsessions") {
      return (await invoke("ui_subsessions_get", { workspaceRoot, subId: q("id") })) as T;
    }
    if (m === "GET" && p === "/api/role-graph") {
      return (await invoke("ui_role_graph", { workspaceRoot })) as T;
    }
    // ─── self-loop ───
    if (m === "POST" && p === "/api/self-loop/start") {
      return (await invoke("ui_self_loop_start", {
        workspaceRoot,
        task: b.task ?? null,
        maxIterations: b.max_iterations ?? null,
      })) as T;
    }
    if (m === "POST" && p === "/api/self-loop/stop") {
      return (await invoke("ui_self_loop_stop", { workspaceRoot })) as T;
    }
  } catch (e) {
    rethrowAsHttpShaped(m, path, e);
  }
  throw new Error(`[uiTransport] no IPC mapping for ${m} ${path}`);
}

function subscribeEvents(sessionId: string, onEvent: (ev: unknown) => void): () => void {
  // 后端按 session 广播 { session_id, event }（契约 C2）；这里按
  // session_id 过滤（同一 UiBackend 上可能有多个 session）。
  const ready = listen<{ session_id: string; event: unknown }>("ui:chat_event", (e) => {
    if (e.payload?.session_id !== sessionId) return;
    onEvent(e.payload.event);
  });
  return () => {
    // unlisten Promise 就绪与否都能退订（已注册则调用，未注册则就绪即调）。
    void ready.then((un) => un());
  };
}

function subscribeSelfLoop(onEvent: (ev: unknown) => void): () => void {
  const ready = listen<{ event: unknown }>("ui:self_loop_event", (e) => {
    onEvent(e.payload?.event);
  });
  return () => {
    void ready.then((un) => un());
  };
}

export function createUiTransport(): UiTransport {
  return { request, subscribeEvents, subscribeSelfLoop };
}
