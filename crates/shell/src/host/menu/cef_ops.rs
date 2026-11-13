//! What batch M asks of Chromium that Tauri does not expose: the profile's
//! preferences (the spellcheck dictionaries, the accept languages) and a
//! browser's own commands (the custom dictionary, misspelling replacement,
//! key events, the print preview). Every function here runs on the CEF UI
//! thread; callers reach it through `on_ui` or a webview's `with_cef_webview`.

use cef::{
    BrowserHost, CefString, ImplBrowser, ImplBrowserHost, ImplListValue, ImplPreferenceManager,
    ImplValue, KeyEvent, KeyEventType, ValueType, list_value_create,
    request_context_get_global_context, value_create,
};

/// A preference of the global request context (the default session) as
/// strings: a list preference item by item, a string preference as one
pub fn string_list_preference(name: &str) -> Vec<String> {
    let Some(context) = request_context_get_global_context() else {
        return Vec::new();
    };
    let Some(value) = context.preference(Some(&CefString::from(name))) else {
        return Vec::new();
    };
    match value.get_type() {
        ValueType::LIST => {
            let Some(list) = value.list() else {
                return Vec::new();
            };
            (0..list.size())
                .map(|i| CefString::from(&list.string(i)).to_string())
                .collect()
        }
        ValueType::STRING => {
            let text = CefString::from(&value.string()).to_string();
            text.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Sets a list-of-strings preference of the global request context; the
/// profile keeps it across runs, as Chromium kept Electron's
pub fn set_string_list_preference(name: &str, items: &[String]) -> Result<(), String> {
    let context = request_context_get_global_context().ok_or("no request context")?;
    let mut list = list_value_create().ok_or("no list value")?;
    list.set_size(items.len());
    for (i, item) in items.iter().enumerate() {
        list.set_string(i, Some(&CefString::from(item.as_str())));
    }
    let mut value = value_create().ok_or("no value")?;
    value.set_list(Some(&mut list));
    let mut error = CefString::default();
    if context.set_preference(
        Some(&CefString::from(name)),
        Some(&mut value),
        Some(&mut error),
    ) == 0
    {
        return Err(error.to_string());
    }
    Ok(())
}

pub fn host_of(webview: &tauri_runtime_cef::Webview) -> Option<BrowserHost> {
    ImplBrowser::host(&webview.browser())
}

/// `session.addWordToSpellCheckerDictionary(word)`: Chromium's custom
/// dictionary of the profile, which every view of the session shares
pub fn add_word(host: &BrowserHost, word: &str) {
    host.add_word_to_dictionary(Some(&CefString::from(word)));
}

pub fn replace_misspelling(host: &BrowserHost, word: &str) {
    host.replace_misspelling(Some(&CefString::from(word)));
}

/// One Space key event, as `sendInputEvent` sent it: a raw key down, the
/// character, the key up
pub fn send_space(host: &BrowserHost, kind: KeyEventType) {
    const VK_SPACE: i32 = 0x20;
    let event = KeyEvent {
        size: std::mem::size_of::<cef::sys::_cef_key_event_t>(),
        type_: kind,
        modifiers: 0,
        windows_key_code: VK_SPACE,
        native_key_code: native_space(),
        is_system_key: 0,
        character: u16::from(b' '),
        unmodified_character: u16::from(b' '),
        focus_on_editable_field: 1,
    };
    host.send_key_event(Some(&event));
}

/// The platform's own code of the Space key, which a key event carries beside
/// the Windows one: macOS `kVK_Space`, X11/evdev 65, Windows the scan code 0x39
fn native_space() -> i32 {
    if cfg!(target_os = "macos") {
        0x31
    } else if cfg!(windows) {
        0x39
    } else {
        65
    }
}

/// Chrome's print preview over the view's page (`window.print()` from the
/// browser side). CEF gives no outcome: the caller answers success.
pub fn print_preview(host: &BrowserHost) {
    host.print();
}
