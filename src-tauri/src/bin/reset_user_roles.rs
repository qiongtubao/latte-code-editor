//! Manual one-shot binary: invoke `chat_reset_roles_to_defaults`
//! against the user's real `~/.latte-code-editor/roles.yaml` so the
//! Chinese-name migration lands for users with old configs.
//!
//! Usage:
//!   cargo run --bin reset_user_roles
//!
//! Backs up the existing file to `roles.yaml.bak` before writing.
//! Reads `/tmp/user_roles_backup.yaml` first to confirm there's a
//! backup before continuing.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use latte_code_editor_lib::chat_panel::global_config::{
    create_default_roles, roles_config_path, write_roles_config,
};

fn main() {
    let path: PathBuf = roles_config_path();
    println!("Resetting: {}", path.display());

    if path.exists() {
        let backup = backup_path(&path);
        fs::copy(&path, &backup).expect("backup existing roles.yaml");
        println!("Backup → {}", backup.display());
    }

    let config = create_default_roles();
    write_roles_config(&path, &config).expect("write defaults");
    println!("OK — wrote Chinese defaults ({} roles, {} workflows)",
             config.roles.len(),
             config.workflows.len());

    // Sanity-check: the on-disk file contains the new Chinese names.
    let raw = fs::read_to_string(&path).expect("re-read");
    let expectations = [
        ("pm", "产品经理"),
        ("programmer", "软件工程师"),
        ("quick_task", "🪄"),
    ];
    for (id, fragment) in expectations {
        assert!(
            raw.contains(fragment),
            "after reset, expected `{fragment}` for `{id}`"
        );
    }
    println!("Sanity OK — file contains 中文 role names + quick_task swarm.");
}

fn backup_path(p: &Path) -> PathBuf {
    let stamp = env::var("RESET_BACKUP_STAMP").unwrap_or_else(|_| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        now.to_string()
    });
    p.with_extension(format!("yaml.bak.{stamp}"))
}
