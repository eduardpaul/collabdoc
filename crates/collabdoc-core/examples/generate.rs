//! Writes a large document for performance checks:
//! `cargo run -p collabdoc-core --example generate -- out.collabdoc [paragraphs]`

use collabdoc_core::schema::mark_bit;
use collabdoc_core::{BlockKind, Document, Editor};

const WORDS: &str = "local first collaborative documents keep every keystroke attributed and versioned \
while people and agents write review and comment together without a server";

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args
        .next()
        .expect("usage: generate <out.collabdoc> [paragraphs]");
    let paragraphs: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(500);
    let mut e = Editor::new(Document::create("Large document", "generator"));
    for i in 0..paragraphs {
        if i % 20 == 0 {
            e.insert_text(&format!("Section {}", i / 20 + 1));
            e.set_kind(BlockKind::Heading(2));
            e.newline();
            e.set_kind(BlockKind::Paragraph);
        }
        let start = e.head();
        e.insert_text(&format!("{i}. {WORDS} {WORDS}"));
        e.set_selection(start, start + 8);
        e.toggle_mark(mark_bit("bold").unwrap());
        let end = e.len();
        e.move_to(end);
        e.newline();
    }
    std::fs::write(&out, e.document().to_collabdoc()).expect("write");
    let words: usize = e
        .blocks()
        .iter()
        .map(|b| b.text.split_whitespace().count())
        .sum();
    println!("{} blocks, {words} words → {out}", e.blocks().len());

    // Typing latency in the middle of the finished document (core only, no UI).
    let middle = e.block_start(e.blocks().len() / 2) + 10;
    e.move_to(middle);
    let keys = 300;
    let started = std::time::Instant::now();
    for i in 0..keys {
        if i % 50 == 49 {
            e.newline();
        } else {
            e.insert_text("x");
        }
    }
    let per_key = started.elapsed() / keys;
    println!("typing: {per_key:?} per keystroke ({keys} keys, Enter every 50)");
}
