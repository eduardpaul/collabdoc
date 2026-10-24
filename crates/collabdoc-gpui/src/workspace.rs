//! The open document and the participants editing it in this process.
//!
//! Each window is its own participant (own Loro peer, own undo stack) synced
//! through one [`Hub`] — the same shape as the TS `SyncHub` with the renderer
//! and agents attached, and the seam a network transport plugs into later.

use std::path::{Path, PathBuf};

use collabdoc_core::sync::Hub;
use collabdoc_core::{DocError, Document};
use gpui::{Global, WeakEntity};

use crate::editor_view::EditorView;

pub struct Workspace {
    pub hub: Hub,
    pub editors: Vec<WeakEntity<EditorView>>,
    pub path: Option<PathBuf>,
    participants: usize,
}

impl Global for Workspace {}

impl Workspace {
    pub fn new(doc: &Document, path: Option<PathBuf>) -> Self {
        Self {
            hub: Hub::new(doc),
            editors: Vec::new(),
            path,
            participants: 0,
        }
    }

    /// A display name for the next window's participant.
    pub fn next_participant(&mut self) -> String {
        self.participants += 1;
        if self.participants == 1 {
            "You".to_owned()
        } else {
            format!("Peer {}", self.participants)
        }
    }

    pub fn live_editors(&self) -> usize {
        self.editors
            .iter()
            .filter(|e| e.upgrade().is_some())
            .count()
    }
}

pub fn open_file(path: &Path, actor: &str) -> Result<Document, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    Document::from_collabdoc(&bytes, actor).map_err(|e: DocError| e.to_string())
}

pub fn save_file(path: &Path, doc: &Document) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Write next to the target, then rename: a crash never leaves half a file.
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
