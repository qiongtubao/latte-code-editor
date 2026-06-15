//! Global configuration for latte-code-editor chat panel.
//!
//! Loads from:
//! 1. `~/.latte/models.yaml` - global model definitions (shared across latte projects)
//! 2. `~/.latte-code-editor/roles.yaml` - role definitions and model assignments
//!
//! Environment variables:
//! - `LATTE_MODELS_PATH` - override models.yaml path
//! - `LATTE_ROLES_PATH` - override roles.yaml path

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Global model configuration from ~/.latte/models.yaml
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GlobalModelConfig {
    /// API keys (can reference env vars like ${ANTHROPIC_API_KEY})
    #[serde(default)]
    pub api_keys: HashMap<String, String>,
    
    /// Model definitions
    pub models: HashMap<String, ModelDef>,
    
    /// Default model ID
    #[serde(default = "default_model")]
    pub default_model: String,
    
    /// Tier presets
    #[serde(default)]
    pub tiers: HashMap<String, String>,
}

fn default_model() -> String {
    "deepseek-chat".into()
}

/// Single model definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDef {
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_base: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_context_window")]
    pub context_window: u32,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_thinking: bool,
    #[serde(default)]
    pub cost_input: f64,
    #[serde(default)]
    pub cost_output: f64,
}

fn default_max_tokens() -> u32 { 8192 }
fn default_context_window() -> u32 { 32768 }

/// Role configuration from ~/.latte-code-editor/roles.yaml
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RoleConfig {
    /// Default model for roles not specified
    #[serde(default = "default_model")]
    pub default_model: String,
    
    /// Role definitions
    pub roles: HashMap<String, RoleDef>,
    
    /// Workflow presets
    #[serde(default)]
    pub workflows: HashMap<String, WorkflowDef>,
}

/// Single role definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleDef {
    pub name: String,
    pub icon: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    pub prompt: String,
}

fn default_temperature() -> f64 { 0.5 }

/// Workflow preset
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDef {
    pub name: String,
    pub roles: Vec<String>,
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
}

fn default_max_rounds() -> usize { 1 }

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

/// Get the global models config path (~/.latte/models.yaml)
pub fn global_models_path() -> PathBuf {
    if let Ok(p) = env::var("LATTE_MODELS_PATH") {
        return PathBuf::from(p);
    }
    
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".latte").join("models.yaml")
}

/// Get the roles config path (~/.latte-code-editor/roles.yaml)
pub fn roles_config_path() -> PathBuf {
    if let Ok(p) = env::var("LATTE_ROLES_PATH") {
        return PathBuf::from(p);
    }
    
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".latte-code-editor").join("roles.yaml")
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/// Load global models config, creating default if not exists
pub fn load_global_models() -> GlobalModelConfig {
    let path = global_models_path();
    
    if !path.exists() {
        // Create default config
        let config = create_default_global_models();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, serde_yaml::to_string(&config).unwrap_or_default());
        eprintln!("[chat] Created default models config at {:?}", path);
        return config;
    }
    
    match fs::read_to_string(&path) {
        Ok(content) => {
            match serde_yaml::from_str(&content) {
                Ok(config) => config,
                Err(e) => {
                    eprintln!("[chat] Failed to parse {:?}: {}. Using defaults.", path, e);
                    create_default_global_models()
                }
            }
        }
        Err(e) => {
            eprintln!("[chat] Failed to read {:?}: {}. Using defaults.", path, e);
            create_default_global_models()
        }
    }
}

/// Load roles config, creating default if not exists
pub fn load_roles_config() -> RoleConfig {
    let path = roles_config_path();
    
    if !path.exists() {
        // Create default config
        let config = create_default_roles_config();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, serde_yaml::to_string(&config).unwrap_or_default());
        eprintln!("[chat] Created default roles config at {:?}", path);
        return config;
    }
    
    match fs::read_to_string(&path) {
        Ok(content) => {
            match serde_yaml::from_str(&content) {
                Ok(config) => config,
                Err(e) => {
                    eprintln!("[chat] Failed to parse {:?}: {}. Using defaults.", path, e);
                    create_default_roles_config()
                }
            }
        }
        Err(e) => {
            eprintln!("[chat] Failed to read {:?}: {}. Using defaults.", path, e);
            create_default_roles_config()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

fn create_default_global_models() -> GlobalModelConfig {
    let mut models = HashMap::new();
    
    models.insert("deepseek-chat".into(), ModelDef {
        name: "DeepSeek Chat V3".into(),
        provider: "openai".into(),
        model: "deepseek-chat".into(),
        api_base: Some("https://api.deepseek.com".into()),
        max_tokens: 8192,
        context_window: 65536,
        supports_vision: false,
        supports_thinking: false,
        cost_input: 0.27,
        cost_output: 1.10,
    });
    
    models.insert("claude-sonnet-4".into(), ModelDef {
        name: "Claude Sonnet 4".into(),
        provider: "anthropic".into(),
        model: "claude-sonnet-4-20250514".into(),
        api_base: None,
        max_tokens: 8192,
        context_window: 200000,
        supports_vision: true,
        supports_thinking: true,
        cost_input: 3.0,
        cost_output: 15.0,
    });
    
    models.insert("gpt-4o".into(), ModelDef {
        name: "GPT-4o".into(),
        provider: "openai".into(),
        model: "gpt-4o".into(),
        api_base: None,
        max_tokens: 16384,
        context_window: 128000,
        supports_vision: true,
        supports_thinking: false,
        cost_input: 2.50,
        cost_output: 10.0,
    });
    
    let mut tiers = HashMap::new();
    tiers.insert("premium".into(), "claude-sonnet-4".into());
    tiers.insert("standard".into(), "claude-sonnet-4".into());
    tiers.insert("budget".into(), "deepseek-chat".into());
    
    let mut api_keys = HashMap::new();
    api_keys.insert("anthropic".into(), "${ANTHROPIC_API_KEY}".into());
    api_keys.insert("openai".into(), "${OPENAI_API_KEY}".into());
    api_keys.insert("deepseek".into(), "${DEEPSEEK_API_KEY}".into());
    
    GlobalModelConfig {
        api_keys,
        models,
        default_model: "deepseek-chat".into(),
        tiers,
    }
}

fn create_default_roles_config() -> RoleConfig {
    let mut roles = HashMap::new();
    
    roles.insert("pm".into(), RoleDef {
        name: "Product Manager".into(),
        icon: "📋".into(),
        category: "planning".into(),
        model: Some("claude-sonnet-4".into()),
        temperature: 0.7,
        prompt: "You are a Product Manager. Analyze requirements, define user stories, and prioritize features. Be concise and thorough.".into(),
    });
    
    roles.insert("architect".into(), RoleDef {
        name: "System Architect".into(),
        icon: "🏗️".into(),
        category: "planning".into(),
        model: Some("claude-sonnet-4".into()),
        temperature: 0.5,
        prompt: "You are a System Architect. Design system architecture, evaluate tradeoffs, and identify risks. Provide concrete recommendations.".into(),
    });
    
    roles.insert("programmer".into(), RoleDef {
        name: "Software Engineer".into(),
        icon: "💻".into(),
        category: "execution".into(),
        model: Some("deepseek-chat".into()),
        temperature: 0.3,
        prompt: r#"You are a Software Engineer. Implement features and fixes. Use <file_edit path="..."> tags for file changes.

Example:
<file_edit path="src/lib/example.ts">
Add new function
</file_edit>"#.into(),
    });
    
    roles.insert("tester".into(), RoleDef {
        name: "QA Engineer".into(),
        icon: "🧪".into(),
        category: "verification".into(),
        model: Some("deepseek-chat".into()),
        temperature: 0.4,
        prompt: "You are a QA Engineer. Design test strategies, identify edge cases, and ensure quality coverage.".into(),
    });
    
    roles.insert("reviewer".into(), RoleDef {
        name: "Code Reviewer".into(),
        icon: "🔍".into(),
        category: "verification".into(),
        model: Some("claude-sonnet-4".into()),
        temperature: 0.4,
        prompt: "You are a Code Reviewer. Review code quality, identify patterns, and suggest improvements. Be constructive.".into(),
    });
    
    roles.insert("devops".into(), RoleDef {
        name: "DevOps Engineer".into(),
        icon: "🚀".into(),
        category: "execution".into(),
        model: Some("deepseek-chat".into()),
        temperature: 0.3,
        prompt: "You are a DevOps Engineer. Design CI/CD pipelines, plan infrastructure, and optimize deployments.".into(),
    });
    
    roles.insert("security".into(), RoleDef {
        name: "Security Auditor".into(),
        icon: "🛡️".into(),
        category: "verification".into(),
        model: Some("claude-sonnet-4".into()),
        temperature: 0.4,
        prompt: "You are a Security Auditor. Identify vulnerabilities, review auth/authz, and assess data protection.".into(),
    });
    
    roles.insert("designer".into(), RoleDef {
        name: "UI/UX Designer".into(),
        icon: "🎨".into(),
        category: "planning".into(),
        model: Some("claude-sonnet-4".into()),
        temperature: 0.7,
        prompt: "You are a UI/UX Designer. Design user experiences, create wireframes, and ensure accessibility.".into(),
    });
    
    roles.insert("tech_writer".into(), RoleDef {
        name: "Technical Writer".into(),
        icon: "📝".into(),
        category: "execution".into(),
        model: Some("deepseek-chat".into()),
        temperature: 0.5,
        prompt: "You are a Technical Writer. Write clear documentation, API docs, and user guides.".into(),
    });
    
    roles.insert("manager".into(), RoleDef {
        name: "Engineering Manager".into(),
        icon: "👔".into(),
        category: "planning".into(),
        model: Some("claude-sonnet-4".into()),
        temperature: 0.5,
        prompt: "You are an Engineering Manager. Plan projects, allocate resources, and make decisions based on team input.".into(),
    });
    
    let mut workflows = HashMap::new();
    
    workflows.insert("plan".into(), WorkflowDef {
        name: "🗺️ Plan — design and architect".into(),
        roles: vec!["pm".into(), "architect".into(), "programmer".into(), "designer".into(), "manager".into()],
        max_rounds: 2,
    });
    
    workflows.insert("code".into(), WorkflowDef {
        name: "💻 Code — review and refactor".into(),
        roles: vec!["programmer".into(), "reviewer".into(), "security".into(), "tester".into()],
        max_rounds: 1,
    });
    
    workflows.insert("debug".into(), WorkflowDef {
        name: "🪲 Debug — triage and fix".into(),
        roles: vec!["tester".into(), "programmer".into(), "security".into(), "devops".into(), "manager".into()],
        max_rounds: 2,
    });
    
    workflows.insert("discuss".into(), WorkflowDef {
        name: "💬 Discuss — full team".into(),
        roles: vec!["pm".into(), "architect".into(), "programmer".into(), "tester".into(), "reviewer".into(), "devops".into(), "manager".into()],
        max_rounds: 3,
    });
    
    RoleConfig {
        default_model: "deepseek-chat".into(),
        roles,
        workflows,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Env Var Expansion
// ─────────────────────────────────────────────────────────────────────────────

/// Expand environment variables in a string.
/// Supports ${VAR} syntax.
pub fn expand_env_vars(s: &str) -> String {
    let mut result = s.to_string();
    
    // Find all ${VAR} patterns
    let re = regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}").unwrap();
    
    for cap in re.captures_iter(s) {
        let full = cap.get(0).unwrap().as_str();
        let var_name = cap.get(1).unwrap().as_str();
        
        if let Ok(value) = env::var(var_name) {
            result = result.replace(full, &value);
        }
    }
    
    result
}

/// Get API key for a provider, expanding env vars
pub fn get_api_key(global_config: &GlobalModelConfig, provider: &str) -> Option<String> {
    global_config
        .api_keys
        .get(provider)
        .map(|k| expand_env_vars(k))
        .filter(|k| !k.starts_with("${")) // Return None if not expanded
}
