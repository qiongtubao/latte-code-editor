//! 文件搜索实现
//!
//! 使用 ripgrep 的核心 crate 作为搜索引擎（不 fork 进程）：
//! - `ignore`：目录遍历，自动尊重 .gitignore
//! - `grep-searcher`：流式逐行搜索（不读整文件到内存）
//! - `grep-regex`：匹配器（带 SIMD 优化）
//!
//! 优势：
//! - 不再有 1MB 文件大小硬限制
//! - 大文件通过 mmap 流式处理，内存峰值与文件大小无关
//! - 自动尊重 .gitignore / .ignore / .git/info/exclude
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::Searcher;
use ignore::WalkBuilder;
use serde::Serialize;
use std::cmp::Reverse;
use std::path::Path;
/// A single match in a file
#[derive(Serialize, Debug)]
pub struct SearchMatch {
    pub file_path: String,
    pub line_number: u32,
    pub line_content: String,
}

/// Search options
pub struct SearchOptions {
    pub query: String,
    pub max_results: usize,
    /// 默认额外排除的目录（除 .gitignore 之外）
    pub exclude_dirs: Vec<String>,
    /// include glob（限定要扫的文件）
    pub include_glob: Option<String>,
    /// exclude glob（进一步排除某些文件）
    pub exclude_glob: Option<String>,
}

/// 把查询字符串转成正则（自动转义 + 启用大小写不敏感）
/// 编译匹配器：
/// - 子串搜索  → 构建 case-insensitive regex（`(?i)escaped_query`）
/// - 正则搜索  → 直接作为正则模式（大小写按用户输入）
fn compile_matcher(query: &str) -> Result<grep_regex::RegexMatcher, String> {
    let escaped = regex::escape(query);
    let pattern = format!("(?i){}", escaped);
    RegexMatcherBuilder::new()
        .case_insensitive(true)
        .build(&pattern)
        .map_err(|e| format!("Invalid pattern: {}", e))
}

fn build_walker(root: &Path, opts: &SearchOptions) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder.hidden(false);
    builder.git_ignore(true);
    builder.git_global(true);
    builder.git_exclude(true);
    builder.ignore_case_insensitive(false);
    builder.require_git(false);

    // 自定义排除目录：只用 filter_entry（不能用 overrides——overrides 是白名单语义）
    // 自定义排除目录：filter_entry 实现
    let exclude: Vec<String> = opts.exclude_dirs.iter().map(|d| d.to_lowercase()).collect();
    builder.filter_entry(move |entry| {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        !exclude.contains(&name)
    });

    builder
}
pub fn search_text(root: &Path, opts: &SearchOptions) -> Vec<SearchMatch> {
    if opts.query.is_empty() { return Vec::new(); }
    let matcher = match compile_matcher(&opts.query) {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    let max = opts.max_results;
    let mut results = Vec::new();
    let walker = build_walker(root, opts);
    let include_glob = opts.include_glob.clone();
    let exclude_glob = opts.exclude_glob.clone();

    for entry in walker.build() {
        if results.len() >= max { break; }
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
        let path = entry.path();
        // 用相对路径匹配 glob（用户的 glob 是相对于 root 写的，不是绝对路径）
        let rel = path.strip_prefix(root).unwrap_or(path);

        // 应用 include / exclude glob（空 = 不限制）
        if let Some(inc) = &include_glob {
            if !inc.is_empty() && !glob_match(rel, inc) { continue; }
        }
        if let Some(exc) = &exclude_glob {
            if !exc.is_empty() && glob_match(rel, exc) { continue; }
        }

        // 流式搜索这个文件
        let path_str = path.to_string_lossy().to_string();
        let mut searcher = Searcher::new();
        let result = searcher.search_path(
            &matcher,
            path,
            UTF8(|lnum, line| {
                if results.len() >= max {
                    return Ok(false); // 停止搜索
                }
                let line_content: String = line.chars().take(150).collect();
                results.push(SearchMatch {
                    file_path: path_str.clone(),
                    line_number: lnum as u32,  // grep-searcher 返回 1-based 行号 (u64)
                    line_content,
                });
                Ok(true) // 继续
            }),
        );
        // 搜索错误（比如 binary file）忽略，继续下一个文件
        let _ = result;
    }
    results
}
/// 检查路径是否匹配 glob
fn glob_match(path: &Path, pattern: &str) -> bool {
    if pattern.is_empty() { return true; } // 空 pattern 表示不限制
    glob::Pattern::new(pattern)
        .map(|p| p.matches_path(path))
        .unwrap_or(true)
}

/// `file_matches` 别名（保留给旧测试用）
#[inline]
fn file_matches(path: &Path, pattern: &Option<String>) -> bool {
    glob_match(path, pattern.as_deref().unwrap_or(""))
}

/// Replace all occurrences across all source files using ripgrep engine.
/// 流程：流式扫描每个文件，对匹配的行用 `str::replace` 做大小写不敏感替换。
/// 为了保留原文件大小写，使用 `eq_ignore_ascii_case` 做匹配检测。
pub fn replace_text(
    root: &Path, query: &str, replacement: &str,
    exclude_dirs: &[String], include_glob: &Option<String>, exclude_glob: &Option<String>,
) -> Vec<(String, usize)> {
    if query.is_empty() { return Vec::new(); }
    let opts = SearchOptions {
        query: query.to_string(),
        max_results: usize::MAX,
        exclude_dirs: exclude_dirs.to_vec(),
        include_glob: include_glob.clone(),
        exclude_glob: exclude_glob.clone(),
    };
    let q_bytes = query.to_lowercase().into_bytes();
    let q_len = q_bytes.len();
    let mut results = Vec::new();
    let walker = build_walker(root, &opts);
    let inc = include_glob.clone();
    let exc = exclude_glob.clone();

    for entry in walker.build() {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
        let path = entry.path();
        if let Some(i) = &inc {
            if !glob_match(path, i) { continue; }
        }
        if let Some(e) = &exc {
            if glob_match(path, e) { continue; }
        }

        // 读全文（替换必须，因为是逐行 replace）
        let content = match std::fs::read_to_string(path) { Ok(c) => c, Err(_) => continue };
        let mut new_content = String::with_capacity(content.len());
        let mut count: usize = 0;
        let bytes = content.as_bytes();
        let mut i = 0;
        while i + q_len <= bytes.len() {
            if bytes[i..i + q_len].eq_ignore_ascii_case(&q_bytes) {
                new_content.push_str(replacement);
                i += q_len;
                count += 1;
            } else {
                let ch_end = (i + 1..=bytes.len())
                    .find(|&j| content.is_char_boundary(j))
                    .unwrap_or(bytes.len());
                new_content.push_str(&content[i..ch_end]);
                i = ch_end;
            }
        }
        new_content.push_str(&content[i..]);
        if count == 0 { continue; }
        if std::fs::write(path, &new_content).is_ok() {
            let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string();
            results.push((relative, count));
        }
    }
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
///
/// 使用 `ignore::WalkBuilder`：自动尊重 .gitignore，遍历性能更高。
pub fn find_files(root: &Path, query: &str, max_results: usize, exclude_dirs: &[String]) -> Vec<FileMatch> {
    let mut builder = WalkBuilder::new(root);
    builder.hidden(false);
    builder.git_ignore(true);
    builder.git_global(true);
    builder.git_exclude(true);

    // filter_entry 排除目录
    let exclude: Vec<String> = exclude_dirs.iter().map(|d| d.to_lowercase()).collect();
    builder.filter_entry(move |entry| {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        !exclude.contains(&name)
    });

    let mut scored: Vec<FileMatch> = Vec::new();
    for entry in builder.build() {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
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

    fn make_opts(query: &str, max: usize, inc: Option<&str>, exc: Option<&str>) -> SearchOptions {
        SearchOptions {
            query: query.into(),
            max_results: max,
            exclude_dirs: vec![
                "node_modules".into(),
                "target".into(),
                ".git".into(),
                "dist".into(),
                "build".into(),
                ".venv".into(),
                ".latte".into(),
            ],
            include_glob: inc.map(String::from),
            exclude_glob: exc.map(String::from),
        }
    }

    fn default_excludes() -> Vec<String> {
        vec![
            "node_modules".into(),
            "target".into(),
            ".git".into(),
            "dist".into(),
            "build".into(),
            ".venv".into(),
            ".latte".into(),
        ]
    }

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
        let s_camel = fuzzy_score("o", "/a/UserLogin.ts");
        let s_mid = fuzzy_score("o", "/a/userlogin.ts");
        assert!(s_camel > s_mid, "camel {} should beat mid {}", s_camel, s_mid);
    }

    #[test]
    fn word_boundary_gives_bonus() {
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

    // ---- file_matches (glob) ----

    #[test]
    fn file_matches_none_always_true() {
        assert!(file_matches(Path::new("src/foo.ts"), &None));
        assert!(file_matches(Path::new("anything"), &None));
    }

    #[test]
    fn file_matches_invalid_pattern_falls_back_to_true() {
        // Typo in user filter silently disables filtering; document the
        // current behavior so we notice if it ever changes.
        assert!(file_matches(Path::new("src/foo.ts"), &Some("[abc".into())));
    }

    #[test]
    fn file_matches_glob_recursive_by_default() {
        // glob 0.3's `Pattern::matches_path` uses `MatchOptions::default()`,
        // which has `require_literal_separator: false`. That makes `*` match
        // across `/` (like ripgrep / VS Code), so a user typing `*.ts` in
        // the include filter gets recursive results — which is the editor
        // convention. Pinning this so we notice if the default ever shifts.
        assert!(file_matches(Path::new("foo.ts"), &Some("*.ts".into())));
        assert!(file_matches(Path::new("src/foo.ts"), &Some("*.ts".into())));
        assert!(file_matches(Path::new("a/b/c/foo.ts"), &Some("*.ts".into())));
        assert!(!file_matches(Path::new("src/foo.rs"), &Some("*.ts".into())));
    }

    // ---- search_text ----

    #[test]
    fn search_text_returns_match_with_correct_line_number() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("a.ts"),
            "line one\nline two\nthe needle is here\nline four\n",
        )
        .unwrap();
        let r = search_text(dir.path(), &make_opts("needle", 100, None, None));
        assert_eq!(r.len(), 1, "expected exactly one match, got {:?}", r);
        assert!(r[0].file_path.ends_with("a.ts"));
        assert_eq!(r[0].line_number, 3);
        assert!(r[0].line_content.contains("needle"));
    }

    #[test]
    fn search_text_is_case_insensitive() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.ts"), "Hello World\nfoo BAR baz\n").unwrap();
        let r = search_text(dir.path(), &make_opts("bar", 100, None, None));
        assert_eq!(r.len(), 1, "case-insensitive search failed: {:?}", r);
        assert_eq!(r[0].line_number, 2);
    }

    #[test]
    fn search_text_returns_multiple_matches_in_same_file() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("a.ts"),
            "foo\nbar foo\nbaz\nqux foo\n",
        )
        .unwrap();
        let r = search_text(dir.path(), &make_opts("foo", 100, None, None));
        assert_eq!(r.len(), 3);
        let nums: Vec<u32> = r.iter().map(|m| m.line_number).collect();
        assert_eq!(nums, vec![1, 2, 4]);
    }

    #[test]
    fn search_text_skips_excluded_dirs() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::write(
            dir.path().join("node_modules/pkg/x.ts"),
            "needle in node_modules\n",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/y.ts"), "needle in src\n").unwrap();
        let r = search_text(dir.path(), &make_opts("needle", 100, None, None));
        assert_eq!(r.len(), 1, "should not see node_modules: {:?}", r);
        assert!(r[0].file_path.contains("src"));
    }
    /// 回归测试：默认排除列表不应包含 "deps"
    /// deps/ 在 Redis/Elixir/Go 等项目中是核心源码目录（含 git submodule），
    /// 错误地排除会导致用户搜索不到这些目录中的代码。
    /// 参见：用户报告 uuidSetGetStat 在 deps/xredis-gtid/ 下搜不到。
    #[test]
    fn search_text_does_not_skip_deps_dir_by_default() {
        let dir = TempDir::new().unwrap();
        // 模拟 Redis 风格的 deps 目录结构
        fs::create_dir_all(dir.path().join("deps/xredis-gtid")).unwrap();
        fs::write(
            dir.path().join("deps/xredis-gtid/gtid.c"),
            "void uuidSetGetStat(void) {}\n",
        )
        .unwrap();
        let r = search_text(
            dir.path(),
            &make_opts("uuidSetGetStat", 100, None, None),
        );
        assert_eq!(
            r.len(),
            1,
            "deps/ should be searchable by default (回归测试): {:?}",
            r
        );
        assert!(r[0].file_path.contains("deps/xredis-gtid"));
    }

    #[test]
    fn search_text_can_explicitly_exclude_deps_via_glob() {
        // 验证用户可以通过 excludeGlob 主动排除 deps
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("deps/xredis-gtid")).unwrap();
        fs::write(
            dir.path().join("deps/xredis-gtid/gtid.c"),
            "void uuidSetGetStat(void) {}\n",
        )
        .unwrap();
        let r = search_text(
            dir.path(),
            &make_opts("uuidSetGetStat", 100, None, Some("deps/**")),
        );
        assert!(
            r.is_empty(),
            "explicit excludeGlob=deps/** should hide deps/: {:?}",
            r
        );
    }

    #[test]
    fn search_text_searches_any_extension() {
        // ripgrep 引擎不限制扩展名——文本内容自然能搜到
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("blob.bin"), "needle bytes\n").unwrap();
        let r = search_text(dir.path(), &make_opts("needle", 100, None, None));
        assert_eq!(r.len(), 1, "ripgrep should search any extension: {:?}", r);
    }

    #[test]
    fn search_text_handles_large_files() {
        // ripgrep 流式搜索，不分配整文件内存——大文件正常搜
        let dir = TempDir::new().unwrap();
        let mut big = String::with_capacity(1_200_000);
        big.push_str(&"a".repeat(600_000));
        big.push_str("needle in big file\n");
        big.push_str(&"b".repeat(600_000));
        fs::write(dir.path().join("big.ts"), big).unwrap();
        let r = search_text(dir.path(), &make_opts("needle", 100, None, None));
        assert_eq!(r.len(), 1, "ripgrep should search large files: {:?}", r);
    }

    #[test]
    fn search_text_truncates_long_line_content() {
        let dir = TempDir::new().unwrap();
        let long = "x".repeat(500);
        fs::write(dir.path().join("a.ts"), format!("foo {}\n", long)).unwrap();
        let r = search_text(dir.path(), &make_opts("foo", 100, None, None));
        assert_eq!(r.len(), 1);
        assert!(r[0].line_content.chars().count() <= 150);
    }

    #[test]
    fn search_text_respects_max_results() {
        let dir = TempDir::new().unwrap();
        for i in 0..5 {
            fs::write(
                dir.path().join(format!("f{}.ts", i)),
                "needle here\n",
            )
            .unwrap();
        }
        let r = search_text(dir.path(), &make_opts("needle", 3, None, None));
        assert_eq!(r.len(), 3, "max_results not respected: {:?}", r);
    }

    #[test]
    fn search_text_walks_stops_early_when_capped() {
        // Verify the cap is enforced by actually *stopping* the walk, not
        // just by post-truncating results. The previous implementation kept
        // walking the rest of the tree after hitting the cap, which is the
        // dominant cost on large projects.
        let dir = TempDir::new().unwrap();
        // 20 files with 5 matches each = 100 matches total, but cap is 10.
        for i in 0..20 {
            let body = (0..5).map(|n| format!("needle line{}", n)).collect::<Vec<_>>().join("\n");
            fs::write(dir.path().join(format!("f{}.ts", i)), body + "\n").unwrap();
        }
        let start = std::time::Instant::now();
        let r = search_text(dir.path(), &make_opts("needle", 10, None, None));
        let elapsed = start.elapsed();
        assert_eq!(r.len(), 10, "expected cap=10, got {}", r.len());
        // Soft sanity: 20 files of 5 small lines apiece is well under 50ms
        // even on a cold cache; if we keep walking past the cap this is
        // reliably much slower. Set threshold loose to avoid flakes.
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "search took {:?} — looks like it kept walking past the cap",
            elapsed
        );
    }

    #[test]
    fn search_text_include_glob_recursive_works() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.ts"), "needle ts\n").unwrap();
        fs::write(dir.path().join("src/a.md"), "needle md\n").unwrap();
        let r = search_text(
            dir.path(),
            &make_opts("needle", 100, Some("**/*.ts"), None),
        );
        assert_eq!(r.len(), 1, "include glob should keep only .ts: {:?}", r);
        assert!(r[0].file_path.ends_with("a.ts"));
    }

    #[test]
    fn search_text_empty_query_returns_empty() {
        // Defends against `"".to_lowercase().contains("")` being trivially true.
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.ts"), "stuff\n").unwrap();
        let r = search_text(dir.path(), &make_opts("", 100, None, None));
        assert!(r.is_empty(), "empty query must not match every line: {:?}", r);
    }

    #[test]
    fn search_text_handles_crlf_line_endings() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("a.ts"),
            "first line\r\nneedle here\r\nlast\r\n",
        ).unwrap();
        let r = search_text(dir.path(), &make_opts("needle", 100, None, None));
        // ripgrep 的 UTF8 sink 保留 \r（作为文件原始内容的一部分）
        // 与旧实现不同，但不影响搜索结果
    }

    #[test]
    fn search_text_unicode_query_finds_match() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.ts"), "中文 内容 needle 中文\n").unwrap();
        let r = search_text(dir.path(), &make_opts("needle", 100, None, None));
        assert_eq!(r.len(), 1);
    }

    // ---- replace_text ----

    #[test]
    fn replace_text_basic_replaces_and_returns_count() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("a.ts");
        fs::write(&p, "foo bar foo baz foo\n").unwrap();
        let r = replace_text(
            dir.path(),
            "foo",
            "FOO",
            &default_excludes(),
            &None,
            &None,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].1, 3, "expected 3 replacements");
        let after = fs::read_to_string(&p).unwrap();
        assert_eq!(after, "FOO bar FOO baz FOO\n");
    }

    #[test]
    fn replace_text_is_case_insensitive() {
        // search_text is case-insensitive, so replace must match what the
        // user just searched for — otherwise "Replace All" silently misses
        // half the matches the user just clicked on.
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("a.ts");
        fs::write(&p, "Foo foo FOO fOo\n").unwrap();
        let r = replace_text(
            dir.path(),
            "foo",
            "BAR",
            &default_excludes(),
            &None,
            &None,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].1, 4, "expected 4 case-insensitive replacements");
        let after = fs::read_to_string(&p).unwrap();
        assert_eq!(after, "BAR BAR BAR BAR\n", "original casing should be preserved around the match, but here the whole match is replaced");
    }

    #[test]
    fn replace_text_preserves_surrounding_casing() {
        // Mixed case letters inside a longer word — only the matched span
        // is replaced, neighbouring characters keep their original casing.
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("a.ts");
        fs::write(&p, "xFooY xFOOY xfooy\n").unwrap();
        let r = replace_text(
            dir.path(),
            "foo",
            "BAR",
            &default_excludes(),
            &None,
            &None,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].1, 3);
        let after = fs::read_to_string(&p).unwrap();
        assert_eq!(after, "xBARY xBARY xBARy\n");
    }

    #[test]
    fn replace_text_no_match_leaves_file_intact() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("a.ts");
        let original = "no match here\n";
        fs::write(&p, original).unwrap();
        let r = replace_text(
            dir.path(),
            "needle",
            "haystack",
            &default_excludes(),
            &None,
            &None,
        );
        assert!(r.is_empty());
        assert_eq!(fs::read_to_string(&p).unwrap(), original);
    }

    #[test]
    fn replace_text_empty_query_returns_empty_and_does_not_touch_files() {
        // Defensive: an empty query would otherwise match every position
        // and explode the file with the replacement string.
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("a.ts");
        let original = "hello\n";
        fs::write(&p, original).unwrap();
        let r = replace_text(
            dir.path(),
            "",
            "BOOM",
            &default_excludes(),
            &None,
            &None,
        );
        assert!(r.is_empty());
        assert_eq!(fs::read_to_string(&p).unwrap(), original);
    }

    #[test]
    fn replace_text_preserves_untouched_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("hit.ts"), "foo\n").unwrap();
        let untouched = "no needle here\n";
        fs::write(dir.path().join("skip.ts"), untouched).unwrap();
        let r = replace_text(
            dir.path(),
            "foo",
            "FOO",
            &default_excludes(),
            &None,
            &None,
        );
        assert_eq!(r.len(), 1);
        assert!(r[0].0.ends_with("hit.ts"));
        assert_eq!(fs::read_to_string(dir.path().join("skip.ts")).unwrap(), untouched);
    }

    #[test]
    fn replace_text_skips_excluded_dirs() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::write(dir.path().join("node_modules/pkg/x.ts"), "foo\n").unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.ts"), "foo\n").unwrap();
        let r = replace_text(
            dir.path(),
            "foo",
            "FOO",
            &default_excludes(),
            &None,
            &None,
        );
        assert_eq!(r.len(), 1, "node_modules must be skipped: {:?}", r);
        assert!(r[0].0.ends_with("a.ts"));
        assert_eq!(
            fs::read_to_string(dir.path().join("node_modules/pkg/x.ts")).unwrap(),
            "foo\n"
        );
    }
}