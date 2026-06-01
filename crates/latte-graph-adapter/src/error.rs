use thiserror::Error;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("schema version mismatch: db has {db}, expected {expected}")]
    SchemaVersion { db: String, expected: String },
    #[error("unsafe path: {0}")]
    UnsafePath(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}
