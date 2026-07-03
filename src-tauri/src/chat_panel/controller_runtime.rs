use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use latte_agent_core::config::AgentConfig;
use latte_agent_core::controller::{ChatController, ControllerConfig};
use latte_agent_core::global_config::GlobalConfig;
use latte_agent_core::model_resolver::{ModelResolver, ModelTier};
use latte_ai::params::GenerateParams;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::types::{ContinueDiscussionRequest, StartDiscussionRequest, WorkspaceChatEvent};

static NEXT_SESSION_ID: AtomicUsize = AtomicUsize::new(1);
struct SessionEntry {
    controller: Arc<ChatController>,
    workspace_id: Option<String>,
}

static SESSIONS: LazyLock<Mutex<HashMap<usize, SessionEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn start(
    app: AppHandle,
    request: StartDiscussionRequest,
    project_root: Option<PathBuf>,
    workspace_id: Option<String>,
) -> Result<usize, String> {
    let cwd = project_root
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let project_agents = cwd.join(".latte").join("agents.d");
    let project_models = cwd.join(".latte").join("models.d");
    tracing::info!(
        event = "chat_controller_runtime.start",
        workspace_id = ?workspace_id,
        project_root = ?project_root,
        cwd = ?cwd,
        project_agents = ?project_agents,
        project_models = ?project_models,
        task_id = ?request.topic
    );
    let (agent_config, resolver) = load_cli_like_agent_config(
        Some(project_agents.as_path()),
        Some(project_models.as_path()),
    )?;
    let role_id = initial_role(&agent_config, &request);
    let initial_tier = agent_config
        .roles
        .get(&role_id)
        .and_then(|r| ModelTier::parse(&r.model_tier).ok());
    let agent_config = Arc::new(agent_config);
    let resolver = Arc::new(resolver);
    let controller = Arc::new(ChatController::new(256));
    let mut events = controller
        .spawn(ControllerConfig {
            task_id: None,
            roles: vec![role_id],
            initial_prompt: None,
            max_rounds: request.max_rounds.unwrap_or(10) as u32,
            session_token_budget: 50_000,
            agent_config,
            model_resolver: resolver,
            default_params: GenerateParams::default(),
            primary_model_id: None,
            initial_tier,
            cwd,
        })
        .await;

    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst);
    SESSIONS.lock().await.insert(
        session_id,
        SessionEntry {
            controller: controller.clone(),
            workspace_id: workspace_id.clone(),
        },
    );

    let app_for_events = app.clone();
    let workspace_id_for_events = workspace_id.clone();
    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            let done = matches!(event, latte_agent_core::controller::ChatEvent::Done);
            if let Some(workspace_id) = workspace_id_for_events.as_ref() {
                let payload = WorkspaceChatEvent {
                    workspace_id: workspace_id.clone(),
                    event,
                };
                let _ = app_for_events.emit("chat:event", &payload);
            } else {
                let _ = app_for_events.emit("chat:event", &event);
            }
            if done {
                SESSIONS.lock().await.remove(&session_id);
                break;
            }
        }
    });

    if !request.topic.trim().is_empty() {
        controller.submit_input(&request.topic).await;
    }

    Ok(session_id)
}

pub async fn continue_chat(request: ContinueDiscussionRequest) -> Result<(), String> {
    let Some(controller) = SESSIONS
        .lock()
        .await
        .get(&request.session_id)
        .map(|entry| entry.controller.clone()) else {
        return Err(format!("chat session {} not found", request.session_id));
    };
    controller.submit_input(&request.message).await;
    Ok(())
}

pub async fn cancel(session_id: usize) -> Result<(), String> {
    let Some(entry) = SESSIONS.lock().await.remove(&session_id) else {
        return Ok(());
    };
    entry.controller.abort().await;
    Ok(())
}

pub async fn cancel_workspace(workspace_id: &str) -> Result<(), String> {
    let sessions = {
        let guard = SESSIONS.lock().await;
        guard
            .iter()
            .filter_map(|(id, entry)| {
                (entry.workspace_id.as_deref() == Some(workspace_id)).then_some(*id)
            })
            .collect::<Vec<_>>()
    };

    for id in sessions {
        cancel(id).await?;
    }
    Ok(())
}

fn initial_role(agent_config: &AgentConfig, request: &StartDiscussionRequest) -> String {
    if let Some(role) = request
        .custom_roles
        .as_ref()
        .and_then(|roles| roles.first())
        .filter(|role| agent_config.roles.contains_key(*role))
    {
        return role.clone();
    }
    if agent_config.roles.contains_key(&request.workflow) {
        return request.workflow.clone();
    }
    if agent_config.roles.contains_key("manager") {
        return "manager".to_string();
    }
    agent_config
        .roles
        .keys()
        .next()
        .cloned()
        .unwrap_or_else(|| "manager".to_string())
}

fn load_cli_like_agent_config(
    project_agents: Option<&Path>,
    project_models: Option<&Path>,
) -> Result<(AgentConfig, ModelResolver), String> {
    // Mirrors latte-agent-cli's config_layer::load for chat:
    // project .latte/agents.d + .latte/models.d, global agents.d,
    // and global ~/.latte/models.{yaml,toml}/models.d with global-only
    // model ids appended to every role chain.
    let global = GlobalConfig::load_default()
        .map_err(|e| format!("failed to load global model config: {e}"))?;
    let project_agents_str = project_agents.and_then(|p| p.to_str());
    let mut project_cfg = AgentConfig::load_with_global(project_agents_str)
        .map_err(|e| format!("failed to load agent config: {e}"))?;

    if let Some(path) = project_models {
        if path.exists() {
            let path_str = path
                .to_str()
                .ok_or_else(|| format!("invalid project model path: {}", path.display()))?;
            let part = AgentConfig::load(path_str)
                .map_err(|e| format!("failed to load project model config: {e}"))?;
            merge_agent_config(&mut project_cfg, &part);
        }
    }

    let project_ids: std::collections::HashSet<&str> = project_cfg
        .models
        .models
        .iter()
        .map(|m| m.id.as_str())
        .collect();
    let extra_ids: Vec<String> = global
        .models
        .iter()
        .map(|m| m.id.as_str())
        .filter(|id| !project_ids.contains(id))
        .map(str::to_string)
        .collect();

    let mut merged = global.merge_into_project(&project_cfg);
    if !extra_ids.is_empty() {
        for template in merged.roles.values_mut() {
            for id in &extra_ids {
                if !template.model_chain.iter().any(|c| c == id) {
                    template.model_chain.push(id.clone());
                }
            }
        }
    }

    let resolver = ModelResolver::from_config(&merged)
        .map_err(|e| format!("model resolver init: {e}"))?;
    Ok((merged, resolver))
}

fn merge_agent_config(dst: &mut AgentConfig, src: &AgentConfig) {
    dst.roles
        .extend(src.roles.iter().map(|(k, v)| (k.clone(), v.clone())));
    dst.models.models.extend(src.models.models.iter().cloned());
    if let Some(tiers) = &src.models.tiers {
        dst.models
            .tiers
            .get_or_insert_with(Default::default)
            .extend(tiers.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    if let Some(role_tiers) = &src.models.role_tiers {
        let dst_role_tiers = dst
            .models
            .role_tiers
            .get_or_insert_with(Default::default);
        for (role, tier_map) in role_tiers {
            dst_role_tiers
                .entry(role.clone())
                .or_insert_with(Default::default)
                .extend(tier_map.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn initial_role_defaults_to_manager_for_workflow_names() {
        let mut agent_config = AgentConfig::default();
        agent_config.roles.insert(
            "manager".to_string(),
            latte_agent_core::role::RoleTemplate {
                id: "manager".to_string(),
                name: "Manager".to_string(),
                category: "planning".to_string(),
                model_tier: "standard".to_string(),
                model_chain: vec![],
                prompt_file: None,
                temperature: Some(0.5),
                tools: vec![],
                icon: "M".to_string(),
            },
        );
        let req = StartDiscussionRequest {
            topic: "hello".to_string(),
            workflow: "discuss".to_string(),
            custom_roles: None,
            max_rounds: None,
            workspace_id: None,
        };

        assert_eq!(initial_role(&agent_config, &req), "manager");
    }

    #[test]
    #[serial]
    fn cli_like_loader_appends_global_only_models_to_role_chains() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let global = temp.path().join("global");
        std::fs::create_dir_all(project.join(".latte/agents.d")).unwrap();
        std::fs::create_dir_all(&global).unwrap();

        std::fs::write(
            project.join(".latte/agents.d/manager.toml"),
            r#"
[roles.manager]
id = "manager"
name = "Manager"
category = "planning"
model_tier = "premium"
model_chain = ["claude-opus"]
prompt_file = "prompts/manager.md"
temperature = 0.2
tools = []
icon = "M"
"#,
        )
        .unwrap();
        std::fs::write(
            global.join("models.yaml"),
            r#"
models:
  - id: deepseek-chat
    name: DeepSeek Chat
    api: openai
    provider: deepseek
    base_url: https://api.deepseek.com
    api_key: sk-test
    context_window: 32768
    max_tokens: 8192
    tier: standard
"#,
        )
        .unwrap();

        let old_latte_home = std::env::var_os("LATTE_HOME");
        std::env::set_var("LATTE_HOME", &global);
        let old_dir = std::env::current_dir().unwrap();
        std::env::set_current_dir(&project).unwrap();

        let (config, resolver) = load_cli_like_agent_config(
            Some(project.join(".latte/agents.d").as_path()),
            Some(project.join(".latte/models.d").as_path()),
        )
        .unwrap();

        std::env::set_current_dir(old_dir).unwrap();
        match old_latte_home {
            Some(value) => std::env::set_var("LATTE_HOME", value),
            None => std::env::remove_var("LATTE_HOME"),
        }

        let manager = config.roles.get("manager").unwrap();
        assert_eq!(manager.model_tier, "premium");
        assert!(manager.model_chain.contains(&"deepseek-chat".to_string()));
        assert!(resolver.build_model("deepseek-chat").is_ok());
    }

    #[test]
    fn merge_agent_config_appends_project_models() {
        let mut dst = AgentConfig::default();
        let mut src = AgentConfig::default();
        src.models.models.push(latte_agent_core::config::ModelDef {
            id: "deepseek-chat".to_string(),
            name: "DeepSeek".to_string(),
            api: "openai".to_string(),
            provider: "deepseek".to_string(),
            base_url: "https://api.deepseek.com".to_string(),
            api_key: "sk-test".to_string(),
            context_window: 32_768,
            max_tokens: 8192,
            supports_thinking: false,
            cost_per_million_input: None,
            cost_per_million_output: None,
            tier: Some("standard".to_string()),
            timeout_secs: None,
        });

        merge_agent_config(&mut dst, &src);

        assert_eq!(dst.models.models[0].id, "deepseek-chat");
    }
}
