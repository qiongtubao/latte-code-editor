//! tracing-subscriber setup that writes JSON-line logs to a rotating file.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOG_GUARD: Mutex<Option<WorkerGuard>> = Mutex::new(None);

pub fn log_dir() -> Option<&'static PathBuf> {
    LOG_DIR.get()
}

/// Initialise tracing. Returns true if file logging was enabled.
///
/// The worker guard is parked in a process-wide `Mutex<Option<WorkerGuard>>`,
/// not leaked. The guard's drop runs on process exit; the lock itself is
/// `static`, so its memory is never freed (deliberate global), but no heap
/// allocation leaks.
pub fn init(app_data_dir: PathBuf) -> bool {
    let env_on = matches!(
        std::env::var("LATTE_DEBUG").as_deref(),
        Ok("1") | Ok("true")
    );
    if !env_on {
        let _ = tracing_subscriber::registry()
            .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
            .with(fmt::layer().with_target(true))
            .try_init();
        return false;
    }
    let dir = app_data_dir.join("debug");
    let _ = std::fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir.clone());
    let file_appender = tracing_appender::rolling::daily(&dir, "latte-debug.log");
    let (nb, guard) = tracing_appender::non_blocking(file_appender);
    {
        let mut slot = LOG_GUARD.lock().expect("LOG_GUARD poisoned");
        *slot = Some(guard);
    }

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,latte=debug"));
    let layer = fmt::layer()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .with_writer(nb);
    let _ = tracing_subscriber::registry()
        .with(env_filter)
        .with(layer)
        .try_init();

    // Schedule a periodic purge on a background thread. Falls back to env
    // defaults if the corresponding env vars are absent.
    let max_age_secs = std::env::var("LATTE_DEBUG_MAX_AGE_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7)
        * 86_400;
    let max_bytes_mb = std::env::var("LATTE_DEBUG_MAX_DIR_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    spawn_periodic_purge(6, max_age_secs, max_bytes_mb);
    true
}

/// Force a purge of the debug log directory using the current env thresholds.
pub fn purge_now(max_age_secs: u64, max_bytes_mb: u64) {
    if let Some(dir) = log_dir() {
        let _ = crate::debug::storage::purge_old_logs(
            dir.as_path(),
            max_age_secs,
            max_bytes_mb,
            50,
        );
    }
}

/// Periodically purge on a background thread.
pub fn spawn_periodic_purge(interval_hours: u64, max_age_secs: u64, max_bytes_mb: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(interval_hours.saturating_mul(3600)));
        purge_now(max_age_secs, max_bytes_mb);
    });
}

/// Look up the active log directory, falling back to the temp dir if uninitialised.
/// Intended for the `debug_purge_now` Tauri command, which may be called before
/// the setup closure has run.
pub fn log_dir_or_fallback() -> PathBuf {
    log_dir().cloned().unwrap_or_else(|| {
        std::env::temp_dir().join("latte-debug-fallback")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn log_dir_accessor_does_not_panic() {
        // Read-only smoke: just call the accessor.
        let _ = log_dir();
    }

    #[test]
    fn json_line_format() {
        let dir = std::env::temp_dir().join(format!(
            "latte-log-fmt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("latte-debug.log");
        let file = std::fs::File::create(&path).unwrap();
        let (nb, _g) = tracing_appender::non_blocking(file);
        let subscriber = tracing_subscriber::registry()
            .with(EnvFilter::new("info"))
            .with(fmt::layer().json().with_writer(nb));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(event = "lsp.start", ctx = "{}", "hello");
        });
        // non_blocking writer is async; wait briefly.
        std::thread::sleep(std::time::Duration::from_millis(200));
        let mut s = String::new();
        std::fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        let first = s.lines().next().expect("at least one line");
        let v: serde_json::Value = serde_json::from_str(first).expect("must be valid JSON");
        // tracing's JSON layer nests custom fields under "fields"; accept either.
        let event = v
            .get("event")
            .or_else(|| v.get("fields").and_then(|f| f.get("event")))
            .expect("expected event field");
        assert_eq!(event, "lsp.start", "unexpected event: {first}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
