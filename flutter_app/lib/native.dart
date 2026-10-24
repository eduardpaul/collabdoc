// Binding to the Rust document core (crates/collabdoc-ffi).
//
// The C surface is open / fork / free plus one JSON command entry point, so
// this file is all the glue there is: every editing rule lives in Rust.
// Offsets are UTF-16 code units, which is how Dart strings index.

import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

import 'model.dart';

typedef _OpenC = Pointer<Void> Function(Pointer<Utf8>, Pointer<Pointer<Utf8>>);
typedef _ForkC = Pointer<Void> Function(Pointer<Void>);
typedef _FreeC = Void Function(Pointer<Void>);
typedef _FreeDart = void Function(Pointer<Void>);
typedef _CallC = Pointer<Utf8> Function(Pointer<Void>, Pointer<Utf8>);
typedef _ViewC = Pointer<Utf8> Function(Pointer<Void>);
typedef _StringFreeC = Void Function(Pointer<Utf8>);
typedef _StringFreeDart = void Function(Pointer<Utf8>);

class _Lib {
  _Lib(DynamicLibrary lib)
    : open = lib.lookupFunction<_OpenC, _OpenC>('cd_open'),
      fork = lib.lookupFunction<_ForkC, _ForkC>('cd_fork'),
      free = lib.lookupFunction<_FreeC, _FreeDart>('cd_free'),
      call = lib.lookupFunction<_CallC, _CallC>('cd_call'),
      view = lib.lookupFunction<_ViewC, _ViewC>('cd_view'),
      stringFree = lib.lookupFunction<_StringFreeC, _StringFreeDart>(
        'cd_string_free',
      );

  final _OpenC open;
  final _ForkC fork;
  final _FreeDart free;
  final _CallC call;
  final _ViewC view;
  final _StringFreeDart stringFree;

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

  /// Another participant on the same document, synced through the shared hub.
  Session fork() => Session._(_lib.fork(_ptr));

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

  ViewState view() => ViewState.fromJson(
    jsonDecode(_lib.take(_lib.view(_ptr))) as Map<String, dynamic>,
  );

  void dispose() {
    if (_ptr != nullptr) {
      _lib.free(_ptr);
      _ptr = nullptr;
    }
  }
}
