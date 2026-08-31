import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceMeta } from "./workspace";

export interface FileResult {
  path: string;
  content: string;
  line_count: number;
  is_large_file: boolean;
  is_modified: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
}

/**
 * 打开文件夹命令的返回。
 * 后端 `open_folder` 一次调用同时返回：项目根目录元数据 + 后端权威 workspace id + meta。
 * 这样前端 useWorkspaceStore.openFolder 一次 await 就能写入 store，避免"先 open_folder 再 list_workspaces"的 race。
 */
export interface OpenFolderResult {
  root: string;
  entries: FsEntry[];
  has_graph: boolean;
  graph_node_count: number;
  workspace_id: string;
  workspace_meta: WorkspaceMeta;
}

export interface BuildResult {
  files_scanned: number;
  nodes_created: number;
  edges_created: number;
  errors: string[];
}

export async function openFile(path: string): Promise<FileResult> {
  return invoke<FileResult>("open_file", { path });
}

export interface TextFileStat {
  total_lines: number;
  byte_size: number;
}

export interface FileRange {
  start_line: number;
  lines: string[];
  eof: boolean;
}

/** Stream file metadata without transferring the whole file over IPC. */
export async function statTextFile(path: string): Promise<TextFileStat> {
  return invoke<TextFileStat>("stat_text_file", { path });
}

/** Read one bounded line window for the virtualized large-file viewer. */
export async function readFileRange(
  path: string,
  startLine: number,
  maxLines: number,
): Promise<FileRange> {
  return invoke<FileRange>("read_file_range", { path, startLine, maxLines });
}

export async function saveFile(path: string, content: string): Promise<void> {
  return invoke<void>("save_file", { path, content });
}

export async function getFileContent(path: string): Promise<FileResult> {
  return invoke<FileResult>("get_file_content", { path });
}

export async function openFolder(path: string): Promise<OpenFolderResult> {
  return invoke<OpenFolderResult>("open_folder", { path });
}

export interface SearchMatch {
  file_path: string;
  line_number: number;
  line_content: string;
}
export async function searchInFiles(
  query: string,
  includeGlob?: string,
  excludeGlob?: string,
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("search_in_files", { query, includeGlob, excludeGlob });
}

export interface ReplaceFileResult {
  file_path: string;
  count: number;
}

/** 匹配到但写盘失败的文件（磁盘满 / 只读 / 权限不足）。 */
export interface ReplaceFailure {
  file_path: string;
  error: string;
}

/**
 * 批量替换结果。失败项必须一并回报——替换直接写盘且无撤销，
 * 只看成功列表会让用户误以为全部替换成功，而工作区可能已半改。
 */
export interface ReplaceOutcome {
  replaced: ReplaceFileResult[];
  failed: ReplaceFailure[];
}

export async function replaceInFiles(
  query: string,
  replacement: string,
  includeGlob?: string,
  excludeGlob?: string,
): Promise<ReplaceOutcome> {
  return invoke<ReplaceOutcome>("replace_in_files", {
    query,
    replacement,
    includeGlob,
    excludeGlob,
  });
}

export async function listDirectory(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("list_directory", { path });
}

export async function buildCodeGraph(): Promise<BuildResult> {
  return invoke<BuildResult>("build_code_graph");
}

export interface UpdateReport {
  changed_files: number;
  nodes_added: number;
  nodes_removed: number;
  edges_rebuilt: number;
  duration_ms: number;
  error?: string | null;
}

export async function updateCodeGraph(
  paths: string[],
): Promise<UpdateReport> {
  return invoke<UpdateReport>("update_code_graph", { paths });
}

export async function createFile(path: string): Promise<void> {
  return invoke<void>("create_file", { path });
}

export async function createFolder(path: string): Promise<void> {
  return invoke<void>("create_folder", { path });
}

export async function deleteEntry(path: string): Promise<void> {
  return invoke<void>("delete_entry", { path });
}
