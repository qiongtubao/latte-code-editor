use latte_graph_adapter::{AdapterError, GraphDb, SCHEMA_VERSION};
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn opens_db_with_matching_version() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("g.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO metadata VALUES ('schema_version', ?1)",
        [SCHEMA_VERSION],
    ).unwrap();
    drop(conn);
    GraphDb::open(&path).expect("should open");
}

#[test]
fn rejects_mismatched_version() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("g.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)", []).unwrap();
    conn.execute("INSERT INTO metadata VALUES ('schema_version', '999')", []).unwrap();
    drop(conn);
    let err = GraphDb::open(&path).unwrap_err();
    assert!(matches!(err, AdapterError::SchemaVersion { .. }));
}
