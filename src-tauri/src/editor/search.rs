use glob::Pattern;
use serde::Serialize;
use std::path::Path;
use walkdir::WalkDir;

/// A single match in a file
#[derive(Serialize)]
pub struct SearchMatch {
    pub file_path: String,
    pub line_number: u32,
    pub line_content: String,
}

/// Search options with optional include/exclude glob patterns
pub struct SearchOptions {
    pub query: String,
    pub max_results: usize,
    pub exclude_dirs: Vec<String>,
    pub include_glob: Option<String>,
    pub exclude_glob: Option<String>,
}

fn file_matches(path: &Path, pattern: &Option<String>) -> bool {
    match pattern {
        Some(p) => Pattern::new(p).map(|pat| pat.matches_path(path)).unwrap_or(true),
        None => true,
    }
}

fn walk_source_files<F>(root: &Path, exclude_dirs: &[String], include_glob: &Option<String>, exclude_glob: &Option<String>, mut cb: F)
where F: FnMut(&walkdir::DirEntry) {
    let exclude: Vec<&str> = exclude_dirs.iter().map(|s| s.as_str()).collect();
    for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
        if e.depth() == 0 { return true; }
        let name = e.file_name().to_string_lossy();
        if e.file_type().is_dir() { return !exclude.contains(&name.as_ref()); }
        true
    }) {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        if !entry.file_type().is_file() { continue; }
        let ext = match entry.path().extension().and_then(|e| e.to_str()) {
            Some(e) => e, None => continue,
        };
        if !TEXT_EXTENSIONS.contains(&ext) { continue; }
        if let Ok(m) = std::fs::metadata(entry.path()) { if m.len() > 1_048_576 { continue; } }
        if !file_matches(entry.path(), include_glob) { continue; }
        if !file_matches(entry.path(), exclude_glob) { continue; }
        cb(&entry);
    }
}

/// Search for text across all source files.
pub fn search_text(root: &Path, opts: &SearchOptions) -> Vec<SearchMatch> {
    let q = opts.query.to_lowercase();
    let mut results = Vec::new();
    walk_source_files(root, &opts.exclude_dirs, &opts.include_glob, &opts.exclude_glob, |entry| {
        if results.len() >= opts.max_results { return; }
        let content = match std::fs::read_to_string(entry.path()) { Ok(c) => c, Err(_) => return };
        for (i, line) in content.lines().enumerate() {
            if results.len() >= opts.max_results { break; }
            if line.to_lowercase().contains(&q) {
                results.push(SearchMatch {
                    file_path: entry.path().to_string_lossy().to_string(),
                    line_number: (i + 1) as u32,
                    line_content: line.trim().chars().take(150).collect(),
                });
            }
        }
    });
    results
}

/// Replace all occurrences across all source files.
pub fn replace_text(
    root: &Path, query: &str, replacement: &str,
    exclude_dirs: &[String], include_glob: &Option<String>, exclude_glob: &Option<String>,
) -> Vec<(String, usize)> {
    let mut results = Vec::new();
    walk_source_files(root, exclude_dirs, include_glob, exclude_glob, |entry| {
        let path = entry.path();
        let content = match std::fs::read_to_string(path) { Ok(c) => c, Err(_) => return };
        let new_content = content.replace(query, replacement);
        if new_content == content { return; }
        if std::fs::write(path, &new_content).is_ok() {
            let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string();
            results.push((relative, content.matches(query).count()));
        }
    });
    results
}

const TEXT_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "py", "rb", "go", "java", "kt", "swift",
    "c", "h", "cpp", "hpp", "cc", "hh", "cxx", "hxx",
    "css", "scss", "less", "html", "vue", "svelte",
    "json", "yaml", "yml", "toml", "xml", "md",
    "sh", "bash", "zsh", "fish",
    "sql", "graphql", "proto",
    "txt", "cfg", "conf", "ini",
];
