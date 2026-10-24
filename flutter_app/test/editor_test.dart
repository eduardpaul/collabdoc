// The Flutter layer, headless: real key handling and platform text input
// driving EditorPane over the Rust core, and two panes syncing.
//
// Needs the native library: `cargo build -p collabdoc-ffi`, then
//   COLLABDOC_FFI_LIB=../target/debug/libcollabdoc_ffi.so flutter test

import 'package:collabdoc/editor.dart';
import 'package:collabdoc/main.dart';
import 'package:collabdoc/workspace.dart';
import 'package:flutter/foundation.dart';
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

Future<Workspace> launch(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1600, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final ws = Workspace.open(null);
  addTearDown(ws.dispose);
  await tester.pumpWidget(CollabDocApp(workspace: ws));
  await tester.pump();
  return ws;
}

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
}
