//! Embedded configuration for the chat panel. Reads TOML files from
//! `latte-rs-agents/config/` at compile time so the binary is self-contained.

use std::collections::HashMap;
use std::path::PathBuf;

/// Try multiple candidate paths for the agents config root. This makes
/// the binary work both during dev (running from `src-tauri/`) and after
/// install.
pub fn agents_config_root() -> PathBuf {
    let candidates = [
        // from src-tauri/
        "../latte-rs-agents/config",
        "../../latte-rs-agents/config",
        // from project root
        "../latte-rs-agents/config",
        // absolute fallback
        "/home/dong/Documents/latte/latte-rs-agents/config",
    ];
    for c in &candidates {
        let p = PathBuf::from(c);
        if p.join("agents.toml").exists() {
            return p;
        }
    }
    PathBuf::from(candidates[0])
}

/// Parse a minimal agents.toml: just role id → icon and name. We don't
/// need full TOML parsing for the frontend listing — only metadata.
pub fn load_role_metadata() -> HashMap<String, (String, String, String)> {
    // id -> (name, icon, category)
    let mut out = HashMap::new();
    let path = agents_config_root().join("agents.toml");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return out,
    };

    let mut current_id: Option<String> = None;
    let mut current_name: Option<String> = None;
    let mut current_icon: Option<String> = None;
    let mut current_category: Option<String> = None;
    let mut current_tier: Option<String> = None;

    for line in content.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("[roles.") {
            if let Some(id) = rest.strip_suffix("]") {
                // flush previous
                if let (Some(id), Some(name), Some(icon)) = (
                    current_id.take(),
                    current_name.take(),
                    current_icon.take(),
                ) {
                    out.insert(
                        id,
                        (
                            name,
                            icon,
                            current_category.take().unwrap_or_else(|| "discussion".into()),
                        ),
                    );
                }
                current_id = Some(id.to_string());
            }
        } else if let Some(v) = t.strip_prefix("name = ") {
            current_name = Some(v.trim_matches('"').to_string());
        } else if let Some(v) = t.strip_prefix("icon = ") {
            current_icon = Some(v.trim_matches('"').to_string());
        } else if let Some(v) = t.strip_prefix("category = ") {
            current_category = Some(v.trim_matches('"').to_string());
        } else if let Some(v) = t.strip_prefix("model_tier = ") {
            current_tier = Some(v.trim_matches('"').to_string());
        }
    }
    if let (Some(id), Some(name), Some(icon)) = (current_id, current_name, current_icon) {
        out.insert(
            id,
            (name, icon, current_category.unwrap_or_else(|| "discussion".into())),
        );
    }
    let _ = current_tier; // not used in this minimal parser
    out
}

/// Parse discussion.toml to extract workflow names + step descriptions.
pub fn load_workflow_info() -> Vec<(String, String, Vec<String>)> {
    let path = agents_config_root().join("discussion.toml");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_desc: Option<String> = None;
    let mut current_steps: Vec<String> = Vec::new();
    let mut section = String::new();

    for line in content.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix('[') {
            // flush previous workflow
            if !section.is_empty() {
                if let (Some(n), Some(d)) = (current_name.take(), current_desc.take()) {
                    out.push((section.clone(), n, std::mem::take(&mut current_steps)));
                    let _ = d;
                }
            }
            // start new section
            let inner = rest.trim_end_matches(']').to_string();
            section = inner.clone();
            current_name = None;
            current_desc = None;
        } else if t.starts_with("name = ") {
            current_name = Some(t.trim_start_matches("name = ").trim_matches('"').to_string());
        } else if t.starts_with("description = ") {
            current_desc = Some(
                t.trim_start_matches("description = ")
                    .trim_matches('"')
                    .to_string(),
            );
        } else if t.starts_with("speakers = ") || t.starts_with("id = ") {
            let v = t
                .split('=')
                .nth(1)
                .map(|s| s.trim().trim_matches('"').trim_matches('[').trim_matches(']'))
                .unwrap_or("");
            if !v.is_empty() {
                current_steps.push(v.to_string());
            }
        }
    }
    if let Some(n) = current_name {
        out.push((section, n, current_steps));
    }
    out
}
