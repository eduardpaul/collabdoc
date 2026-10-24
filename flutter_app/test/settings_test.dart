// The settings file the native runner reads: GLib key-file format, edited
// in place so other groups and comments survive.

import 'dart:io';

import 'package:collabdoc/settings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory dir;
  late File file;
  setUp(() {
    dir = Directory.systemTemp.createTempSync('collabdoc-settings');
    file = File('${dir.path}/collabdoc/settings.ini');
  });
  tearDown(() => dir.deleteSync(recursive: true));

  test('no file means automatic', () {
    expect(Settings(file).renderer, Renderer.auto);
  });

  test('a choice is written as a key-file group and read back', () {
    Settings(file).renderer = Renderer.software;
    expect(file.readAsStringSync(), '[display]\nrenderer=software\n');
    expect(Settings(file).renderer, Renderer.software);
    Settings(file).renderer = Renderer.gpu;
    expect(file.readAsStringSync(), '[display]\nrenderer=gpu\n');
  });

  test('other groups, keys and comments are kept', () {
    file.parent.createSync(recursive: true);
    file.writeAsStringSync(
      '# mine\n[other]\nrenderer=keep\n\n[display]\nscale=2\n\n[last]\nx=1\n',
    );
    final settings = Settings(file);
    expect(settings.renderer, Renderer.auto, reason: 'other group ignored');
    settings.renderer = Renderer.software;
    expect(
      file.readAsStringSync(),
      '# mine\n[other]\nrenderer=keep\n\n[display]\nscale=2\n'
      'renderer=software\n\n[last]\nx=1\n',
    );
  });

  test('an unknown value reads as automatic', () {
    file.parent.createSync(recursive: true);
    file.writeAsStringSync('[display]\nrenderer=vulkan\n');
    expect(Settings(file).renderer, Renderer.auto);
  });

  test('the active renderer comes from the runner', () {
    expect(
      Settings(file, activeRenderer: 'software').activeRenderer,
      Renderer.software,
    );
    expect(Settings(file).activeRenderer, isNull);
  });
}
