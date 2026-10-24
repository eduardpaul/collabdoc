//! CollabDoc desktop editor (GPUI).
//!
//! `collabdoc [file.collabdoc]` opens a file, or a new document that saves
//! there. Ctrl+Shift+N opens another window as a second participant on the
//! same document, synced through Loro like a remote collaborator would be.

use std::path::PathBuf;

use collabdoc_core::Document;
use collabdoc_core::ids::new_actor_id;
use gpui::{App, Application};

use collabdoc_gpui::editor_view::{self, Quit};
use collabdoc_gpui::theme;
use collabdoc_gpui::workspace::{self, Workspace};

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let path = std::env::args_os().nth(1).map(PathBuf::from);

    Application::new().run(move |cx: &mut App| {
        theme::load_fonts(cx);
        editor_view::bind_keys(cx);
        cx.on_action(|_: &Quit, cx| cx.quit());

        let actor = new_actor_id();
        let doc = match &path {
            Some(p) if p.exists() => match workspace::open_file(p, &actor) {
                Ok(doc) => doc,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            },
            Some(p) => {
                let title = p.file_stem().map(|s| s.to_string_lossy().into_owned());
                Document::create(title.as_deref().unwrap_or("Untitled"), &actor)
            }
            None => Document::create("Untitled", &actor),
        };
        let mut ws = Workspace::new(&doc, path.clone());
        let participant = ws.next_participant();
        cx.set_global(ws);
        editor_view::open_window(doc, participant, cx);

        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
}
