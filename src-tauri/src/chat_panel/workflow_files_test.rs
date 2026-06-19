//! Tests for the per-file workflow storage layout.
//!
//! Marked `#[serial]` because the tests share `LATTE_ROLES_PATH` /
//! `LATTE_WORKFLOWS_DIR` env vars; running in parallel races.

#[cfg(test)]
mod tests {
    use crate::chat_panel::global_config::{
        create_default_roles, delete_workflow_file, load_roles_config, read_all_workflow_files,
        read_workflow_file, roles_config_path, workflows_dir, write_roles_config,
        write_workflow_file, RoleConfig, RoleDef, WorkflowDef,
    };
    use parking_lot::Mutex;
    use serial_test::serial;
    use std::collections::HashMap;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tempfile::TempDir;

    static SEQ: AtomicU64 = AtomicU64::new(0);
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn fresh_workspace(label: &str) -> (TempDir, PathBuf, PathBuf) {
        let tmp = TempDir::with_suffix(format!(
            "latte-workflow-files-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ))
        .unwrap();
        let roles_path = tmp.path().join("roles.yaml");
        let workflows_path = tmp.path().join("workflows");
        env::set_var("LATTE_ROLES_PATH", &roles_path);
        env::set_var("LATTE_WORKFLOWS_DIR", &workflows_path);
        (tmp, roles_path, workflows_path)
    }

    /// Write a fake roles.yaml with inline workflows (the legacy
    /// single-file layout) and confirm `load_roles_config` splits
    /// them into `workflows/<id>.yaml` files.
    #[test]
    #[serial]
    fn load_roles_config_splits_inline_workflows_into_files() {
        let _guard = ENV_LOCK.lock();
        let (_tmp, roles_path, workflows_path) = fresh_workspace("split");

        let mut roles = HashMap::new();
        roles.insert(
            "pm".into(),
            RoleDef {
                name: "产品经理".into(),
                ..Default::default()
            },
        );
        let config = RoleConfig {
            default_model: "deepseek-chat".into(),
            roles,
            workflows: HashMap::from([
                (
                    "default".into(),
                    WorkflowDef {
                        name: "💬 默认".into(),
                        ..Default::default()
                    },
                ),
                (
                    "quick_task".into(),
                    WorkflowDef {
                        name: "🪄 快速任务".into(),
                        ..Default::default()
                    },
                ),
            ]),
        };
        write_roles_config(&roles_path, &config).unwrap();

        assert!(
            !workflows_path.exists()
                || fs::read_dir(&workflows_path).unwrap().next().is_none()
        );

        let _ = load_roles_config();

        assert!(
            workflows_path.join("default.yaml").exists(),
            "default.yaml should exist"
        );
        assert!(
            workflows_path.join("quick_task.yaml").exists(),
            "quick_task.yaml should exist"
        );

        let after = fs::read_to_string(&roles_path).unwrap();
        assert!(
            !after.contains("quick_task"),
            "roles.yaml should not contain inline workflows after migration: {after}"
        );

        env::remove_var("LATTE_ROLES_PATH");
        env::remove_var("LATTE_WORKFLOWS_DIR");
    }

    /// Once migration has run, re-running `load_roles_config` should
    /// not duplicate the workflows or write to existing files.
    #[test]
    #[serial]
    fn split_migration_is_idempotent() {
        let _guard = ENV_LOCK.lock();
        let (_tmp, roles_path, workflows_path) = fresh_workspace("idem");

        let mut roles = HashMap::new();
        roles.insert(
            "pm".into(),
            RoleDef {
                name: "PM".into(),
                ..Default::default()
            },
        );
        let config = RoleConfig {
            default_model: "deepseek-chat".into(),
            roles,
            workflows: HashMap::from([(
                "plan".into(),
                WorkflowDef {
                    name: "🗺️ Plan".into(),
                    ..Default::default()
                },
            )]),
        };
        write_roles_config(&roles_path, &config).unwrap();

        let _ = load_roles_config();
        let workflow_file = workflows_path.join("plan.yaml");
        let original = fs::read_to_string(&workflow_file).unwrap();
        let original_mtime = fs::metadata(&workflow_file).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));

        let _ = load_roles_config();

        let after = fs::read_to_string(&workflow_file).unwrap();
        assert_eq!(after, original, "plan.yaml content changed unexpectedly");
        let after_mtime = fs::metadata(&workflow_file).unwrap().modified().unwrap();
        assert_eq!(
            after_mtime, original_mtime,
            "plan.yaml mtime changed — migration re-ran and overwrote"
        );

        env::remove_var("LATTE_ROLES_PATH");
        env::remove_var("LATTE_WORKFLOWS_DIR");
    }

    #[test]
    #[serial]
    fn write_and_read_workflow_file_round_trips() {
        let _guard = ENV_LOCK.lock();
        let (_tmp, _roles_path, _workflows_path) = fresh_workspace("roundtrip");

        let def = WorkflowDef {
            name: "🪄 Test Swarm".into(),
            ..Default::default()
        };
        write_workflow_file("myflow", &def).unwrap();

        let read_back = read_workflow_file("myflow").unwrap().expect("must exist");
        assert_eq!(read_back.name, "🪄 Test Swarm");

        let all = read_all_workflow_files();
        assert_eq!(all.len(), 1);
        assert!(all.contains_key("myflow"));

        env::remove_var("LATTE_ROLES_PATH");
        env::remove_var("LATTE_WORKFLOWS_DIR");
    }

    #[test]
    #[serial]
    fn read_workflow_file_missing_returns_none() {
        let _guard = ENV_LOCK.lock();
        let (_tmp, _roles_path, _workflows_path) = fresh_workspace("missing");
        assert!(read_workflow_file("does_not_exist").unwrap().is_none());

        env::remove_var("LATTE_ROLES_PATH");
        env::remove_var("LATTE_WORKFLOWS_DIR");
    }

    #[test]
    #[serial]
    fn delete_workflow_file_only_succeeds_if_existed() {
        let _guard = ENV_LOCK.lock();
        let (_tmp, _roles_path, _workflows_path) = fresh_workspace("delete");
        assert!(!delete_workflow_file("absent").unwrap());
        write_workflow_file("present", &WorkflowDef::default()).unwrap();
        assert!(workflows_dir().join("present.yaml").exists());
        assert!(delete_workflow_file("present").unwrap());
        assert!(!workflows_dir().join("present.yaml").exists());

        env::remove_var("LATTE_ROLES_PATH");
        env::remove_var("LATTE_WORKFLOWS_DIR");
    }

    #[test]
    #[serial]
    fn read_all_workflow_files_skips_invalid_yaml() {
        let _guard = ENV_LOCK.lock();
        let (_tmp, _roles_path, workflows_path) = fresh_workspace("invalid");
        fs::create_dir_all(&workflows_path).unwrap();
        write_workflow_file("good", &WorkflowDef::default()).unwrap();
        fs::write(workflows_path.join("bad.yaml"), "not: valid: yaml: [[[").unwrap();
        let all = read_all_workflow_files();
        assert!(all.contains_key("good"));
        assert!(!all.contains_key("bad"));

        env::remove_var("LATTE_ROLES_PATH");
        env::remove_var("LATTE_WORKFLOWS_DIR");
    }

    /// Sanity: the default config that ships with the binary has 6
    /// workflows. Confirms `create_default_roles` still produces them
    /// (and they'll be written to files on first load).
    #[test]
    fn create_default_roles_has_six_workflows() {
        let cfg = create_default_roles();
        assert_eq!(cfg.workflows.len(), 6);
        assert!(cfg.workflows.contains_key("default"));
        assert!(cfg.workflows.contains_key("plan"));
        assert!(cfg.workflows.contains_key("code_review"));
        assert!(cfg.workflows.contains_key("debug"));
        assert!(cfg.workflows.contains_key("quick_task"));
        assert!(cfg.workflows.contains_key("manager_default"));
    }
}
