//! The open document and the participants editing it in this process.
//!
//! Each window is its own participant (own Loro peer, own undo stack) synced
//! through one [`Hub`] — the same shape as the TS `SyncHub` with the renderer
//! and agents attached, and the seam a network transport plugs into later.

use std::path::PathBuf;

use collabdoc_core::Document;
use collabdoc_core::sync::Hub;
use gpui::{Global, WeakEntity};

use crate::editor_view::EditorView;

pub use collabdoc_core::persist::{default_path, open_file, save_file};

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
