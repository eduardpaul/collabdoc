// Per-keystroke cost of the Rust bridge (edit + full view as JSON) on a big
// document. Skipped unless COLLABDOC_PERF_DOC points at a .collabdoc, e.g.
// one from `cargo run --release -p collabdoc-core --example generate`.

import 'dart:io';

import 'package:collabdoc/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final path = Platform.environment['COLLABDOC_PERF_DOC'];
  test('bridge cost per keystroke', () {
    final session = Session.open(path);
    addTearDown(session.dispose);
    var view = session.view();
    final middle = view.starts[view.blocks.length ~/ 2] + 10;
    session.call({'op': 'select', 'anchor': middle, 'head': middle});
    const keys = 200;
    final edit = Stopwatch();
    final read = Stopwatch();
    for (var i = 0; i < keys; i++) {
      edit.start();
      session.edit({'op': 'insert', 'text': 'x'});
      edit.stop();
      read.start();
      view = session.view();
      read.stop();
    }
    // ignore: avoid_print
    print(
      '${view.blocks.length} blocks: edit ${edit.elapsedMicroseconds ~/ keys} µs, '
      'view (JSON + decode) ${read.elapsedMicroseconds ~/ keys} µs per keystroke',
    );
  }, skip: path == null ? 'set COLLABDOC_PERF_DOC' : false);
}
