// The start screen, as in the TS app: New and Open, drafts a crash left
// behind (Recover / Discard), and the recents. A moved or deleted file says
// so and offers Locate… and Remove instead of opening an empty document.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app.dart';
import 'model.dart';
import 'theme.dart';

class StartScreen extends StatelessWidget {
  const StartScreen({super.key, required this.app});

  final AppController app;

  @override
  Widget build(BuildContext context) {
    final listing = app.listing;
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyN, control: true):
            app.newDocument,
        const SingleActivator(LogicalKeyboardKey.keyO, control: true): () =>
            app.openFile(context),
      },
      child: Focus(
        autofocus: true,
        child: DefaultTextStyle(
          style: const TextStyle(
            fontFamily: uiFont,
            fontSize: 14,
            color: AppColors.text,
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'CollabDoc',
                      style: TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'Every keystroke stays on this machine, saved as you type.',
                      style: TextStyle(color: AppColors.muted),
                    ),
                    const SizedBox(height: 24),
                    Row(
                      children: [
                        _Button(
                          'New document',
                          key: const ValueKey('start-new'),
                          shortcut: 'Ctrl+N',
                          primary: true,
                          onTap: app.newDocument,
                        ),
                        const SizedBox(width: 12),
                        _Button(
                          'Open…',
                          key: const ValueKey('start-open'),
                          shortcut: 'Ctrl+O',
                          onTap: () => app.openFile(context),
                        ),
                      ],
                    ),
                    if (app.notice.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      Text(
                        app.notice,
                        key: const ValueKey('start-notice'),
                        style: const TextStyle(color: AppColors.accent),
                      ),
                    ],
                    if (listing.recoveries.isNotEmpty) ...[
                      const SizedBox(height: 32),
                      const _Heading('Recover'),
                      for (final offer in listing.recoveries)
                        _Row(
                          key: ValueKey('recover-${offer.docId}'),
                          title: 'Recover “${offer.title}”',
                          detail: [
                            'Unsaved when CollabDoc closed',
                            if (offer.updatedAt != null) ago(offer.updatedAt!),
                          ].join(' · '),
                          preview: offer.preview,
                          onTap: () => app.recover(offer.docId),
                          actions: [
                            _Button(
                              'Recover',
                              onTap: () => app.recover(offer.docId),
                            ),
                            _Button(
                              'Discard',
                              onTap: () => app.discardRecovery(offer.docId),
                            ),
                          ],
                        ),
                    ],
                    const SizedBox(height: 32),
                    const _Heading('Recent'),
                    if (listing.recents.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 12),
                        child: Text(
                          'No documents yet. Create one or open a file from disk.',
                          style: TextStyle(color: AppColors.muted),
                        ),
                      ),
                    for (final entry in listing.recents)
                      _recent(context, entry),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _recent(BuildContext context, RecentEntry entry) {
    final where = entry.path ?? 'Draft';
    final when = entry.updatedAt == null ? null : ago(entry.updatedAt!);
    if (entry.missing) {
      return _Row(
        key: ValueKey('recent-${entry.docId}'),
        title: entry.title,
        detail: 'Moved or deleted · $where',
        muted: true,
        actions: [
          _Button(
            'Locate…',
            onTap: () async {
              final path = await app.pickOpenPath();
              if (path != null) app.locate(entry, path);
            },
          ),
          _Button('Remove', onTap: () => app.removeRecent(entry.docId)),
        ],
      );
    }
    return _Row(
      key: ValueKey('recent-${entry.docId}'),
      title: entry.title,
      detail: [where, ?when].join(' · '),
      preview: entry.preview,
      onTap: () => app.openRecent(entry),
    );
  }
}

/// "just now", "5 min ago", "3 h ago", "2 days ago", else the date.
String ago(DateTime at, {DateTime? now}) {
  final d = (now ?? DateTime.now()).difference(at);
  if (d.inMinutes < 1) return 'just now';
  if (d.inHours < 1) return '${d.inMinutes} min ago';
  if (d.inDays < 1) return '${d.inHours} h ago';
  if (d.inDays < 7) return d.inDays == 1 ? 'yesterday' : '${d.inDays} days ago';
  final local = at.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)}';
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 11,
        letterSpacing: 1.2,
        color: AppColors.muted,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

class _Row extends StatelessWidget {
  const _Row({
    super.key,
    required this.title,
    required this.detail,
    this.preview = '',
    this.onTap,
    this.actions = const [],
    this.muted = false,
  });

  final String title;
  final String detail;
  final String preview;
  final VoidCallback? onTap;
  final List<Widget> actions;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: onTap == null
          ? SystemMouseCursors.basic
          : SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppColors.panel,
            border: Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: muted ? AppColors.muted : AppColors.text,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      detail,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.muted,
                      ),
                    ),
                    if (preview.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13,
                          color: AppColors.muted,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              for (final a in actions) ...[const SizedBox(width: 8), a],
            ],
          ),
        ),
      ),
    );
  }
}

class _Button extends StatelessWidget {
  const _Button(
    this.label, {
    super.key,
    required this.onTap,
    this.shortcut,
    this.primary = false,
  });

  final String label;
  final VoidCallback onTap;
  final String? shortcut;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          decoration: BoxDecoration(
            color: primary ? AppColors.accent : AppColors.buttonHover,
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  color: primary ? AppColors.bg : AppColors.text,
                ),
              ),
              if (shortcut != null) ...[
                const SizedBox(width: 8),
                Text(
                  shortcut!,
                  style: TextStyle(
                    fontSize: 11,
                    color: primary
                        ? AppColors.bg.withAlpha(0xAA)
                        : AppColors.muted,
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
