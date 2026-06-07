import { invoke } from "@tauri-apps/api/core";

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

export interface OpenFolderResult {
  root: string;
  entries: FsEntry[];
  has_graph: boolean;
  graph_node_count: number;
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

export async function replaceInFiles(
  query: string,
  replacement: string,
  includeGlob?: string,
  excludeGlob?: string,
): Promise<ReplaceFileResult[]> {
  return invoke<ReplaceFileResult[]>("replace_in_files", { query, replacement, includeGlob, excludeGlob });
}

export async function listDirectory(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("list_directory", { path });
}

export async function buildCodeGraph(): Promise<BuildResult> {
  return invoke<BuildResult>("build_code_graph");
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
