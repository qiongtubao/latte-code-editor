use regex::Regex;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Statistics from a graph build
pub struct BuildStats {
    pub files_scanned: usize,
    pub nodes_created: usize,
    pub edges_created: usize,
    pub errors: Vec<String>,
}

/// Language-specific patterns for extracting symbols
struct LangPatterns {
    /// File extensions this language matches
    extensions: Vec<&'static str>,
    /// (regex, kind) pairs for definition extraction
    definitions: Vec<(Regex, &'static str)>,
    /// Regex for import statements
    imports: Vec<Regex>,
    /// How to extract the imported module name from a match
    import_extract: fn(&regex::Captures) -> String,
}

fn build_lang_patterns() -> Vec<LangPatterns> {
    fn r(p: &str) -> Regex { Regex::new(p).unwrap() }

    vec![
        // TypeScript / JavaScript
        LangPatterns {
            extensions: vec!["ts", "tsx", "js", "jsx", "mjs"],
            definitions: vec![
                (r(r"(?:export\s+)?(?:default\s+)?class\s+(\w+)"), "class"),
                (r(r"(?:export\s+)?interface\s+(\w+)"), "interface"),
                (r(r"(?:export\s+)?type\s+(\w+)\s*="), "type_alias"),
                (r(r"(?:export\s+)?enum\s+(\w+)"), "enum"),
                (r(r"(?:export\s+)?function\s+(\w+)\s*\("), "function"),
                (r(r"(?:export\s+)?(?:async\s+)?function\s+(\w+)"), "function"),
                (r(r"(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(?"), "function"),
                (r(r"(?:export\s+)?const\s+(\w+)\s*:"), "constant"),
                (r(r"(?:export\s+)?let\s+(\w+)\s*:"), "variable"),
                (r(r"(\w+)\s*\(\s*(?:this|event|e)\s*[\)\s]*\{"), "method"),
            ],
            imports: vec![
                r(r#"import\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]"#),
                r(r#"import\s+(\w+)\s+from\s+['"]([^'"]+)['"]"#),
                r(r#"require\(['"]([^'"]+)['"]\)"#),
            ],
            import_extract: |c| c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_string()).unwrap_or_default(),
        },
        // Rust
        LangPatterns {
            extensions: vec!["rs"],
            definitions: vec![
                (r(r"fn\s+(\w+)\s*\("), "function"),
                (r(r"pub\s*(?:unsafe\s*)?fn\s+(\w+)\s*\("), "function"),
                (r(r"(?:pub\s+)?struct\s+(\w+)"), "struct"),
                (r(r"(?:pub\s+)?enum\s+(\w+)"), "enum"),
                (r(r"(?:pub\s+)?trait\s+(\w+)"), "trait"),
                (r(r"(?:pub\s+)?(?:abstract\s+)?type\s+(\w+)"), "type_alias"),
                (r(r"(?:pub\s+)?const\s+(\w+)\s*:"), "constant"),
                (r(r"(?:pub\s+)?static\s+(\w+)\s*:"), "constant"),
                (r(r"(?:pub\s+)?(?:async\s+)?fn\s+(\w+)"), "function"),
            ],
            imports: vec![
                r(r"use\s+(?:\{[^}]*\})?(?:::)?([^;]+)"),
                r(r"extern\s+crate\s+(\w+)"),
            ],
            import_extract: |c| {
                c.get(1).map(|m| {
                    m.as_str().split("::").next().unwrap_or("").to_string()
                }).unwrap_or_default()
            },
        },
        // Python
        LangPatterns {
            extensions: vec!["py"],
            definitions: vec![
                (r(r"class\s+(\w+)"), "class"),
                (r(r"(?:async\s+)?def\s+(\w+)\s*\("), "function"),
                (r(r"(\w+)\s*=\s*(?:lambda|\(|\[|\{)"), "variable"),
            ],
            imports: vec![
                r(r"import\s+(\w+)"),
                r(r"from\s+(\w+)\s+import"),
            ],
            import_extract: |c| c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
        },
        LangPatterns {
            extensions: vec!["c", "h", "cpp", "cxx", "cc", "hpp", "hxx"],
            definitions: vec![
                (r(r"(?:class|struct|union)\s+(\w+)"), "class"),
                (r(r"typedef\s+(?:struct|union|enum)\s*(?:\w+\s*)?\{[^}]*\}\s*(\w+)"), "class"),
                (r(r"(?:enum\s+)(?:class\s+)?(\w+)"), "enum"),
                (r(r"(?:virtual\s+)?(?:inline\s+)?(?:static\s+)?(?:const\s+)?[\w:*&]+\s+(\w+)\s*\("), "function"),
                (r(r"#define\s+(\w+)"), "constant"),
                (r(r"(?:typedef|using)\s+[\w:]+\s+(\w+)"), "type_alias"),
            ],
            imports: vec![
                r(r#"#include\s*[<"]([^>"]+)[">]"#),
            ],
            import_extract: |c| c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
        },
    ]
}
pub fn build_graph(project_root: &Path, progress: Arc<AtomicUsize>) -> Result<BuildStats, String> {
    let patterns = build_lang_patterns();
    let graph_dir = project_root.join(".codegraph");
    std::fs::create_dir_all(&graph_dir)
        .map_err(|e| format!("Cannot create .codegraph directory: {}", e))?;

    let db_path = graph_dir.join("codegraph.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Cannot create database: {}", e))?;

    // Create schema matching existing codegraph format
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            qualified_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            language TEXT NOT NULL,
            start_line INTEGER,
            end_line INTEGER,
            start_column INTEGER,
            end_column INTEGER,
            docstring TEXT,
            signature TEXT,
            visibility TEXT,
            is_exported INTEGER DEFAULT 0,
            is_async INTEGER DEFAULT 0,
            is_static INTEGER DEFAULT 0,
            is_abstract INTEGER DEFAULT 0,
            updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            target TEXT NOT NULL,
            kind TEXT NOT NULL,
            metadata TEXT,
            line INTEGER,
            col INTEGER
        );
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            content_hash TEXT,
            language TEXT,
            size INTEGER,
            modified_at INTEGER,
            indexed_at INTEGER,
            node_count INTEGER DEFAULT 0,
            errors TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
        CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
        CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
        ",
    )
    .map_err(|e| format!("Cannot create schema: {}", e))?;

    // Clear existing data for this build
    conn.execute("DELETE FROM nodes", [])
        .map_err(|e| format!("Cannot clear nodes: {}", e))?;
    conn.execute("DELETE FROM edges", [])
        .map_err(|e| format!("Cannot clear edges: {}", e))?;
    conn.execute("DELETE FROM files", [])
        .map_err(|e| format!("Cannot clear files: {}", e))?;

    let mut stats = BuildStats {
        files_scanned: 0,
        nodes_created: 0,
        edges_created: 0,
        errors: vec![],
    };

    // Collect all source files
    let mut source_files: Vec<PathBuf> = Vec::new();
    collect_source_files(project_root, &mut source_files, &patterns);

    // Track file IDs for edge creation
    let mut file_node_ids: HashMap<PathBuf, String> = HashMap::new();

    // Scan each file
    for file_path in &source_files {
        let relative = file_path
            .strip_prefix(project_root)
            .unwrap_or(file_path)
            .to_string_lossy()
            .to_string();
        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // Find matching language patterns
        let lang_patterns = patterns.iter().find(|lp| lp.extensions.contains(&ext.as_str()));
        let language = match ext.as_str() {
            "ts" | "tsx" => "typescript",
            "js" | "jsx" | "mjs" => "javascript",
            "rs" => "rust",
            "py" => "python",
            "c" | "h" => "c",
            "cpp" | "cxx" | "cc" | "hpp" | "hxx" => "cpp",
            _ => "unknown",
        };

        // Read file content
        let content = match std::fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        stats.files_scanned += 1;
        progress.store(stats.files_scanned, Ordering::Relaxed);

        // Create a file node
        let file_node_id = format!("file:{}", relative);
        file_node_ids.insert(file_path.clone(), file_node_id.clone());

        conn.execute(
            "INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line)
             VALUES (?1, 'file', ?2, ?2, ?3, ?4, 0, 0)",
            params![file_node_id, &relative, &relative, language],
        )
        .map_err(|e| format!("Cannot insert file node: {}", e))?;
        stats.nodes_created += 1;

        // Extract definitions if we have patterns for this language
        if let Some(lp) = lang_patterns {
            let mut node_ids: Vec<(String, &str, u32)> = Vec::new(); // (id, kind, line)

            for (re, kind) in &lp.definitions {
                for cap in re.captures_iter(&content) {
                    let name = cap.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let line = content[..cap.get(0).unwrap().start()]
                        .lines()
                        .count() as u32
                        + 1;

                    let node_id = format!("{}:{}", kind, name);
                    let qualified = format!("{}::{}", relative.replace('/', "::").replace(".", ""), name);

                    conn.execute(
                        "INSERT OR IGNORE INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                        params![node_id.clone(), kind, name, qualified, &relative, language, line],
                    )
                    .map_err(|e| format!("Cannot insert node: {}", e))?;
                    stats.nodes_created += 1;
                    node_ids.push((node_id.clone(), kind, line));

                    // contains edge: file → definition
                    conn.execute(
                        "INSERT INTO edges (source, target, kind) VALUES (?1, ?2, 'contains')",
                        params![file_node_id, node_id],
                    )
                    .map_err(|e| format!("Cannot insert contains edge: {}", e))?;
                    stats.edges_created += 1;
                }
            }

            // Extract imports
            for import_re in &lp.imports {
                for cap in import_re.captures_iter(&content) {
                    let import_name = (lp.import_extract)(&cap);
                    if import_name.is_empty() {
                        continue;
                    }
                    let line = content[..cap.get(0).unwrap().start()]
                        .lines()
                        .count() as u32
                        + 1;

                    let import_id = format!("import:{}", import_name);
                    conn.execute(
                        "INSERT OR IGNORE INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line)
                         VALUES (?1, 'import', ?2, ?2, ?3, ?4, ?5, ?5)",
                        params![import_id, &import_name, &relative, language, line],
                    )
                    .ok();
                    stats.nodes_created += 1;

                    // imports edge
                    conn.execute(
                        "INSERT INTO edges (source, target, kind, line) VALUES (?1, ?2, 'imports', ?3)",
                        params![file_node_id, import_id, line],
                    )
                    .ok();
                    stats.edges_created += 1;
                }
            }
        }

        // Update progress every 10 files
        if stats.files_scanned % 10 == 0 {
            progress.store(stats.files_scanned, Ordering::Relaxed);
        }
    }

    // Final progress
    progress.store(stats.files_scanned, Ordering::Relaxed);

    // VACUUM to reclaim space
    conn.execute_batch("VACUUM;").ok();

    Ok(stats)
}

/// Recursively collect source files, skipping hidden dirs and node_modules/target
fn collect_source_files(dir: &Path, files: &mut Vec<PathBuf>, patterns: &[LangPatterns]) {
    let skip_dirs: [&str; 6] = [
        ".git", ".codegraph", ".editor", "node_modules", "target", "dist",
    ];

    let Ok(entries) = std::fs::read_dir(dir) else { return };

    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();

        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if !skip_dirs.contains(&name) && !name.starts_with('.') {
                    collect_source_files(&path, files, patterns);
                }
            }
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext = ext.to_lowercase();
                if patterns.iter().any(|lp| lp.extensions.contains(&ext.as_str())) {
                    files.push(path);
                }
            }
        }
    }
}
