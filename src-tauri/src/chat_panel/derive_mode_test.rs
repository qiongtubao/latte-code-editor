//! Integration tests for `derive_mode` / `kind_to_str`.
//!
//! Verifies workflow runtime dispatch tags.
//!
#[cfg(test)]
mod tests {
    use crate::chat_panel::commands::{derive_mode, kind_to_str};
    use crate::chat_panel::global_config::{create_default_roles, WorkflowKind};

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

    #[test]
    fn default_roles_has_manager_default_with_manager_led_mode() {
        let defaults = create_default_roles();
        let manager_default = defaults
            .workflows
            .get("manager_default")
            .expect(
                "manager_default workflow missing from built-in defaults",
            );
        assert_eq!(manager_default.name, "🧭 通用 — Manager 主导");
        assert_eq!(
            derive_mode("manager_default", &kind_to_str(manager_default.kind)),
            "manager_led",
            "compute_mode should produce manager_led for manager_default",
        );
    }
}
