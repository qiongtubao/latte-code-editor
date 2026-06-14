/**
 * Doc-gen API for the latte-code-editor.
 */

import { invoke } from "@tauri-apps/api/core";

export interface DocSuggestion {
  title: string;
  doc_type: string;
  rel_path: string;
  sources: string[];
  reason: string;
}

export interface ScanResult {
  project_root: string;
  suggested_docs: DocSuggestion[];
  stats: {
    source_files: number;
    top_level_dirs: number;
    suggested_doc_count: number;
  };
}

export async function scanProjectForDocs(projectRoot: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_project_for_docs", { projectRoot });
}

export async function writeDocStub(
  docsRoot: string,
  suggestion: DocSuggestion,
  allSuggestions?: DocSuggestion[],
): Promise<string> {
  return invoke<string>("write_doc_stub", {
    docsRoot,
    suggestion,
    allSuggestions: allSuggestions ?? null,
  });
}
