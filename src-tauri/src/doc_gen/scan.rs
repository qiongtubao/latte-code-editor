//! Project scanner for the doc-generation workflow.
//!
//! Walks a project root, identifies top-level subdirectories, and groups
//! source files into suggested document categories. Output is consumed by
//! the frontend DocGenModal to let the user multi-select which stubs to
//! generate.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocSuggestion {
    /// Display title for the suggestion (e.g. "String", "Persistence").
    pub title: String,
    /// Top-level category (entities / concepts / features / spec / other).
    pub doc_type: String,
    /// Suggested file path, relative to the docs output dir.
    /// e.g. "entities/string.md"
    pub rel_path: String,
    /// First few representative source files in this group.
    pub sources: Vec<String>,
    /// Why this grouping was suggested (heuristic reason).
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub project_root: String,
    pub suggested_docs: Vec<DocSuggestion>,
    pub stats: ScanStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScanStats {
    pub source_files: usize,
    pub top_level_dirs: usize,
    pub suggested_doc_count: usize,
}

/// Heuristics for mapping a single source file to a doc category.
fn classify_file(path: &Path) -> Option<(String, String, String)> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let lower = stem.to_lowercase();

    // Skip test files, generated files, third-party
    if lower.starts_with("test_")
        || lower.contains("test")
        || lower.starts_with("ctrip_")
        || lower == "main"
        || lower == "app"
    {
        return None;
    }

    // Redis-style: src/t_string.c, t_list.c → entity "String", "List"
    if let Some(rest) = stem.strip_prefix('t') {
        if !rest.is_empty() && rest.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Some((capitalize(rest), "entity".into(), format!("Redis data type: t_{rest}.c")));
        }
    }

    // Generic data structures in adlist.c, dict.c, sds.c, etc.
    let known_data_structures: &[&str] = &[
        "sds", "adlist", "dict", "skiplist", "intset", "quicklist", "listpack", "rax",
        "zskiplist", "ziplist", "zipmap", "stream",
    ];
    if known_data_structures.contains(&lower.as_str()) {
        return Some((capitalize(&stem), "entity".into(), "core data structure".into()));
    }

    // Networking
    if matches!(lower.as_str(), "anet" | "connection" | "sockcompat" | "tls") {
        return Some((capitalize(&stem), "concept".into(), "networking primitive".into()));
    }

    // Persistence
    if matches!(lower.as_str(), "rdb" | "aof" | "cluster" | "replication" | "slave" | "sentintel" | "sentinel" | "childinfo" | "config") {
        return Some((capitalize(&stem), "feature".into(), "persistence / replication".into()));
    }

fn capitalize(s: &str) -> String {
    // Skip leading underscores/digits, uppercase the first alphabetic char, then keep the rest.
    let mut chars = s.chars().peekable();
    // Skip leading non-alphabetic.
    while let Some(&c) = chars.peek() {
        if c.is_ascii_alphabetic() { break; }
        chars.next();
    }
    let mut out = String::new();
    if let Some(&c) = chars.peek() {
        out.push(c.to_ascii_uppercase());
        chars.next();
    }
    for c in chars { out.push(c); }
    out
}

    // Server / event loop
    if matches!(lower.as_str(), "server" | "networking" | "ae" | "ae_epoll" | "ae_kqueue" | "ae_select" | "ae_evport") {
        return Some((capitalize(&stem), "concept".into(), "server / event loop".into()));
    }

    None
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    let first = chars.next().unwrap_or(' ').to_uppercase().to_string();
    format!("{first}{}", chars.as_str())
}

/// Walk `project_root` and produce a list of DocSuggestion.
pub fn scan_project(project_root: &Path) -> ScanResult {
    let mut by_title: std::collections::HashMap<String, DocSuggestion> = std::collections::HashMap::new();
    let mut source_files = 0usize;
    let mut seen_titles: HashSet<String> = HashSet::new();

    for entry in WalkDir::new(project_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() { continue; }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("c") { continue; }
        if !path.starts_with(project_root) { continue; }

        source_files += 1;

        let rel = path.strip_prefix(project_root).unwrap_or(path);
        let rel_str = rel.to_string_lossy().to_string();
        if rel_str.contains("/test/") || rel_str.contains("/tests/") { continue; }

        if let Some((title, doc_type, reason)) = classify_file(path) {
            if !seen_titles.contains(&title) {
                seen_titles.insert(title.clone());
                let slug = title.to_lowercase().replace([' ', '_'], "-");
                by_title.entry(title.clone()).or_insert_with(|| DocSuggestion {
                    title: title.clone(),
                    doc_type: doc_type.clone(),
                    rel_path: format!("{doc_type}s/{slug}.md"),
                    sources: vec![],
                    reason: reason.clone(),
                });
            }
            if let Some(s) = by_title.get_mut(&title) {
                if s.sources.len() < 5 {
                    s.sources.push(rel_str);
                }
            }
        }
    }

    // Top-level directory scan
    let top_level_dirs: Vec<String> = std::fs::read_dir(project_root)
        .ok()
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with("."))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();

    let mut suggested_docs: Vec<DocSuggestion> = by_title.into_values().collect();
    suggested_docs.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    ScanResult {
        project_root: project_root.to_string_lossy().to_string(),
        stats: ScanStats {
            source_files,
            top_level_dirs: top_level_dirs.len(),
            suggested_doc_count: suggested_docs.len(),
        },
        suggested_docs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn classify_redis_type() {
        let p = Path::new("/tmp/t_string.c");
        let (title, ty, _) = classify_file(p).unwrap();
        assert_eq!(title, "String");
        assert_eq!(ty, "entity");
    }

    #[test]
    fn classify_data_structure() {
        let p = Path::new("/tmp/dict.c");
        let (title, ty, _) = classify_file(p).unwrap();
        assert_eq!(title, "Dict");
        assert_eq!(ty, "entity");
    }

    #[test]
    fn classify_persistence() {
        let p = Path::new("/tmp/rdb.c");
        let (title, ty, _) = classify_file(p).unwrap();
        assert_eq!(title, "Rdb");
        assert_eq!(ty, "feature");
    }

    #[test]
    fn classify_skip_test() {
        assert!(classify_file(Path::new("/tmp/test_foo.c")).is_none());
    }

    #[test]
    fn scan_real_dir() {
        let dir = tempdir().unwrap();
        let d = dir.path();
        fs::write(d.join("t_string.c"), "").unwrap();
        fs::write(d.join("dict.c"), "").unwrap();
        fs::write(d.join("rdb.c"), "").unwrap();
        fs::write(d.join("test_foo.c"), "").unwrap();
        let r = scan_project(d);
        assert_eq!(r.suggested_docs.len(), 3);
        assert!(r.suggested_docs.iter().any(|d| d.title == "String"));
    }
}
