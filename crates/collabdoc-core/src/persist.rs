//! Reading and writing `.collabdoc` files on disk (shared by every front end).

use std::path::{Path, PathBuf};

use crate::{DocError, Document};

pub fn open_file(path: &Path, actor: &str) -> Result<Document, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    Document::from_collabdoc(&bytes, actor).map_err(|e: DocError| e.to_string())
}

/// Writes next to the target, then renames: a crash never leaves half a file.
pub fn save_file(path: &Path, doc: &Document) -> Result<(), String> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("collabdoc.tmp");
    std::fs::write(&tmp, doc.to_collabdoc()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// `~/Documents/CollabDoc/<title>.collabdoc`, like `defaultCollabdocPath`.
pub fn default_path(title: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let name: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || " -_".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim();
    home.join("Documents").join("CollabDoc").join(format!(
        "{}.collabdoc",
        if name.is_empty() { "Untitled" } else { name }
    ))
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
        assert!(!path.with_extension("collabdoc.tmp").exists());
        assert_eq!(open_file(&path, "me").unwrap().title(), "Saved");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn default_path_is_a_safe_file_name() {
        let p = default_path("a/b: c");
        assert_eq!(p.file_name().unwrap(), "a-b- c.collabdoc");
        assert!(p.parent().unwrap().ends_with("Documents/CollabDoc"));
    }
}
