//! Application-level user settings.
//!
//! Persisted to `app_data_dir/settings.json`. Read on startup and on
//! every `get_graph_settings` invocation; written on every
//! `set_graph_settings` call.
//!
//! Only the auto-update graph settings live here for now. Other
//! settings (theme, keymap, …) will land in this same struct over
//! time so we keep one canonical file.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::fs;

const SETTINGS_FILE: &str = "settings.json";

/// Per-workspace graph auto-update knobs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphSettings {
    /// Master switch. When false, the file watcher still emits
    /// `file-changed:<ws_id>` events but the incremental hub will
    /// discard them.
    pub auto_update_enabled: bool,

    /// Wait at least this long after the most recent change before
    /// flushing a batch. Batches that arrive within the window are
    /// coalesced into a single update.
    pub debounce_ms: u64,

    /// Refuse to auto-update if a single batch contains more than
    /// this many distinct files. Above the threshold we drop the
    /// auto-update and tell the frontend the user should run a
    /// manual rebuild instead. Counts cost roughly 1-3ms per file
    /// to parse, so 200 is a sane ceiling on modest hardware.
    pub max_files_per_batch: usize,

    /// If the system reports less than this much available memory
    /// (in MB) at the moment a batch is ready, skip the auto-update
    /// and surface a "low memory" notice. The check is best-effort:
    /// unsupported platforms return `None` and we update as usual.
    pub low_memory_skip_mb: u64,
}

impl Default for GraphSettings {
    fn default() -> Self {
        Self {
            auto_update_enabled: true,
            debounce_ms: 1500,
            max_files_per_batch: 200,
            low_memory_skip_mb: 512,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AppSettings {
    #[serde(default)]
    pub graph: GraphSettings,
}

/// Loads + saves the settings file. The path is fixed at construction;
/// the struct is cheap to clone and contains no locks, so callers are
/// expected to wrap it in their own `Mutex`/`RwLock` if they want
/// concurrent access.
#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            path: app_data_dir.join(SETTINGS_FILE),
        }
    }

    /// Load the current settings. Missing or corrupt files yield the
    /// defaults so we never block startup on a bad config.
    pub async fn load(&self) -> AppSettings {
        match fs::read(&self.path).await {
            Ok(bytes) => match serde_json::from_slice::<AppSettings>(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "[settings] cannot parse {}: {e}; using defaults",
                        self.path.display()
                    );
                    AppSettings::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppSettings::default(),
            Err(e) => {
                eprintln!(
                    "[settings] cannot read {}: {e}; using defaults",
                    self.path.display()
                );
                AppSettings::default()
            }
        }
    }

    /// Atomic write: temp file + rename. Returns an error if the
    /// parent directory can't be created or the write itself fails.
    pub async fn save(&self, settings: &AppSettings) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("cannot create settings dir: {e}"))?;
        }
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|e| format!("cannot serialise settings: {e}"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &bytes)
            .await
            .map_err(|e| format!("cannot write settings tmp: {e}"))?;
        fs::rename(&tmp, &self.path)
            .await
            .map_err(|e| format!("cannot commit settings: {e}"))?;
        Ok(())
    }
}

/// Best-effort free memory probe. Returns `None` on platforms we
/// haven't implemented yet (or when the probe itself fails); callers
/// should treat `None` as "no opinion" and proceed.
///
/// Values are in megabytes.
pub fn available_memory_mb() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("MemAvailable:") {
                // "  123456 kB"
                let kb: u64 = rest
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse().ok())?;
                return Some(kb / 1024);
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        // vm_stat reports in pages; combine free + inactive as a
        // rough approximation of "available". Pages are 4 KB on
        // every macOS we support, but the page size can be read
        // from the line above the table if we want to be picky.
        use std::process::Command;
        let out = Command::new("vm_stat").output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        let mut pages: u64 = 0;
        for line in s.lines() {
            let line = line.trim_end_matches('.');
            if line.contains("Pages free")
                || line.contains("Pages inactive")
                || line.contains("Pages speculative")
            {
                if let Some(num) = line.split_whitespace().last() {
                    pages += num.parse::<u64>().unwrap_or(0);
                }
            }
        }
        Some(pages * 4 / 1024) // 4 KB pages → MB
    }
    #[cfg(target_os = "windows")]
    {
        // Skipped for now: the Win32 bindings are noisy and the
        // workspace's primary target is Linux/macOS. Returning None
        // means "no opinion" → the incremental hub will proceed.
        None
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Convenience: did we trip the low-memory gate? `None` means "no
/// probe available, proceed normally".
pub fn is_low_memory(settings: &GraphSettings) -> Option<bool> {
    available_memory_mb().map(|mb| mb < settings.low_memory_skip_mb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn load_returns_defaults_when_file_missing() {
        let dir = TempDir::new().unwrap();
        let s = SettingsStore::new(dir.path().to_path_buf());
        let got = s.load().await;
        assert_eq!(got, AppSettings::default());
    }

    #[tokio::test]
    async fn save_then_load_roundtrips() {
        let dir = TempDir::new().unwrap();
        let s = SettingsStore::new(dir.path().to_path_buf());
        let mut want = AppSettings::default();
        want.graph.auto_update_enabled = false;
        want.graph.debounce_ms = 3000;
        want.graph.max_files_per_batch = 50;
        want.graph.low_memory_skip_mb = 1024;
        s.save(&want).await.unwrap();
        let got = s.load().await;
        assert_eq!(got, want);
    }

    #[tokio::test]
    async fn load_returns_defaults_on_corrupt_file() {
        let dir = TempDir::new().unwrap();
        let s = SettingsStore::new(dir.path().to_path_buf());
        tokio::fs::write(s.path.clone(), b"not json")
            .await
            .unwrap();
        let got = s.load().await;
        assert_eq!(got, AppSettings::default());
    }

    #[test]
    fn defaults_are_sane() {
        let d = GraphSettings::default();
        assert!(d.auto_update_enabled);
        assert!(d.debounce_ms >= 100);
        assert!(d.max_files_per_batch > 0);
        assert!(d.low_memory_skip_mb > 0);
    }
}
