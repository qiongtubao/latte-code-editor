use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct AiReviewResult {
    pub success: bool,
    pub message: String,
}

/// Try to invoke latte-tune (from latte-rs-model-router) as a sidecar.
/// Falls back to a local stub if the binary is not in PATH.
#[tauri::command]
pub async fn ai_review(prompt: String) -> Result<AiReviewResult, String> {
    if let Ok(output) = Command::new("latte-tune")
        .arg("review")
        .arg("--prompt")
        .arg(&prompt)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            return Ok(AiReviewResult {
                success: true,
                message: stdout,
            });
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Ok(AiReviewResult {
            success: false,
            message: format!("latte-tune exited with error: {stderr}"),
        });
    }
    // latte-tune not found: use local stub.
    Ok(AiReviewResult {
        success: true,
        message: stub_review(&prompt),
    })
}

/// Local fallback: produces a basic review when latte-tune is unavailable.
fn stub_review(content: &str) -> String {
    let word_count = content.split_whitespace().count();
    let line_count = content.lines().count();
    let heading_count = content
        .lines()
        .filter(|l| l.trim_start().starts_with("# "))
        .count();
    let wikilink_count = content.matches("[[").count();
    let flow_count = content.matches("```flow:").count();
    let has_frontmatter = content.starts_with("---");

    let yes_no = if has_frontmatter { "yes" } else { "no" };

    let mut review = String::new();
    review.push_str("[stub] latte-tune not in PATH, using local fallback\n\n");
    review.push_str("Stats:\n");
    review.push_str(&format!("  words: {word_count}\n"));
    review.push_str(&format!("  lines: {line_count}\n"));
    review.push_str(&format!("  headings: {heading_count}\n"));
    review.push_str(&format!("  wikilinks: {wikilink_count}\n"));
    review.push_str(&format!("  flow diagrams: {flow_count}\n"));
    review.push_str(&format!("  frontmatter: {yes_no}\n"));

    review.push_str("\nSuggestions:\n");
    if !has_frontmatter {
        review.push_str("  - Add YAML frontmatter (type, title)\n");
    }
    if heading_count == 0 {
        review.push_str("  - Add section headings to improve readability\n");
    }
    if wikilink_count == 0 {
        review.push_str("  - Add [[wikilinks]] to connect to related docs\n");
    }
    if flow_count == 0 {
        review.push_str("  - Consider adding a ```flow:``` diagram for key workflows\n");
    }
    if word_count > 500 && heading_count < 3 {
        review.push_str("  - Long doc without many sections; split or add headings\n");
    }
    review.push_str("\nInstall latte-rs-model-router to enable real AI reviews:\n");
    review.push_str("  cd ../latte-rs-model-router && cargo build --release\n");
    review
}
