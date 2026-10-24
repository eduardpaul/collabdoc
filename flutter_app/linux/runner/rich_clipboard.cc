#include "rich_clipboard.h"

#include <gtk/gtk.h>
#include <string.h>

namespace {

enum Target { kText = 0, kHtml = 1 };

struct Offer {
  gchar* text;
  gchar* html;
};

void offer_get(GtkClipboard*, GtkSelectionData* selection, guint info,
               gpointer user_data) {
  auto* offer = static_cast<Offer*>(user_data);
  if (info == kHtml) {
    gtk_selection_data_set(selection, gtk_selection_data_get_target(selection),
                           8, reinterpret_cast<const guchar*>(offer->html),
                           strlen(offer->html));
  } else {
    gtk_selection_data_set_text(selection, offer->text, -1);
  }
}

void offer_clear(GtkClipboard*, gpointer user_data) {
  auto* offer = static_cast<Offer*>(user_data);
  g_free(offer->text);
  g_free(offer->html);
  g_free(offer);
}

void write(const gchar* text, const gchar* html) {
  GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
  GtkTargetList* list = gtk_target_list_new(nullptr, 0);
  if (html[0] != '\0') {
    gtk_target_list_add(list, gdk_atom_intern_static_string("text/html"), 0,
                        kHtml);
  }
  gtk_target_list_add_text_targets(list, kText);
  gint count = 0;
  GtkTargetEntry* targets = gtk_target_table_new_from_list(list, &count);
  auto* offer = g_new0(Offer, 1);
  offer->text = g_strdup(text);
  offer->html = g_strdup(html);
  if (!gtk_clipboard_set_with_data(clipboard, targets, count, offer_get,
                                   offer_clear, offer)) {
    offer_clear(clipboard, offer);
  }
  // Keep both flavours available after the app quits (clipboard managers).
  gtk_clipboard_set_can_store(clipboard, nullptr, 0);
  gtk_target_table_free(targets, count);
  gtk_target_list_unref(list);
}

void html_received(GtkClipboard*, GtkSelectionData* selection,
                   gpointer user_data) {
  g_autoptr(FlMethodCall) call = FL_METHOD_CALL(user_data);
  g_autoptr(FlValue) result = nullptr;
  const gint length =
      selection != nullptr ? gtk_selection_data_get_length(selection) : -1;
  if (length > 0) {
    const guchar* bytes = gtk_selection_data_get_data(selection);
    gchar* html = nullptr;
    // Firefox offers UTF-16 (with a byte-order mark, or plain ASCII's
    // zero high bytes); everyone else UTF-8.
    const bool bom = length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE;
    if (bom || (length >= 2 && bytes[1] == 0)) {
      const guchar* start = bom ? bytes + 2 : bytes;
      const glong units = (length - (bom ? 2 : 0)) / 2;
      html = g_utf16_to_utf8(reinterpret_cast<const gunichar2*>(start), units,
                             nullptr, nullptr, nullptr);
    } else {
      html = g_strndup(reinterpret_cast<const gchar*>(bytes), length);
    }
    if (html != nullptr && g_utf8_validate(html, -1, nullptr)) {
      result = fl_value_new_string(html);
    }
    g_free(html);
  }
  if (result == nullptr) result = fl_value_new_null();
  fl_method_call_respond_success(call, result, nullptr);
}

// An image on the clipboard (a screenshot, an image copied in a browser),
// re-encoded as PNG whatever its format, or null.
void image_received(GtkClipboard*, GdkPixbuf* pixbuf, gpointer user_data) {
  g_autoptr(FlMethodCall) call = FL_METHOD_CALL(user_data);
  g_autoptr(FlValue) result = nullptr;
  gchar* buffer = nullptr;
  gsize size = 0;
  if (pixbuf != nullptr &&
      gdk_pixbuf_save_to_buffer(pixbuf, &buffer, &size, "png", nullptr,
                                nullptr)) {
    result = fl_value_new_uint8_list(reinterpret_cast<const uint8_t*>(buffer),
                                     size);
  }
  g_free(buffer);
  if (result == nullptr) result = fl_value_new_null();
  fl_method_call_respond_success(call, result, nullptr);
}

const gchar* string_arg(FlValue* args, const gchar* key) {
  if (args == nullptr || fl_value_get_type(args) != FL_VALUE_TYPE_MAP) {
    return "";
  }
  FlValue* value = fl_value_lookup_string(args, key);
  return value != nullptr && fl_value_get_type(value) == FL_VALUE_TYPE_STRING
             ? fl_value_get_string(value)
             : "";
}

void method_call(FlMethodChannel*, FlMethodCall* call, gpointer) {
  const gchar* method = fl_method_call_get_name(call);
  if (g_strcmp0(method, "write") == 0) {
    FlValue* args = fl_method_call_get_args(call);
    write(string_arg(args, "text"), string_arg(args, "html"));
    fl_method_call_respond_success(call, nullptr, nullptr);
  } else if (g_strcmp0(method, "readHtml") == 0) {
    gtk_clipboard_request_contents(
        gtk_clipboard_get(GDK_SELECTION_CLIPBOARD),
        gdk_atom_intern_static_string("text/html"), html_received,
        g_object_ref(call));
  } else if (g_strcmp0(method, "readImage") == 0) {
    gtk_clipboard_request_image(gtk_clipboard_get(GDK_SELECTION_CLIPBOARD),
                                image_received, g_object_ref(call));
  } else {
    fl_method_call_respond_not_implemented(call, nullptr);
  }
}

}  // namespace

FlMethodChannel* rich_clipboard_new(FlBinaryMessenger* messenger) {
  g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
  FlMethodChannel* channel = fl_method_channel_new(
      messenger, "collabdoc/clipboard", FL_METHOD_CODEC(codec));
  fl_method_channel_set_method_call_handler(channel, method_call, nullptr,
                                            nullptr);
  return channel;
}
