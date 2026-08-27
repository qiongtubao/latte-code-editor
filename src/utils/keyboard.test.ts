/**
 * 快捷键匹配回归测试。
 *
 * 每个 describe 对应一个真实修掉的失效场景，避免以后再退化。
 */
import { describe, it, expect } from "vitest";
import { hasMod, normalizeKey, isChord } from "./keyboard";

/** 构造 keydown 事件，happy-dom 的 KeyboardEvent 已支持修饰键字段。 */
function ev(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("hasMod", () => {
  it("接受 Ctrl（Windows/Linux）和 Meta（macOS Cmd）", () => {
    expect(hasMod(ev({ key: "b", ctrlKey: true }))).toBe(true);
    expect(hasMod(ev({ key: "b", metaKey: true }))).toBe(true);
  });

  it("无主修饰键时为假", () => {
    expect(hasMod(ev({ key: "b" }))).toBe(false);
    expect(hasMod(ev({ key: "b", shiftKey: true }))).toBe(false);
  });
});

describe("normalizeKey", () => {
  it("Shift 组合下 event.key 是大写，归一化后可比较", () => {
    // 这正是 `e.shiftKey && e.key === "f"` 恒为假的根因。
    expect(ev({ key: "F", shiftKey: true }).key).toBe("F");
    expect(normalizeKey(ev({ key: "F", shiftKey: true }))).toBe("f");
  });
});

describe("Ctrl/Cmd+Shift+F 全局搜索（此前恒不触发）", () => {
  it("Shift 使 key 变为大写 F 时仍然匹配", () => {
    expect(isChord(ev({ key: "F", ctrlKey: true, shiftKey: true }), "f", { shift: true })).toBe(true);
  });

  it("macOS 的 Cmd+Shift+F 同样匹配", () => {
    expect(isChord(ev({ key: "F", metaKey: true, shiftKey: true }), "f", { shift: true })).toBe(true);
  });

  it("旧写法 e.ctrlKey && e.shiftKey && e.key === \"f\" 确实匹配不到", () => {
    const e = ev({ key: "F", ctrlKey: true, shiftKey: true });
    expect(e.ctrlKey && e.shiftKey && e.key === "f").toBe(false);
  });
});

describe("Ctrl/Cmd+Shift+E 切换 Explorer（此前恒不触发）", () => {
  it("大写 E 仍然匹配", () => {
    expect(isChord(ev({ key: "E", ctrlKey: true, shiftKey: true }), "e", { shift: true })).toBe(true);
  });
});

describe("macOS 上的 Cmd+B / Cmd+P（此前只判 ctrlKey）", () => {
  it("Cmd+B 匹配", () => {
    expect(isChord(ev({ key: "b", metaKey: true }), "b")).toBe(true);
  });

  it("Cmd+P 匹配", () => {
    expect(isChord(ev({ key: "p", metaKey: true }), "p")).toBe(true);
  });

  it("CapsLock 导致的大写也不影响", () => {
    expect(isChord(ev({ key: "B", metaKey: true }), "b")).toBe(true);
  });
});

describe("修饰键精确匹配：避免分支互相抢占", () => {
  it("Ctrl+S 不被 Ctrl+Alt+S 命中（此前会连带触发保存）", () => {
    const ctrlAltS = ev({ key: "s", ctrlKey: true, altKey: true });
    expect(isChord(ctrlAltS, "s")).toBe(false);
    expect(isChord(ctrlAltS, "s", { alt: true })).toBe(true);
  });

  it("Ctrl+Shift+S 与 Ctrl+Alt+Shift+S 互斥（此前后者永远进不去）", () => {
    const screenshot = ev({ key: "S", ctrlKey: true, shiftKey: true });
    const snapshot = ev({ key: "S", ctrlKey: true, shiftKey: true, altKey: true });

    expect(isChord(screenshot, "s", { shift: true })).toBe(true);
    expect(isChord(screenshot, "s", { shift: true, alt: true })).toBe(false);

    expect(isChord(snapshot, "s", { shift: true, alt: true })).toBe(true);
    expect(isChord(snapshot, "s", { shift: true })).toBe(false);

    // 旧的宽松写法会让截图分支抢走 Ctrl+Alt+Shift+S。
    expect(
      (snapshot.ctrlKey || snapshot.metaKey) &&
        snapshot.shiftKey &&
        (snapshot.key === "S" || snapshot.key === "s"),
    ).toBe(true);
  });

  it("Ctrl+P 不被 Ctrl+Alt+P 命中", () => {
    expect(isChord(ev({ key: "p", ctrlKey: true, altKey: true }), "p")).toBe(false);
  });

  it("要求 Shift 的组合不会被无 Shift 的按键命中", () => {
    expect(isChord(ev({ key: "f", ctrlKey: true }), "f", { shift: true })).toBe(false);
  });

  it("无修饰键的裸按键一律不匹配", () => {
    expect(isChord(ev({ key: "s" }), "s")).toBe(false);
    expect(isChord(ev({ key: "F", shiftKey: true }), "f", { shift: true })).toBe(false);
  });
});
