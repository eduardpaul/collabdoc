//! In-process sync: one authoritative doc that participants push to and pull
//! from, the way the TS `SyncHub` sits between the renderer and agents. Over a
//! network the same update bytes travel through the peer transport instead.

use loro::{ExportMode, LoroDoc};

use crate::document::{DocError, Document, configure};

pub struct Hub {
    doc: LoroDoc,
}

impl Hub {
    /// Seeds the hub with everything `document` has.
    pub fn new(document: &Document) -> Self {
        let doc = LoroDoc::new();
        configure(&doc);
        doc.import(&document.export_since(&Default::default()))
            .expect("seed hub");
        Self { doc }
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
}
