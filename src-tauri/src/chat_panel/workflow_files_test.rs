//! Tests for the per-file workflow storage layout.
//!
//! Marked `#[serial]` because the tests share `LATTE_ROLES_PATH` /
//! `LATTE_WORKFLOWS_DIR` env vars; running in parallel races.

#[cfg(test)]
mod tests {
    use crate::chat_panel::global_config::{
        create_default_roles, delete_workflow_file, load_roles_config, read_all_role_files,
        read_all_workflow_files, read_role_file, read_workflow_file, roles_config_path,
        workflows_dir, write_role_file, write_roles_config, write_workflow_file,
        RoleConfig, RoleDef, WorkflowDef,
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
    ///
    /// 必须隔离环境：`create_default_roles` → `load_from_merged` 会先读
    /// `LATTE_WORKFLOWS_DIR` 下的工作流文件，只有读到空集才回落到
    /// `builtin_workflows()` 的 6 个内置项。此前本测试是全文件里唯一既没
    /// `#[serial]` 也没 `fresh_workspace()` 的，于是读到了开发机上的真实
    /// 用户配置，断言结果随机器而变（本机为 3，故长期失败）。
    /// 指向空的临时目录后，测的才是它声称的「fresh install」回落路径。
    #[test]
    #[serial]
    fn create_default_roles_has_six_workflows() {
        let _guard = ENV_LOCK.lock();
        let (_tmp, _roles_path, _workflows_path) = fresh_workspace("defaults");

        let cfg = create_default_roles();
        assert_eq!(cfg.workflows.len(), 6);
        assert!(cfg.workflows.contains_key("default"));
        assert!(cfg.workflows.contains_key("plan"));
        assert!(cfg.workflows.contains_key("code_review"));
        assert!(cfg.workflows.contains_key("debug"));
        assert!(cfg.workflows.contains_key("quick_task"));
        assert!(cfg.workflows.contains_key("manager_default"));

        env::remove_var("LATTE_ROLES_PATH");
        env::remove_var("LATTE_WORKFLOWS_DIR");
    }
#[test]
#[serial]
fn read_role_file_returns_none_when_missing() {
    let _guard = ENV_LOCK.lock();
    let tmp = TempDir::new().unwrap();
    env::set_var("LATTE_ROLES_DIR", tmp.path());
    let result = read_role_file("does_not_exist").expect("read ok");
    assert!(result.is_none(), "missing file must return Ok(None), got {result:?}");
    env::remove_var("LATTE_ROLES_DIR");
}

#[test]
#[serial]
fn role_file_roundtrip_writes_then_reads_back() {
    let _guard = ENV_LOCK.lock();
    let tmp = TempDir::new().unwrap();
    env::set_var("LATTE_ROLES_DIR", tmp.path());

    let role = RoleDef {
        name: "Round Trip".into(),
        icon: "🧪".into(),
        category: "test".into(),
        model_tier: "standard".into(),
        model: None,
        model_chain: vec!["deepseek-chat".into()],
        temperature: 0.0,
        tools: vec![],
        prompt_file: "".into(),
        prompt: "echo round-trip".into(),
    };
    write_role_file("round_trip", &role).expect("write");
    let read = read_role_file("round_trip")
        .expect("read ok")
        .expect("file exists");
    assert_eq!(read.name, "Round Trip");
    assert_eq!(read.model_chain, vec!["deepseek-chat".to_string()]);
    assert_eq!(read.prompt, "echo round-trip");
    env::remove_var("LATTE_ROLES_DIR");
}

#[test]
#[serial]
fn read_all_role_files_skips_invalid_yaml() {
    let _guard = ENV_LOCK.lock();
    let tmp = TempDir::new().unwrap();
    env::set_var("LATTE_ROLES_DIR", tmp.path());

    let good = RoleDef {
        name: "Good".into(),
        icon: "✅".into(),
        category: "".into(),
        model_tier: "standard".into(),
        model: None,
        model_chain: vec!["deepseek-chat".into()],
        temperature: 0.0,
        tools: vec![],
        prompt_file: "".into(),
        prompt: "".into(),
    };
    write_role_file("good", &good).unwrap();
    // Drop a malformed file alongside.
    std::fs::write(tmp.path().join("bad.yaml"), "name: broken
  - : : :")
        .unwrap();

    let all = read_all_role_files();
    assert!(all.contains_key("good"), "good role should load: {all:?}");
    assert!(!all.contains_key("bad"), "malformed role must be skipped");
    env::remove_var("LATTE_ROLES_DIR");
}

#[test]
#[serial]
fn load_roles_config_overrides_inline_with_file_role() {
    // Set up an isolated workspace:
    //   <tmp>/roles.yaml        → role "pm" with inline prompt
    //   <tmp>/roles/pm.yaml     → role "pm" with different (file) prompt
    // After load_roles_config() the inline role must be REPLACED by
    // the file version (file is source of truth once it exists).
    let _guard = ENV_LOCK.lock();
    let tmp = TempDir::new().unwrap();
    let roles_yaml = tmp.path().join("roles.yaml");
    let roles_dir = tmp.path().join("roles");
    std::fs::create_dir_all(&roles_dir).unwrap();

    let mut inline_cfg = create_default_roles();
    inline_cfg.workflows.clear();
    inline_cfg.roles.insert(
        "pm".into(),
        RoleDef {
            name: "Inline PM".into(),
            icon: "📋".into(),
            category: "".into(),
            model_tier: "standard".into(),
            model: None,
            model_chain: vec!["deepseek-chat".into()],
            temperature: 0.0,
            tools: vec![],
            prompt_file: "".into(),
            prompt: "inline prompt".into(),
        },
    );
    write_roles_config(&roles_yaml, &inline_cfg).unwrap();

    env::set_var("LATTE_ROLES_PATH", roles_yaml.clone());
    env::set_var("LATTE_ROLES_DIR", roles_dir.clone());
    env::set_var("LATTE_WORKFLOWS_DIR", tmp.path().join("workflows"));

    // Now write the file role — `write_role_file` routes through
    // `LATTE_ROLES_DIR` so this lands at `<tmp>/roles/pm.yaml`.
    let file_role = RoleDef {
        name: "File PM".into(),
        icon: "📋".into(),
        category: "".into(),
        model_tier: "standard".into(),
        model: None,
        model_chain: vec!["deepseek-chat".into()],
        temperature: 0.0,
        tools: vec![],
        prompt_file: "".into(),
        prompt: "file prompt wins".into(),
    };
    write_role_file("pm", &file_role).unwrap();

    let cfg = load_roles_config();
    let pm = cfg.roles.get("pm").expect("pm present");
    assert_eq!(pm.name, "File PM", "file role must override inline entry");
    assert_eq!(pm.prompt, "file prompt wins");

    env::remove_var("LATTE_ROLES_PATH");
    env::remove_var("LATTE_ROLES_DIR");
    env::remove_var("LATTE_WORKFLOWS_DIR");
}
}
