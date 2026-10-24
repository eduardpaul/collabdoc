//! Colours and type, matching the Electron app's dark theme (`assets/base.css`).

use std::borrow::Cow;

use gpui::{App, Font, FontFeatures, FontStyle, FontWeight, Hsla, Rgba, SharedString, rgb, rgba};

pub const UI_FONT: &str = "Inter";
pub const MONO_FONT: &str = "JetBrains Mono";

pub fn bg() -> Rgba {
    rgb(0x0f0f10)
}
pub fn panel() -> Rgba {
    rgb(0x18181b)
}
pub fn border() -> Rgba {
    rgb(0x2a2a2e)
}
pub fn text() -> Rgba {
    rgb(0xe8e8ea)
}
pub fn muted() -> Rgba {
    rgb(0x8b8b93)
}
pub fn accent() -> Rgba {
    rgb(0xc45c26)
}
pub fn button_hover() -> Rgba {
    rgb(0x26262b)
}
pub fn button_active() -> Rgba {
    rgb(0x3a2a20)
}
pub fn code_bg() -> Rgba {
    rgb(0x1c1c20)
}
pub fn code_text() -> Rgba {
    rgb(0xf0a37a)
}
pub fn selection() -> Rgba {
    rgba(0xc45c2655)
}
pub fn highlight_mark() -> Rgba {
    rgba(0xe5c07b40)
}
pub fn link() -> Rgba {
    rgb(0x7aa2f7)
}

pub fn hsla(c: Rgba) -> Hsla {
    c.into()
}

pub fn font(family: &str, bold: bool, italic: bool) -> Font {
    Font {
        family: SharedString::from(family.to_owned()),
        features: FontFeatures::default(),
        fallbacks: None,
        weight: if bold {
            FontWeight::BOLD
        } else {
            FontWeight::NORMAL
        },
        style: if italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        },
    }
}

/// The fonts ship inside the binary so text looks the same everywhere.
pub fn load_fonts(cx: &App) {
    let fonts: Vec<Cow<'static, [u8]>> = vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/Inter-Regular.otf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Inter-Bold.otf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Inter-Italic.otf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Inter-BoldItalic.otf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-Bold.ttf")),
    ];
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        log::warn!("could not load the embedded fonts: {error}");
    }
}
