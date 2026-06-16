//! Global configuration for latte-code-editor chat panel.
//!
//! Supports ~/.latte/models.yaml in latte-tune array format

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

/// Model definition in latte-tune array format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub api: String,
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    pub api_key: String,
    #[serde(default = "default_context_window")]
    pub context_window: u32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub cost_per_million_input: f64,
    #[serde(default)]
    pub cost_per_million_output: f64,
}

/// Role definition
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

/// Workflow preset
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDef {
    pub name: String,
    pub roles: Vec<String>,
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
}

/// Global models config
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GlobalModelConfig {
    #[serde(default)]
    pub models: Vec<ModelDef>,
    #[serde(default = "default_model")]
    pub default_model: String,
}

/// Roles config
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RoleConfig {
    #[serde(default = "default_model")]
    pub default_model: String,
    #[serde(default)]
    pub roles: HashMap<String, RoleDef>,
    #[serde(default)]
    pub workflows: HashMap<String, WorkflowDef>,
}

fn default_model() -> String { "deepseek-chat".into() }
fn default_max_tokens() -> u32 { 8192 }
fn default_context_window() -> u32 { 32768 }
fn default_temperature() -> f64 { 0.5 }
fn default_max_rounds() -> usize { 1 }

impl GlobalModelConfig {
    pub fn first_model(&self) -> Option<&ModelDef> {
        self.models.first()
    }

    pub fn has_api_key(&self) -> bool {
        self.models.iter().any(|m| {
            let expanded = expand_env_vars(&m.api_key);
            !expanded.starts_with("${") && !expanded.is_empty()
        })
    }

    pub fn get_api_key(&self, provider: &str) -> Option<String> {
        self.models
            .iter()
            .find(|m| m.provider == provider)
            .map(|m| expand_env_vars(&m.api_key))
            .filter(|k| !k.starts_with("${"))
    }
}

/// Get models.yaml path
pub fn global_models_path() -> PathBuf {
    if let Ok(p) = env::var("LATTE_MODELS_PATH") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".latte")
        .join("models.yaml")
}

/// Get roles.yaml path
pub fn roles_config_path() -> PathBuf {
    if let Ok(p) = env::var("LATTE_ROLES_PATH") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".latte-code-editor")
        .join("roles.yaml")
}

/// Load models config
pub fn load_global_models() -> GlobalModelConfig {
    let path = global_models_path();

    if !path.exists() {
        let config = create_default_models();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, serde_yaml::to_string(&config).unwrap_or_default());
        eprintln!("[chat] Created default models config at {:?}", path);
        return config;
    }

    match fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str(&content).unwrap_or_else(|e| {
            eprintln!("[chat] Failed to parse {:?}: {}. Using defaults.", path, e);
            create_default_models()
        }),
        Err(e) => {
            eprintln!("[chat] Failed to read {:?}: {}. Using defaults.", path, e);
            create_default_models()
        }
    }
}

/// Load roles config
pub fn load_roles_config() -> RoleConfig {
    let path = roles_config_path();

    if !path.exists() {
        let config = create_default_roles();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, serde_yaml::to_string(&config).unwrap_or_default());
        eprintln!("[chat] Created default roles config at {:?}", path);
        return config;
    }

    match fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str(&content).unwrap_or_else(|e| {
            eprintln!("[chat] Failed to parse {:?}: {}. Using defaults.", path, e);
            create_default_roles()
        }),
        Err(e) => {
            eprintln!("[chat] Failed to read {:?}: {}. Using defaults.", path, e);
            create_default_roles()
        }
    }
}

/// Expand env vars in ${VAR} format
pub fn expand_env_vars(s: &str) -> String {
    let mut result = s.to_string();
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

fn create_default_models() -> GlobalModelConfig {
    GlobalModelConfig {
        models: vec![
            ModelDef {
                id: "deepseek-chat".into(),
                name: "DeepSeek Chat V3".into(),
                api: "openai".into(),
                provider: "deepseek".into(),
                base_url: "https://api.deepseek.com".into(),
                api_key: "${DEEPSEEK_API_KEY}".into(),
                context_window: 65536,
                max_tokens: 8192,
                reasoning: false,
                cost_per_million_input: 0.27,
                cost_per_million_output: 1.10,
            },
        ],
        default_model: "deepseek-chat".into(),
    }
}

fn create_default_roles() -> RoleConfig {
    let mut roles = HashMap::new();

    roles.insert("programmer".into(), RoleDef {
        name: "Software Engineer".into(),
        icon: "💻".into(),
        category: "execution".into(),
        model: None,
        temperature: 0.3,
        prompt: "You are a Software Engineer.".into(),
    });

    let mut workflows = HashMap::new();
    workflows.insert("debug".into(), WorkflowDef {
        name: "🪲 Debug".into(),
        roles: vec!["programmer".into()],
        max_rounds: 1,
    });

    RoleConfig {
        default_model: "deepseek-chat".into(),
        roles,
        workflows,
    }
}
