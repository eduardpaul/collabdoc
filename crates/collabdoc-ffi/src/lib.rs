//! C ABI over `collabdoc-core`, for front ends that are not Rust (Flutter).
//!
//! The surface is deliberately tiny — open, fork, free, and one JSON command
//! entry point — so the binding on the other side is a handful of lines and
//! all editing rules stay in `collabdoc_core::Editor`. Offsets are UTF-16
//! code units, which is what Dart strings index by.
//!
//! A session is one participant (one Loro peer, one undo stack). Sessions
//! opened from each other share a workspace: the document's hub and its path.
//! Everything here must be called from one thread (Dart's UI isolate).

use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;
use std::rc::Rc;

use collabdoc_core::ids::new_actor_id;
use collabdoc_core::model::ListKind;
use collabdoc_core::persist;
use collabdoc_core::schema::mark_bit;
use collabdoc_core::sync::Hub;
use collabdoc_core::{BlockKind, Document, Editor};
use serde_json::{Value, json};

struct Shared {
    hub: Hub,
    path: Option<PathBuf>,
}

pub struct Session {
    editor: Editor,
    shared: Rc<RefCell<Shared>>,
}

impl Session {
    fn open(path: Option<PathBuf>) -> Result<Self, String> {
        let actor = new_actor_id();
        let doc = match &path {
            Some(p) if p.exists() => persist::open_file(p, &actor)?,
            Some(p) => {
                let title = p.file_stem().map(|s| s.to_string_lossy().into_owned());
                Document::create(title.as_deref().unwrap_or("Untitled"), &actor)
            }
            None => Document::create("Untitled", &actor),
        };
        let shared = Shared {
            hub: Hub::new(&doc),
            path,
        };
        Ok(Self {
            editor: Editor::new(doc),
            shared: Rc::new(RefCell::new(shared)),
        })
    }

    fn fork(&self) -> Self {
        let doc = self.editor.document().fork(&new_actor_id());
        Self {
            editor: Editor::new(doc),
            shared: self.shared.clone(),
        }
    }

    fn view(&self) -> Value {
        let e = &self.editor;
        let blocks: Vec<Value> = e
            .blocks()
            .iter()
            .map(|b| {
                let (kind, level) = match b.kind {
                    BlockKind::Paragraph => ("paragraph", 0),
                    BlockKind::Heading(l) => ("heading", l),
                    BlockKind::CodeBlock => ("code", 0),
                    BlockKind::Atom => ("atom", 0),
                };
                let list = b.list.map(|l| match l {
                    ListKind::Bullet => "bullet",
                    ListKind::Ordered => "ordered",
                    ListKind::Task => "task",
                });
                let spans: Vec<Value> = b
                    .spans
                    .iter()
                    .map(|s| json!([s.start, s.end, s.marks, s.href]))
                    .collect();
                json!({
                    "key": b.key, "kind": kind, "level": level, "list": list,
                    "listDepth": b.list_depth, "quoteDepth": b.quote_depth, "checked": b.checked,
                    "editable": b.editable, "text": b.text, "spans": spans,
                })
            })
            .collect();
        let (kind, level) = match e.kind_at_cursor() {
            BlockKind::Heading(l) => ("heading", l),
            BlockKind::CodeBlock => ("code", 0),
            BlockKind::Atom => ("atom", 0),
            BlockKind::Paragraph => ("paragraph", 0),
        };
        let shared = self.shared.borrow();
        json!({
            "blocks": blocks,
            "anchor": e.anchor(),
            "head": e.head(),
            "marks": e.marks_at_cursor(),
            "kind": kind,
            "level": level,
            "canUndo": e.document().can_undo(),
            "canRedo": e.document().can_redo(),
            "title": e.document().title(),
            "path": shared.path.as_ref().map(|p| p.display().to_string()),
        })
    }

    /// Runs one command. Every reply has `ok`; edits also say `changed`.
    fn call(&mut self, cmd: &Value) -> Value {
        let n = |key: &str| cmd[key].as_u64().unwrap_or(0) as usize;
        let s = |key: &str| cmd[key].as_str().unwrap_or("");
        let extend = cmd["extend"].as_bool().unwrap_or(false);
        let e = &mut self.editor;
        let changed = match s("op") {
            "insert" => e.insert_text(s("text")),
            "replace" => e.replace(n("start")..n("end"), s("text")),
            "newline" => e.newline(),
            "backspace" => e.backspace(),
            "delete" => e.delete_forward(),
            "undo" => e.undo(),
            "redo" => e.redo(),
            "toggleMark" => match mark_bit(s("mark")) {
                Some(bit) => e.toggle_mark(bit),
                None => return json!({ "ok": false, "error": "unknown mark" }),
            },
            "setKind" => {
                let kind = match s("kind") {
                    "heading" => BlockKind::Heading(n("level").clamp(1, 4) as u8),
                    "code" => BlockKind::CodeBlock,
                    _ => BlockKind::Paragraph,
                };
                e.set_kind(kind)
            }
            "toggleList" => {
                let kind = match s("kind") {
                    "ordered" => ListKind::Ordered,
                    "task" => ListKind::Task,
                    _ => ListKind::Bullet,
                };
                e.toggle_list(kind)
            }
            "indent" => e.indent(),
            "outdent" => e.outdent(),
            "toggleTask" => e.toggle_task(n("block")),
            "select" => {
                e.set_selection(n("anchor"), n("head"));
                false
            }
            "selectAll" => {
                e.select_all();
                false
            }
            "left" => {
                e.move_left(extend);
                false
            }
            "right" => {
                e.move_right(extend);
                false
            }
            "home" => {
                e.move_home(extend);
                false
            }
            "end" => {
                e.move_end(extend);
                false
            }
            "textIn" => return json!({ "ok": true, "text": e.text_in(n("start")..n("end")) }),
            "push" => {
                let shared = self.shared.borrow();
                return match shared.hub.push(self.editor.document()) {
                    Ok(()) => json!({ "ok": true }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            "pull" => {
                let shared = self.shared.clone();
                let shared = shared.borrow();
                return match self.editor.remote_change(|doc| shared.hub.pull(doc)) {
                    Ok(changed) => json!({ "ok": true, "changed": changed }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            "save" => {
                let mut shared = self.shared.borrow_mut();
                let path = match cmd["path"].as_str() {
                    Some(p) if !p.is_empty() => PathBuf::from(p),
                    _ => shared
                        .path
                        .clone()
                        .unwrap_or_else(|| persist::default_path(&self.editor.document().title())),
                };
                return match persist::save_file(&path, self.editor.document()) {
                    Ok(()) => {
                        let shown = path.display().to_string();
                        shared.path = Some(path);
                        json!({ "ok": true, "path": shown })
                    }
                    Err(err) => json!({ "ok": false, "error": err }),
                };
            }
            other => return json!({ "ok": false, "error": format!("unknown op {other:?}") }),
        };
        json!({ "ok": true, "changed": changed })
    }
}

fn to_c(value: Value) -> *mut c_char {
    // JSON never contains a NUL byte (it is escaped as \u0000).
    CString::new(value.to_string())
        .expect("JSON has no NUL")
        .into_raw()
}

/// Opens `path` (or a new document when it does not exist yet, or when null).
/// Returns null and sets `*error` (free with `cd_string_free`) on failure.
///
/// # Safety
/// `path` is null or a NUL-terminated UTF-8 string; `error` is null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_open(path: *const c_char, error: *mut *mut c_char) -> *mut Session {
    let path = (!path.is_null())
        .then(|| {
            unsafe { CStr::from_ptr(path) }
                .to_string_lossy()
                .into_owned()
        })
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    match Session::open(path) {
        Ok(session) => Box::into_raw(Box::new(session)),
        Err(message) => {
            if !error.is_null() {
                unsafe { *error = to_c(Value::String(message)) };
            }
            std::ptr::null_mut()
        }
    }
}

/// A new participant on the same document, synced through the shared hub.
///
/// # Safety
/// `session` comes from `cd_open`/`cd_fork` and is not freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_fork(session: *const Session) -> *mut Session {
    let session = unsafe { &*session };
    Box::into_raw(Box::new(session.fork()))
}

/// # Safety
/// `session` comes from `cd_open`/`cd_fork`; it is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_free(session: *mut Session) {
    if !session.is_null() {
        drop(unsafe { Box::from_raw(session) });
    }
}

/// Runs a JSON command (`{"op": "insert", "text": "a"}` …) and returns JSON.
///
/// # Safety
/// `session` is live; `command` is a NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_call(session: *mut Session, command: *const c_char) -> *mut c_char {
    let session = unsafe { &mut *session };
    let command = unsafe { CStr::from_ptr(command) }.to_string_lossy();
    let reply = match serde_json::from_str::<Value>(&command) {
        Ok(cmd) => session.call(&cmd),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    };
    to_c(reply)
}

/// The blocks and selection as JSON.
///
/// # Safety
/// `session` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_view(session: *const Session) -> *mut c_char {
    to_c(unsafe { &*session }.view())
}

/// # Safety
/// `s` comes from this library and is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(s: &mut Session, cmd: Value) -> Value {
        s.call(&cmd)
    }

    #[test]
    fn commands_edit_and_participants_sync() {
        let mut me = Session::open(None).unwrap();
        let mut peer = me.fork();
        assert_eq!(
            call(&mut me, json!({"op": "insert", "text": "Hello"}))["changed"],
            true
        );
        call(&mut me, json!({"op": "newline"}));
        call(&mut me, json!({"op": "insert", "text": "world"}));
        call(&mut me, json!({"op": "select", "anchor": 0, "head": 5}));
        call(&mut me, json!({"op": "toggleMark", "mark": "bold"}));
        call(&mut me, json!({"op": "push"}));
        assert_eq!(call(&mut peer, json!({"op": "pull"}))["changed"], true);
        let view = peer.view();
        assert_eq!(view["blocks"][0]["text"], "Hello");
        assert_eq!(view["blocks"][0]["spans"][0], json!([0, 5, 1, ""]));
        assert_eq!(view["blocks"][1]["text"], "world");
    }

    #[test]
    fn the_c_entry_points_round_trip_json() {
        unsafe {
            let session = cd_open(std::ptr::null(), std::ptr::null_mut());
            let cmd = CString::new(r#"{"op":"insert","text":"é👍"}"#).unwrap();
            let reply = cd_call(session, cmd.as_ptr());
            let reply_json: Value =
                serde_json::from_str(CStr::from_ptr(reply).to_str().unwrap()).unwrap();
            assert_eq!(reply_json, json!({ "ok": true, "changed": true }));
            cd_string_free(reply);
            let view = cd_view(session);
            let value: Value =
                serde_json::from_str(CStr::from_ptr(view).to_str().unwrap()).unwrap();
            assert_eq!(value["head"], 3, "UTF-16 offsets, as Dart counts");
            cd_string_free(view);
            let fork = cd_fork(session);
            cd_free(fork);
            cd_free(session);
        }
    }

    #[test]
    fn list_commands() {
        let mut s = Session::open(None).unwrap();
        call(&mut s, json!({"op": "insert", "text": "one\ntwo"}));
        call(&mut s, json!({"op": "selectAll"}));
        assert_eq!(
            call(&mut s, json!({"op": "toggleList", "kind": "task"}))["changed"],
            true
        );
        assert_eq!(
            call(&mut s, json!({"op": "toggleTask", "block": 1}))["changed"],
            true
        );
        call(&mut s, json!({"op": "select", "anchor": 4, "head": 4}));
        assert_eq!(call(&mut s, json!({"op": "indent"}))["changed"], true);
        let view = s.view();
        assert_eq!(view["blocks"][1]["list"], "task");
        assert_eq!(view["blocks"][1]["listDepth"], 2);
        assert_eq!(view["blocks"][1]["checked"], true);
    }

    #[test]
    fn unknown_commands_are_errors_not_crashes() {
        let mut s = Session::open(None).unwrap();
        assert_eq!(call(&mut s, json!({"op": "fly"}))["ok"], false);
        assert_eq!(
            call(&mut s, json!({"op": "toggleMark", "mark": "blink"}))["ok"],
            false
        );
    }
}
