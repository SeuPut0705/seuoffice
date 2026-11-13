//! `apps/hwp/src/main/memos.ts` (`lostMemoCountOf`) and the memo list a
//! save carries (`memoSnapshotsOf`, `memoPathOf`, `commitOptionsOf` of
//! hwp-main.ts). The engine's own reading of memos (`hwpMemosOf`) is
//! [`HwpEngine::hwp_memos_of`].

use std::collections::HashMap;

use main_core::hwp::tab_widths::hwpx_memo_count_of;
use shell_contract::IpcValue;

use super::{HwpEngine, HwpMemo};
use crate::kit::{as_num, as_str, field};

/// `MemoSnapshot`: what identifies a memo across a save (the anchor fields
/// are checked for their shape only, as the TypeScript does)
#[derive(Clone, Debug, PartialEq)]
pub(super) struct MemoSnapshot {
    pub author: String,
    pub date: Option<String>,
    pub text: String,
    pub place: String,
}

/// `commitOptionsOf(raw).memos`: absent, null, or the list (`None` inside
/// when it is not the shape main can compare)
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Memos {
    Absent,
    Null,
    List(Option<Vec<MemoSnapshot>>),
}

/// `commitOptionsOf(raw)`
pub(super) fn commit_options_of(raw: &IpcValue) -> (bool, Memos) {
    let is_object = matches!(raw, IpcValue::Object(_));
    let get = |key: &str| {
        if is_object {
            field(raw, key)
        } else {
            &IpcValue::Undefined
        }
    };
    let memos = match get("memos") {
        IpcValue::Undefined => Memos::Absent,
        IpcValue::Null => Memos::Null,
        list => Memos::List(memo_snapshots_of(list)),
    };
    (matches!(get("auto"), IpcValue::Bool(true)), memos)
}

/// `memoPathOf(value) !== null` for a value that is there. The steps are
/// only validated: what the save compares does not include them.
fn memo_path_ok(value: &IpcValue) -> bool {
    let IpcValue::Array(steps) = value else {
        return false;
    };
    steps.iter().all(|step| {
        matches!(step, IpcValue::Object(_))
            && matches!(as_str(field(step, "type")), Some("cell" | "textbox"))
            && as_num(field(step, "controlIndex")).is_some()
            && as_num(field(step, "paraIndex")).is_some()
    })
}

/// `memoSnapshotsOf(value)`: the editor's memo list, or `None` when it is
/// not the shape main can compare
fn memo_snapshots_of(value: &IpcValue) -> Option<Vec<MemoSnapshot>> {
    let IpcValue::Array(items) = value else {
        return None;
    };
    let mut memos = Vec::new();
    for item in items {
        if !matches!(item, IpcValue::Object(_)) {
            return None;
        }
        let author = as_str(field(item, "author"))?;
        let text = as_str(field(item, "text"))?;
        let place = as_str(field(item, "place"))?;
        let date = match field(item, "date") {
            IpcValue::Null => None,
            IpcValue::String(s) => Some(s.clone()),
            _ => return None,
        };
        // `path: memoPathOf(raw.path)`: a bad path is null, not a bad list
        let _ = memo_path_ok(field(item, "path"));
        memos.push(MemoSnapshot {
            author: author.to_owned(),
            date,
            text: text.to_owned(),
            place: place.to_owned(),
        });
    }
    Some(memos)
}

type Identity = (String, String, String, String);

/// `identityOf(memo)`: the note and who wrote it, without the anchor
fn identity_of(memo: &HwpMemo) -> Identity {
    let f = |v: &Option<String>| v.clone().unwrap_or_default();
    (
        f(&memo.author),
        f(&memo.date),
        f(&memo.text),
        f(&memo.place),
    )
}

fn snapshot_identity(memo: &MemoSnapshot) -> Identity {
    (
        memo.author.clone(),
        memo.date.clone().unwrap_or_default(),
        memo.text.clone(),
        memo.place.clone(),
    )
}

/// `missingFrom(wanted, saved)`: each memo counted once
fn missing_from(wanted: &[MemoSnapshot], saved: &[HwpMemo]) -> usize {
    let mut left: HashMap<Identity, usize> = HashMap::new();
    for memo in saved {
        *left.entry(identity_of(memo)).or_default() += 1;
    }
    let mut missing = 0;
    for memo in wanted {
        match left.get_mut(&snapshot_identity(memo)) {
            Some(count) if *count > 0 => *count -= 1,
            _ => missing += 1,
        }
    }
    missing
}

/// `lostMemoCountOf({ saved, original, memos })`: how many memos of an HWPX
/// save did not make it into the written bytes. A failure reads as none lost.
pub(super) fn lost_memo_count_of(
    engine: &dyn HwpEngine,
    saved: &[u8],
    original: Option<&[u8]>,
    memos: Option<&[MemoSnapshot]>,
) -> usize {
    if memos.map_or(0, <[_]>::len) == 0 && original.is_none() {
        return 0;
    }
    let count = || -> Result<usize, String> {
        let original_raw = original.and_then(hwpx_memo_count_of);
        if memos.is_some_and(<[_]>::is_empty) && original_raw == Some(0) {
            return Ok(0);
        }
        let saved_model = engine.hwp_memos_of(saved)?;
        let model_lost = memos.map_or(0, |m| missing_from(m, &saved_model));
        let Some(original) = original else {
            return Ok(model_lost);
        };
        let original_model = engine.hwp_memos_of(original)?;
        let saved_raw = hwpx_memo_count_of(saved);
        let (Some(original_raw), Some(saved_raw)) = (original_raw, saved_raw) else {
            return Ok(model_lost);
        };
        let before = original_raw.saturating_sub(original_model.len());
        let after = saved_raw.saturating_sub(saved_model.len());
        Ok(model_lost + before.saturating_sub(after))
    };
    count().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kit::{IntoIpc, obj};

    fn memo(author: &str, text: &str) -> IpcValue {
        obj([
            ("author", author.into_ipc()),
            ("date", IpcValue::Null),
            ("text", text.into_ipc()),
            ("place", "body".into_ipc()),
        ])
    }

    #[test]
    fn options_read_auto_and_the_memo_list_by_shape() {
        let raw = obj([
            ("auto", true.into_ipc()),
            ("memos", IpcValue::Array(vec![memo("a", "x")])),
        ]);
        let (auto, memos) = commit_options_of(&raw);
        assert!(auto);
        assert_eq!(
            memos,
            Memos::List(Some(vec![MemoSnapshot {
                author: "a".into(),
                date: None,
                text: "x".into(),
                place: "body".into(),
            }]))
        );
        // a memo without its text makes the list unusable, not the save
        let bad = obj([(
            "memos",
            IpcValue::Array(vec![obj([("author", "a".into_ipc())])]),
        )]);
        assert_eq!(commit_options_of(&bad), (false, Memos::List(None)));
        assert_eq!(
            commit_options_of(&obj([("memos", IpcValue::Null)])),
            (false, Memos::Null)
        );
        assert_eq!(
            commit_options_of(&"auto".into_ipc()),
            (false, Memos::Absent)
        );
    }

    #[test]
    fn a_listed_memo_missing_from_the_saved_file_counts_once() {
        let saved = super::super::fake::FakeEngine::new(&serde_json::json!({
            "hwp_memos_of": [[{ "author": "a", "text": "x", "place": "body" }]],
        }));
        let wanted = |text: &str| MemoSnapshot {
            author: "a".into(),
            date: None,
            text: text.into(),
            place: "body".into(),
        };
        assert_eq!(
            lost_memo_count_of(&saved, b"", None, Some(&[wanted("x")])),
            0
        );
        assert_eq!(
            lost_memo_count_of(&saved, b"", None, Some(&[wanted("x"), wanted("x")])),
            1
        );
        // nothing listed and no original: nothing is read
        assert_eq!(lost_memo_count_of(&saved, b"", None, Some(&[])), 0);
    }
}
