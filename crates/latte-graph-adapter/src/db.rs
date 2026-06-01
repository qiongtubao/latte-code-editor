use crate::error::AdapterError;
use rusqlite::Connection;
use std::fmt;

/// Schema version we know how to read.
/// Matches the row inserted by `packages/core/src/persistence/schema.sql`
/// in `@latte-graph/core`: `INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '1');`
/// Increment this when adding a migration that requires Rust-side handling.
pub const SCHEMA_VERSION: &str = "1";

pub struct GraphDb { conn: Connection }

impl fmt::Debug for GraphDb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GraphDb").finish()
    }
}

impl GraphDb {
    /// Opens a graph.db produced by `@latte-graph/core` and verifies its schema version.
    pub fn open(path: &std::path::Path) -> Result<Self, AdapterError> {
        let conn = Connection::open(path)?;
        let actual: String = conn.query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [], |r| r.get(0),
        )?;
        if actual != SCHEMA_VERSION {
            return Err(AdapterError::SchemaVersion { db: actual, expected: SCHEMA_VERSION.into() });
        }
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &Connection { &self.conn }
}
