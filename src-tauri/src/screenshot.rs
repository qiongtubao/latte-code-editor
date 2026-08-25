//! 窗口截图：调平台原生抓屏工具存盘，把路径交回前端。
//!
//! 前端拿到 `path` 后用 clipboard 插件的 `writeImage(path)` 入剪贴板
//! （Tauri 的 `JsImage` 把字符串解析为 `Path` 变体，需要 tauri 的
//! `image-png` feature 才能解码，见 Cargo.toml）。**不要**回传 base64：
//! 那既是几 MB 的无谓 IPC 负载，又会被 `JsImage` 误当成文件路径。

use serde::Serialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::Command;

#[derive(Serialize)]
pub struct ScreenshotResult {
    pub path: String,
    pub size_bytes: u64,
}

/// Linux 抓屏工具候选，按优先级排列。第二项是文件路径**之前**的参数，
/// 路径统一追加在末尾。只列「参数末位接输出文件」的工具——像 flameshot
/// 的 `-p` 收的是目录而非文件，语义不同，故不纳入。
#[cfg(target_os = "linux")]
const LINUX_TOOLS: &[(&str, &[&str])] = &[
    ("gnome-screenshot", &["-f"]),
    ("xfce4-screenshooter", &["-f", "-s"]),
    ("spectacle", &["-b", "-n", "-o"]),
    ("scrot", &[]),
    ("maim", &[]),
    ("grim", &[]), // wayland
    ("import", &["-window", "root"]), // imagemagick
];

/// 抓屏后校验产物：工具可能 exit 0 却没落盘（用户取消、无权限抓屏、
/// wayland 工具在 X11 下空跑），所以成功判据是「文件存在且非空」。
fn verify_capture(path: &Path) -> Result<u64, String> {
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("screenshot file missing after capture: {e}"))?;
    if meta.len() == 0 {
        return Err("screenshot tool produced an empty file".to_string());
    }
    Ok(meta.len())
}

/// Capture a screenshot using the platform's native screenshot tool,
/// save to ~/Pictures/latte-screenshots/screenshot-<ts>.png
#[tauri::command]
pub async fn screenshot_window() -> Result<ScreenshotResult, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot determine home directory".to_string())?;
    let dir = Path::new(&home).join("Pictures").join("latte-screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir failed: {e}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("screenshot-{ts}.png"));

    #[cfg(target_os = "macos")]
    {
        // -x: no sound; -t png: output format
        let status = Command::new("screencapture")
            .args(["-x", "-t", "png"])
            .arg(&path)
            .status()
            .await
            .map_err(|e| format!("screencapture spawn failed: {e}"))?;
        if !status.success() {
            return Err(format!("screencapture exited with status: {status}"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut captured = false;
        for (tool, pre_args) in LINUX_TOOLS {
            let status = Command::new(tool).args(*pre_args).arg(&path).status().await;
            // spawn 失败 = 工具没装，继续下一个；exit != 0 = 装了但失败
            // （grim 在 X11 下、gnome-screenshot 无 portal 时），同样继续。
            if matches!(status, Ok(s) if s.success()) && verify_capture(&path).is_ok() {
                captured = true;
                break;
            }
        }
        if !captured {
            // 此前这里会写一个假 PNG 占位文件并报告成功，结果前端拿到
            // 损坏文件、剪贴板静默失败、toast 却显示 "Saved"。宁可明确报错。
            let names: Vec<&str> = LINUX_TOOLS.iter().map(|(t, _)| *t).collect();
            return Err(format!(
                "no working screenshot tool found; install one of: {}",
                names.join(", ")
            ));
        }
    }
    #[cfg(target_os = "windows")]
    {
        let ps = format!(
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
             $b = New-Object Drawing.Bitmap ([System.Windows.Forms.SystemInformation]::VirtualScreen.Width), \
                                              ([System.Windows.Forms.SystemInformation]::VirtualScreen.Height); \
             $g = [Drawing.Graphics]::FromImage($b); \
             $g.CopyFromScreen(0, 0, 0, 0, $b.Size); \
             $b.Save('{}', [Drawing.Imaging.ImageFormat]::Png);",
            path.to_string_lossy().replace('\\', "\\\\").replace('\'', "\\'")
        );
        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(&ps)
            .status()
            .await
            .map_err(|e| format!("powershell spawn failed: {e}"))?;
        if !status.success() {
            return Err(format!("powershell exited with status: {status}"));
        }
    }

    let size_bytes = verify_capture(&path)?;
    Ok(ScreenshotResult {
        path: path.to_string_lossy().to_string(),
        size_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn verify_capture_reports_size_for_written_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("shot.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n1234").unwrap();
        assert_eq!(verify_capture(&path).unwrap(), 12);
    }

    #[test]
    fn verify_capture_rejects_missing_file() {
        let dir = TempDir::new().unwrap();
        let err = verify_capture(&dir.path().join("nope.png")).unwrap_err();
        assert!(err.contains("missing after capture"), "got: {err}");
    }

    #[test]
    fn verify_capture_rejects_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty.png");
        std::fs::write(&path, b"").unwrap();
        let err = verify_capture(&path).unwrap_err();
        assert!(err.contains("empty file"), "got: {err}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_tool_list_is_non_empty_and_unique() {
        let names: Vec<&str> = LINUX_TOOLS.iter().map(|(t, _)| *t).collect();
        assert!(!names.is_empty());
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "duplicate tool in LINUX_TOOLS");
    }
}
