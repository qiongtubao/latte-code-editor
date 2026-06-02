use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;

use crate::search::embedder::Embedder;

/// Persistent vector store for per-symbol embeddings, backed by SQLite +
/// the `sqlite-vss` extension.
///
/// # sqlite-vss extension loading
///
/// `sqlite-vss` is a C SQLite extension, NOT a pure-rust crate. The
/// `Connection::open` + `CREATE VIRTUAL TABLE ... USING vss0(...)` calls
/// below WILL fail at runtime unless the `vss0` module is pre-loaded into
/// the connection. The standard `rusqlite` `bundled` feature does NOT
/// include `vss0`. The T22 implementer (semantic search) is responsible for
/// one of:
///
/// 1. Calling `conn.load_extension("vss", None)` (after
///    `enable_load_extension(true)`) before this `open()` runs, with a
///    `vss0.dylib`/`vss0.so` discoverable in the loader path; or
/// 2. Building a custom SQLite (e.g. via `sqlite-vss`'s `build.rs` /
///    `sqlite3` amalgamation) that statically registers `vss0`; or
/// 3. Vendoring the compiled extension next to the binary and pointing
///    `load_extension` at the absolute path.
///
/// For T21 we only need the struct and methods to exist with the right
/// shape so the T22 code can wire it up. There is no integration test for
/// `EmbeddingStore` in this change because exercising it would require
/// pulling in a vss0 build setup that is out of scope.
pub struct EmbeddingStore {
    conn: Mutex<Connection>,
    dim: usize,
}

impl EmbeddingStore {
    pub fn open(path: &Path, dim: usize) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        // DEVIATION from T21: per the B1 fix, eagerly load vss0 here so any
        // caller (T22, future indexer, tests) cannot accidentally hit the
        // "vss0 not loaded" runtime error. The store.rs doc comment above
        // still documents the three delivery options for vss0.
        crate::search::loader::ensure_vss0_loaded(&conn)?;
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vss0(embedding)",
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vec_meta \
             (rowid INTEGER PRIMARY KEY, kind TEXT, name TEXT, file TEXT, line INTEGER, col INTEGER)",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            dim,
        })
    }

    pub fn upsert(
        &self,
        rowid: i64,
        embedding: &[f32],
        meta: (&str, &str, &str, u32, u32),
    ) -> Result<(), String> {
        if embedding.len() != self.dim {
            return Err(format!(
                "embedding length {} != store dim {}",
                embedding.len(),
                self.dim
            ));
        }
        let mut c = self.conn.lock();
        let bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO vec_embeddings(rowid, embedding) VALUES (?1, ?2)",
            rusqlite::params![rowid, bytes],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO vec_meta VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                rowid,
                meta.0,
                meta.1,
                meta.2,
                meta.3 as i64,
                meta.4 as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn search(&self, query_emb: &[f32], k: usize) -> Result<Vec<(i64, f32)>, String> {
        let c = self.conn.lock();
        let bytes: Vec<u8> = query_emb.iter().flat_map(|f| f.to_le_bytes()).collect();
        let k_i64: i64 = k
            .try_into()
            .map_err(|_| format!("k out of i64 range: {}", k))?;
        let mut stmt = c
            .prepare(
                "SELECT rowid, distance FROM vec_embeddings \
                 WHERE embedding MATCH ?1 ORDER BY distance LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![bytes, k_i64], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Borrow the underlying SQLite connection for ad-hoc reads
    /// (e.g. hydrating `vec_meta` rows after an RRF fuse). The caller
    /// MUST treat the returned `MutexGuard` as a short-lived borrow —
    /// holding it across an `upsert` or another `search` call on the
    /// same `EmbeddingStore` will deadlock.
    ///
    /// Added in T22 so the semantic-search command can hydrate hits
    /// from the cached store instead of opening a second `Connection`
    /// to the same file (see B7 deviation in `cmd/search.rs`).
    pub fn conn(&self) -> parking_lot::MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock()
    }
}

pub fn build_embedder() -> Result<Embedder, String> {
    Embedder::new()
}
