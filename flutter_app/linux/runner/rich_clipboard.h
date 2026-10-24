#ifndef RUNNER_RICH_CLIPBOARD_H_
#define RUNNER_RICH_CLIPBOARD_H_

#include <flutter_linux/flutter_linux.h>

// The "collabdoc/clipboard" channel: Flutter's Clipboard carries plain text
// only, so copy (Markdown text + HTML) and reading pasted HTML go here.
//   write {text, html}  offers both, as text/plain and text/html
//   readHtml            the clipboard's text/html, or null
// Returns the channel; keep a reference for as long as the view lives.
FlMethodChannel* rich_clipboard_new(FlBinaryMessenger* messenger);

#endif  // RUNNER_RICH_CLIPBOARD_H_
