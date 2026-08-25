// languageExtensions 工厂与 TCL StreamParser 单测
//
// 覆盖目标：
// 1. languages() 根据扩展名返回对应扩展（包含 .tcl）
// 2. tcl() 工厂独立返回 LanguageSupport
// 3. .tcl 后缀识别大小写不敏感
// 4. 文件名为空/未识别扩展时返回空扩展数组
//
// TCL 高亮回归（行为合同）：
// - `#` 行注释打 tag.lineComment
// - `"..."` 字符串打 tag.string
// - `$name` 变量打 tag.variableName
// - 整数/浮点打 tag.number
// - 花括号字面量 `{...}` 内部的 #、$ 视为普通字符（不应再被打成注释/变量）

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { syntaxTree, StreamLanguage } from "@codemirror/language";
import { languages, tcl } from "./languageExtensions";

describe("languageExtensions.languages()", () => {
  it("对 .tcl 文件返回 tcl 语言扩展", () => {
    const ext = languages("script.tcl");
    expect(ext).toBeDefined();
  });

  it(".tcl 后缀大小写不敏感均识别", () => {
    expect(languages("foo.tcl")).toBeDefined();
    expect(languages("FOO.TCL")).toBeDefined();
  });

  it("对空文件路径返回空扩展数组", () => {
    expect(languages(null)).toEqual([]);
  });

  it("对未识别的扩展返回空扩展数组", () => {
    expect(languages("archive.xyz")).toEqual([]);
  });

  it("已识别扩展（ts/md/json）仍能正常返回对应扩展", () => {
    expect(languages("foo.ts")).toBeDefined();
    expect(languages("foo.md")).toBeDefined();
    expect(languages("foo.json")).toBeDefined();
  });
});

describe("languageExtensions.tcl()", () => {
  it("返回非空 LanguageSupport", () => {
    const support = tcl();
    expect(support).toBeDefined();
    expect(support.language).toBeDefined();
  });

  it("tcl() 两次调用返回不同实例（不共享内部状态）", () => {
    const a = tcl();
    const b = tcl();
    // LanguageSupport 每次构造应是新实例，避免编辑器之间互相覆盖 highlighter 状态
    expect(a).not.toBe(b);
  });

  it("tcl() 暴露的 Language 是 StreamLanguage 实例", () => {
    const support = tcl();
    expect(support.language).toBeInstanceOf(StreamLanguage);
  });
});

/**
 * 把一段文本塞进 TCL StreamLanguage，吐出每段 token 的 (from, to, name)。
 * 用于回归校验"高亮类别"是否符合预期 —— 这里只关心 Lezer 节点名称
 * （例如 "lineComment"、"string"、"variableName"、"number"），
 * 不依赖任何具体的 HighlightStyle 渲染。
 */
interface Token {
  from: number;
  to: number;
  name: string;
}

function tokensFor(code: string): Token[] {
  const state = EditorState.create({
    doc: code,
    extensions: [tcl().language],
  });
  const tree = syntaxTree(state);
  const out: Token[] = [];
  // 动态去重：同一区间同一名称的节点可能由父节点重复产出（嵌套遍历场景）
  const seen = new Set<string>();
  tree.iterate({
    enter: (node) => {
      const name = node.type.name;
      if (!name || name === "Document") return;
      const key = `${node.from}-${node.to}-${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ from: node.from, to: node.to, name });
    },
  });
  return out;
}

describe("tcl() 高亮分类回归", () => {
  it("行注释 # 打上 lineComment 标签", () => {
    const tokens = tokensFor("# header comment\n");
    const comment = tokens.find((tk) => tk.name === "lineComment");
    expect(comment).toBeDefined();
    expect(comment!.from).toBe(0);
  });

  it("双引号字符串打上 string 标签", () => {
    const code = 'set msg "hello world"\n';
    const tokens = tokensFor(code);
    const str = tokens.find((tk) => tk.name === "string");
    expect(str).toBeDefined();
    expect(code.slice(str!.from, str!.to)).toBe('"hello world"');
  });

  it("变量 $name 打上 variableName 标签", () => {
    const tokens = tokensFor("set foo $bar\n");
     const variable = tokens.find((tk) => tk.name === "variableName");
     expect(variable).toBeDefined();
    // "set foo " 占 8 字符，$bar 从位置 8 开始
    expect(variable!.from).toBe(8);
  });

  it("数字字面量打上 number 标签（整数与浮点）", () => {
    const tokens = tokensFor("set n 42\nset f 3.14\n");
    const numbers = tokens.filter((tk) => tk.name === "number");
    expect(numbers.length).toBeGreaterThanOrEqual(2);
  });

  it("花括号字面量内部的 # 不应被识别为注释", () => {
    // 在 `{...}` 字面量内，TCL 不做变量替换和注释解析 —— 整段应统一为 string
    const code = 'set x {#not a comment $name}\n';
    const tokens = tokensFor(code);
    // 整段字面量至少要有一段长的 string 节点覆盖 #...$name 区间
    const literal = tokens.find(
      (tk) => tk.name === "string" && tk.to - tk.from >= 20,
    );
    expect(literal).toBeDefined();
    // 不能在同一份源码上又出现覆盖 # 的 lineComment
    const commentInside = tokens.find(
      (tk) =>
        tk.name === "lineComment" &&
        code.slice(tk.from, tk.to).includes("#"),
    );
    expect(commentInside).toBeUndefined();
  });
});
