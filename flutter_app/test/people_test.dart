// Phase 5 in the Flutter layer (spec 07): the first-launch name prompt and
// the profile kept across restarts; the People tab with role and status and
// offline collaborators; claimed blocks outlined with the claimer's name.
//
// Needs the native library, as editor_test.dart does.

import 'dart:io';

import 'package:collabdoc/app.dart';
import 'package:collabdoc/editor.dart';
import 'package:collabdoc/native.dart';
import 'package:collabdoc/people_panel.dart';
import 'package:collabdoc/settings.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'editor_test.dart' show chord, launch, launchApp, scratch, texts, type;

final ctrlAlt = [LogicalKeyboardKey.controlLeft, LogicalKeyboardKey.altLeft];

EditorPaneState paneAt(WidgetTester tester, int i) =>
    tester.stateList<EditorPaneState>(find.byType(EditorPane)).elementAt(i);

/// The app started again on the same store (as after a restart).
Future<AppController> restart(WidgetTester tester, Directory dir) async {
  // A new process would read the profile afresh.
  CoreStore.configure(
    userData: '${dir.path}/user',
    documentsDir: '${dir.path}/docs',
  );
  final app = AppController(
    settings: Settings(File('${dir.path}/settings.ini')),
  );
  await tester.pumpWidget(const SizedBox());
  await tester.pumpWidget(CollabDocApp(app: app));
  await tester.pump();
  return app;
}

void main() {
  testWidgets('the first launch asks a name; it is kept across restarts', (
    tester,
  ) async {
    final dir = scratch();
    final app = await launchApp(tester, dir: dir, withDocument: false);
    expect(find.byKey(const ValueKey('ask-name')), findsOneWidget);

    // The handle follows the name until it is typed.
    await tester.enterText(
      find.byKey(const ValueKey('profile-name')),
      'Ana Lopez',
    );
    await tester.pump();
    final handle = find.byKey(const ValueKey('profile-handle'));
    expect(tester.widget<TextField>(handle).controller!.text, 'ana-lopez');

    // An invalid handle is refused, with the rule.
    await tester.enterText(handle, 'Ana!');
    await tester.tap(find.byKey(const ValueKey('profile-save')));
    await tester.pump();
    expect(find.byKey(const ValueKey('profile-handle-error')), findsOneWidget);
    expect(app.askName, isTrue);

    await tester.enterText(handle, 'ana');
    await tester.tap(find.byKey(const ValueKey('profile-color-#1f8a70')));
    await tester.tap(find.byKey(const ValueKey('profile-save')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('ask-name')), findsNothing);
    expect(find.text('Ana Lopez'), findsOneWidget, reason: 'the chip');
    expect(find.text('@ana'), findsOneWidget);

    // A new document is written by Ana.
    await tester.tap(find.byKey(const ValueKey('start-new')));
    await tester.pumpAndSettle();
    expect(app.workspace!.participants.first.name, 'Ana Lopez');
    expect(app.workspace!.participants.first.color, '#1f8a70');
    app.closeDocument(discard: true);
    await tester.pumpAndSettle();

    // Started again: no question, the same profile.
    final again = await restart(tester, dir);
    expect(again.askName, isFalse);
    expect(again.profile.name, 'Ana Lopez');
    expect(find.byKey(const ValueKey('ask-name')), findsNothing);

    // Edit profile from the chip.
    await tester.tap(find.byKey(const ValueKey('profile-chip')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(
        of: find.byType(Dialog),
        matching: find.byKey(const ValueKey('profile-name')),
      ),
      'Ana L.',
    );
    await tester.tap(
      find.descendant(
        of: find.byType(Dialog),
        matching: find.byKey(const ValueKey('profile-save')),
      ),
    );
    await tester.pumpAndSettle();
    expect(again.profile.name, 'Ana L.');
    expect(again.profile.handle, 'ana', reason: 'a typed handle stays');
  });

  testWidgets('skipping the question is remembered too', (tester) async {
    final dir = scratch();
    final app = await launchApp(tester, dir: dir, withDocument: false);
    await tester.tap(find.byKey(const ValueKey('profile-cancel')));
    await tester.pump();
    expect(app.askName, isFalse);
    expect(app.profile.name, 'You');
    final again = await restart(tester, dir);
    expect(again.askName, isFalse);
  });

  testWidgets('People lists who is here, what they do, and who was here', (
    tester,
  ) async {
    final ws = await launch(tester);
    final mine = paneAt(tester, 0);
    type(mine, 'First line');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(mine, 'Second line');
    ws.addPeer();
    await tester.pumpAndSettle();
    final theirs = paneAt(tester, 1);
    theirs.run({'op': 'select', 'anchor': 2, 'head': 2});
    type(theirs, 'x');
    await tester.pump(const Duration(milliseconds: 150));

    await tester.tap(find.text('People').first);
    await tester.pumpAndSettle();
    final panel = tester.state<PeoplePanelState>(find.byType(PeoplePanel));
    final rows = panel.people.session;
    expect(rows.map((p) => p.name), containsAll(['You', 'Peer 2']));
    final you = rows.firstWhere((p) => p.kind == 'you');
    final peer = rows.firstWhere((p) => p.name == 'Peer 2');
    expect(you.handle, 'you');
    expect(peer.handle, 'peer-2');
    expect(peer.kind, 'peer');
    expect(peer.status, 'typing in ¶1');
    expect(you.status, 'typing in ¶2');
    expect(find.byKey(ValueKey('person-${peer.id}')), findsOneWidget);
    expect(find.text('Human'), findsOneWidget);

    // The peer leaves: no longer in the session, still on the document.
    ws.removePeer(ws.participants[1]);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(panel.people.session.map((p) => p.name), ['You']);
    final gone = panel.people.everyone.firstWhere((p) => p.name == 'Peer 2');
    expect(gone.online, isFalse);
    expect(find.byKey(ValueKey('person-${gone.id}')), findsOneWidget);
    expect(find.text('offline'), findsOneWidget);

    // @ offers everyone on the document, the one who left too.
    mine.focus.requestFocus();
    await tester.pump();
    type(mine, ' ');
    type(mine, '@');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('mention-Peer 2')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('mention-Peer 2')));
    await tester.pumpAndSettle();
    final chip = mine.view.blocks.last.inlines.last;
    expect((chip.attr('handle'), chip.attr('id')), ('peer-2', gone.id));
  });

  testWidgets('a claim outlines the blocks with the claimer\'s name', (
    tester,
  ) async {
    final ws = await launch(tester);
    final mine = paneAt(tester, 0);
    type(mine, 'Mine');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    type(mine, 'Theirs');
    ws.addPeer();
    await tester.pumpAndSettle();
    final theirs = paneAt(tester, 1);
    final blockId = theirs.view.blocks[1].blockId;

    // Ctrl+Alt+L in the peer's pane claims the block the caret is in.
    theirs.run({'op': 'select', 'anchor': 7, 'head': 7});
    theirs.focus.requestFocus();
    await tester.pump();
    await chord(tester, ctrlAlt, LogicalKeyboardKey.keyL);
    await tester.pump(const Duration(milliseconds: 150));
    expect(mine.claims[blockId]?.$1, 'Peer 2');
    expect(texts(mine), ['Mine', 'Theirs']);
    expect(
      find.descendant(
        of: find.byType(EditorPane).first,
        matching: find.byKey(ValueKey('claim-$blockId')),
      ),
      findsOneWidget,
    );
    expect(find.text('Peer 2 is editing'), findsOneWidget);
    expect(theirs.claims[blockId]?.$1, 'You', reason: 'ours shows too');

    // Given up: the outline goes.
    await chord(tester, ctrlAlt, LogicalKeyboardKey.keyL);
    await tester.pump(const Duration(milliseconds: 150));
    expect(mine.claims, isEmpty);
    expect(find.text('Peer 2 is editing'), findsNothing);

    // One that runs out goes by itself.
    theirs.session.claim(seconds: 1);
    ws.publishPresence(ws.participants[1]);
    await tester.pump();
    expect(mine.claims[blockId]?.$1, 'Peer 2');
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 1100)),
    );
    await tester.pump(const Duration(milliseconds: 1100));
    expect(mine.claims, isEmpty);
    expect(find.text('Peer 2 is editing'), findsNothing);
  });
}
