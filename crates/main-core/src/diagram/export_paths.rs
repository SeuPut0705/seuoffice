//! `apps/diagram/src/main/export-paths.ts`: file names of picture exports.
//!
//! `safeFileNameBase` of `apps/diagram/src/shared/formats.ts` is ported here.
//! A name cut by `slice(0, 80)` in the middle of a surrogate pair keeps a lone
//! surrogate in JavaScript; here it is U+FFFD (see `jscompat::slice_utf16`).

use jscompat::node_path::host::{basename, dirname, extname, join};
use jscompat::{js_regex, number_to_string, slice_utf16, trim};

/// A file name base made safe for every file system (`undefined` is `''`).
fn safe_file_name_base(name: Option<&str>) -> String {
    let replaced =
        js_regex!(r#"[/\\:*?"<>|]"#, "g").replace_all(name.unwrap_or(""), |_| "_".to_owned());
    trim(&slice_utf16(&replaced, 0.0, Some(80.0))).to_owned()
}

/// Where the pictures of an export go: one file per page,
/// `<base>-p<n>.<ext>` beside the chosen file; one page picked is the chosen
/// file itself.
pub fn page_file_paths(
    chosen: &str,
    ext: &str,
    page_numbers: &[f64],
    per_page: bool,
) -> Vec<String> {
    if !per_page && page_numbers.len() == 1 {
        return vec![chosen.to_owned()];
    }
    let dir = dirname(chosen);
    let mut base = basename(chosen, None);
    if extname(&base).to_lowercase() == format!(".{ext}") {
        base = slice_utf16(&base, 0.0, Some(-(ext.encode_utf16().count() as f64) - 1.0));
    }
    let mut base = safe_file_name_base(Some(&base));
    if base.is_empty() {
        base = "diagram".to_owned();
    }
    page_numbers
        .iter()
        .map(|n| join(&[&dir, &format!("{base}-p{}.{ext}", number_to_string(*n))]))
        .collect()
}
