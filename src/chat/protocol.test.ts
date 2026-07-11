// 协议层单测 — ChatRenderer 接口、parseChatEvent、ReactChatEventAdapter
//
// 覆盖协议层的"渲染器无关"合约：把后端 ChatEvent 解析为统一的消息格式，
// 并验证多个渲染器（React 适配器 / 未来 CLI / HTML 适配器）共用同一套数据。
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseChatEvent,
  extractControllerRoles,
  deriveStatusFromEvent,
  extractPrompt,
  type ChatProtocolMessage,
} from "./protocol";
import { ReactChatEventAdapter } from "./renderers/react";
import type { ChatEvent, ChatTurn, SwarmEvent } from "../api/chat";

describe("protocol — parseChatEvent", () => {
  it("RoleTurn → agent message with role icon + name", () => {
    const event: ChatEvent = {
      RoleTurn: { role_id: "pm", content: "需求分析", is_complete: true },
    };
    const msg = parseChatEvent(event, []);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("agent");
    expect(msg!.content).toBe("需求分析");
    expect(msg!.agentName).toBe("pm");
  });

  it("RoleTurn uses known role icon/name when provided", () => {
    const event: ChatEvent = {
      RoleTurn: { role_id: "pm", content: "x", is_complete: true },
    };
    const msg = parseChatEvent(event, [
      { id: "pm", name: "产品经理", icon: "📋" },
    ]);
    expect(msg!.agentName).toBe("产品经理");
    expect(msg!.agentIcon).toBe("📋");
  });

  it("Status → system message with 'status' agent name", () => {
    const msg = parseChatEvent({ Status: { message: "[ok]" } }, []);
    expect(msg!.role).toBe("system");
    expect(msg!.agentName).toBe("status");
    expect(msg!.content).toBe("[ok]");
  });

  it("Paused → system message", () => {
    const msg = parseChatEvent({ Paused: { reason: "用户暂停" } }, []);
    expect(msg!.agentName).toBe("paused");
  });

  it("Done → system completion message", () => {
    const msg = parseChatEvent("Done", []);
    expect(msg!.agentName).toBe("system");
    expect(msg!.content).toContain("completed");
  });

  it("Resumed → system message", () => {
    const msg = parseChatEvent("Resumed", []);
    expect(msg!.agentName).toBe("system");
  });

  it("RoundStarted/Ended → numbered system messages", () => {
    const s = parseChatEvent({ RoundStarted: { round: 3 } }, []);
    const e = parseChatEvent({ RoundEnded: { round: 3 } }, []);
    expect(s!.content).toBe("Round 3 started.");
    expect(e!.content).toBe("Round 3 ended.");
  });

  it("Error → system error message", () => {
    const msg = parseChatEvent({ Error: { message: "boom" } }, []);
    expect(msg!.agentName).toBe("error");
    expect(msg!.content).toBe("boom");
  });

  it("ToolUse/ToolResult → prefixed system messages", () => {
    const use = parseChatEvent(
      { ToolUse: { role_id: "dev", tool_name: "edit", args: "{}" } },
      [],
    );
    const res = parseChatEvent(
      { ToolResult: { role_id: "dev", tool_name: "edit", result: "ok" } },
      [],
    );
    expect(use!.content.startsWith("Tool: edit")).toBe(true);
    expect(res!.content.startsWith("Tool result: edit")).toBe(true);
  });

  it("returns null for unknown string events", () => {
    expect(parseChatEvent("ContextCleared" as never, [])).not.toBeNull();
    // 完全未知的字符串事件
    expect(parseChatEvent("BogusEvent" as never, [])).toBeNull();
  });
});

describe("protocol — extractControllerRoles", () => {
  it("extracts roles from SessionInfo", () => {
    const event: ChatEvent = {
      SessionInfo: {
        task_id: "t1",
        state: "Running",
        turn: 0,
        roles: [{ id: "r1", name: "角色1", icon: "🔹" }],
      },
    };
    const roles = extractControllerRoles(event);
    expect(roles).toHaveLength(1);
    expect(roles[0].id).toBe("r1");
  });

  it("returns empty array for events without role info", () => {
    expect(extractControllerRoles("Done")).toEqual([]);
    expect(extractControllerRoles({ Status: { message: "x" } })).toEqual([]);
  });
});

describe("protocol — deriveStatusFromEvent", () => {
  it("Done → completed", () => {
    expect(deriveStatusFromEvent("Done")).toBe("completed");
  });

  it("Resumed → running", () => {
    expect(deriveStatusFromEvent("Resumed")).toBe("running");
  });

  it("Error event → error", () => {
    expect(deriveStatusFromEvent({ Error: { message: "x" } })).toBe("error");
  });

  it("Paused event → idle", () => {
    expect(deriveStatusFromEvent({ Paused: { reason: "x" } })).toBe("idle");
  });

  it("returns null for events with no status impact", () => {
    expect(deriveStatusFromEvent({ Status: { message: "x" } })).toBeNull();
    expect(deriveStatusFromEvent({
      RoleTurn: { role_id: "r", content: "x", is_complete: true },
    })).toBeNull();
  });
});

describe("protocol — extractPrompt", () => {
  it("extracts from Prompt event", () => {
    expect(extractPrompt({ Prompt: { icon: "💬", role_id: "r1", model_id: "m1" } }))
      .toEqual({ icon: "💬", roleId: "r1", modelId: "m1" });
  });

  it("returns null for non-prompt events", () => {
    expect(extractPrompt("Done")).toBeNull();
    expect(extractPrompt({ Status: { message: "x" } })).toBeNull();
  });
});

describe("ReactChatEventAdapter", () => {
  let captured: {
    messages: ChatProtocolMessage[];
    status: string;
    errorMessage: string | null;
    currentPrompt: { icon: string; roleId: string; modelId: string } | null;
    unknownRoles: { id: string; name: string; icon: string }[];
  }[] = [];
  let adapter: ReactChatEventAdapter;

  beforeEach(() => {
    captured = [];
    adapter = new ReactChatEventAdapter((state) => {
      captured.push({ ...state });
    });
  });

  it("applyChatEvent pushes parsed message and updates status", () => {
    adapter.applyChatEvent({
      RoleTurn: { role_id: "pm", content: "需求", is_complete: true },
    });
    expect(adapter.messages).toHaveLength(1);
    expect(adapter.messages[0].content).toBe("需求");
    expect(adapter.status).toBe("idle");
  });

  it("applyChatEvent captures controller roles from SessionInfo", () => {
    adapter.applyChatEvent({
      SessionInfo: {
        task_id: "t",
        state: "Running",
        turn: 0,
        roles: [{ id: "r1", name: "角色1", icon: "🔹" }],
      },
    });
    // 下次解析的 RoleTurn 会用上这个角色信息
    adapter.applyChatEvent({
      RoleTurn: { role_id: "r1", content: "hi", is_complete: true },
    });
    // SessionInfo 不产生可见消息，只有 RoleTurn 推送了一条
    expect(adapter.messages[0].agentName).toBe("角色1");
    expect(adapter.messages[0].agentIcon).toBe("🔹");
  });

  it("applyChatEvent(Error) sets errorMessage + status=error", () => {
    adapter.applyChatEvent({ Error: { message: "boom" } });
    expect(adapter.errorMessage).toBe("boom");
    expect(adapter.status).toBe("error");
  });

  it("applyChatEvent(Resumed) sets status=running", () => {
    adapter.applyChatEvent("Resumed");
    expect(adapter.status).toBe("running");
  });

  it("applyTurn produces an agent message with the turn's icon/name", () => {
    const turn: ChatTurn = {
      agent: "pm",
      roleId: "pm",
      icon: "📋",
      response: "我先梳理需求",
      round: 1,
      stepId: "s1",
      turnNumber: 1,
    };
    adapter.applyTurn(turn);
    expect(adapter.messages).toHaveLength(1);
    expect(adapter.messages[0].content).toBe("我先梳理需求");
    expect(adapter.messages[0].agentIcon).toBe("📋");
    expect(adapter.messages[0].agentName).toBe("pm");
    expect(adapter.status).toBe("running");
  });

  it("applySwarmEvent(plan) renders a planner agent message", () => {
    const event: SwarmEvent = {
      kind: "plan",
      steps: [
        { role: "dev", instruction: "实现登录页" },
        { role: "tester", instruction: "测试" },
      ],
    };
    adapter.applySwarmEvent(event);
    expect(adapter.messages[0].agentName).toBe("planner");
    expect(adapter.messages[0].content).toContain("**dev**");
    expect(adapter.messages[0].content).toContain("实现登录页");
  });

  it("applySwarmEvent(summary) marks status=completed and renders synthesis", () => {
    const event: SwarmEvent = { kind: "summary", content: "完成" };
    adapter.applySwarmEvent(event);
    expect(adapter.status).toBe("completed");
    expect(adapter.messages[0].agentName).toBe("synthesis");
  });

  it("applySwarmEvent(error) marks status=error and sets errorMessage", () => {
    const event: SwarmEvent = { kind: "error", content: "swarm 失败" };
    adapter.applySwarmEvent(event);
    expect(adapter.status).toBe("error");
    expect(adapter.errorMessage).toBe("swarm 失败");
  });

  it("reset clears all state", () => {
    adapter.applyChatEvent({
      RoleTurn: { role_id: "r", content: "x", is_complete: true },
    });
    adapter.reset();
    expect(adapter.messages).toEqual([]);
    expect(adapter.status).toBe("idle");
    expect(adapter.errorMessage).toBeNull();
  });

  it("onStateChange callback fires on every state mutation", () => {
    adapter.onMessage({
      id: "m1",
      role: "user",
      content: "hi",
      timestamp: 0,
    });
    adapter.setStatus("running");
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured[captured.length - 1].status).toBe("running");
  });
});
