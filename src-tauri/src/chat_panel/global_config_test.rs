#[cfg(test)]
mod tests {
    use super::super::global_config::{expand_env_vars, global_models_path, load_global_models, GlobalModelConfig, RoleDef};

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

    // ─── RoleDef::chain / set_chain — model priority selection ──────────
    //
    // The chain is the new top-level config field. These tests cover
    // the read/write contract: `chain()` is the single source of truth
    // (preferring the explicit list, falling back to the legacy
    // single `model` field), and `set_chain()` clears the legacy
    // field so the YAML form is unambiguous.

    fn make_role(model: Option<&str>, chain: Vec<&str>) -> RoleDef {
        RoleDef {
            name: "Test".into(),
            icon: "🧪".into(),
            category: "test".into(),
            model: model.map(String::from),
            model_chain: chain.into_iter().map(String::from).collect(),
            temperature: 0.5,
            prompt: "You are a test.".into(),
        }
    }

    #[test]
    fn test_chain_prefers_explicit_chain() {
        // Explicit chain wins over the legacy `model` field.
        let r = make_role(Some("legacy"), vec!["primary", "fallback-1", "fallback-2"]);
        assert_eq!(r.chain(), vec!["primary", "fallback-1", "fallback-2"]);
    }

    #[test]
    fn test_chain_falls_back_to_legacy_model() {
        // No explicit chain → wrap the legacy single model in a one-element list.
        let r = make_role(Some("legacy"), vec![]);
        assert_eq!(r.chain(), vec!["legacy"]);
    }

    #[test]
    fn test_chain_empty_when_nothing_set() {
        // Neither field set → empty chain; caller decides the fallback.
        let r = make_role(None, vec![]);
        assert!(r.chain().is_empty());
    }

    #[test]
    fn test_set_chain_clears_legacy_model() {
        // Setting the chain clears the legacy `model` field so the
        // serialized form is unambiguous.
        let mut r = make_role(Some("legacy"), vec![]);
        r.set_chain(vec!["a".into(), "b".into()]);
        assert_eq!(r.chain(), vec!["a", "b"]);
        assert!(r.model.is_none(), "legacy `model` field must be cleared by set_chain");
    }

    #[test]
    fn test_roundtrip_yaml_with_chain() {
        // The chain survives a serialize → deserialize roundtrip, with
        // the legacy `model` field absent in the YAML.
        let original = make_role(None, vec!["claude-opus", "claude-sonnet", "deepseek"]);
        let yaml = serde_yaml::to_string(&original).expect("serialize");
        let parsed: RoleDef = serde_yaml::from_str(&yaml).expect("parse");
        assert_eq!(parsed.chain(), vec!["claude-opus", "claude-sonnet", "deepseek"]);
        assert!(parsed.model.is_none());
    }

    #[test]
    fn test_roundtrip_yaml_with_legacy_model_only() {
        // Backward compat: a config that still uses the legacy `model`
        // field deserializes correctly and surfaces as a one-element
        // chain through the `chain()` accessor.
        let original = make_role(Some("deepseek-chat"), vec![]);
        let yaml = serde_yaml::to_string(&original).expect("serialize");
        let parsed: RoleDef = serde_yaml::from_str(&yaml).expect("parse");
        assert_eq!(parsed.chain(), vec!["deepseek-chat"]);
    }
}
