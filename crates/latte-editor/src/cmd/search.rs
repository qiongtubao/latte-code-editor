//! T22: combined semantic + ripgrep search via RRF.
//!
//! The plan file's reference command has several bugs that we deviate
//! from inline. The deviations are listed in the spec for T22; the
//! short version:
//!
//!   B2/B4 — embedder and store are cached in `AppState::semantic`
//!           behind one mutex; first call builds, subsequent reuse.
//!   B3     — workspace mutex is locked once and the path is cloned
//!           out before any other work happens.
//!   B5     — `rg --json -l` is a flag conflict; we drop `-l` so we
//!           actually get the per-match JSON the parser wants.
//!   B6     — `DefaultHasher` is per-process; we use an inline FNV-1a
//!           hash instead so the same path produces the same rowid
//!           across restarts. No new dep pulled in.
//!   B7     — we hydrate via the cached `EmbeddingStore` connection
//!           (the `Mutex<Connection>` inside it) instead of opening
//!           a second `rusqlite::Connection` to the same file.

use crate::search::{rrf_fuse, EmbeddingStore};
use crate::state::{AppState, SemanticCache};
use tauri::State;

#[derive(serde::Serialize)]
pub struct SemanticHit {
    pub name: String,
    pub file: String,
    pub line: u32,
    pub score: f32,
}

#[tauri::command]
pub async fn cmd_semantic_search(
    state: State<'_, AppState>,
    query: String,
    k: Option<usize>,
) -> Result<Vec<SemanticHit>, String> {
    let k = k.unwrap_or(20);

    // DEVIATION B3: lock the workspace mutex once, clone out, drop. The
    // plan locks it twice (once for the store path, once for the rg
    // workspace arg), which is a footgun if anything else ever needs
    // the workspace.
    let workspace = state
        .workspace
        .lock()
        .unwrap()
        .clone()
        .ok_or("workspace not open")?;

    // DEVIATION B2+B4: lazily build (or reuse) the embedder + store.
    // The first call pays the ~seconds-long init cost; subsequent calls
    // are fast. The cache is keyed on the AppState instance, so the
    // lifetime is tied to the app process — fine for a single-workspace
    // desktop editor. We hold the lock across init only (not across the
    // slow `embed` call that follows), so a second concurrent caller
    // will see the populated cache when it acquires the lock.
    {
        let mut guard = state.semantic.lock().unwrap();
        if guard.is_none() {
            let embedder = crate::search::build_embedder()?;
            let store_path = workspace.join(".latte/embeddings.db");
            // EmbeddingStore::open already loads vss0 (see B1 deviation
            // in search/store.rs). If vss0 isn't installed this will
            // surface a clear "install via pip install sqlite-vss" error.
            let store = EmbeddingStore::open(&store_path, embedder.dim())?;
            *guard = Some(SemanticCache { embedder, store });
        }
    }

    // Embed the query under a brief lock on the embedder (Embedder::embed
    // takes &mut self per fastembed 5.x).
    let q_vec: Vec<f32> = {
        let mut guard = state.semantic.lock().unwrap();
        let cache = guard.as_mut().ok_or("semantic cache vanished")?;
        let mut emb = cache.embedder.embed(&[&query])?;
        emb.pop().ok_or("embedder returned no vectors")?
    };

    // Vector search via the cached store.
    let vec_hits = {
        let guard = state.semantic.lock().unwrap();
        let cache = guard.as_ref().ok_or("semantic cache vanished")?;
        cache.store.search(&q_vec, k)?
    };
    let vec_ids: Vec<u64> = vec_hits.iter().map(|(id, _)| *id as u64).collect();

    // ripgrep text search (best-effort, empty if rg is missing).
    let text_ids = rg_search(&workspace, &query, k)?;
    let fused = rrf_fuse(&[vec_ids, text_ids], 60.0);

    // DEVIATION B7: hydrate via the cached connection, not a fresh
    // `Connection::open` of the same file. Reopening would race with
    // any concurrent writer and waste a syscall.
    let guard = state.semantic.lock().unwrap();
    let cache = guard.as_ref().ok_or("semantic cache vanished")?;
    let conn = cache.store.conn();
    let mut out = Vec::new();
    for (id, score) in fused.into_iter().take(k) {
        let row: Result<(String, String, i64), _> = conn
            .query_row(
                "SELECT name, file, line FROM vec_meta WHERE rowid = ?1",
                [id as i64],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            );
        if let Ok((name, file, line)) = row {
            out.push(SemanticHit {
                name,
                file,
                line: line as u32,
                score,
            });
        }
    }
    Ok(out)
}

/// Best-effort ripgrep driver. Returns an empty vec if `rg` is missing
/// or fails to launch — the rest of the semantic path still works.
///
/// DEVIATION B5: drop `-l`. `-l` (files-with-matches) and `--json` are
/// incompatible: `-l` makes rg suppress per-match output, so the JSON
/// stream would only contain `summary` events and we would have nothing
/// to hash. With `-l` removed we get the full `{"type":"match", ...}`
/// stream the parser below expects.
fn rg_search(ws: &std::path::Path, q: &str, k: usize) -> Result<Vec<u64>, String> {
    use std::process::Command;
    let out = Command::new("rg")
        .args([
            "--json",
            "-m",
            &k.to_string(),
            q,
        ])
        .arg(ws)
        .output();
    let mut ids = Vec::new();
    if let Ok(o) = out {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v["type"] == "match" {
                    if let Some(path) = v["data"]["path"]["text"].as_str() {
                        ids.push(stable_hash(path));
                    }
                }
            }
        }
    }
    Ok(ids)
}

/// DEVIATION B6: stable across processes.
///
/// `std::collections::hash_map::DefaultHasher` is randomized per
/// process (it uses SipHash with random keys), so two runs of the
/// editor hashing the same path would get different `u64`s and RRF
/// would fuse nothing. We need the hash to be the same across runs.
///
/// Pulling in a new dep (siphasher, xxhash-rust, twox-hash) is out of
/// scope for T22 and would change the dep graph. FNV-1a is ~10 lines,
/// has good distribution for ASCII paths, and is stable across
/// processes and platforms. We only need 64 bits, and we only need
/// stability, not cryptographic strength.
fn stable_hash(s: &str) -> u64 {
    // FNV-1a 64-bit, as per http://www.isthe.com/chongo/tech/comp/fnv/
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut h = FNV_OFFSET;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::stable_hash;

    #[test]
    fn stable_hash_is_deterministic() {
        // Same input => same output, across "processes" (we just call
        // it twice; the FNV constants are baked into the binary).
        assert_eq!(stable_hash("src/foo.ts"), stable_hash("src/foo.ts"));
        assert_ne!(stable_hash("src/foo.ts"), stable_hash("src/bar.ts"));
    }

    #[test]
    fn stable_hash_handles_empty() {
        // FNV-1a of empty string is the offset basis.
        assert_eq!(stable_hash(""), 0xcbf29ce484222325);
    }
}
