// The Flutter layer, headless: real key handling and platform text input
// driving EditorPane over the Rust core, and two panes syncing.
//
// Needs the native library: `cargo build -p collabdoc-ffi`, then
//   COLLABDOC_FFI_LIB=../target/debug/libcollabdoc_ffi.so flutter test

import 'dart:io';

import 'package:collabdoc/app.dart';
import 'package:collabdoc/editor.dart';
import 'package:collabdoc/find_bar.dart';
import 'package:collabdoc/native.dart';
import 'package:collabdoc/model.dart';
import 'package:collabdoc/settings.dart';
import 'package:collabdoc/workspace.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

List<String> texts(EditorPaneState pane) => [
  for (final b in pane.view.blocks) b.text,
];

/// What the platform sends when the user types `text` at the caret.
void type(EditorPaneState pane, String text) {
  final value = pane.currentTextEditingValue!;
  final at = value.selection.extentOffset;
  pane.updateEditingValueWithDeltas([
    TextEditingDeltaInsertion(
      oldText: value.text,
      textInserted: text,
      insertionOffset: at,
      selection: TextSelection.collapsed(offset: at + text.length),
      composing: TextRange.empty,
    ),
  ]);
}

Future<void> chord(
  WidgetTester tester,
  List<LogicalKeyboardKey> modifiers,
  LogicalKeyboardKey key,
) async {
  for (final m in modifiers) {
    await tester.sendKeyDownEvent(m);
  }
  await tester.sendKeyEvent(key);
  for (final m in modifiers.reversed) {
    await tester.sendKeyUpEvent(m);
  }
  await tester.pump();
}

/// A temporary folder for settings, drafts, the journal and recents (never
/// the user's), with the store pointed at it.
Directory scratch({int idleMs = 0}) {
  final dir = Directory.systemTemp.createTempSync('collabdoc-test');
  addTearDown(() => dir.deleteSync(recursive: true));
  CoreStore.configure(
    userData: '${dir.path}/user',
    documentsDir: '${dir.path}/docs',
    // By default autosave at the next tick (the core's clock is real time).
    idleMs: idleMs,
  );
  return dir;
}

Future<AppController> launchApp(
  WidgetTester tester, {
  Directory? dir,
  bool withDocument = true,
}) async {
  tester.view.physicalSize = const Size(1600, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final config = dir ?? scratch();
  final settings = Settings(File('${config.path}/settings.ini'));
  final app = AppController(
    workspace: withDocument ? Workspace.create(settings: settings) : null,
    settings: settings,
  );
  addTearDown(() => app.workspace?.dispose());
  await tester.pumpWidget(CollabDocApp(app: app));
  await tester.pump();
  return app;
}

Future<Workspace> launch(WidgetTester tester) async =>
    (await launchApp(tester)).workspace!;

void main() {
  testWidgets('typing, Enter, Backspace and shortcuts', (tester) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    expect(pane.focus.hasFocus, isTrue);

    type(pane, 'Hello world');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(pane, 'Second');
    await tester.pump();
    expect(texts(pane), ['Hello world', 'Second']);

    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    expect(texts(pane), ['Hello world', 'Seco']);

    // Home, select to the end, bold.
    await tester.sendKeyEvent(LogicalKeyboardKey.home);
    await chord(tester, [LogicalKeyboardKey.shiftLeft], LogicalKeyboardKey.end);
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyB);
    final span = pane.view.blocks[1].spans.single;
    expect((span.start, span.end), (0, 4));

    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
      LogicalKeyboardKey.altLeft,
    ], LogicalKeyboardKey.digit1);
    expect(pane.view.blocks[1].kind, 'heading');

    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyZ);
    expect(
      pane.view.blocks[1].kind,
      'paragraph',
      reason: 'undo reverts the heading',
    );
  });

  testWidgets('two panes are two synced participants', (tester) async {
    final ws = await launch(tester);
    final mine = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(mine, 'From me');

    ws.addPeer();
    await tester.pump();
    await tester.pump();
    final panes = tester
        .stateList<EditorPaneState>(find.byType(EditorPane))
        .toList();
    final theirs = panes[1];
    expect(
      theirs.focus.hasFocus,
      isTrue,
      reason: 'a new peer takes the keyboard',
    );
    expect(texts(theirs), ['From me']);

    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.end);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(theirs, 'From the peer');
    await tester.pump();
    expect(texts(mine), ['From me', 'From the peer']);

    // Undo in my pane takes back only my typing.
    mine.focus.requestFocus();
    await tester.pump();
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyZ);
    expect(texts(mine), ['', 'From the peer']);
    expect(texts(theirs), ['', 'From the peer']);
  });

  testWidgets('list shortcuts, Tab and task ticks', (tester) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'one');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(pane, 'two');
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyA);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(
      LogicalKeyboardKey.asterisk,
      physicalKey: PhysicalKeyboardKey.digit8,
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();
    expect([for (final b in pane.view.blocks) b.list], ['bullet', 'bullet']);

    // Tab on the second line nests it under the first.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect([for (final b in pane.view.blocks) b.listDepth], [1, 2]);
    await chord(tester, [LogicalKeyboardKey.shiftLeft], LogicalKeyboardKey.tab);
    expect([for (final b in pane.view.blocks) b.listDepth], [1, 1]);

    // Task list; clicking the box ticks it.
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyA);
    pane.run({'op': 'toggleList', 'kind': 'task'});
    await tester.pump();
    expect(pane.view.blocks.first.list, 'task');
    await tester.tap(find.byKey(const ValueKey('task-box-1')));
    await tester.pump();
    expect(
      [for (final b in pane.view.blocks) b.checked].contains(true),
      isTrue,
    );
  });

  testWidgets('Ctrl+K links the selection', (tester) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'see the docs');
    pane.run({'op': 'select', 'anchor': 8, 'head': 12});
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyK);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('link-url')),
      'https://loro.dev',
    );
    await tester.tap(find.byKey(const ValueKey('link-save')));
    await tester.pumpAndSettle();
    final span = pane.view.blocks.single.spans.single;
    expect((span.start, span.end, span.href), (8, 12, 'https://loro.dev'));
    expect(pane.focus.hasFocus, isTrue, reason: 'typing goes on in the editor');
  });

  testWidgets('input made against text we no longer show lands at the caret', (
    tester,
  ) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'abc');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(pane, 'de');
    await tester.pump();
    final stale = pane.currentTextEditingValue!;
    // An arrow key wins the race against the next character…
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    // …which the platform still made against "de".
    pane.updateEditingValueWithDeltas([
      TextEditingDeltaInsertion(
        oldText: stale.text,
        textInserted: 'f',
        insertionOffset: 2,
        selection: const TextSelection.collapsed(offset: 3),
        composing: TextRange.empty,
      ),
    ]);
    await tester.pump();
    final blocks = texts(pane);
    expect(blocks[1], 'de', reason: 'no edit is applied to the wrong block');
    expect(
      blocks[0].length,
      4,
      reason: '"f" goes in at the caret, nothing is lost',
    );
  });

  testWidgets('without the rich clipboard, copy and paste use plain text', (
    tester,
  ) async {
    // No runner channel (another platform): nobody answers, plain text only.
    tester.binding.defaultBinaryMessenger.setMockMessageHandler(
      'collabdoc/clipboard',
      (message) async => null,
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMessageHandler(
        'collabdoc/clipboard',
        null,
      ),
    );
    String? clipboard;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard = (call.arguments as Map)['text'] as String;
        } else if (call.method == 'Clipboard.getData') {
          return {'text': clipboard};
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    final ctrl = [LogicalKeyboardKey.controlLeft];
    final ctrlShift = [
      LogicalKeyboardKey.controlLeft,
      LogicalKeyboardKey.shiftLeft,
    ];

    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'Bold');
    await chord(tester, [
      LogicalKeyboardKey.shiftLeft,
    ], LogicalKeyboardKey.home);
    await chord(tester, ctrl, LogicalKeyboardKey.keyB);
    await chord(tester, ctrl, LogicalKeyboardKey.keyC);
    await tester.pumpAndSettle();
    expect(clipboard, '**Bold**');

    clipboard = '- one\n- two';
    await tester.sendKeyEvent(LogicalKeyboardKey.end);
    await chord(tester, ctrl, LogicalKeyboardKey.keyV);
    await tester.pumpAndSettle();
    expect(texts(pane), ['Bold', 'one', 'two']);
    expect(pane.view.blocks[1].list, isNotNull);

    // Ctrl+Shift+V types the Markdown as it is.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    clipboard = '**raw**';
    await chord(tester, ctrlShift, LogicalKeyboardKey.keyV);
    await tester.pumpAndSettle();
    expect(texts(pane).last, '**raw**');
  });

  testWidgets('each pane shows the other participants\' carets', (
    tester,
  ) async {
    final ws = await launch(tester);
    final mine = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(mine, 'Hello world');
    ws.addPeer();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    final theirs = tester
        .stateList<EditorPaneState>(find.byType(EditorPane))
        .last;

    (String, int, int) seen(EditorPaneState pane) {
      expect(pane.carets, hasLength(1));
      final c = pane.carets.single;
      return (c.name, c.anchor, c.head);
    }

    expect(seen(theirs), ('You', 11, 11));
    expect(seen(mine), ('Peer 2', 0, 0));
    expect(mine.carets.single.color, 0xFFE5484D);

    // The peer types at the start: my caret, as they see it, rides along.
    type(theirs, '>> ');
    await tester.pump(const Duration(milliseconds: 60));
    expect(seen(theirs), ('You', 14, 14));
    expect(seen(mine), ('Peer 2', 3, 3));

    // I select a word; the throttle lets the last move through.
    mine.focus.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await chord(tester, [
      LogicalKeyboardKey.shiftLeft,
    ], LogicalKeyboardKey.home);
    await tester.pump(const Duration(milliseconds: 60));
    expect(seen(theirs), ('You', 13, 0));

    // A peer that leaves takes its caret along.
    ws.removePeer(ws.participants.last);
    await tester.pump();
    expect(mine.carets, isEmpty);
  });

  testWidgets('Home and End go to the edges of the line on screen', (
    tester,
  ) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    final text = List.filled(60, 'word').join(' ');
    type(pane, text);
    await tester.pump();
    expect(pane.view.head, text.length);

    // Home: the start of the last wrapped line, not of the paragraph.
    await tester.sendKeyEvent(LogicalKeyboardKey.home);
    final lastLine = pane.view.head;
    expect(lastLine, greaterThan(0));
    expect(text[lastLine - 1], ' ', reason: 'a line starts after a space');

    // End on the line above stops before its trailing space.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.sendKeyEvent(LogicalKeyboardKey.end);
    final lineEnd = pane.view.head;
    expect(lineEnd, lessThan(lastLine));
    expect(text[lineEnd], ' ');

    // Shift+Home selects back to that line's start.
    await chord(tester, [
      LogicalKeyboardKey.shiftLeft,
    ], LogicalKeyboardKey.home);
    expect(pane.view.anchor, lineEnd);
    expect(pane.view.head, lessThan(lineEnd));
    expect(pane.view.head == 0 || text[pane.view.head - 1] == ' ', isTrue);
  });

  testWidgets('dragging a selection past the bottom scrolls', (tester) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    pane.run({
      'op': 'insert',
      'text': List.generate(120, (i) => 'Line $i').join('\n'),
    });
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.home);
    await tester.pump();
    expect(pane.scroll.offset, 0);

    final first = tester.getCenter(find.text('Line 0', findRichText: true));
    final drag = await tester.startGesture(first, buttons: kPrimaryButton);
    await tester.pump();
    // Into the status bar, under the list.
    await drag.moveTo(Offset(first.dx, 895));
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    final scrolled = pane.scroll.offset;
    final head = pane.view.head;
    expect(scrolled, greaterThan(100));
    expect(
      pane.view.blockAt(pane.view.anchor),
      0,
      reason: "anchored where pressed",
    );
    expect(head, greaterThan(pane.view.starts[20]));

    // Letting go stops it.
    await drag.up();
    await tester.pump(const Duration(milliseconds: 200));
    expect(pane.scroll.offset, scrolled);
  });

  testWidgets('the status bar picks the renderer for the next start', (
    tester,
  ) async {
    final ws = await launch(tester);
    expect(find.text('Renderer: Automatic'), findsOneWidget);
    ws.addPeer();
    await tester.pump();
    expect(
      find.byKey(const ValueKey('renderer-menu')),
      findsOneWidget,
      reason: 'one per app, not per pane',
    );

    await tester.tap(find.byKey(const ValueKey('renderer-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('renderer-software')));
    await tester.pumpAndSettle();
    expect(ws.settings.renderer, Renderer.software);
    expect(
      ws.settings.file.readAsStringSync(),
      '[display]\nrenderer=software\n',
    );
    expect(find.text('Renderer: Software'), findsOneWidget);
    expect(ws.status, 'Renderer: Software from the next start');
  }, skip: !Platform.isLinux);

  testWidgets('Ctrl+Shift+B quotes; Enter on an empty quoted line leaves', (
    tester,
  ) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'one');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(pane, 'two');
    await tester.pump();
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyA);
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
      LogicalKeyboardKey.shiftLeft,
    ], LogicalKeyboardKey.keyB);
    List<int> depths() => [for (final b in pane.view.blocks) b.quoteDepth];
    expect(depths(), [1, 1]);
    expect(pane.view.marks & Marks.bold, 0, reason: 'not bold');

    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.end);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(pane, 'after');
    await tester.pump();
    expect(texts(pane), ['one', 'two', 'after']);
    expect(depths(), [1, 1, 0]);
  });

  testWidgets('Ctrl+arrows move by word, Ctrl+Backspace deletes one', (
    tester,
  ) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'alpha beta gamma');
    await tester.pump();
    final ctrl = [LogicalKeyboardKey.controlLeft];
    await chord(tester, ctrl, LogicalKeyboardKey.arrowLeft);
    expect(pane.view.head, 11);
    await chord(tester, [
      ...ctrl,
      LogicalKeyboardKey.shiftLeft,
    ], LogicalKeyboardKey.arrowLeft);
    expect((pane.view.anchor, pane.view.head), (11, 6));
    await chord(tester, ctrl, LogicalKeyboardKey.end);
    await chord(tester, ctrl, LogicalKeyboardKey.backspace);
    expect(texts(pane), ['alpha beta ']);
    await chord(tester, ctrl, LogicalKeyboardKey.home);
    await chord(tester, ctrl, LogicalKeyboardKey.delete);
    expect(texts(pane), [' beta ']);
  });

  testWidgets('Ctrl+F finds, Enter steps, replace one and all', (tester) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'one two one');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(pane, 'three One');
    await tester.pump();
    final ctrl = [LogicalKeyboardKey.controlLeft];

    await chord(tester, ctrl, LogicalKeyboardKey.keyF);
    await tester.pump();
    await tester.enterText(find.byKey(const ValueKey('find-field')), 'one');
    await tester.pump();
    expect(pane.matches, [(0, 3), (8, 11), (18, 21)]);
    String count() =>
        tester.widget<Text>(find.byKey(const ValueKey('find-count'))).data!;
    expect(count(), '1/3', reason: 'from the caret, wrapping round');
    expect((pane.view.selectionStart, pane.view.selectionEnd), (0, 3));

    // A real Enter key in the field is not for the document.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(texts(pane), ['one two one', 'three One']);
    expect(count(), '1/3');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(count(), '2/3');
    expect((pane.view.selectionStart, pane.view.selectionEnd), (8, 11));

    // Match case: "One" drops out.
    await tester.tap(find.byKey(const ValueKey('find-case')));
    await tester.pump();
    expect(pane.matches, [(0, 3), (8, 11)]);
    await tester.tap(find.byKey(const ValueKey('find-case')));
    await tester.pump();

    await tester.enterText(find.byKey(const ValueKey('replace-field')), '1');
    await tester.tap(find.byKey(const ValueKey('replace-one')));
    await tester.pump();
    expect(texts(pane), ['one two 1', 'three One']);
    expect(count(), '2/2', reason: 'on to the next one');

    await tester.tap(find.byKey(const ValueKey('replace-all')));
    await tester.pump();
    expect(texts(pane), ['1 two 1', 'three 1']);
    expect(count(), '0');

    // Esc closes and gives the keyboard back; one undo takes "All" back.
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byType(FindBar), findsNothing);
    expect(pane.focus.hasFocus, isTrue);
    await chord(tester, ctrl, LogicalKeyboardKey.keyZ);
    expect(texts(pane), ['one two 1', 'three One']);
  });

  testWidgets('rich clipboard: copy offers HTML, paste prefers it, '
      'Mermaid source asks first', (tester) async {
    String? text;
    String? html;
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.getData') return {'text': text};
      return null;
    });
    messenger.setMockMethodCallHandler(
      const MethodChannel('collabdoc/clipboard'),
      (call) async {
        if (call.method == 'write') {
          final args = call.arguments as Map;
          text = args['text'] as String;
          html = args['html'] as String;
        }
        if (call.method == 'readHtml') return html;
        return null;
      },
    );
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      messenger.setMockMethodCallHandler(
        const MethodChannel('collabdoc/clipboard'),
        null,
      );
    });
    final ctrl = [LogicalKeyboardKey.controlLeft];

    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'Bold');
    await chord(tester, [
      LogicalKeyboardKey.shiftLeft,
    ], LogicalKeyboardKey.home);
    await chord(tester, ctrl, LogicalKeyboardKey.keyB);
    await chord(tester, ctrl, LogicalKeyboardKey.keyC);
    await tester.pumpAndSettle();
    expect(text, '**Bold**');
    expect(html, '<meta charset="utf-8"><p><strong>Bold</strong></p>');

    // HTML wins over the text beside it.
    text = 'plain words';
    html = '<h2>From a browser</h2><ul><li>item</li></ul>';
    await chord(tester, ctrl, LogicalKeyboardKey.end);
    await chord(tester, ctrl, LogicalKeyboardKey.keyV);
    await tester.pumpAndSettle();
    expect(texts(pane), ['Bold', 'From a browser', 'item']);
    expect(pane.view.blocks[1].kind, 'heading');
    expect(pane.view.blocks[2].list, 'bullet');

    // Mermaid source: asked, then inserted as a diagram.
    text = 'graph TD\n  A --> B';
    html = null;
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await chord(tester, ctrl, LogicalKeyboardKey.keyV);
    await tester.pumpAndSettle();
    expect(find.text('Insert as Mermaid diagram?'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('mermaid-diagram')));
    await tester.pumpAndSettle();
    expect(pane.view.blocks.any((b) => b.kind == 'atom'), isTrue);
    expect(pane.focus.hasFocus, isTrue);
  });

  testWidgets('the start screen: new, autosave, leaving a draft asks', (
    tester,
  ) async {
    final dir = scratch();
    final app = await launchApp(tester, dir: dir, withDocument: false);
    expect(
      find.text('No documents yet. Create one or open a file from disk.'),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const ValueKey('start-new')));
    await tester.pumpAndSettle();
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'Kept by autosave');
    await tester.pump(const Duration(milliseconds: 600)); // a tick
    String status() =>
        tester.widget<Text>(find.byKey(const ValueKey('persist-status'))).data!;
    expect(status(), 'Draft · saved automatically');

    // Home: a draft with content asks; Save as… picks a place.
    final file = '${dir.path}/docs/Kept.collabdoc';
    app.pickSavePath = ({suggested, markdown = false}) async => file;
    await tester.tap(find.text('Home'));
    await tester.pumpAndSettle();
    expect(find.text('Discard this draft?'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('leave-save-as')));
    await tester.pumpAndSettle();
    expect(find.byType(EditorPane), findsNothing, reason: 'back at the start');
    expect(File(file).existsSync(), isTrue);
    final recent = app.listing.recents.single;
    expect((recent.title, recent.path), ('Kept', file));
    expect(recent.preview, 'Kept by autosave');

    // A saved file opens from the recents without asking when left.
    await tester.tap(find.byKey(ValueKey('recent-${recent.docId}')));
    await tester.pumpAndSettle();
    final again = tester.state<EditorPaneState>(find.byType(EditorPane));
    expect(texts(again), ['Kept by autosave']);
    expect(status(), 'Saved · $file');
    await tester.tap(find.text('Home'));
    await tester.pumpAndSettle();
    expect(find.text('Discard this draft?'), findsNothing);

    // A new draft left with "Don't save" is gone.
    await tester.tap(find.byKey(const ValueKey('start-new')));
    await tester.pumpAndSettle();
    type(tester.state<EditorPaneState>(find.byType(EditorPane)), 'scrap');
    await tester.pump(const Duration(milliseconds: 600));
    await tester.tap(find.text('Home'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('leave-discard')));
    await tester.pumpAndSettle();
    expect(app.listing.recents.map((r) => r.title), ['Kept']);
  });

  testWidgets('after a crash the start screen offers the draft back', (
    tester,
  ) async {
    // Autosave 2 s after the edit, which the crash beats: only the journal
    // has the text.
    final dir = scratch(idleMs: 2000);
    final first = await launchApp(tester, dir: dir);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'typed just before the crash');
    await tester.pump(); // journaled with the edit, before any autosave

    // The next run: a new store over the same folders, the start screen.
    CoreStore.configure(
      userData: '${dir.path}/user',
      documentsDir: '${dir.path}/docs',
    );
    final app = AppController(settings: first.settings);
    addTearDown(() => app.workspace?.dispose());
    await tester.pumpWidget(CollabDocApp(app: app));
    await tester.pumpAndSettle();
    final offer = app.listing.recoveries.single;
    expect(offer.preview, 'typed just before the crash');
    expect(find.text('Recover “Untitled”'), findsOneWidget);
    await tester.tap(find.text('Recover').last);
    await tester.pumpAndSettle();
    final back = tester.state<EditorPaneState>(find.byType(EditorPane));
    expect(texts(back), ['typed just before the crash']);
    expect(app.workspace!.status, 'Recovered edits made after the last save');
  });

  testWidgets('Markdown opens as a new document and exports back', (
    tester,
  ) async {
    final dir = scratch();
    final md = File('${dir.path}/notes.md')
      ..writeAsStringSync('# Notes\n\nHello **there**\n\n- one\n');
    final app = await launchApp(tester, dir: dir, withDocument: false);
    app.pickOpenPath = ({suggested, markdown = false}) async => md.path;
    await tester.tap(find.byKey(const ValueKey('start-open')));
    await tester.pumpAndSettle();
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    expect(texts(pane), ['Hello there', 'one']);
    expect(pane.view.title, 'Notes');
    expect(app.workspace!.suggestedPath, '${dir.path}/notes.collabdoc');

    final out = '${dir.path}/exported.md';
    app.pickSavePath = ({suggested, markdown = false}) async => out;
    await tester.tap(find.text('Export .md'));
    await tester.pumpAndSettle();
    expect(
      File(out).readAsStringSync(),
      '# Notes\n\nHello **there**\n\n- one\n',
    );
    expect(md.readAsStringSync(), '# Notes\n\nHello **there**\n\n- one\n');
  });

  testWidgets('a moved file says so and can be removed', (tester) async {
    final dir = scratch();
    final file = File('${dir.path}/gone.collabdoc');
    // Make a saved document, then lose its file.
    final ws = Workspace.openPath(file.path);
    ws.close();
    ws.dispose();
    file.deleteSync();
    final app = await launchApp(tester, dir: dir, withDocument: false);
    expect(find.textContaining('Moved or deleted'), findsOneWidget);
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(app.listing.recents, isEmpty);
  });
}
