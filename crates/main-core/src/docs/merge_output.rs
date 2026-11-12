//! `apps/docs/src/main/merge-output.ts`: where a merged document is written.

use jscompat::node_path::host::join;
use jscompat::{js_regex, trim};
use std::path::Path;

/// The name a merged document is written under, as a `.docx` file name: only
/// the last part of what the renderer sent.
pub fn merge_output_file_name(name: &str) -> String {
    let last = js_regex!(r"[\\/]").split(name).pop().unwrap_or("");
    let replaced = js_regex!(r#"[\\/:*?"<>|]"#, "g").replace_all(last, |_| "_".to_owned());
    let base = trim(&replaced);
    let safe = if base.is_empty() || base == "." || base == ".." {
        "document"
    } else {
        base
    };
    if safe.to_lowercase().ends_with(".docx") {
        safe.to_owned()
    } else {
        format!("{safe}.docx")
    }
}

/// A free path inside `dir` for that name: name.docx, name-2.docx, name-3.docx...
pub fn merge_output_path(dir: &str, name: &str) -> String {
    let file_name = merge_output_file_name(name);
    // the dot is one character wherever it is counted
    let dot = file_name.rfind('.').filter(|at| *at > 0);
    let base = dot.map_or(file_name.as_str(), |at| &file_name[..at]);
    let ext = dot.map_or("", |at| &file_name[at..]);
    let mut candidate = join(&[dir, &file_name]);
    let mut i = 2u64;
    while Path::new(&candidate).exists() {
        candidate = join(&[dir, &format!("{base}-{i}{ext}")]);
        i += 1;
    }
    candidate
}
