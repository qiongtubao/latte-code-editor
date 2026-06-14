//! Doc generation: produce a stub .md file for a DocSuggestion.

use std::path::Path;

use crate::doc_gen::scan::DocSuggestion;

pub fn render_stub(sug: &DocSuggestion) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("type: {}\n", sug.doc_type));
    out.push_str(&format!("title: {}\n", sug.title));
    if !sug.sources.is_empty() {
        out.push_str("sources:\n");
        for s in &sug.sources {
            out.push_str(&format!("  - {s}\n"));
        }
    }
    out.push_str(&format!("reason: \"{}\"\n", sug.reason));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", sug.title));
    out.push_str(&format!("*{}* — {}\n\n", sug.doc_type, sug.reason));
    if !sug.sources.is_empty() {
        out.push_str("## Source files\n\n");
        for s in &sug.sources {
            out.push_str(&format!("- `{s}`\n"));
        }
        out.push_str("\n");
    }
    out.push_str("## Overview\n\n");
    out.push_str("TODO: AI will fill this in (or edit by hand).\n\n");
    out.push_str("## Key concepts\n\n");
    out.push_str("TODO.\n\n");
    out.push_str("## Related\n\n");
    out.push_str("<!-- link to other docs here -->\n");
    out
}

/// Write a stub to `<docs_root>/<rel_path>`. Returns the absolute path.
pub fn write_stub(docs_root: &Path, sug: &DocSuggestion) -> Result<String, String> {
    let target = docs_root.join(&sug.rel_path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(&target, render_stub(sug)).map_err(|e| format!("write: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn render_stub_includes_frontmatter_and_sources() {
        let sug = DocSuggestion {
            title: "String".into(),
            doc_type: "entity".into(),
            rel_path: "entities/string.md".into(),
            sources: vec!["src/t_string.c".into()],
            reason: "Redis data type".into(),
        };
        let out = render_stub(&sug);
        assert!(out.contains("type: entity"));
        assert!(out.contains("title: String"));
        assert!(out.contains("src/t_string.c"));
        assert!(out.contains("## Source files"));
    }

    #[test]
    fn write_stub_creates_file() {
        let dir = tempdir().unwrap();
        let sug = DocSuggestion {
            title: "Dict".into(),
            doc_type: "entity".into(),
            rel_path: "entities/dict.md".into(),
            sources: vec!["src/dict.c".into()],
            reason: "data structure".into(),
        };
        let path = write_stub(dir.path(), &sug).unwrap();
        assert!(std::path::Path::new(&path).exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("title: Dict"));
    }
}
