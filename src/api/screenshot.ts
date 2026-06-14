import { invoke } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

export interface ScreenshotResult {
  path: string;
  size_bytes: number;
  data_base64: string;
}

/** Capture the main window and save to ~/Pictures/latte-screenshots/ */
export async function screenshotWindow(): Promise<ScreenshotResult> {
  return invoke<ScreenshotResult>("screenshot_window");
}

/**
 * Copy a screenshot to the system clipboard via Tauri's native clipboard
 * plugin. The browser's navigator.clipboard.write() doesn't always work
 * for binary data inside a Tauri webview, so we use the Rust side.
 */
export async function copyScreenshotToClipboard(result: ScreenshotResult): Promise<boolean> {
  try {
    await writeImage(result.data_base64);
    return true;
  } catch (e) {
    console.error("clipboard writeImage failed:", e);
    return false;
  }
}
