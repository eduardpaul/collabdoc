// Binding to the Rust document core (crates/collabdoc-ffi).
//
// The C surface is open / fork / free plus one JSON command entry point, so
// this file is all the glue there is: every editing rule lives in Rust.
// Offsets are UTF-16 code units, which is how Dart strings index.

import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'model.dart';

typedef _OpenC = Pointer<Void> Function(Pointer<Utf8>, Pointer<Pointer<Utf8>>);
typedef _StoreC = Pointer<Utf8> Function(Pointer<Utf8>);
typedef _ForkC = Pointer<Void> Function(Pointer<Void>);
typedef _FreeC = Void Function(Pointer<Void>);
typedef _FreeDart = void Function(Pointer<Void>);
typedef _CallC = Pointer<Utf8> Function(Pointer<Void>, Pointer<Utf8>);
typedef _ViewC = Pointer<Utf8> Function(Pointer<Void>);
typedef _StringFreeC = Void Function(Pointer<Utf8>);
typedef _StringFreeDart = void Function(Pointer<Utf8>);
typedef _AssetC = Pointer<Uint8> Function(
  Pointer<Void>,
  Pointer<Utf8>,
  Pointer<Size>,
);
typedef _MermaidC = Pointer<Uint8> Function(
  Pointer<Utf8>,
  Float,
  Pointer<Size>,
  Pointer<Pointer<Utf8>>,
);
typedef _MermaidDart = Pointer<Uint8> Function(
  Pointer<Utf8>,
  double,
  Pointer<Size>,
  Pointer<Pointer<Utf8>>,
);
typedef _SvgC = Pointer<Uint8> Function(
  Pointer<Uint8>,
  Size,
  Float,
  Pointer<Size>,
  Pointer<Pointer<Utf8>>,
);
typedef _SvgDart = Pointer<Uint8> Function(
  Pointer<Uint8>,
  int,
  double,
  Pointer<Size>,
  Pointer<Pointer<Utf8>>,
);
typedef _VersionC = Pointer<Void> Function(
  Pointer<Void>,
  Pointer<Utf8>,
  Pointer<Pointer<Utf8>>,
);
typedef _BytesFreeC = Void Function(Pointer<Uint8>, Size);
typedef _BytesFreeDart = void Function(Pointer<Uint8>, int);

class _Lib {
  _Lib(DynamicLibrary lib)
    : open = lib.lookupFunction<_OpenC, _OpenC>('cd_open'),
      openWith = lib.lookupFunction<_OpenC, _OpenC>('cd_open_with'),
      store = lib.lookupFunction<_StoreC, _StoreC>('cd_store'),
      fork = lib.lookupFunction<_ForkC, _ForkC>('cd_fork'),
      free = lib.lookupFunction<_FreeC, _FreeDart>('cd_free'),
      call = lib.lookupFunction<_CallC, _CallC>('cd_call'),
      view = lib.lookupFunction<_ViewC, _ViewC>('cd_view'),
      stringFree = lib.lookupFunction<_StringFreeC, _StringFreeDart>(
        'cd_string_free',
      ),
      asset = lib.lookupFunction<_AssetC, _AssetC>('cd_asset'),
      openVersion = lib.lookupFunction<_VersionC, _VersionC>('cd_open_version'),
      renderMermaid = lib.lookupFunction<_MermaidC, _MermaidDart>(
        'cd_render_mermaid',
      ),
      renderSvg = lib.lookupFunction<_SvgC, _SvgDart>('cd_render_svg'),
      bytesFree = lib.lookupFunction<_BytesFreeC, _BytesFreeDart>(
        'cd_bytes_free',
      );

  final _OpenC open;
  final _OpenC openWith;
  final _StoreC store;
  final _ForkC fork;
  final _FreeDart free;
  final _CallC call;
  final _ViewC view;
  final _StringFreeDart stringFree;
  final _AssetC asset;
  final _VersionC openVersion;
  final _MermaidDart renderMermaid;
  final _SvgDart renderSvg;
  final _BytesFreeDart bytesFree;

  /// The bundled `lib/libcollabdoc_ffi.so`, or `COLLABDOC_FFI_LIB` (tests).
  static _Lib load() {
    final override = Platform.environment['COLLABDOC_FFI_LIB'];
    if (override != null && override.isNotEmpty) {
      return _Lib(DynamicLibrary.open(override));
    }
    final name = Platform.isWindows
        ? 'collabdoc_ffi.dll'
        : Platform.isMacOS
        ? 'libcollabdoc_ffi.dylib'
        : 'libcollabdoc_ffi.so';
    return _Lib(DynamicLibrary.open(name));
  }

  String take(Pointer<Utf8> s) {
    final out = s.toDartString();
    stringFree(s);
    return out;
  }

  /// Copies bytes Rust handed over (or reads its error), then frees them.
  Uint8List takeBytes(
    Pointer<Uint8> ptr,
    Pointer<Size> len,
    Pointer<Pointer<Utf8>>? error,
  ) {
    if (ptr == nullptr) {
      final e = error?.value ?? nullptr;
      throw CoreException(e == nullptr ? 'not available' : take(e));
    }
    final out = Uint8List.fromList(ptr.asTypedList(len.value));
    bytesFree(ptr, len.value);
    return out;
  }
}

final _Lib _lib = _Lib.load();

class CoreException implements Exception {
  CoreException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// One participant on a document: its own Loro peer and undo stack.
class Session {
  Session._(this._ptr);

  Pointer<Void> _ptr;

  /// Opens `path`, or a new document (that will save there) when it does not exist.
  static Session open(String? path) {
    final error = calloc<Pointer<Utf8>>();
    final cPath = path == null ? nullptr : path.toNativeUtf8();
    try {
      final ptr = _lib.open(cPath.cast(), error);
      if (ptr == nullptr) {
        throw CoreException(_lib.take(error.value));
      }
      return Session._(ptr);
    } finally {
      if (cPath != nullptr) calloc.free(cPath);
      calloc.free(error);
    }
  }

  /// Opens per `spec`: `{'new': true}`, `{'path': …}` (a `.collabdoc`, or
  /// Markdown to import) or `{'draft': docId}` (recover a draft).
  static Session openWith(Map<String, Object?> spec) {
    final error = calloc<Pointer<Utf8>>();
    final cSpec = jsonEncode(spec).toNativeUtf8();
    try {
      final ptr = _lib.openWith(cSpec, error);
      if (ptr == nullptr) {
        throw CoreException(_lib.take(error.value));
      }
      return Session._(ptr);
    } finally {
      calloc.free(cSpec);
      calloc.free(error);
    }
  }

  /// Another participant on the same document, synced through the shared hub.
  Session fork() => Session._(_lib.fork(_ptr));

  /// The document as it was at `frontiers` (a history entry's or a
  /// checkpoint's), read-only: typing and saving do nothing.
  Session openVersion(List frontiers) {
    final error = calloc<Pointer<Utf8>>();
    final cFrontiers = jsonEncode(frontiers).toNativeUtf8();
    try {
      final ptr = _lib.openVersion(_ptr, cFrontiers, error);
      if (ptr == nullptr) throw CoreException(_lib.take(error.value));
      return Session._(ptr);
    } finally {
      calloc.free(cFrontiers);
      calloc.free(error);
    }
  }

  Map<String, dynamic> call(Map<String, Object?> command) {
    final cmd = jsonEncode(command).toNativeUtf8();
    try {
      return jsonDecode(_lib.take(_lib.call(_ptr, cmd)))
          as Map<String, dynamic>;
    } finally {
      calloc.free(cmd);
    }
  }

  /// Runs an edit; true when the document changed.
  bool edit(Map<String, Object?> command) {
    final reply = call(command);
    if (reply['ok'] != true) throw CoreException('${reply['error']}');
    return reply['changed'] == true;
  }

  /// Everyone else's caret, as of the hub's latest presence.
  List<RemoteCaret> carets() {
    final reply = call({'op': 'carets'});
    return [
      for (final c in (reply['carets'] as List? ?? const []))
        RemoteCaret.fromJson(c as Map<String, dynamic>),
    ];
  }

  ViewState? _view;

  /// The current view, built from the previous one plus what changed.
  ViewState view() => _view = ViewState.next(
    _view,
    jsonDecode(_lib.take(_lib.view(_ptr))) as Map<String, dynamic>,
  );

  /// The bytes of image `hash` (PNG, JPEG, GIF, WebP or SVG), or null.
  Uint8List? asset(String hash) {
    final cHash = hash.toNativeUtf8();
    final len = calloc<Size>();
    try {
      final ptr = _lib.asset(_ptr, cHash, len);
      return ptr == nullptr ? null : _lib.takeBytes(ptr, len, null);
    } finally {
      calloc.free(cHash);
      calloc.free(len);
    }
  }

  void dispose() {
    if (_ptr != nullptr) {
      _lib.free(_ptr);
      _ptr = nullptr;
    }
  }
}

/// The document store, without an open document: recents, recoveries, and
/// where it keeps things.
class CoreStore {
  static Map<String, dynamic> call(Map<String, Object?> command) {
    final cmd = jsonEncode(command).toNativeUtf8();
    try {
      return jsonDecode(_lib.take(_lib.store(cmd))) as Map<String, dynamic>;
    } finally {
      calloc.free(cmd);
    }
  }

  /// Puts drafts, the journal and recents in `userData` (tests).
  static void configure({
    required String userData,
    String? documentsDir,
    int? idleMs,
  }) => call({
    'op': 'configure',
    'userData': userData,
    'documentsDir': ?documentsDir,
    'idleMs': ?idleMs,
  });

  static Listing listing() {
    final reply = call({'op': 'listing'});
    if (reply['ok'] != true) return const Listing.empty();
    return Listing.fromJson(reply['listing'] as Map<String, dynamic>);
  }

  static void removeRecent(String docId) =>
      call({'op': 'removeRecent', 'docId': docId});

  static void discardDraft(String docId) =>
      call({'op': 'discardDraft', 'docId': docId});

  static String documentsDir() =>
      call({'op': 'documentsDir'})['path'] as String;
}

/// Mermaid `source` drawn by the core as a PNG, `scale` device pixels per
/// unit. Pure: safe in a background isolate. Throws [CoreException] with the
/// reason a diagram cannot be drawn.
Uint8List renderMermaid(String source, double scale) {
  final cSource = source.toNativeUtf8();
  final len = calloc<Size>();
  final error = calloc<Pointer<Utf8>>();
  try {
    return _lib.takeBytes(
      _lib.renderMermaid(cSource, scale, len, error),
      len,
      error,
    );
  } finally {
    calloc.free(cSource);
    calloc.free(len);
    calloc.free(error);
  }
}

/// An SVG image drawn as a PNG. Pure: safe in a background isolate.
Uint8List renderSvg(Uint8List svg, double scale) {
  final data = calloc<Uint8>(svg.length);
  data.asTypedList(svg.length).setAll(0, svg);
  final len = calloc<Size>();
  final error = calloc<Pointer<Utf8>>();
  try {
    return _lib.takeBytes(
      _lib.renderSvg(data, svg.length, scale, len, error),
      len,
      error,
    );
  } finally {
    calloc.free(data);
    calloc.free(len);
    calloc.free(error);
  }
}
