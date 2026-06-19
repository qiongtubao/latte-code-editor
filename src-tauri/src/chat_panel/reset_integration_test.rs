//! Integration test for `chat_reset_roles_to_defaults`.
//!
//! Simulates the exact user pain point: an old `roles.yaml` with
//! English role names and no swarm workflow. After reset, the file
//! must contain Chinese names + the `quick_task` swarm preset.

#[cfg(test)]
mod tests {
    use crate::chat_panel::global_config::{
        create_default_roles, load_roles_config, write_roles_config, RoleConfig, RoleDef,
        WorkflowKind,
    };
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use std::env;
    use std::fs;
    use tempfile::TempDir;

    static WORKSPACE_LOCK: Mutex<()> = Mutex::new(());

    fn workspace_dir(label: &str) -> TempDir {
        TempDir::with_suffix(format!("latte-reset-{label}")).expect("temp dir")
    }

    fn english_only_config() -> RoleConfig {
        let mut roles = HashMap::new();
        roles.insert(
            "programmer".into(),
            RoleDef {
                name: "Software Engineer".into(),
                icon: "💻".into(),
                category: "execution".into(),
                model_tier: "standard".into(),
                model_chain: vec!["deepseek-chat".into()],
                temperature: 0.3,
                tools: vec![],
                prompt_file: String::new(),
                prompt: "old english prompt".into(),
                ..Default::default()
            },
        );
        roles.insert(
            "reviewer".into(),
            RoleDef {
                name: "Code Reviewer".into(),
                ..Default::default()
            },
        );
        RoleConfig {
            default_model: "deepseek-chat".into(),
            roles,
            workflows: HashMap::new(),
        }
    }

    /// Run the test body with `LATTE_ROLES_PATH` pointing at the
    /// temp file so `load_roles_config` reads from there instead of
    /// the user's real `~/.latte-code-editor/roles.yaml`.
    fn with_temp_workspace<F: FnOnce(&std::path::Path)>(label: &str, body: F) {
        let _guard = WORKSPACE_LOCK.lock();
        let tmp = workspace_dir(label);
        let config_path = tmp.path().join("roles.yaml");
        env::set_var("LATTE_ROLES_PATH", &config_path);
        body(tmp.path());
        env::remove_var("LATTE_ROLES_PATH");
    }

    #[test]
    fn reset_replaces_english_with_chinese_and_adds_swarm() {
        with_temp_workspace("reset_basic", |workspace| {
            let config_path = workspace.join("roles.yaml");

            write_roles_config(&config_path, &english_only_config()).expect("write baseline");

            let raw_before = fs::read_to_string(&config_path).unwrap();
            assert!(raw_before.contains("Software Engineer"), "baseline missing English name");
            assert!(!raw_before.contains("产品经理"), "baseline shouldn't have Chinese yet");

            // Reset — same path the `chat_reset_roles_to_defaults`
            // command takes (without the Tauri AppHandle wrapper).
            let defaults = create_default_roles();
            write_roles_config(&config_path, &defaults).expect("write reset");
            let reloaded = load_roles_config();

            assert_eq!(reloaded.roles["programmer"].name, "软件工程师");
            assert_eq!(reloaded.roles["pm"].name, "产品经理");
            assert_eq!(reloaded.roles["architect"].name, "系统架构师");
            assert_eq!(reloaded.roles["reviewer"].name, "代码审查员");

            let qt = reloaded
                .workflows
                .get("quick_task")
                .expect("quick_task swarm workflow must exist after reset");
            assert_eq!(qt.kind, WorkflowKind::Swarm);

            for id in ["default", "plan", "code_review", "debug", "quick_task"] {
                assert!(
                    reloaded.workflows.contains_key(id),
                    "missing default workflow `{id}` after reset"
                );
            }
            for id in [
                "pm",
                "architect",
                "programmer",
                "tester",
                "reviewer",
                "devops",
                "security",
                "designer",
                "tech_writer",
                "manager",
            ] {
                assert!(
                    reloaded.roles.contains_key(id),
                    "missing default role `{id}` after reset"
                );
            }

            let raw_after = fs::read_to_string(&config_path).unwrap();
            assert!(!raw_after.contains("Software Engineer"));
            assert!(!raw_after.contains("Code Reviewer"));
            assert!(!raw_after.contains("old english prompt"));
            assert!(raw_after.contains("软件工程师"));
            assert!(raw_after.contains("quick_task"));
        });
    }

    #[test]
    fn reset_creates_file_when_missing() {
        with_temp_workspace("reset_missing", |workspace| {
            let config_path = workspace.join("roles.yaml");
            assert!(!config_path.exists(), "test precondition");

            write_roles_config(&config_path, &create_default_roles()).expect("write fresh");

            assert!(
                config_path.exists(),
                "reset must create the file when missing"
            );
            let raw = fs::read_to_string(&config_path).unwrap();
            assert!(raw.contains("quick_task"));
            assert!(raw.contains("软件工程师"));
        });
    }

    #[test]
    fn defaults_are_chinese_friendly() {
        let cfg = create_default_roles();
        let expected: &[(&str, &str)] = &[
            ("pm", "产品经理"),
            ("architect", "系统架构师"),
            ("programmer", "软件工程师"),
            ("tester", "测试工程师"),
            ("reviewer", "代码审查员"),
            ("devops", "运维工程师"),
            ("security", "安全审计员"),
            ("designer", "UI/UX 设计师"),
            ("tech_writer", "技术写作"),
            ("manager", "工程经理"),
        ];
        for (id, name) in expected {
            let actual = &cfg
                .roles
                .get(*id)
                .unwrap_or_else(|| panic!("missing default role `{id}`"))
                .name;
            assert_eq!(actual, name, "default role `{id}` must be Chinese");
        }
    }
}
