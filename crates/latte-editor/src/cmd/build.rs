use crate::build::runner::{run, BuildEvent};
use crate::state::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn cmd_build(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ws: PathBuf = state
        .workspace
        .lock()
        .unwrap()
        .clone()
        .ok_or("workspace not open")?;
    // CLI lives at packages/cli/src/index.ts relative to the editor crate.
    // `CARGO_MANIFEST_DIR` is resolved at compile time, so the path is stable
    // across dev and prod regardless of the runtime cwd.
    let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/cli/src/index.ts");
    let app2 = app.clone();
    run(&ws, &cli, move |ev: BuildEvent| {
        let _ = app2.emit("build:event", &ev);
    })
    .await
}
