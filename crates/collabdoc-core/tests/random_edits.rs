//! Random editing sessions: after every step the incrementally maintained
//! view must equal a fresh read of the Loro tree, and two participants must
//! converge. Deterministic (seeded) so a failure reproduces.

use collabdoc_core::schema::mark_bit;
use collabdoc_core::sync::Hub;
use collabdoc_core::{BlockKind, Document, Editor, tree};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn fresh(doc: &Document) -> Vec<collabdoc_core::ViewBlock> {
    tree::flatten(doc.loro())
        .into_iter()
        .map(|(_, v)| v)
        .collect()
}

fn step(e: &mut Editor, rng: &mut Rng) {
    let len = e.len();
    let op = rng.below(12);
    if std::env::var("FUZZ_TRACE").is_ok() {
        eprintln!(
            "op {op} sel {:?} blocks {:?}",
            e.selection(),
            e.blocks()
                .iter()
                .map(|b| (b.text.clone(), b.spans.clone()))
                .collect::<Vec<_>>()
        );
    }
    match op {
        0..=3 => {
            let words = ["a", "Loro ", "ü", "👍🏽", "δ", "  ", "x\ny", "longer words "];
            e.insert_text(words[rng.below(words.len())]);
        }
        4 => {
            e.newline();
        }
        5 => {
            e.backspace();
        }
        6 => {
            e.delete_forward();
        }
        7 => {
            let a = rng.below(len + 1);
            let b = rng.below(len + 1);
            if std::env::var("FUZZ_TRACE").is_ok() {
                eprintln!("  select {a} {b}");
            }
            e.set_selection(a, b);
        }
        8 => {
            let marks = ["bold", "italic", "code", "highlight", "strike"];
            e.toggle_mark(mark_bit(marks[rng.below(marks.len())]).unwrap());
        }
        9 => {
            let kinds = [
                BlockKind::Paragraph,
                BlockKind::Heading(2),
                BlockKind::CodeBlock,
            ];
            e.set_kind(kinds[rng.below(kinds.len())]);
        }
        10 => {
            e.undo();
        }
        _ => {
            e.redo();
        }
    }
}

#[test]
fn the_cached_view_always_matches_the_tree() {
    for seed in 1..=20u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut e = Editor::new(Document::create("fuzz", "me"));
        for i in 0..150 {
            step(&mut e, &mut rng);
            assert_eq!(
                e.blocks(),
                fresh(e.document()).as_slice(),
                "seed {seed} step {i}"
            );
            assert!(
                e.head() <= e.len() && e.anchor() <= e.len(),
                "seed {seed} step {i}"
            );
        }
    }
}

#[test]
fn two_random_participants_converge() {
    for seed in 1..=10u64 {
        let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03));
        let mut a = Editor::new(Document::create("fuzz", "a"));
        a.insert_text("start");
        let hub = Hub::new(a.document());
        let mut b = Editor::new(a.document().fork("b"));
        for i in 0..120 {
            let who = if rng.below(2) == 0 { &mut a } else { &mut b };
            step(who, &mut rng);
            if rng.below(4) == 0 {
                hub.push(a.document()).unwrap();
                hub.push(b.document()).unwrap();
                a.remote_change(|d| hub.pull(d)).unwrap();
                b.remote_change(|d| hub.pull(d)).unwrap();
                assert_eq!(a.blocks(), b.blocks(), "seed {seed} step {i}");
                assert_eq!(
                    a.blocks(),
                    fresh(a.document()).as_slice(),
                    "seed {seed} step {i}"
                );
            }
        }
    }
}
