// The clipboard with HTML beside the text. Flutter's Clipboard carries plain
// text only; the GTK runner's "collabdoc/clipboard" channel adds text/html.
// Without the channel (tests, other platforms) it falls back to plain text.

import 'package:flutter/services.dart';

class RichClipboard {
  static const _channel = MethodChannel('collabdoc/clipboard');

  /// Offers `text` (Markdown) and `html` together.
  static Future<void> write(String text, String html) async {
    try {
      await _channel.invokeMethod('write', {'text': text, 'html': html});
    } on MissingPluginException {
      await Clipboard.setData(ClipboardData(text: text));
    }
  }

  /// The clipboard's text/html, if it has some.
  static Future<String?> readHtml() async {
    try {
      final html = await _channel.invokeMethod<String>('readHtml');
      return html == null || html.trim().isEmpty ? null : html;
    } on MissingPluginException {
      return null;
    }
  }

  /// An image on the clipboard, as PNG bytes (the GTK runner converts
  /// whatever image it holds), or null.
  static Future<Uint8List?> readImage() async {
    try {
      final png = await _channel.invokeMethod<Uint8List>('readImage');
      return png == null || png.isEmpty ? null : png;
    } on MissingPluginException {
      return null;
    }
  }

  static Future<String?> readText() async =>
      (await Clipboard.getData(Clipboard.kTextPlain))?.text;
}
