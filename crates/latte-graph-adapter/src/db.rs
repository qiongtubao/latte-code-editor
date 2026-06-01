use crate::error::AdapterError;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fmt;

pub const SCHEMA_HASH: &str = "REPLACE_WITH_HASH_FROM_BUILD_STEP";

pub struct GraphDb { conn: Connection }

impl fmt::Debug for GraphDb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GraphDb").finish()
    }
}

impl GraphDb {
    pub fn open(path: &std::path::Path) -> Result<Self, AdapterError> {
        let conn = Connection::open(path)?;
        let actual: String = conn.query_row(
            "SELECT value FROM meta WHERE key = 'schema_hash'",
            [], |r| r.get(0),
        )?;
        if actual != SCHEMA_HASH {
            return Err(AdapterError::SchemaHash { db: actual, expected: SCHEMA_HASH.into() });
        }
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &Connection { &self.conn }

    pub fn hash_schema(sql: &str) -> String {
        let mut h = Sha256::new();
        h.update(sql.as_bytes());
        hex::encode(h.finalize())
    }
}
