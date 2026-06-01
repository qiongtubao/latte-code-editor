use serde::Deserialize;
use std::path::Path;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BuildEvent {
    Start { job: String },
    Progress { file: String, pct: u8 },
    Log { level: String, msg: String },
    Done { stats: serde_json::Value },
    Error { message: String },
}

pub async fn run<F>(workspace: &Path, cli_path: &Path, on_event: F) -> Result<(), String>
where F: Fn(BuildEvent) + Send + 'static
{
    let mut child = Command::new("node")
        .arg(cli_path).arg("build").arg(workspace)
        .stdout(std::process::Stdio::piped())
        .spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        match serde_json::from_str::<BuildEvent>(&line) {
            Ok(ev) => on_event(ev),
            Err(e) => return Err(format!("malformed NDJSON line '{}': {}", line, e)),
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() { return Err(format!("cli exited {status}")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn parses_dummy_ndjson() {
        let line = r#"{"type":"done","stats":{"files":2,"nodes":0,"edges":0,"ms":1}}"#;
        let ev: BuildEvent = serde_json::from_str(line).unwrap();
        assert!(matches!(ev, BuildEvent::Done { .. }));
    }
}
