// The document editor: draws the core's blocks as rich text and turns keys,
// mouse and platform text input (IME) into commands for the Rust Editor.
//
// Like the GPUI build, this file only maps between pixels and the core's
// global UTF-16 offsets; typing, Enter/Backspace, marks, block kinds, undo
// and sync are decided in Rust.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:super_sliver_list/super_sliver_list.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app.dart';
import 'clipboard.dart';
import 'figures.dart';
import 'find_bar.dart';
import 'model.dart';
import 'native.dart';
import 'settings.dart';
import 'theme.dart';
import 'workspace.dart';

class EditorPane extends StatefulWidget {
  const EditorPane({
    super.key,
    required this.app,
    required this.workspace,
    required this.participant,
    this.autofocus = false,
    this.version,
    this.live,
  });

  final AppController app;
  final Workspace workspace;
  final Participant participant;
  final bool autofocus;

  /// Set when this pane shows a past version (read-only) for [live].
  final VersionView? version;
  final Participant? live;

  bool get readOnly => version != null;

  @override
  State<EditorPane> createState() => EditorPaneState();
}

class EditorPaneState extends State<EditorPane>
    implements DeltaTextInputClient {
  late ViewState view;
  final FocusNode focus = FocusNode(debugLabel: 'editor');
  final ScrollController scroll = ScrollController();
  final ListController list = ListController();
  List<GlobalKey> _keys = [];

  TextInputConnection? _input;
  TextEditingValue _sent = TextEditingValue.empty;
  int _sentBlockStart = 0;

  /// IME composition (global UTF-16), underlined while it lasts.
  TextRange _composing = TextRange.empty;

  /// Column kept across consecutive Up/Down presses.
  double? _goalX;
  bool _selecting = false;
  Offset? _dragAt;
  Timer? _autoscroll;
  final GlobalKey _viewportKey = GlobalKey(debugLabel: 'viewport');
  int _clicks = 0;
  Duration _lastClick = Duration.zero;
  Offset _lastClickAt = Offset.zero;

  /// Other participants' carets, and what we last told them about ours.
  List<RemoteCaret> _carets = const [];
  (int, int)? _published;
  Timer? _presenceCooldown;
  bool _presencePending = false;
  Timer? _heartbeat;

  /// Find bar: open or not, matches (global ranges) and the current one.
  bool _findOpen = false;
  final GlobalKey<FindBarState> _findBar = GlobalKey();
  String _query = '';
  bool _caseSensitive = false;
  List<(int, int)> _matches = const [];
  int _matchIndex = 0;

  @visibleForTesting
  List<(int, int)> get matches => _matches;

  @visibleForTesting
  int get matchIndex => _matchIndex;

  /// Per peer: the last caret position seen, and how long its name shows.
  final Map<String, (String, Timer)> _flags = {};

  /// Claimed blocks by `blockId`: who and their color (AC-07.6), ours
  /// included; and a timer for when the first claim runs out.
  Map<String, (String, int)> _claims = const {};
  Claim? _ownClaim;
  Timer? _claimEnds;

  @visibleForTesting
  Map<String, (String, int)> get claims => _claims;

  Session get session => widget.participant.session;

  @visibleForTesting
  List<RemoteCaret> get carets => _carets;

  @override
  void initState() {
    super.initState();
    view = session.view();
    _readCarets();
    widget.workspace.historyVersion.addListener(_authorsChanged);
    widget.workspace.addListener(_attributionToggled);
    _readAuthors();
    focus.addListener(_focusChanged);
    widget.participant.remoteVersion.addListener(_remoteChanged);
    widget.participant.presenceVersion.addListener(_caretsChanged);
    // Presence expires unless refreshed; this also drops carets of peers
    // that went quiet.
    _heartbeat = Timer.periodic(const Duration(milliseconds: _heartbeatMs), (
      _,
    ) {
      _published = null;
      _schedulePresence();
      _caretsChanged();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _schedulePresence();
    });
    // A new pane (a peer just added) takes the keyboard, like a new window.
    if (widget.autofocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) focus.requestFocus();
      });
    }
  }

  @override
  void didUpdateWidget(EditorPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.participant, widget.participant)) {
      oldWidget.participant.remoteVersion.removeListener(_remoteChanged);
      oldWidget.participant.presenceVersion.removeListener(_caretsChanged);
      widget.participant.remoteVersion.addListener(_remoteChanged);
      widget.participant.presenceVersion.addListener(_caretsChanged);
      view = session.view();
      _readCarets();
      _published = null;
    }
  }

  @override
  void dispose() {
    widget.workspace.historyVersion.removeListener(_authorsChanged);
    widget.workspace.removeListener(_attributionToggled);
    _authorsSettle?.cancel();
    widget.participant.remoteVersion.removeListener(_remoteChanged);
    widget.participant.presenceVersion.removeListener(_caretsChanged);
    _heartbeat?.cancel();
    _claimEnds?.cancel();
    for (final (_, timer) in _flags.values) {
      timer.cancel();
    }
    _autoscroll?.cancel();
    _presenceCooldown?.cancel();
    _input?.close();
    focus.dispose();
    scroll.dispose();
    list.dispose();
    super.dispose();
  }

  // ── Attribution gutter (AC-05.9) ─────────────────────────────────────

  /// Each block's last author's color, by `blockId`, while the gutter is on.
  Map<String, Color> _authorColors = const {};
  bool _attributionShown = false;
  Timer? _authorsSettle;

  void _readAuthors() {
    if (!widget.workspace.attribution) {
      _authorColors = const {};
      return;
    }
    final reply = session.call({'op': 'blockAuthors'});
    final authors = (reply['authors'] as Map?) ?? const {};
    _authorColors = {
      for (final MapEntry(:key, :value) in authors.entries)
        key as String: Color(parseHexColor((value as Map)['color'] as String)),
    };
  }

  void _authorsChanged() {
    if (!widget.workspace.attribution) return;
    _authorsSettle?.cancel();
    _authorsSettle = Timer(const Duration(milliseconds: 400), () {
      if (mounted) setState(_readAuthors);
    });
  }

  void _attributionToggled() {
    if (widget.workspace.attribution == _attributionShown || !mounted) return;
    _attributionShown = widget.workspace.attribution;
    setState(_readAuthors);
  }

  // ── Commands ─────────────────────────────────────────────────────────

  /// Runs a command; edits are broadcast to the other participants.
  void run(Map<String, Object?> command) {
    final changed = session.edit(command);
    if (changed) widget.workspace.broadcast(widget.participant);
    _goalX = null;
    _refresh(reveal: true);
  }

  void _remoteChanged() {
    if (mounted) _refresh();
  }

  void _refresh({bool reveal = false}) {
    setState(() {
      view = session.view();
      // The text changed under the matches: find them again.
      if (_findOpen) _findMatches();
      // Text moved under the others' cursors: where they point now.
      _readCarets();
    });
    _syncInput();
    if (_published != (view.anchor, view.head)) _schedulePresence();
    if (reveal) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _revealCaret());
    }
  }

  // ── Find and replace ─────────────────────────────────────────────────

  void _openFind({bool replace = false}) {
    setState(() => _findOpen = true);
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _findBar.currentState?.focusField(replace: replace),
    );
  }

  void _closeFind() {
    setState(() {
      _findOpen = false;
      _matches = const [];
    });
    focus.requestFocus();
  }

  void _findMatches() {
    if (_query.isEmpty) {
      _matches = const [];
      return;
    }
    final reply = session.call({
      'op': 'find',
      'query': _query,
      'caseSensitive': _caseSensitive,
    });
    _matches = [
      for (final m in reply['matches'] as List)
        ((m as List)[0] as int, m[1] as int),
    ];
    if (_matchIndex >= _matches.length) _matchIndex = 0;
  }

  /// The first match at or after `offset` (wrapping round).
  int _matchFrom(int offset) {
    final i = _matches.indexWhere((m) => m.$1 >= offset);
    return i < 0 ? 0 : i;
  }

  /// Selects the current match and scrolls to it.
  void _showMatch() {
    if (_matches.isEmpty) return;
    final (start, end) = _matches[_matchIndex];
    _select(start, end);
  }

  void _search(String query, bool caseSensitive) {
    _query = query;
    _caseSensitive = caseSensitive;
    setState(() {
      _findMatches();
      _matchIndex = _matchFrom(view.selectionStart);
    });
    _showMatch();
  }

  void _step(int delta) {
    if (_matches.isEmpty) return;
    setState(() {
      _matchIndex = (_matchIndex + delta) % _matches.length;
    });
    _showMatch();
  }

  void _replace(String text, {required bool all}) {
    if (_matches.isEmpty) return;
    final ranges = all ? _matches : [_matches[_matchIndex]];
    run({
      'op': 'replaceMatches',
      'ranges': [
        for (final (s, e) in ranges) [s, e],
      ],
      'text': text,
    });
    // Go on from the caret, which is after the replacement.
    setState(() => _matchIndex = _matchFrom(view.head));
    if (!all) _showMatch();
  }

  /// Re-reads the others' carets; a caret that moved shows its name for 2 s.
  void _readCarets() {
    _carets = session.carets();
    _readClaims();
    for (final c in _carets) {
      final seen = _flags[c.peer];
      if (seen != null && seen.$1 == c.moved) continue;
      seen?.$2.cancel();
      _flags[c.peer] = (
        c.moved,
        Timer(const Duration(seconds: 2), () {
          if (mounted) setState(() {});
        }),
      );
    }
  }

  void _caretsChanged() {
    if (mounted) setState(_readCarets);
  }

  /// Who claims which block; re-read when the first claim runs out.
  void _readClaims() {
    _ownClaim = widget.readOnly ? null : session.myClaim();
    final me = widget.participant;
    final claims = <String, (String, int)>{};
    final ends = <DateTime>[];
    for (final (name, color, claim) in [
      if (_ownClaim case final own?) ('You', parseHexColor(me.color), own),
      for (final c in _carets)
        if (c.claim case final claim? when claim.live) (c.name, c.color, claim),
    ]) {
      ends.add(claim.until);
      for (final id in claim.blockIds) {
        claims.putIfAbsent(id, () => (name, color));
      }
    }
    _claims = claims;
    _claimEnds?.cancel();
    _claimEnds = null;
    if (ends.isNotEmpty) {
      final first = ends.reduce((a, b) => a.isBefore(b) ? a : b);
      _claimEnds = Timer(
        first.difference(DateTime.now()) + const Duration(milliseconds: 20),
        _caretsChanged,
      );
    }
  }

  /// Ctrl+Alt+L: claim the blocks the selection touches for 30 s (others
  /// see an outline with our name), or give them up.
  void _toggleClaim() {
    if (session.myClaim() != null) {
      session.unclaim();
    } else if (session.claim() == null) {
      return;
    }
    _published = null;
    _presenceCooldown?.cancel();
    _presenceCooldown = null;
    _schedulePresence();
    setState(_readClaims);
  }

  static const _heartbeatMs = 5000;

  /// Tells the others where our caret is, as often as the core's pace
  /// allows: at most 20 a second and 2 KB/s (about every 100 ms).
  void _schedulePresence() {
    if (_presenceCooldown != null) {
      _presencePending = true;
      return;
    }
    _published = (view.anchor, view.head);
    final gap = widget.workspace.publishPresence(widget.participant);
    _presenceCooldown = Timer(Duration(milliseconds: gap), () {
      _presenceCooldown = null;
      if (_presencePending && mounted) {
        _presencePending = false;
        _schedulePresence();
      }
    });
  }

  void _select(int anchor, int head) {
    session.call({'op': 'select', 'anchor': anchor, 'head': head});
    _refresh(reveal: true);
  }

  void _revealCaret() {
    final i = view.blockAt(view.head);
    if (i >= _keys.length) return;
    final context = _keys[i].currentContext;
    if (context == null) {
      // Not built (far off screen): bring its item into view first.
      if (list.isAttached) {
        list.jumpToItem(index: i + 1, scrollController: scroll, alignment: 0.5);
      }
      return;
    }
    Scrollable.ensureVisible(
      context,
      duration: Duration.zero,
      alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
    );
    Scrollable.ensureVisible(
      context,
      duration: Duration.zero,
      alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtStart,
    );
  }

  /// Copies the selection as Markdown text and as HTML.
  Future<void> _copy({bool cut = false}) async {
    if (view.selectionStart == view.selectionEnd) return;
    final reply = session.call({'op': 'copy'});
    await RichClipboard.write(reply['text'] as String, reply['html'] as String);
    if (cut) run({'op': 'insert', 'text': ''});
  }

  /// Ctrl+V, in the TS app's order: Mermaid source asks whether it is a
  /// diagram; HTML becomes blocks and marks; text that looks like Markdown
  /// too; anything else is typed. Ctrl+Shift+V types the text as is.
  Future<void> _paste({bool plain = false}) async {
    final text = (await RichClipboard.readText())?.replaceAll('\r\n', '\n');
    if (!mounted) return;
    if (plain) {
      if (text != null) run({'op': 'insert', 'text': text});
      return;
    }
    if (text != null &&
        session.call({'op': 'looksLikeMermaid', 'text': text})['mermaid'] ==
            true) {
      final diagram = await showDialog<bool>(
        context: context,
        builder: (context) => const _MermaidDialog(),
      );
      if (!mounted || diagram == null) return;
      focus.requestFocus();
      run(
        diagram
            ? {'op': 'insertMermaid', 'source': text}
            : {'op': 'insert', 'text': text},
      );
      return;
    }
    final html = await RichClipboard.readHtml();
    if (!mounted) return;
    // An image (a screenshot, an image copied in a browser, whose HTML only
    // points at it) goes in as an image figure.
    if (text == null || text.trim().isEmpty || html?.contains('<img') == true) {
      final image = await RichClipboard.readImage();
      if (!mounted) return;
      if (image != null && !(html?.contains('data:image/') ?? false)) {
        _insertImage({'base64': base64Encode(image)});
        return;
      }
    }
    if (html != null) {
      run({'op': 'pasteHtml', 'html': html, 'text': text ?? ''});
    } else if (text != null) {
      run({'op': 'paste', 'text': text});
    }
  }

  /// Insert image… (Ctrl+Alt+P): a PNG, JPEG, GIF, WebP or SVG file.
  Future<void> _pickImage() async {
    final file = await widget.app.pickImagePath();
    if (!mounted || file == null) return;
    focus.requestFocus();
    _insertImage({'path': file});
  }

  /// Inserts an image from `source` (`path` or `base64`); a refusal (too
  /// big, not an image) shows in the status bar.
  void _insertImage(Map<String, Object?> source) {
    final reply = session.call({'op': 'insertImage', ...source});
    if (reply['ok'] != true) {
      widget.workspace.setStatus('${reply['error']}');
      return;
    }
    if (reply['changed'] == true) {
      widget.workspace.broadcast(widget.participant);
    }
    _refresh(reveal: true);
  }

  FigureActions _figureActions(int i) => FigureActions(
    caption: () => _editFigureText(i, caption: true),
    source: () => _editFigureText(i, caption: false),
    width: (percent) => run({
      'op': 'setFigureAttr',
      'block': i,
      'key': 'width',
      'value': percent,
    }),
    align: (align) => run({
      'op': 'setFigureAttr',
      'block': i,
      'key': 'align',
      'value': align,
    }),
  );

  /// The figure's caption, or a diagram's source, in a dialog.
  Future<void> _editFigureText(int i, {required bool caption}) async {
    final b = view.blocks[i];
    final text = await showDialog<String>(
      context: context,
      builder: (context) => _TextDialog(
        title: caption ? 'Caption' : 'Diagram source',
        initial: caption ? b.caption : b.attr('source'),
        multiline: !caption,
      ),
    );
    if (!mounted) return;
    focus.requestFocus();
    if (text == null) return;
    run(
      caption
          ? {'op': 'setCaption', 'block': i, 'text': text}
          : {'op': 'setFigureAttr', 'block': i, 'key': 'source', 'value': text},
    );
  }

  /// @: a chip for one of the people on the document. After a typed `@`
  /// (`replacingAt`), the chip takes the `@`'s place; dismissed, it stays.
  Future<void> _mention({bool replacingAt = false}) async {
    // Everyone on the document, offline collaborators too (AC-07.9).
    final people = session.people().everyone;
    final picked = await showDialog<Person>(
      context: context,
      builder: (context) => SimpleDialog(
        backgroundColor: AppColors.panel,
        title: const Text(
          'Mention',
          style: TextStyle(fontFamily: uiFont, fontSize: 15),
        ),
        children: [
          for (final p in people)
            SimpleDialogOption(
              key: ValueKey('mention-${p.name}'),
              onPressed: () => Navigator.of(context).pop(p),
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: p.name,
                      style: TextStyle(color: Color(p.color)),
                    ),
                    TextSpan(
                      text: '  @${p.handle}',
                      style: const TextStyle(color: AppColors.muted),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
    if (!mounted) return;
    focus.requestFocus();
    if (picked == null) return;
    final head = view.head;
    if (replacingAt &&
        view.selectionStart == view.selectionEnd &&
        head > 0 &&
        session.call({
              'op': 'textIn',
              'start': head - 1,
              'end': head,
            })['text'] ==
            '@') {
      session.call({'op': 'select', 'anchor': head - 1, 'head': head});
    }
    run({
      'op': 'insertMention',
      'attrs': {
        'kind': 'person',
        'id': picked.id,
        'handle': picked.handle,
        'label': picked.name,
      },
    });
  }

  /// Ctrl+K: edit the link on the selection or under the caret.
  Future<void> _editLink() async {
    final found = session.call({'op': 'linkAt', 'offset': view.selectionStart});
    final current = (found['link'] as Map?)?['href'] as String? ?? '';
    final href = await showDialog<String>(
      context: context,
      builder: (context) => _LinkDialog(initial: current),
    );
    if (!mounted) return;
    focus.requestFocus();
    if (href != null) run({'op': 'setLink', 'href': href.trim()});
  }

  /// Ctrl+click on a link opens it in the browser.
  Future<bool> _openLinkAt(int offset) async {
    final found = session.call({'op': 'linkAt', 'offset': offset});
    final href = (found['link'] as Map?)?['href'] as String?;
    final uri = href == null ? null : Uri.tryParse(href);
    if (uri == null ||
        !const {'http', 'https', 'mailto'}.contains(uri.scheme)) {
      return false;
    }
    await launchUrl(uri);
    return true;
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent) return KeyEventResult.ignored;
    // Keys a field inside the pane (the find bar) left unhandled bubble up
    // here; they are not for the document.
    if (!focus.hasPrimaryFocus) return KeyEventResult.ignored;
    final keys = HardwareKeyboard.instance;
    final ctrl = keys.isControlPressed || keys.isMetaPressed;
    final shift = keys.isShiftPressed;
    final alt = keys.isAltPressed;

    void op(String name, [Map<String, Object?> args = const {}]) =>
        run({'op': name, ...args});
    void kind(String k, [int level = 0]) =>
        op('setKind', {'kind': k, 'level': level});
    void mark(String m) => op('toggleMark', {'mark': m});

    // Ctrl+Shift+8/7/9 (Tiptap's list shortcuts): match the physical key,
    // since Shift turns the digit into a symbol on most layouts.
    if (ctrl && shift && !alt && !widget.readOnly) {
      final list = switch (event.physicalKey) {
        PhysicalKeyboardKey.digit8 => 'bullet',
        PhysicalKeyboardKey.digit7 => 'ordered',
        PhysicalKeyboardKey.digit9 => 'task',
        _ => null,
      };
      if (list != null) {
        op('toggleList', {'kind': list});
        return KeyEventResult.handled;
      }
      // Ctrl+Shift+B: quote (Tiptap's shortcut).
      if (event.logicalKey == LogicalKeyboardKey.keyB) {
        op('toggleQuote');
        return KeyEventResult.handled;
      }
    }

    final Map<LogicalKeyboardKey, void Function()> table;
    if (ctrl && alt) {
      table = {
        LogicalKeyboardKey.digit0: () => kind('paragraph'),
        LogicalKeyboardKey.digit1: () => kind('heading', 1),
        LogicalKeyboardKey.digit2: () => kind('heading', 2),
        LogicalKeyboardKey.digit3: () => kind('heading', 3),
        LogicalKeyboardKey.keyC: () => kind('code'),
        // The Tiptap app's figure shortcuts.
        LogicalKeyboardKey.keyM: () =>
            op('insertFigure', {'name': 'mermaidFigure'}),
        LogicalKeyboardKey.keyI: () =>
            op('insertFigure', {'name': 'infographicFigure'}),
        LogicalKeyboardKey.keyP: _pickImage,
        LogicalKeyboardKey.keyL: _toggleClaim,
      };
    } else if (ctrl) {
      table = {
        LogicalKeyboardKey.keyA: () => op('selectAll'),
        LogicalKeyboardKey.keyC: _copy,
        LogicalKeyboardKey.keyX: shift
            ? () => mark('strike')
            : () => _copy(cut: true),
        LogicalKeyboardKey.keyV: () => _paste(plain: shift),
        LogicalKeyboardKey.keyZ: () => op(shift ? 'redo' : 'undo'),
        LogicalKeyboardKey.keyY: () => op('redo'),
        LogicalKeyboardKey.keyB: () => mark('bold'),
        LogicalKeyboardKey.keyI: () => mark('italic'),
        LogicalKeyboardKey.keyU: () => mark('underline'),
        LogicalKeyboardKey.keyE: () => mark('code'),
        LogicalKeyboardKey.keyK: _editLink,
        LogicalKeyboardKey.keyF: _openFind,
        if (!shift) LogicalKeyboardKey.keyH: () => _openFind(replace: true),
        if (shift) LogicalKeyboardKey.keyH: () => mark('highlight'),
        LogicalKeyboardKey.keyS: () =>
            shift ? widget.app.saveAs(context) : widget.app.save(context),
        LogicalKeyboardKey.keyO: () => widget.app.openFile(context),
        LogicalKeyboardKey.keyN: () => shift
            ? widget.workspace.addPeer()
            : widget.app.newFromEditor(context),
        LogicalKeyboardKey.home: () => _select(0, 0),
        LogicalKeyboardKey.end: () => _select(view.length, view.length),
        LogicalKeyboardKey.arrowLeft: () => op('wordLeft', {'extend': shift}),
        LogicalKeyboardKey.arrowRight: () => op('wordRight', {'extend': shift}),
        LogicalKeyboardKey.backspace: () => op('deleteWordBack'),
        LogicalKeyboardKey.delete: () => op('deleteWordForward'),
      };
    } else {
      table = {
        LogicalKeyboardKey.backspace: () => op('backspace'),
        LogicalKeyboardKey.tab: () => op(shift ? 'outdent' : 'indent'),
        LogicalKeyboardKey.delete: () => op('delete'),
        // Shift+Enter: a line break inside the paragraph.
        LogicalKeyboardKey.enter: () => op(shift ? 'hardBreak' : 'newline'),
        LogicalKeyboardKey.numpadEnter: () =>
            op(shift ? 'hardBreak' : 'newline'),
        LogicalKeyboardKey.arrowLeft: () => op('left', {'extend': shift}),
        LogicalKeyboardKey.arrowRight: () => op('right', {'extend': shift}),
        LogicalKeyboardKey.home: () => _lineEdge(false, shift),
        LogicalKeyboardKey.end: () => _lineEdge(true, shift),
        LogicalKeyboardKey.arrowUp: () => _vertical(false, shift),
        LogicalKeyboardKey.arrowDown: () => _vertical(true, shift),
      };
    }
    // A viewed version: moving, selecting, copying and finding only.
    if (widget.readOnly) {
      final reading = {
        LogicalKeyboardKey.keyA,
        LogicalKeyboardKey.keyC,
        LogicalKeyboardKey.keyF,
        LogicalKeyboardKey.home,
        LogicalKeyboardKey.end,
        LogicalKeyboardKey.arrowLeft,
        LogicalKeyboardKey.arrowRight,
        LogicalKeyboardKey.arrowUp,
        LogicalKeyboardKey.arrowDown,
      };
      if (!reading.contains(event.logicalKey) || alt) {
        return KeyEventResult.handled;
      }
    }
    final action = table[event.logicalKey];
    // Printable keys go on to the platform text input (and its IME).
    if (action == null) return KeyEventResult.ignored;
    action();
    return KeyEventResult.handled;
  }

  // ── Geometry ─────────────────────────────────────────────────────────

  RenderParagraph? _paragraph(int i) => i < _keys.length
      ? _keys[i].currentContext?.findRenderObject() as RenderParagraph?
      : null;

  Rect? _globalRect(int i) {
    final p = _paragraph(i);
    if (p == null || !p.hasSize) return null;
    return p.localToGlobal(Offset.zero) & p.size;
  }

  /// The global offset under `global`. With `up`, a point between blocks
  /// belongs to the block above (for the Up key), otherwise to the one below.
  int _offsetAt(Offset global, {bool up = false}) {
    final rects = <(int, Rect)>[
      for (var i = 0; i < view.blocks.length; i++)
        if (_globalRect(i) case final r?) (i, r),
    ];
    if (rects.isEmpty) return 0;
    if (global.dy < rects.first.$2.top) return view.starts[rects.first.$1];
    final chosen = up
        ? rects.lastWhere(
            (e) => e.$2.top <= global.dy,
            orElse: () => rects.first,
          )
        : rects.firstWhere(
            (e) => global.dy <= e.$2.bottom,
            orElse: () => rects.last,
          );
    final (i, rect) = chosen;
    final y = global.dy.clamp(rect.top + 1, rect.bottom - 1);
    final p = _paragraph(i)!;
    final local = p.globalToLocal(Offset(global.dx, y));
    final pos = p
        .getPositionForOffset(local)
        .offset
        .clamp(0, view.blocks[i].text.length);
    return view.starts[i] + pos;
  }

  /// Caret position (global coordinates) and line height.
  (Offset, double)? _caret(int offset) {
    final i = view.blockAt(offset);
    final p = _paragraph(i);
    if (p == null || !p.hasSize) return null;
    final local = TextPosition(offset: offset - view.starts[i]);
    final at = p.getOffsetForCaret(local, Rect.zero);
    final height = p.getFullHeightForCaret(local);
    return (p.localToGlobal(at), height);
  }

  void _vertical(bool down, bool extend) {
    final caret = _caret(view.head);
    if (caret == null) return;
    final (p, lineHeight) = caret;
    final x = _goalX ?? p.dx;
    final y = down ? p.dy + lineHeight * 1.5 : p.dy - lineHeight * 0.5;
    final first = _globalRect(0);
    final last = _globalRect(view.blocks.length - 1);
    final int target;
    if (first != null && y < first.top) {
      target = 0;
    } else if (last != null && y > last.bottom) {
      target = view.length;
    } else {
      target = _offsetAt(Offset(x, y), up: !down);
    }
    // The next line may be in a block that is not built (off screen): step
    // to that block's edge instead of standing still.
    final i = view.blockAt(view.head);
    var to = target;
    if (down && to <= view.head && i + 1 < view.blocks.length) {
      to = view.starts[i + 1];
    } else if (!down && to >= view.head && i > 0) {
      to = view.starts[i - 1] + view.blocks[i - 1].text.length;
    }
    _select(extend ? view.anchor : to, to);
    _goalX = x;
  }

  /// Home/End: to the start or end of the line on screen, as in a browser,
  /// not of the whole (wrapped) block.
  void _lineEdge(bool end, bool extend) {
    final i = view.blockAt(view.head);
    final p = _paragraph(i);
    if (p == null || !p.hasSize) {
      run({'op': end ? 'end' : 'home', 'extend': extend});
      return;
    }
    final text = view.blocks[i].text;
    final caret = TextPosition(offset: view.head - view.starts[i]);
    // The caret's line on screen: hit-test its far left and right.
    final y =
        p.getOffsetForCaret(caret, Rect.zero).dy +
        p.getFullHeightForCaret(caret) / 2;
    final start = p.getPositionForOffset(Offset(0, y)).offset;
    var local = end
        ? p.getPositionForOffset(Offset(p.size.width, y)).offset
        : start;
    // At a soft wrap the line ends after its trailing space, which is where
    // the next line starts; stop before the space to stay on this line.
    if (end &&
        local < text.length &&
        local > start &&
        text.codeUnitAt(local - 1) == 0x20) {
      local--;
    }
    final to = view.starts[i] + local;
    _select(extend ? view.anchor : to, to);
    _goalX = null;
  }

  // ── Mouse ────────────────────────────────────────────────────────────

  void _pointerDown(PointerDownEvent e) {
    if (e.buttons != kPrimaryButton) return;
    focus.requestFocus();
    final offset = _offsetAt(e.position);
    final now = e.timeStamp;
    final near = (e.position - _lastClickAt).distance < 4;
    _clicks = (near && now - _lastClick < const Duration(milliseconds: 400))
        ? _clicks + 1
        : 1;
    _lastClick = now;
    _lastClickAt = e.position;
    final shift = HardwareKeyboard.instance.isShiftPressed;
    if (HardwareKeyboard.instance.isControlPressed && _clicks == 1) {
      _openLinkAt(offset);
    }
    if (shift) {
      _select(view.anchor, offset);
    } else if (_clicks >= 3) {
      final i = view.blockAt(offset);
      _select(view.starts[i], view.starts[i] + view.blocks[i].text.length);
    } else if (_clicks == 2) {
      _selectWord(offset);
    } else {
      _select(offset, offset);
    }
    _selecting = _clicks == 1;
    _goalX = null;
  }

  void _pointerMove(PointerMoveEvent e) {
    if (_selecting && e.buttons == kPrimaryButton) {
      _dragAt = e.position;
      _select(view.anchor, _offsetAt(_insideViewport(e.position)));
      if (_overshoot(e.position) != 0) {
        _autoscroll ??= Timer.periodic(
          const Duration(milliseconds: 16),
          (_) => _autoscrollTick(),
        );
      }
    }
  }

  void _pointerUp() {
    _selecting = false;
    _dragAt = null;
    _autoscroll?.cancel();
    _autoscroll = null;
  }

  Rect? get _viewport {
    final box = _viewportKey.currentContext?.findRenderObject() as RenderBox?;
    return box != null && box.hasSize
        ? box.localToGlobal(Offset.zero) & box.size
        : null;
  }

  /// How far `global` is above (negative) or below the visible list.
  double _overshoot(Offset global) {
    final r = _viewport;
    if (r == null) return 0;
    if (global.dy < r.top) return global.dy - r.top;
    if (global.dy > r.bottom) return global.dy - r.bottom;
    return 0;
  }

  /// `global` moved onto the visible list, so it hits a block on screen.
  Offset _insideViewport(Offset global) {
    final r = _viewport;
    if (r == null) return global;
    return Offset(global.dx, global.dy.clamp(r.top + 1, r.bottom - 1));
  }

  /// Dragging a selection past the top or bottom scrolls, faster the further
  /// out the pointer is, and the selection follows.
  void _autoscrollTick() {
    final at = _dragAt;
    final over = at == null ? 0.0 : _overshoot(at);
    if (!_selecting || over == 0 || !scroll.hasClients || !mounted) {
      _autoscroll?.cancel();
      _autoscroll = null;
      return;
    }
    final position = scroll.position;
    final target = (position.pixels + (over / 2).clamp(-40.0, 40.0)).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if (target == position.pixels) return;
    scroll.jumpTo(target);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_selecting || _dragAt == null) return;
      final head = _offsetAt(_insideViewport(_dragAt!));
      if (head != view.head) {
        session.call({'op': 'select', 'anchor': view.anchor, 'head': head});
        _refresh();
      }
    });
  }

  void _selectWord(int offset) {
    final i = view.blockAt(offset);
    final text = view.blocks[i].text;
    final isWord = RegExp(r'[\p{L}\p{N}_]', unicode: true);
    var a = offset - view.starts[i];
    var b = a;
    while (a > 0 && isWord.hasMatch(text[a - 1])) {
      a--;
    }
    while (b < text.length && isWord.hasMatch(text[b])) {
      b++;
    }
    _select(view.starts[i] + a, view.starts[i] + b);
  }

  // ── Platform text input (typing, IME) ────────────────────────────────

  void _focusChanged() {
    if (focus.hasFocus) {
      // Another field (the find bar) may have taken the platform input.
      if (_input?.attached != true) _input = null;
      _input ??= TextInput.attach(
        this,
        const TextInputConfiguration(
          inputType: TextInputType.multiline,
          inputAction: TextInputAction.newline,
          autocorrect: false,
          enableSuggestions: false,
          enableDeltaModel: true,
        ),
      );
      _input!.show();
      _syncInput();
    } else {
      _input?.close();
      _input = null;
    }
    setState(() {});
  }

  /// Tells the platform what the caret's block says, so IME has context.
  void _syncInput() {
    final input = _input;
    if (input == null || !input.attached) return;
    final i = view.blockAt(view.head);
    final start = view.starts[i];
    final text = view.blocks[i].text;
    int local(int g) => (g - start).clamp(0, text.length);
    _sentBlockStart = start;
    _sent = TextEditingValue(
      text: text,
      selection: TextSelection(
        baseOffset: local(view.anchor),
        extentOffset: local(view.head),
      ),
      composing: _composing.isValid
          ? TextRange(
              start: local(_composing.start),
              end: local(_composing.end),
            )
          : TextRange.empty,
    );
    input.setEditingState(_sent);
  }

  static final bool _traceInput =
      Platform.environment['COLLABDOC_TRACE_INPUT'] == '1';

  static String _describe(TextEditingValue v) =>
      '"${v.text}" sel=${v.selection.baseOffset}..${v.selection.extentOffset} '
      'comp=${v.composing.start}..${v.composing.end}';

  @override
  TextEditingValue? get currentTextEditingValue => _sent;

  @override
  AutofillScope? get currentAutofillScope => null;

  /// Platform input is asynchronous: a character can arrive after Dart has
  /// already moved the caret (an arrow key) or rewritten the block (a
  /// collaborator), i.e. relative to text we no longer show. Deltas carry the
  /// text they were made against, so a stale one is applied at the caret —
  /// where Flutter's own text field would put it — instead of being diffed
  /// against the wrong block.
  @override
  void updateEditingValueWithDeltas(List<TextEditingDelta> deltas) {
    var buffer = _sent.text;
    final base = _sentBlockStart;
    var inSync = true;
    for (final d in deltas) {
      final fresh = inSync && d.oldText == buffer;
      if (_traceInput) {
        debugPrint(
          'input ${widget.participant.name}: ${d.runtimeType} fresh=$fresh '
          'old="${d.oldText}" sent=${_describe(_sent)}',
        );
      }
      var inserted = '';
      switch (d) {
        case TextEditingDeltaInsertion():
          inserted = d.textInserted;
          if (fresh) {
            _edit(base + d.insertionOffset, base + d.insertionOffset, inserted);
          } else {
            _edit(view.selectionStart, view.selectionEnd, inserted);
          }
        case TextEditingDeltaDeletion():
          if (fresh) {
            _edit(base + d.deletedRange.start, base + d.deletedRange.end, '');
          }
        case TextEditingDeltaReplacement():
          inserted = d.replacementText;
          if (fresh) {
            _edit(
              base + d.replacedRange.start,
              base + d.replacedRange.end,
              inserted,
            );
          } else if (_composing.isValid) {
            _edit(_composing.start, _composing.end, inserted);
          } else {
            _edit(view.selectionStart, view.selectionEnd, inserted);
          }
        case TextEditingDeltaNonTextUpdate():
          if (fresh && d.selection.isValid) {
            session.call({
              'op': 'select',
              'anchor': base + d.selection.baseOffset,
              'head': base + d.selection.extentOffset,
            });
          }
      }
      _composing = fresh && d.composing.isValid && !d.composing.isCollapsed
          ? TextRange(
              start: base + d.composing.start,
              end: base + d.composing.end,
            )
          : TextRange.empty;
      buffer = d.apply(TextEditingValue(text: d.oldText)).text;
      // A line break splits the block: later deltas no longer map 1:1.
      inSync = fresh && !inserted.contains('\n');
      view = session.view();
    }
    _goalX = null;
    _refresh(reveal: true);
    // `@` opens the mention picker, as in the Tiptap app (not in code).
    final last = deltas.isEmpty ? null : deltas.last;
    final typedAt =
        last is TextEditingDeltaInsertion && last.textInserted == '@' ||
        last is TextEditingDeltaReplacement && last.replacementText == '@';
    if (typedAt &&
        !widget.readOnly &&
        !_composing.isValid &&
        view.blocks[view.blockAt(view.head)].kind != 'code') {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _mention(replacingAt: true);
      });
    }
  }

  void _edit(int start, int end, String text) {
    if (session.edit({
      'op': 'replace',
      'start': start,
      'end': end,
      'text': text,
    })) {
      widget.workspace.broadcast(widget.participant);
    }
  }

  /// Only used when the platform has no delta model; same staleness caveat.
  @override
  void updateEditingValue(TextEditingValue value) {
    final old = _sent.text;
    final now = value.text;
    final base = _sentBlockStart;
    if (old != now) {
      var p = 0;
      while (p < old.length &&
          p < now.length &&
          old.codeUnitAt(p) == now.codeUnitAt(p)) {
        p++;
      }
      var s = 0;
      while (s < old.length - p &&
          s < now.length - p &&
          old.codeUnitAt(old.length - 1 - s) ==
              now.codeUnitAt(now.length - 1 - s)) {
        s++;
      }
      _edit(base + p, base + old.length - s, now.substring(p, now.length - s));
    }
    _goalX = null;
    _refresh(reveal: true);
  }

  @override
  void performAction(TextInputAction action) {
    // Enter arrives as a key event (handled in _onKey); nothing to do here.
  }

  @override
  bool onFocusReceived() => focus.hasFocus;

  @override
  void connectionClosed() {
    _input = null;
  }

  @override
  void updateFloatingCursor(RawFloatingCursorPoint point) {}
  @override
  void showAutocorrectionPromptRect(int start, int end) {}
  @override
  void performPrivateCommand(String action, Map<String, dynamic> data) {}
  @override
  void insertTextPlaceholder(Size size) {}
  @override
  void removeTextPlaceholder() {}
  @override
  void showToolbar() {}
  @override
  void didChangeInputControl(
    TextInputControl? oldControl,
    TextInputControl? newControl,
  ) {}
  @override
  void performSelector(String selectorName) {}
  @override
  void insertContent(KeyboardInsertedContent content) {}

  // ── Rendering ────────────────────────────────────────────────────────

  TextStyle _base(BlockView b) {
    final (size, bold) = switch ((b.kind, b.level)) {
      ('heading', 1) => (28.0, true),
      ('heading', 2) => (22.0, true),
      ('heading', 3) => (18.0, true),
      ('heading', _) => (16.0, true),
      ('code', _) => (14.0, false),
      _ => (15.0, false),
    };
    return TextStyle(
      fontFamily: b.kind == 'code' ? monoFont : uiFont,
      fontSize: size,
      height: 1.55,
      fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
      fontStyle: b.editable ? FontStyle.normal : FontStyle.italic,
      color: b.editable && !(b.list == 'task' && b.checked)
          ? (b.quoteDepth > 0 ? AppColors.muted : AppColors.text)
          : AppColors.muted,
      // A ticked task reads as done.
      decoration: b.list == 'task' && b.checked
          ? TextDecoration.lineThrough
          : null,
    );
  }

  InlineSpan _spans(BlockView b, TextStyle base, int blockStart) {
    final text = b.text;
    if (text.isEmpty) return TextSpan(text: '', style: base);
    // Inline nodes: one character each, a chip or a line break.
    final nodes = {for (final n in b.inlines) n.at: n};
    final marks = List<int>.filled(text.length, 0);
    for (final s in b.spans) {
      for (var u = s.start; u < s.end && u < text.length; u++) {
        marks[u] |= s.marks;
      }
    }
    final composeStart = _composing.isValid
        ? _composing.start - blockStart
        : -1;
    final composeEnd = _composing.isValid ? _composing.end - blockStart : -1;
    bool composed(int u) => u >= composeStart && u < composeEnd;
    final children = <InlineSpan>[];
    var start = 0;
    while (start < text.length) {
      if (nodes[start] case final node?) {
        children.add(
          node.name == 'hardBreak'
              ? const TextSpan(text: '\n')
              : node.name == 'mention'
              ? WidgetSpan(
                  alignment: PlaceholderAlignment.baseline,
                  baseline: TextBaseline.alphabetic,
                  child: MentionChip(node: node, style: base),
                )
              : const TextSpan(text: '\uFFFC'),
        );
        start++;
        continue;
      }
      final m = marks[start];
      final c = composed(start);
      var end = start + 1;
      while (end < text.length &&
          marks[end] == m &&
          composed(end) == c &&
          !nodes.containsKey(end)) {
        end++;
      }
      bool has(int bit) => m & bit != 0;
      final code = has(Marks.code);
      final link = has(Marks.link);
      final color = !b.editable
          ? AppColors.muted
          : link
          ? AppColors.link
          : code
          ? AppColors.codeText
          : null;
      final decorations = [
        if (has(Marks.underline) || link || c) TextDecoration.underline,
        if (has(Marks.strike)) TextDecoration.lineThrough,
      ];
      children.add(
        TextSpan(
          text: text.substring(start, end),
          style: TextStyle(
            fontFamily: code ? monoFont : null,
            fontWeight: has(Marks.bold) ? FontWeight.w700 : null,
            fontStyle: has(Marks.italic) ? FontStyle.italic : null,
            color: color,
            backgroundColor: code
                ? AppColors.codeBg
                : has(Marks.highlight)
                ? AppColors.highlight
                : null,
            decoration: decorations.isEmpty
                ? null
                : TextDecoration.combine(decorations),
            decorationColor: color ?? AppColors.text,
          ),
        ),
      );
      start = end;
    }
    return TextSpan(style: base, children: children);
  }

  Widget _block(int i, BlockView b, int? number) {
    final base = _base(b);
    final start = view.starts[i];
    final end = start + b.text.length;
    final atom = b.kind == 'atom';
    // A figure is selected with the caret on it or a selection over it.
    final selected =
        atom &&
        focus.hasFocus &&
        (view.blockAt(view.head) == i ||
            (view.selectionStart <= start &&
                view.selectionEnd >= end &&
                view.selectionEnd > view.selectionStart));
    Widget paragraph([double? width]) => RichText(
      key: _keys[i],
      text: atom
          ? TextSpan(
              style: base,
              children: [
                WidgetSpan(
                  alignment: PlaceholderAlignment.middle,
                  child: FigureView(
                    block: b,
                    session: session,
                    // Room for the caret beside it.
                    width: (width ?? 400) - 4,
                    selected: selected,
                    actions: _figureActions(i),
                  ),
                ),
              ],
            )
          : _spans(b, base, start),
      textScaler: TextScaler.noScaling,
    );
    Widget painted(Widget paragraph) => CustomPaint(
      foregroundPainter: _SelectionPainter(
        paragraph: _keys[i],
        start: view.selectionStart - start,
        end: view.selectionEnd - start,
        length: b.text.length,
        caret: !atom && focus.hasFocus && view.blockAt(view.head) == i
            ? view.head - start
            : null,
        hits: [
          for (var m = 0; m < _matches.length; m++)
            if (_matches[m].$2 >= start && _matches[m].$1 <= end)
              (
                start: _matches[m].$1 - start,
                end: _matches[m].$2 - start,
                current: m == _matchIndex,
              ),
        ],
        remote: [
          for (final c in _carets)
            if (c.end >= start && c.start <= end)
              (
                start: c.start - start,
                end: c.end - start,
                caret: view.blockAt(c.head) == i ? c.head - start : null,
                color: c.color,
                // The name tag shows while the caret is moving.
                name: _flags[c.peer]?.$2.isActive == true ? c.name : null,
              ),
        ],
      ),
      child: paragraph,
    );
    final lineHeight = (base.fontSize! * 1.55).roundToDouble();
    Widget? marker = switch (b.list) {
      'bullet' => Text(b.listDepth.isOdd ? '•' : '◦'),
      'ordered' => Text('$number.'),
      'task' => Align(
        alignment: Alignment.topLeft,
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            key: ValueKey('task-box-$i'),
            onTap: () => run({'op': 'toggleTask', 'block': i}),
            child: Container(
              margin: const EdgeInsets.only(top: 5),
              width: 12,
              height: 12,
              decoration: BoxDecoration(
                color: b.checked ? AppColors.accent : null,
                border: Border.all(color: AppColors.muted),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
        ),
      ),
      _ => null,
    };
    Widget row = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (marker != null)
          SizedBox(
            width: 26,
            height: lineHeight,
            child: DefaultTextStyle(
              style: base.copyWith(
                color: AppColors.muted,
                fontStyle: FontStyle.normal,
              ),
              child: marker,
            ),
          ),
        Expanded(
          child: atom
              ? LayoutBuilder(
                  builder: (context, c) => painted(paragraph(c.maxWidth)),
                )
              : painted(paragraph()),
        ),
      ],
    );
    final indent = 26.0 * (b.listDepth > 0 ? b.listDepth - 1 : 0);
    row = Padding(
      padding: EdgeInsets.only(left: indent),
      child: row,
    );
    if (_claims[b.blockId] case (final who, final color)) {
      // Someone is working on this block: an outline with their name.
      row = Container(
        key: ValueKey('claim-${b.blockId}'),
        margin: const EdgeInsets.only(top: 14),
        decoration: BoxDecoration(
          border: Border.all(color: Color(color), width: 1.5),
          borderRadius: BorderRadius.circular(4),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            row,
            Positioned(
              top: -17,
              right: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 5),
                color: Color(color),
                child: Text(
                  '$who is editing',
                  style: const TextStyle(
                    fontFamily: uiFont,
                    fontSize: 10,
                    color: Colors.white,
                    fontStyle: FontStyle.normal,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }
    if (widget.workspace.attribution) {
      // Who wrote this block last, as a bar in the margin.
      row = Container(
        key: ValueKey('gutter-${b.blockId}'),
        padding: const EdgeInsets.only(left: 10),
        decoration: BoxDecoration(
          border: Border(
            left: BorderSide(
              width: 3,
              color: _authorColors[b.blockId] ?? Colors.transparent,
            ),
          ),
        ),
        child: row,
      );
    }
    if (b.quoteDepth > 0) {
      row = Container(
        padding: const EdgeInsets.only(left: 12),
        decoration: const BoxDecoration(
          border: Border(left: BorderSide(color: AppColors.muted, width: 2)),
        ),
        child: row,
      );
    }
    return switch ((b.kind, b.level)) {
      ('heading', 1) => Padding(
        padding: const EdgeInsets.only(top: 16, bottom: 4),
        child: row,
      ),
      ('heading', _) => Padding(
        padding: const EdgeInsets.only(top: 12, bottom: 4),
        child: row,
      ),
      ('code', _) => Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: AppColors.codeBg,
          borderRadius: BorderRadius.circular(6),
        ),
        child: row,
      ),
      ('atom', _) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: row,
      ),
      _ => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: row,
      ),
    };
  }

  /// Centres page content at reading width.
  Widget _page(Widget child) => Center(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 760),
      child: SizedBox(
        width: double.infinity,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: child,
        ),
      ),
    ),
  );

  Widget _tool(String label, bool active, VoidCallback onTap) {
    return _ToolButton(
      label: label,
      active: active,
      onTap: () {
        onTap();
        focus.requestFocus();
      },
    );
  }

  Widget _toolbar() {
    bool on(int bit) => view.marks & bit != 0;
    final here = view.blocks[view.blockAt(view.head)];
    final listHere = here.list;
    final quoteHere = here.quoteDepth > 0;
    void op(String name, [Map<String, Object?> args = const {}]) =>
        run({'op': name, ...args});
    final sep = Container(
      width: 1,
      height: 18,
      margin: const EdgeInsets.symmetric(horizontal: 4),
      color: AppColors.border,
    );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: const BoxDecoration(
        color: AppColors.panel,
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      // Formatting scrolls sideways when the pane is narrow; file actions stay.
      child: Row(
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _tool(
                    '¶',
                    view.kind == 'paragraph',
                    () => op('setKind', {'kind': 'paragraph'}),
                  ),
                  _tool(
                    'H1',
                    view.kind == 'heading' && view.level == 1,
                    () => op('setKind', {'kind': 'heading', 'level': 1}),
                  ),
                  _tool(
                    'H2',
                    view.kind == 'heading' && view.level == 2,
                    () => op('setKind', {'kind': 'heading', 'level': 2}),
                  ),
                  _tool(
                    'H3',
                    view.kind == 'heading' && view.level == 3,
                    () => op('setKind', {'kind': 'heading', 'level': 3}),
                  ),
                  _tool(
                    '{ }',
                    view.kind == 'code',
                    () => op('setKind', {'kind': 'code'}),
                  ),
                  sep,
                  _tool(
                    'B',
                    on(Marks.bold),
                    () => op('toggleMark', {'mark': 'bold'}),
                  ),
                  _tool(
                    'I',
                    on(Marks.italic),
                    () => op('toggleMark', {'mark': 'italic'}),
                  ),
                  _tool(
                    'U',
                    on(Marks.underline),
                    () => op('toggleMark', {'mark': 'underline'}),
                  ),
                  _tool(
                    'S',
                    on(Marks.strike),
                    () => op('toggleMark', {'mark': 'strike'}),
                  ),
                  _tool(
                    '</>',
                    on(Marks.code),
                    () => op('toggleMark', {'mark': 'code'}),
                  ),
                  _tool(
                    'Mark',
                    on(Marks.highlight),
                    () => op('toggleMark', {'mark': 'highlight'}),
                  ),
                  _tool('Link', on(Marks.link), _editLink),
                  sep,
                  _tool(
                    '• List',
                    listHere == 'bullet',
                    () => op('toggleList', {'kind': 'bullet'}),
                  ),
                  _tool(
                    '1. List',
                    listHere == 'ordered',
                    () => op('toggleList', {'kind': 'ordered'}),
                  ),
                  _tool(
                    'Tasks',
                    listHere == 'task',
                    () => op('toggleList', {'kind': 'task'}),
                  ),
                  _tool('Quote', quoteHere, () => op('toggleQuote')),
                  sep,
                  _tool('Image', false, _pickImage),
                  _tool(
                    'Diagram',
                    false,
                    () => op('insertFigure', {'name': 'mermaidFigure'}),
                  ),
                  _tool('@', false, _mention),
                  sep,
                  _tool('Undo', false, () => op('undo')),
                  _tool('Redo', false, () => op('redo')),
                ],
              ),
            ),
          ),
          // Document actions: all shown when there is room, scrolling when
          // panes are narrow (several participants, the History tab).
          Flexible(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _tool(
                    'History',
                    widget.workspace.historyOpen &&
                        identical(
                          widget.workspace.historyFor,
                          widget.participant,
                        ),
                    () => widget.workspace.toggleHistory(widget.participant),
                  ),
                  _tool(
                    'Authors',
                    widget.workspace.attribution,
                    widget.workspace.toggleAttribution,
                  ),
                  _tool(
                    'People',
                    widget.workspace.peopleOpen &&
                        identical(
                          widget.workspace.peopleFor,
                          widget.participant,
                        ),
                    () => widget.workspace.togglePeople(widget.participant),
                  ),
                  _tool('+ Peer', false, widget.workspace.addPeer),
                  if (widget.workspace.participants.length > 1 &&
                      !identical(
                        widget.participant,
                        widget.workspace.participants.first,
                      ))
                    _tool(
                      'Close',
                      false,
                      () => widget.workspace.removePeer(widget.participant),
                    ),
                  _tool('Home', false, () => widget.app.home(context)),
                  _tool('Open', false, () => widget.app.openFile(context)),
                  _tool('Save', false, () => widget.app.save(context)),
                  _tool(
                    'Export .md',
                    false,
                    () => widget.app.exportMarkdown(context),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// "Viewing version from 14:02 by Ana · Restore · Close" (AC-05.6).
  Widget _versionBanner(VersionView v) {
    final live = widget.live!;
    return Container(
      key: const ValueKey('version-banner'),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: const BoxDecoration(
        color: AppColors.buttonActive,
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Viewing ${v.label} · read-only',
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: uiFont,
                fontSize: 13,
                color: AppColors.text,
              ),
            ),
          ),
          _ToolButton(
            key: const ValueKey('version-restore'),
            label: 'Restore',
            active: false,
            onTap: () {
              widget.workspace.restore(live, v.frontiers);
              widget.workspace.closeVersion(live);
            },
          ),
          _ToolButton(
            key: const ValueKey('version-close'),
            label: 'Close',
            active: false,
            onTap: () => widget.workspace.closeVersion(live),
          ),
        ],
      ),
    );
  }

  Widget _statusBar() {
    final ws = widget.workspace;
    final n = ws.participants.length;
    final persist = ws.persist;
    final saved = persist == null
        ? ''
        : persist.dirty
        ? '● Unsaved'
        : persist.isDraft
        ? 'Draft · saved automatically'
        : 'Saved · ${persist.path}';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: const BoxDecoration(
        color: AppColors.panel,
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: DefaultTextStyle(
        style: const TextStyle(
          fontFamily: uiFont,
          fontSize: 12,
          color: AppColors.muted,
        ),
        child: Row(
          children: [
            Flexible(
              child: Text(
                '● ${widget.participant.name}',
                overflow: TextOverflow.ellipsis,
                softWrap: false,
                style: TextStyle(
                  color: Color(parseHexColor(widget.participant.color)),
                ),
              ),
            ),
            const SizedBox(width: 16),
            Flexible(
              child: Text(
                n == 1 ? '1 participant' : '$n participants',
                overflow: TextOverflow.ellipsis,
                softWrap: false,
              ),
            ),
            const SizedBox(width: 16),
            Flexible(
              child: Text(
                '${view.blocks.length} blocks',
                overflow: TextOverflow.ellipsis,
                softWrap: false,
              ),
            ),
            const SizedBox(width: 16),
            Flexible(
              child: Text(
                saved,
                key: const ValueKey('persist-status'),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const Spacer(),
            Flexible(child: Text(ws.status, overflow: TextOverflow.ellipsis)),
            // The renderer is the app's, not a participant's: shown once,
            // where the runner applies it (the GTK one).
            if (Platform.isLinux &&
                identical(widget.participant, ws.participants.first)) ...[
              const SizedBox(width: 16),
              _rendererMenu(ws),
            ],
          ],
        ),
      ),
    );
  }

  /// Which renderer is running, and a menu to pick one for the next start.
  Widget _rendererMenu(Workspace ws) {
    final chosen = ws.settings.renderer;
    final active = ws.settings.activeRenderer;
    final label = active == null
        ? chosen.label
        : chosen == Renderer.auto
        ? '${active.label} (auto)'
        : active.label;
    return PopupMenuButton<Renderer>(
      key: const ValueKey('renderer-menu'),
      tooltip:
          'Renderer: Software uses about 100 MB less memory and needs '
          'no GPU; GPU draws faster on large screens. Applies on restart.',
      initialValue: chosen,
      onSelected: ws.setRenderer,
      itemBuilder: (context) => [
        for (final r in Renderer.values)
          PopupMenuItem(
            key: ValueKey('renderer-${r.name}'),
            value: r,
            child: Row(
              children: [
                SizedBox(width: 20, child: Text(r == chosen ? '●' : '')),
                Text(r.label),
              ],
            ),
          ),
      ],
      child: Text('Renderer: $label'),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_keys.length != view.blocks.length) {
      _keys = [
        for (var i = 0; i < view.blocks.length; i++)
          i < _keys.length ? _keys[i] : GlobalKey(),
      ];
    }
    // Ordered-list numbering per depth, restarting after other content.
    final counters = <int>[];
    final numbers = <int?>[];
    for (final b in view.blocks) {
      final depth = b.listDepth;
      if (counters.length > depth) counters.removeRange(depth, counters.length);
      while (counters.length < depth) {
        counters.add(0);
      }
      if (depth > 0) counters[depth - 1]++;
      numbers.add(depth > 0 ? counters[depth - 1] : null);
    }
    final title = view.title.isEmpty ? 'Untitled' : view.title;
    return Focus(
      focusNode: focus,
      autofocus: widget.autofocus,
      onKeyEvent: _onKey,
      child: Container(
        color: AppColors.bg,
        child: Column(
          children: [
            if (widget.version case final v?) _versionBanner(v) else _toolbar(),
            if (_findOpen)
              FindBar(
                key: _findBar,
                count: _matches.length,
                index: _matchIndex,
                onQuery: _search,
                onStep: _step,
                onReplace: (text) => _replace(text, all: false),
                onReplaceAll: (text) => _replace(text, all: true),
                onClose: _closeFind,
              ),
            Expanded(
              child: MouseRegion(
                cursor: SystemMouseCursors.text,
                child: Listener(
                  key: _viewportKey,
                  behavior: HitTestBehavior.opaque,
                  onPointerDown: _pointerDown,
                  onPointerMove: _pointerMove,
                  onPointerUp: (_) => _pointerUp(),
                  onPointerCancel: (_) => _pointerUp(),
                  // Only blocks near the viewport are built and laid out:
                  // item 0 is the title, then one item per block, then room
                  // to scroll past the end.
                  child: SuperListView.builder(
                    controller: scroll,
                    listController: list,
                    cacheExtent: 800,
                    itemCount: view.blocks.length + 2,
                    itemBuilder: (context, index) {
                      if (index == 0) {
                        return _page(
                          Padding(
                            padding: const EdgeInsets.only(top: 24, bottom: 8),
                            child: Text(
                              title,
                              style: const TextStyle(
                                fontFamily: uiFont,
                                fontSize: 12,
                                color: AppColors.muted,
                              ),
                            ),
                          ),
                        );
                      }
                      if (index > view.blocks.length) {
                        return const SizedBox(height: 240);
                      }
                      final i = index - 1;
                      return _page(_block(i, view.blocks[i], numbers[i]));
                    },
                  ),
                ),
              ),
            ),
            if (!widget.readOnly) _statusBar(),
          ],
        ),
      ),
    );
  }
}

class _ToolButton extends StatefulWidget {
  const _ToolButton({
    super.key,
    required this.label,
    required this.active,
    required this.onTap,
  });
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  State<_ToolButton> createState() => _ToolButtonState();
}

class _ToolButtonState extends State<_ToolButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          margin: const EdgeInsets.only(right: 2),
          decoration: BoxDecoration(
            color: widget.active
                ? AppColors.buttonActive
                : (_hover ? AppColors.buttonHover : null),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Text(
            widget.label,
            style: TextStyle(
              fontFamily: uiFont,
              fontSize: 13,
              color: widget.active ? AppColors.accent : AppColors.text,
            ),
          ),
        ),
      ),
    );
  }
}

/// Paints the selection and caret over one block's paragraph.
class _SelectionPainter extends CustomPainter {
  _SelectionPainter({
    required this.paragraph,
    required this.start,
    required this.end,
    required this.length,
    required this.caret,
    this.remote = const [],
    this.hits = const [],
  });

  final GlobalKey paragraph;

  /// Selection relative to this block (may run past either end).
  final int start;
  final int end;
  final int length;
  final int? caret;

  /// Other participants' selections over this block (relative, like ours).
  final List<RemoteMark> remote;

  /// Find matches in this block (relative).
  final List<({int start, int end, bool current})> hits;

  @override
  void paint(Canvas canvas, Size size) {
    final p = paragraph.currentContext?.findRenderObject() as RenderParagraph?;
    if (p == null || !p.hasSize) return;
    for (final h in hits) {
      final color = h.current ? AppColors.findCurrent : AppColors.findHit;
      _range(canvas, p, h.start, h.end, Paint()..color = color);
    }
    for (final r in remote) {
      final color = Color(r.color);
      _range(canvas, p, r.start, r.end, Paint()..color = color.withAlpha(0x40));
      final c = r.caret;
      if (c != null) {
        final caretRect = _caret(canvas, p, c, color);
        if (r.name case final name?) _flag(canvas, caretRect, name, color);
      }
    }
    _range(canvas, p, start, end, Paint()..color = AppColors.selection);
    final c = caret;
    if (c != null) _caret(canvas, p, c, AppColors.accent);
  }

  void _range(
    Canvas canvas,
    RenderParagraph p,
    int start,
    int end,
    Paint paint,
  ) {
    final from = start.clamp(0, length);
    final to = end.clamp(0, length);
    // The newline after this block is selected too.
    final coversBreak = start <= length && end > length;
    if (end > start && (from < to || coversBreak)) {
      final boxes = p.getBoxesForSelection(
        TextSelection(baseOffset: from, extentOffset: to),
      );
      for (final b in boxes) {
        canvas.drawRect(b.toRect(), paint);
      }
      if (coversBreak) {
        final at = p.getOffsetForCaret(TextPosition(offset: length), Rect.zero);
        final h = p.getFullHeightForCaret(TextPosition(offset: length));
        canvas.drawRect(Rect.fromLTWH(at.dx, at.dy, 6, h), paint);
      }
    }
  }

  Rect _caret(Canvas canvas, RenderParagraph p, int offset, Color color) {
    final position = TextPosition(offset: offset.clamp(0, length));
    final at = p.getOffsetForCaret(position, Rect.zero);
    final rect = Rect.fromLTWH(
      at.dx,
      at.dy,
      2,
      p.getFullHeightForCaret(position),
    );
    canvas.drawRect(rect, Paint()..color = color);
    return rect;
  }

  /// The participant's name in a small tag above their caret.
  void _flag(Canvas canvas, Rect caret, String name, Color color) {
    final label = TextPainter(
      text: TextSpan(
        text: name,
        style: const TextStyle(
          fontFamily: uiFont,
          fontSize: 10,
          fontWeight: FontWeight.w600,
          color: Color(0xFFFFFFFF),
          height: 1.2,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    final box = Rect.fromLTWH(
      caret.left,
      caret.top - label.height - 2,
      label.width + 8,
      label.height + 2,
    );
    canvas.drawRRect(
      RRect.fromRectAndCorners(
        box,
        topLeft: const Radius.circular(3),
        topRight: const Radius.circular(3),
        bottomRight: const Radius.circular(3),
      ),
      Paint()..color = color,
    );
    label.paint(canvas, Offset(box.left + 4, box.top + 1));
    label.dispose();
  }

  @override
  bool shouldRepaint(_SelectionPainter old) =>
      old.start != start ||
      old.end != end ||
      old.length != length ||
      old.caret != caret ||
      !listEquals(old.remote, remote) ||
      !listEquals(old.hits, hits);
}

/// A remote selection relative to one block; `caret` only in the block that
/// holds its head.
typedef RemoteMark = ({
  int start,
  int end,
  int? caret,
  int color,
  String? name,
});

/// One text: a figure caption (one line) or a diagram's source.
class _TextDialog extends StatefulWidget {
  const _TextDialog({
    required this.title,
    required this.initial,
    required this.multiline,
  });

  final String title;
  final String initial;
  final bool multiline;

  @override
  State<_TextDialog> createState() => _TextDialogState();
}

class _TextDialogState extends State<_TextDialog> {
  late final TextEditingController text = TextEditingController(
    text: widget.initial,
  );

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.panel,
      title: Text(
        widget.title,
        style: const TextStyle(fontFamily: uiFont, fontSize: 15),
      ),
      content: SizedBox(
        width: widget.multiline ? 520 : 360,
        child: TextField(
          key: const ValueKey('figure-text-field'),
          controller: text,
          autofocus: true,
          minLines: widget.multiline ? 6 : 1,
          maxLines: widget.multiline ? 16 : 1,
          style: TextStyle(
            fontFamily: widget.multiline ? monoFont : uiFont,
            fontSize: 13,
            color: AppColors.text,
          ),
          onSubmitted: widget.multiline
              ? null
              : (value) => Navigator.of(context).pop(value),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        TextButton(
          key: const ValueKey('figure-text-ok'),
          onPressed: () => Navigator.of(context).pop(text.text),
          child: const Text('OK'),
        ),
      ],
    );
  }
}

class _LinkDialog extends StatefulWidget {
  const _LinkDialog({required this.initial});
  final String initial;

  @override
  State<_LinkDialog> createState() => _LinkDialogState();
}

class _LinkDialogState extends State<_LinkDialog> {
  late final TextEditingController url = TextEditingController(
    text: widget.initial,
  );

  @override
  void dispose() {
    url.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.panel,
      title: Text(
        widget.initial.isEmpty ? 'Add link' : 'Edit link',
        style: const TextStyle(
          fontFamily: uiFont,
          fontSize: 15,
          color: AppColors.text,
        ),
      ),
      content: SizedBox(
        width: 420,
        child: TextField(
          key: const ValueKey('link-url'),
          controller: url,
          autofocus: true,
          style: const TextStyle(fontFamily: uiFont, color: AppColors.text),
          decoration: const InputDecoration(hintText: 'https://…'),
          onSubmitted: (value) => Navigator.of(context).pop(value),
        ),
      ),
      actions: [
        if (widget.initial.isNotEmpty)
          TextButton(
            onPressed: () => Navigator.of(context).pop(''),
            child: const Text('Remove'),
          ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        TextButton(
          key: const ValueKey('link-save'),
          onPressed: () => Navigator.of(context).pop(url.text),
          child: const Text('Save'),
        ),
      ],
    );
  }
}

/// "Insert as Mermaid diagram?" when pasted text looks like Mermaid source,
/// as in the TS app: true for a diagram, false for text.
class _MermaidDialog extends StatelessWidget {
  const _MermaidDialog();

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.panel,
      title: const Text(
        'Insert as Mermaid diagram?',
        style: TextStyle(
          fontFamily: uiFont,
          fontSize: 15,
          color: AppColors.text,
        ),
      ),
      actions: [
        TextButton(
          key: const ValueKey('mermaid-text'),
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Insert as text'),
        ),
        TextButton(
          key: const ValueKey('mermaid-diagram'),
          autofocus: true,
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Insert as diagram'),
        ),
      ],
    );
  }
}
