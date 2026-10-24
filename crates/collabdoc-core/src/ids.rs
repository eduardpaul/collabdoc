//! Identifier formats from `src/shared/ids.ts`.

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS random source is unavailable");
    bytes
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `b_` + 10 hex characters, like `newBlockId()`.
pub fn new_block_id() -> String {
    format!("b_{}", hex(&random_bytes::<5>()))
}

/// A random (v4) UUID, like `crypto.randomUUID()`.
pub fn new_doc_id() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// A participant id for this install. The TS app uses a UUID too.
pub fn new_actor_id() -> String {
    new_doc_id()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_match_the_typescript_ids() {
        let block = new_block_id();
        assert_eq!(block.len(), 12);
        assert!(block.starts_with("b_"));
        let doc = new_doc_id();
        assert_eq!(doc.len(), 36);
        assert_eq!(&doc[14..15], "4");
        assert_ne!(new_block_id(), new_block_id());
    }
}
