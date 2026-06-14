import { invoke } from "@tauri-apps/api/core";

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  size_bytes: number;
}

/** Capture the main window and save to ~/Pictures/latte-screenshots/ */
export async function screenshotWindow(): Promise<ScreenshotResult> {
  return invoke<ScreenshotResult>("screenshot_window");
}
