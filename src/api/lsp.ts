/**
 * LSP 状态查询 API
 * 用于手动触发模式
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * LSP 状态信息（增强版 - 包含内存占用）
 */
export interface LspStatusInfo {
  language: string;
  state: "stopped" | "starting" | "running" | "hibernated" | "error";
  project_root: string;
  supports_hibernation: boolean;
  /** 内存占用（MB）- 通过 ps 命令获取 */
  memory_mb?: number;
  /** 启动时间戳（毫秒）*/
  started_at?: number;
  /** 最后使用时间戳（毫秒）*/
  last_used_at?: number;
}

export async function startLsp(language: string): Promise<void> {
  return invoke("lsp_start", { language });
}

export async function stopLsp(language: string): Promise<void> {
  return invoke("lsp_stop", { language });
}

export async function hibernateLsp(language: string): Promise<void> {
  return invoke("lsp_hibernate", { language });
}

export async function wakeLsp(language: string): Promise<void> {
  return invoke("lsp_wake", { language });
}

export async function stopAllLsp(): Promise<void> {
  return invoke("lsp_stop_all");
}

export async function hibernateAllLsp(): Promise<void> {
  return invoke("lsp_hibernate_all");
}

export async function getLspStatus(): Promise<LspStatusInfo[]> {
  return invoke<LspStatusInfo[]>("lsp_status");
}

/**
 * 获取所有 LSP 状态（包含内存信息）
 * 这个命令会查询系统获取每个 LSP 进程的实际内存占用
 */
export async function getLspStatusWithMemory(): Promise<LspStatusInfo[]> {
  return invoke<LspStatusInfo[]>("lsp_status_with_memory");
}

export async function isLspRunning(language: string): Promise<boolean> {
  return invoke<boolean>("lsp_is_running", { language });
}
