//! The spike in a real window:
//! `cargo run -p collabdoc-egui --features native --example window`.

use collabdoc_egui::demo::{DemoApp, sample_view};

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("CollabDoc egui")
            .with_inner_size([900.0, 640.0]),
        ..Default::default()
    };
    eframe::run_native(
        "CollabDoc egui",
        options,
        Box::new(|cc| Ok(Box::new(DemoApp::new(cc, sample_view())))),
    )
}
