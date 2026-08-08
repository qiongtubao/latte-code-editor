import { describe, expect, it } from "vitest";
import { SKINS, applySkin, type SkinId } from "./skins";
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
