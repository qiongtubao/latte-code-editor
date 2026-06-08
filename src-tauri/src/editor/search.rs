use glob::Pattern;
use serde::Serialize;
use std::cmp::Reverse;
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

// =============================================================================
// Quick Open: fuzzy filename search (子序列匹配)
// =============================================================================

/// 模糊匹配得分：
/// - query 的每个字符必须按顺序出现在 path 中（子序列约束，大小写不敏感）
/// - 越靠前匹配 + 连续匹配 + camelCase 边界 + 文件名前缀，得分越高
/// - 得分 <= 0 表示不匹配
///
/// 实现细节：lower-case 用于大小写不敏感匹配，**但用原 path 字符判断 camelCase 边界**，
/// 否则 `UserLogin.ts` 压成 `userlogin.ts` 后丢失大写信息。
pub fn fuzzy_score(query: &str, path: &str) -> i32 {
    let q = query.to_lowercase();
    let p = path.to_lowercase();
    let q_bytes = q.as_bytes();
    let p_lower = p.as_bytes();
    let path_bytes = path.as_bytes();
    if q_bytes.is_empty() { return 0; }

    let mut score: i32 = 0;
    let mut qi = 0;
    let mut prev_match_idx: Option<usize> = None;
    let basename_start = p.rfind('/').map(|i| i + 1).unwrap_or(0);
    let basename = &p[basename_start..];

    for (pi, &pb) in p_lower.iter().enumerate() {
        if qi >= q_bytes.len() { break; }
        if pb == q_bytes[qi] {
            // 连续匹配 +5
            if let Some(prev) = prev_match_idx {
                if pi == prev + 1 { score += 5; }
            }
            // 位置 / 边界 bonus（用原 path 大小写判断 camelCase）
            if pi == 0 {
                score += 8; // path 起点
            } else {
                let prev_ch = path_bytes[pi - 1];
                if matches!(prev_ch, b'_' | b'-' | b'/' | b'.' | b' ') {
                    score += 3;
                } else if prev_ch.is_ascii_uppercase() && pb.is_ascii_lowercase() {
                    // camelCase 边界（prev 大写 + 当前小写）
                    score += 2;
                }
            }
            prev_match_idx = Some(pi);
            qi += 1;
        }
    }
    if qi < q_bytes.len() {
        return 0; // query 没匹配完
    }
    // basename 命中前缀额外加分
    if basename.starts_with(&q) {
        score += 20;
    } else if basename.contains(&q) {
        score += 10;
    }
    // 越短的路径得分越高
    score -= (p.len() as i32) / 10;
    score
}

#[derive(Serialize, Debug, Clone)]
pub struct FileMatch {
    pub path: String,
    pub score: i32,
}

/// 按子序列模糊匹配在 root 下找文件，返回 top N
/// 不做内容搜索，只走文件名（Quick Open 语义）
pub fn find_files(root: &Path, query: &str, max_results: usize, exclude_dirs: &[String]) -> Vec<FileMatch> {
    let exclude: Vec<&str> = exclude_dirs.iter().map(|s| s.as_str()).collect();
    let mut scored: Vec<FileMatch> = Vec::new();

    for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
        if e.depth() == 0 { return true; }
        let name = e.file_name().to_string_lossy();
        if e.file_type().is_dir() { return !exclude.contains(&name.as_ref()); }
        true
    }) {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        if !entry.file_type().is_file() { continue; }
        let path_str = entry.path().to_string_lossy().to_string();
        let s = fuzzy_score(query, &path_str);
        if s > 0 {
            scored.push(FileMatch { path: path_str, score: s });
        }
    }

    scored.sort_by_key(|m| Reverse(m.score));
    scored.truncate(max_results);
    scored
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ---- fuzzy_score ----

    #[test]
    fn empty_query_returns_zero() {
        assert_eq!(fuzzy_score("", "/a/foo.ts"), 0);
    }

    #[test]
    fn perfect_basename_prefix_scores_high() {
        let s = fuzzy_score("foo", "/a/foo.ts");
        assert!(s > 20, "expected >20 got {}", s);
    }

    #[test]
    fn subsequence_in_basename_scores_positive() {
        let s = fuzzy_score("usap", "/a/user_apply.ts");
        assert!(s > 0);
    }

    #[test]
    fn non_subsequence_returns_zero() {
        assert_eq!(fuzzy_score("z", "/a/foo.ts"), 0);
    }

    #[test]
    fn case_insensitive_match() {
        let s = fuzzy_score("FOO", "/a/Foo.ts");
        assert!(s > 0);
    }

    #[test]
    fn camel_case_boundary_gives_bonus() {
        // 'o' 匹配 UserLogin.ts (位置 5，前一字符 'L' 大写→小写) → camel bonus
        // 'o' 匹配 userlogin.ts (位置 5，前一字符 'l' 小写) → 无 bonus
        let s_camel = fuzzy_score("o", "/a/UserLogin.ts");
        let s_mid = fuzzy_score("o", "/a/userlogin.ts");
        assert!(s_camel > s_mid, "camel {} should beat mid {}", s_camel, s_mid);
    }

    #[test]
    fn word_boundary_gives_bonus() {
        // 'a' 匹配 user_apply.ts: 'a' 位置 5 (前 '_' → +3 boundary)
        // 'a' 匹配 userxapply.ts: 'a' 位置 5 (前 'x' → 0)
        // 路径无 /a/ 前缀避免 query 在前缀里就匹配完
        let s_boundary = fuzzy_score("a", "user_apply.ts");
        let s_mid = fuzzy_score("a", "userxapply.ts");
        assert!(s_boundary > s_mid, "boundary {} should beat mid {}", s_boundary, s_mid);
    }

    // ---- find_files ----

    #[test]
    fn find_files_returns_empty_for_no_match() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("foo.ts"), "").unwrap();
        let r = find_files(dir.path(), "zzzzzz", 10, &[]);
        assert!(r.is_empty());
    }

    #[test]
    fn find_files_finds_by_basename() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/header.ts"), "").unwrap();
        fs::write(dir.path().join("src/footer.ts"), "").unwrap();
        fs::write(dir.path().join("src/main.rs"), "").unwrap();
        let r = find_files(dir.path(), "hdr", 10, &[]);
        assert!(!r.is_empty());
        assert!(r[0].path.ends_with("header.ts"));
    }

    #[test]
    fn find_files_subsequence_ranks_better_matches_first() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("user_apply.ts"), "").unwrap();
        fs::write(dir.path().join("user_state_provider.ts"), "").unwrap();
        let r = find_files(dir.path(), "usap", 10, &[]);
        assert!(!r.is_empty());
        assert!(r[0].path.contains("user_apply"));
    }

    #[test]
    fn find_files_respects_exclude_dirs() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("node_modules/foo")).unwrap();
        fs::write(dir.path().join("node_modules/foo/bar.ts"), "").unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/bar.ts"), "").unwrap();
        let r = find_files(dir.path(), "bar", 10, &vec!["node_modules".into()]);
        assert_eq!(r.len(), 1);
        assert!(r[0].path.contains("/src/"));
    }

    #[test]
    fn find_files_respects_max_results() {
        let dir = TempDir::new().unwrap();
        for i in 0..10 {
            fs::write(dir.path().join(format!("foo{}.ts", i)), "").unwrap();
        }
        let r = find_files(dir.path(), "foo", 3, &[]);
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn find_files_empty_query_returns_empty() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.ts"), "").unwrap();
        let r = find_files(dir.path(), "", 10, &[]);
        assert!(r.is_empty());
    }
}
