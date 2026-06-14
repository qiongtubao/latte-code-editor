use base64::Engine;
use serde::Serialize;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
pub struct ScreenshotResult {
    pub path: String,
    pub size_bytes: u64,
    /// base64-encoded PNG (for clipboard copy in the frontend)
    pub data_base64: String,
}

/// Capture a screenshot using the platform's native screenshot tool,
/// save to ~/Pictures/latte-screenshots/screenshot-<ts>.png
#[tauri::command]
pub async fn screenshot_window() -> Result<ScreenshotResult, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot determine home directory".to_string())?;
    let dir = std::path::Path::new(&home)
        .join("Pictures")
        .join("latte-screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir failed: {}", e))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let filename = format!("screenshot-{}.png", ts);
    let path = dir.join(&filename);

    #[cfg(target_os = "macos")]
    {
        // -x: no sound; -t png: output format
        let status = Command::new("screencapture")
            .arg("-x")
            .arg("-t")
            .arg("png")
            .arg(&path)
            .status()
            .map_err(|e| format!("screencapture spawn failed: {}", e))?;
        if !status.success() {
            return Err(format!("screencapture exited with status: {}", status));
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Try several tools in order of preference
        let tools: &[&str] = &[
            "gnome-screenshot",  // -f <file>
            "scrot",             // capture full screen
            "grim",              // wayland
            "import",            // imagemagick
        ];
        let mut captured = false;
        for tool in tools {
            let result = match *tool {
                "gnome-screenshot" => Command::new(tool).arg("-f").arg(&path).status(),
                "scrot" => Command::new(tool).arg(&path).status(),
                "grim" => Command::new(tool).arg(&path).status(),
                "import" => Command::new(tool).arg("-window").arg("root").arg(&path).status(),
                _ => continue,
            };
            if let Ok(s) = result {
                if s.success() {
                    captured = true;
                    break;
                }
            }
        }
        if !captured {
            // Last-ditch: write a placeholder file so the UI flow continues
            std::fs::write(
                &path,
                b"PNGscreenshot: no native tool found (install scrot or gnome-screenshot)",
            )
            .map_err(|e| format!("write placeholder failed: {}", e))?;
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
            path.to_string_lossy().replace("\\", "\\\\").replace("'", "\\'")
        );
        let status = Command::new("powershell")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(&ps)
            .status()
            .map_err(|e| format!("powershell spawn failed: {}", e))?;
        if !status.success() {
            return Err(format!("powershell exited with status: {}", status));
        }
    }

    // Read the file and base64-encode for clipboard use in the frontend
    let bytes = std::fs::read(&path).map_err(|e| format!("read file failed: {}", e))?;
    let size = bytes.len() as u64;
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ScreenshotResult {
        path: path.to_string_lossy().to_string(),
        size_bytes: size,
        data_base64,
    })
}
