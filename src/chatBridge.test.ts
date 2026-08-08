import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  register,
  unregister,
  insertContext,
  focus,
  setSkin,
  toWorkspaceRel,
  _resetForTests,
} from "./chatBridge";

function mockWin() {
  const style = { setProperty: vi.fn() };
  return {
    postMessage: vi.fn(),
    document: { documentElement: { style } },
    _style: style,
  } as unknown as Window & { _style: { setProperty: ReturnType<typeof vi.fn> } };
}

const ORIGIN = "http://127.0.0.1:12345";

beforeEach(() => {
  _resetForTests();
});

describe("chatBridge 缓冲/flush", () => {
  it("未 register 时入队，register 时按序 flush（消息格式逐字符合协议）", () => {
    insertContext({ path: "src/a.ts", startLine: 10, endLine: 20, symbol: "foo", quote: "const x = 1;" });
    focus();
    const win = mockWin();
    register(win, ORIGIN);
    expect(win.postMessage).toHaveBeenCalledTimes(2);
    expect(win.postMessage).toHaveBeenNthCalledWith(
      1,
      {
        type: "latte:ui-call",
        method: "insertContext",
        args: [{ path: "src/a.ts", startLine: 10, endLine: 20, symbol: "foo", quote: "const x = 1;" }],
      },
      ORIGIN,
    );
    expect(win.postMessage).toHaveBeenNthCalledWith(
      2,
      { type: "latte:ui-call", method: "focus", args: [] },
      ORIGIN,
    );
  });

  it("register 后立即投递，不再缓冲", () => {
    const win = mockWin();
    register(win, ORIGIN);
    insertContext({ path: "b.ts" });
    expect(win.postMessage).toHaveBeenCalledWith(
      { type: "latte:ui-call", method: "insertContext", args: [{ path: "b.ts" }] },
      ORIGIN,
    );
  });

  it("unregister 后回到缓冲态；再次 register 时 flush 到新通道", () => {
    const win1 = mockWin();
    register(win1, ORIGIN);
    unregister(ORIGIN);
    insertContext({ path: "c.ts" });
    expect(win1.postMessage).not.toHaveBeenCalled();
    const win2 = mockWin();
    register(win2, ORIGIN);
    expect(win2.postMessage).toHaveBeenCalledWith(
      { type: "latte:ui-call", method: "insertContext", args: [{ path: "c.ts" }] },
      ORIGIN,
    );
  });

  it("origin 不匹配的 unregister（旧 iframe 迟到清理）不清通道", () => {
    const win = mockWin();
    register(win, ORIGIN);
    unregister("http://127.0.0.1:9999");
    insertContext({ path: "d.ts" });
    expect(win.postMessage).toHaveBeenCalledTimes(1);
  });

  it("缓冲有上限（MAX_QUEUED），溢出丢弃最旧", () => {
    for (let i = 0; i < 60; i++) insertContext({ path: `f${i}.ts` });
    const win = mockWin();
    register(win, ORIGIN);
    expect(win.postMessage).toHaveBeenCalledTimes(50);
    // 最旧的 f0..f9 被丢弃，flush 从 f10 开始。
    expect(win.postMessage).toHaveBeenNthCalledWith(
      1,
      { type: "latte:ui-call", method: "insertContext", args: [{ path: "f10.ts" }] },
      ORIGIN,
    );
  });
});

describe("setSkin 皮肤联动", () => {
  const VARS = { "--bg": "#ffffff", "--fg": "#1f2328" };

  it("register 后 setSkin 直写 iframe :root 变量", () => {
    const win = mockWin();
    register(win, ORIGIN);
    setSkin(VARS);
    expect(win._style.setProperty).toHaveBeenCalledWith("--bg", "#ffffff");
    expect(win._style.setProperty).toHaveBeenCalledWith("--fg", "#1f2328");
  });

  it("未 register 时缓存，register 时补应用", () => {
    setSkin(VARS);
    const win = mockWin();
    register(win, ORIGIN);
    expect(win._style.setProperty).toHaveBeenCalledWith("--bg", "#ffffff");
    expect(win._style.setProperty).toHaveBeenCalledWith("--fg", "#1f2328");
  });

  it("换肤后切工作区重挂 iframe（新通道 register）应用最新皮肤", () => {
    const win1 = mockWin();
    register(win1, ORIGIN);
    setSkin(VARS);
    unregister(ORIGIN);
    const win2 = mockWin();
    register(win2, ORIGIN);
    expect(win2._style.setProperty).toHaveBeenCalledWith("--bg", "#ffffff");
  });

  it("iframe document 不可得（重载途中）不抛异常", () => {
    const win = { postMessage: vi.fn(), document: null } as unknown as Window;
    register(win, ORIGIN);
    expect(() => setSkin(VARS)).not.toThrow();
  });
});

describe("toWorkspaceRel", () => {
  it("root 内的绝对路径转相对", () => {
    expect(toWorkspaceRel("/home/u/ws/src/a.ts", "/home/u/ws")).toBe("src/a.ts");
    // root 尾部斜杠容忍
    expect(toWorkspaceRel("/home/u/ws/src/a.ts", "/home/u/ws/")).toBe("src/a.ts");
    expect(toWorkspaceRel("/home/u/ws", "/home/u/ws")).toBe(".");
  });

  it("root 外 / 无 root → 原样返回", () => {
    expect(toWorkspaceRel("/etc/passwd", "/home/u/ws")).toBe("/etc/passwd");
    // 前缀陷阱：/home/u/ws2 不在 /home/u/ws 下
    expect(toWorkspaceRel("/home/u/ws2/a.ts", "/home/u/ws")).toBe("/home/u/ws2/a.ts");
    expect(toWorkspaceRel("/home/u/ws/a.ts", null)).toBe("/home/u/ws/a.ts");
    expect(toWorkspaceRel("/home/u/ws/a.ts", undefined)).toBe("/home/u/ws/a.ts");
  });
});
