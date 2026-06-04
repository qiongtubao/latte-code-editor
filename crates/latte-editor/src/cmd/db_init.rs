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
    // Run DDL every time, with IF NOT EXISTS. On a fresh DB this creates
    // everything from scratch. On an existing DB this migrates forward by
    // adding any tables/indexes that the previous version of ensure_db
    // didn't know about. The INSERT OR IGNORE on schema_version keeps us
    // from clobbering a future real version number.
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("open graph.db: {e}"))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS nodes (
            id    TEXT PRIMARY KEY,
            name  TEXT NOT NULL,
            file  TEXT,
            line  INTEGER,
            col   INTEGER,
            kind  TEXT
        )",
        [],
    )
    .map_err(|e| format!("create nodes table: {e}"))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS edges (
            from_node TEXT NOT NULL,
            to_node   TEXT NOT NULL,
            kind      TEXT
        )",
        [],
    )
    .map_err(|e| format!("create edges table: {e}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)",
        [],
    )
    .map_err(|e| format!("create idx_nodes_name: {e}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node)",
        [],
    )
    .map_err(|e| format!("create idx_edges_from: {e}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node)",
        [],
    )
    .map_err(|e| format!("create idx_edges_to: {e}"))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )
    .map_err(|e| format!("create metadata table: {e}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO metadata VALUES ('schema_version', ?1)",
        ["1"],
    )
    .map_err(|e| format!("insert schema_version: {e}"))?;
    // `conn` drops here, which commits and releases the file lock.
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

        // The graph data tables must also exist and be empty: the CLI
        // build is a stub, so the real index never populates them, but
        // the symbol queries in `latte-graph-adapter` need them to be
        // present (otherwise `definition`/`references`/`neighbors`
        // error with "no such table: nodes" on a fresh workspace).
        let nodes_count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get(0))
            .expect("nodes table should exist");
        assert_eq!(nodes_count, 0);

        let edges_count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .expect("edges table should exist");
        assert_eq!(edges_count, 0);
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

    /// U5: an empty graph (CLI build is still a stub) must support a
    /// `definition` query without erroring. `ensure_db` is responsible
    /// for creating the `nodes` table up front, so the query returns
    /// `Ok(None)` instead of `Err("no such table: nodes")`.
    #[test]
    fn ensure_db_supports_definition_query_on_empty_graph() {
        let dir = tempdir().unwrap();
        let db = ensure_db(dir.path()).expect("ensure_db should succeed");

        let result = latte_graph_adapter::definition(&db, "anything");
        assert!(
            result.is_ok(),
            "definition query should succeed on an empty graph; got: {result:?}"
        );
        assert!(
            matches!(result.unwrap(), None),
            "definition should be None for an unknown symbol on an empty graph"
        );
    }

    /// U6: same contract for `references`. The query joins `nodes` and
    /// `edges`, so both tables must exist. On an empty graph the
    /// result is `Ok(vec![])`, not an error.
    #[test]
    fn ensure_db_supports_references_query_on_empty_graph() {
        let dir = tempdir().unwrap();
        let db = ensure_db(dir.path()).expect("ensure_db should succeed");

        let result = latte_graph_adapter::references(&db, "anything", 100);
        assert!(
            result.is_ok(),
            "references query should succeed on an empty graph; got: {result:?}"
        );
        assert!(result.unwrap().is_empty());
    }

    /// U7: a graph.db that was created by an OLDER version of `ensure_db`
    /// (which only created the `metadata` table) must be migrated forward
    /// on the next call. Otherwise the user sees `no such table: edges`
    /// until they manually `rm .latte/graph.db`. We migrate by running the
    /// DDL with `IF NOT EXISTS` on every call, so missing tables/indexes
    /// get added without touching data that already exists.
    #[test]
    fn ensure_db_migrates_existing_graph_db_with_old_schema() {
        let dir = tempdir().unwrap();
        let latte_dir = dir.path().join(".latte");
        fs::create_dir_all(&latte_dir).unwrap();
        let db_path = latte_dir.join("graph.db");

        // Simulate an old `ensure_db`: only the `metadata` table exists.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO metadata VALUES ('schema_version', '1')",
                [],
            )
            .unwrap();
        }

        // Now run the new `ensure_db`. It should add `nodes` and `edges`
        // (and the indexes) without touching the existing `metadata` row.
        let db = ensure_db(dir.path()).expect("ensure_db should succeed");

        // The new tables must exist and be empty.
        let nodes_count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get(0))
            .expect("nodes table should exist after migration");
        assert_eq!(nodes_count, 0);

        let edges_count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .expect("edges table should exist after migration");
        assert_eq!(edges_count, 0);

        // The pre-existing schema_version row must NOT have been clobbered.
        // (INSERT OR IGNORE preserves it; a naive INSERT would still work for
        // version='1', but the contract we're locking in is "don't touch
        // existing metadata".)
        let version: String = db
            .conn()
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .expect("schema_version should still be present");
        assert_eq!(version, "1");

        // And the same query the Drawer uses must succeed.
        let refs = latte_graph_adapter::references(&db, "anything", 100)
            .expect("references query should succeed on migrated DB");
        assert!(refs.is_empty());
    }
}
