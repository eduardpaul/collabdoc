//! Prints a `.collabdoc` file's blocks: `cargo run -p collabdoc-core --example dump -- file.collabdoc`

use collabdoc_core::Document;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: dump <file.collabdoc>");
    let bytes = std::fs::read(&path).expect("readable file");
    let doc = Document::from_collabdoc(&bytes, "dump").expect("a CollabDoc file");
    println!("title: {}", doc.title());
    println!("docId: {}", doc.doc_id());
    for block in doc.blocks() {
        let list = block
            .list
            .map(|l| format!(" {l:?}@{}", block.list_depth))
            .unwrap_or_default();
        let mut extra = String::new();
        if !block.inlines.is_empty() {
            let nodes: Vec<String> = block
                .inlines
                .iter()
                .map(|n| {
                    format!(
                        "{}@{} {}",
                        n.name,
                        n.at,
                        serde_json::Value::Object(n.attrs.clone())
                    )
                })
                .collect();
            extra.push_str(&format!(" inlines={nodes:?}"));
        }
        if !block.attrs.is_empty() {
            extra.push_str(&format!(
                " attrs={}",
                serde_json::Value::Object(block.attrs.clone())
            ));
        }
        println!(
            "{:?}{list} {:?} spans={:?}{extra}",
            block.kind,
            block.label(),
            block.spans
        );
    }
    for asset in doc.assets() {
        println!(
            "asset {} {} {} bytes",
            asset.hash,
            asset.mime,
            asset.bytes.len()
        );
    }
}
