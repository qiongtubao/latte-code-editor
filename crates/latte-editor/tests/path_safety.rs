use latte_editor::path::safe_path;
use latte_graph_adapter::AdapterError;
use proptest::prelude::*;
use tempfile::tempdir;

#[test]
fn rejects_absolute() {
    let root = tempdir().unwrap();
    let err = safe_path(root.path(), "/etc/passwd").unwrap_err();
    assert!(matches!(err, AdapterError::UnsafePath(_)));
}

#[test]
fn rejects_parent_traversal() {
    let root = tempdir().unwrap();
    let err = safe_path(root.path(), "../escape").unwrap_err();
    assert!(matches!(err, AdapterError::UnsafePath(_)));
}

#[test]
fn accepts_relative_within_root() {
    let root = tempdir().unwrap();
    let canon_root = dunce::canonicalize(root.path()).unwrap();
    let p = safe_path(root.path(), "src/foo.ts").unwrap();
    assert!(p.starts_with(&canon_root));
}

proptest! {
    #[test]
    fn never_panics_on_any_input(s in ".*") {
        let root = tempdir().unwrap();
        let _ = safe_path(root.path(), &s);
    }
}
