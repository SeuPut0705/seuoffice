//! The text of runs (`w:t`, `w:br` and their kin) and the leaf readers of
//! paragraphs, runs and styles.

mod build_block;
mod build_run;
mod build_run_old;
mod context;
mod controls;
mod convert;
mod extract_runs;
mod format;
mod lists;
mod math;
pub mod notes_part;
mod paragraph;
mod paragraph_block;
mod runs;
mod toc;

pub use build_block::*;
pub use build_run::*;
pub use context::*;
pub use controls::*;
pub use convert::*;
pub use extract_runs::*;
pub use format::*;
pub use lists::*;
pub use math::*;
pub use notes_part::*;
pub use paragraph::*;
pub use paragraph_block::*;
pub use runs::*;
pub use toc::*;

use jscompat::math_round;

use crate::xml_text::EMU_PER_PX;

/// `emuToPx`: picture extents keep the authored size to 1/100 px.
pub fn emu_to_px(emu: f64) -> f64 {
    math_round((emu / EMU_PER_PX) * 100.0) / 100.0
}

/// `breakCharOf`: a `w:br` that clears floats travels as U+001E, a page break
/// as a form feed, a column break as a vertical tab, any other as `\n`.
pub fn break_char_of(clear: Option<&str>, kind: Option<&str>) -> char {
    if clear.is_some_and(|clear| !clear.is_empty()) {
        return '\u{1e}';
    }
    match kind {
        Some("page") => '\u{c}',
        Some("column") => '\u{b}',
        _ => '\n',
    }
}

/// `wtText`: a line break inside `w:t` is a space; without `xml:space="preserve"`
/// the leading and trailing spaces and tabs go and a tab is a space.
pub fn wt_text(raw: &str, preserve: bool) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                text.push(' ');
            }
            '\n' => text.push(' '),
            c => text.push(c),
        }
    }
    if preserve {
        return text;
    }
    text.trim_matches([' ', '\t']).replace('\t', " ")
}
