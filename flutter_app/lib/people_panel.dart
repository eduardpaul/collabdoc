// Identity and presence (spec 07): the profile form (first launch, and
// Edit profile), and the People tab: "In this session" (you, everyone
// connected, invited agents, each with role and live status) and the
// document's other collaborators, offline, as the registry lists them.

import 'dart:async';

import 'package:flutter/material.dart';

import 'model.dart';
import 'native.dart';
import 'theme.dart';
import 'workspace.dart';

/// Name, `@handle` (validated, following the name until edited) and color.
class ProfileForm extends StatefulWidget {
  const ProfileForm({
    super.key,
    required this.profile,
    required this.onSaved,
    required this.onCancel,
    this.cancelLabel = 'Cancel',
    this.autofocus = true,
  });

  final Profile profile;
  final bool autofocus;
  final ValueChanged<Profile> onSaved;
  final VoidCallback onCancel;
  final String cancelLabel;

  @override
  State<ProfileForm> createState() => ProfileFormState();
}

class ProfileFormState extends State<ProfileForm> {
  late final _name = TextEditingController(
    text: widget.profile.setupComplete ? widget.profile.name : '',
  );
  late final _handle = TextEditingController(text: widget.profile.handle);
  late String _color = widget.profile.color;

  /// The handle follows the name until the user types one.
  late bool _derived =
      !widget.profile.setupComplete ||
      widget.profile.handle == CoreStore.handleFromName(widget.profile.name);
  String _error = '';

  @override
  void dispose() {
    _name.dispose();
    _handle.dispose();
    super.dispose();
  }

  void _nameChanged(String name) {
    if (_derived) {
      _handle.text = CoreStore.handleFromName(
        name.trim().isEmpty ? 'You' : name,
      );
    }
    setState(() => _error = '');
  }

  void _save() {
    final handle = _handle.text.trim().replaceFirst(RegExp('^@+'), '');
    if (!isValidHandle(handle)) {
      setState(() => _error = 'A handle is 2–20 of a–z, 0–9, _ and -.');
      return;
    }
    try {
      widget.onSaved(
        CoreStore.saveProfile(
          name: _name.text.trim().isEmpty ? 'You' : _name.text,
          handle: handle,
          color: _color,
        ),
      );
    } on CoreException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _field(
          'profile-name',
          _name,
          'Your name',
          onChanged: _nameChanged,
          autofocus: widget.autofocus,
        ),
        const SizedBox(height: 10),
        _field(
          'profile-handle',
          _handle,
          'handle',
          prefix: '@',
          onChanged: (_) => setState(() {
            _derived = false;
            _error = '';
          }),
        ),
        if (_error.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              _error,
              key: const ValueKey('profile-handle-error'),
              style: const TextStyle(color: AppColors.accent, fontSize: 12),
            ),
          ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          children: [
            for (final c in userColors)
              GestureDetector(
                key: ValueKey('profile-color-$c'),
                onTap: () => setState(() => _color = c),
                child: Container(
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(
                    color: Color(parseHexColor(c)),
                    shape: BoxShape.circle,
                    border: Border.all(
                      width: 2,
                      color: c == _color ? AppColors.text : Colors.transparent,
                    ),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            panelButton('Save', _save, 'profile-save', primary: true),
            const SizedBox(width: 8),
            panelButton(widget.cancelLabel, widget.onCancel, 'profile-cancel'),
          ],
        ),
      ],
    );
  }

  Widget _field(
    String key,
    TextEditingController controller,
    String hint, {
    String? prefix,
    ValueChanged<String>? onChanged,
    bool autofocus = false,
  }) => TextField(
    key: ValueKey(key),
    controller: controller,
    autofocus: autofocus,
    onChanged: onChanged,
    onSubmitted: (_) => _save(),
    style: const TextStyle(fontFamily: uiFont, fontSize: 14),
    decoration: InputDecoration(
      isDense: true,
      hintText: hint,
      prefixText: prefix,
      hintStyle: const TextStyle(color: AppColors.muted),
      contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
      border: const OutlineInputBorder(),
    ),
  );
}

/// Edit profile, as a dialog; the saved profile, or null.
Future<Profile?> editProfile(BuildContext context) => showDialog<Profile>(
  context: context,
  builder: (context) => Dialog(
    backgroundColor: AppColors.panel,
    child: SizedBox(
      width: 360,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Profile',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            const Text(
              'How others see you in documents you share.',
              style: TextStyle(color: AppColors.muted, fontSize: 12),
            ),
            const SizedBox(height: 14),
            ProfileForm(
              profile: CoreStore.profile(),
              onSaved: (p) => Navigator.of(context).pop(p),
              onCancel: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ),
    ),
  ),
);

/// A colored dot, the name and `@handle`.
class ProfileChip extends StatelessWidget {
  const ProfileChip({super.key, required this.profile, required this.onTap});

  final Profile profile;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => MouseRegion(
    cursor: SystemMouseCursors.click,
    child: GestureDetector(
      key: const ValueKey('profile-chip'),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: AppColors.buttonHover,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _dot(parseHexColor(profile.color)),
            const SizedBox(width: 8),
            Text(
              profile.name,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(width: 6),
            Text(
              '@${profile.handle}',
              style: const TextStyle(color: AppColors.muted),
            ),
          ],
        ),
      ),
    ),
  );
}

Widget _dot(int color, {bool online = true}) => Container(
  width: 9,
  height: 9,
  decoration: BoxDecoration(
    color: online ? Color(color) : Colors.transparent,
    shape: BoxShape.circle,
    border: Border.all(color: Color(color), width: 1.5),
  ),
);

class PeoplePanel extends StatefulWidget {
  const PeoplePanel({super.key, required this.workspace});

  final Workspace workspace;

  @override
  State<PeoplePanel> createState() => PeoplePanelState();
}

class PeoplePanelState extends State<PeoplePanel> {
  People people = const People.empty();
  Participant? _listening;

  /// Presence expires without a message; read again every second.
  Timer? _tick;

  Participant get _participant =>
      widget.workspace.peopleFor ?? widget.workspace.participants.first;

  @override
  void initState() {
    super.initState();
    _follow();
    widget.workspace.historyVersion.addListener(_changed);
    widget.workspace.addListener(_follow);
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _changed());
  }

  @override
  void dispose() {
    _listening?.presenceVersion.removeListener(_changed);
    widget.workspace.historyVersion.removeListener(_changed);
    widget.workspace.removeListener(_follow);
    _tick?.cancel();
    super.dispose();
  }

  /// Listens to the participant whose view the panel shows.
  void _follow() {
    final p = _participant;
    if (!identical(p, _listening)) {
      _listening?.presenceVersion.removeListener(_changed);
      p.presenceVersion.addListener(_changed);
      _listening = p;
    }
    _changed();
  }

  void _changed() {
    if (mounted) setState(() => people = _participant.session.people());
  }

  Future<void> _editProfile() async {
    final saved = await editProfile(context);
    if (saved != null) widget.workspace.applyProfile(saved);
  }

  @override
  Widget build(BuildContext context) {
    final inSession = {for (final p in people.session) p.id};
    final others = people.everyone.where((p) => !inSession.contains(p.id));
    return Container(
      key: const ValueKey('people-panel'),
      color: AppColors.panel,
      child: DefaultTextStyle(
        style: const TextStyle(
          fontFamily: uiFont,
          fontSize: 13,
          color: AppColors.text,
        ),
        child: ListView(
          padding: const EdgeInsets.all(14),
          children: [
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'In this session',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                  ),
                ),
                panelButton(
                  'Edit profile',
                  _editProfile,
                  'people-edit-profile',
                ),
              ],
            ),
            const SizedBox(height: 10),
            for (final p in people.session) _row(p),
            if (people.handleChanged)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  'Someone else here has your handle; you are '
                  '@${people.localHandle} in this document.',
                  key: const ValueKey('people-handle-changed'),
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
              ),
            const SizedBox(height: 10),
            const Text(
              'Ctrl+Alt+L claims the blocks you have selected for 30 s: '
              'the others see them outlined with your name.',
              style: TextStyle(color: AppColors.muted, fontSize: 12),
            ),
            if (others.isNotEmpty) ...[
              const SizedBox(height: 18),
              const Text(
                'Also on this document',
                style: TextStyle(
                  color: AppColors.muted,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 6),
              for (final p in others) _row(p),
            ],
          ],
        ),
      ),
    );
  }

  Widget _row(Person p) {
    final role = switch (p.kind) {
      'you' => 'You',
      _ => p.role == 'agent' ? 'Agent' : 'Human',
    };
    return Padding(
      key: ValueKey('person-${p.id}'),
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: _dot(p.color, online: p.online),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      p.name,
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: p.online ? AppColors.text : AppColors.muted,
                      ),
                    ),
                    Text(
                      '@${p.handle}',
                      style: const TextStyle(color: AppColors.muted),
                    ),
                    if (p.kind.isNotEmpty)
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 5,
                          vertical: 1,
                        ),
                        decoration: BoxDecoration(
                          border: Border.all(color: AppColors.border),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          role,
                          style: const TextStyle(
                            fontSize: 11,
                            color: AppColors.muted,
                          ),
                        ),
                      ),
                  ],
                ),
                Text(
                  p.kind.isEmpty ? 'offline' : p.status,
                  key: ValueKey('person-status-${p.id}'),
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A small button, as the History tab's.
Widget panelButton(
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
