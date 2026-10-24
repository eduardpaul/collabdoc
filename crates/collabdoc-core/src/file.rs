//! The on-disk `.collabdoc` container, byte-compatible with `src/core/collabdoc-file.ts`.
//!
//! ```text
//! magic (8) | header length u32 LE | header JSON | snapshot | assets
//! ```

use serde::{Deserialize, Serialize};

use crate::schema::SCHEMA_VERSION;

pub const COLLABDOC_MAGIC: &[u8; 8] = b"CLBDOC01";
const MAGIC_PREFIX: &[u8] = b"CLBDOC";
const HEADER_OFFSET: usize = 12;
pub const COLLABDOC_APP: &str = "collabdoc-rs/0.1.0";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMeta {
    pub hash: String,
    #[serde(rename = "type")]
    pub mime: String,
    pub size: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub doc_id: String,
    pub title: String,
    pub schema_version: i64,
    pub saved_at: i64,
    pub app: String,
    pub snapshot_bytes: usize,
    pub assets: Vec<AssetMeta>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    pub hash: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Decoded {
    pub header: Header,
    pub snapshot: Vec<u8>,
    pub assets: Vec<Asset>,
    /// Hashes listed in the header whose bytes are missing (truncated file).
    pub missing: Vec<String>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum FileError {
    #[error("This is not a CollabDoc file.")]
    Magic,
    #[error("This document uses schema version {0}, which this version of CollabDoc cannot open.")]
    Schema(i64),
    #[error("This CollabDoc file is truncated or damaged.")]
    Truncated,
    #[error("This CollabDoc file has a damaged header.")]
    Header,
}

pub fn encode(
    doc_id: &str,
    title: &str,
    saved_at: i64,
    snapshot: &[u8],
    assets: &[Asset],
) -> Vec<u8> {
    let mut packed = Vec::new();
    let mut meta = Vec::with_capacity(assets.len());
    for asset in assets {
        meta.push(AssetMeta {
            hash: asset.hash.clone(),
            mime: asset.mime.clone(),
            size: asset.bytes.len(),
            offset: packed.len(),
        });
        packed.extend_from_slice(&asset.bytes);
    }
    let header = Header {
        doc_id: doc_id.to_owned(),
        title: title.to_owned(),
        schema_version: SCHEMA_VERSION,
        saved_at,
        app: COLLABDOC_APP.to_owned(),
        snapshot_bytes: snapshot.len(),
        assets: meta,
    };
    let header_json = serde_json::to_vec(&header).expect("header serialises");
    let mut out =
        Vec::with_capacity(HEADER_OFFSET + header_json.len() + snapshot.len() + packed.len());
    out.extend_from_slice(COLLABDOC_MAGIC);
    out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_json);
    out.extend_from_slice(snapshot);
    out.extend_from_slice(&packed);
    out
}

/// The header alone (recents and the start screen read only this).
pub fn read_header(bytes: &[u8]) -> Result<Header, FileError> {
    if bytes.len() < HEADER_OFFSET || !bytes.starts_with(MAGIC_PREFIX) {
        return Err(FileError::Magic);
    }
    let len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let end = HEADER_OFFSET.checked_add(len).ok_or(FileError::Truncated)?;
    if end > bytes.len() {
        return Err(FileError::Truncated);
    }
    serde_json::from_slice(&bytes[HEADER_OFFSET..end]).map_err(|_| FileError::Header)
}

pub fn decode(bytes: &[u8]) -> Result<Decoded, FileError> {
    let header = read_header(bytes)?;
    if header.schema_version > SCHEMA_VERSION {
        return Err(FileError::Schema(header.schema_version));
    }
    let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let snap_at = HEADER_OFFSET + header_len;
    let snap_end = snap_at
        .checked_add(header.snapshot_bytes)
        .filter(|end| *end <= bytes.len())
        .ok_or(FileError::Truncated)?;
    let mut assets = Vec::new();
    let mut missing = Vec::new();
    for meta in &header.assets {
        let start = snap_end.checked_add(meta.offset);
        let end = start.and_then(|s| s.checked_add(meta.size));
        match (start, end) {
            (Some(start), Some(end)) if end <= bytes.len() => assets.push(Asset {
                hash: meta.hash.clone(),
                mime: meta.mime.clone(),
                bytes: bytes[start..end].to_vec(),
            }),
            _ => missing.push(meta.hash.clone()),
        }
    }
    Ok(Decoded {
        snapshot: bytes[snap_at..snap_end].to_vec(),
        header,
        assets,
        missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_header_snapshot_and_assets() {
        let asset = Asset {
            hash: "ab".repeat(32),
            mime: "image/png".into(),
            bytes: vec![1, 2, 3],
        };
        let bytes = encode("d1", "Title", 42, &[9, 9], std::slice::from_ref(&asset));
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.header.doc_id, "d1");
        assert_eq!(decoded.header.saved_at, 42);
        assert_eq!(decoded.snapshot, vec![9, 9]);
        assert_eq!(decoded.assets, vec![asset]);
        assert!(decoded.missing.is_empty());
    }

    #[test]
    fn header_json_uses_the_typescript_field_names() {
        let bytes = encode("d1", "T", 1, &[], &[]);
        let len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let json: serde_json::Value = serde_json::from_slice(&bytes[12..12 + len]).unwrap();
        for key in [
            "docId",
            "title",
            "schemaVersion",
            "savedAt",
            "app",
            "snapshotBytes",
            "assets",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn rejects_bad_magic_newer_schema_and_truncation() {
        assert_eq!(decode(b"not a collabdoc").unwrap_err(), FileError::Magic);
        let mut bytes = encode("d", "t", 1, &[1, 2, 3], &[]);
        bytes.truncate(bytes.len() - 1);
        assert_eq!(decode(&bytes).unwrap_err(), FileError::Truncated);

        let header = br#"{"docId":"d","title":"t","schemaVersion":99,"savedAt":0,"app":"x","snapshotBytes":0,"assets":[]}"#;
        let mut newer = COLLABDOC_MAGIC.to_vec();
        newer.extend_from_slice(&(header.len() as u32).to_le_bytes());
        newer.extend_from_slice(header);
        assert_eq!(decode(&newer).unwrap_err(), FileError::Schema(99));
    }

    #[test]
    fn missing_asset_bytes_are_reported_not_fatal() {
        let asset = Asset {
            hash: "h".into(),
            mime: "image/png".into(),
            bytes: vec![0; 10],
        };
        let mut bytes = encode("d", "t", 1, &[], &[asset]);
        bytes.truncate(bytes.len() - 5);
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.missing, vec!["h".to_string()]);
    }
}
