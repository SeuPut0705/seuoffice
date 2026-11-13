//! Experiment for assumption 1 of the port decision: see README.md.
//!
//! `container` and the items here are shared by both ways. `way_a` and
//! `way_b` are the two designs under test. `probe` and `classify` belong to
//! the measurement: they read the original and the saved XML with a plain
//! tag walk, so neither way checks itself.

pub mod classify;
pub mod container;
pub mod probe;
pub mod way_a;
pub mod way_b;

/// The edit both ways perform: in body element `paragraph` (an index into
/// `docx_engine::scan::scan_body` elements, a `w:p`), the run at `run` among
/// the paragraph's runs (every `w:r` not inside another `w:r`, in document
/// order) gets `text` as the content of its one `w:t`.
#[derive(Debug, Clone, Copy)]
pub struct RunEdit<'t> {
    pub paragraph: usize,
    pub run: usize,
    pub text: &'t str,
}

pub fn escape_text(text: &str, out: &mut String) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
}

/// Leading or trailing white space that `w:t` drops without `xml:space="preserve"`.
pub fn needs_preserve(text: &str) -> bool {
    let edge = |c: Option<char>| c.is_some_and(char::is_whitespace);
    edge(text.chars().next()) || edge(text.chars().last())
}
