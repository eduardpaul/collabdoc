// The open document and its participants in this process.
//
// Each pane is a participant (own Loro peer, own undo stack). After a local
// edit the pane pushes to the shared hub and every other pane pulls — the
// same shape as the GPUI build's windows and the TS SyncHub. Carets travel
// the same way, as presence beside the document.
//
// The hub's document is kept on disk by the core's store: every edit goes to
// its journal at once, and [Workspace.tick], every half second (the app
// widget's timer), lets it autosave: 2 s after the last edit, at most 30 s
// after the first unsaved one.

import 'dart:io';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'native.dart';
import 'settings.dart';

/// Caret colors, one per participant in join order.
const participantColors = [
  '#3b82f6',
  '#e5484d',
  '#30a46c',
  '#f5a524',
  '#8e4ec6',
  '#12a594',
];

class Participant {
  Participant(this.name, this.color, this.session, {this.handle}) {
    _tell();
  }

  String name;
  String color;

  /// The `@handle` they prefer (the profile's, for the user).
  String? handle;
  final Session session;

  void _tell() => session.call({
    'op': 'setUser',
    'name': name,
    'color': color,
    'handle': ?handle,
  });

  /// Takes a new name, color and handle (the profile was edited).
  void rename(String name, String color, String handle) {
    this.name = name;
    this.color = color;
    this.handle = handle;
    _tell();
  }

  /// Bumped when a collaborator's edit arrived; the pane re-reads its view.
  final ValueNotifier<int> remoteVersion = ValueNotifier(0);

  /// Bumped when someone else's caret moved; the pane re-reads the carets.
  final ValueNotifier<int> presenceVersion = ValueNotifier(0);
}

/// A past version a pane shows instead of the live document (read-only).
class VersionView {
  VersionView(this.participant, this.frontiers, this.label);

  /// A participant on a read-only session of that version.
  final Participant participant;
  final List frontiers;

  /// "Oct 25, 14:02 by Ana", "Checkpoint Draft 1".
  final String label;
}

/// What Ctrl+S did.
enum SaveResult { saved, needsSaveAs, failed }

class Workspace extends ChangeNotifier {
  Workspace._(Session session, {Settings? settings})
    : settings = settings ?? Settings.forUser() {
    // The user, as their profile says (the core writes as its id).
    final me = CoreStore.profile();
    participants.add(
      Participant(me.name, me.color, session, handle: me.handle),
    );
    final info = session.call({'op': 'openInfo'});
    if (info['recoveredEdits'] == true) {
      status = 'Recovered edits made after the last save';
    } else if ((info['warnings'] as List? ?? const []).isNotEmpty) {
      status = 'Some images in this file are damaged';
    }
    _readPersist(session.call({'op': 'tick'}));
  }

  /// A new, untitled document (a draft until saved somewhere).
  factory Workspace.create({Settings? settings}) =>
      Workspace._(Session.openWith({'new': true}), settings: settings);

  /// A `.collabdoc`, or a Markdown file to import; a path that does not
  /// exist yet is a new document saved there.
  factory Workspace.openPath(String path, {Settings? settings}) =>
      Workspace._(Session.openWith({'path': path}), settings: settings);

  /// A draft from the recents, or one a crash left behind.
  factory Workspace.recover(String docId, {Settings? settings}) =>
      Workspace._(Session.openWith({'draft': docId}), settings: settings);

  final Settings settings;
  final List<Participant> participants = [];
  String status = '';

  /// One line for the status bar (a refused image…).
  void setStatus(String text) {
    status = text;
    notifyListeners();
  }

  PersistState? persist;
  bool _closed = false;

  /// The History tab, and the participant it restores and marks
  /// checkpoints as.
  bool historyOpen = false;
  Participant? historyFor;

  /// Bumped after every edit that reached the hub: history and the
  /// attribution gutter read again (debounced where they listen).
  final ValueNotifier<int> historyVersion = ValueNotifier(0);

  /// The gutter showing each block's last author (AC-05.9).
  bool attribution = false;

  /// Per pane, the version it shows instead of the live document.
  final Map<Participant, VersionView> viewing = {};

  /// The People tab ("In this session", AC-07.4), and whose view it shows.
  bool peopleOpen = false;
  Participant? peopleFor;

  void togglePeople(Participant from) {
    peopleOpen = !peopleOpen || !identical(peopleFor, from);
    peopleFor = from;
    notifyListeners();
  }

  /// The user's profile was edited: their pane speaks as the new one.
  void applyProfile(Profile profile) {
    participants.first.rename(profile.name, profile.color, profile.handle);
    publishPresence(participants.first);
    notifyListeners();
  }

  void toggleHistory(Participant from) {
    historyOpen = !historyOpen || !identical(historyFor, from);
    historyFor = from;
    notifyListeners();
  }

  void toggleAttribution() {
    attribution = !attribution;
    notifyListeners();
  }

  /// View this version: `p`'s pane shows the document at `frontiers`,
  /// read-only, until [closeVersion]. The live editor keeps its caret.
  void viewVersion(Participant p, List frontiers, String label) {
    try {
      final session = p.session.openVersion(frontiers);
      viewing.remove(p)?.participant.session.dispose();
      viewing[p] = VersionView(
        Participant('Version', p.color, session),
        frontiers,
        label,
      );
    } on CoreException catch (e) {
      status = e.message;
    }
    notifyListeners();
  }

  void closeVersion(Participant p) {
    viewing.remove(p)?.participant.session.dispose();
    notifyListeners();
  }

  /// Restores `frontiers` as one new commit by `p`, undoable with Ctrl+Z.
  void restore(Participant p, List frontiers) {
    final changed = p.session.edit({'op': 'restore', 'frontiers': frontiers});
    status = changed ? 'Restored that version' : 'Already reads like that';
    if (changed) {
      broadcast(p);
      p.remoteVersion.value++;
    }
    notifyListeners();
  }

  /// Names the current version.
  void addCheckpoint(Participant p, String name) {
    p.session.call({'op': 'addCheckpoint', 'name': name});
    broadcast(p);
    notifyListeners();
  }

  bool get dirty => persist?.dirty ?? false;
  bool get isDraft => persist?.isDraft ?? true;
  Session get _main => participants.first.session;

  /// Lets the store sync its journal and autosave when due.
  void tick() {
    if (_closed) return;
    _readPersist(_main.call({'op': 'tick'}));
  }

  void _readPersist(Map<String, dynamic> reply) {
    final json = reply['persist'];
    final next = json == null
        ? null
        : PersistState.fromJson(json as Map<String, dynamic>);
    if (next != persist) {
      persist = next;
      notifyListeners();
    }
  }

  /// Whether leaving this document should ask first: a draft with content
  /// ("Don't save" deletes it). Saved files never ask; they are autosaved.
  bool get leavingAsks =>
      isDraft && _main.call({'op': 'hasContent'})['hasContent'] == true;

  /// Ctrl+S: writes now, or the caller asks where ([suggestedPath]).
  SaveResult save() {
    final reply = _main.call({'op': 'save'});
    if (reply['needsSaveAs'] == true) return SaveResult.needsSaveAs;
    if (reply['ok'] != true) {
      status = 'Save failed: ${reply['error']}';
      notifyListeners();
      return SaveResult.failed;
    }
    status = 'Saved ${reply['path']}';
    tick();
    notifyListeners();
    return SaveResult.saved;
  }

  String get suggestedPath =>
      _main.call({'op': 'suggestedPath'})['path'] as String;

  /// Save As: the document lives at `path` from now on.
  bool saveAs(String path) {
    final reply = _main.call({'op': 'saveAs', 'path': path});
    status = reply['ok'] == true
        ? 'Saved ${reply['path']}'
        : 'Save failed: ${reply['error']}';
    // The title may have changed: every pane re-reads.
    for (final p in participants.skip(1)) {
      if (p.session.call({'op': 'pull'})['changed'] == true) {
        p.remoteVersion.value++;
      }
    }
    participants.first.remoteVersion.value++;
    tick();
    notifyListeners();
    return reply['ok'] == true;
  }

  bool exportMarkdown(String path) {
    final reply = _main.call({'op': 'exportMarkdown', 'path': path});
    status = reply['ok'] == true
        ? 'Exported ${reply['path']}'
        : 'Export failed: ${reply['error']}';
    notifyListeners();
    return reply['ok'] == true;
  }

  /// Leaves the document: unsaved edits are written (or, with `discard`,
  /// the draft is deleted), and every pane closes.
  void close({bool discard = false}) {
    if (_closed) return;
    _closed = true;
    for (final v in viewing.values) {
      v.participant.session.dispose();
    }
    viewing.clear();
    _main.call({'op': 'close', 'discard': discard});
    for (final p in participants) {
      p.session.dispose();
    }
    participants.clear();
  }

  /// A new participant on the same document.
  void addPeer() {
    final session = participants.first.session.fork();
    final n = participants.length;
    participants.add(
      Participant(
        'Peer ${n + 1}',
        participantColors[n % participantColors.length],
        session,
      ),
    );
    notifyListeners();
  }

  void removePeer(Participant p) {
    if (participants.length == 1) return;
    participants.remove(p);
    viewing.remove(p)?.participant.session.dispose();
    if (identical(historyFor, p)) historyFor = participants.first;
    if (identical(peopleFor, p)) peopleFor = participants.first;
    p.session.dispose(); // which also takes its caret away
    _presenceChanged(null);
    notifyListeners();
  }

  /// Chooses the renderer for the next start.
  void setRenderer(Renderer renderer) {
    try {
      settings.renderer = renderer;
      status = renderer == settings.activeRenderer || renderer == Renderer.auto
          ? 'Renderer: ${renderer.label}'
          : 'Renderer: ${renderer.label} from the next start';
    } on FileSystemException catch (e) {
      status = 'Could not save settings: ${e.message}';
    }
    notifyListeners();
  }

  /// Sends `from`'s caret to everyone else; returns how long to wait
  /// before sending again.
  int publishPresence(Participant from) {
    final gap = from.session.publishPresence();
    _presenceChanged(from);
    return gap;
  }

  void _presenceChanged(Participant? from) {
    for (final p in participants) {
      if (!identical(p, from)) p.presenceVersion.value++;
    }
  }

  /// Sends `from`'s edits to the hub and every other participant.
  void broadcast(Participant from) {
    from.session.call({'op': 'push'});
    for (final p in participants) {
      if (identical(p, from)) continue;
      final reply = p.session.call({'op': 'pull'});
      if (reply['changed'] == true) p.remoteVersion.value++;
    }
    historyVersion.value++;
    tick();
  }

  @override
  void dispose() {
    close();
    super.dispose();
  }
}
