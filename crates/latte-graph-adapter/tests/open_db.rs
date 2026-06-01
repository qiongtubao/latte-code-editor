use latte_graph_adapter::{GraphDb, SCHEMA_HASH};
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn opens_db_with_matching_hash() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("g.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO meta VALUES ('schema_hash', ?1)",
        [SCHEMA_HASH],
    ).unwrap();
    drop(conn);
    GraphDb::open(&path).expect("should open");
}

#[test]
fn rejects_mismatched_hash() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("g.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)", []).unwrap();
    conn.execute("INSERT INTO meta VALUES ('schema_hash', 'wrong')", []).unwrap();
    drop(conn);
    let err = GraphDb::open(&path).unwrap_err();
    matches!(err, AdapterError::SchemaHash { .. });
}

use latte_graph_adapter::AdapterError;
