// The find and replace bar (Ctrl+F / Ctrl+H), like the TS app's
// SearchReplace: find, replace, case toggle, "n/N", previous/next, replace
// one or all. Matching and replacing happen in the core; the pane keeps the
// matches and paints them.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'theme.dart';

class FindBar extends StatefulWidget {
  const FindBar({
    super.key,
    required this.count,
    required this.index,
    required this.onQuery,
    required this.onStep,
    required this.onReplace,
    required this.onReplaceAll,
    required this.onClose,
  });

  /// Matches, and which one is current.
  final int count;
  final int index;

  final void Function(String query, bool caseSensitive) onQuery;
  final void Function(int delta) onStep;
  final void Function(String text) onReplace;
  final void Function(String text) onReplaceAll;
  final VoidCallback onClose;

  @override
  State<FindBar> createState() => FindBarState();
}

class FindBarState extends State<FindBar> {
  final find = TextEditingController();
  final replacement = TextEditingController();
  final findFocus = FocusNode(debugLabel: 'find');
  final replaceFocus = FocusNode(debugLabel: 'replace');
  bool caseSensitive = false;

  /// Puts the cursor in the find field (or the replace field), text selected.
  void focusField({bool replace = false}) {
    final (node, field) = replace
        ? (replaceFocus, replacement)
        : (findFocus, find);
    node.requestFocus();
    field.selection = TextSelection(
      baseOffset: 0,
      extentOffset: field.text.length,
    );
  }

  @override
  void dispose() {
    find.dispose();
    replacement.dispose();
    findFocus.dispose();
    replaceFocus.dispose();
    super.dispose();
  }

  void _query() => widget.onQuery(find.text, caseSensitive);

  @override
  Widget build(BuildContext context) {
    final has = widget.count > 0;
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): widget.onClose,
        const SingleActivator(LogicalKeyboardKey.keyF, control: true):
            focusField,
        const SingleActivator(LogicalKeyboardKey.keyH, control: true): () =>
            focusField(replace: true),
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: const BoxDecoration(
          color: AppColors.panel,
          border: Border(bottom: BorderSide(color: AppColors.border)),
        ),
        child: DefaultTextStyle(
          style: const TextStyle(
            fontFamily: uiFont,
            fontSize: 13,
            color: AppColors.text,
          ),
          child: Row(
            children: [
              Expanded(
                child: _Field(
                  key: const ValueKey('find-field'),
                  controller: find,
                  focus: findFocus,
                  hint: 'Find',
                  onChanged: (_) => _query(),
                  // Enter: next match; Shift+Enter: the one before.
                  onEnter: () => widget.onStep(
                    HardwareKeyboard.instance.isShiftPressed ? -1 : 1,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _Field(
                  key: const ValueKey('replace-field'),
                  controller: replacement,
                  focus: replaceFocus,
                  hint: 'Replace',
                  onEnter: () => widget.onReplace(replacement.text),
                ),
              ),
              const SizedBox(width: 8),
              _BarButton(
                'Aa',
                key: const ValueKey('find-case'),
                active: caseSensitive,
                tooltip: 'Match case',
                onTap: () {
                  setState(() => caseSensitive = !caseSensitive);
                  _query();
                },
              ),
              SizedBox(
                width: 64,
                child: Text(
                  has ? '${widget.index + 1}/${widget.count}' : '0',
                  key: const ValueKey('find-count'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColors.muted),
                ),
              ),
              _BarButton('Prev', enabled: has, onTap: () => widget.onStep(-1)),
              _BarButton('Next', enabled: has, onTap: () => widget.onStep(1)),
              _BarButton(
                'Replace',
                key: const ValueKey('replace-one'),
                enabled: has,
                onTap: () => widget.onReplace(replacement.text),
              ),
              _BarButton(
                'All',
                key: const ValueKey('replace-all'),
                enabled: has,
                onTap: () => widget.onReplaceAll(replacement.text),
              ),
              _BarButton(
                '×',
                key: const ValueKey('find-close'),
                tooltip: 'Close (Esc)',
                onTap: widget.onClose,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    super.key,
    required this.controller,
    required this.focus,
    required this.hint,
    required this.onEnter,
    this.onChanged,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final String hint;
  final VoidCallback onEnter;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      focusNode: focus,
      onChanged: onChanged,
      onSubmitted: (_) {
        onEnter();
        focus.requestFocus(); // stay in the field, like a browser
      },
      onEditingComplete: () {},
      cursorColor: AppColors.accent,
      style: const TextStyle(
        fontFamily: uiFont,
        fontSize: 13,
        color: AppColors.text,
      ),
      decoration: InputDecoration(
        isDense: true,
        hintText: hint,
        hintStyle: const TextStyle(color: AppColors.muted),
        filled: true,
        fillColor: AppColors.bg,
        contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        enabledBorder: const OutlineInputBorder(
          borderSide: BorderSide(color: AppColors.border),
        ),
        focusedBorder: const OutlineInputBorder(
          borderSide: BorderSide(color: AppColors.accent),
        ),
      ),
    );
  }
}

class _BarButton extends StatelessWidget {
  const _BarButton(
    this.label, {
    super.key,
    required this.onTap,
    this.enabled = true,
    this.active = false,
    this.tooltip,
  });

  final String label;
  final VoidCallback onTap;
  final bool enabled;
  final bool active;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    Widget button = MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: GestureDetector(
        onTap: enabled ? onTap : null,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          decoration: BoxDecoration(
            color: active ? AppColors.buttonActive : null,
            borderRadius: BorderRadius.circular(4),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: !enabled
                  ? AppColors.muted.withAlpha(0x80)
                  : active
                  ? AppColors.accent
                  : AppColors.text,
            ),
          ),
        ),
      ),
    );
    if (tooltip != null) button = Tooltip(message: tooltip, child: button);
    return button;
  }
}
