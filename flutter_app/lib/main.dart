// CollabDoc in Flutter over the Rust document core.
//
// `collabdoc [file.collabdoc]` opens a file, or a new document that saves
// there. "+ Peer" (Ctrl+Shift+N) adds a pane that is a second participant on
// the same document, synced through Loro like a remote collaborator would be.

import 'package:flutter/material.dart';

import 'editor.dart';
import 'theme.dart';
import 'workspace.dart';

void main(List<String> args) {
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
