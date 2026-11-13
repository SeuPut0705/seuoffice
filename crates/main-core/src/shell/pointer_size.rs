//! `apps/shell/src/main/pointer-size.ts`: the size of the system mouse
//! pointer, for renderers that place things next to it.
//!
//! The webContents are [`StyleTarget`]s, the registry commands of the
//! TypeScript (`app.on(...)`) are the caller's: it calls
//! [`PointerSize::refresh`] when the shell regains focus and at start, and
//! [`PointerSize::did_finish_load`] when a webContents finished loading.

use std::rc::Rc;

use jscompat::{Radix, parse_int, to_number};

use crate::shell::default_app::parse_reg_value;
use crate::shell::mac_update::RunProgram;
use crate::shell::ui_scale::StyleTarget;

pub const POINTER_SIZE_VAR: &str = "--os-pointer-size";

const CURSORS_KEY: &str = "HKCU\\Control Panel\\Cursors";
const MIN_PX: f64 = 16.0;
const MAX_PX: f64 = 512.0;

/// `parseCursorBaseSize`: `CursorBaseSize    REG_DWORD    0x40` is 64. Anything
/// implausible is `None` (null).
pub fn parse_cursor_base_size(output: &str) -> Option<u32> {
    let value = parse_reg_value(output).filter(|v| !v.is_empty())?;
    let px = if value.starts_with("0x") {
        parse_int(&value, Radix::Sixteen)
    } else {
        to_number(&value)
    };
    // Number.isInteger
    let integer = px.is_finite() && px.trunc() == px;
    (integer && (MIN_PX..=MAX_PX).contains(&px)).then_some(px as u32)
}

/// `readPointerSize(run, platform)`: `run` is the `reg` runner, an `Err` is
/// its rejection (no such value on this machine)
pub fn read_pointer_size(run: RunProgram<'_>, platform: &str) -> Option<u32> {
    if platform != "win32" {
        return None;
    }
    let args = [
        "query".to_owned(),
        CURSORS_KEY.to_owned(),
        "/v".to_owned(),
        "CursorBaseSize".to_owned(),
    ];
    match run("reg", &args) {
        Ok(output) => parse_cursor_base_size(&output),
        // the standard pointer
        Err(_) => None,
    }
}

/// the script `applyPointerSizeTo` runs
pub fn pointer_size_script(px: u32) -> String {
    format!("document.documentElement.style.setProperty('{POINTER_SIZE_VAR}', '{px}px')")
}

/// `applyPointerSizeTo`
pub fn apply_pointer_size_to(contents: &dyn StyleTarget, px: u32) {
    if contents.is_destroyed() {
        return;
    }
    // a renderer torn down mid-call has nothing left to style
    let _ = contents.execute_javascript(&pointer_size_script(px));
}

/// `let current: number | null = null`
#[derive(Debug, Default)]
pub struct PointerSize {
    current: Option<u32>,
}

impl PointerSize {
    pub fn new() -> Self {
        Self::default()
    }

    /// `refresh`, after `readPointerSize()` answered `px`; `all` is
    /// `webContents.getAllWebContents()`, asked only when the size changed
    pub fn refresh(&mut self, px: Option<u32>, all: &dyn Fn() -> Vec<Rc<dyn StyleTarget>>) {
        if px == self.current {
            return;
        }
        self.current = px;
        let Some(px) = px else {
            return;
        };
        for contents in all() {
            apply_pointer_size_to(contents.as_ref(), px);
        }
    }

    /// the `did-finish-load` listener of a webContents
    pub fn did_finish_load(&self, contents: &dyn StyleTarget) {
        if let Some(px) = self.current {
            apply_pointer_size_to(contents, px);
        }
    }
}
