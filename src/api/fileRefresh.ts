/**
 * 文件刷新相关 API
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * 刷新文件缓存（从磁盘重新加载）
 * @param filePath 文件路径
 */
export async function refreshFile(filePath: string): Promise<{
  path: string;
  content: string;
  line_count: number;
  byte_size: number;
  is_large_file: boolean;
}> {
  return invoke("refresh_file", { path: filePath });
}

/**
 * 检查文件是否在磁盘上被修改
 * @param filePath 文件路径
 * @returns true 表示磁盘文件已变化
 */
export async function checkFileChanged(filePath: string): Promise<boolean> {
  return invoke("check_file_changed", { path: filePath });
}