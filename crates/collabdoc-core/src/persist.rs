//! Reading and writing `.collabdoc` files on disk (shared by every front end).

use std::path::{Path, PathBuf};

use crate::{DocError, Document};

pub fn open_file(path: &Path, actor: &str) -> Result<Document, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    Document::from_collabdoc(&bytes, actor).map_err(|e: DocError| e.to_string())
}

/// Writes next to the target, fsyncs, then renames: a crash never leaves
/// half a file ([`crate::store::atomic_write`]).
pub fn save_file(path: &Path, doc: &Document) -> Result<(), String> {
    crate::store::atomic_write(path, &doc.to_collabdoc()).map_err(|e| e.to_string())
}

/// `~/Documents/CollabDoc/<title>.collabdoc`, like `defaultCollabdocPath`.
pub fn default_path(title: &str) -> PathBuf {
    crate::store::default_collabdoc_path(&crate::store::default_documents_dir(), title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_atomically_and_reopens() {
        let dir = std::env::temp_dir().join(format!("collabdoc-persist-{}", std::process::id()));
        let path = dir.join("nested").join("a.collabdoc");
        let doc = Document::create("Saved", "me");
        save_file(&path, &doc).unwrap();
        assert!(!dir.join("nested").join("a.collabdoc.tmp").exists());
        assert_eq!(open_file(&path, "me").unwrap().title(), "Saved");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn default_path_is_a_safe_file_name() {
        let p = default_path("a/b: c");
        assert_eq!(p.file_name().unwrap(), "ab c.collabdoc");
        assert!(p.parent().unwrap().ends_with("Documents/CollabDoc"));
    }
}
