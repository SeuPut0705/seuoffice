//! `apps/shell/src/main/generate/title-bar.ts`: the generate window's own
//! title band on Windows and Linux.

use jscompat::JsNum;

use crate::shell::title_bar_overlay::TitleBarOverlay;

/// The height of the generate window's own title band; it must match
/// `.gen-head`'s height in generate.css.
pub const GENERATE_TITLE_BAR_HEIGHT: f64 = 44.0;

/// Overlay colors from tokens.css: `--surface` and `--text` in each theme.
pub fn generate_title_bar_overlay(dark: bool) -> TitleBarOverlay {
    let height = JsNum(GENERATE_TITLE_BAR_HEIGHT);
    if dark {
        TitleBarOverlay {
            color: "#1e1e1e",
            symbol_color: "#e4e4e4",
            height,
        }
    } else {
        TitleBarOverlay {
            color: "#ffffff",
            symbol_color: "#242424",
            height,
        }
    }
}
