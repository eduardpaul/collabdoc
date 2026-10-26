//! The demo in a browser: `WebHandle` is what `web/index.html` (and the
//! Playwright check in `scripts/egui-web.sh`) calls from JavaScript.

use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::prelude::*;

use crate::EditorView;
use crate::demo::{DemoApp, sample_view};

#[wasm_bindgen]
pub struct WebHandle {
    runner: eframe::WebRunner,
    view: Rc<RefCell<EditorView>>,
}

#[wasm_bindgen]
impl WebHandle {
    #[wasm_bindgen(constructor)]
    #[expect(clippy::new_without_default, reason = "a JS constructor")]
    pub fn new() -> Self {
        Self {
            runner: eframe::WebRunner::new(),
            view: sample_view(),
        }
    }

    /// Runs the editor in `canvas`.
    pub async fn start(&self, canvas: web_sys::HtmlCanvasElement) -> Result<(), JsValue> {
        let view = self.view.clone();
        self.runner
            .start(
                canvas,
                eframe::WebOptions::default(),
                Box::new(move |cc| Ok(Box::new(DemoApp::new(cc, view)))),
            )
            .await
    }

    /// The document as Markdown, as the core writes it.
    pub fn markdown(&self) -> String {
        collabdoc_core::markdown::render(self.view.borrow().editor.blocks())
    }

    /// The selection as `[anchor, head]` (UTF-16 offsets).
    pub fn selection(&self) -> Vec<u32> {
        let view = self.view.borrow();
        vec![view.editor.anchor() as u32, view.editor.head() as u32]
    }

    /// The IME composition shown at the caret (empty when none).
    pub fn preedit(&self) -> String {
        self.view.borrow().preedit.clone()
    }

    pub fn has_panicked(&self) -> bool {
        self.runner.has_panicked()
    }

    pub fn panic_message(&self) -> Option<String> {
        self.runner.panic_summary().map(|s| s.message())
    }

    pub fn destroy(&self) {
        self.runner.destroy();
    }
}
