//! The spike in a real window: `cargo run -p collabdoc-egui --example window`.

use collabdoc_core::{Document, Editor};
use collabdoc_egui::{EditorView, install_fonts};

const SAMPLE: &str = "# The editor in egui\n\nThe same **core**, the same *rules*: typing, `marks`, ~~strike~~, ==highlight== and [links](https://loro.dev) are the core's; egui only draws them.\n\n## Lists and quotes\n\n- one\n- two\n  - nested\n\n> A quote, as the other builds show it.\n\n```\nfn main() {}\n```\n";

struct App {
    view: EditorView,
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::Frame::new()
            .fill(egui::Color32::from_rgb(0x0F, 0x0F, 0x10))
            .inner_margin(32.0)
            .show(ui, |ui| {
                ui.set_min_size(ui.available_size());
                egui::ScrollArea::vertical().show(ui, |ui| {
                    let response = self.view.ui(ui);
                    if !ui.ctx().memory(|m| m.focused().is_some()) {
                        response.request_focus();
                    }
                });
            });
    }
}

fn main() -> eframe::Result {
    let mut editor = Editor::new(Document::create("egui", "spike"));
    editor.paste(SAMPLE);
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("CollabDoc egui")
            .with_inner_size([900.0, 640.0]),
        ..Default::default()
    };
    eframe::run_native(
        "CollabDoc egui",
        options,
        Box::new(|cc| {
            install_fonts(&cc.egui_ctx);
            Ok(Box::new(App {
                view: EditorView::new(editor),
            }))
        }),
    )
}
