// The History tab (spec 05), as HistoryPanel.tsx: one entry per commit,
// newest first, filtered by author or text; the selected entry's word-level
// diff with "View this version" and "Restore"; checkpoints pinned on top
// and "Mark checkpoint". History comes from the core's incremental index and
// is read again 400 ms after edits settle (HISTORY_SETTLE_MS).

import 'dart:async';

import 'package:flutter/material.dart';

import 'model.dart';
import 'theme.dart';
import 'workspace.dart';

const _settleMs = 400;

class HistoryPanel extends StatefulWidget {
  const HistoryPanel({super.key, required this.workspace});

  final Workspace workspace;

  @override
  State<HistoryPanel> createState() => HistoryPanelState();
}

class HistoryPanelState extends State<HistoryPanel> {
  List<HistoryEntry> entries = const [];
  List<Checkpoint> checkpoints = const [];
  String _you = '';
  String? _author; // null: all
  String _query = '';
  String? _selected;
  List<DiffHunk> _hunks = const [];
  Timer? _settle;
  final _checkpointName = TextEditingController();

  Participant get _participant =>
      widget.workspace.historyFor ?? widget.workspace.participants.first;

  @override
  void initState() {
    super.initState();
    _read();
    widget.workspace.historyVersion.addListener(_changed);
  }

  @override
  void dispose() {
    widget.workspace.historyVersion.removeListener(_changed);
    _settle?.cancel();
    _checkpointName.dispose();
    super.dispose();
  }

  void _changed() {
    _settle?.cancel();
    _settle = Timer(const Duration(milliseconds: _settleMs), () {
      if (mounted) setState(_read);
    });
  }

  void _read() {
    final reply = _participant.session.call({'op': 'history'});
    if (reply['ok'] != true) return;
    entries = [
      for (final e in reply['entries'] as List)
        HistoryEntry.fromJson(e as Map<String, dynamic>),
    ];
    checkpoints = [
      for (final c in reply['checkpoints'] as List)
        Checkpoint.fromJson(c as Map<String, dynamic>),
    ];
    _you = reply['actorId'] as String? ?? '';
    final selected = _selected;
    if (selected != null) _diff(selected);
  }

  void _diff(String id) {
    final reply = _participant.session.call({'op': 'historyDiff', 'id': id});
    _hunks = reply['ok'] == true
        ? [
            for (final h in reply['hunks'] as List)
              DiffHunk.fromJson(h as Map<String, dynamic>),
          ]
        : const [];
  }

  void _select(String id) => setState(() {
    _selected = _selected == id ? null : id;
    if (_selected != null) _diff(id);
  });

  String _name(HistoryAuthor a) => a.actorId == _you ? 'You' : a.name;

  @override
  Widget build(BuildContext context) {
    // Authors in order: You first, then by name; counts per author.
    final counts = <String, int>{};
    final authors = <String, HistoryAuthor>{};
    for (final e in entries) {
      counts[e.author.actorId] = (counts[e.author.actorId] ?? 0) + 1;
      authors.putIfAbsent(e.author.actorId, () => e.author);
    }
    final order = authors.values.toList()
      ..sort((a, b) {
        if (a.actorId == _you) return -1;
        if (b.actorId == _you) return 1;
        return a.name.compareTo(b.name);
      });
    final q = _query.trim().toLowerCase();
    final visible = [
      for (final e in entries.reversed)
        if ((_author == null || e.author.actorId == _author) &&
            (q.isEmpty ||
                e.summary.toLowerCase().contains(q) ||
                e.message.toLowerCase().contains(q) ||
                e.author.name.toLowerCase().contains(q)))
          e,
    ];
    final selected = entries.where((e) => e.id == _selected).firstOrNull;
    final sum = counts.values.fold(0, (a, b) => a + b);
    return Container(
      color: AppColors.panel,
      child: DefaultTextStyle(
        style: const TextStyle(
          fontFamily: uiFont,
          fontSize: 13,
          color: AppColors.text,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 6, 4),
              child: Row(
                children: [
                  const Text(
                    'History',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
                  ),
                  const Spacer(),
                  IconButton(
                    key: const ValueKey('history-close'),
                    tooltip: 'Close',
                    iconSize: 16,
                    color: AppColors.muted,
                    onPressed: () =>
                        widget.workspace.toggleHistory(_participant),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Text(
                'One entry per commit. Filter by author; $sum across filters'
                '${sum == entries.length ? ' matches the total.' : '.'}',
                style: const TextStyle(color: AppColors.muted, fontSize: 12),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 4),
              child: Wrap(
                spacing: 4,
                runSpacing: 4,
                children: [
                  _chip(
                    'All ${entries.length}',
                    _author == null,
                    null,
                    () => setState(() => _author = null),
                    'history-all',
                  ),
                  for (final a in order)
                    _chip(
                      '${_name(a)} ${counts[a.actorId] ?? 0}',
                      _author == a.actorId,
                      Color(parseHexColor(a.color)),
                      () => setState(() => _author = a.actorId),
                      'history-author-${a.actorId}',
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 6),
              child: _field(
                'history-search',
                'Search summaries',
                onChanged: (v) => setState(() => _query = v),
              ),
            ),
            for (final cp in checkpoints)
              _row(
                key: 'checkpoint-${cp.id}',
                color: AppColors.accent,
                pin: true,
                title: cp.name,
                time: cp.at,
                selected: false,
                onTap: () => widget.workspace.viewVersion(
                  _participant,
                  cp.frontiers,
                  'Checkpoint “${cp.name}”',
                ),
              ),
            Expanded(
              child: visible.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.all(14),
                      child: Text(
                        'No commits match.',
                        style: TextStyle(color: AppColors.muted),
                      ),
                    )
                  : ListView.builder(
                      key: const ValueKey('history-list'),
                      itemCount: visible.length,
                      itemBuilder: (context, i) {
                        final e = visible[i];
                        return _row(
                          key: 'history-${e.id}',
                          color: Color(parseHexColor(e.author.color)),
                          title: _name(e.author),
                          time: e.timestamp,
                          summary: e.summary,
                          message: e.message,
                          selected: e.id == _selected,
                          onTap: () => _select(e.id),
                        );
                      },
                    ),
            ),
            if (selected != null) _detail(selected),
            _checkpointForm(),
          ],
        ),
      ),
    );
  }

  Widget _detail(HistoryEntry e) => Container(
    constraints: const BoxConstraints(maxHeight: 320),
    decoration: const BoxDecoration(
      border: Border(top: BorderSide(color: AppColors.border)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(child: DiffBoard(hunks: _hunks)),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 6, 14, 8),
          child: Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              _button(
                'View this version',
                () => widget.workspace.viewVersion(
                  _participant,
                  e.frontiers,
                  '${historyTime(e.timestamp)} by ${_name(e.author)}',
                ),
                'history-view',
              ),
              _button(
                'Restore',
                () => widget.workspace.restore(_participant, e.frontiers),
                'history-restore',
                primary: true,
              ),
            ],
          ),
        ),
      ],
    ),
  );

  Widget _checkpointForm() => Container(
    padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
    decoration: const BoxDecoration(
      border: Border(top: BorderSide(color: AppColors.border)),
    ),
    child: Row(
      children: [
        Expanded(
          child: _field(
            'checkpoint-name',
            'Checkpoint name',
            controller: _checkpointName,
            onSubmitted: (_) => _mark(),
          ),
        ),
        const SizedBox(width: 8),
        _button('Mark checkpoint', _mark, 'checkpoint-mark'),
      ],
    ),
  );

  void _mark() {
    widget.workspace.addCheckpoint(_participant, _checkpointName.text);
    _checkpointName.clear();
    setState(_read);
  }

  Widget _field(
    String key,
    String hint, {
    TextEditingController? controller,
    ValueChanged<String>? onChanged,
    ValueChanged<String>? onSubmitted,
  }) => TextField(
    key: ValueKey(key),
    controller: controller,
    onChanged: onChanged,
    onSubmitted: onSubmitted,
    style: const TextStyle(fontFamily: uiFont, fontSize: 13),
    decoration: InputDecoration(
      isDense: true,
      hintText: hint,
      hintStyle: const TextStyle(color: AppColors.muted),
      contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      border: const OutlineInputBorder(),
    ),
  );

  Widget _chip(
    String label,
    bool on,
    Color? dot,
    VoidCallback onTap,
    String key,
  ) => GestureDetector(
    key: ValueKey(key),
    onTap: onTap,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: on ? AppColors.buttonActive : AppColors.bg,
        border: Border.all(color: on ? AppColors.accent : AppColors.border),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot != null) ...[
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
            ),
            const SizedBox(width: 5),
          ],
          Text(label, style: const TextStyle(fontSize: 12)),
        ],
      ),
    ),
  );

  Widget _row({
    required String key,
    required Color color,
    required String title,
    required DateTime time,
    required bool selected,
    required VoidCallback onTap,
    String summary = '',
    String message = '',
    bool pin = false,
  }) => GestureDetector(
    key: ValueKey(key),
    onTap: onTap,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
      color: selected ? AppColors.buttonActive : null,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 4, right: 8),
            child: Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: color,
                shape: pin ? BoxShape.rectangle : BoxShape.circle,
              ),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: title,
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      TextSpan(
                        text: '  ${historyTime(time)}',
                        style: const TextStyle(
                          color: AppColors.muted,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                if (summary.isNotEmpty)
                  Text(summary, maxLines: 2, overflow: TextOverflow.ellipsis),
                if (message.isNotEmpty)
                  Text(
                    message,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 12,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

Widget _button(
  String label,
  VoidCallback onTap,
  String key, {
  bool primary = false,
}) => MouseRegion(
  cursor: SystemMouseCursors.click,
  child: GestureDetector(
    key: ValueKey(key),
    onTap: onTap,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: primary ? AppColors.accent : AppColors.buttonHover,
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: uiFont,
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: primary ? AppColors.bg : AppColors.text,
        ),
      ),
    ),
  ),
);

/// A commit's diff: each touched block with its words kept, removed (struck,
/// red) or added (green), and unchanged blocks around them for context.
class DiffBoard extends StatelessWidget {
  const DiffBoard({super.key, required this.hunks});

  final List<DiffHunk> hunks;

  static const _add = Color(0xFF7EE787);
  static const _addBg = Color(0x2A2EA043);
  static const _remove = Color(0xFFFF7B72);
  static const _removeBg = Color(0x2AF85149);

  @override
  Widget build(BuildContext context) {
    if (hunks.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(14),
        child: Text(
          'Nothing visible changed.',
          style: TextStyle(color: AppColors.muted),
        ),
      );
    }
    return ListView(
      key: const ValueKey('diff-board'),
      shrinkWrap: true,
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
      children: [
        for (final h in hunks)
          Container(
            margin: const EdgeInsets.only(bottom: 6),
            padding: const EdgeInsets.fromLTRB(8, 4, 8, 4),
            decoration: BoxDecoration(
              border: Border(
                left: BorderSide(
                  width: 3,
                  color: switch (h.kind) {
                    'add' => _add,
                    'remove' => _remove,
                    'change' => AppColors.accent,
                    _ => AppColors.border,
                  },
                ),
              ),
            ),
            child: Text.rich(
              TextSpan(
                children: [
                  for (final p in h.parts)
                    TextSpan(
                      text: p.text,
                      style: switch (p.kind) {
                        'add' => const TextStyle(
                          color: _add,
                          backgroundColor: _addBg,
                        ),
                        'remove' => const TextStyle(
                          color: _remove,
                          backgroundColor: _removeBg,
                          decoration: TextDecoration.lineThrough,
                        ),
                        _ => TextStyle(
                          color: h.kind == 'same'
                              ? AppColors.muted
                              : AppColors.text,
                        ),
                      },
                    ),
                ],
              ),
              key: ValueKey('hunk-${h.kind}'),
              maxLines: 8,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13),
            ),
          ),
      ],
    );
  }
}
