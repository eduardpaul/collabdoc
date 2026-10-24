// The open document and its participants in this process.
//
// Each pane is a participant (own Loro peer, own undo stack). After a local
// edit the pane pushes to the shared hub and every other pane pulls — the
// same shape as the GPUI build's windows and the TS SyncHub.

import 'package:flutter/foundation.dart';

import 'native.dart';

class Participant {
  Participant(this.name, this.session);

  final String name;
  final Session session;

  /// Bumped when a collaborator's edit arrived; the pane re-reads its view.
  final ValueNotifier<int> remoteVersion = ValueNotifier(0);
}

class Workspace extends ChangeNotifier {
  Workspace.open(String? path) {
    participants.add(Participant('You', Session.open(path)));
  }

  final List<Participant> participants = [];
  bool dirty = false;
  String status = '';

  /// A new participant on the same document.
  void addPeer() {
    final session = participants.first.session.fork();
    participants.add(Participant('Peer ${participants.length + 1}', session));
    notifyListeners();
  }

  void removePeer(Participant p) {
    if (participants.length == 1) return;
    participants.remove(p);
    p.session.dispose();
    notifyListeners();
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
      ..add(Participant('You', session));
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
