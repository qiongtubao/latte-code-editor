use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct AiReviewResult {
    pub success: bool,
    pub message: String,
}

/// Invoke latte-tune (from latte-rs-model-router) as a sidecar.
///
/// The binary is expected at `$PATH/latte-tune` or sidecar path.
/// v1: stub that attempts to call latte-tune and falls back gracefully.
#[tauri::command]
pub async fn ai_review(prompt: String) -> Result<AiReviewResult, String> {
    match Command::new("latte-tune")
        .arg("review")
        .arg("--prompt")
        .arg(&prompt)
        .output()
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            Ok(AiReviewResult {
                success: true,
                message: stdout,
            })
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(AiReviewResult {
                success: false,
                message: format!("latte-tune exited with error: {stderr}"),
            })
        }
        Err(e) => Ok(AiReviewResult {
            success: false,
            message: format!("latte-tune not found or not running: {e}. Install latte-rs-model-router first."),
        }),
    }
}
