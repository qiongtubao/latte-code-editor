//! 语言检测和 LSP 服务器配置
//!
//! 根据文件扩展名自动识别语言，并配置对应的 LSP 服务器

use std::path::Path;

/// 支持的语言类型
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Language {
    TypeScript,
    JavaScript,
    Rust,
    Python,
    Go,
    C,
    Cpp,
    Json,
    Markdown,
    /// TCL 脚本语言（Tcl/Tk）。
    /// 当前未配置社区级稳定 LSP（`tclserv`、`naga` 等均不通用），故仅做语法识别而不启动 LSP。
    Tcl,
    Unknown,
}

/// LSP 服务器配置
#[derive(Debug, Clone)]
pub struct LspConfig {
    /// 语言类型
    pub language: Language,
    /// LSP 服务器命令（例如 ["typescript-language-server", "--stdio"]）
    pub command: Vec<String>,
    /// 初始化选项（可选）
    pub initialization_options: Option<serde_json::Value>,
    /// 是否支持休眠（某些 LSP 不支持内存压缩）
    pub supports_hibernation: bool,
}

/// 根据文件路径检测语言
pub fn detect_language(path: &Path) -> Language {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");

    match ext {
        "ts" | "tsx" => Language::TypeScript,
        "js" | "jsx" | "mjs" | "cjs" => Language::JavaScript,
        "rs" => Language::Rust,
        "py" | "pyi" => Language::Python,
        "go" => Language::Go,
        "c" => Language::C,
        "cpp" | "cc" | "cxx" | "h" | "hpp" => Language::Cpp,
        "json" | "jsonc" => Language::Json,
        "md" | "mdx" => Language::Markdown,
        "tcl" => Language::Tcl,
        _ => Language::Unknown,
    }
}

/// 获取语言对应的 LSP 配置
pub fn get_lsp_config(language: &Language) -> Option<LspConfig> {
    match language {
        Language::TypeScript | Language::JavaScript => Some(LspConfig {
            language: language.clone(),
            command: vec!["typescript-language-server".to_string(), "--stdio".to_string()],
            initialization_options: None,
            supports_hibernation: true,
        }),
        Language::Rust => Some(LspConfig {
            language: language.clone(),
            command: vec!["rust-analyzer".to_string()],
            initialization_options: None,
            supports_hibernation: true,
        }),
        Language::Python => Some(LspConfig {
            language: language.clone(),
            command: vec!["pylsp".to_string()],
            initialization_options: None,
            supports_hibernation: true,
        }),
        Language::Go => Some(LspConfig {
            language: language.clone(),
            command: vec!["gopls".to_string()],
            initialization_options: None,
            supports_hibernation: true,
        }),
        Language::C | Language::Cpp => Some(LspConfig {
            language: language.clone(),
            command: vec!["clangd".to_string()],
            initialization_options: None,
            supports_hibernation: true,
        }),
        // JSON/Markdown/TCL 目前没有接入 LSP；保留识别但不出 LSP 进程
        Language::Json | Language::Markdown | Language::Tcl | Language::Unknown => None,
    }
}

/// 获取语言的显示名称
pub fn language_display_name(language: &Language) -> &'static str {
    match language {
        Language::TypeScript => "TypeScript",
        Language::JavaScript => "JavaScript",
        Language::Rust => "Rust",
        Language::Python => "Python",
        Language::Go => "Go",
        Language::C => "C",
        Language::Cpp => "C++",
        Language::Json => "JSON",
        Language::Markdown => "Markdown",
        Language::Tcl => "TCL",
        Language::Unknown => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_language() {
        assert_eq!(detect_language(Path::new("test.ts")), Language::TypeScript);
        assert_eq!(detect_language(Path::new("test.js")), Language::JavaScript);
        assert_eq!(detect_language(Path::new("test.rs")), Language::Rust);
        assert_eq!(detect_language(Path::new("test.py")), Language::Python);
        assert_eq!(detect_language(Path::new("test.unknown")), Language::Unknown);
        assert_eq!(detect_language(Path::new("script.tcl")), Language::Tcl);
    }

    #[test]
    fn test_get_lsp_config() {
        let ts_config = get_lsp_config(&Language::TypeScript);
        assert!(ts_config.is_some());
        let config = ts_config.unwrap();
        assert_eq!(config.command[0], "typescript-language-server");

        let rust_config = get_lsp_config(&Language::Rust);
        assert!(rust_config.is_some());
        let config = rust_config.unwrap();
        assert_eq!(config.command[0], "rust-analyzer");
    }

    /// 验证 tcl 显示名与无 LSP 配置
    #[test]
    fn test_tcl_language_metadata() {
        assert_eq!(language_display_name(&Language::Tcl), "TCL");
        assert!(get_lsp_config(&Language::Tcl).is_none());
    }
}
