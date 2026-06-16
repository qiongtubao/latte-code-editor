#[cfg(test)]
mod tests {
    use super::super::global_config::{expand_env_vars, global_models_path, load_global_models, GlobalModelConfig};

    const TEST_YAML: &str = r#"
models:
  - id: "deepseek-v4-flash"
    name: "DeepSeek Chat V3"
    api: "openai"
    provider: "deepseek"
    base_url: "https://api.deepseek.com"
    api_key: "sk-test-key-123"
    context_window: 1000000
    max_tokens: 384000
    reasoning: false
    cost_per_million_input: 0.27
    cost_per_million_output: 1.10
"#;

    #[test]
    fn test_parse_user_yaml_format() {
        let config: GlobalModelConfig = serde_yaml::from_str(TEST_YAML).unwrap();
        assert_eq!(config.models.len(), 1);
        let m = &config.models[0];
        assert_eq!(m.id, "deepseek-v4-flash");
        assert_eq!(m.provider, "deepseek");
        assert_eq!(m.api_key, "sk-test-key-123");
    }

    #[test]
    fn test_has_api_key_with_direct_value() {
        let config: GlobalModelConfig = serde_yaml::from_str(TEST_YAML).unwrap();
        assert!(config.has_api_key());
    }

    #[test]
    fn test_get_api_key_by_provider() {
        let config: GlobalModelConfig = serde_yaml::from_str(TEST_YAML).unwrap();
        let key = config.get_api_key("deepseek").unwrap();
        assert_eq!(key, "sk-test-key-123");
    }

    #[test]
    fn test_env_var_expansion() {
        std::env::set_var("TEST_API_KEY", "sk-env-expanded");
        let result = expand_env_vars("${TEST_API_KEY}");
        assert_eq!(result, "sk-env-expanded");
    }

    #[test]
    fn test_first_model() {
        let config: GlobalModelConfig = serde_yaml::from_str(TEST_YAML).unwrap();
        let first = config.first_model().unwrap();
        assert_eq!(first.id, "deepseek-v4-flash");
    }

    #[test]
    fn test_load_user_actual_config() {
        // Test loading the actual user config file if it exists
        let path = global_models_path();
        if path.exists() {
            let config = load_global_models();
            println!("Loaded {} models from {:?}", config.models.len(), path);
            assert!(!config.models.is_empty(), "models.yaml should have at least one model");
        }
    }
}
