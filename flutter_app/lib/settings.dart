// App settings the native runner reads before Flutter starts, kept in
// `$XDG_CONFIG_HOME/collabdoc/settings.ini` (GLib key-file format):
//
//   [display]
//   renderer=auto        auto | gpu | software
//
// The runner (linux/runner/my_application.cc) resolves `auto` and reports
// what it chose in COLLABDOC_RENDERER_ACTIVE, so changes apply on restart.

import 'dart:io';

enum Renderer {
  /// Software when the machine has no GPU, the GPU otherwise.
  auto('Automatic'),

  /// Flutter's default GPU renderer.
  gpu('GPU'),

  /// Skia's CPU rasterizer: about 100 MB less memory, no GPU needed.
  software('Software');

  const Renderer(this.label);
  final String label;
}

class Settings {
  Settings(this.file, {String? activeRenderer})
    : activeRenderer = switch (activeRenderer) {
        'gpu' => Renderer.gpu,
        'software' => Renderer.software,
        _ => null,
      };

  /// The user's settings file, and the renderer this process started with.
  factory Settings.forUser() {
    final env = Platform.environment;
    final config =
        env['XDG_CONFIG_HOME'] ??
        '${env['HOME'] ?? Directory.systemTemp.path}/.config';
    return Settings(
      File('$config/collabdoc/settings.ini'),
      activeRenderer: env['COLLABDOC_RENDERER_ACTIVE'],
    );
  }

  final File file;

  /// What the runner chose at startup; null when not started by it (tests).
  final Renderer? activeRenderer;

  Renderer get renderer {
    final value = _read('display', 'renderer');
    return Renderer.values.firstWhere(
      (r) => r.name == value,
      orElse: () => Renderer.auto,
    );
  }

  set renderer(Renderer value) => _write('display', 'renderer', value.name);

  String? _read(String group, String key) {
    String? current;
    for (final line in _lines()) {
      final t = line.trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        current = t.substring(1, t.length - 1);
      } else if (current == group && t.startsWith('$key=')) {
        return t.substring(key.length + 1).trim();
      }
    }
    return null;
  }

  /// Sets one key, keeping every other line (and comment) as it was.
  void _write(String group, String key, String value) {
    final lines = _lines();
    String? current;
    var groupEnd = -1;
    for (var i = 0; i < lines.length; i++) {
      final t = lines[i].trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        current = t.substring(1, t.length - 1);
        if (current == group) groupEnd = i + 1;
      } else if (current == group) {
        if (t.startsWith('$key=')) {
          lines[i] = '$key=$value';
          return _save(lines);
        }
        if (t.isNotEmpty) groupEnd = i + 1;
      }
    }
    if (groupEnd < 0) {
      if (lines.isNotEmpty && lines.last.trim().isNotEmpty) lines.add('');
      lines.addAll(['[$group]', '$key=$value']);
    } else {
      lines.insert(groupEnd, '$key=$value');
    }
    _save(lines);
  }

  List<String> _lines() {
    try {
      final text = file.readAsStringSync();
      final lines = text.split('\n');
      if (lines.isNotEmpty && lines.last.isEmpty) lines.removeLast();
      return lines;
    } on FileSystemException {
      return [];
    }
  }

  void _save(List<String> lines) {
    file.parent.createSync(recursive: true);
    file.writeAsStringSync('${lines.join('\n')}\n');
  }
}
