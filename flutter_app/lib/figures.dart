// Figures in the document: images from the document's own bytes, Mermaid
// diagrams drawn by the Rust core (mermaid-rs-renderer → resvg → PNG, on a
// background isolate), infographics as a placeholder, rules as a line.
// Caption, source, width and align are edited from the bar a selected
// figure shows, as the Tiptap app's figure menu does.

import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'model.dart';
import 'native.dart';
import 'theme.dart';

/// A figure's bitmap and its pixels per logical pixel.
typedef Drawn = ({Uint8List bytes, double scale});

/// Drawn figures by what they show, shared by every pane: a diagram drawn
/// once at a scale is not drawn again while it stays in the cache, and an
/// image's bytes are copied out of the core once.
class FigureImages {
  static const _capacity = 48;
  static final _cache = <String, Future<Drawn>>{};

  static Future<Drawn> _get(String key, Future<Drawn> Function() make) {
    final hit = _cache.remove(key);
    final future = hit ?? make();
    _cache[key] = future;
    while (_cache.length > _capacity) {
      _cache.remove(_cache.keys.first);
    }
    // A failure is not kept: the next try draws again.
    future.then<void>(
      (_) {},
      onError: (Object _) {
        if (identical(_cache[key], future)) _cache.remove(key);
      },
    );
    return future;
  }

  /// Mermaid `source` as a PNG at `scale` device pixels per unit.
  static Future<Drawn> mermaid(String source, double scale) => _get(
    'mermaid:$scale:$source',
    () async => (
      bytes: await Isolate.run(() => renderMermaid(source, scale)),
      scale: scale,
    ),
  );

  /// Image `hash` of the session's document: as stored, or (an SVG) drawn
  /// to a PNG at `scale`. Images are named by content, so any document's
  /// copy will do.
  static Future<Drawn> asset(Session session, String hash, double scale) =>
      _get('asset:$scale:$hash', () async {
        final bytes = session.asset(hash);
        if (bytes == null) throw CoreException('This image is missing.');
        if (!isSvg(bytes)) return (bytes: bytes, scale: 1.0);
        return (
          bytes: await Isolate.run(() => renderSvg(bytes, scale)),
          scale: scale,
        );
      });

  static bool isSvg(Uint8List bytes) {
    final head = String.fromCharCodes(bytes.take(256)).trimLeft().toLowerCase();
    return head.startsWith('<svg') ||
        (head.startsWith('<?xml') && head.contains('<svg'));
  }

  @visibleForTesting
  static void clear() => _cache.clear();
}

/// The hash an image `src` names (`asset:<hash>`).
String? assetHash(String src) =>
    src.startsWith('asset:') ? src.substring('asset:'.length) : null;

/// What the figure bar asks the editor to do.
class FigureActions {
  const FigureActions({
    required this.caption,
    required this.source,
    required this.width,
    required this.align,
  });

  final VoidCallback caption;
  final VoidCallback source;
  final void Function(int? percent) width;
  final void Function(String align) align;
}

/// One figure block, `width` logical pixels wide at most.
class FigureView extends StatelessWidget {
  const FigureView({
    super.key,
    required this.block,
    required this.session,
    required this.width,
    required this.selected,
    required this.actions,
  });

  final BlockView block;
  final Session session;
  final double width;
  final bool selected;
  final FigureActions actions;

  @override
  Widget build(BuildContext context) {
    if (block.nodeName == 'horizontalRule') {
      return SizedBox(
        width: width,
        height: 25,
        child: Center(
          child: Container(
            height: selected ? 2 : 1,
            color: selected ? AppColors.accent : AppColors.border,
          ),
        ),
      );
    }
    final dpr = MediaQuery.maybeDevicePixelRatioOf(context) ?? 1.0;
    final percent = (block.attrs['width'] as num?)?.toInt();
    final inner = percent == null ? width : width * percent / 100;
    final align = switch (block.attr('align')) {
      'left' => Alignment.centerLeft,
      'right' => Alignment.centerRight,
      _ => Alignment.center,
    };
    final body = switch (block.nodeName) {
      'imageFigure' => _image(dpr, inner, sized: percent != null),
      'mermaidFigure' => _diagram(dpr, inner),
      _ => _infographic(inner),
    };
    return SizedBox(
      width: width,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (selected) _bar(percent),
            Align(
              alignment: align,
              child: Container(
                key: ValueKey('figure-${block.key}'),
                width: block.nodeName == 'imageFigure' ? null : inner,
                constraints: BoxConstraints(maxWidth: inner),
                decoration: BoxDecoration(
                  border: Border.all(
                    color: selected ? AppColors.accent : Colors.transparent,
                    width: 2,
                  ),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: body,
              ),
            ),
            if (block.caption.isNotEmpty)
              Align(
                alignment: align,
                child: SizedBox(
                  width: inner,
                  child: Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      block.caption,
                      key: ValueKey('caption-${block.key}'),
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontFamily: uiFont,
                        fontSize: 13,
                        fontStyle: FontStyle.italic,
                        color: AppColors.muted,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _image(double dpr, double inner, {required bool sized}) {
    final hash = assetHash(block.attr('src'));
    if (hash == null) return _missing('This image is not in the document.');
    return FutureBuilder<Drawn>(
      future: FigureImages.asset(session, hash, dpr),
      builder: (context, snap) {
        if (snap.hasError) return _missing('${snap.error}');
        final drawn = snap.data;
        if (drawn == null) return _loading(inner * 0.4);
        // With a width, as wide as that; else at its own size, narrowed
        // (keeping its shape) to fit.
        return ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: Image.memory(
            drawn.bytes,
            scale: drawn.scale,
            width: sized ? inner : null,
            fit: BoxFit.contain,
            semanticLabel: block.attr('alt'),
            gaplessPlayback: true,
            errorBuilder: (_, _, _) => _missing('This image cannot be shown.'),
          ),
        );
      },
    );
  }

  Widget _diagram(double dpr, double inner) {
    final source = block.attr('source');
    return FutureBuilder<Drawn>(
      future: FigureImages.mermaid(source, dpr),
      builder: (context, snap) {
        if (snap.hasError) {
          return _sourceCard(
            'Mermaid diagram — cannot be drawn: ${snap.error}',
            source,
          );
        }
        final drawn = snap.data;
        if (drawn == null) return _loading(inner * 0.4);
        return Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(4),
          ),
          child: Center(
            child: Image.memory(
              drawn.bytes,
              scale: drawn.scale,
              gaplessPlayback: true,
            ),
          ),
        );
      },
    );
  }

  /// Infographics are drawn by AntV's runtime in the TS app; here they show
  /// their source until a native renderer exists.
  Widget _infographic(double inner) => _sourceCard(
    'Infographic — shown as source here; the Electron app draws it',
    block.attr('source'),
  );

  Widget _sourceCard(String title, String source) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: AppColors.panel,
      border: Border.all(color: AppColors.border),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontFamily: uiFont,
            fontSize: 12,
            color: AppColors.muted,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          source,
          maxLines: 12,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            fontFamily: monoFont,
            fontSize: 12,
            height: 1.4,
            color: AppColors.text,
          ),
        ),
      ],
    ),
  );

  Widget _missing(String why) => Container(
    height: 80,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: AppColors.panel,
      border: Border.all(color: AppColors.border),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      why,
      style: const TextStyle(
        fontFamily: uiFont,
        fontSize: 12,
        color: AppColors.muted,
      ),
    ),
  );

  Widget _loading(double height) => Container(
    height: height.clamp(48, 240),
    decoration: BoxDecoration(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(4),
    ),
  );

  /// Caption, source and layout of the selected figure.
  Widget _bar(int? percent) {
    final diagram = block.nodeName != 'imageFigure';
    final align = block.attr('align').isEmpty ? 'center' : block.attr('align');
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Wrap(
        spacing: 2,
        runSpacing: 2,
        children: [
          _button('Caption…', false, actions.caption, 'figure-caption'),
          if (diagram)
            _button('Source…', false, actions.source, 'figure-source'),
          const SizedBox(width: 8),
          for (final (label, value) in [
            ('Auto', null),
            ('50%', 50),
            ('75%', 75),
            ('100%', 100),
          ])
            _button(
              label,
              percent == value,
              () => actions.width(value),
              'figure-width-${value ?? 'auto'}',
            ),
          const SizedBox(width: 8),
          for (final (label, value) in [
            ('Left', 'left'),
            ('Center', 'center'),
            ('Right', 'right'),
          ])
            _button(
              label,
              align == value,
              () => actions.align(value),
              'figure-align-$value',
            ),
        ],
      ),
    );
  }

  Widget _button(String label, bool active, VoidCallback onTap, String key) =>
      MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          key: ValueKey(key),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: active ? AppColors.buttonActive : AppColors.panel,
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontFamily: uiFont,
                fontSize: 12,
                color: active ? AppColors.accent : AppColors.text,
              ),
            ),
          ),
        ),
      );
}

/// A mention chip in the line: one character of the block's text.
class MentionChip extends StatelessWidget {
  const MentionChip({super.key, required this.node, required this.style});

  final InlineView node;
  final TextStyle style;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 4),
    decoration: BoxDecoration(
      color: AppColors.link.withAlpha(0x26),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      node.chip,
      style: style.copyWith(
        color: AppColors.link,
        fontWeight: FontWeight.w600,
        fontStyle: FontStyle.normal,
        decoration: TextDecoration.none,
      ),
      textScaler: TextScaler.noScaling,
    ),
  );
}
