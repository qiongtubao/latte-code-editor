/**
 * 快捷键匹配工具。
 *
 * 这里集中处理三个在各个 keydown handler 里反复踩到的坑：
 *
 * 1. **Shift 会改变 `event.key` 的大小写。** 按下 Shift+F 时 `event.key`
 *    是 `"F"` 而不是 `"f"`（CapsLock 同理），所以
 *    `e.shiftKey && e.key === "f"` 这类判断恒为假。统一转小写比较。
 *
 * 2. **macOS 用 Cmd 而非 Ctrl。** 只判 `e.ctrlKey` 会让快捷键在 mac 上
 *    完全失效，必须同时接受 `metaKey`。
 *
 * 3. **修饰键必须精确匹配。** 若 `Ctrl+S` 的判断不排除 Alt，那么
 *    `Ctrl+Alt+S` 会同时命中「保存」和「停止 LSP」两个分支；在 else-if
 *    链里则表现为更具体的组合（如 Ctrl+Alt+Shift+S）被靠前的宽松分支
 *    （Ctrl+Shift+S）抢先匹配而永远无法触发。因此 `isChord` 要求
 *    Shift/Alt 的状态**完全一致**，未声明即代表必须未按下。
 *    这样各分支互斥，书写顺序不再影响正确性。
 */

export interface ChordOptions {
  /** 是否要求按下 Shift。默认 false，即要求 Shift 未按下。 */
  shift?: boolean;
  /** 是否要求按下 Alt/Option。默认 false，即要求 Alt 未按下。 */
  alt?: boolean;
}

/** 主修饰键：Ctrl（Windows/Linux）或 Cmd（macOS）。 */
export function hasMod(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

/** 归一化按键名，消除 Shift/CapsLock 带来的大小写差异。 */
export function normalizeKey(e: KeyboardEvent): string {
  return e.key.toLowerCase();
}

/**
 * 精确匹配一个以 Ctrl/Cmd 为主修饰键的组合键。
 *
 * @param key 目标按键，大小写不敏感（如 `"s"`、`"f"`）
 */
export function isChord(
  e: KeyboardEvent,
  key: string,
  opts: ChordOptions = {},
): boolean {
  if (!hasMod(e)) return false;
  if (e.shiftKey !== (opts.shift ?? false)) return false;
  if (e.altKey !== (opts.alt ?? false)) return false;
  return normalizeKey(e) === key.toLowerCase();
}
