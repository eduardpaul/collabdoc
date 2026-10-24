// Phase 3 in the Flutter layer: hard breaks and mention chips in the line,
// figures drawn natively (Mermaid by the core, images from the document's
// bytes) and edited from the bar a selected figure shows.
//
// Needs the native library, as editor_test.dart does.

import 'dart:convert';
import 'dart:io';

import 'package:collabdoc/editor.dart';
import 'package:collabdoc/figures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'editor_test.dart' show chord, launch, launchApp, scratch, texts, type;

/// The core's starting diagram (`figures::DEFAULT_MERMAID`).
const defaultMermaid =
    'flowchart LR\n  A[Write] --> B[Review]\n  B --> C[Publish]';

/// A 1×1 PNG.
final png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
);

final ctrlAlt = [LogicalKeyboardKey.controlLeft, LogicalKeyboardKey.altLeft];

Finder imagesIn(Finder figure) =>
    find.descendant(of: figure, matching: find.byType(Image));

/// Lets drawn figures (finished on the real event loop) reach their
/// widgets, then builds.
Future<void> settleFigures(WidgetTester tester) async {
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 50)),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(FigureImages.clear);

  testWidgets('Shift+Enter breaks the line; @ picks someone to mention', (
    tester,
  ) async {
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'Ask');
    await chord(tester, [
      LogicalKeyboardKey.shiftLeft,
    ], LogicalKeyboardKey.enter);
    type(pane, 'line two ');
    await tester.pump();
    expect(texts(pane), ['Ask￼line two ']);
    expect(pane.view.blocks.single.inlines.single.name, 'hardBreak');

    // `@` opens the picker; the chip takes the `@`'s place.
    type(pane, '@');
    await tester.pumpAndSettle();
    expect(find.text('Mention'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('mention-You')));
    await tester.pumpAndSettle();
    final block = pane.view.blocks.single;
    expect(block.text, 'Ask￼line two ￼ ');
    final chip = block.inlines.last;
    expect(
      (chip.name, chip.attr('label'), chip.attr('handle')),
      ('mention', 'You', 'you'),
    );
    expect(find.byType(MentionChip), findsOneWidget);
    expect(find.text('@You'), findsOneWidget);
    expect(pane.focus.hasFocus, isTrue);

    // Backspace takes the chip (and the space after it) out whole.
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.pump();
    expect(texts(pane), ['Ask￼line two ']);
    expect(find.byType(MentionChip), findsNothing);
  });

  testWidgets('a diagram is drawn natively and edited from its bar', (
    tester,
  ) async {
    // Drawn on a real isolate before the widget asks for it.
    final drawn = await tester.runAsync(
      () => FigureImages.mermaid(defaultMermaid, 1.0),
    );
    expect(drawn!.bytes.take(4), [0x89, 0x50, 0x4E, 0x47]);

    final ws = await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    type(pane, 'Intro');
    await chord(tester, ctrlAlt, LogicalKeyboardKey.keyM);
    await settleFigures(tester);
    final i = pane.view.blocks.indexWhere((b) => b.kind == 'atom');
    expect(pane.view.blocks[i].nodeName, 'mermaidFigure');
    final figure = find.byType(FigureView);
    expect(imagesIn(figure), findsOneWidget);

    // The caret is on the new figure: its bar is up.
    await tester.tap(find.byKey(const ValueKey('figure-width-50')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('figure-align-right')));
    await tester.pump();
    expect(pane.view.blocks[i].attrs['width'], 50);
    expect(pane.view.blocks[i].attr('align'), 'right');

    await tester.tap(find.byKey(const ValueKey('figure-caption')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('figure-text-field')),
      'The flow',
    );
    await tester.tap(find.byKey(const ValueKey('figure-text-ok')));
    await tester.pumpAndSettle();
    expect(pane.view.blocks[i].caption, 'The flow');
    expect(find.text('The flow'), findsOneWidget);

    // Undo is per edit: the caption goes first.
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyZ);
    expect(pane.view.blocks[i].caption, '');
    expect(ws.persist?.dirty, isNotNull);
  });

  testWidgets('Insert image takes a file; what is no image is refused', (
    tester,
  ) async {
    final dir = scratch();
    final app = await launchApp(tester, dir: dir);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    final image = File('${dir.path}/dot.png')..writeAsBytesSync(png);
    final text = File('${dir.path}/notes.txt')..writeAsStringSync('hello');

    app.pickImagePath = () async => text.path;
    await chord(tester, ctrlAlt, LogicalKeyboardKey.keyP);
    await tester.pumpAndSettle();
    expect(app.workspace!.status, contains('not an image'));
    expect(pane.view.blocks.where((b) => b.kind == 'atom'), isEmpty);

    app.pickImagePath = () async => image.path;
    await chord(tester, ctrlAlt, LogicalKeyboardKey.keyP);
    await settleFigures(tester);
    final figure = pane.view.blocks.singleWhere((b) => b.kind == 'atom');
    expect(figure.nodeName, 'imageFigure');
    expect(figure.attr('src'), startsWith('asset:'));
    expect(imagesIn(find.byType(FigureView)), findsOneWidget);
    // The bytes are the document's: a second participant shows them too.
    expect(
      pane.session.asset(figure.attr('src').substring('asset:'.length)),
      png,
    );
  });

  testWidgets('a pasted screenshot becomes an image figure', (tester) async {
    final messenger = tester.binding.defaultBinaryMessenger;
    // No text on the clipboard, only an image.
    messenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async => null,
    );
    messenger.setMockMethodCallHandler(
      const MethodChannel('collabdoc/clipboard'),
      (call) async => call.method == 'readImage' ? png : null,
    );
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      messenger.setMockMethodCallHandler(
        const MethodChannel('collabdoc/clipboard'),
        null,
      );
    });
    await launch(tester);
    final pane = tester.state<EditorPaneState>(find.byType(EditorPane));
    await chord(tester, [
      LogicalKeyboardKey.controlLeft,
    ], LogicalKeyboardKey.keyV);
    await tester.pumpAndSettle();
    expect(pane.view.blocks.any((b) => b.nodeName == 'imageFigure'), isTrue);
  });
}
