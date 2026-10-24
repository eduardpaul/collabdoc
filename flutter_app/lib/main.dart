// CollabDoc in Flutter over the Rust document core.
//
// `collabdoc [file.collabdoc]` opens a file, or a new document that saves
// there. "+ Peer" (Ctrl+Shift+N) adds a pane that is a second participant on
// the same document, synced through Loro like a remote collaborator would be.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'editor.dart';
import 'theme.dart';
import 'workspace.dart';

void main(List<String> args) {
  if (Platform.environment['COLLABDOC_FRAME_TIMES'] == '1') _logFrameTimes();
  runApp(
    CollabDocApp(workspace: Workspace.open(args.isEmpty ? null : args.first)),
  );
}

class CollabDocApp extends StatelessWidget {
  const CollabDocApp({super.key, required this.workspace});

  final Workspace workspace;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CollabDoc',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        fontFamily: uiFont,
        scaffoldBackgroundColor: AppColors.bg,
      ),
      home: Material(
        color: AppColors.bg,
        child: ListenableBuilder(
          listenable: workspace,
          builder: (context, _) => Row(
            children: [
              for (final (i, p) in workspace.participants.indexed) ...[
                if (i > 0)
                  const VerticalDivider(width: 1, color: AppColors.border),
                Expanded(
                  child: EditorPane(
                    key: ObjectKey(p),
                    workspace: workspace,
                    participant: p,
                    autofocus: i == workspace.participants.length - 1,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
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
