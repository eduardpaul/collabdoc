//! HTML on the clipboard: what copy writes, and what paste makes of HTML
//! from us, from the Tiptap app and from other editors.

use collabdoc_core::markdown::looks_like_mermaid;
use collabdoc_core::schema::mark_bit;
use collabdoc_core::{BlockKind, Document, Editor, ListKind};

fn editor() -> Editor {
    Editor::new(Document::create("t", "me"))
}

/// `(kind, list, depth, quote, text)` per block.
type Shape = (BlockKind, Option<ListKind>, u8, u8, String);
fn shape(e: &Editor) -> Vec<Shape> {
    e.blocks()
        .iter()
        .map(|b| (b.kind, b.list, b.list_depth, b.quote_depth, b.text.clone()))
        .collect()
}

fn p(text: &str) -> Shape {
    (BlockKind::Paragraph, None, 0, 0, text.into())
}

fn bit(name: &str) -> u32 {
    mark_bit(name).unwrap()
}

/// `(start, end, marks)` of a block's spans.
fn marks(e: &Editor, block: usize) -> Vec<(u32, u32, u32)> {
    e.blocks()[block]
        .spans
        .iter()
        .map(|s| (s.start, s.end, s.marks))
        .collect()
}

fn pasted(html: &str) -> Editor {
    let mut e = editor();
    assert!(e.paste_html(html, "fallback"), "{html}");
    e
}

#[test]
fn copy_writes_tiptap_html() {
    let mut e = editor();
    e.insert_text("Plan\nBold & <b>\none\nnested\ndone\nquoted");
    e.move_to(0);
    e.set_kind(BlockKind::Heading(2));
    let line = e.block_start(1);
    e.set_selection(line, line + 4);
    e.toggle_mark(bit("bold"));
    e.set_selection(e.block_start(2), e.block_start(3));
    e.toggle_list(ListKind::Bullet);
    let nested = e.block_start(3);
    e.move_to(nested);
    e.indent();
    let task = e.block_start(4);
    e.move_to(task);
    e.toggle_list(ListKind::Task);
    e.toggle_task(4);
    let quoted = e.block_start(5);
    e.move_to(quoted);
    e.toggle_quote();
    e.select_all();
    assert_eq!(
        e.selection_html(),
        "<meta charset=\"utf-8\"><h2>Plan</h2>\
         <p><strong>Bold</strong> &amp; &lt;b&gt;</p>\
         <ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul>\
         <ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><p>done</p></li></ul>\
         <blockquote><p>quoted</p></blockquote>"
    );
}

#[test]
fn copy_then_paste_html_round_trips() {
    let mut source = editor();
    source.paste(
        "## Title\n\n**Bold**, *it*, ~~gone~~, ==hi==, <u>under</u>, `code` and [a link](https://loro.dev).\n\n\
         1. first\n2. second\n   - inner\n\n* [x] done\n* [ ] todo\n\n> quoted\n\n```\nlet x = 1;\n```",
    );
    source.select_all();
    let html = source.selection_html();
    let target = pasted(&html);
    assert_eq!(shape(&target), shape(&source), "{html}");
    for i in 0..source.blocks().len() {
        assert_eq!(
            target.blocks()[i].spans,
            source.blocks()[i].spans,
            "block {i}"
        );
        assert_eq!(target.blocks()[i].checked, source.blocks()[i].checked);
    }
}

#[test]
fn google_docs_html_keeps_its_styling() {
    let html = r#"<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">
        <h1 dir="ltr"><span style="font-size:20pt;font-weight:400;">Title</span></h1>
        <p dir="ltr"><span style="font-weight:700;">Bold</span><span style="font-weight:400;"> and </span><span style="font-style:italic;font-weight:400;">italic</span><span> </span><a href="https://x.y"><span style="text-decoration:underline;">link</span></a><span style="vertical-align:super;">2</span></p>
        <ul><li dir="ltr"><p dir="ltr"><span>one</span></p></li><li><p><span>two</span></p><ul><li><p>nested</p></li></ul></li></ul>
        </b><br class="Apple-interchange-newline">"#;
    let e = pasted(html);
    assert_eq!(
        shape(&e),
        [
            (BlockKind::Heading(1), None, 0, 0, "Title".into()),
            p("Bold and italic link2"),
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                1,
                0,
                "one".into()
            ),
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                1,
                0,
                "two".into()
            ),
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                2,
                0,
                "nested".into()
            ),
        ]
    );
    assert!(
        marks(&e, 0).is_empty(),
        "the normal-weight wrapper is not bold"
    );
    assert_eq!(
        marks(&e, 1),
        [
            (0, 4, bit("bold")),
            (9, 15, bit("italic")),
            (16, 20, bit("link") | bit("underline")),
            (20, 21, bit("superscript")),
        ]
    );
    assert_eq!(e.blocks()[1].spans[2].href, "https://x.y");
}

#[test]
fn whitespace_collapses_and_scripts_and_styles_are_skipped() {
    let e = pasted(
        "<style>p { color: red }</style><p>\n  a\n   b  </p>\
         <script>if (a<b) { x() }</script><div>c <i>d</i></div>",
    );
    assert_eq!(shape(&e), [p("a b"), p("c d")]);
}

#[test]
fn tiptap_task_lists_and_unclosed_items() {
    let e = pasted(
        r#"<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li><li data-type="taskItem" data-checked="false"><div><p>todo</p></div></li></ul>"#,
    );
    let tasks: Vec<_> = e.blocks().iter().map(|b| (b.list, b.checked)).collect();
    assert_eq!(
        tasks,
        [(Some(ListKind::Task), true), (Some(ListKind::Task), false)]
    );

    // Checkboxes in plain lists (GitHub's HTML) make tasks too.
    let e = pasted(r#"<ul><li><input type="checkbox" checked disabled> shipped</li></ul>"#);
    assert_eq!(
        (e.blocks()[0].list, e.blocks()[0].checked),
        (Some(ListKind::Task), true)
    );
    assert_eq!(e.blocks()[0].text, "shipped");

    let e = pasted("<ul><li>one<li>two</ul><p>after</p>");
    assert_eq!(
        shape(&e),
        [
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                1,
                0,
                "one".into()
            ),
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                1,
                0,
                "two".into()
            ),
            p("after"),
        ]
    );
}

#[test]
fn code_blocks_keep_their_lines_and_mermaid_becomes_a_diagram() {
    let e = pasted(
        "<pre><code class=\"language-rust\">fn main() {\n    x &lt; 1;\n}\n</code></pre>\
         <pre><code class=\"language-mermaid\">graph TD; A--&gt;B</code></pre>",
    );
    assert_eq!(e.blocks()[0].kind, BlockKind::CodeBlock);
    assert_eq!(e.blocks()[0].text, "fn main() {\n    x < 1;\n}");
    assert_eq!(e.blocks()[1].node_name, "mermaidFigure");
}

#[test]
fn breaks_and_rules() {
    let e = pasted("<p>one<br>two</p><hr><p>three<br></p>");
    let names: Vec<_> = e.blocks().iter().map(|b| b.node_name.as_str()).collect();
    assert_eq!(names, ["paragraph", "horizontalRule", "paragraph"]);
    // A `<br>` is a hard break, except at the end of its block.
    assert_eq!(e.blocks()[0].text, "one\u{FFFC}two");
    assert_eq!(e.blocks()[0].inlines[0].name, "hardBreak");
    assert_eq!(e.blocks()[2].text, "three");
    assert!(e.blocks()[2].inlines.is_empty());
}

#[test]
fn mention_chips_paste_and_copy_as_tiptap_spans() {
    let html = "<p>Ask <span data-type=\"mention\" data-kind=\"agent\" data-id=\"a1\" \
                data-handle=\"writer\" data-label=\"Writer\" class=\"mention\">\
                <span class=\"mention__text\">@Writer</span></span> now</p>";
    let mut e = pasted(html);
    let b = &e.blocks()[0];
    assert_eq!(b.text, "Ask \u{FFFC} now");
    assert_eq!(b.inlines.len(), 1);
    let m = &b.inlines[0];
    assert_eq!((m.at, m.name.as_str()), (4, "mention"));
    assert_eq!(m.attr("handle"), "writer");
    assert_eq!(m.attr("kind"), "agent");
    assert_eq!(b.plain_text(), "Ask @writer now");

    e.select_all();
    let copied = e.selection_html();
    assert!(copied.contains("data-type=\"mention\""), "{copied}");
    assert!(copied.contains("data-handle=\"writer\""), "{copied}");
    assert_eq!(e.selection_markdown(), "Ask @writer now");

    // Pasted back into a fresh document, the chip survives.
    let again = pasted(&copied);
    assert_eq!(again.blocks()[0].inlines, e.blocks()[0].inlines);
}

#[test]
fn inside_a_list_html_falls_back_to_the_plain_text() {
    let mut e = editor();
    e.insert_text("item");
    e.toggle_list(ListKind::Bullet);
    let end = e.len();
    e.move_to(end);
    assert!(e.paste_html("<h1>A</h1><p>B</p>", "A\nB"));
    let texts: Vec<_> = e.blocks().iter().map(|b| b.text.clone()).collect();
    assert_eq!(texts, ["itemA", "B"], "the text, never the markup");
}

#[test]
fn html_with_one_paragraph_pastes_inline() {
    let mut e = editor();
    e.insert_text("ab");
    e.move_to(1);
    assert!(e.paste_html("<meta charset=utf-8><span><b>X</b></span>", "X"));
    assert_eq!(shape(&e), [p("aXb")]);
    assert_eq!(marks(&e, 0), [(1, 2, bit("bold"))]);
}

#[test]
fn mermaid_source_is_recognised_and_inserted_as_a_diagram() {
    assert!(looks_like_mermaid("flowchart LR\n  A --> B"));
    assert!(looks_like_mermaid("  graph TD\nA-->B"));
    assert!(!looks_like_mermaid("graphs are nice"));
    assert!(!looks_like_mermaid("```mermaid\ngraph TD\n```"));
    assert!(!looks_like_mermaid("Some text\ngraph TD"));
    let mut e = editor();
    e.insert_text("before");
    assert!(e.insert_mermaid("graph TD\n  A --> B\n"));
    let names: Vec<_> = e.blocks().iter().map(|b| b.node_name.as_str()).collect();
    assert_eq!(names, ["paragraph", "mermaidFigure"]);
}

#[test]
fn code_copied_from_an_editor_keeps_its_indentation() {
    // VS Code's HTML: one div per line, spaces kept by style.
    let e = pasted(
        r#"<div style="color: #d4d4d4;white-space: pre;"><div><span style="color: #569cd6;">fn</span> main() {</div><div>    <span>run</span>();</div><div>}</div></div>"#,
    );
    let texts: Vec<_> = e.blocks().iter().map(|b| b.text.clone()).collect();
    assert_eq!(texts, ["fn main() {", "    run();", "}"]);
}

#[test]
fn spacing_ends_with_its_own_element() {
    // Spaces kept inside the styled div, collapsed again after it, however
    // the divs nest.
    let e = pasted(
        r#"<div><div style="white-space:pre"><div>  a</div></div><div>  b</div></div><p>  c</p>"#,
    );
    let texts: Vec<_> = e.blocks().iter().map(|b| b.text.clone()).collect();
    assert_eq!(texts, ["  a", "b", "c"]);
}
