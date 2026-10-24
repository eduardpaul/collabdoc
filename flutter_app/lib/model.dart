// What the Rust core hands the UI: blocks in reading order plus selection.

/// Mark bits, in `collabdoc_core::schema::MARKS` order.
class Marks {
  static const bold = 1 << 0;
  static const italic = 1 << 1;
  static const underline = 1 << 2;
  static const strike = 1 << 3;
  static const code = 1 << 4;
  static const link = 1 << 5;
  static const highlight = 1 << 6;
  static const superscript = 1 << 7;
  static const subscript = 1 << 8;
}

class Span {
  const Span(this.start, this.end, this.marks, this.href);
  final int start;
  final int end;
  final int marks;
  final String href;
}

class BlockView {
  BlockView.fromJson(Map<String, dynamic> j)
    : key = j['key'] as String,
      kind = j['kind'] as String,
      level = j['level'] as int,
      list = j['list'] as String?,
      listDepth = j['listDepth'] as int,
      quoteDepth = j['quoteDepth'] as int,
      checked = j['checked'] as bool,
      editable = j['editable'] as bool,
      text = j['text'] as String,
      spans = [
        for (final s in j['spans'] as List)
          Span(s[0] as int, s[1] as int, s[2] as int, s[3] as String),
      ];

  final String key;

  /// `paragraph`, `heading`, `code` or `atom` (a figure: shown, not text-editable).
  final String kind;
  final int level;

  /// `bullet`, `ordered`, `task` or null.
  final String? list;
  final int listDepth;
  final int quoteDepth;
  final bool checked;
  final bool editable;
  final String text;
  final List<Span> spans;
}

class ViewState {
  /// The next view: the previous one with the blocks Rust says changed
  /// (`changed`), in Rust's order (`order`, sent only when it changed).
  factory ViewState.next(ViewState? previous, Map<String, dynamic> j) {
    final known = <String, BlockView>{...?previous?._byKey};
    for (final b in j['changed'] as List) {
      final view = BlockView.fromJson(b as Map<String, dynamic>);
      known[view.key] = view;
    }
    final order =
        (j['order'] as List?)?.cast<String>() ?? previous?.order ?? const [];
    final byKey = {for (final k in order) k: known[k]!};
    return ViewState._(
      order: order,
      byKey: byKey,
      anchor: j['anchor'] as int,
      head: j['head'] as int,
      marks: j['marks'] as int,
      kind: j['kind'] as String,
      level: j['level'] as int,
      canUndo: j['canUndo'] as bool,
      canRedo: j['canRedo'] as bool,
      title: j['title'] as String,
      persist: j['persist'] == null
          ? null
          : PersistState.fromJson(j['persist'] as Map<String, dynamic>),
    );
  }

  ViewState._({
    required this.order,
    required Map<String, BlockView> byKey,
    required this.anchor,
    required this.head,
    required this.marks,
    required this.kind,
    required this.level,
    required this.canUndo,
    required this.canRedo,
    required this.title,
    required this.persist,
  }) : _byKey = byKey,
       blocks = [for (final k in order) byKey[k]!] {
    var at = 0;
    for (final b in blocks) {
      starts.add(at);
      at += b.text.length + 1;
    }
  }

  final List<String> order;
  final Map<String, BlockView> _byKey;
  final List<BlockView> blocks;
  final List<int> starts = [];
  final int anchor;
  final int head;
  final int marks;
  final String kind;
  final int level;
  final bool canUndo;
  final bool canRedo;
  final String title;

  /// Where the document is kept and whether it is saved; null in tests
  /// without a store.
  final PersistState? persist;

  int get length => starts.last + blocks.last.text.length;
  int get selectionStart => anchor < head ? anchor : head;
  int get selectionEnd => anchor < head ? head : anchor;

  /// Index of the block holding global offset `offset`.
  int blockAt(int offset) {
    var lo = 0;
    var hi = starts.length - 1;
    while (lo < hi) {
      final mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }
}

/// Another participant's selection, in this pane's offsets.
class RemoteCaret {
  RemoteCaret.fromJson(Map<String, dynamic> j)
    : peer = j['peer'] as String,
      name = j['name'] as String? ?? 'Someone',
      color = parseHexColor(j['color'] as String?),
      anchor = j['anchor'] as int,
      head = j['head'] as int,
      moved = j['moved'] as String? ?? '';

  final String peer;
  final String name;
  final int color;
  final int anchor;
  final int head;

  /// Changes only when the participant moves their caret.
  final String moved;

  int get start => anchor < head ? anchor : head;
  int get end => anchor < head ? head : anchor;
}

/// `#rrggbb` as an opaque ARGB value; grey when missing or malformed.
int parseHexColor(String? hex) {
  final digits = hex?.replaceFirst('#', '');
  final rgb = digits != null && digits.length == 6
      ? int.tryParse(digits, radix: 16)
      : null;
  return 0xFF000000 | (rgb ?? 0x8B8B93);
}

/// Where a document is kept and whether everything is written.
class PersistState {
  PersistState.fromJson(Map<String, dynamic> j)
    : docId = j['docId'] as String,
      title = j['title'] as String,
      path = j['path'] as String?,
      isDraft = j['isDraft'] as bool,
      dirty = j['dirty'] as bool;

  final String docId;
  final String title;

  /// Null for a draft (never saved anywhere).
  final String? path;
  final bool isDraft;
  final bool dirty;

  @override
  bool operator ==(Object other) =>
      other is PersistState &&
      other.docId == docId &&
      other.title == title &&
      other.path == path &&
      other.isDraft == isDraft &&
      other.dirty == dirty;

  @override
  int get hashCode => Object.hash(docId, title, path, isDraft, dirty);
}

/// A document in the recents.
class RecentEntry {
  RecentEntry.fromJson(Map<String, dynamic> j)
    : docId = j['docId'] as String,
      title = j['title'] as String,
      path = j['path'] as String?,
      updatedAt = DateTime.tryParse(j['updatedAt'] as String? ?? ''),
      preview = j['preview'] as String? ?? '',
      missing = j['missing'] as bool? ?? false;

  final String docId;
  final String title;

  /// Null for a draft.
  final String? path;
  final DateTime? updatedAt;
  final String preview;

  /// The file was moved or deleted.
  final bool missing;
}

/// A draft a crash left behind.
class RecoveryOffer {
  RecoveryOffer.fromJson(Map<String, dynamic> j)
    : docId = j['docId'] as String,
      title = j['title'] as String,
      updatedAt = DateTime.tryParse(j['updatedAt'] as String? ?? ''),
      preview = j['preview'] as String? ?? '';

  final String docId;
  final String title;
  final DateTime? updatedAt;
  final String preview;
}

class Listing {
  Listing.fromJson(Map<String, dynamic> j)
    : recents = [
        for (final r in j['recents'] as List)
          RecentEntry.fromJson(r as Map<String, dynamic>),
      ],
      recoveries = [
        for (final r in j['recoveries'] as List)
          RecoveryOffer.fromJson(r as Map<String, dynamic>),
      ];

  const Listing.empty() : recents = const [], recoveries = const [];

  final List<RecentEntry> recents;
  final List<RecoveryOffer> recoveries;
}
