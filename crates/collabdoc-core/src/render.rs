//! Figures drawn to PNG for a front end that shows bitmaps: Mermaid diagrams
//! (`mermaid-rs-renderer`, picked over `merman` in spec 24: every diagram
//! type the app offers comes out legible through `resvg`, at a fifth of the
//! binary size) and SVG images.
//!
//! The system fonts are loaded once, on the first figure drawn.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, OnceLock};

use resvg::{tiny_skia, usvg};

/// The longest side of a drawn figure, in pixels, whatever the scale.
pub const MAX_SIDE_PX: u32 = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct Png {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = usvg::fontdb::Database::new();
            db.load_system_fonts();
            Arc::new(db)
        })
        .clone()
}

/// The SVG of Mermaid `source`, or why it cannot be drawn.
pub fn mermaid_svg(source: &str) -> Result<String, String> {
    if source.trim().is_empty() {
        return Err("The diagram is empty.".into());
    }
    // A parser bug must not take the app down with it.
    match catch_unwind(AssertUnwindSafe(|| mermaid_rs_renderer::render(source))) {
        Ok(Ok(svg)) => Ok(svg),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("This diagram could not be drawn.".into()),
    }
}

/// `svg` as a PNG at `scale` device pixels per SVG unit, on `background`
/// (RGBA; transparent when `None`).
pub fn svg_png(svg: &[u8], scale: f32, background: Option<[u8; 4]>) -> Result<Png, String> {
    let options = usvg::Options {
        fontdb: fonts(),
        ..Default::default()
    };
    let tree = usvg::Tree::from_data(svg, &options).map_err(|e| e.to_string())?;
    let size = tree.size();
    let longest = size.width().max(size.height()).max(1.0);
    let scale = scale.clamp(0.1, 8.0).min(MAX_SIDE_PX as f32 / longest);
    let width = ((size.width() * scale).ceil() as u32).max(1);
    let height = ((size.height() * scale).ceil() as u32).max(1);
    let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or("The image is too big.")?;
    if let Some([r, g, b, a]) = background {
        pixmap.fill(tiny_skia::Color::from_rgba8(r, g, b, a));
    }
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let bytes = pixmap.encode_png().map_err(|e| e.to_string())?;
    Ok(Png {
        bytes,
        width,
        height,
    })
}

/// Mermaid `source` drawn on white, as the app shows diagrams.
pub fn mermaid_png(source: &str, scale: f32) -> Result<Png, String> {
    let svg = mermaid_svg(source)?;
    svg_png(svg.as_bytes(), scale, Some([255, 255, 255, 255]))
}
