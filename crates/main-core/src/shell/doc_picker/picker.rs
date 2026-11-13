//! The id check of `apps/shell/src/main/doc-picker/doc-picker-window.ts`: what
//! the person ticked, held against the list the window last read.

use std::collections::HashSet;

use super::{DocItemState, DocListItem};

/// the plan caps one attach at 20 documents; ids past it are ignored
const MAX_PICKS: usize = 20;
/// a path (the only id an attachable item carries) is longer than a Drive file id
const MAX_ID_LENGTH: usize = 4096;

/// `pathsOf(raw, items)`: keeps only the ids that were in the list just handed
/// out with state `ok` and maps each to its path (a path-id maps to itself).
/// Anything else (not a string, too long, unknown, missing, unsaved, modified)
/// is silently dropped. `raw` is `None` when what the renderer sent is not an
/// array, and an entry is `None` when it is not a string.
pub fn paths_of(raw: Option<&[Option<&str>]>, items: Option<&[DocListItem]>) -> Vec<String> {
    let (Some(raw), Some(items)) = (raw, items) else {
        return Vec::new();
    };
    let attachable: HashSet<&str> = items
        .iter()
        .filter(|item| item.state == DocItemState::Ok)
        .map(|item| item.id.as_str())
        .collect();
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for id in raw.iter().take(MAX_PICKS) {
        let Some(id) = id else {
            continue;
        };
        if id.encode_utf16().count() > MAX_ID_LENGTH {
            continue;
        }
        if !attachable.contains(id) || !seen.insert(id) {
            continue;
        }
        out.push((*id).to_owned());
    }
    out
}
