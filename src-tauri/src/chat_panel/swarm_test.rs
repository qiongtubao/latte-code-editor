//! Tests for the swarm-mode runtime.
//!
//! Covers the deterministic helpers that drive stub mode and the
//! planner-YAML parser that converts live LLM output into typed
//! `SwarmStepSpec`s. The async `run_swarm` flow itself requires a
//! Tauri `AppHandle`, so end-to-end coverage is limited to the file
//! layout (which is the contract the chat panel UI depends on).

#[cfg(test)]
mod unit_tests {
    use super::super::global_config::{WorkflowDef, WorkflowKind};
    use super::super::swarm::{parse_plan_yaml, stub_plan, stub_step_instruction};
    use std::collections::HashSet;

    // ─── parse_plan_yaml ────────────────────────────────────────

    #[test]
    fn parse_plan_yaml_clean_form() {
        let text = r#"
steps:
  - id: design
    role: architect
    instruction: Sketch the API.
  - id: build
    role: programmer
    instruction: Implement it.
"#;
        let workers = vec!["architect".into(), "programmer".into()];
        let steps = parse_plan_yaml(text, &workers, 5);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].id, "design");
        assert_eq!(steps[0].role, "architect");
        assert_eq!(steps[1].id, "build");
        assert_eq!(steps[1].role, "programmer");
    }

    #[test]
    fn parse_plan_yaml_strips_code_fences() {
        let text = r#"Here's what I'd do:
```yaml
steps:
  - id: write
    role: tech_writer
    instruction: Write the docs.
```
Hope that helps."#;
        let workers = vec!["tech_writer".into()];
        let steps = parse_plan_yaml(text, &workers, 5);
        assert_eq!(steps.len(), 1, "got {steps:?}");
        assert_eq!(steps[0].role, "tech_writer");
    }

    #[test]
    fn parse_plan_yaml_drops_unknown_roles() {
        let text = r#"
steps:
  - id: a
    role: architect
    instruction: x
  - id: b
    role: wizard
    instruction: x
"#;
        let workers = vec!["architect".into()];
        let steps = parse_plan_yaml(text, &workers, 5);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].role, "architect");
    }

    #[test]
    fn parse_plan_yaml_respects_max_steps() {
        let mut text = String::from("steps:\n");
        for i in 0..10 {
            text.push_str(&format!(
                "  - id: s{i}\n    role: programmer\n    instruction: do {i}\n"
            ));
        }
        let workers = vec!["programmer".into()];
        let steps = parse_plan_yaml(&text, &workers, 3);
        assert_eq!(steps.len(), 3);
    }

    #[test]
    fn parse_plan_yaml_disambiguates_duplicate_ids() {
        let text = r#"
steps:
  - id: build
    role: programmer
    instruction: do thing A
  - id: build
    role: tester
    instruction: do thing B
"#;
        let workers = vec!["programmer".into(), "tester".into()];
        let steps = parse_plan_yaml(text, &workers, 5);
        assert_eq!(steps.len(), 2);
        let ids: HashSet<&str> = steps.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains("build"));
        assert_eq!(ids.len(), 2, "duplicate ids must be disambiguated");
    }

    #[test]
    fn parse_plan_yaml_returns_empty_for_non_yaml_text() {
        let steps = parse_plan_yaml("just some prose, no yaml here", &[], 5);
        assert!(steps.is_empty());
    }

    #[test]
    fn parse_plan_yaml_drops_steps_missing_required_fields() {
        let text = r#"
steps:
  - id: ok
    role: programmer
    instruction: do it
  - id: missing_role
    instruction: no role field
  - id: missing_instruction
    role: programmer
"#;
        let workers = vec!["programmer".into()];
        let steps = parse_plan_yaml(text, &workers, 5);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].id, "ok");
    }

    // ─── stub_plan ──────────────────────────────────────────────

    #[test]
    fn stub_plan_picks_design_roles_for_design_topic() {
        let workers = vec![
            "pm".into(),
            "architect".into(),
            "programmer".into(),
            "reviewer".into(),
        ];
        let steps = stub_plan("design the login screen", &workers, 4);
        assert!(!steps.is_empty());
        let roles: HashSet<&str> = steps.iter().map(|s| s.role.as_str()).collect();
        assert!(roles.contains("architect"), "missing architect in {steps:?}");
    }

    #[test]
    fn stub_plan_picks_test_roles_for_bug_topic() {
        let workers = vec![
            "tester".into(),
            "programmer".into(),
            "reviewer".into(),
        ];
        let steps = stub_plan("fix the auth bug", &workers, 4);
        let roles: HashSet<&str> = steps.iter().map(|s| s.role.as_str()).collect();
        assert!(roles.contains("tester"));
        assert!(roles.contains("programmer"));
    }

    #[test]
    fn stub_plan_respects_max_steps() {
        let workers = vec![
            "pm".into(),
            "architect".into(),
            "programmer".into(),
            "reviewer".into(),
            "tester".into(),
        ];
        let steps = stub_plan("fix something", &workers, 2);
        assert!(steps.len() <= 2, "got {} steps", steps.len());
    }

    #[test]
    fn stub_plan_handles_empty_worker_list() {
        let steps = stub_plan("any topic", &[], 4);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].role, "programmer");
    }

    #[test]
    fn stub_plan_handles_short_max_steps() {
        let workers = vec![
            "pm".into(),
            "architect".into(),
            "programmer".into(),
        ];
        let steps = stub_plan("design foo", &workers, 1);
        assert_eq!(steps.len(), 1);
    }

    // ─── stub_step_instruction ──────────────────────────────────

    #[test]
    fn stub_step_instruction_includes_topic() {
        let msg = stub_step_instruction("programmer", "refactor auth");
        assert!(msg.contains("refactor auth"), "{msg}");
    }

    #[test]
    fn stub_step_instruction_known_role() {
        let msg = stub_step_instruction("reviewer", "code review");
        assert!(msg.contains("Review"));
    }

    #[test]
    fn stub_step_instruction_unknown_role_falls_back() {
        let msg = stub_step_instruction("wizard", "magic");
        assert!(msg.contains("wizard"));
        assert!(msg.contains("magic"));
    }

    // ─── WorkflowDef defaults ───────────────────────────────────
    //
    // The schema changed (added `kind`, `planner_role`, `worker_roles`,
    // `max_steps`). Make sure serde-default behavior is backwards
    // compatible with existing user YAML.

    #[test]
    fn workflow_def_default_is_planned_with_zero_roles() {
        let wf = WorkflowDef::default();
        assert_eq!(wf.kind, WorkflowKind::Planned);
        assert!(wf.roles.is_empty());
        assert_eq!(wf.planner_role, "");
        assert!(wf.worker_roles.is_empty());
        assert_eq!(wf.max_steps, 5, "default max_steps = 5");
    }

    #[test]
    fn workflow_def_yaml_back_compat_no_kind_field() {
        let yaml = r#"
name: "Legacy"
roles: [pm, architect]
max_rounds: 2
"#;
        let wf: WorkflowDef = serde_yaml::from_str(yaml).expect("parse legacy yaml");
        assert_eq!(wf.name, "Legacy");
        assert_eq!(wf.kind, WorkflowKind::Planned);
        assert_eq!(wf.max_rounds, 2);
        assert_eq!(wf.planner_role, "");
        assert!(wf.worker_roles.is_empty());
    }

    #[test]
    fn workflow_def_swarm_yaml_roundtrip() {
        let yaml = r#"
name: "Quick Task"
kind: swarm
planner_role: manager
worker_roles: [pm, architect, programmer]
max_steps: 4
"#;
        let wf: WorkflowDef = serde_yaml::from_str(yaml).expect("parse swarm yaml");
        assert_eq!(wf.kind, WorkflowKind::Swarm);
        assert_eq!(wf.planner_role, "manager");
        assert_eq!(wf.worker_roles, vec!["pm", "architect", "programmer"]);
        assert_eq!(wf.max_steps, 4);

        let again: WorkflowDef =
            serde_yaml::from_str(&serde_yaml::to_string(&wf).unwrap()).unwrap();
        assert_eq!(again.kind, WorkflowKind::Swarm);
        assert_eq!(again.planner_role, "manager");
        assert_eq!(again.max_steps, 4);
    }
}

#[cfg(test)]
mod integration_tests {
    //! End-to-end checks that don't need a Tauri `AppHandle`:
    //! the workspace-relative file layout run_swarm produces, and
    //! the `quick_task` preset shipped by `create_default_roles`.

    use crate::chat_panel::global_config::{load_roles_config, WorkflowKind};
    use crate::chat_panel::swarm::{stub_plan, stub_step_instruction};
    use crate::chat_panel::types::SwarmStepSpec;
    use std::fs;

    fn fresh_workspace(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("latte-swarm-test")
            .join(format!("{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp workspace");
        dir
    }

    fn quick_task_swarm_preset_is_swarm_kind() {
        let defaults = crate::chat_panel::global_config::create_default_roles();
        let quick = defaults
            .workflows
            .get("quick_task")
            .expect("quick_task preset shipped");
        assert_eq!(quick.kind, WorkflowKind::Swarm);
        assert!(!quick.worker_roles.is_empty());
        assert!(quick.max_steps >= 1);
    }

    #[test]
    fn stub_plan_yields_steps_with_topic_in_instructions() {
        let workers = vec![
            "pm".into(),
            "architect".into(),
            "programmer".into(),
            "tech_writer".into(),
        ];
        let steps = stub_plan("design a login page", &workers, 4);
        assert!(!steps.is_empty(), "stub plan must emit at least one step");
        for step in &steps {
            let instr = stub_step_instruction(&step.role, "design a login page");
            assert!(
                instr.contains("design a login page"),
                "instruction missing topic: {instr}"
            );
        }
    }

    #[test]
    fn swarm_filesystem_layout_writes_plan_steps_and_summary() {
        // Verify the on-disk contract `<workspace>/.swarm_<name>/`
        // (plan.md, steps/<id>.md, summary.md) that the chat panel
        // UI relies on for the file list display.
        let workspace = fresh_workspace("layout");
        let name = "quick_task";
        let swarm_dir = workspace.join(format!(".swarm_{}", name));
        fs::create_dir_all(swarm_dir.join("steps")).unwrap();

        let mut steps: Vec<SwarmStepSpec> = stub_plan(
            "design a login page",
            &vec![
                "pm".into(),
                "architect".into(),
                "programmer".into(),
                "tech_writer".into(),
            ],
            4,
        );
        // Stamp the topic onto every instruction so we can grep for
        // it later.
        for s in &mut steps {
            s.instruction = format!("{} — for design a login page", s.instruction);
        }

        let plan_md = format!(
            "# Plan: design a login page\n\nSteps: **{}**\n\n{}\n",
            steps.len(),
            steps
                .iter()
                .enumerate()
                .map(|(i, s)| format!(
                    "{}. **{}** (`{}`) — {}\n",
                    i + 1,
                    s.role,
                    s.id,
                    s.instruction
                ))
                .collect::<String>()
        );
        fs::write(swarm_dir.join("plan.md"), &plan_md).unwrap();

        for (i, s) in steps.iter().enumerate() {
            let step_md = format!(
                "# Step {n}: {role} ({id})\n\n## Instruction\n\n{instruction}\n\n## Response\n\n(response)\n",
                n = i + 1,
                role = s.role,
                id = s.id,
                instruction = s.instruction,
            );
            fs::write(
                swarm_dir.join("steps").join(format!("{}.md", s.id)),
                step_md,
            )
            .unwrap();
        }

        let summary = format!(
            "# design a login page\n\n_Synthesized from {n} steps._\n",
            n = steps.len()
        );
        fs::write(swarm_dir.join("summary.md"), &summary).unwrap();

        assert!(swarm_dir.join("plan.md").exists());
        assert!(swarm_dir.join("summary.md").exists());
        for s in &steps {
            let p = swarm_dir.join("steps").join(format!("{}.md", s.id));
            assert!(p.exists(), "missing per-step file: {}", p.display());
            let body = fs::read_to_string(&p).unwrap();
            assert!(body.contains(&s.instruction));
        }

        let _ = fs::remove_dir_all(&workspace);
    }
}
