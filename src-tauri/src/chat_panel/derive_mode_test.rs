//! Integration tests for `derive_mode` / `kind_to_str`.
//!
//! Loads the user's actual `~/.latte-code-editor/roles.yaml` (the
//! one we set up via `cargo run --bin reset_user_roles`) and verifies
//! the runtime dispatch tags work end-to-end. Critical because this
//! is what makes the chat panel's dropdown filter show the
//! "🧭 通用 — Manager 主导" workflow under manager mode.
//!
//! If the test fails, the user's `roles.yaml` either:
//! - lacks `manager_default` (need to run `reset_user_roles` again), or
//! - has the workflow but with a non-planned kind (would need fix in
//!   `create_default_roles`), or
//! - has the workflow but `derive_mode` is wrongly returning a value
//!   other than `manager_led`.

#[cfg(test)]
mod tests {
    use crate::chat_panel::commands::{derive_mode, kind_to_str};
    use crate::chat_panel::global_config::{load_roles_config, WorkflowKind};

    #[test]
    fn derive_mode_manager_default_returns_manager_led() {
        assert_eq!(
            derive_mode("manager_default", "planned"),
            "manager_led",
            "manager_default workflow id must surface mode=manager_led \
             so the dropdown shows it under manager mode"
        );
    }

    #[test]
    fn derive_mode_other_planned_workflows_stay_planned() {
        // All the default planned workflows should stay in 'planned'
        // mode regardless of which mode the user is in.
        for id in &["default", "plan", "code_review", "debug"] {
            assert_eq!(derive_mode(id, "planned"), "planned", "{id}");
        }
    }

    #[test]
    fn derive_mode_swarm_workflows_stay_swarm() {
        assert_eq!(derive_mode("quick_task", "swarm"), "swarm");
    }

    #[test]
    fn kind_to_str_planned() {
        assert_eq!(kind_to_str(WorkflowKind::Planned), "planned");
    }

    #[test]
    fn kind_to_str_swarm() {
        assert_eq!(kind_to_str(WorkflowKind::Swarm), "swarm");
    }

    /// Live test: the user must have run `cargo run --bin reset_user_roles`
    /// (or otherwise written `manager_default` into roles.yaml) for
    /// this to pass. The test prints the full workflow list with
    /// computed modes so failures are diagnosable without re-running.
    #[test]
    fn users_roles_yaml_has_manager_default_with_manager_led_mode() {
        // Use the real path unless overridden (lets us target a temp
        // dir in CI by setting LATTE_ROLES_PATH).
        let cfg = load_roles_config();

        // Print all workflows for diagnostics — very helpful when
        // the assertion fails because the user can see what's
        // actually in roles.yaml.
        eprintln!("\n=== workflows in roles.yaml ===");
        for (id, w) in cfg.workflows.iter() {
            let mode = derive_mode(id, &kind_to_str(w.kind));
            let kind_str = format!("{:?}", w.kind);
            eprintln!("  {id:20} kind={kind_str:8} mode={mode}");
        }
        eprintln!("=== end ===\n");

        let manager_default = cfg
            .workflows
            .get("manager_default")
            .expect(
                "manager_default workflow missing from roles.yaml — \
                 run `cargo run --bin reset_user_roles` or manually add it",
            );
        assert_eq!(manager_default.name, "🧭 通用 — Manager 主导");
        assert_eq!(
            derive_mode("manager_default", &kind_to_str(manager_default.kind)),
            "manager_led",
            "compute_mode should produce manager_led for manager_default",
        );
    }
}
