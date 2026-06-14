import { invoke } from "@tauri-apps/api/core";

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
 * Copy a screenshot to the system clipboard so the user can paste it
 * directly into chat / browser / editor. Falls back to text-only if
 * the browser doesn't support image clipboard.
 */
export async function copyScreenshotToClipboard(result: ScreenshotResult): Promise<boolean> {
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
    return false;
  }
  try {
    const bin = atob(result.data_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    const item = new ClipboardItem({ "image/png": blob });
    await navigator.clipboard.write([item]);
    return true;
  } catch (e) {
    console.error("clipboard write failed:", e);
    return false;
  }
}
