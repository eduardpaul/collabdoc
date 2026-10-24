// The open document and its participants in this process.
//
// Each pane is a participant (own Loro peer, own undo stack). After a local
// edit the pane pushes to the shared hub and every other pane pulls — the
// same shape as the GPUI build's windows and the TS SyncHub. Carets travel
// the same way, as presence beside the document.

import 'package:flutter/foundation.dart';

import 'native.dart';

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
  Participant(this.name, this.color, this.session) {
    session.call({'op': 'setUser', 'name': name, 'color': color});
  }

  final String name;
  final String color;
  final Session session;

  /// Bumped when a collaborator's edit arrived; the pane re-reads its view.
  final ValueNotifier<int> remoteVersion = ValueNotifier(0);

  /// Bumped when someone else's caret moved; the pane re-reads the carets.
  final ValueNotifier<int> presenceVersion = ValueNotifier(0);
}

class Workspace extends ChangeNotifier {
  Workspace.open(String? path) {
    participants.add(
      Participant('You', participantColors[0], Session.open(path)),
    );
  }

  final List<Participant> participants = [];
  bool dirty = false;
  String status = '';

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
    p.session.dispose(); // which also takes its caret away
    _presenceChanged(null);
    notifyListeners();
  }

  /// Sends `from`'s caret to everyone else.
  void publishPresence(Participant from) {
    from.session.call({'op': 'presence'});
    _presenceChanged(from);
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
    if (!dirty) {
      dirty = true;
      notifyListeners();
    }
  }

  void save(Participant who, {String? path}) {
    final reply = who.session.call({'op': 'save', 'path': ?path});
    if (reply['ok'] == true) {
      dirty = false;
      status = 'Saved ${reply['path']}';
    } else {
      status = 'Save failed: ${reply['error']}';
    }
    notifyListeners();
  }

  /// Replaces the document; every pane closes but one, on the new file.
  void open(String path) {
    final Session session;
    try {
      session = Session.open(path);
    } on CoreException catch (e) {
      status = e.message;
      notifyListeners();
      return;
    }
    for (final p in participants) {
      p.session.dispose();
    }
    participants
      ..clear()
      ..add(Participant('You', participantColors[0], session));
    dirty = false;
    status = 'Opened $path';
    notifyListeners();
  }

  @override
  void dispose() {
    for (final p in participants) {
      p.session.dispose();
    }
    super.dispose();
  }
}
