// uiTransport 的 path+method → ui_* 命令映射、事件订阅过滤/透传、
// HttpError 404 shape（ensureSession 依赖）的单元测试。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createUiTransport } from "./uiTransport";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import type { WorkspaceMeta } from "./workspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

function meta(project_root: string): WorkspaceMeta {
  return {
    name: "ws",
    project_root,
    open_tabs: [],
    active_tab: null,
    ui_state: {
      sidebar_width: 240,
      outline_width: 180,
      editor_flex: 0.5,
      sidebar_open: true,
      active_panel: "split",
      sidebar_panel: "files",
    },
    last_used_at: 0,
  };
}

function seedWorkspace(root: string | null) {
  useWorkspaceStore.setState(
    root
      ? { activeWorkspaceId: "ws1", workspaces: { ws1: meta(root) } }
      : { activeWorkspaceId: null, workspaces: {} },
  );
}

const transport = createUiTransport();

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  mockListen.mockResolvedValue(() => {});
  seedWorkspace("/home/u/ws");
});

describe("request → ui_* 命令映射", () => {
  it("sessions：list/create/get/delete/set_label/history", async () => {
    await transport.request("GET", "/api/sessions");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_sessions_list", { workspaceRoot: "/home/u/ws" });

    await transport.request("POST", "/api/sessions", {});
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_sessions_create", { workspaceRoot: "/home/u/ws" });

    await transport.request("GET", "/api/session?id=abc");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_sessions_get", {
      workspaceRoot: "/home/u/ws",
      sessionId: "abc",
    });

    // api.ts deleteSession 实际用复数路径 + query。
    await transport.request("DELETE", "/api/sessions?id=abc");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_sessions_delete", {
      workspaceRoot: "/home/u/ws",
      sessionId: "abc",
    });

    await transport.request("POST", "/api/session/label", { session_id: "abc", label: "L" });
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_sessions_set_label", {
      workspaceRoot: "/home/u/ws",
      sessionId: "abc",
      label: "L",
    });

    await transport.request("GET", "/api/session/history?id=abc");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_sessions_history", {
      workspaceRoot: "/home/u/ws",
      sessionId: "abc",
    });
  });

  it("roles：list / config get / config save（body 作 config 透传）", async () => {
    await transport.request("GET", "/api/roles");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_roles_list", { workspaceRoot: "/home/u/ws" });

    await transport.request("GET", "/api/roles/config");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_roles_config_get", { workspaceRoot: "/home/u/ws" });

    const cfg = { id: "manager", name: "Manager" };
    await transport.request("POST", "/api/roles/config", cfg);
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_roles_config_save", {
      workspaceRoot: "/home/u/ws",
      config: cfg,
    });
  });

  it("chat：send/command/role（body 的 session_id → sessionId）", async () => {
    await transport.request("POST", "/api/chat/send", { session_id: "s1", message: "hi" });
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_chat_send", {
      workspaceRoot: "/home/u/ws",
      sessionId: "s1",
      message: "hi",
    });

    await transport.request("POST", "/api/chat/command", { session_id: "s1", command: "/clear" });
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_chat_command", {
      workspaceRoot: "/home/u/ws",
      sessionId: "s1",
      command: "/clear",
    });

    await transport.request("POST", "/api/chat/role", { session_id: "s1", role_id: "pm" });
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_chat_role", {
      workspaceRoot: "/home/u/ws",
      sessionId: "s1",
      roleId: "pm",
    });
  });

  it("traces：list / 路径模板 get（sessionId 取自路径并 decode）", async () => {
    await transport.request("GET", "/api/traces");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_traces_list", { workspaceRoot: "/home/u/ws" });

    await transport.request("GET", `/api/traces/${encodeURIComponent("ui-1/2")}`);
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_traces_get", {
      workspaceRoot: "/home/u/ws",
      sessionId: "ui-1/2",
    });
  });

  it("subsessions / role-graph / self-loop", async () => {
    await transport.request("GET", "/api/subsessions?id=sub1");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_subsessions_get", {
      workspaceRoot: "/home/u/ws",
      subId: "sub1",
    });

    await transport.request("GET", "/api/role-graph");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_role_graph", { workspaceRoot: "/home/u/ws" });

    await transport.request("POST", "/api/self-loop/start", { task: "fix", max_iterations: 3 });
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_self_loop_start", {
      workspaceRoot: "/home/u/ws",
      task: "fix",
      maxIterations: 3,
    });

    // max_iterations 缺省 → null（Rust 侧 Option<u32>）
    await transport.request("POST", "/api/self-loop/start", { task: "fix" });
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_self_loop_start", {
      workspaceRoot: "/home/u/ws",
      task: "fix",
      maxIterations: null,
    });

    await transport.request("POST", "/api/self-loop/stop");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_self_loop_stop", { workspaceRoot: "/home/u/ws" });
  });

  it("query 解析：URL 编码的 id 被 decode", async () => {
    await transport.request("GET", `/api/session?id=${encodeURIComponent("a b/c")}`);
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_sessions_get", {
      workspaceRoot: "/home/u/ws",
      sessionId: "a b/c",
    });
  });

  it("无工作区 → workspaceRoot: null（走 default 容器）", async () => {
    seedWorkspace(null);
    await transport.request("GET", "/api/sessions");
    expect(mockInvoke).toHaveBeenLastCalledWith("ui_sessions_list", { workspaceRoot: null });
  });

  it("未映射的路径报错", async () => {
    await expect(transport.request("GET", "/api/nope")).rejects.toThrow(/no IPC mapping/);
  });
});

describe("错误形态：ensureSession 的 404 语义", () => {
  it('"not found" 类 reject → HttpError shape（name/status/method/path）', async () => {
    mockInvoke.mockRejectedValueOnce('session_id "x" not found');
    const err = (await transport.request("GET", "/api/session?id=x").catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HttpError");
    expect((err as { status?: number }).status).toBe(404);
    expect((err as { method?: string }).method).toBe("GET");
    expect((err as { path?: string }).path).toBe("/api/session?id=x");
  });

  it("其它错误原样抛出（不包装成 HttpError）", async () => {
    mockInvoke.mockRejectedValueOnce("spawn ui backend failed: boom");
    const err = (await transport.request("GET", "/api/session?id=x").catch((e) => e)) as Error;
    expect(err.name).not.toBe("HttpError");
    expect((err as { status?: number }).status).toBeUndefined();
  });
});

describe("事件订阅", () => {
  it("subscribeEvents：按 session_id 过滤后透传 event", async () => {
    let handler: ((e: { payload: { session_id: string; event: unknown } }) => void) | null = null;
    mockListen.mockImplementationOnce(async (_event, cb) => {
      handler = cb as typeof handler;
      return () => {};
    });
    const onEvent = vi.fn();
    const un = transport.subscribeEvents("s1", onEvent);
    expect(mockListen).toHaveBeenCalledWith("ui:chat_event", expect.any(Function));
    await Promise.resolve(); // 等 mockImplementation 赋值 handler
    handler!({ payload: { session_id: "s2", event: { Done: null } } });
    expect(onEvent).not.toHaveBeenCalled();
    handler!({ payload: { session_id: "s1", event: { Done: null } } });
    expect(onEvent).toHaveBeenCalledWith({ Done: null });
    expect(typeof un).toBe("function");
  });

  it("subscribeEvents：返回的 unlisten 调用底层 unlisten", async () => {
    const inner = vi.fn();
    mockListen.mockResolvedValueOnce(inner);
    const un = transport.subscribeEvents("s1", () => {});
    un();
    await Promise.resolve();
    expect(inner).toHaveBeenCalled();
  });

  it("subscribeSelfLoop：透传 payload.event", async () => {
    let handler: ((e: { payload: { event: unknown } }) => void) | null = null;
    mockListen.mockImplementationOnce(async (_event, cb) => {
      handler = cb as typeof handler;
      return () => {};
    });
    const onEvent = vi.fn();
    transport.subscribeSelfLoop(onEvent);
    expect(mockListen).toHaveBeenCalledWith("ui:self_loop_event", expect.any(Function));
    await Promise.resolve();
    handler!({ payload: { event: { kind: "started" } } });
    expect(onEvent).toHaveBeenCalledWith({ kind: "started" });
  });
});
