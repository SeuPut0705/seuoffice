//! `apps/shell/src/main/title-bar-overlay.ts`.

use jscompat::math_round;
use serde::Serialize;

/// `TAB_STRIP_HEIGHT` of `apps/shell/src/shared/tab-drag-geometry.ts`
const TAB_STRIP_HEIGHT: f64 = 40.0;

/// `tabStripHeight(scale)` of the same file: the strip's rendered height at
/// an interface scale.
fn tab_strip_height(scale: f64) -> f64 {
    math_round(TAB_STRIP_HEIGHT * scale)
}

/// Electron's `TitleBarOverlay` as `tabStripOverlay` writes it: the keys in
/// the order of the literals. `height` is a JavaScript number (NaN prints as
/// `null`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TitleBarOverlay {
    pub color: &'static str,
    #[serde(rename = "symbolColor")]
    pub symbol_color: &'static str,
    pub height: jscompat::JsNum,
}

/// `tabStripOverlay(dark, uiScale = 1)`
pub fn tab_strip_overlay(dark: bool, ui_scale: f64) -> TitleBarOverlay {
    let height = jscompat::JsNum(tab_strip_height(ui_scale));
    if dark {
        TitleBarOverlay {
            color: "#2a2a2a",
            symbol_color: "#e4e4e4",
            height,
        }
    } else {
        TitleBarOverlay {
            color: "#ebebeb",
            symbol_color: "#454746",
            height,
        }
    }
}
