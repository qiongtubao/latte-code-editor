use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocSuggestion {
    pub title: String,
    pub doc_type: String,
    pub rel_path: String,
    pub sources: Vec<String>,
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

fn classify_file(path: &Path) -> Option<(String, String, String)> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let lower = stem.to_lowercase();

    if lower.starts_with("test_")
        || lower.contains("test")
        || lower.starts_with("ctrip_")
        || lower == "main"
        || lower == "app"
    {
        return None;
    }

    // Redis data types
    let types: &[(&str, &str)] = &[
        ("t_string", "String"), ("t_list", "List"), ("t_hash", "Hash"),
        ("t_set", "Set"), ("t_zset", "ZSet"), ("t_stream", "Stream"),
    ];
    for (prefix, name) in types {
        if lower == *prefix {
            return Some((name.to_string(), "entity".into(), format!("Redis data type: {prefix}.c")));
        }
    }

    // Core data structures
    let data: &[&str] = &[
        "sds", "adlist", "dict", "skiplist", "intset", "quicklist", "listpack", "rax",
        "zskiplist", "ziplist", "zipmap",
    ];
    if data.contains(&lower.as_str()) {
        return Some((capitalize(&stem), "entity".into(), "core data structure".into()));
    }

    // Networking
    if matches!(lower.as_str(), "anet" | "connection" | "sockcompat" | "tls") {
        return Some((capitalize(&stem), "concept".into(), "networking primitive".into()));
    }

    // Persistence/replication
    if matches!(lower.as_str(), "rdb" | "aof" | "cluster" | "replication" | "slave"
        | "sentinel" | "childinfo" | "config") {
        return Some((capitalize(&stem), "feature".into(), "persistence/replication".into()));
    }

    // Server / event loop
    if matches!(lower.as_str(), "server" | "networking" | "ae" | "ae_epoll" | "ae_kqueue" | "ae_select" | "ae_evport") {
        return Some((capitalize(&stem), "concept".into(), "server/event loop".into()));
    }

    None
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_alphabetic() { break; }
        chars.next();
    }
    let mut out = String::new();
    if let Some(c) = chars.next() {
        out.push(c.to_ascii_uppercase());
    }
    for c in chars { out.push(c); }
    out
}

pub fn scan_project(project_root: &Path) -> ScanResult {
    let mut by_title: HashSet<String> = HashSet::new();
    let mut source_files = 0usize;
    let mut suggested_docs: Vec<DocSuggestion> = Vec::new();

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
            if by_title.contains(&title) {
                if let Some(s) = suggested_docs.iter_mut().find(|s| s.title == title) {
                    if s.sources.len() < 5 { s.sources.push(rel_str); }
                }
            } else {
                by_title.insert(title.clone());
                let slug = title.to_lowercase().replace([' ', '_'], "-");
                suggested_docs.push(DocSuggestion {
                    title,
                    rel_path: format!("{doc_type}s/{slug}.md"),
                    doc_type,
                    sources: vec![rel_str],
                    reason,
                });
            }
        }
    }

    let top_count = std::fs::read_dir(project_root)
        .map(|rd| rd.filter_map(Result::ok).filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with(".")).count())
        .unwrap_or(0);

    suggested_docs.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    ScanResult {
        project_root: project_root.to_string_lossy().to_string(),
        stats: ScanStats {
            source_files,
            top_level_dirs: top_count,
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
    fn classify_redis_string() {
        let (title, ty, _) = classify_file(Path::new("t_string.c")).unwrap();
        assert_eq!(title, "String");
        assert_eq!(ty, "entity");
    }

    #[test]
    fn classify_redis_list() {
        let (title, _, _) = classify_file(Path::new("t_list.c")).unwrap();
        assert_eq!(title, "List");
    }

    #[test]
    fn classify_data_structure() {
        let (title, ty, _) = classify_file(Path::new("dict.c")).unwrap();
        assert_eq!(title, "Dict");
        assert_eq!(ty, "entity");
    }

    #[test]
    fn classify_persistence() {
        let (title, ty, _) = classify_file(Path::new("rdb.c")).unwrap();
        assert_eq!(title, "Rdb");
        assert_eq!(ty, "feature");
    }

    #[test]
    fn classify_skip_test() {
        assert!(classify_file(Path::new("test_foo.c")).is_none());
    }

    #[test]
    fn scan_real_dir() {
        let dir = tempdir().unwrap();
        let d = dir.path();
        fs::write(d.join("t_string.c"), "").unwrap();
        fs::write(d.join("dict.c"), "").unwrap();
        fs::write(d.join("rdb.c"), "").unwrap();
        let r = scan_project(d);
        assert!(!r.suggested_docs.is_empty());
    }

    #[test]
    fn scan_redis_dir() {
        let path = std::path::Path::new("/home/dong/Documents/github/redis");
        if !path.is_dir() { return; }
        let r = scan_project(path);
        for d in &r.suggested_docs {
            println!("  [{:>8}] {} ({} sources) {}", d.doc_type, d.title, d.sources.len(), d.rel_path);
        }
        assert!(r.suggested_docs.len() > 5);
    }
}
