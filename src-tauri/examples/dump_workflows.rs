//! Direct IPC smoke test: dumps every workflow + computed mode that
//! `chat_get_role_config` would return to the frontend. Run with:
//!
//!   cargo run --example dump_workflows
//!
//! Prints JSON-shaped output the user can compare against what their
//! chat panel dropdown shows. If `mode` is missing for any workflow,
//! the dropdown won't have it visible under manager mode.

use latte_code_editor_lib::chat_panel::commands::derive_mode;
use latte_code_editor_lib::chat_panel::global_config::{load_roles_config, WorkflowKind};

fn main() {
    let cfg = load_roles_config();
    println!("=== workflows as seen by the frontend (chat_get_role_config) ===");
    println!("workflows in roles.yaml: {}", cfg.workflows.len());
    for (id, w) in cfg.workflows.iter() {
        let kind_str = match w.kind {
            WorkflowKind::Planned => "planned",
            WorkflowKind::Swarm => "swarm",
        };
        let mode = derive_mode(id, kind_str);
        println!(
            "  {id:20} | kind={kind_str:8} | mode={mode:11} | display={}",
            w.name
        );
    }
    println!("=== end ===");
}
