import { invoke } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

export interface ScreenshotResult {
  path: string;
  size_bytes: number;
}

/** Capture the main window and save to ~/Pictures/latte-screenshots/ */
export async function screenshotWindow(): Promise<ScreenshotResult> {
  return invoke<ScreenshotResult>("screenshot_window");
}

/**
 * Copy a screenshot to the system clipboard via Tauri's native clipboard
 * plugin. The browser's navigator.clipboard.write() doesn't always work
 * for binary data inside a Tauri webview, so we use the Rust side.
 *
 * 传**文件路径**：Tauri 的 `JsImage` 是 `#[serde(untagged)]`，字符串会被
 * 解析成 `Path` 变体，由 Rust 侧读盘解码（需 tauri 的 `image-png` feature）。
 * 早先这里传的是 base64 字符串，同样落进 `Path` 变体、被当成一个几 MB 长的
 * 文件名，剪贴板必然失败 —— 而调用方只 catch 后返回 false，于是静默降级。
 */
export async function copyScreenshotToClipboard(result: ScreenshotResult): Promise<boolean> {
  try {
    await writeImage(result.path);
    return true;
  } catch (e) {
    console.error("clipboard writeImage failed:", e);
    return false;
  }
}
