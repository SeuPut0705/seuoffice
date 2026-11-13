//! `apps/shell/src/main/projects/visibility.ts`: whether a folder-relative
//! path is a file the AI may see (spec 5.5, 5.9): it stays inside the folder
//! (no `..`, not absolute), no segment is a hidden entry by the home tree's
//! rule (dot names, `~$` lock files, OS junk, the Markdown app-owned
//! `assets/` folder), it is not under the data folder (by any name it has
//! had), it is not a file a save puts beside a document (the staging temp, a
//! failed save's rescue copy), and `ignore` does not match it. Paths are not
//! resolved here; callers that touch the disk also check links (the read tool
//! resolves the real path).

use jscompat::RegexLimit;
use jscompat::node_path::host::{is_absolute, join};

use super::folder_files::is_data_dir_name;
use super::ignore::IgnoreMatcher;
use crate::packages::electron_utils::atomic_write::is_save_temp_name;
use crate::shell::projects::stand_ins::is_hidden_entry;

/// `isAiVisiblePath(root, relPath, matcher, isDir)`; `isDir` is `false` where
/// the TypeScript leaves it out. `Err` is a search of `ignore` that reached
/// the backtrack bound.
pub fn is_ai_visible_path(
    root: &str,
    rel_path: &str,
    matcher: &IgnoreMatcher,
    is_dir: bool,
) -> Result<bool, RegexLimit> {
    let mut chars = rel_path.chars();
    let first = chars.next();
    // `!relPath || isAbsolute(relPath) || /^[\\/]/.test(relPath) || /^[A-Za-z]:/.test(relPath)`
    if first.is_none()
        || is_absolute(rel_path)
        || matches!(first, Some('\\' | '/'))
        || (first.is_some_and(|c| c.is_ascii_alphabetic()) && chars.next() == Some(':'))
    {
        return Ok(false);
    }
    let segments: Vec<&str> = rel_path
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty() {
        return Ok(false);
    }
    let mut dir = root.to_owned();
    for (index, name) in segments.iter().enumerate() {
        if *name == "." || *name == ".." {
            return Ok(false);
        }
        if index == 0 && is_data_dir_name(name) {
            return Ok(false);
        }
        let segment_is_dir = index < segments.len() - 1 || is_dir;
        if is_hidden_entry(&dir, name, segment_is_dir) {
            return Ok(false);
        }
        // a save's own files carry no leading dot (it would stick to the saved
        // document on an SMB share), so the dot rule above no longer covers them
        if !segment_is_dir && is_save_temp_name(name) {
            return Ok(false);
        }
        dir = join(&[&dir, name]);
    }
    Ok(!matcher.ignores(&segments.join("/"), is_dir)?)
}
