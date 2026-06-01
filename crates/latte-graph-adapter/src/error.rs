use thiserror::Error;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("schema hash mismatch: db has {db}, expected {expected}")]
    SchemaHash { db: String, expected: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}
