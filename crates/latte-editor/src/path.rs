use std::path::{Component, Path, PathBuf};

use latte_graph_adapter::AdapterError;

pub fn safe_path(root: &Path, raw: &str) -> Result<PathBuf, AdapterError> {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return Err(AdapterError::UnsafePath("absolute path rejected".into()));
    }
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AdapterError::UnsafePath("parent component rejected".into()));
    }
    let canon_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let cleaned = path_clean::clean(canon_root.join(candidate));
    if !cleaned.starts_with(&canon_root) {
        return Err(AdapterError::UnsafePath("escapes root".into()));
    }
    Ok(cleaned)
}

