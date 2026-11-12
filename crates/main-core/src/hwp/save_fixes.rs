//! `apps/hwp/src/main/save-fixes.ts`: what a save corrects against the file
//! the view opened, in order: tabs, field kinds, section tails (see AGENTS.md).
//! Both the save and the recovery copy go through here.

use std::borrow::Cow;

use serde_json::Value;

use super::field_kinds::{FieldKinds, restore_field_kinds};
use super::ipc::HwpFormat;
use super::section_tails::{RestoreSkip, SectionTails, restore_section_tails};
use super::tab_widths::write_tab_widths;

/// What a save corrects against the file the view opened: kept when the file
/// is read (section tails and field kinds of an `.hwp`), applied to what the
/// engine exports.
#[derive(Debug, Clone, Default)]
pub struct SaveBase {
    pub tails: Option<SectionTails>,
    pub kinds: Option<FieldKinds>,
}

pub struct SaveFixResult<'a> {
    pub bytes: Cow<'a, [u8]>,
    /// why master pages or memos of the opened file could not be carried over
    pub tails_skipped: Option<RestoreSkip>,
}

/// The corrections a save makes to the engine's bytes before they are written,
/// in their order: tabs, field kinds, section tails.
pub fn apply_save_fixes<'a>(
    data: &'a [u8],
    format: HwpFormat,
    tabs: Option<&[Value]>,
    base: &SaveBase,
) -> SaveFixResult<'a> {
    let mut bytes: Cow<'a, [u8]> = Cow::Borrowed(data);
    // the tabs first: their places were found in the engine's bytes, and putting the
    // tails back leaves the body of each section as it is
    if let Some(tabs) = tabs
        && !tabs.is_empty()
    {
        let next = match write_tab_widths(&bytes, format, tabs).bytes {
            Cow::Owned(written) => Some(written),
            Cow::Borrowed(_) => None,
        };
        if let Some(written) = next {
            bytes = Cow::Owned(written);
        }
    }
    let kinds = if format == HwpFormat::Hwp {
        base.kinds.as_ref()
    } else {
        None
    };
    if let Some(kinds) = kinds {
        let next = match restore_field_kinds(&bytes, kinds).bytes {
            Cow::Owned(written) => Some(written),
            Cow::Borrowed(_) => None,
        };
        if let Some(written) = next {
            bytes = Cow::Owned(written);
        }
    }
    let tails = if format == HwpFormat::Hwp {
        base.tails.as_ref()
    } else {
        None
    };
    if let Some(tails) = tails {
        let result = restore_section_tails(&bytes, tails);
        let skipped = result.skipped;
        let next = match result.bytes {
            Cow::Owned(written) => Some(written),
            Cow::Borrowed(_) => None,
        };
        if let Some(skip) = skipped {
            return SaveFixResult {
                bytes: match next {
                    Some(written) => Cow::Owned(written),
                    None => bytes,
                },
                tails_skipped: Some(skip),
            };
        }
        if let Some(written) = next {
            bytes = Cow::Owned(written);
        }
    }
    SaveFixResult {
        bytes,
        tails_skipped: None,
    }
}
