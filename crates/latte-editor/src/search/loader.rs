//! Runtime loader for the `vss0` SQLite extension used by `EmbeddingStore`.
//!
//! `sqlite-vss` ships its C extension as a separately-distributed shared
//! library (`.dylib` / `.so`) that is NOT bundled by `rusqlite`'s
//! `bundled` feature. To use `CREATE VIRTUAL TABLE ... USING vss0(...)`
//! we must `load_extension` it into the connection at runtime, after
//! enabling the extension-loading switch.
//!
//! `ensure_vss0_loaded` probes a small set of OS-specific candidate paths
//! and returns the first one that loads cleanly. If none of them resolves
//! we return an error message that points the user at `pip install
//! sqlite-vss` (which ships prebuilts for macOS x86_64 / aarch64 and
//! Linux x86_64) — that is the lowest-friction way to get a working
//! `vss0` on a developer machine today.
//!
//! Probed locations, in order:
//!
//! 1. `"vss0"` — let `dlopen` resolve the bare name from the loader path
//!    (`LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` / system locations).
//! 2. `"./libvss0.dylib"` and `"./vss0.dylib"` (macOS, working dir).
//! 3. `"./libvss0.so"` and `"./vss0.so"` (Linux, working dir).
//! 4. `"libsqlite_vector0"` — Debian/Ubuntu package `libsqlite-vector0`
//!    installs the dso under this name.
//!
//! T22 calls this from `EmbeddingStore::open` so any code path that
//! opens the store (T22 itself, future indexer, tests) gets vss0 for
//! free. The loader is intentionally best-effort: a failed probe is
//! bubbled up as a `String` error with a remediation hint, never a
//! panic.
//!
//! Implementation note: we deliberately go through the SQL function
//! `SELECT load_extension('...')` rather than
//! `Connection::load_extension(...)`. The latter is gated behind a
//! `load_extension` cargo feature in `rusqlite` 0.31, which the
//! workspace does not currently enable. The SQL function path only
//! needs `PRAGMA enable_load_extension = true`, which works on the
//! bundled SQLite we ship with `rusqlite`'s `bundled` feature.

use rusqlite::Connection;

/// Attempt to load `vss0` into `conn`. Idempotent — calling it twice
/// on the same connection is harmless (the second call will either
/// succeed again or fail with `already loaded`).
pub fn ensure_vss0_loaded(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA enable_load_extension = true")
        .map_err(|e| format!("enable_load_extension failed: {e}"))?;

    let candidates: &[&str] = &[
        "vss0",
        "./libvss0.dylib",
        "./vss0.dylib",
        "./libvss0.so",
        "./vss0.so",
        "libsqlite_vector0",
        // Windows: project scope is macOS/Linux. If a Windows contributor
        // adds `vss0.dll` here, the FFI is the same — only the candidate
        // name differs.
    ];

    let mut last_err: Option<String> = None;
    for cand in candidates {
        // Skip FS-only candidates that definitely don't exist on disk.
        // The bare names (`vss0`, `libsqlite_vector0`) are kept on the
        // list even though `Path::new(name).exists()` returns false for
        // them: `dlopen` can still resolve them via the loader path.
        if is_path_only(cand) && !std::path::Path::new(cand).exists() {
            continue;
        }
        // Call `load_extension(?)` as a SQL function with a bound param
        // instead of string interpolation. We don't care about the
        // return value (it's the entry point's return code), only the
        // absence of an error.
        let mut stmt = conn
            .prepare("SELECT load_extension(?)")
            .map_err(|e| format!("{cand}: prepare failed: {e}"))?;
        match stmt.query(rusqlite::params![cand]).map(|_| ()) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(format!("{cand}: {e}")),
        }
    }

    Err(format!(
        "vss0 extension not loadable (last error: {}). \
         Install it via `pip install sqlite-vss` (prebuilts for macOS \
         x86_64/aarch64 and Linux x86_64) or place `libvss0.dylib` / \
         `libvss0.so` on the loader path or next to the binary.",
        last_err.as_deref().unwrap_or("no candidate found")
    ))
}

/// `dlopen("vss0", ...)` will succeed if any loader-path directory
/// contains the file, but `Path::new("vss0").exists()` returns false
/// in that case. We can't introspect the loader path portably, so we
/// skip the FS-existence check for the bare names that may be
/// resolver-only.
///
/// Returns `true` for candidates that are explicit paths (start with
/// `./`) and should be checked with `Path::exists()` first. Returns
/// `false` for bare names that we just hand to `load_extension` and
/// let `dlopen` resolve.
fn is_path_only(cand: &str) -> bool {
    cand.starts_with("./")
}

#[cfg(test)]
mod tests {
    use super::is_path_only;

    #[test]
    fn is_path_only_flags_bare_names() {
        assert!(!is_path_only("vss0"));
        assert!(!is_path_only("libsqlite_vector0"));
        assert!(is_path_only("./vss0.dylib"));
        assert!(is_path_only("./libvss0.so"));
    }
}
