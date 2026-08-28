// quick open 工具函数

import { openFile } from "../api/commands";
import { useEditorStore } from "../hooks/useEditorStore";

/**
 * 解析 path:line:col 三合一路径。
 * 示例: "src/main.rs:42" → line=42, col=null
 *       "src/main.rs:42:10" → line=42, col=10
 *       "src/main.rs" → line=null, col=null
 *
 * 返回 { cleanPath, line, col }，cleanPath 去掉 :line:col 后缀。
 */
export function parseLineCol(path: string): {
  cleanPath: string;
  line: number | null;
  col: number | null;
} {
  // 先检测最后是否是 :数字 或 :数字:数字（排除 Windows 盘符如 C:\）
  // Windows 盘符匹配 /^[A-Za-z]:\//，提前返回
  if (/^[A-Za-z]:[/\\]/.test(path)) {
    return { cleanPath: path, line: null, col: null };
  }

  // 找最后一个 :line 或 :line:col
  // 从路径末尾向前搜索 ":数字" 模式
  const colonIdx = path.lastIndexOf(":");
  if (colonIdx < 0) return { cleanPath: path, line: null, col: null };

  const afterColon = path.slice(colonIdx + 1);
  // 如果 : 后面是纯数字 → 可能是行号
  if (/^\d+$/.test(afterColon)) {
    const line = parseInt(afterColon, 10);
    return { cleanPath: path.slice(0, colonIdx), line, col: null };
  }
  // 如果是 :数字:数字 模式
  const secondColon = path.lastIndexOf(":", colonIdx - 1);
  if (secondColon >= 0) {
    const middle = path.slice(secondColon + 1, colonIdx);
    const rest = path.slice(colonIdx + 1);
    if (/^\d+$/.test(middle) && /^\d+$/.test(rest)) {
      const lineNum = parseInt(middle, 10);
      const colNum = parseInt(rest, 10);
      return {
        cleanPath: path.slice(0, secondColon),
        line: lineNum,
        col: colNum,
      };
    }
  }

  return { cleanPath: path, line: null, col: null };
}

/**
 * 打开文件并跳转到指定行列。
 * path 可以带 :line 或 :line:col。
 * 如果 path 已经在后端打开（FileResult），直接跳转 ; 否则先 invoke openFile。
 */
export async function openWithLineCol(path: string): Promise<void> {
  const { cleanPath, line, col } = parseLineCol(path);
  const openFileOrSwitch = useEditorStore.getState().openFileOrSwitch;
  try {
    const result = await openFile(cleanPath);
    openFileOrSwitch(result);
    if (line != null) {
      useEditorStore.getState().setTargetLine(line, col);
    }
  } catch (e) {
    console.error("openWithLineCol failed:", e);
  }
}
