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
        println!(
            "{:?}{list} {:?} spans={:?}",
            block.kind, block.text, block.spans
        );
    }
}
