//! One-shot example: run `load_roles_config` against the user's real
//! roles.yaml. If `~/.latte-code-editor/workflows/` doesn't exist yet,
//! this triggers the one-time migration that splits the inline
//! workflows into per-file storage.
//!
//! Run with:
//!   cargo run --example split_user_workflows
//!
//! Output:
//!   Before: 6 workflows in roles.yaml, 0 in workflows/
//!   After: 0 in roles.yaml, 6 in workflows/<id>.yaml

use latte_code_editor_lib::chat_panel::global_config::{
    load_roles_config, read_all_workflow_files, roles_config_path, workflows_dir,
};

fn main() {
    let roles_path = roles_config_path();
    let workflows_path = workflows_dir();
    println!("=== migration smoke test ===");
    println!("roles.yaml:  {}", roles_path.display());
    println!("workflows/:  {}", workflows_path.display());

    let inline_before = std::fs::read_to_string(&roles_path)
        .ok()
        .and_then(|s| serde_yaml::from_str::<serde_yaml::Value>(&s).ok())
        .and_then(|v| v.get("workflows").and_then(|w| w.as_mapping()).map(|m| m.len()))
        .unwrap_or(0);
    let files_before = std::fs::read_dir(&workflows_path)
        .map(|it| it.flatten().filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("yaml")).count())
        .unwrap_or(0);

    println!(
        "before:  roles.yaml has {inline_before} inline workflows, workflows/ has {files_before} files"
    );

    let cfg = load_roles_config();
    println!(
        "load_roles_config returned {} workflows",
        cfg.workflows.len()
    );

    let inline_after = std::fs::read_to_string(&roles_path)
        .ok()
        .and_then(|s| serde_yaml::from_str::<serde_yaml::Value>(&s).ok())
        .and_then(|v| v.get("workflows").and_then(|w| w.as_mapping()).map(|m| m.len()))
        .unwrap_or(0);
    let files_after: Vec<String> = read_all_workflow_files()
        .keys()
        .cloned()
        .collect();
    let files_after_count = files_after.len();

    println!(
        "after:   roles.yaml has {inline_after} inline workflows, workflows/ has {files_after_count} files"
    );
    for id in &files_after {
        println!("  ✓ workflows/{id}.yaml");
    }
    println!("=== done ===");
}
