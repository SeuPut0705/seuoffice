//! `apps/shell/src/main/window-background.ts`.

/// Native window background shown until the renderer paints its first frame
/// (light).
pub const SHELL_BACKGROUND_LIGHT: &str = "#ffffff";
/// the same, dark
pub const SHELL_BACKGROUND_DARK: &str = "#1e1e1e";

/// `shellWindowBackground`
pub fn shell_window_background(dark: bool) -> &'static str {
    if dark {
        SHELL_BACKGROUND_DARK
    } else {
        SHELL_BACKGROUND_LIGHT
    }
}
