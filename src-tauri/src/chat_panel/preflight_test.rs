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
        }
    }

    fn resolver_with_models(models: Vec<UpstreamModelDef>) -> ModelResolver {
        // Per-role tier map: each model id maps to itself. We
        // expect callers to seed `role_tiers[role_id][standard] =
        // first_model_in_role_chain`. preflight_check calls
        // `resolve_chain(role_id, Standard, &chain_tail)` which
        // uses `role_tiers` to pick the primary. Building a flat
        // "all roles use m1" map collapses every chain to `[m1]`,
        // which makes the test wrong. Use per-role entries below.
        ModelResolver::from_config(&AgentConfig {
            models: ModelCatalog {
                models: models.clone(),
                tiers: None,
                role_tiers: None,
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
        let resolver = resolver_with_models(vec![model_def("m1", "sk-real-key")]);
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        assert!(preflight_check(&resolver, &config, &role_ids).is_ok());
    }

    #[test]
    fn preflight_reports_role_missing_api_key() {
        let (id, r) = role_with_chain("软件工程师", "💻", vec!["m1".into()]);
        let config = make_config(vec![(id, r)]);
        let resolver = resolver_with_models(vec![model_def("m1", "")]);
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        let err = preflight_check(&resolver, &config, &role_ids).expect_err("must fail");
        assert_eq!(err.len(), 1, "exactly one role should be reported");
        let PreflightRoleError { role_name, icon, missing_models, message, .. } = &err[0];
        assert_eq!(role_name, "软件工程师");
        assert_eq!(icon, "💻");
        assert!(missing_models.contains(&"m1".to_string()));
        // Message is Chinese + names the role + names the model.
        assert!(message.contains("软件工程师"), "{message}");
        assert!(message.contains("m1"), "{message}");
        assert!(message.contains("API key"), "{message}");
    }

    #[test]
    fn preflight_reports_each_broken_role_independently() {
        let (id1, r1) = role_with_chain("产品经理", "📋", vec!["m1".into()]);
        let (id2, r2) = role_with_chain("软件工程师", "💻", vec!["m2".into()]);
        let (id3, r3) = role_with_chain("测试工程师", "🧪", vec!["m3".into()]);
        let (id1, r1) = role_with_chain("产品经理", "📋", vec!["m1".into()]);
        let (id2, r2) = role_with_chain("软件工程师", "💻", vec!["m2".into()]);
        let (id3, r3) = role_with_chain("测试工程师", "🧪", vec!["m3".into()]);
        let config = make_config(vec![(id1.clone(), r1), (id2.clone(), r2), (id3.clone(), r3)]);
        let resolver = per_role_resolver(
            vec![
                model_def("m1", ""),
                model_def("m2", "sk-real"),
                model_def("m3", ""),
            ],
            &config,
            &[id1, id2, id3],
        );
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        let err = preflight_check(&resolver, &config, &role_ids).expect_err("must fail");
        assert_eq!(err.len(), 2, "exactly two roles should be reported");
        let names: Vec<&str> = err.iter().map(|e| e.role_name.as_str()).collect();
        assert!(names.contains(&"产品经理"));
        assert!(names.contains(&"测试工程师"));
        assert!(!names.contains(&"软件工程师"));
    }

    #[test]
    fn preflight_with_chain_one_working_model_passes() {
        // Chain: [empty, empty, "sk-real"]. Even though the
        // primary is missing a key, the chain has one usable
        // model — the runtime resolver will fall back to it, so
        // preflight passes.
        let (id, r) = role_with_chain(
            "软件工程师",
            "💻",
            vec!["m1".into(), "m2".into(), "m3".into()],
        );
        let config = make_config(vec![(id, r)]);
        let resolver = resolver_with_models(vec![
            model_def("m1", ""),
            model_def("m2", ""),
            model_def("m3", "sk-real"),
        ]);
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        assert!(preflight_check(&resolver, &config, &role_ids).is_ok());
    }

    #[test]
    fn preflight_handles_unknown_role_id() {
        let (id, r) = role_with_chain("软件工程师", "💻", vec!["m1".into()]);
        let config = make_config(vec![(id, r)]);
        let resolver = resolver_with_models(vec![model_def("m1", "sk")]);
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
        let resolver = resolver_with_models(vec![model_def("m1", "")]);
        let role_ids: Vec<String> = config.roles.keys().cloned().collect();
        let err = preflight_check(&resolver, &config, &role_ids).expect_err("must fail");
        // No English-only message — every error report should be
        // user-readable for a Chinese-locale audience.
        let msg = &err[0].message;
        assert!(msg.chars().any(|c| c as u32 > 0x4E00), "must contain Chinese chars: {msg}");
    }
}
