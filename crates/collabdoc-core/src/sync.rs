//! In-process sync: one authoritative doc that participants push to and pull
//! from, the way the TS `SyncHub` sits between the renderer and agents. Over a
//! network the same update bytes travel through the peer transport instead.

use loro::awareness::EphemeralStore;
use loro::{ExportMode, LoroDoc};

use crate::document::{DocError, Document, configure};
use crate::presence::PRESENCE_TIMEOUT_MS;

pub struct Hub {
    doc: LoroDoc,
    /// Everyone's presence entries, relayed like document updates.
    presence: EphemeralStore,
}

impl Hub {
    /// Seeds the hub with everything `document` has.
    pub fn new(document: &Document) -> Self {
        let doc = LoroDoc::new();
        configure(&doc);
        doc.import(&document.export_since(&Default::default()))
            .expect("seed hub");
        Self {
            doc,
            presence: EphemeralStore::new(PRESENCE_TIMEOUT_MS),
        }
    }

    /// The authoritative document: what is saved and journaled.
    pub fn loro(&self) -> &LoroDoc {
        &self.doc
    }

    /// Sends what `document` has that the hub does not.
    pub fn push(&self, document: &Document) -> Result<(), DocError> {
        let bytes = document.export_since(&self.doc.oplog_vv());
        if !bytes.is_empty() {
            self.doc
                .import(&bytes)
                .map_err(|e| DocError::Loro(e.to_string()))?;
        }
        Ok(())
    }

    /// Brings `document` up to date. Returns whether it changed.
    pub fn pull(&self, document: &mut Document) -> Result<bool, DocError> {
        let bytes = self
            .doc
            .export(ExportMode::updates(&document.version()))
            .expect("export");
        document.import(&bytes)
    }

    /// Takes a participant's presence update.
    pub fn push_presence(&self, bytes: &[u8]) -> Result<(), DocError> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.presence
            .apply(bytes)
            .map_err(|e| DocError::Loro(e.to_string()))
    }

    /// Everyone's current presence, for a participant to apply.
    pub fn presence(&self) -> Vec<u8> {
        self.presence.encode_all()
    }
}
