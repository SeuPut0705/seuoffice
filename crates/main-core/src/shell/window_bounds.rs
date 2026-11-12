//! `apps/shell/src/main/window-bounds.ts`: the shell window's geometry across
//! sessions. The decisions are here; the timers of
//! `installShellWindowBoundsPersistence` and the events of the window belong
//! to the shell, which calls [`ShellWindowBoundsPersistence::settle`] when
//! `WINDOW_BOUNDS_SETTLE_MS` of rest follow an event and
//! [`ShellWindowBoundsPersistence::save`] when
//! `WINDOW_BOUNDS_SAVE_DEBOUNCE_MS` do, or the window closes.

use jscompat::{JsObject, JsonValue, math_max, math_min, math_round};

use super::app_settings::{read_app_settings, write_app_setting};
use crate::node_fs::NodeError;

/// `WINDOW_BOUNDS_KEY`
pub const WINDOW_BOUNDS_KEY: &str = "windowBounds";

pub const SHELL_WINDOW_DEFAULT_WIDTH: f64 = 1360.0;
pub const SHELL_WINDOW_DEFAULT_HEIGHT: f64 = 900.0;
pub const SHELL_WINDOW_MIN_WIDTH: f64 = 720.0;
pub const SHELL_WINDOW_MIN_HEIGHT: f64 = 550.0;

const MAX_DIMENSION: f64 = 8192.0;
const MIN_VISIBLE_WIDTH: f64 = 120.0;
const MIN_VISIBLE_STRIP_HEIGHT: f64 = 12.0;
const TITLE_STRIP_HEIGHT: f64 = 40.0;

pub const WINDOW_BOUNDS_SAVE_DEBOUNCE_MS: f64 = 500.0;
pub const WINDOW_BOUNDS_SETTLE_MS: f64 = 100.0;

/// `WindowRect`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WindowRect {
    /// `{ x, y, width, height }`
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("x", JsonValue::Number(self.x));
        object.set("y", JsonValue::Number(self.y));
        object.set("width", JsonValue::Number(self.width));
        object.set("height", JsonValue::Number(self.height));
        JsonValue::Object(object)
    }
}

/// `ShellWindowState`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShellWindowState {
    pub rect: WindowRect,
    pub maximized: bool,
}

impl ShellWindowState {
    /// `{ x, y, width, height, maximized }`
    pub fn to_json(&self) -> JsonValue {
        let JsonValue::Object(mut object) = self.rect.to_json() else {
            unreachable!("a rectangle is an object")
        };
        object.set("maximized", JsonValue::Bool(self.maximized));
        JsonValue::Object(object)
    }
}

fn same_rect(a: &WindowRect, b: &WindowRect) -> bool {
    a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height
}

/// `isFiniteNumber(value)` and the number
fn finite_number(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

/// `parseShellWindowState(value)`
pub fn parse_shell_window_state(value: Option<&JsonValue>) -> Option<ShellWindowState> {
    // an array is an object too, and has none of the four numbers
    let record = value.filter(|v| matches!(v, JsonValue::Object(_) | JsonValue::Array(_)))?;
    let x = finite_number(record.get("x").as_deref())?;
    let y = finite_number(record.get("y").as_deref())?;
    let width = finite_number(record.get("width").as_deref())?;
    let height = finite_number(record.get("height").as_deref())?;
    let state = ShellWindowState {
        rect: WindowRect {
            x: math_round(x),
            y: math_round(y),
            width: math_round(width),
            height: math_round(height),
        },
        maximized: record.get("maximized").as_deref() == Some(&JsonValue::Bool(true)),
    };
    if state.rect.width < SHELL_WINDOW_MIN_WIDTH || state.rect.height < SHELL_WINDOW_MIN_HEIGHT {
        return None;
    }
    if state.rect.width > MAX_DIMENSION || state.rect.height > MAX_DIMENSION {
        return None;
    }
    Some(state)
}

/// `isShellWindowVisible(state, workAreas)`
pub fn is_shell_window_visible(state: &WindowRect, work_areas: &[WindowRect]) -> bool {
    let strip = math_min(state.height, TITLE_STRIP_HEIGHT);
    work_areas.iter().any(|area| {
        let overlap_width =
            math_min(state.x + state.width, area.x + area.width) - math_max(state.x, area.x);
        let overlap_height =
            math_min(state.y + strip, area.y + area.height) - math_max(state.y, area.y);
        overlap_width >= MIN_VISIBLE_WIDTH
            && overlap_height >= math_min(strip, MIN_VISIBLE_STRIP_HEIGHT)
    })
}

/// `readShellWindowState(settingsPath, workAreas)`
pub fn read_shell_window_state(
    settings_path: &str,
    work_areas: &[WindowRect],
) -> Option<ShellWindowState> {
    let settings = read_app_settings(settings_path);
    let parsed = parse_shell_window_state(settings.get(WINDOW_BOUNDS_KEY))?;
    is_shell_window_visible(&parsed.rect, work_areas).then_some(parsed)
}

/// `ShellWindowTarget`
pub trait ShellWindowTarget {
    fn set_content_bounds(&mut self, bounds: WindowRect);
    fn get_content_bounds(&self) -> WindowRect;
    fn maximize(&mut self);
}

/// `applyShellWindowState(win, state)`: the baseline, `None` (null) when
/// there was no state to apply.
pub fn apply_shell_window_state(
    win: &mut impl ShellWindowTarget,
    state: Option<&ShellWindowState>,
) -> Option<WindowRect> {
    let state = state?;
    win.set_content_bounds(state.rect);
    let bounds = win.get_content_bounds();
    if state.maximized {
        win.maximize();
    }
    Some(bounds)
}

/// `ShellWindowLaunch`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShellWindowLaunch {
    pub restored: Option<ShellWindowState>,
    pub baseline: Option<WindowRect>,
}

/// `ShellWindowSource` and what `installShellWindowBoundsPersistence` asks
/// of the window besides (`isDestroyed`). `isMinimized` and `isFullScreen`
/// are optional there.
pub trait ShellWindowSource {
    fn is_maximized(&self) -> bool;
    fn is_minimized(&self) -> bool {
        false
    }
    fn is_full_screen(&self) -> bool {
        false
    }
    fn get_content_bounds(&self) -> WindowRect;
    fn is_destroyed(&self) -> bool;
}

/// `writeShellWindowState(settingsPath, state)`
pub fn write_shell_window_state(
    settings_path: &str,
    state: &ShellWindowState,
) -> Result<(), NodeError> {
    let mut object = JsObject::new();
    object.set("x", JsonValue::Number(math_round(state.rect.x)));
    object.set("y", JsonValue::Number(math_round(state.rect.y)));
    object.set(
        "width",
        JsonValue::Number(math_max(
            SHELL_WINDOW_MIN_WIDTH,
            math_round(state.rect.width),
        )),
    );
    object.set(
        "height",
        JsonValue::Number(math_max(
            SHELL_WINDOW_MIN_HEIGHT,
            math_round(state.rect.height),
        )),
    );
    object.set("maximized", JsonValue::Bool(state.maximized));
    write_app_setting(
        settings_path,
        WINDOW_BOUNDS_KEY,
        Some(JsonValue::Object(object)),
    )
}

/// The state `installShellWindowBoundsPersistence` closes over.
#[derive(Debug, Clone, PartialEq)]
pub struct ShellWindowBoundsPersistence {
    launch: ShellWindowLaunch,
    /// the normal-state content rectangle last seen
    normal: Option<WindowRect>,
    maximized: bool,
}

impl ShellWindowBoundsPersistence {
    /// The setup of `installShellWindowBoundsPersistence`, up to the first
    /// `observe()`.
    pub fn install(launch: ShellWindowLaunch, win: &impl ShellWindowSource) -> Self {
        let mut persistence = ShellWindowBoundsPersistence {
            launch,
            normal: launch.baseline,
            maximized: launch.restored.is_some_and(|restored| restored.maximized),
        };
        persistence.observe(win);
        persistence
    }

    /// `observe()`
    pub fn observe(&mut self, win: &impl ShellWindowSource) {
        if win.is_minimized() {
            return;
        }
        self.maximized = win.is_maximized();
        if self.maximized || win.is_full_screen() {
            return;
        }
        self.normal = Some(win.get_content_bounds());
    }

    /// The settle timer's callback.
    pub fn settle(&mut self, win: &impl ShellWindowSource) {
        if !win.is_destroyed() {
            self.observe(win);
        }
    }

    /// `save()`; `warn` gets the message of a failed write (the
    /// `console.warn` of the TypeScript).
    pub fn save(
        &mut self,
        settings_path: &str,
        win: &impl ShellWindowSource,
        warn: impl FnOnce(&NodeError),
    ) {
        if win.is_destroyed() {
            return;
        }
        self.observe(win);
        let Some(normal) = self.normal else { return };
        let rect = match (self.launch.restored, self.launch.baseline) {
            (Some(restored), Some(baseline)) if same_rect(&normal, &baseline) => restored.rect,
            _ => normal,
        };
        if let Err(error) = write_shell_window_state(
            settings_path,
            &ShellWindowState {
                rect,
                maximized: self.maximized,
            },
        ) {
            warn(&error);
        }
    }
}
