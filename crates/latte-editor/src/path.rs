use std::path::{Component, Path, PathBuf};

use latte_graph_adapter::AdapterError;

/// Validates that `raw` is a safe relative path under `root` and returns the
/// joined canonicalized path. Rejects:
///   - absolute paths
///   - `..` components
///   - any cleaned path that escapes the (canonicalized) root
///
/// Note: in-root symlinks (e.g. `<root>/escape -> /etc`) are NOT resolved;
/// the function trusts the root directory itself. Callers handling
/// untrusted-symlink scenarios should canonicalize the result themselves.
pub fn safe_path(root: &Path, raw: &str) -> Result<PathBuf, AdapterError> {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return Err(AdapterError::UnsafePath("absolute path rejected".into()));
    }
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AdapterError::UnsafePath("parent component rejected".into()));
    }
    // Fail closed: if we cannot canonicalize the root (missing, perms, etc.),
    // we cannot verify the boundary, so we reject.
    let canon_root = dunce::canonicalize(root).map_err(|e| {
        AdapterError::UnsafePath(format!("cannot canonicalize root: {e}"))
    })?;
    let cleaned = path_clean::clean(canon_root.join(candidate));
    if !cleaned.starts_with(&canon_root) {
        return Err(AdapterError::UnsafePath("escapes root".into()));
    }
    Ok(cleaned)
}
