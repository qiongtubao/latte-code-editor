//! Tests for `preflight_check` — the per-role API-key gate that
//! runs before the orchestrator. Verifies the function reports each
//! broken role individually (so the user sees one avatar per role),
//! not a single opaque "missing API key" message.

#[cfg(test)]
mod tests {
    use super::super::global_config::{RoleConfig, RoleDef};
    use super::super::session::{preflight_check, PreflightRoleError};
    use latte_agent_core::config::{AgentConfig, ModelCatalog, ModelDef as UpstreamModelDef};
    use latte_agent_core::model_resolver::ModelResolver;
    use std::collections::HashMap;

    fn role_with_chain(name: &str, icon: &str, chain: Vec<String>) -> (String, RoleDef) {
        (
            format!("role_for_{name}"),
            RoleDef {
                name: name.into(),
                icon: icon.into(),
                category: "test".into(),
                model_tier: "standard".into(),
                model_chain: chain,
                temperature: 0.3,
                tools: vec![],
                prompt_file: String::new(),
                prompt: "test".into(),
                ..Default::default()
            },
        )
    }

    fn model_def(id: &str, api_key: &str) -> UpstreamModelDef {
        UpstreamModelDef {
            id: id.into(),
            name: id.into(),
            api: "openai".into(),
            provider: "test".into(),
            base_url: "https://example.invalid".into(),
            api_key: api_key.into(),
            context_window: 8192,
            max_tokens: 4096,
            supports_thinking: false,
            cost_per_million_input: None,
            cost_per_million_output: None,
            tier: None,
            timeout_secs: None,
        }
    }

    fn resolver_with_models(
        models: Vec<UpstreamModelDef>,
        role_ids: &[String],
    ) -> ModelResolver {
        // Build role_tiers mapping each role_id to its primary model.
        let primary = models.first().map(|m| m.id.clone()).unwrap_or_default();
        let mut role_tiers = HashMap::new();
        for rid in role_ids {
            let mut tm = HashMap::new();
            tm.insert("standard".to_string(), primary.clone());
            role_tiers.insert(rid.clone(), tm);
        }
        ModelResolver::from_config(&AgentConfig {
            models: ModelCatalog {
                models,
                tiers: None,
                role_tiers: Some(role_tiers),
            },
            roles: HashMap::new(),
        })
        .expect("resolver")
    }

    /// Build a resolver where every role's tier-Standard primary is
    /// the first model in its own chain. Mirrors what the chat
    /// panel does at runtime.
    fn per_role_resolver(
        models: Vec<UpstreamModelDef>,
        roles_config: &RoleConfig,
        role_ids: &[String],
    ) -> ModelResolver {
        let mut all_role_tiers: HashMap<String, HashMap<String, String>> = HashMap::new();
        for id in role_ids {
            let chain = roles_config
                .roles
                .get(id)
                .map(|r| r.chain())
                .unwrap_or_default();
            let primary = chain
                .first()
                .cloned()
                .unwrap_or_else(|| models[0].id.clone());
            let mut tier_map = HashMap::new();
            tier_map.insert("standard".to_string(), primary);
            all_role_tiers.insert(id.clone(), tier_map);
        }
        ModelResolver::from_config(&AgentConfig {
            models: ModelCatalog {
                models,
                tiers: None,
                role_tiers: Some(all_role_tiers),
            },
            roles: HashMap::new(),
        })
        .expect("resolver")
    }

    fn make_config(entries: Vec<(String, RoleDef)>) -> RoleConfig {
        let mut roles = HashMap::new();
        for (id, r) in entries {
            roles.insert(id, r);
        }
        RoleConfig {
            default_model: "m1".into(),
            roles,
            workflows: HashMap::new(),
        }
    }

    #[test]
    fn preflight_passes_when_every_role_has_an_api_key() {
        let (id, r) = role_with_chain("软件工程师", "💻", vec!["m1".into()]);
        let config = make_config(vec![(id, r)]);
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        let resolver = resolver_with_models(vec![model_def("m1", "sk-real-key")], &role_ids);
        assert!(preflight_check(&resolver, &config, &role_ids).is_ok());
    }

    #[test]
    fn preflight_reports_role_missing_api_key() {
        // Role uses ["m1"] with empty api_key. No fallback exists.
        let (id, r) = role_with_chain("软件工程师", "💻", vec!["m1".into()]);
        let config = make_config(vec![(id, r)]);
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        let resolver = resolver_with_models(vec![
            model_def("m1", ""),
        ], &role_ids);
        let err = preflight_check(&resolver, &config, &role_ids).expect_err("must fail");
        assert_eq!(err.len(), 1, "exactly one role should be reported");
        // resolve_chain returns Err when every model in the chain
        // has no api_key — the error message reflects the resolver
        // failure, not a missing-models report.
        let PreflightRoleError { role_name, icon, message, .. } = &err[0];
        assert_eq!(role_name, "软件工程师");
        assert_eq!(icon, "💻");
        assert!(message.contains("软件工程师"), "{message}");
        assert!(message.contains("api_key"), "{message}");
    }
    fn preflight_reports_each_broken_role_independently() {
        let (id1, r1) = role_with_chain("产品经理", "📋", vec!["m1".into()]);
        let (id2, r2) = role_with_chain("软件工程师", "💻", vec!["m2".into()]);
        let (id3, r3) = role_with_chain("测试工程师", "🧪", vec!["m3".into()]);
        let config = make_config(vec![(id1.clone(), r1), (id2.clone(), r2), (id3.clone(), r3)]);
        // software_engineer uses m2 which has a valid key -> passes
        // product_manager (m1) and tester (m3) have empty keys -> fail
        let resolver = per_role_resolver(
            vec![
                model_def("m1", ""),
                model_def("m2", "sk-real"),
                model_def("m3", ""),
            ],
            &config,
            &[id1.clone(), id2.clone(), id3.clone()],
        );
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        let err = preflight_check(&resolver, &config, &role_ids).expect_err("must fail");
        assert_eq!(err.len(), 2, "exactly two roles should be reported");
        let names: Vec<&str> = err.iter().map(|e| e.role_name.as_str()).collect();
        assert!(names.contains(&"产品经理"));
        assert!(names.contains(&"测试工程师"));
        assert!(!names.contains(&"软件工程师"));
    }
    fn preflight_with_chain_one_working_model_passes() {
        let (id, r) = role_with_chain(
            "软件工程师",
            "💻",
            vec!["m1".into(), "m2".into(), "m3".into()],
        );
        let config = make_config(vec![(id, r)]);
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        let resolver = resolver_with_models(vec![
            model_def("m1", ""),
            model_def("m2", ""),
            model_def("m3", "sk-real"),
        ], &role_ids);
        assert!(preflight_check(&resolver, &config, &role_ids).is_ok());
    }

    #[test]
    fn preflight_handles_unknown_role_id() {
        let (id, r) = role_with_chain("软件工程师", "💻", vec!["m1".into()]);
        let config = make_config(vec![(id, r)]);
        let resolver = resolver_with_models(vec![model_def("m1", "sk")], &config.roles.keys().cloned().collect::<Vec<_>>());
        let err = preflight_check(&resolver, &config, &["nonexistent".into()])
            .expect_err("unknown role must fail");
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].role_name, "nonexistent");
        assert!(err[0].message.contains("未在 roles.yaml 中定义"));
    }

    #[test]
    fn preflight_message_is_chinese() {
        let (id, r) = role_with_chain("软件工程师", "💻", vec!["m1".into()]);
        let config = make_config(vec![(id, r)]);
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        let resolver = resolver_with_models(vec![model_def("m1", "")], &role_ids);
        let err = preflight_check(&resolver, &config, &role_ids).expect_err("must fail");
        let msg = &err[0].message;
        assert!(msg.chars().any(|c| c as u32 > 0x4E00), "must contain Chinese chars: {msg}");
    }
}
