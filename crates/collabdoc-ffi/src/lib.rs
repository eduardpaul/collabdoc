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
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;
use std::rc::Rc;

use collabdoc_core::ids::new_actor_id;
use collabdoc_core::model::ListKind;
use collabdoc_core::persist;
use collabdoc_core::presence::{Presence, User};
use collabdoc_core::schema::mark_bit;
use collabdoc_core::sync::Hub;
use collabdoc_core::{BlockKind, Document, Editor, ViewBlock};
use serde_json::{Value, json};

struct Shared {
    hub: Hub,
    path: Option<PathBuf>,
}

pub struct Session {
    editor: Editor,
    shared: Rc<RefCell<Shared>>,
    /// What the UI was last sent, so `view` only sends what changed.
    sent_order: Vec<String>,
    sent: HashMap<String, ViewBlock>,
    presence: Presence,
    user: User,
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
        Ok(Self::with(Editor::new(doc), Rc::new(RefCell::new(shared))))
    }

    fn fork(&self) -> Self {
        let doc = self.editor.document().fork(&new_actor_id());
        Self::with(Editor::new(doc), self.shared.clone())
    }

    fn with(editor: Editor, shared: Rc<RefCell<Shared>>) -> Self {
        let user = User {
            name: "You".into(),
            color: "#3b82f6".into(),
            actor_id: editor.document().actor().to_owned(),
            role: Some("human".into()),
        };
        Self {
            presence: Presence::new(&editor),
            user,
            editor,
            shared,
            sent_order: Vec::new(),
            sent: HashMap::new(),
        }
    }

    /// Blocks and selection. Only blocks that changed since the last call
    /// are included (`changed`), and the block order only when it changed
    /// (`order`), so a keystroke in a long document sends one block.
    fn view(&mut self) -> Value {
        let e = &self.editor;
        let order: Vec<String> = e.blocks().iter().map(|b| b.key.clone()).collect();
        let changed: Vec<&ViewBlock> = e
            .blocks()
            .iter()
            .filter(|b| self.sent.get(&b.key) != Some(*b))
            .collect();
        let blocks: Vec<Value> = changed
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
        let order_changed = order != self.sent_order;
        let mut sent: HashMap<String, ViewBlock> = HashMap::with_capacity(order.len());
        for b in e.blocks() {
            sent.insert(b.key.clone(), b.clone());
        }
        self.sent = sent;
        let order_json = if order_changed {
            Some(order.clone())
        } else {
            None
        };
        self.sent_order = order;
        json!({
            "order": order_json,
            "changed": blocks,
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
            "paste" => e.paste(s("text")),
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
            "setLink" => e.set_link(s("href")),
            "linkAt" => {
                let link = e.link_at(n("offset")).map(
                    |(range, href)| json!({ "start": range.start, "end": range.end, "href": href }),
                );
                return json!({ "ok": true, "link": link });
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
            "toggleQuote" => e.toggle_quote(),
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
            "wordLeft" => {
                e.move_word_left(extend);
                false
            }
            "wordRight" => {
                e.move_word_right(extend);
                false
            }
            "deleteWordBack" => e.delete_word_backward(),
            "deleteWordForward" => e.delete_word_forward(),
            "home" => {
                e.move_home(extend);
                false
            }
            "end" => {
                e.move_end(extend);
                false
            }
            "resetView" => {
                // The UI lost its copy (hot restart): the next view is complete.
                self.sent.clear();
                self.sent_order.clear();
                return json!({ "ok": true });
            }
            "find" => {
                let matches: Vec<Value> = e
                    .find(s("query"), cmd["caseSensitive"].as_bool().unwrap_or(false))
                    .into_iter()
                    .map(|r| json!([r.start, r.end]))
                    .collect();
                return json!({ "ok": true, "matches": matches });
            }
            "replaceMatches" => {
                let ranges: Vec<std::ops::Range<usize>> = cmd["ranges"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|r| Some(r[0].as_u64()? as usize..r[1].as_u64()? as usize))
                            .collect()
                    })
                    .unwrap_or_default();
                e.replace_matches(&ranges, s("text"))
            }
            "copyMarkdown" => return json!({ "ok": true, "text": e.selection_markdown() }),
            "setUser" => {
                self.user.name = s("name").to_owned();
                if let Some(color) = cmd["color"].as_str() {
                    self.user.color = color.to_owned();
                }
                return json!({ "ok": true });
            }
            "presence" => {
                // Our caret and name, to everyone through the hub.
                let update = self.presence.publish(&self.editor, &self.user);
                return match self.shared.borrow().hub.push_presence(&update) {
                    Ok(()) => json!({ "ok": true }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            "carets" => {
                if let Err(err) = self.presence.apply(&self.shared.borrow().hub.presence()) {
                    return json!({ "ok": false, "error": err });
                }
                let carets: Vec<Value> = self
                    .presence
                    .carets(&self.editor)
                    .into_iter()
                    .map(|c| {
                        let (name, color) = c
                            .user
                            .map(|u| (Some(u.name), Some(u.color)))
                            .unwrap_or_default();
                        json!({
                            "peer": c.peer, "name": name, "color": color,
                            "anchor": c.anchor, "head": c.head,
                            // A string: a u64 does not fit a Dart int.
                            "moved": c.moved.to_string(),
                        })
                    })
                    .collect();
                return json!({ "ok": true, "carets": carets });
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
pub unsafe extern "C" fn cd_view(session: *mut Session) -> *mut c_char {
    to_c(unsafe { &mut *session }.view())
}

/// # Safety
/// `s` comes from this library and is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

impl Drop for Session {
    /// A closed pane's caret goes away at once rather than timing out.
    fn drop(&mut self) {
        let _ = self
            .shared
            .borrow()
            .hub
            .push_presence(&self.presence.leave());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(s: &mut Session, cmd: Value) -> Value {
        s.call(&cmd)
    }

    /// Every block, in order (a view after a reset sends them all).
    fn all_blocks(s: &mut Session) -> Vec<Value> {
        call(s, json!({"op": "resetView"}));
        s.view()["changed"].as_array().unwrap().clone()
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
        let blocks = all_blocks(&mut peer);
        assert_eq!(blocks[0]["text"], "Hello");
        assert_eq!(blocks[0]["spans"][0], json!([0, 5, 1, ""]));
        assert_eq!(blocks[1]["text"], "world");
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
        let blocks = all_blocks(&mut s);
        assert_eq!(blocks[1]["list"], "task");
        assert_eq!(blocks[1]["listDepth"], 2);
        assert_eq!(blocks[1]["checked"], true);
    }

    #[test]
    fn views_send_only_what_changed() {
        let mut s = Session::open(None).unwrap();
        call(&mut s, json!({"op": "insert", "text": "one\ntwo\nthree"}));
        let first = s.view();
        assert_eq!(first["order"].as_array().unwrap().len(), 3);
        assert_eq!(first["changed"].as_array().unwrap().len(), 3);

        // Typing in one block: that block only, and no order.
        call(&mut s, json!({"op": "select", "anchor": 1, "head": 1}));
        call(&mut s, json!({"op": "insert", "text": "x"}));
        let typed = s.view();
        assert!(typed["order"].is_null());
        assert_eq!(typed["changed"].as_array().unwrap().len(), 1);
        assert_eq!(typed["changed"][0]["text"], "oxne");

        // Nothing changed: nothing sent.
        assert_eq!(s.view()["changed"].as_array().unwrap().len(), 0);

        // Enter: the new block plus the split one, and the new order.
        call(&mut s, json!({"op": "newline"}));
        let split = s.view();
        assert_eq!(split["order"].as_array().unwrap().len(), 4);
        assert_eq!(split["changed"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn link_commands() {
        let mut s = Session::open(None).unwrap();
        call(&mut s, json!({"op": "insert", "text": "see docs"}));
        call(&mut s, json!({"op": "select", "anchor": 4, "head": 8}));
        assert_eq!(
            call(&mut s, json!({"op": "setLink", "href": "https://loro.dev"}))["changed"],
            true
        );
        let found = call(&mut s, json!({"op": "linkAt", "offset": 5}));
        assert_eq!(
            found["link"],
            json!({"start": 4, "end": 8, "href": "https://loro.dev"})
        );
        assert!(call(&mut s, json!({"op": "linkAt", "offset": 1}))["link"].is_null());
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

    #[test]
    fn markdown_goes_through_the_clipboard_ops() {
        let mut s = Session::open(None).unwrap();
        call(
            &mut s,
            json!({"op": "paste", "text": "# Title\n\n- one\n- two"}),
        );
        call(&mut s, json!({"op": "selectAll"}));
        let copied = call(&mut s, json!({"op": "copyMarkdown"}));
        assert_eq!(copied["text"], "# Title\n\n- one\n- two");
    }

    #[test]
    fn carets_go_through_the_hub() {
        let mut me = Session::open(None).unwrap();
        let mut peer = me.fork();
        call(&mut me, json!({"op": "insert", "text": "hello"}));
        call(&mut me, json!({"op": "push"}));
        call(&mut peer, json!({"op": "pull"}));
        call(
            &mut me,
            json!({"op": "setUser", "name": "Ana", "color": "#ff0000"}),
        );
        call(&mut me, json!({"op": "select", "anchor": 1, "head": 4}));
        call(&mut me, json!({"op": "presence"}));
        call(&mut peer, json!({"op": "presence"}));
        let carets = call(&mut peer, json!({"op": "carets"}))["carets"].clone();
        assert_eq!(carets.as_array().unwrap().len(), 1);
        assert_eq!(carets[0]["name"], "Ana");
        assert_eq!(carets[0]["color"], "#ff0000");
        assert_eq!(
            (carets[0]["anchor"].clone(), carets[0]["head"].clone()),
            (json!(1), json!(4))
        );
        assert_eq!(
            call(&mut me, json!({"op": "carets"}))["carets"][0]["name"],
            "You"
        );

        // Closing a session takes its caret away.
        drop(me);
        assert!(
            call(&mut peer, json!({"op": "carets"}))["carets"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
