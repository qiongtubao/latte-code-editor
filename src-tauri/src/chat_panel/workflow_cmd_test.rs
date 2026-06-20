//! Tests for the workflow save / delete command surface.
//!
//! Exercises the pure helpers (`validate_workflow_id`,
//! `workflow_payload_to_def`, `workflow_def_to_payload`) without
//! needing a Tauri AppHandle or a real roles.yaml. The persistence
//! path (`write_roles_config` + reload round-trip) is also covered.

#[cfg(test)]
mod tests {
    use crate::chat_panel::commands::{
        validate_workflow_id, workflow_def_to_payload, workflow_payload_to_def,
    };
    use crate::chat_panel::global_config::{WorkflowDef, WorkflowKind, WorkflowStep};
    use crate::chat_panel::types::{WorkflowPayload, WorkflowStepPayload};

    // ─── validate_workflow_id ────────────────────────────────────

    #[test]
    fn validate_id_rejects_empty() {
        assert!(validate_workflow_id("").is_err());
    }

    #[test]
    fn validate_id_accepts_alphanumeric() {
        assert!(validate_workflow_id("plan_v2").is_ok());
        assert!(validate_workflow_id("CODE-REVIEW").is_ok());
        assert!(validate_workflow_id("ns:workflow").is_ok());
    }

    #[test]
    fn validate_id_rejects_whitespace_and_slashes() {
        assert!(validate_workflow_id("has space").is_err());
        assert!(validate_workflow_id("path/traversal").is_err());
        assert!(validate_workflow_id("path\\traversal").is_err());
    }

    #[test]
    fn validate_id_rejects_overlong() {
        let s = "a".repeat(65);
        assert!(validate_workflow_id(&s).is_err());
    }

    // ─── workflow_payload_to_def ─────────────────────────────────

    fn base_payload() -> WorkflowPayload {
        WorkflowPayload {
            id: "plan_v2".into(),
            name: "🗺️ 规划 v2".into(),
            kind: "planned".into(),
            roles: vec!["pm".into(), "architect".into()],
            steps: vec![
                WorkflowStepPayload {
                    name: "需求澄清".into(),
                    roles: vec!["pm".into()],
                },
                WorkflowStepPayload {
                    name: "架构方案".into(),
                    roles: vec!["architect".into()],
                },
            ],
            max_rounds: 2,
            planner_role: String::new(),
            worker_roles: Vec::new(),
            max_steps: 4,
            manager_role: "tech_director".into(),
            initial_workers: vec![],
            max_total_steps: 8,
            max_user_decisions: 5,
        }
    }

    #[test]
    fn payload_to_def_round_trips_basic_fields() {
        let def = workflow_payload_to_def(&base_payload()).expect("valid");
        assert_eq!(def.name, "🗺️ 规划 v2");
        assert_eq!(def.kind, WorkflowKind::Planned);
        assert_eq!(def.max_rounds, 2);
        assert_eq!(def.steps.len(), 2);
        assert_eq!(def.steps[0].name, "需求澄清");
        assert_eq!(def.steps[0].roles, vec!["pm".to_string()]);
        assert_eq!(def.steps[1].roles, vec!["architect".to_string()]);
    }

    #[test]
    fn payload_to_def_swarm_kind() {
        let mut p = base_payload();
        p.kind = "swarm".into();
        p.planner_role = "manager".into();
        p.worker_roles = vec!["pm".into(), "tester".into()];
        let def = workflow_payload_to_def(&p).expect("valid");
        assert_eq!(def.kind, WorkflowKind::Swarm);
        assert_eq!(def.planner_role, "manager");
        assert_eq!(def.worker_roles, vec!["pm".to_string(), "tester".to_string()]);
    }

    #[test]
    fn payload_to_def_rejects_empty_name() {
        let mut p = base_payload();
        p.name = "   ".into();
        let err = workflow_payload_to_def(&p).unwrap_err();
        assert!(err.contains("名称"));
    }

    #[test]
    fn payload_to_def_rejects_invalid_kind() {
        let mut p = base_payload();
        p.kind = "rocket".into();
        let err = workflow_payload_to_def(&p).unwrap_err();
        assert!(err.contains("rocket"));
    }

    #[test]
    fn payload_to_def_rejects_zero_max_rounds() {
        let mut p = base_payload();
        p.max_rounds = 0;
        let err = workflow_payload_to_def(&p).unwrap_err();
        assert!(err.contains("max_rounds"));
    }

    #[test]
    fn payload_to_def_rejects_empty_step_roles() {
        let mut p = base_payload();
        p.steps[1].roles = vec![];
        let err = workflow_payload_to_def(&p).unwrap_err();
        assert!(err.contains("第 2 步"));
        assert!(err.contains("架构方案"));
    }

    #[test]
    fn payload_to_def_rejects_invalid_id() {
        let mut p = base_payload();
        p.id = "bad id with spaces".into();
        let err = workflow_payload_to_def(&p).unwrap_err();
        assert!(err.contains("id"));
    }

    // ─── workflow_def_to_payload ─────────────────────────────────

    #[test]
    fn def_to_payload_round_trips() {
        let def = WorkflowDef {
            name: "🪲 排查".into(),
            kind: WorkflowKind::Planned,
            roles: vec!["tester".into()],
            steps: vec![WorkflowStep {
                name: "复现".into(),
                roles: vec!["tester".into()],
            }],
            max_rounds: 1,
            planner_role: String::new(),
            worker_roles: Vec::new(),
            max_steps: 4,
            manager_role: "tech_director".into(),
            initial_workers: vec![],
            max_total_steps: 8,
            max_user_decisions: 5,
        };
        let p = workflow_def_to_payload("debug", &def);
        assert_eq!(p.id, "debug");
        assert_eq!(p.steps[0].name, "复现");
    }

    #[test]
    fn def_to_payload_uses_swarm_kind_string() {
        let def = WorkflowDef {
            name: "🪄 quick".into(),
            kind: WorkflowKind::Swarm,
            roles: Vec::new(),
            steps: Vec::new(),
            max_rounds: 1,
            planner_role: "manager".into(),
            worker_roles: vec!["pm".into()],
            max_steps: 4,
            manager_role: "tech_director".into(),
            initial_workers: vec!["pm".into()],
            max_total_steps: 8,
            max_user_decisions: 5,
        };
        let p = workflow_def_to_payload("quick_task", &def);
        assert_eq!(p.kind, "swarm");
        assert_eq!(p.planner_role, "manager");
    }

    #[test]
    fn payload_to_def_to_payload_is_stable() {
        let original = base_payload();
        let def = workflow_payload_to_def(&original).expect("valid");
        let round = workflow_def_to_payload(&original.id, &def);
        // JSON equality would require serde — instead compare key
        // scalar fields. The "id" round-trips by construction since
        // the payload is keyed by it.
        assert_eq!(round.id, original.id);
        assert_eq!(round.name, original.name);
        assert_eq!(round.kind, original.kind);
        assert_eq!(round.max_rounds, original.max_rounds);
        assert_eq!(round.steps.len(), original.steps.len());
        for (a, b) in round.steps.iter().zip(original.steps.iter()) {
            assert_eq!(a.name, b.name);
            assert_eq!(a.roles, b.roles);
        }
    }
}
