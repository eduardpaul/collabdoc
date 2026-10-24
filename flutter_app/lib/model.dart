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
  ViewState.fromJson(Map<String, dynamic> j)
    : blocks = [
        for (final b in j['blocks'] as List)
          BlockView.fromJson(b as Map<String, dynamic>),
      ],
      anchor = j['anchor'] as int,
      head = j['head'] as int,
      marks = j['marks'] as int,
      kind = j['kind'] as String,
      level = j['level'] as int,
      canUndo = j['canUndo'] as bool,
      canRedo = j['canRedo'] as bool,
      title = j['title'] as String,
      path = j['path'] as String? {
    var at = 0;
    for (final b in blocks) {
      starts.add(at);
      at += b.text.length + 1;
    }
  }

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
  final String? path;

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
