//! Figures (images, Mermaid and infographic diagrams) and the image bytes
//! they point at: the rules of `editor/figures/*` and `editor/assets.ts`.
//!
//! An image figure's `src` is `asset:<sha256>`, naming bytes the document
//! carries in its `.collabdoc` file; Markdown spells it `assets/<hash>.<ext>`
//! or, written as one file, a `data:` URI.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::{Digest, Sha256};

use crate::file::Asset;
use crate::model::ViewBlock;

/// One image (`MAX_IMAGE_BYTES`).
pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// All of a document's images (`MAX_DOCUMENT_ASSET_BYTES`).
pub const MAX_DOCUMENT_ASSET_BYTES: usize = 25 * 1024 * 1024;

pub const FIGURE_TYPES: &[&str] = &["imageFigure", "mermaidFigure", "infographicFigure"];
pub const FIGURE_ALIGNS: &[&str] = &["left", "center", "right"];
pub const FIGURE_WIDTHS: &[u8] = &[50, 75, 100];

pub const DEFAULT_MERMAID: &str = "flowchart LR\n  A[Write] --> B[Review]\n  B --> C[Publish]";
pub const DEFAULT_INFOGRAPHIC: &str = "infographic list-row-simple-horizontal-arrow\ndata\n  lists\n    - label Step 1\n      desc Start\n    - label Step 2\n      desc In Progress\n    - label Step 3\n      desc Complete";

pub fn is_figure(name: &str) -> bool {
    FIGURE_TYPES.contains(&name)
}

/// The fence language of a diagram figure.
pub fn fence_lang(name: &str) -> Option<&'static str> {
    match name {
        "mermaidFigure" => Some("mermaid"),
        "infographicFigure" => Some("infographic"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AssetError {
    #[error("Image must be 2 MB or smaller.")]
    TooLarge,
    #[error("Document assets would exceed 25 MB.")]
    DocTooLarge,
    #[error("This is not an image CollabDoc can show (PNG, JPEG, GIF, WebP or SVG).")]
    Invalid,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The image type of `bytes`, from their first bytes.
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
        let head = head.trim_start_matches('\u{feff}').trim_start();
        (head.starts_with("<svg") || head.starts_with("<?xml") && head.contains("<svg"))
            .then_some("image/svg+xml")
    }
}

pub fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

/// An asset for `bytes`, checked against the limits given what the document
/// already holds. Bytes it already has come back as they are.
pub fn make_asset(bytes: Vec<u8>, have: &[Asset]) -> Result<Asset, AssetError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AssetError::TooLarge);
    }
    let mime = sniff_mime(&bytes).ok_or(AssetError::Invalid)?;
    let hash = sha256_hex(&bytes);
    if let Some(existing) = have.iter().find(|a| a.hash == hash) {
        return Ok(existing.clone());
    }
    let total: usize = have.iter().map(|a| a.bytes.len()).sum();
    if total + bytes.len() > MAX_DOCUMENT_ASSET_BYTES {
        return Err(AssetError::DocTooLarge);
    }
    Ok(Asset {
        hash,
        mime: mime.to_owned(),
        bytes,
    })
}

/// The asset hash an image `src` names: `asset:<hash>`, or a file named
/// `<hash>.<ext>` (16+ hex digits), as Markdown exports write.
pub fn hash_from_src(src: &str) -> Option<String> {
    if let Some(hash) = src.strip_prefix("asset:") {
        return Some(hash.to_owned());
    }
    let file = src.rsplit('/').next()?;
    let (stem, ext) = file.rsplit_once('.')?;
    (stem.len() >= 16
        && stem.chars().all(|c| c.is_ascii_hexdigit())
        && !ext.is_empty()
        && ext.chars().all(|c| c.is_ascii_alphanumeric()))
    .then(|| stem.to_ascii_lowercase())
}

/// `(mime, bytes)` of a `data:` URI.
pub fn parse_data_uri(uri: &str) -> Option<(String, Vec<u8>)> {
    let rest = uri.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let base64 = meta.ends_with(";base64");
    let mime = meta.trim_end_matches(";base64");
    let mime = if mime.is_empty() {
        "application/octet-stream"
    } else {
        mime
    };
    let bytes = if base64 {
        BASE64.decode(data.trim()).ok()?
    } else {
        percent_decode(data)
    };
    Some((mime.to_owned(), bytes))
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

pub fn data_uri(asset: &Asset) -> String {
    format!("data:{};base64,{}", asset.mime, BASE64.encode(&asset.bytes))
}

/// Where Markdown or HTML points for an image `src`: a `data:` URI when
/// `inline` and the bytes are known, else `assets/<hash>.<ext>`
/// (`exportImageSrc`).
pub fn export_src(src: &str, assets: &[Asset], inline: bool) -> String {
    if src.starts_with("data:") {
        return src.to_owned();
    }
    let Some(hash) = hash_from_src(src) else {
        return src.to_owned();
    };
    let asset = assets.iter().find(|a| a.hash == hash);
    match asset {
        Some(a) if inline => data_uri(a),
        Some(a) => format!("assets/{hash}.{}", ext_for_mime(&a.mime)),
        None => format!("assets/{hash}.png"),
    }
}

fn attr<'a>(view: &'a ViewBlock, key: &str) -> &'a str {
    view.attrs.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// A figure (or rule) as Markdown, as the Tiptap app writes it.
pub fn markdown(view: &ViewBlock, assets: &[Asset], inline: bool) -> String {
    let caption = view.caption.replace('"', "'");
    match view.node_name.as_str() {
        "horizontalRule" => "---".to_owned(),
        "imageFigure" => {
            let src = export_src(attr(view, "src"), assets, inline);
            let title = if caption.is_empty() {
                String::new()
            } else {
                format!(" \"{caption}\"")
            };
            format!("![{}]({src}{title})", attr(view, "alt"))
        }
        name => match fence_lang(name) {
            Some(lang) => {
                let info = if caption.is_empty() {
                    lang.to_owned()
                } else {
                    format!("{lang} caption=\"{caption}\"")
                };
                format!("```{info}\n{}\n```", attr(view, "source"))
            }
            None => view.text.clone(),
        },
    }
}

/// A figure (or rule) as the Tiptap app's HTML.
pub fn html(view: &ViewBlock, assets: &[Asset], escape: impl Fn(&str) -> String) -> String {
    let caption = escape(&view.caption);
    let mut data = String::new();
    if let Some(width) = view.attrs.get("width").and_then(|v| v.as_f64()) {
        data.push_str(&format!(" data-width=\"{width}\""));
    }
    let align = match attr(view, "align") {
        "" => "center",
        a => a,
    };
    data.push_str(&format!(" data-align=\"{}\"", escape(align)));
    match view.node_name.as_str() {
        "horizontalRule" => "<hr>".to_owned(),
        "imageFigure" => {
            let src = attr(view, "src");
            let shown = export_src(src, assets, true);
            let alt = escape(attr(view, "alt"));
            let alt_attr = if alt.is_empty() {
                String::new()
            } else {
                format!(" data-alt=\"{alt}\"")
            };
            format!(
                "<figure data-src=\"{}\"{alt_attr}{data} data-type=\"image\" class=\"doc-figure\"><img src=\"{}\" alt=\"{alt}\"><figcaption>{caption}</figcaption></figure>",
                escape(src),
                escape(&shown)
            )
        }
        name => match fence_lang(name) {
            Some(lang) => format!(
                "<figure data-source=\"{}\"{data} data-type=\"{lang}\" class=\"doc-figure\"><div class=\"doc-figure__diagram\" contenteditable=\"false\"></div><figcaption>{caption}</figcaption></figure>",
                escape(attr(view, "source"))
            ),
            None => format!("<p>{}</p>", escape(&view.text)),
        },
    }
}
