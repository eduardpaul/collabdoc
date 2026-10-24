//! Figures and their images: insert, edit, copy and paste, Markdown, saving
//! with the bytes, and drawing diagrams natively.

use std::fs;
use std::path::PathBuf;

use collabdoc_core::figures::{self, AssetError};
use collabdoc_core::store::{Store, StoreConfig};
use collabdoc_core::{Document, Editor};
use serde_json::json;

/// A 1×1 PNG.
const PNG_URI: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

fn png() -> Vec<u8> {
    figures::parse_data_uri(PNG_URI).unwrap().1
}

fn editor() -> Editor {
    Editor::new(Document::create("t", "me"))
}

fn figure_index(e: &Editor, name: &str) -> usize {
    e.blocks()
        .iter()
        .position(|b| b.node_name == name)
        .unwrap_or_else(|| panic!("no {name}"))
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("collabdoc-figures-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn an_inserted_image_is_an_asset_figure() {
    let mut e = editor();
    e.insert_text("Before");
    assert_eq!(e.insert_image(png(), "a dot"), Ok(true));
    let i = figure_index(&e, "imageFigure");
    let b = &e.blocks()[i];
    let hash = figures::sha256_hex(&png());
    assert_eq!(b.attrs["src"], json!(format!("asset:{hash}")));
    assert_eq!(b.attrs["alt"], json!("a dot"));
    assert_eq!(b.attrs["align"], json!("center"));
    assert!(!b.attrs.contains_key("width"));
    let asset = e.document().asset(&hash).unwrap();
    assert_eq!(asset.mime, "image/png");
    // The same bytes again are the same asset.
    e.insert_image(png(), "").unwrap();
    assert_eq!(e.document().assets().len(), 1);
}

#[test]
fn images_must_be_images_and_small_enough() {
    let mut e = editor();
    assert_eq!(
        e.insert_image(b"hello".to_vec(), ""),
        Err(AssetError::Invalid)
    );
    let mut big = png();
    big.resize(figures::MAX_IMAGE_BYTES + 1, 0);
    assert_eq!(e.insert_image(big, ""), Err(AssetError::TooLarge));
    assert!(e.document().assets().is_empty());
    assert_eq!(
        figures::sniff_mime(b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
        Some("image/svg+xml")
    );
}

#[test]
fn captions_and_attributes_are_edits_that_undo() {
    let mut e = editor();
    e.insert_figure("mermaidFigure");
    let i = figure_index(&e, "mermaidFigure");
    assert_eq!(
        e.blocks()[i].attrs["source"],
        json!(figures::DEFAULT_MERMAID)
    );
    assert!(e.set_caption(i, "The flow"));
    assert!(e.set_figure_attr(i, "source", &json!("graph TD; X-->Y")));
    assert!(e.set_figure_attr(i, "width", &json!(75)));
    assert!(e.set_figure_attr(i, "align", &json!("left")));
    // Values the TS schema does not allow are refused.
    assert!(!e.set_figure_attr(i, "width", &json!(60)));
    assert!(!e.set_figure_attr(i, "align", &json!("middle")));
    assert!(!e.set_figure_attr(i, "onclick", &json!("x")));
    let b = &e.blocks()[i];
    assert_eq!(b.caption, "The flow");
    assert_eq!(b.attrs["source"], json!("graph TD; X-->Y"));
    assert_eq!(b.attrs["width"], json!(75.0));
    assert_eq!(b.attrs["align"], json!("left"));
    assert!(e.undo());
    assert_eq!(e.blocks()[i].attrs["align"], json!("center"));
    assert!(e.set_figure_attr(i, "width", &serde_json::Value::Null));
    assert!(!e.blocks()[i].attrs.contains_key("width"));
}

#[test]
fn markdown_round_trips_diagrams_and_images() {
    let md = "```mermaid caption=\"Flow\"\ngraph TD; A-->B\n```\n\n\
              ```infographic\ninfographic list-row\n```\n\n\
              ![alt text](assets/0123456789abcdef0123.png \"A caption\")";
    let mut e = editor();
    e.paste(md);
    let names: Vec<_> = e.blocks().iter().map(|b| b.node_name.as_str()).collect();
    assert_eq!(names, ["mermaidFigure", "infographicFigure", "imageFigure"]);
    let m = &e.blocks()[0];
    assert_eq!(m.attrs["source"], json!("graph TD; A-->B"));
    assert_eq!(m.caption, "Flow");
    let img = &e.blocks()[2];
    assert_eq!(img.attrs["src"], json!("asset:0123456789abcdef0123"));
    assert_eq!(img.attrs["alt"], json!("alt text"));
    assert_eq!(img.caption, "A caption");
    e.select_all();
    assert_eq!(e.selection_markdown(), md);
}

#[test]
fn a_data_uri_image_becomes_an_asset_and_exports_inline() {
    let mut e = editor();
    e.paste(&format!("![dot]({PNG_URI})"));
    let i = figure_index(&e, "imageFigure");
    let hash = figures::sha256_hex(&png());
    assert_eq!(e.blocks()[i].attrs["src"], json!(format!("asset:{hash}")));
    // A whole-document export carries the bytes; the clipboard points at them.
    let exported = Store::markdown_of(e.document());
    assert!(
        exported.contains(&format!("![dot]({PNG_URI})")),
        "{exported}"
    );
    e.select_all();
    assert!(
        e.selection_markdown()
            .contains(&format!("![dot](assets/{hash}.png)"))
    );
}

#[test]
fn html_copy_and_paste_keeps_figures_and_their_bytes() {
    let mut a = editor();
    a.insert_image(png(), "dot").unwrap();
    let i = figure_index(&a, "imageFigure");
    a.set_caption(i, "Tiny");
    a.set_figure_attr(i, "width", &json!(50));
    a.insert_figure("mermaidFigure");
    a.select_all();
    let html = a.selection_html();
    assert!(html.contains("data-type=\"image\""), "{html}");
    assert!(html.contains(&format!("src=\"{PNG_URI}\"")), "{html}");
    assert!(html.contains("data-type=\"mermaid\""), "{html}");

    let mut b = editor();
    b.paste_html(&html, "");
    let i = figure_index(&b, "imageFigure");
    let img = &b.blocks()[i];
    assert_eq!(
        img.attrs["src"],
        a.blocks()[figure_index(&a, "imageFigure")].attrs["src"]
    );
    assert_eq!(img.attrs["width"], json!(50.0));
    assert_eq!(img.caption, "Tiny");
    assert!(b.document().asset(&figures::sha256_hex(&png())).is_some());
    let m = &b.blocks()[figure_index(&b, "mermaidFigure")];
    assert_eq!(m.attrs["source"], json!(figures::DEFAULT_MERMAID));

    // An image another app put on the clipboard as a data URI.
    let mut c = editor();
    c.paste_html(&format!("<p>see</p><img src=\"{PNG_URI}\" alt=\"x\">"), "");
    assert_eq!(c.blocks()[1].node_name, "imageFigure");
    assert_eq!(c.document().assets().len(), 1);
}

#[test]
fn saved_images_survive_reopening_and_unused_ones_are_dropped() {
    let s = Scratch::new("save");
    let mut store = Store::open(StoreConfig::new(s.0.join("user"), s.0.join("docs")));
    let doc = store.create("Pics", "me", 1).unwrap();
    let mut e = Editor::new(doc);
    e.insert_image(png(), "dot").unwrap();
    let mut doc = e.into_document();
    let new = doc.take_new_assets();
    assert_eq!(new.len(), 1);
    store.put_assets(doc.loro(), new, 2).unwrap();
    let path = s.0.join("pics.collabdoc");
    store.save_to(doc.loro(), &path, 3).unwrap();
    store.release(doc.loro(), 4).unwrap();

    let mut other = Store::open(StoreConfig::new(s.0.join("user"), s.0.join("docs")));
    let opened = other.open_path(&path, "me", 5).unwrap();
    let hash = figures::sha256_hex(&png());
    assert_eq!(opened.document.asset(&hash).unwrap().bytes, png());
    assert!(other.asset(&opened.document.doc_id(), &hash).is_some());

    // Once no figure points at the bytes, the next save leaves them out.
    let mut e = Editor::new(opened.document);
    e.select_all();
    e.backspace();
    let doc = e.into_document();
    other.save(doc.loro(), 6).unwrap();
    let decoded = collabdoc_core::file::decode(&fs::read(&path).unwrap()).unwrap();
    assert!(decoded.assets.is_empty());
}

#[test]
fn markdown_import_finds_exported_images_beside_the_file() {
    let s = Scratch::new("import");
    let hash = figures::sha256_hex(&png());
    fs::create_dir_all(s.0.join("assets")).unwrap();
    fs::write(s.0.join(format!("assets/{hash}.png")), png()).unwrap();
    let md = s.0.join("note.md");
    fs::write(&md, format!("# Note\n\n![dot](assets/{hash}.png)\n")).unwrap();
    let mut store = Store::open(StoreConfig::new(s.0.join("user"), s.0.join("docs")));
    let opened = store.import_markdown(&md, "me", 1).unwrap();
    assert_eq!(opened.document.asset(&hash).unwrap().bytes, png());
}

#[cfg(feature = "render")]
#[test]
fn diagrams_and_svg_images_draw_natively() {
    use collabdoc_core::render;
    let png = render::mermaid_png(figures::DEFAULT_MERMAID, 2.0).unwrap();
    assert!(png.bytes.starts_with(b"\x89PNG"));
    assert!(png.width > png.height, "a left-to-right flow is wide");
    assert!(render::mermaid_png("", 1.0).is_err());
    assert!(render::mermaid_png("not a diagram at all", 1.0).is_err());
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>"#;
    let drawn = render::svg_png(svg, 2.0, None).unwrap();
    assert_eq!((drawn.width, drawn.height), (80, 40));
}

#[test]
fn the_typescript_fixtures_figure_has_its_source_and_caption() {
    let bytes = fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/from-ts.collabdoc"
    ))
    .unwrap();
    let doc = Document::from_collabdoc(&bytes, "rust").unwrap();
    let blocks = doc.blocks();
    let figure = blocks
        .iter()
        .find(|b| b.node_name == "mermaidFigure")
        .unwrap();
    assert_eq!(figure.attrs["source"], json!("graph TD; A-->B"));
    assert_eq!(figure.caption, "Flow");
    #[cfg(feature = "render")]
    assert!(collabdoc_core::render::mermaid_png("graph TD; A-->B", 1.0).is_ok());
}
