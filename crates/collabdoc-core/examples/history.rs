//! Prints a `.collabdoc` file's history and checkpoints as the History tab
//! shows them: `cargo run -p collabdoc-core --example history -- file.collabdoc`

use collabdoc_core::Document;
use collabdoc_core::history;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: history <file.collabdoc>");
    let bytes = std::fs::read(&path).expect("readable file");
    let doc = Document::from_collabdoc(&bytes, "history").expect("a CollabDoc file");
    for e in history::list_history(doc.loro()) {
        let message = if e.message.is_empty() {
            String::new()
        } else {
            format!("  [{}]", e.message)
        };
        println!("{:<10} {}{message}", e.author.name, e.summary);
    }
    for c in history::list_checkpoints(doc.loro()) {
        let blocks: Vec<String> = history::preview_at(doc.loro(), &c.frontiers)
            .into_iter()
            .map(|b| b.text)
            .collect();
        println!("checkpoint “{}” by {}: {blocks:?}", c.name, c.actor_id);
    }
    let blocks: Vec<String> = doc.blocks().iter().map(|b| b.label()).collect();
    println!("now: {blocks:?}");
}
