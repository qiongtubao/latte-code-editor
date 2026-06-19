//! Integration test for `chat_reset_roles_to_defaults`.
//!
//! Marked `#[serial]` because the tests share `LATTE_ROLES_PATH` and
//! `LATTE_WORKFLOWS_DIR` env vars; running in parallel races.

#[cfg(test)]
mod tests {
    use crate::chat_panel::global_config::{
        create_default_roles, load_roles_config, read_all_workflow_files,
        write_roles_config, RoleConfig, RoleDef, WorkflowKind,
    };
    use parking_lot::Mutex;
    use serial_test::serial;
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

    /// Run the test body with `LATTE_ROLES_PATH` + `LATTE_WORKFLOWS_DIR`
    /// pointing at the temp file so `load_roles_config` reads from
    /// there instead of the user's real `~/.latte-code-editor/roles.yaml`.
    fn with_temp_workspace<F: FnOnce(&std::path::Path)>(label: &str, body: F) {
        let _guard = WORKSPACE_LOCK.lock();
        let tmp = workspace_dir(label);
        let config_path = tmp.path().join("roles.yaml");
        let workflows_path = tmp.path().join("workflows");
        env::set_var("LATTE_ROLES_PATH", &config_path);
        env::set_var("LATTE_WORKFLOWS_DIR", &workflows_path);
        body(tmp.path());
        env::remove_var("LATTE_ROLES_PATH");
        env::remove_var("LATTE_WORKFLOWS_DIR");
    }

    #[test]
    #[serial]
    fn reset_replaces_english_with_chinese_and_adds_swarm() {
        with_temp_workspace("reset_basic", |workspace| {
            let config_path = workspace.join("roles.yaml");

            write_roles_config(&config_path, &english_only_config()).expect("write baseline");

            let raw_before = fs::read_to_string(&config_path).unwrap();
            assert!(raw_before.contains("Software Engineer"), "baseline missing English name");
            assert!(!raw_before.contains("产品经理"), "baseline shouldn't have Chinese yet");

            let defaults = create_default_roles();
            write_roles_config(&config_path, &defaults).expect("write reset");
            let _reloaded = load_roles_config();

            // After the workflow-files migration, the inline
            // `workflows:` key in roles.yaml is empty by design.
            // Confirm the roles file + the per-file workflow file.
            let raw_after = fs::read_to_string(&config_path).unwrap();
            assert!(!raw_after.contains("Software Engineer"));
            assert!(!raw_after.contains("Code Reviewer"));
            assert!(!raw_after.contains("old english prompt"));
            assert!(raw_after.contains("软件工程师"));
            assert!(
                !raw_after.contains("quick_task"),
                "quick_task should have moved to workflows/quick_task.yaml: {raw_after}"
            );
            let workflows = read_all_workflow_files();
            let qt = workflows
                .get("quick_task")
                .expect("quick_task swarm workflow must exist after reset");
            assert_eq!(qt.kind, WorkflowKind::Swarm);

            for id in [
                "default",
                "plan",
                "code_review",
                "debug",
                "quick_task",
                "manager_default",
            ] {
                assert!(
                    workflows.contains_key(id),
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
                let role = _reloaded.roles.get(id).unwrap_or_else(|| panic!("missing role `{id}`"));
                assert!(
                    !role.name.is_empty(),
                    "role `{id}` must have a Chinese name after reset"
                );
            }
        });
    }

    #[test]
    #[serial]
    fn reset_creates_file_when_missing() {
        with_temp_workspace("reset_missing", |workspace| {
            let config_path = workspace.join("roles.yaml");
            assert!(!config_path.exists(), "test precondition");

            write_roles_config(&config_path, &create_default_roles()).expect("write fresh");

            // Trigger the workflow-files migration so quick_task ends
            // up in workflows/quick_task.yaml, not inline in roles.yaml.
            let _ = load_roles_config();
            assert!(
                config_path.exists(),
                "reset must create the file when missing"
            );
            let raw = fs::read_to_string(&config_path).unwrap();
            assert!(raw.contains("软件工程师"));
            // quick_task now lives in workflows/, not roles.yaml.
            assert!(
                read_all_workflow_files().contains_key("quick_task"),
                "workflows/quick_task.yaml must exist"
            );
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
