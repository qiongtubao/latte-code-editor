//! Tests for the manager status computation + emission.

#[cfg(test)]
mod tests {
    use crate::chat_panel::manager::{compute_manager_status, phase_label};
    use crate::chat_panel::types::{
        ManagerAction, ManagerSessionState, ManagerState, ManagerTurn,
    };
    use crate::chat_panel::global_config::WorkflowDef;

    fn empty_state(state: ManagerState) -> ManagerSessionState {
        ManagerSessionState {
            session_id: 1,
            state,
            topic: "测试".into(),
            manager_role_id: "manager".into(),
            available_roles: vec!["pm".into(), "programmer".into()],
            max_total_steps: 8,
            max_user_decisions: 5,
            steps_taken: 0,
            decisions_taken: 0,
            turns: Vec::new(),
            started_at_ms: 0,
            finished_at_ms: None,
            summary: None,
        }
    }

    #[test]
    fn phase_labels_are_chinese_and_match_state() {
        let cases = [
            (ManagerState::Idle, "空闲"),
            (ManagerState::Planning, "规划中"),
            (ManagerState::AwaitingDecision, "等待你的决策"),
            (ManagerState::AssigningWorker, "派单中"),
            (ManagerState::WorkerRunning, "Worker 运行中"),
            (ManagerState::Reflecting, "反思中"),
            (ManagerState::Finalizing, "收尾中"),
            (ManagerState::Done, "已完成"),
            (ManagerState::Failed, "失败"),
        ];
        for (state, expected) in cases {
            let label = phase_label(&state);
            assert_eq!(label, expected, "phase label for {state:?} should be Chinese");
        }
    }

    #[test]
    fn compute_status_empty_session() {
        // No API key in tests → stub mode. The manager role ships a
        // chain (default `deepseek-chat`), so `is_stub_mode` is true
        // because no real API key exists in the test env.
        let state = empty_state(ManagerState::Planning);
        let status = compute_manager_status(&state);
        assert_eq!(status.session_id, 1);
        assert_eq!(status.state, ManagerState::Planning);
        assert_eq!(status.phase_label, "规划中");
        assert_eq!(status.manager_role_id, "manager");
        assert!(!status.manager_role_name.is_empty(), "manager role name should be set");
        assert!(status.is_stub_mode, "no API key in test env → stub mode");
        assert_eq!(status.steps_taken, 0);
        assert_eq!(status.max_total_steps, 8);
        assert_eq!(status.decisions_taken, 0);
        assert_eq!(status.max_user_decisions, 5);
        assert_eq!(status.transcript_bytes, 0);
        assert_eq!(status.summary_bytes, 0);
        assert_eq!(status.tokens_estimated, 0);
    }

    #[test]
    fn compute_status_aggregates_transcript_bytes() {
        let mut state = empty_state(ManagerState::Reflecting);
        state.turns.push(ManagerTurn {
            turn_number: 0,
            role_id: "manager".into(),
            role_name: "工程经理".into(),
            icon: "👔".into(),
            content: "What should we do next?".into(),
            action: Some(ManagerAction::NeedDecision {
                branch_label: "🧭 通用".into(),
                question: "?".into(),
                reason: "r".into(),
                options: vec![],
            }),
            user_decision: None,
            weight: 2.0,
            pinned: false,
            ts_ms: 0,
        });
        state.turns.push(ManagerTurn {
            turn_number: 1,
            role_id: "programmer".into(),
            role_name: "软件工程师".into(),
            icon: "💻".into(),
            content: "实现登录页的 POST /auth/login".into(),
            action: None,
            user_decision: None,
            weight: 1.0,
            pinned: false,
            ts_ms: 0,
        });
        state.summary = Some("# Summary\n\nlogin page plan".into());
        let status = compute_manager_status(&state);
        // Each turn contributes content + role_name bytes.
        let expected = ("What should we do next?".len() + "工程经理".len()) as u32
            + ("实现登录页的 POST /auth/login".len() + "软件工程师".len()) as u32;
        assert_eq!(status.transcript_bytes, expected);
        assert_eq!(status.summary_bytes, "# Summary\n\nlogin page plan".len() as u32);
        // Token estimate = transcript / 3 + summary / 3.
        assert_eq!(
            status.tokens_estimated,
            (status.transcript_bytes / 3) + (status.summary_bytes / 3)
        );
    }

    #[test]
    fn compute_status_carries_available_workers_from_state() {
        let mut state = empty_state(ManagerState::AwaitingDecision);
        state.available_roles = vec!["pm".into(), "architect".into(), "tester".into()];
        let status = compute_manager_status(&state);
        assert_eq!(status.available_workers, vec!["pm", "architect", "tester"]);
    }

    #[test]
    fn compute_status_records_role_label_and_icon() {
        let state = empty_state(ManagerState::Planning);
        let status = compute_manager_status(&state);
        // "manager" is shipped by the default roles.yaml.
        assert!(!status.manager_role_name.is_empty());
        assert!(!status.manager_icon.is_empty());
    }
}
