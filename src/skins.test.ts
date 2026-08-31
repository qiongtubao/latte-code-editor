import { describe, expect, it, vi } from "vitest";
import { SKINS, applySkin, cssVar, type SkinId } from "./skins";
import { cmThemes } from "./hooks/themes";

const SKIN_IDS = Object.keys(SKINS) as SkinId[];

describe("SKINS 注册表", () => {
  it("所有皮肤的 chrome token key 集合一致", () => {
    const reference = Object.keys(SKINS["vscode-dark"].vars).sort();
    for (const id of SKIN_IDS) {
      expect(Object.keys(SKINS[id].vars).sort()).toEqual(reference);
    }
  });

  it("所有皮肤的 chatVars key 集合一致", () => {
    const reference = Object.keys(SKINS["vscode-dark"].chatVars).sort();
    for (const id of SKIN_IDS) {
      expect(Object.keys(SKINS[id].chatVars).sort()).toEqual(reference);
    }
  });

  it("每套皮肤搭配的 cmTheme 都存在", () => {
    for (const id of SKIN_IDS) {
      expect(cmThemes[SKINS[id].cmTheme]).toBeDefined();
    }
  });

  it("colorScheme 与皮肤明暗一致", () => {
    expect(SKINS["vscode-dark"].colorScheme).toBe("dark");
    expect(SKINS["monokai"].colorScheme).toBe("dark");
    expect(SKINS["dracula"].colorScheme).toBe("dark");
    expect(SKINS["github-light"].colorScheme).toBe("light");
    expect(SKINS["solarized-light"].colorScheme).toBe("light");
  });
});

describe("applySkin", () => {
  it("把 token 写到 documentElement 并设置 color-scheme / data-skin", () => {
    applySkin("github-light");
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--surface")).toBe("#ffffff");
    expect(el.style.getPropertyValue("--accent")).toBe("#0969da");
    expect(el.style.colorScheme).toBe("light");
    expect(el.dataset.skin).toBe("github-light");

    applySkin("vscode-dark");
    expect(el.style.getPropertyValue("--surface")).toBe("#1e1e1e");
    expect(el.style.colorScheme).toBe("dark");
    expect(el.dataset.skin).toBe("vscode-dark");
  });
});

describe("cssVar cache", () => {
  it("reuses one computed style snapshot and invalidates after applySkin", () => {
    applySkin("vscode-dark");
    const values: Record<string, string> = {
      "--fg": " #111111 ",
      "--surface": "#222222",
    };
    const getPropertyValue = vi.fn((name: string) => values[name] ?? "");
    const computedStyle = vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      getPropertyValue,
    } as unknown as CSSStyleDeclaration);

    expect(cssVar("--fg", "fallback")).toBe("#111111");
    expect(cssVar("--fg", "other")).toBe("#111111");
    expect(cssVar("--surface", "fallback")).toBe("#222222");
    expect(cssVar("--missing", "first-fallback")).toBe("first-fallback");
    expect(cssVar("--missing", "second-fallback")).toBe("second-fallback");
    expect(computedStyle).toHaveBeenCalledTimes(1);
    expect(getPropertyValue).toHaveBeenCalledTimes(3);

    values["--fg"] = "#333333";
    expect(cssVar("--fg", "fallback")).toBe("#111111");

    applySkin("monokai");
    expect(cssVar("--fg", "fallback")).toBe("#333333");
    expect(computedStyle).toHaveBeenCalledTimes(2);
    expect(getPropertyValue).toHaveBeenCalledTimes(4);

    computedStyle.mockRestore();
  });
});
