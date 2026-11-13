// SeuOffice patch 0001 (see ../patches): not part of upstream tauri-runtime-cef.
//
// Lets the application take a webview's context menu over. The CEF runtime builds
// Chrome style browsers and otherwise always shows Chrome's own (filtered) menu;
// CEF only lets a client replace it from `CefContextMenuHandler::RunContextMenu`,
// which the runtime does not expose. This is the smallest public surface that does:
// one process-wide handler, installed once, without touching window creation.

use std::sync::{
  Arc, OnceLock,
  atomic::{AtomicBool, Ordering},
};

use cef::{
  ContextMenuParams as CefContextMenuParams, ImplContextMenuParams, ImplRunContextMenuCallback,
  RunContextMenuCallback, wrap_task, *,
};

/// Which edit commands the element under the pointer allows
/// (`cef_context_menu_edit_state_flags_t`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EditFlags {
  pub can_undo: bool,
  pub can_redo: bool,
  pub can_cut: bool,
  pub can_copy: bool,
  pub can_paste: bool,
  pub can_delete: bool,
  pub can_select_all: bool,
}

/// What the page's context menu was opened on (`CefContextMenuParams`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextMenuParams {
  /// Pointer position in the webview's view coordinates (DIPs).
  pub x: i32,
  pub y: i32,
  pub is_editable: bool,
  pub selection_text: String,
  /// The misspelled word under the pointer, empty when there is none.
  pub misspelled_word: String,
  /// Spellcheck replacements for `misspelled_word`.
  pub dictionary_suggestions: Vec<String>,
  /// `"image"`, `"video"`, `"audio"`, `"canvas"`, `"file"` or `"plugin"`;
  /// `None` when the menu was not opened on media.
  pub media_type: Option<String>,
  /// The media element's source URL; `None` when empty.
  pub src_url: Option<String>,
  pub edit_flags: EditFlags,
}

/// Ends a context menu the app took over. Dropping it without calling
/// [`ContextMenuDone::cancel`] cancels too.
///
/// It may be moved to and used from any thread: the CEF callback is only ever
/// touched on the CEF UI thread, `cancel` posts there when called elsewhere.
pub struct ContextMenuDone {
  callback: Option<RunContextMenuCallback>,
  // Set once the handler declined the menu: the runtime then shows Chrome's menu
  // and the callback it gave out must stay untouched, so dropping does nothing.
  declined: Arc<AtomicBool>,
}

impl ContextMenuDone {
  /// Closes the menu. Nothing was chosen: the page gets no command.
  pub fn cancel(mut self) {
    self.finish();
  }

  fn finish(&mut self) {
    let Some(callback) = self.callback.take() else {
      return;
    };
    if self.declined.load(Ordering::Acquire) {
      return;
    }
    if currently_on(sys::cef_thread_id_t::TID_UI.into()) != 0 {
      callback.cancel();
    } else {
      let mut task = CancelMenuTask::new(callback, self.declined.clone());
      post_task(sys::cef_thread_id_t::TID_UI.into(), Some(&mut task));
    }
  }
}

impl Drop for ContextMenuDone {
  fn drop(&mut self) {
    self.finish();
  }
}

wrap_task! {
  struct CancelMenuTask {
    callback: RunContextMenuCallback,
    declined: Arc<AtomicBool>,
  }

  impl Task {
    fn execute(&self) {
      if !self.declined.load(Ordering::Acquire) {
        self.callback.cancel();
      }
    }
  }
}

type Handler = dyn Fn(&str, ContextMenuParams, ContextMenuDone) -> bool + Send + Sync;

static HANDLER: OnceLock<Box<Handler>> = OnceLock::new();

/// Installs the process-wide context menu handler. Only the first call counts;
/// a later one is ignored.
///
/// `handler` runs on the CEF UI thread for every webview's context menu, with the
/// webview's label. Return `true` to take the menu over: Chrome's menu is not
/// shown and the app must eventually call [`ContextMenuDone::cancel`] (later, from
/// any thread, is fine). Return `false` to keep the runtime's filtered Chrome menu.
pub fn set_context_menu_handler(
  handler: impl Fn(&str, ContextMenuParams, ContextMenuDone) -> bool + Send + Sync + 'static,
) {
  let _ = HANDLER.set(Box::new(handler));
}

fn media_type_name(params: &CefContextMenuParams) -> Option<String> {
  let kind = params.media_type();
  [
    (ContextMenuMediaType::IMAGE, "image"),
    (ContextMenuMediaType::VIDEO, "video"),
    (ContextMenuMediaType::AUDIO, "audio"),
    (ContextMenuMediaType::CANVAS, "canvas"),
    (ContextMenuMediaType::FILE, "file"),
    (ContextMenuMediaType::PLUGIN, "plugin"),
  ]
  .into_iter()
  .find(|(candidate, _)| *candidate == kind)
  .map(|(_, name)| name.to_string())
}

fn convert(params: &CefContextMenuParams) -> ContextMenuParams {
  let flags: sys::cef_context_menu_edit_state_flags_t = params.edit_state_flags().into();
  let has = |flag: sys::cef_context_menu_edit_state_flags_t| flags.0 & flag.0 != 0;
  let mut suggestions = CefStringList::new();
  params.dictionary_suggestions(Some(&mut suggestions));
  let src_url = CefString::from(&params.source_url()).to_string();

  ContextMenuParams {
    x: params.xcoord(),
    y: params.ycoord(),
    is_editable: params.is_editable() != 0,
    selection_text: CefString::from(&params.selection_text()).to_string(),
    misspelled_word: CefString::from(&params.misspelled_word()).to_string(),
    dictionary_suggestions: suggestions.into_iter().collect(),
    media_type: media_type_name(params),
    src_url: (!src_url.is_empty()).then_some(src_url),
    edit_flags: EditFlags {
      can_undo: has(sys::cef_context_menu_edit_state_flags_t::CM_EDITFLAG_CAN_UNDO),
      can_redo: has(sys::cef_context_menu_edit_state_flags_t::CM_EDITFLAG_CAN_REDO),
      can_cut: has(sys::cef_context_menu_edit_state_flags_t::CM_EDITFLAG_CAN_CUT),
      can_copy: has(sys::cef_context_menu_edit_state_flags_t::CM_EDITFLAG_CAN_COPY),
      can_paste: has(sys::cef_context_menu_edit_state_flags_t::CM_EDITFLAG_CAN_PASTE),
      can_delete: has(sys::cef_context_menu_edit_state_flags_t::CM_EDITFLAG_CAN_DELETE),
      can_select_all: has(sys::cef_context_menu_edit_state_flags_t::CM_EDITFLAG_CAN_SELECT_ALL),
    },
  }
}

/// Offers the menu to the installed handler. True when the app took it over.
pub(crate) fn run(
  label: &str,
  params: &CefContextMenuParams,
  callback: &RunContextMenuCallback,
) -> bool {
  let Some(handler) = HANDLER.get() else {
    return false;
  };
  let declined = Arc::new(AtomicBool::new(false));
  let done = ContextMenuDone {
    callback: Some(callback.clone()),
    declined: declined.clone(),
  };
  let taken = handler(label, convert(params), done);
  if !taken {
    declined.store(true, Ordering::Release);
  }
  taken
}
