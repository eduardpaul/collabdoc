// Phase 4 in the Flutter layer: the History tab (entries per author,
// filters, diff, checkpoints), viewing a version read-only, restoring it as
// one undoable commit, and the attribution gutter (spec 05).
//
// Needs the native library, as editor_test.dart does.

import 'package:collabdoc/editor.dart';
import 'package:collabdoc/history_panel.dart';
import 'package:collabdoc/workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'editor_test.dart' show chord, launch, texts, type;

final ctrl = [LogicalKeyboardKey.controlLeft];

/// Lets history settle (it re-reads 400 ms after edits).
Future<void> settle(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 500));
  await tester.pumpAndSettle();
}

EditorPaneState paneOf(WidgetTester tester, Participant p) => tester
    .stateList<EditorPaneState>(find.byType(EditorPane))
    .firstWhere((s) => identical(s.widget.participant, p));

void main() {
  testWidgets('history: attribution, filters, diff, checkpoint, view, restore', (
    tester,
  ) async {
    final ws = await launch(tester);
    final you = ws.participants.first;
    var mine = paneOf(tester, you);
    type(mine, 'first draft');
    await tester.pump();
    await tester.tap(find.text('History'));
    await settle(tester);
    final panel = tester.state<HistoryPanelState>(find.byType(HistoryPanel));
    expect(panel.entries.any((e) => e.author.name == 'You'), isTrue);

    // A checkpoint of this version.
    await tester.enterText(
      find.byKey(const ValueKey('checkpoint-name')),
      'Draft 1',
    );
    await tester.tap(find.byKey(const ValueKey('checkpoint-mark')));
    await settle(tester);
    expect(panel.checkpoints.single.name, 'Draft 1');
    final pinned = ValueKey('checkpoint-${panel.checkpoints.single.id}');
    expect(find.byKey(pinned), findsOneWidget);

    // A second participant (focus is in the checkpoint field) rewrites the
    // line.
    ws.addPeer();
    await tester.pumpAndSettle();
    final peer = ws.participants[1];
    final theirs = paneOf(tester, peer);
    theirs.run({'op': 'selectAll'});
    theirs.run({'op': 'insert', 'text': 'rewritten by a peer'});
    await tester.pump();
    await settle(tester);
    mine = paneOf(tester, you);
    expect(texts(mine), ['rewritten by a peer']);

    // Each change under its author; the peer's chip filters to theirs.
    final peerActor = panel.entries
        .firstWhere((e) => e.author.name == 'Peer 2')
        .author
        .actorId;
    await tester.tap(find.byKey(ValueKey('history-author-$peerActor')));
    await tester.pump();
    final rows = tester
        .widgetList<GestureDetector>(
          find.descendant(
            of: find.byKey(const ValueKey('history-list')),
            matching: find.byWidgetPredicate(
              (w) =>
                  w is GestureDetector &&
                  (w.key as ValueKey?)?.value.toString().startsWith(
                        'history-',
                      ) ==
                      true,
            ),
          ),
        )
        .toList();
    expect(rows, isNotEmpty);
    expect(find.text('You'), findsNothing, reason: 'only the peer is listed');

    // Its diff: the old words struck, the new ones added.
    await tester.tap(find.byWidget(rows.first));
    await tester.pump();
    expect(find.byKey(const ValueKey('diff-board')), findsOneWidget);
    expect(find.byKey(const ValueKey('hunk-change')), findsWidgets);

    // View the checkpoint: the pane shows it read-only, typing changes nothing.
    await tester.tap(find.byKey(const ValueKey('history-all')));
    await tester.pump();
    await tester.tap(find.byKey(pinned));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('version-banner')), findsOneWidget);
    final version = tester
        .stateList<EditorPaneState>(find.byType(EditorPane))
        .firstWhere((s) => s.widget.readOnly);
    expect(texts(version), ['first draft']);
    type(version, 'typed into the past');
    await tester.pump();
    expect(texts(version), ['first draft']);

    // Restore it: one commit by You, the peer's pane follows, Ctrl+Z undoes.
    await tester.tap(find.byKey(const ValueKey('version-restore')));
    await settle(tester);
    expect(find.byKey(const ValueKey('version-banner')), findsNothing);
    mine = paneOf(tester, you);
    expect(texts(mine), ['first draft']);
    expect(texts(paneOf(tester, peer)), ['first draft']);
    final restore = panel.entries.lastWhere(
      (e) => e.message == 'Restore version',
    );
    expect(restore.author.name, 'You');
    expect(
      panel.entries.any((e) => e.author.name == 'Peer 2'),
      isTrue,
      reason: 'history keeps what came after the version',
    );
    mine.focus.requestFocus();
    await tester.pump();
    await chord(tester, ctrl, LogicalKeyboardKey.keyZ);
    await tester.pump();
    expect(texts(mine), ['rewritten by a peer']);
  });

  testWidgets('the Authors gutter shows who wrote each block last', (
    tester,
  ) async {
    final ws = await launch(tester);
    final mine = paneOf(tester, ws.participants.first);
    type(mine, 'mine');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(mine, 'also mine');
    await tester.pump();
    await tester.tap(find.text('Authors'));
    await settle(tester);
    expect(ws.attribution, isTrue);
    final blockId = mine.view.blocks.first.blockId;
    final gutter = tester.widget<Container>(
      find.byKey(ValueKey('gutter-$blockId')).first,
    );
    final border = (gutter.decoration! as BoxDecoration).border! as Border;
    expect(border.left.color, isNot(Colors.transparent));
    await tester.tap(find.text('Authors'));
    await tester.pump();
    expect(find.byKey(ValueKey('gutter-$blockId')), findsNothing);
  });
}
