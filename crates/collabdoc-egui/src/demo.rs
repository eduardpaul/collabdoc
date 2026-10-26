//! The demo app around the widget, shared by the native window
//! (`--example window`) and the browser build (`web`).

use std::cell::RefCell;
use std::rc::Rc;

use collabdoc_core::{Document, Editor};

use crate::{EditorView, install_fonts};

pub const SAMPLE: &str = "# The editor in egui\n\nThe same **core**, the same *rules*: typing, `marks`, ~~strike~~, ==highlight== and [links](https://loro.dev) are the core's; egui only draws them.\n\n## Lists and quotes\n\n- one\n- two\n  - nested\n\n> A quote, as the other builds show it.\n\n```\nfn main() {}\n```\n";

/// The sample document in an editor view, shared with whoever drives it
/// (the web handle reads it back for tests).
pub fn sample_view() -> Rc<RefCell<EditorView>> {
    let mut editor = Editor::new(Document::create("egui", "spike"));
    editor.paste(SAMPLE);
    Rc::new(RefCell::new(EditorView::new(editor)))
}

pub struct DemoApp {
    view: Rc<RefCell<EditorView>>,
}

impl DemoApp {
    pub fn new(cc: &eframe::CreationContext<'_>, view: Rc<RefCell<EditorView>>) -> Self {
        install_fonts(&cc.egui_ctx);
        Self { view }
    }
}

impl eframe::App for DemoApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::Frame::new()
            .fill(egui::Color32::from_rgb(0x0F, 0x0F, 0x10))
            .inner_margin(32.0)
            .show(ui, |ui| {
                ui.set_min_size(ui.available_size());
                egui::ScrollArea::vertical().show(ui, |ui| {
                    let response = self.view.borrow_mut().ui(ui);
                    if !ui.ctx().memory(|m| m.focused().is_some()) {
                        response.request_focus();
                    }
                });
            });
    }
}
