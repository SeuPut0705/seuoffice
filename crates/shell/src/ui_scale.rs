//! The interface scale (`apps/shell/src/main/ui-scale.ts`, `installUiScale`
//! of index.ts): one CSS custom property written into every page. The logic
//! is `main_core::shell::ui_scale`; this is its Tauri half: the webviews as
//! [`StyleTarget`]s, the current value for pages that load later, and the
//! hook that stamps it on each page when it finishes loading.

use std::rc::Rc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use main_core::shell::ui_scale::{StyleTarget, UiScale, read_ui_scale, ui_scale_script};
use tauri::{AppHandle, Manager, Webview};

/// `currentUiScale`, as `f64` bits
static CURRENT: AtomicU64 = AtomicU64::new(0);

static APP: OnceLock<AppHandle> = OnceLock::new();

/// `currentUiScale`: 1 before [`install`]
pub fn current() -> f64 {
    match CURRENT.load(Ordering::Relaxed) {
        0 => 1.0,
        bits => f64::from_bits(bits),
    }
}

/// `installUiScale`: reads the stored scale; pages stamp it as they load
/// ([`on_page_finished`]). No page exists yet, so nothing is applied now.
pub fn install(app: &AppHandle, settings_path: &str) {
    let _ = APP.set(app.clone());
    CURRENT.store(read_ui_scale(settings_path).to_bits(), Ordering::Relaxed);
}

/// `contents.on('did-finish-load', () => applyUiScaleTo(contents, currentUiScale))`
pub fn on_page_finished(webview: &Webview) {
    if let Err(error) = webview.eval(ui_scale_script(current())) {
        eprintln!("shell: ui scale on '{}': {error}", webview.label());
    }
}

/// A webview as `applyUiScaleTo` sees a `WebContents`
struct Page(Webview);

impl StyleTarget for Page {
    fn is_destroyed(&self) -> bool {
        self.0.app_handle().get_webview(self.0.label()).is_none()
    }

    fn execute_javascript(&self, script: &str) {
        // started and left alone: a page that went away has nothing to style
        let _ = self.0.eval(script);
    }
}

fn all_pages() -> Vec<Rc<dyn StyleTarget>> {
    let Some(app) = APP.get() else {
        return Vec::new();
    };
    app.webviews()
        .into_values()
        .map(|w| Rc::new(Page(w)) as Rc<dyn StyleTarget>)
        .collect()
}

/// `changeUiScale(settingsPath, direction)`: `0` resets, `1` and `-1` step
/// through the presets. Saved, applied to every page, then `after` runs with
/// the new scale (the tab strip moves). On the core thread.
pub fn change(settings_path: &str, direction: i32, after: impl Fn(f64) + 'static) {
    let mut scale = UiScale::new();
    scale.on_ui_scale_changed(Box::new(move |next| {
        CURRENT.store(next.to_bits(), Ordering::Relaxed);
        after(next);
    }));
    if let Err(error) = scale.change_ui_scale(settings_path, direction, &all_pages) {
        eprintln!("shell: changing the ui scale: {}", error.message);
    }
}
