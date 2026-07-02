//! Configuration loader for latte-code-editor chat panel.
//!
//! Mirrors `latte-agent-cli/src/commands/config_layer.rs` — loads models
//! and roles through the three-layer merge:
//!   1. Global (`~/.latte/models.yaml` + `~/.latte/models.d/*`)
//!   2. Project (`<cwd>/.latte/agents.d/*.toml` + `<cwd>/.latte/models.d/*.toml`)
//!   3. Built-in fallback (`latte_agent_core::prompts::template_for`)
//!
//! The editor has NO built-in config of its own — everything comes through
//! `latte_agent_core`.

use std::collections::HashMap;
use std::path::PathBuf;

use latte_agent_core::config::{AgentConfig, ConfigLayer, ModelCatalog};
use latte_agent_core::global_config::GlobalConfig;
use latte_agent_core::role::RoleTemplate;

/// The merged view the chat panel reads from.
/// Equivalent to what `config_layer::load` returns in `latte-agent-cli`.
pub struct MergedConfig {
    /// Full model catalog (globally merged + project model defs).
    pub models: ModelCatalog,
    /// Role templates from all layers.
    pub roles: HashMap<String, RoleTemplate>,
    /// Default model id.
    pub default_model: String,
}

/// Load the merged config from all layers. Writes nothing to disk.
pub fn load_merged() -> MergedConfig {
    // ── Layer 3: Global config (~/.latte/models.* + ~/.latte/models.d/*) ──
    let global = GlobalConfig::load_default().unwrap_or_default();
    let global_pending_ids: Vec<String> = global.models.iter().map(|m| m.id.clone()).collect();

    let agents_dir = ConfigLayer::Project.agents_dir();

    // ── Layer 2: Project config (agents + models) ──
    let mut project = if let Some(dir) = agents_dir {
        AgentConfig::load_with_global(Some(dir.to_str().unwrap_or("")))
            .unwrap_or_else(|_| AgentConfig::default())
    } else {
        AgentConfig::default()
    };

    // Append global-only model ids into every role's model_chain
    // (mirrors what config_layer.rs does: inject_extra_global_ids).
    for tmpl in project.roles.values_mut() {
        for id in &global_pending_ids {
            if !tmpl.model_chain.contains(id) {
                tmpl.model_chain.push(id.clone());
            }
        }
    }

    // ── Merge global models into project (field-fill semantics) ──
    let merged = global.merge_into_project(&project);

    // ── Fallback: built-in role templates when no config exists ──
    let roles = if merged.roles.is_empty() {
        builtin_role_templates()
    } else {
        merged.roles
    };

    // ── Resolve default model id ──
    let default_model = merged
        .models
        .tiers
        .as_ref()
        .and_then(|t| t.get("standard"))
        .or_else(|| merged.models.models.first().map(|m| &m.id))
        .or_else(|| global.models.first().map(|m| &m.id))
        .cloned()
        .unwrap_or_else(|| "deepseek-chat".to_string());

    MergedConfig {
        models: merged.models,
        roles,
        default_model,
    }
}

/// Built-in fallback: use `latte_agent_core::prompts::template_for`.
fn builtin_role_templates() -> HashMap<String, RoleTemplate> {
    let mut roles = HashMap::new();
    let ids = [
        "pm", "architect", "programmer", "tester", "reviewer",
        "devops", "security", "designer", "tech_writer", "manager",
    ];
    for id in &ids {
        if let Some(tmpl) = latte_agent_core::prompts::template_for(id) {
            roles.insert(tmpl.id.clone(), tmpl);
        }
    }
    roles
}

/// Project agents directory (`./.latte/agents.d/`)
pub fn project_agents_dir() -> Option<PathBuf> {
    ConfigLayer::Project.agents_dir()
}

/// Project models file (`./.latte/models.toml`)
pub fn project_models_path() -> Option<PathBuf> {
    let p = PathBuf::from(".latte").join("models.toml");
    if p.exists() { Some(p) } else { None }
}


/// Global models.yaml path
pub fn global_models_path() -> PathBuf {
    GlobalConfig::default_candidates()
        .first()
        .cloned()
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".latte")
                .join("models.yaml")
        })
}

// ─── Write helpers ──────────────────────────────────────────────────

/// Write or update `~/.latte/models.yaml` with a new `tiers.standard`
/// default model. Creates the file from scratch if it doesn't exist.
pub fn write_global_default_model(model_id: &str) -> Result<(), String> {
    let path = global_models_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }

    let mut global = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_yaml::from_str::<GlobalConfig>(&c).ok())
            .unwrap_or_default()
    } else {
        GlobalConfig::default()
    };

    // Set tiers.standard = model_id
    let mut tiers = global.tiers.take().unwrap_or_default();
    tiers.insert("standard".to_string(), model_id.to_string());
    global.tiers = Some(tiers);

    // Write
    let yaml = serde_yaml::to_string(&global)
        .map_err(|e| format!("cannot serialize: {e}"))?;
    std::fs::write(&path, &yaml)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(())
}

/// Write a role's model_chain to `<cwd>/.latte/agents.d/<id>.toml`.
/// Creates/updates only the `model_chain` field — other fields are kept.
pub fn write_role_model_chain(role_id: &str, chain: &[String]) -> Result<(), String> {
    let dir = project_agents_dir().ok_or_else(|| {
        "no project agents directory; run from a project with .latte/".to_string()
    })?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let path = dir.join(format!("{role_id}.toml"));

    let chain_line = format!(
        "model_chain = [{}]",
        chain.iter()
            .map(|s| format!("\"{}\"", s))
            .collect::<Vec<_>>()
            .join(", ")
    );

    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;

        let new_content = if content.contains("model_chain") {
            // Replace existing model_chain line
            content
                .lines()
                .map(|line| {
                    if line.trim().starts_with("model_chain") {
                        chain_line.as_str()
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            // Append at the end
            format!("{}{}\n", content.trim_end(), chain_line)
        };

        if new_content != content {
            std::fs::write(&path, &new_content)
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        }
    } else {
        // Create minimal role template with chain
        let content = format!(
            r#"id = "{role_id}"
name = "{role_id}"
model_tier = "standard"
category = "general"
icon = "💬"
{chain_line}
"#,
        );
        std::fs::write(&path, &content)
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Build a `ModelResolver` from the merged config. Returns `None` if
/// the catalog is empty.
pub fn build_resolver(config: &MergedConfig) -> Option<latte_agent_core::model_resolver::ModelResolver> {
    // Reconstruct an AgentConfig from the merged pieces, because
    // ModelResolver::from_config takes an &AgentConfig.
    let agent_cfg = AgentConfig {
        models: config.models.clone(),
        roles: config.roles.clone(),
    };
    latte_agent_core::model_resolver::ModelResolver::from_config(&agent_cfg).ok()
}
