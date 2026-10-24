// The app: the start screen, or a document's workspace (its panes).
//
// Leaving a document goes through here: a draft with content asks first, as
// in the TS app ("Save as…", "Don't save" deletes it, "Cancel"); saved files
// never ask, they are autosaved. Quitting writes what is unsaved.

import 'dart:async';
import 'dart:io';
import 'dart:ui' show AppExitResponse;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import 'editor.dart';
import 'model.dart';
import 'native.dart';
import 'settings.dart';
import 'start_screen.dart';
import 'theme.dart';
import 'workspace.dart';

/// Picks a file to open, or where to save; replaced in tests.
typedef PickPath = Future<String?> Function({String? suggested, bool markdown});

class AppController extends ChangeNotifier {
  AppController({Workspace? workspace, Settings? settings})
    : settings = settings ?? Settings.forUser() {
    _show(workspace);
    if (workspace == null) refreshListing();
  }

  final Settings settings;
  Workspace? workspace;
  Listing listing = const Listing.empty();

  /// One line for the start screen (an error opening a file…).
  String notice = '';

  PickPath pickOpenPath = _pickOpen;
  PickPath pickSavePath = _pickSave;

  void refreshListing() {
    listing = CoreStore.listing();
    notifyListeners();
  }

  void _show(Workspace? next) {
    workspace?.removeListener(notifyListeners);
    workspace = next;
    next?.addListener(notifyListeners);
    notice = '';
    notifyListeners();
  }

  /// Opens a workspace made by `make`, or says why it could not.
  void _open(Workspace Function() make) {
    try {
      _show(make());
    } on CoreException catch (e) {
      notice = e.message;
      refreshListing();
    }
  }

  void newDocument() => _open(() => Workspace.create(settings: settings));

  void openPath(String path) =>
      _open(() => Workspace.openPath(path, settings: settings));

  /// A recents entry: its file, or (a draft) its draft.
  void openRecent(RecentEntry entry) {
    final path = entry.path;
    if (path == null) {
      recover(entry.docId);
    } else {
      openPath(path);
    }
  }

  void recover(String docId) =>
      _open(() => Workspace.recover(docId, settings: settings));

  void discardRecovery(String docId) {
    CoreStore.discardDraft(docId);
    refreshListing();
  }

  void removeRecent(String docId) {
    CoreStore.removeRecent(docId);
    refreshListing();
  }

  /// A moved file found again: it replaces the stale entry.
  void locate(RecentEntry entry, String path) {
    CoreStore.removeRecent(entry.docId);
    openPath(path);
  }

  /// Back to the start screen (the document is written or, with
  /// `discard`, its draft deleted).
  void closeDocument({bool discard = false}) {
    final ws = workspace;
    _show(null);
    ws?.close(discard: discard);
    ws?.dispose();
    refreshListing();
  }

  /// Quitting: everything unsaved is written.
  void closeAll() {
    workspace?.close();
  }

  // ── Flows with dialogs ──

  /// Ctrl+S; a draft asks where first.
  Future<void> save(BuildContext context) async {
    final ws = workspace;
    if (ws == null) return;
    if (ws.save() == SaveResult.needsSaveAs) await saveAs(context);
  }

  /// Ctrl+Shift+S. True when it saved.
  Future<bool> saveAs(BuildContext context) async {
    final ws = workspace;
    if (ws == null) return false;
    final path = await pickSavePath(suggested: ws.suggestedPath);
    if (path == null) return false;
    return ws.saveAs(_withExtension(path, '.collabdoc'));
  }

  Future<void> exportMarkdown(BuildContext context) async {
    final ws = workspace;
    if (ws == null) return;
    final base = ws.suggestedPath.replaceFirst(RegExp(r'\.collabdoc$'), '');
    final path = await pickSavePath(suggested: '$base.md', markdown: true);
    if (path != null) ws.exportMarkdown(_withExtension(path, '.md'));
  }

  /// Whether the current document may be left; a draft with content asks.
  Future<bool> confirmLeave(BuildContext context) async {
    final ws = workspace;
    if (ws == null || !ws.leavingAsks) return true;
    final answer = await showDialog<_Leave>(
      context: context,
      builder: (context) => _LeaveDialog(title: ws.persist?.title ?? ''),
    );
    switch (answer) {
      case _Leave.saveAs:
        if (!context.mounted) return false;
        return saveAs(context);
      case _Leave.discard:
        closeDocument(discard: true);
        return true;
      case _Leave.cancel || null:
        return false;
    }
  }

  /// Leave (if allowed), then `next`.
  Future<void> leaveThen(BuildContext context, VoidCallback next) async {
    if (await confirmLeave(context)) next();
  }

  /// Open…: a `.collabdoc` or Markdown file.
  Future<void> openFile(BuildContext context) async {
    final path = await pickOpenPath();
    if (path == null || !context.mounted) return;
    await leaveThen(context, () {
      if (workspace != null) closeDocument();
      openPath(path);
    });
  }

  Future<void> newFromEditor(BuildContext context) => leaveThen(context, () {
    closeDocument();
    newDocument();
  });

  Future<void> home(BuildContext context) => leaveThen(context, closeDocument);
}

String _withExtension(String path, String ext) =>
    path.toLowerCase().endsWith(ext) ? path : '$path$ext';

const _collabdocFiles = XTypeGroup(
  label: 'CollabDoc',
  extensions: ['collabdoc'],
);
const _markdownFiles = XTypeGroup(
  label: 'Markdown',
  extensions: ['md', 'markdown', 'txt'],
);

Future<String?> _pickOpen({String? suggested, bool markdown = false}) async {
  final file = await openFile(
    acceptedTypeGroups: const [
      XTypeGroup(
        label: 'Documents',
        extensions: ['collabdoc', 'md', 'markdown', 'txt'],
      ),
      _collabdocFiles,
      _markdownFiles,
    ],
  );
  return file?.path;
}

Future<String?> _pickSave({String? suggested, bool markdown = false}) async {
  final dir = suggested == null ? null : File(suggested).parent.path;
  final name = suggested?.split(Platform.pathSeparator).last;
  final location = await getSaveLocation(
    suggestedName: name,
    initialDirectory: dir != null && Directory(dir).existsSync() ? dir : null,
    acceptedTypeGroups: [markdown ? _markdownFiles : _collabdocFiles],
  );
  return location?.path;
}

enum _Leave { saveAs, discard, cancel }

class _LeaveDialog extends StatelessWidget {
  const _LeaveDialog({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final name = title.isEmpty ? 'Untitled' : title;
    return AlertDialog(
      backgroundColor: AppColors.panel,
      title: const Text(
        'Discard this draft?',
        style: TextStyle(
          fontFamily: uiFont,
          fontSize: 15,
          color: AppColors.text,
        ),
      ),
      content: Text(
        '“$name” has not been saved to a file. Don\'t save deletes the draft.',
        style: const TextStyle(fontFamily: uiFont, color: AppColors.muted),
      ),
      actions: [
        TextButton(
          key: const ValueKey('leave-save-as'),
          onPressed: () => Navigator.of(context).pop(_Leave.saveAs),
          child: const Text('Save as…'),
        ),
        TextButton(
          key: const ValueKey('leave-discard'),
          onPressed: () => Navigator.of(context).pop(_Leave.discard),
          child: const Text("Don't save"),
        ),
        TextButton(
          key: const ValueKey('leave-cancel'),
          onPressed: () => Navigator.of(context).pop(_Leave.cancel),
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}

class CollabDocApp extends StatefulWidget {
  const CollabDocApp({super.key, required this.app});

  final AppController app;

  @override
  State<CollabDocApp> createState() => _CollabDocAppState();
}

class _CollabDocAppState extends State<CollabDocApp> {
  late final AppLifecycleListener _lifecycle;
  late final Timer _ticker;

  @override
  void initState() {
    super.initState();
    // The store syncs its journal and autosaves when the open document asks.
    _ticker = Timer.periodic(
      const Duration(milliseconds: 500),
      (_) => widget.app.workspace?.tick(),
    );
    // Closing the window writes what is unsaved (the journal already has it).
    _lifecycle = AppLifecycleListener(
      onExitRequested: () async {
        widget.app.closeAll();
        return AppExitResponse.exit;
      },
    );
  }

  @override
  void dispose() {
    _ticker.cancel();
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
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
          listenable: app,
          builder: (context, _) {
            final ws = app.workspace;
            if (ws == null) return StartScreen(app: app);
            return Row(
              children: [
                for (final (i, p) in ws.participants.indexed) ...[
                  if (i > 0)
                    const VerticalDivider(width: 1, color: AppColors.border),
                  Expanded(
                    child: EditorPane(
                      key: ObjectKey(p),
                      app: app,
                      workspace: ws,
                      participant: p,
                      autofocus: i == ws.participants.length - 1,
                    ),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}
