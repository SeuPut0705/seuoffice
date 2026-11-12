//! `apps/hwp/src/main/field-kinds.ts`: the kinds of the fields the engine
//! writes as "unknown", kept from the opened file by the content of the
//! field's control record and written back into the saved one.

use std::borrow::Cow;

use jscompat::{JsMap, sha1_hex};

use super::hwp5_file::{
    CTRL_HEADER, HwpRecord, PARA_TEXT, Res, open_hwp, read_u16, read_u32, records_of,
    rewrite_streams, section, section_count, stream_of, write_u32_f64,
};

/// A field's control: its id, four characters, read as a little-endian number.
const UNKNOWN_FIELD: u32 = 0x2575_6e6b; // '%unk'
const FIELD_BEGIN: u16 = 3;

/// Characters of the paragraph text that take eight code units (a control and its data).
const LONG_CHARS: [u16; 21] = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
];
/// Of those, the ones that have a control record of their own, in the same order.
const EXTENDED_CHARS: [u16; 13] = [1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23];

/// By digest of the field's control record: the kind its opening character had.
/// The kinds are numbers, which a caller may make anything `writeUInt32LE` takes.
pub type FieldKinds = JsMap<f64>;

struct FieldBegin {
    /// where the kind is in the section stream
    at: usize,
    kind: u32,
    control: HwpRecord,
}

/// The field-opening characters of an unknown-kind field, with their control records.
fn unknown_fields_in(data: &[u8], records: &[HwpRecord]) -> Res<Vec<FieldBegin>> {
    let mut out = Vec::new();
    for (index, text) in records.iter().enumerate() {
        if text.tag != PARA_TEXT {
            continue;
        }
        // the paragraph's control records follow its text, at the same level
        let mut controls: Vec<HwpRecord> = Vec::new();
        let mut j = index + 1;
        while j < records.len() && records[j].level >= text.level {
            if records[j].level == text.level && records[j].tag == CTRL_HEADER {
                controls.push(records[j]);
            }
            j += 1;
        }
        let mut at = text.body;
        let mut nth = 0;
        while at + 1 < text.end {
            let unit = read_u16(data, at)?;
            if unit < 32 && LONG_CHARS.contains(&unit) {
                if at + 16 > text.end {
                    break;
                }
                if EXTENDED_CHARS.contains(&unit) {
                    let control = controls.get(nth).copied();
                    nth += 1;
                    if let Some(control) = control
                        && unit == FIELD_BEGIN
                        && control.end - control.body >= 4
                        && read_u32(data, control.body)? == UNKNOWN_FIELD
                    {
                        out.push(FieldBegin {
                            at: at + 2,
                            kind: read_u32(data, at + 2)?,
                            control,
                        });
                    }
                }
                at += 16;
            } else {
                at += 2;
            }
        }
    }
    Ok(out)
}

fn digest_of(data: &[u8], control: &HwpRecord) -> String {
    sha1_hex(&data[control.body..control.end])
}

fn field_kinds_inner(file: &[u8]) -> Res<Option<FieldKinds>> {
    let Some(opened) = open_hwp(file)? else {
        return Ok(None);
    };
    let mut kinds = FieldKinds::new();
    for sec in 0..section_count(&opened) {
        let data = stream_of(&opened, &section(sec))?;
        let records = data.as_deref().and_then(records_of);
        let (Some(data), Some(records)) = (data, records) else {
            return Ok(None);
        };
        for field in unknown_fields_in(&data, &records)? {
            if field.kind != UNKNOWN_FIELD {
                kinds.set(digest_of(&data, &field.control), f64::from(field.kind));
            }
        }
    }
    Ok(if kinds.is_empty() { None } else { Some(kinds) })
}

/// The kinds the opened file gives its unknown-kind fields in the text, where
/// that is not "unknown"; `None` when it has none (the common case) or cannot
/// be read here. Never throws.
pub fn field_kinds_of(file: &[u8]) -> Option<FieldKinds> {
    field_kinds_inner(file).unwrap_or(None)
}

/// `{ bytes, restored }`; the bytes are the saved ones themselves when nothing was written.
pub struct RestoredKinds<'a> {
    pub bytes: Cow<'a, [u8]>,
    pub restored: usize,
}

fn restore_inner<'a>(saved: &'a [u8], kept: &FieldKinds) -> Res<RestoredKinds<'a>> {
    let untouched = || RestoredKinds {
        bytes: Cow::Borrowed(saved),
        restored: 0,
    };
    let Some(mut opened) = open_hwp(saved)? else {
        return Ok(untouched());
    };
    let mut changed: Vec<(String, Vec<u8>)> = Vec::new();
    let mut restored = 0;
    for sec in 0..section_count(&opened) {
        let stream = stream_of(&opened, &section(sec))?;
        let records = stream.as_deref().and_then(records_of);
        let (Some(stream), Some(records)) = (stream, records) else {
            return Ok(untouched());
        };
        let mut data = stream;
        let mut any = false;
        for field in unknown_fields_in(&data, &records)? {
            let kind = kept.get(&digest_of(&data, &field.control)).copied();
            let Some(kind) = kind else {
                continue;
            };
            if field.kind != UNKNOWN_FIELD {
                continue;
            }
            write_u32_f64(&mut data, kind, field.at)?;
            restored += 1;
            any = true;
        }
        if any {
            changed.push((section(sec), data));
        }
    }
    if changed.is_empty() {
        return Ok(untouched());
    }
    Ok(match rewrite_streams(&mut opened, &changed)? {
        Some(written) => RestoredKinds {
            bytes: Cow::Owned(written),
            restored,
        },
        None => untouched(),
    })
}

/// The saved bytes with the kept kinds written back into the fields the engine
/// wrote as "unknown", each found by the content of its control record; fields
/// without a kept kind stay as written. The saved bytes come back untouched
/// when there is nothing to write or the result cannot be read back as meant.
/// Never throws: a save does not fail on this.
pub fn restore_field_kinds<'a>(saved: &'a [u8], kept: &FieldKinds) -> RestoredKinds<'a> {
    restore_inner(saved, kept).unwrap_or(RestoredKinds {
        bytes: Cow::Borrowed(saved),
        restored: 0,
    })
}
