//! `apps/shell/src/main/ui-scale.ts`: the interface scale, the user's "make
//! the UI bigger" preference.
//!
//! The scale lands on one CSS custom property written into every live
//! renderer. The webContents are [`StyleTarget`]s, the module-level
//! `changeListeners` set is a [`UiScale`] the caller owns, and
//! `webContents.getAllWebContents()` is a closure asked when the TypeScript
//! asks it.

use std::rc::Rc;

use jscompat::{JsonValue, math_max, math_min, number_to_string};

use crate::node_fs::NodeError;
use crate::shell::app_settings::{read_app_settings, write_app_setting};

/// `app-settings.json` key; absent or 1 means "no scaling"
pub const UI_SCALE_KEY: &str = "uiScale";

/// Presets offered by the View menu.
pub const UI_SCALE_STEPS: [f64; 4] = [1.0, 1.1, 1.25, 1.5];

pub const UI_SCALE_MIN: f64 = UI_SCALE_STEPS[0];
pub const UI_SCALE_MAX: f64 = UI_SCALE_STEPS[UI_SCALE_STEPS.len() - 1];

/// The part of a `WebContents` the style calls use.
pub trait StyleTarget {
    fn is_destroyed(&self) -> bool;
    /// `contents.executeJavaScript(script)`: an `Err` is a rejection
    fn execute_javascript(&self, script: &str) -> Result<(), String>;
}

/// `readUiScale`: the stored value, clamped into range; anything unreadable,
/// non-finite, or out of range falls back to 1
pub fn read_ui_scale(settings_path: &str) -> f64 {
    match read_app_settings(settings_path).get(UI_SCALE_KEY) {
        Some(JsonValue::Number(stored)) if stored.is_finite() => clamp_ui_scale(*stored),
        _ => UI_SCALE_MIN,
    }
}

/// `clampUiScale`
pub fn clamp_ui_scale(scale: f64) -> f64 {
    math_min(UI_SCALE_MAX, math_max(UI_SCALE_MIN, scale))
}

/// `stepUiScale`: the next preset above (1) or below (-1) `scale`, clamped at
/// the ends
pub fn step_ui_scale(scale: f64, direction: i32) -> f64 {
    let index = UI_SCALE_STEPS.iter().position(|step| *step >= scale - 1e-9);
    let last = UI_SCALE_STEPS.len() as i32 - 1;
    let from = index.map_or(last, |i| i as i32);
    let at = (from + direction).max(0).min(last);
    UI_SCALE_STEPS
        .get(at as usize)
        .copied()
        .unwrap_or(UI_SCALE_MIN)
}

/// the script `applyUiScaleTo` runs
pub fn ui_scale_script(scale: f64) -> String {
    format!(
        "document.documentElement.style.setProperty('--ui-scale', '{}')",
        number_to_string(clamp_ui_scale(scale))
    )
}

/// `applyUiScaleTo`: write the scale into a renderer's `:root`
pub fn apply_ui_scale_to(contents: &dyn StyleTarget, scale: f64) {
    if contents.is_destroyed() {
        return;
    }
    // a renderer torn down mid-call has nothing left to style
    let _ = contents.execute_javascript(&ui_scale_script(scale));
}

/// `applyUiScaleToAll`; `all` is `webContents.getAllWebContents()`
pub fn apply_ui_scale_to_all(all: &dyn Fn() -> Vec<Rc<dyn StyleTarget>>, scale: f64) {
    for contents in all() {
        if contents.is_destroyed() {
            continue;
        }
        apply_ui_scale_to(contents.as_ref(), scale);
    }
}

/// `const changeListeners = new Set<(scale: number) => void>()`
#[derive(Default)]
pub struct UiScale {
    change_listeners: Vec<Box<dyn FnMut(f64)>>,
}

impl UiScale {
    pub fn new() -> Self {
        Self::default()
    }

    /// `onUiScaleChanged`: what has to happen when the scale changes
    pub fn on_ui_scale_changed(&mut self, listener: Box<dyn FnMut(f64)>) {
        self.change_listeners.push(listener);
    }

    /// `setUiScale`: persist first, then apply, then the listeners
    pub fn set_ui_scale(
        &mut self,
        settings_path: &str,
        scale: f64,
        all: &dyn Fn() -> Vec<Rc<dyn StyleTarget>>,
    ) -> Result<f64, NodeError> {
        let next = clamp_ui_scale(scale);
        write_app_setting(settings_path, UI_SCALE_KEY, Some(JsonValue::Number(next)))?;
        apply_ui_scale_to_all(all, next);
        for listener in &mut self.change_listeners {
            listener(next);
        }
        Ok(next)
    }

    /// `changeUiScale`: `0` resets; `1` / `-1` step through the presets
    pub fn change_ui_scale(
        &mut self,
        settings_path: &str,
        direction: i32,
        all: &dyn Fn() -> Vec<Rc<dyn StyleTarget>>,
    ) -> Result<f64, NodeError> {
        if direction == 0 {
            return self.set_ui_scale(settings_path, UI_SCALE_MIN, all);
        }
        let stepped = step_ui_scale(read_ui_scale(settings_path), direction);
        self.set_ui_scale(settings_path, stepped, all)
    }
}
