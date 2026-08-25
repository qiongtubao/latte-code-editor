import { cpp } from "@codemirror/lang-cpp";
import type { Extension } from "@codemirror/state";
import { StreamLanguage, LanguageSupport } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";

/**
 * TCL 语言扩展（基于 StreamLanguage）。
 *
 * 设计要点：
 * - CodeMirror 官方未提供 @codemirror/lang-tcl，本实现按 TCL 词法规则手写 StreamParser。
 * - 覆盖常用高亮：行注释 `#`、双引号字符串（含反斜杠转义与跨行）、
 *   花括号字面量 `{}`（内部不解析，带嵌套深度计数）、变量 `$name` / `$name(idx)` / `${name}`、
 *   命令/标识符、数字字面量（含十进制 / 浮点 / 十六进制 / 八进制 / 指数）。
 * - 高亮类别尽量与现有语言包一致：注释、字符串、变量名、数字、关键字、标点。
 */
interface TclState {
  /** 是否在花括号字面量 `{...}` 内部；内部所有字符都按字符串处理，包括 #、$ 等。 */
  inBraceLiteral: boolean;
  /** 是否在 `"..."` 字符串内部；用于正确处理跨行字符串。 */
  inString: boolean;
}

const tclLanguage = StreamLanguage.define<TclState>({
  startState() {
    return { inBraceLiteral: false, inString: false };
  },

  // 字符串状态允许跨行；下一行重置 inString 时依下一字符决定
  copyState(state) {
    return { inBraceLiteral: state.inBraceLiteral, inString: state.inString };
  },

  token(stream, state) {
    // 花括号字面量模式：吞所有字符直到匹配的右大括号
    if (state.inBraceLiteral) {
      let depth = 1;
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") {
          // 转义：原样吃下一个字符（保留在字面量里）
          if (!stream.eol()) stream.next();
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            state.inBraceLiteral = false;
            return "string";
          }
        }
      }
      return "string";
    }

    // 双引号字符串模式
    if (state.inString) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") {
          // 跳过被转义的下一个字符；保留在字符串里
          if (!stream.eol()) stream.next();
          continue;
        }
        if (ch === '"') {
          state.inString = false;
          return "string";
        }
      }
      // 字符串跨行延续：保持状态等待下一行
      return "string";
    }

    // 跳过行首空白
    if (stream.eatSpace()) return null;

    const ch = stream.next();
    if (!ch) return null;

    // 行注释：# 直到行尾（仅在非字符串/非字面量内生效；此分支已确保）
    if (ch === "#") {
      stream.skipToEnd();
      return "lineComment";
    }

    // 字符串起始：吃掉开始的 "
    if (ch === '"') {
      state.inString = true;
      return "string";
    }

    // 花括号字面量起始
    if (ch === "{") {
      if (stream.peek() === "}") {
        // 空字面量 {}
        stream.next();
        return "string";
      }
      state.inBraceLiteral = true;
      return "string";
    }

    // 变量：$name / $name(index) / ${name}
    if (ch === "$") {
      if (stream.peek() === "{") {
        stream.next();
        while (!stream.eol() && stream.next() !== "}") {
          /* 吞下 } 之前的所有字符 */
        }
        return "variableName";
      }
      stream.eatWhile((c) => /[A-Za-z0-9_]/.test(c));
      if (stream.peek() === "(") {
        stream.next();
        let depth = 1;
        while (!stream.eol() && depth > 0) {
          const c = stream.next();
          if (c === "(") depth++;
          else if (c === ")") depth--;
        }
      }
      return "variableName";
    }

    // 命令分隔 / 子命令替换（仅高亮为标点，不做配对）
    if (ch === ";" || ch === "[" || ch === "]") {
      return "punctuation";
    }

    // 数字字面量
    if (
      /[0-9]/.test(ch) ||
      (ch === "." && /[0-9]/.test(stream.peek() ?? ""))
    ) {
      if (ch === "0" && (stream.peek() === "x" || stream.peek() === "X")) {
        stream.next();
        stream.eatWhile((c) => /[0-9A-Fa-f]/.test(c));
        return "number";
      }
      stream.eatWhile((c) => /[0-9]/.test(c));
      if (stream.peek() === ".") {
 stream.next();
        stream.eatWhile((c) => /[0-9]/.test(c));
      }
      if (stream.peek() === "e" || stream.peek() === "E") {
        stream.next();
        if (stream.peek() === "+" || stream.peek() === "-") stream.next();
        stream.eatWhile((c) => /[0-9]/.test(c));
      }
      return "number";
    }

    // 命令名 / 标识符 / 关键字
    if (/[A-Za-z_:]/.test(ch)) {
      stream.eatWhile((c) => /[A-Za-z0-9_:]/.test(c));
      return "keyword";
    }

    // 其他字符透传
    return null;
  },

  languageData: {
    commentTokens: { line: "#" },
  },
});

/**
 * 与 CodeMirror 其他语言包保持一致形态的工厂函数。
 */
export function tcl(): LanguageSupport {
  return new LanguageSupport(tclLanguage);
}

export function languages(filePath: string | null): Extension {
  if (!filePath) return [];

  const ext = filePath.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
      return javascript({
        typescript: ext === "ts" || ext === "tsx",
        jsx: ext === "tsx" || ext === "jsx",
      });
    case "rs":
      return rust();
    case "py":
      return python();
    case "json":
    case "jsonc":
      return json();
    case "c":
    case "h":
      return cpp();
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
    case "hxx":
      return cpp();
    case "md":
    case "mdx":
      return markdown();
    case "tcl":
      return tcl();
     default:
       return [];
   }
 }
