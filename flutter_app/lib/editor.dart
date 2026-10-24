// The document editor: draws the core's blocks as rich text and turns keys,
// mouse and platform text input (IME) into commands for the Rust Editor.
//
// Like the GPUI build, this file only maps between pixels and the core's
// global UTF-16 offsets; typing, Enter/Backspace, marks, block kinds, undo
// and sync are decided in Rust.

import 'dart:async';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:super_sliver_list/super_sliver_list.dart';
import 'package:url_launcher/url_launcher.dart';

import 'model.dart';
import 'native.dart';
import 'settings.dart';
import 'theme.dart';
import 'workspace.dart';

class EditorPane extends StatefulWidget {
  const EditorPane({
    super.key,
    required this.workspace,
    required this.participant,
    this.autofocus = false,
  });

  final Workspace workspace;
  final Participant participant;
  final bool autofocus;

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

  /// Per peer: the last caret position seen, and how long its name shows.
  final Map<String, (String, Timer)> _flags = {};

  Session get session => widget.participant.session;

  @visibleForTesting
  List<RemoteCaret> get carets => _carets;

  @override
  void initState() {
    super.initState();
    view = session.view();
    _readCarets();
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
    widget.participant.remoteVersion.removeListener(_remoteChanged);
    widget.participant.presenceVersion.removeListener(_caretsChanged);
    _heartbeat?.cancel();
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
      // Text moved under the others' cursors: where they point now.
      _readCarets();
    });
    _syncInput();
    if (_published != (view.anchor, view.head)) _schedulePresence();
    if (reveal) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _revealCaret());
    }
  }

  /// Re-reads the others' carets; a caret that moved shows its name for 2 s.
  void _readCarets() {
    _carets = session.carets();
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

  static const _presenceGapMs = 50; // ≤ 20 updates a second, as in TS
  static const _heartbeatMs = 5000;

  /// Tells the others where our caret is, at most every [_presenceGapMs].
  void _schedulePresence() {
    if (_presenceCooldown != null) {
      _presencePending = true;
      return;
    }
    _published = (view.anchor, view.head);
    widget.workspace.publishPresence(widget.participant);
    _presenceCooldown = Timer(const Duration(milliseconds: _presenceGapMs), () {
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

  Future<void> _copy({bool cut = false}) async {
    if (view.selectionStart == view.selectionEnd) return;
    final reply = session.call({'op': 'copyMarkdown'});
    await Clipboard.setData(ClipboardData(text: reply['text'] as String));
    if (cut) run({'op': 'insert', 'text': ''});
  }

  /// Ctrl+V reads Markdown into blocks and marks; Ctrl+Shift+V types it as is.
  Future<void> _paste({bool plain = false}) async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text != null && mounted) {
      run({
        'op': plain ? 'insert' : 'paste',
        'text': text.replaceAll('\r\n', '\n'),
      });
    }
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

  Future<void> _open() async {
    final file = await openFile(
      acceptedTypeGroups: [
        const XTypeGroup(label: 'CollabDoc', extensions: ['collabdoc']),
      ],
    );
    if (file != null) widget.workspace.open(file.path);
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent) return KeyEventResult.ignored;
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
    if (ctrl && shift && !alt) {
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
    }

    final Map<LogicalKeyboardKey, void Function()> table;
    if (ctrl && alt) {
      table = {
        LogicalKeyboardKey.digit0: () => kind('paragraph'),
        LogicalKeyboardKey.digit1: () => kind('heading', 1),
        LogicalKeyboardKey.digit2: () => kind('heading', 2),
        LogicalKeyboardKey.digit3: () => kind('heading', 3),
        LogicalKeyboardKey.keyC: () => kind('code'),
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
        if (shift) LogicalKeyboardKey.keyH: () => mark('highlight'),
        LogicalKeyboardKey.keyS: () =>
            widget.workspace.save(widget.participant),
        LogicalKeyboardKey.keyO: _open,
        if (shift) LogicalKeyboardKey.keyN: widget.workspace.addPeer,
        LogicalKeyboardKey.home: () => _select(0, 0),
        LogicalKeyboardKey.end: () => _select(view.length, view.length),
        LogicalKeyboardKey.arrowLeft: () => _word(false, shift),
        LogicalKeyboardKey.arrowRight: () => _word(true, shift),
      };
    } else {
      table = {
        LogicalKeyboardKey.backspace: () => op('backspace'),
        LogicalKeyboardKey.tab: () => op(shift ? 'outdent' : 'indent'),
        LogicalKeyboardKey.delete: () => op('delete'),
        LogicalKeyboardKey.enter: () => op('newline'),
        LogicalKeyboardKey.numpadEnter: () => op('newline'),
        LogicalKeyboardKey.arrowLeft: () => op('left', {'extend': shift}),
        LogicalKeyboardKey.arrowRight: () => op('right', {'extend': shift}),
        LogicalKeyboardKey.home: () => _lineEdge(false, shift),
        LogicalKeyboardKey.end: () => _lineEdge(true, shift),
        LogicalKeyboardKey.arrowUp: () => _vertical(false, shift),
        LogicalKeyboardKey.arrowDown: () => _vertical(true, shift),
      };
    }
    final action = table[event.logicalKey];
    // Printable keys go on to the platform text input (and its IME).
    if (action == null) return KeyEventResult.ignored;
    action();
    return KeyEventResult.handled;
  }

  void _word(bool forward, bool extend) {
    final i = view.blockAt(view.head);
    final text = view.blocks[i].text;
    final start = view.starts[i];
    var local = view.head - start;
    final isWord = RegExp(r'[\p{L}\p{N}_]', unicode: true);
    bool word(int at) =>
        at >= 0 && at < text.length && isWord.hasMatch(text[at]);
    int target;
    if (forward) {
      if (local >= text.length) {
        target = view.head + 1;
      } else {
        while (local < text.length && !word(local)) {
          local++;
        }
        while (local < text.length && word(local)) {
          local++;
        }
        target = start + local;
      }
    } else {
      if (local == 0) {
        target = view.head - 1;
      } else {
        while (local > 0 && !word(local - 1)) {
          local--;
        }
        while (local > 0 && word(local - 1)) {
          local--;
        }
        target = start + local;
      }
    }
    target = target.clamp(0, view.length);
    _select(extend ? view.anchor : target, target);
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

  TextSpan _spans(BlockView b, TextStyle base, int blockStart) {
    final text = b.text;
    if (text.isEmpty) return TextSpan(text: '', style: base);
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
    final children = <TextSpan>[];
    var start = 0;
    while (start < text.length) {
      final m = marks[start];
      final c = composed(start);
      var end = start + 1;
      while (end < text.length && marks[end] == m && composed(end) == c) {
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
    final paragraph = RichText(
      key: _keys[i],
      text: _spans(b, base, start),
      textScaler: TextScaler.noScaling,
    );
    final end = start + b.text.length;
    final painted = CustomPaint(
      foregroundPainter: _SelectionPainter(
        paragraph: _keys[i],
        start: view.selectionStart - start,
        end: view.selectionEnd - start,
        length: b.text.length,
        caret: focus.hasFocus && view.blockAt(view.head) == i
            ? view.head - start
            : null,
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
        Expanded(child: painted),
      ],
    );
    final indent = 26.0 * (b.listDepth > 0 ? b.listDepth - 1 : 0);
    row = Padding(
      padding: EdgeInsets.only(left: indent),
      child: row,
    );
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
      ('atom', _) => Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(6),
        ),
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
    final listHere = view.blocks[view.blockAt(view.head)].list;
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
                  sep,
                  _tool('Undo', false, () => op('undo')),
                  _tool('Redo', false, () => op('redo')),
                ],
              ),
            ),
          ),
          _tool('+ Peer', false, widget.workspace.addPeer),
          if (widget.workspace.participants.length > 1 &&
              widget.participant.name != 'You')
            _tool(
              'Close',
              false,
              () => widget.workspace.removePeer(widget.participant),
            ),
          _tool('Open', false, _open),
          _tool('Save', false, () => widget.workspace.save(widget.participant)),
        ],
      ),
    );
  }

  Widget _statusBar() {
    final ws = widget.workspace;
    final n = ws.participants.length;
    final saved = ws.dirty ? '● unsaved' : (view.path ?? 'not saved yet');
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
            Text(
              '● ${widget.participant.name}',
              style: TextStyle(
                color: Color(parseHexColor(widget.participant.color)),
              ),
            ),
            const SizedBox(width: 16),
            Text(n == 1 ? '1 participant' : '$n participants'),
            const SizedBox(width: 16),
            Text('${view.blocks.length} blocks'),
            const SizedBox(width: 16),
            Flexible(child: Text(saved, overflow: TextOverflow.ellipsis)),
            const Spacer(),
            Flexible(child: Text(ws.status, overflow: TextOverflow.ellipsis)),
            // The renderer is the app's, not a participant's: shown once.
            if (identical(widget.participant, ws.participants.first)) ...[
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
            _toolbar(),
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
            _statusBar(),
          ],
        ),
      ),
    );
  }
}

class _ToolButton extends StatefulWidget {
  const _ToolButton({
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
  });

  final GlobalKey paragraph;

  /// Selection relative to this block (may run past either end).
  final int start;
  final int end;
  final int length;
  final int? caret;

  /// Other participants' selections over this block (relative, like ours).
  final List<RemoteMark> remote;

  @override
  void paint(Canvas canvas, Size size) {
    final p = paragraph.currentContext?.findRenderObject() as RenderParagraph?;
    if (p == null || !p.hasSize) return;
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
      !listEquals(old.remote, remote);
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
