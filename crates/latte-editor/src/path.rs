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

/// Resolve a workspace-relative path for *read-only* access. Unlike
/// `safe_path`, this does NOT enforce workspace containment — go-to from
/// the editor needs to land on `.d.ts` files in `node_modules` or
/// elsewhere outside the workspace. Writes still go through `safe_path`,
/// so this relaxation is one-way: read = loose, write = strict.
///
/// Rules:
///   - Rejects absolute paths (the renderer is supposed to pass a
///     workspace-relative path; an absolute path means the caller is wrong).
///   - Rejects any `..` component (defends against traversal even though
///     we no longer have a workspace to compare against).
///   - Canonicalises the result so symlinks are resolved (matching the
///     semantics of `safe_path`).
///   - Rejects directories — we only read files.
pub fn safe_read_path(rel: &str) -> Result<PathBuf, AdapterError> {
    if Path::new(rel).is_absolute() {
        return Err(AdapterError::UnsafePath("absolute path rejected".into()));
    }
    if Path::new(rel).components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AdapterError::UnsafePath("parent component rejected".into()));
    }
    let abs = dunce::canonicalize(rel)
        .map_err(|e| AdapterError::UnsafePath(format!("canonicalize failed: {e}")))?;
    let meta = std::fs::metadata(&abs)
        .map_err(|e| AdapterError::UnsafePath(format!("stat failed: {e}")))?;
    if meta.is_dir() {
        return Err(AdapterError::UnsafePath("not a file (path is a directory)".into()));
    }
    Ok(abs)
}

#[cfg(test)]
mod read_path_tests {
    use super::*;
    use std::fs;

    /// U1: a plain relative path that points at a real file is returned
    /// as its canonical absolute path. No workspace containment check.
    #[test]
    fn read_path_accepts_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("hello.txt");
        fs::write(&f, "x").unwrap();

        // The path is relative to the cwd; make cwd the tempdir so "hello.txt" resolves.
        let original = std::env::current_dir().unwrap();
        std::env::set_current_dir(&dir).unwrap();
        let result = safe_read_path("hello.txt");
        std::env::set_current_dir(original).unwrap();

        assert!(result.is_ok(), "got: {result:?}");
        let abs = result.unwrap();
        // Canonical comparison: tmpdir may be a symlink (e.g. /tmp → /private/tmp on macOS).
        assert_eq!(abs, fs::canonicalize(&f).unwrap());
    }

    /// U2: an absolute path is rejected — go-to from the editor is always
    /// given a workspace-relative path; absolute means the caller is wrong.
    #[test]
    fn read_path_rejects_absolute() {
        let result = safe_read_path("/etc/passwd");
        assert!(result.is_err(), "got: {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("absolute"),
            "error should mention 'absolute', got: {err}"
        );
    }

    /// U3: a `..` component is rejected. We never want go-to to escape
    /// via the renderer-supplied path.
    #[test]
    fn read_path_rejects_dotdot() {
        let result = safe_read_path("../escape.txt");
        assert!(result.is_err(), "got: {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("parent"),
            "error should mention 'parent', got: {err}"
        );
    }

    /// U4: a path that resolves to a directory (not a file) is rejected.
    /// We only read files; directories would just give an unhelpful error
    /// from `fs::read_to_string` deeper in the call.
    #[test]
    fn read_path_rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("subdir");
        fs::create_dir(&sub).unwrap();

        // The path is relative to the cwd, but the directory we created is
        // under the tempdir. Make cwd the tempdir so "subdir" resolves.
        let original = std::env::current_dir().unwrap();
        std::env::set_current_dir(&dir).unwrap();
        let result = safe_read_path("subdir");
        std::env::set_current_dir(original).unwrap();

        assert!(result.is_err(), "got: {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("directory") || err.to_string().contains("not a file"),
            "error should mention directory, got: {err}"
        );
    }
}
