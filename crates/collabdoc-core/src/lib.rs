//! CollabDoc's document core in Rust.
//!
//! The Loro layout matches the TypeScript core (`src/core`, `loro-prosemirror`),
//! so `.collabdoc` files and sync updates move between the two builds.

pub mod document;
pub mod editing;
pub mod file;
pub mod ids;
pub mod model;
pub mod schema;
pub mod sync;
pub mod tree;
pub mod utf16;

pub use document::{DocError, Document};
pub use editing::Editor;
pub use model::{BlockKind, ListKind, Span, TargetBlock, ViewBlock};
