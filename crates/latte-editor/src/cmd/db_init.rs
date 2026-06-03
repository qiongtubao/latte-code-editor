use latte_graph_adapter::GraphDb;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

/// Ensure the workspace has a usable graph.db SQLite file under
/// `<ws>/.latte/graph.db` and return an open [`GraphDb`] handle.
///
/// Why this exists: `state.db` is `None` until *something* populates it.
/// The CLI `build` command is a stub that never writes a real `graph.db`,
/// so without this helper a freshly opened workspace has no graph index
/// and every `cmd_*` symbol query reports "workspace not open" (the
/// original, misleading error). The picker and the setup callback both
/// call this so the index is ready before the user can click a symbol.
///
/// We deliberately do NOT auto-spawn `cmd_build`: the CLI is a stub
/// that emits fake progress for two hardcoded files and would burn
/// cycles without producing a real index. `cmd_build` remains an
/// explicit user action that we will wire to a real implementation
/// later.
pub(crate) fn ensure_db(ws: &Path) -> Result<GraphDb, String> {
    let dir = ws.join(".latte");
    fs::create_dir_all(&dir).map_err(|e| format!("create .latte/: {e}"))?;
    let db_path = dir.join("graph.db");
    if !db_path.exists() {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("create graph.db: {e}"))?;
        conn.execute(
            "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .map_err(|e| format!("create metadata table: {e}"))?;
        conn.execute(
            "INSERT INTO metadata VALUES ('schema_version', ?1)",
            ["1"],
        )
        .map_err(|e| format!("insert schema_version: {e}"))?;
        // `conn` drops here, which commits and releases the file lock.
    }
    GraphDb::open(&db_path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::tempdir;

    /// U1: a fresh workspace has no `.latte/graph.db` yet. After calling
    /// `ensure_db`, the file must exist, contain the metadata table, and
    /// the returned `GraphDb` must be usable for a trivial query.
    #[test]
    fn ensure_db_creates_graph_db_on_fresh_workspace() {
        let dir = tempdir().unwrap();
        let db = ensure_db(dir.path()).expect("ensure_db should succeed");

        let db_path = dir.path().join(".latte").join("graph.db");
        assert!(
            db_path.exists(),
            "expected .latte/graph.db to exist at {}",
            db_path.display()
        );

        // The returned handle should be usable: a trivial SELECT proves
        // the connection is open and the metadata table is queryable.
        let version: String = db
            .conn()
            .query_row("SELECT value FROM metadata WHERE key = 'schema_version'", [], |r| {
                r.get(0)
            })
            .expect("schema_version row should be present");
        assert_eq!(version, "1");
    }

    /// U2: calling `ensure_db` twice on the same workspace must succeed
    /// both times. The first call creates the file, the second call must
    /// treat the existing file as already-initialized and just open it.
    /// No file lock contention: each `GraphDb` owns its own `Connection`,
    /// and the first handle is dropped at the end of the inner block.
    #[test]
    fn ensure_db_is_idempotent() {
        let dir = tempdir().unwrap();

        {
            let first = ensure_db(dir.path()).expect("first call should succeed");
            // Sanity: the first handle works.
            let _: i64 = first
                .conn()
                .query_row("SELECT 1", [], |r| r.get(0))
                .expect("first handle should answer SELECT 1");
            // Drop the first handle before opening a second one. This
            // mirrors how `apply_workspace` replaces the old `state.db`
            // slot.
        }

        let second = ensure_db(dir.path()).expect("second call should succeed");
        let one: i64 = second
            .conn()
            .query_row("SELECT 1", [], |r| r.get(0))
            .expect("second handle should answer SELECT 1");
        assert_eq!(one, 1);
    }

    /// U3: a workspace that already has a `.latte/` directory from some
    /// other feature (e.g. `search.rs` writes `embeddings.db` there)
    /// must not trip `ensure_db`. We pre-create the directory so the
    /// helper only needs to create the `graph.db` file inside it.
    #[test]
    fn ensure_db_works_when_latte_dir_already_exists() {
        let dir = tempdir().unwrap();
        let latte_dir = dir.path().join(".latte");
        std::fs::create_dir_all(&latte_dir).unwrap();
        // Drop a sibling file the way `search.rs` would have.
        std::fs::write(latte_dir.join("embeddings.db"), b"").unwrap();

        let db = ensure_db(dir.path()).expect("ensure_db should succeed");

        // The sibling file must be untouched.
        assert!(latte_dir.join("embeddings.db").exists());
        // And our new graph.db must be queryable.
        let version: String = db
            .conn()
            .query_row("SELECT value FROM metadata WHERE key = 'schema_version'", [], |r| {
                r.get(0)
            })
            .expect("schema_version row should be present");
        assert_eq!(version, "1");
    }

    /// The path returned by `ensure_db`'s output is independent of any
    /// other `Connection` we open by hand. Sanity check that the helper
    /// doesn't accidentally try to read the file via a long-lived
    /// connection it forgot to drop.
    #[test]
    fn ensure_db_does_not_leak_connections_across_calls() {
        let dir = tempdir().unwrap();
        let _ = ensure_db(dir.path()).unwrap();

        // Manually open a second `Connection` to the same file. If
        // `ensure_db` had leaked a handle that kept the file locked,
        // this would either block or fail on the SQLite lock.
        let conn = Connection::open(dir.path().join(".latte").join("graph.db"))
            .expect("manual open should not be blocked by leaked handle");
        let _: i64 = conn
            .query_row("SELECT 1", [], |r| r.get(0))
            .expect("manual connection should be usable");
    }
}
