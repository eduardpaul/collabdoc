// CollabDoc in Flutter over the Rust document core.
//
// `collabdoc` shows the start screen (recents, recoveries); `collabdoc
// file.collabdoc` (or a `.md` to import) opens that file, or a new document
// that saves there. "+ Peer" (Ctrl+Shift+N) adds a pane that is a second
// participant on the same document, synced through Loro like a remote
// collaborator would be.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'app.dart';

void main(List<String> args) {
  if (Platform.environment['COLLABDOC_FRAME_TIMES'] == '1') _logFrameTimes();
  final app = AppController();
  if (args.isNotEmpty) app.openPath(args.first);
  runApp(CollabDocApp(app: app));
}

/// Prints build/raster times every 30 frames (for typing-latency checks).
void _logFrameTimes() {
  final build = <int>[];
  final raster = <int>[];
  WidgetsFlutterBinding.ensureInitialized();
  SchedulerBinding.instance.addTimingsCallback((timings) {
    for (final t in timings) {
      build.add(t.buildDuration.inMicroseconds);
      raster.add(t.rasterDuration.inMicroseconds);
    }
    if (build.length >= 30) {
      int p(List<int> xs, double q) => (xs..sort())[(xs.length * q).floor()];
      stderr.writeln(
        'frames ${build.length}: build p50 ${p(build, .5)}µs p95 ${p(build, .95)}µs, '
        'raster p50 ${p(raster, .5)}µs p95 ${p(raster, .95)}µs',
      );
      build.clear();
      raster.clear();
    }
  });
}
