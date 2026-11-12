//! `apps/hwp/src/main/section-tails.ts`: the lists HWP 5 keeps after a
//! section's last paragraph (master pages beyond the first, memos) and the
//! captions of equations, kept when a file is opened and put back on save
//! where the engine's section lacks them (decisions 0024 and 0028).

use std::borrow::Cow;
use std::collections::HashSet;

use jscompat::{JsMap, js_regex, sha1_hex};

use super::hwp5_file::{
    CTRL_HEADER, DOC_INFO, HwpRecord, LIST_HEADER, OpenedHwp, PARA_HEADER, PARA_TEXT, Res,
    open_hwp, read_i32, read_u16, read_u32, records_of, rewrite_streams, section, section_count,
    stream_of, write_u32,
};

const ID_MAPPINGS: u32 = 17;
const FACE_NAME: u32 = 19;
const MEMO_LIST: u32 = 93;
/// DocInfo records the body refers to by their position among records of the same tag
const FIRST_ID_TAG: u32 = 18;
const LAST_ID_TAG: u32 = 26;
/// Fonts are numbered within their language; ID_MAPPINGS counts them from its second number.
const FONT_LANGUAGES: usize = 7;
/// How a memo's field in the body starts, in the text of its command: MEMO/<n>/<memo number>/
const MEMO_COMMAND: [u8; 10] = [b'M', 0, b'E', 0, b'M', 0, b'O', 0, b'/', 0];
const MAX_COMMAND_DIGITS: usize = 12;
/// A master page's list header: paragraph count, properties, width and height come first.
const MASTER_PAGE_KIND_AT: usize = 16;
/// An equation's control, its id read as a little-endian number ('eqed')
const EQUATION: u32 = 0x6571_6564;
/// A record's header word: tag, level and size in 10, 10 and 12 bits; a full size may follow
const LEVEL_SHIFT: u32 = 10;
const LEVEL_MASK: u32 = 0x3ff;

/// One list after the body: a master page or a memo, with everything below it.
#[derive(Debug, Clone, PartialEq)]
pub struct TailList {
    /// what tells it from the other lists of its section, however its content
    /// was rewritten: a memo's number, or what a master page's header says
    /// after its sizes
    pub key: String,
    pub bytes: Vec<u8>,
    /// for a memo, the number the field in the body names it by
    pub memo: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Caption {
    pub bytes: Vec<u8>,
    pub level: u32,
}

/// What is kept of an opened file to put its section tails back on save.
#[derive(Debug, Clone)]
pub struct SectionTails {
    /// number of body sections of the opened file
    pub sections: f64,
    /// the lists after the last paragraph, by section index; only sections that have any
    pub tails: Vec<(usize, Vec<TailList>)>,
    /// a digest of each DocInfo record the body can refer to, in order, by kind
    pub ids: JsMap<Vec<String>>,
    /// names of the binary data streams (pictures) of the opened file
    pub bin_data: Vec<String>,
    /// the captions of equations, by digest of the equation's control record
    pub captions: JsMap<Caption>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreSkip {
    Unreadable,
    Sections,
    Ids,
    BinData,
}

impl RestoreSkip {
    pub fn as_str(self) -> &'static str {
        match self {
            RestoreSkip::Unreadable => "unreadable",
            RestoreSkip::Sections => "sections",
            RestoreSkip::Ids => "ids",
            RestoreSkip::BinData => "bin-data",
        }
    }
}

pub struct RestoreResult<'a> {
    /// the bytes to write: the saved bytes themselves when nothing was put back
    pub bytes: Cow<'a, [u8]>,
    /// lists that were put back
    pub restored: usize,
    /// lists were missing and were not put back, and why
    pub skipped: Option<RestoreSkip>,
}

struct SectionTail {
    /// where the body ends in the stream
    body_end: usize,
    lists: Vec<TailList>,
}

/// `body.indexOf(MEMO_COMMAND, from)`
fn index_of(body: &[u8], from: usize) -> Option<usize> {
    if from > body.len() {
        return None;
    }
    body[from..]
        .windows(MEMO_COMMAND.len())
        .position(|window| window == MEMO_COMMAND)
        .map(|at| at + from)
}

/// Adds the numbers of the memos a section has a field for.
fn memos_anchored_in(body: &[u8], found: &mut HashSet<u64>) -> Res<()> {
    let mut at = index_of(body, 0);
    while let Some(start) = at {
        // two numbers, each closed by a slash, in two-byte characters; the second is the memo's
        let mut cursor = start + MEMO_COMMAND.len();
        let mut numbers: Vec<u64> = Vec::new();
        while numbers.len() < 2 {
            let mut digits = String::new();
            while digits.len() <= MAX_COMMAND_DIGITS && cursor + 1 < body.len() {
                let unit = read_u16(body, cursor)?;
                if !(0x30..=0x39).contains(&unit) {
                    break;
                }
                digits.push(char::from(unit as u8));
                cursor += 2;
            }
            if digits.is_empty() || cursor + 1 >= body.len() || read_u16(body, cursor)? != 0x2f {
                break;
            }
            numbers.push(digits.parse::<u64>().unwrap_or(0));
            cursor += 2;
        }
        if numbers.len() == 2 {
            found.insert(numbers[1]);
        }
        at = index_of(body, start + MEMO_COMMAND.len());
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The lists after the body of a section. `None` when what follows the last
/// paragraph is something else than master pages and memos: then the section
/// is left alone.
fn tail_of(data: &[u8], records: &[HwpRecord]) -> Res<Option<SectionTail>> {
    let mut last_body: Option<usize> = None;
    for index in (0..records.len()).rev() {
        let record = records[index];
        if record.tag == PARA_HEADER && record.level == 0 {
            last_body = Some(index);
            break;
        }
    }
    let Some(last_body) = last_body else {
        return Ok(Some(SectionTail {
            body_end: data.len(),
            lists: Vec::new(),
        }));
    };
    // the paragraph's own records are one level below it: its text, shapes and controls
    let mut first = last_body + 1;
    while first < records.len() {
        let record = records[first];
        if record.level == 1 && (record.tag < PARA_TEXT || record.tag > CTRL_HEADER) {
            break;
        }
        first += 1;
    }
    if first == records.len() {
        return Ok(Some(SectionTail {
            body_end: data.len(),
            lists: Vec::new(),
        }));
    }

    let mut lists: Vec<TailList> = Vec::new();
    let mut index = first;
    while index < records.len() {
        let head = records[index];
        if head.level != 1 {
            return Ok(None);
        }
        let mut next = index + 1;
        let mut memo: Option<u32> = None;
        if head.tag == MEMO_LIST {
            let Some(list) = records.get(next) else {
                return Ok(None);
            };
            if list.level != 1 || list.tag != LIST_HEADER {
                return Ok(None);
            }
            if head.end - head.body < 4 {
                return Ok(None);
            }
            memo = Some(read_u32(data, head.body)?);
            next += 1;
        } else if head.tag != LIST_HEADER {
            return Ok(None);
        }
        let key = match memo {
            None => format!(
                "page:{}",
                hex(&data[(head.body + MASTER_PAGE_KIND_AT).min(head.end)..head.end])
            ),
            Some(memo) => format!("memo:{memo}"),
        };
        // everything up to the next list belongs to this one
        while next < records.len() {
            let record = records[next];
            if record.level == 0 {
                return Ok(None);
            }
            if record.level == 1 && (record.tag == LIST_HEADER || record.tag == MEMO_LIST) {
                break;
            }
            next += 1;
        }
        let end = if next < records.len() {
            records[next].start
        } else {
            data.len()
        };
        lists.push(TailList {
            key,
            bytes: data[head.start..end].to_vec(),
            memo,
        });
        index = next;
    }
    Ok(Some(SectionTail {
        body_end: records[first].start,
        lists,
    }))
}

fn digest_of(data: &[u8], record: &HwpRecord) -> String {
    sha1_hex(&data[record.body..record.end])
}

/// Where the caption under the control at `index` ends, or `None` when it has none.
fn caption_end(records: &[HwpRecord], index: usize) -> Option<usize> {
    let control = records[index];
    let head = records.get(index + 1)?;
    if head.tag != LIST_HEADER || head.level != control.level + 1 {
        return None;
    }
    // the list header, then its paragraphs with everything below them
    let mut end = index + 2;
    while end < records.len() {
        let record = records[end];
        let inside = record.level > control.level + 1
            || (record.level == control.level + 1 && record.tag == PARA_HEADER);
        if !inside {
            break;
        }
        end += 1;
    }
    Some(end)
}

fn is_equation(data: &[u8], record: &HwpRecord) -> Res<bool> {
    Ok(record.tag == CTRL_HEADER
        && record.end - record.body >= 4
        && read_u32(data, record.body)? == EQUATION)
}

/// Adds the captions of the equations of one section.
fn captions_in(data: &[u8], records: &[HwpRecord], found: &mut JsMap<Caption>) -> Res<()> {
    for (index, record) in records.iter().enumerate() {
        if !is_equation(data, record)? {
            continue;
        }
        let Some(end) = caption_end(records, index) else {
            continue;
        };
        let stop = if end < records.len() {
            records[end].start
        } else {
            data.len()
        };
        found.set(
            digest_of(data, record),
            Caption {
                bytes: data[records[index + 1].start..stop].to_vec(),
                level: record.level,
            },
        );
    }
    Ok(())
}

/// The records in `bytes`, each moved `by` levels; `None` when that leaves the allowed levels.
fn shift_levels(bytes: &[u8], by: i64) -> Res<Option<Vec<u8>>> {
    if by == 0 {
        return Ok(Some(bytes.to_vec()));
    }
    let Some(records) = records_of(bytes) else {
        return Ok(None);
    };
    let mut out = bytes.to_vec();
    for record in records {
        let word = read_u32(&out, record.start)?;
        let level = i64::from((word >> LEVEL_SHIFT) & LEVEL_MASK) + by;
        if !(0..=i64::from(LEVEL_MASK)).contains(&level) {
            return Ok(None);
        }
        write_u32(
            &mut out,
            (word & !(LEVEL_MASK << LEVEL_SHIFT)) | ((level as u32) << LEVEL_SHIFT),
            record.start,
        )?;
    }
    Ok(Some(out))
}

struct Captioned<'a> {
    data: Cow<'a, [u8]>,
    added: usize,
}

/// The section with the kept captions put back under the equations that lost
/// theirs, and how many were put back; `None` when one cannot be.
fn with_captions<'a>(
    data: &'a [u8],
    records: &[HwpRecord],
    kept: &JsMap<Caption>,
) -> Res<Option<Captioned<'a>>> {
    if kept.is_empty() {
        return Ok(Some(Captioned {
            data: Cow::Borrowed(data),
            added: 0,
        }));
    }
    let mut pieces: Vec<Cow<'_, [u8]>> = Vec::new();
    let mut from = 0;
    let mut added = 0;
    for (index, record) in records.iter().enumerate() {
        if !is_equation(data, record)? || caption_end(records, index).is_some() {
            continue;
        }
        let Some(caption) = kept.get(&digest_of(data, record)) else {
            continue;
        };
        let Some(bytes) = shift_levels(
            &caption.bytes,
            i64::from(record.level) - i64::from(caption.level),
        )?
        else {
            return Ok(None);
        };
        pieces.push(Cow::Borrowed(&data[from..record.end]));
        pieces.push(Cow::Owned(bytes));
        from = record.end;
        added += 1;
    }
    if added == 0 {
        return Ok(Some(Captioned {
            data: Cow::Borrowed(data),
            added: 0,
        }));
    }
    pieces.push(Cow::Borrowed(&data[from..]));
    Ok(Some(Captioned {
        data: Cow::Owned(pieces.concat()),
        added,
    }))
}

/// Digests of the DocInfo records the body refers to by number, in order, by
/// kind. Fonts are numbered within their language, so each language is a kind
/// of its own.
fn ids_of(opened: &OpenedHwp) -> Res<Option<JsMap<Vec<String>>>> {
    let data = stream_of(opened, DOC_INFO)?;
    let records = data.as_deref().and_then(records_of);
    let (Some(data), Some(records)) = (data, records) else {
        return Ok(None);
    };
    let Some(mappings) = records.iter().find(|record| record.tag == ID_MAPPINGS) else {
        return Ok(None);
    };
    let payload = &data[mappings.body..mappings.end];
    if payload.len() < 4 * (1 + FONT_LANGUAGES) {
        return Ok(None);
    }
    // the font of position n belongs to the language whose count covers n
    let mut font_language: Vec<usize> = Vec::new();
    for language in 0..FONT_LANGUAGES {
        let count = read_i32(payload, 4 * (1 + language))?;
        if count < 0 || count as usize > records.len() {
            return Ok(None);
        }
        for _ in 0..count {
            font_language.push(language);
        }
    }
    let mut ids: JsMap<Vec<String>> = JsMap::new();
    let mut fonts = 0;
    for record in &records {
        if record.tag < FIRST_ID_TAG || record.tag > LAST_ID_TAG {
            continue;
        }
        let mut kind = record.tag.to_string();
        if record.tag == FACE_NAME {
            let language = font_language.get(fonts).copied();
            fonts += 1;
            let Some(language) = language else {
                return Ok(None);
            };
            kind = format!("font{language}");
        }
        let digest = sha1_hex(&data[record.start..record.end]);
        match ids.get_mut(&kind) {
            Some(list) => list.push(digest),
            None => ids.set(kind, vec![digest]),
        }
    }
    if fonts != font_language.len() {
        return Ok(None);
    }
    Ok(Some(ids))
}

fn bin_data_of(opened: &OpenedHwp) -> Vec<String> {
    let bin_data = js_regex!(r"/BinData/[^/]+$");
    opened
        .cfb
        .full_paths
        .iter()
        .filter(|path| bin_data.test(path))
        .map(|path| {
            let at = path.rfind('/').map_or(0, |at| at + 1);
            path[at..].to_lowercase()
        })
        .collect()
}

fn section_tails_inner(file: &[u8]) -> Res<Option<SectionTails>> {
    let Some(opened) = open_hwp(file)? else {
        return Ok(None);
    };
    let sections = section_count(&opened);
    let mut tails: Vec<(usize, Vec<TailList>)> = Vec::new();
    let mut captions: JsMap<Caption> = JsMap::new();
    for index in 0..sections {
        let data = stream_of(&opened, &section(index))?;
        let records = data.as_deref().and_then(records_of);
        let (Some(data), Some(records)) = (data, records) else {
            return Ok(None);
        };
        if let Some(tail) = tail_of(&data, &records)?
            && !tail.lists.is_empty()
        {
            tails.push((index, tail.lists));
        }
        captions_in(&data, &records, &mut captions)?;
    }
    if tails.is_empty() && captions.is_empty() {
        return Ok(None);
    }
    let Some(ids) = ids_of(&opened)? else {
        return Ok(None);
    };
    Ok(Some(SectionTails {
        sections: sections as f64,
        tails,
        ids,
        bin_data: bin_data_of(&opened),
        captions,
    }))
}

/// The section tails of a file as it was opened; `None` when it has none to
/// keep (the common case), is not an HWP 5 file, or cannot be read here. Never
/// throws: opening a document does not depend on this.
pub fn section_tails_of(file: &[u8]) -> Option<SectionTails> {
    section_tails_inner(file).unwrap_or(None)
}

/// Every record the lists can refer to is where it was: the saved lists start with the kept ones.
fn ids_kept(kept: &JsMap<Vec<String>>, saved: &JsMap<Vec<String>>) -> bool {
    for (kind, digests) in kept.iter() {
        let now: &[String] = match saved.get(kind) {
            Some(list) => list,
            None => &[],
        };
        if now.len() < digests.len() {
            return false;
        }
        if !digests
            .iter()
            .enumerate()
            .all(|(index, digest)| now[index] == *digest)
        {
            return false;
        }
    }
    true
}

/// The kept lists in their order, each one as the saved section has it when it
/// has it. Lists only the saved section has follow. A kept memo whose field is
/// gone from the body stays out. `missing` counts the lists put back.
fn merge_lists(
    kept: &[TailList],
    saved: Vec<TailList>,
    anchored: &mut dyn FnMut(u32) -> Res<bool>,
) -> Res<(Vec<TailList>, usize)> {
    let mut left = saved;
    let mut lists: Vec<TailList> = Vec::new();
    let mut missing = 0;
    for list in kept {
        if let Some(at) = left.iter().position(|candidate| candidate.key == list.key) {
            lists.push(left.remove(at));
        } else if match list.memo {
            None => true,
            Some(memo) => anchored(memo)?,
        } {
            lists.push(list.clone());
            missing += 1;
        }
    }
    lists.extend(left);
    Ok((lists, missing))
}

fn restore_inner<'a>(saved_bytes: &'a [u8], kept: &SectionTails) -> Res<RestoreResult<'a>> {
    let untouched = |skipped: Option<RestoreSkip>| RestoreResult {
        bytes: Cow::Borrowed(saved_bytes),
        restored: 0,
        skipped,
    };
    let Some(mut opened) = open_hwp(saved_bytes)? else {
        return Ok(untouched(Some(RestoreSkip::Unreadable)));
    };
    let mut due: Vec<(usize, Vec<u8>)> = Vec::new();
    let mut restored = 0;
    // the memos that still have their field, looked up in every section the first time asked
    let mut anchored: Option<HashSet<u64>> = None;
    let mut memos_anchored = |memo: u32| -> Res<bool> {
        if anchored.is_none() {
            let mut found = HashSet::new();
            let count = section_count(&opened);
            for index in 0..count {
                if let Some(stream) = stream_of(&opened, &section(index))? {
                    memos_anchored_in(&stream, &mut found)?;
                }
            }
            anchored = Some(found);
        }
        Ok(anchored
            .as_ref()
            .is_some_and(|set| set.contains(&u64::from(memo))))
    };
    let count = section_count(&opened);
    for index in 0..count {
        let lists = kept
            .tails
            .iter()
            .find(|(at, _)| *at == index)
            .map(|(_, lists)| lists);
        if lists.is_none() && kept.captions.is_empty() {
            continue;
        }
        let stream = stream_of(&opened, &section(index))?;
        let stream_records = stream.as_deref().and_then(records_of);
        let (Some(stream), Some(stream_records)) = (stream, stream_records) else {
            return Ok(untouched(Some(RestoreSkip::Unreadable)));
        };
        // the captions first: they go inside the body, the tail after it
        let Some(captioned) = with_captions(&stream, &stream_records, &kept.captions)? else {
            return Ok(untouched(Some(RestoreSkip::Unreadable)));
        };
        restored += captioned.added;
        let data = captioned.data;
        let mut next: Option<Vec<u8>> = if captioned.added > 0 {
            Some(data.to_vec())
        } else {
            None
        };
        if let Some(lists) = lists {
            let records = records_of(&data);
            let tail = match &records {
                Some(records) => tail_of(&data, records)?,
                None => None,
            };
            let Some(tail) = tail else {
                return Ok(untouched(Some(RestoreSkip::Unreadable)));
            };
            let (merged, missing) = merge_lists(lists, tail.lists, &mut memos_anchored)?;
            if missing > 0 {
                restored += missing;
                let mut joined = data[..tail.body_end].to_vec();
                for list in &merged {
                    joined.extend_from_slice(&list.bytes);
                }
                next = Some(joined);
            }
        }
        if let Some(next) = next {
            due.push((index, next));
        }
    }
    if due.is_empty() {
        return Ok(untouched(None));
    }
    if section_count(&opened) as f64 != kept.sections {
        return Ok(untouched(Some(RestoreSkip::Sections)));
    }
    let Some(ids) = ids_of(&opened)? else {
        return Ok(untouched(Some(RestoreSkip::Unreadable)));
    };
    if !ids_kept(&kept.ids, &ids) {
        return Ok(untouched(Some(RestoreSkip::Ids)));
    }
    let bin_data: HashSet<String> = bin_data_of(&opened).into_iter().collect();
    if !kept.bin_data.iter().all(|name| bin_data.contains(name)) {
        return Ok(untouched(Some(RestoreSkip::BinData)));
    }

    // read back what will be written: the same streams as the engine wrote, each with the
    // same bytes, except the changed sections, which hold exactly what was meant
    let changed: Vec<(String, Vec<u8>)> = due
        .into_iter()
        .map(|(index, data)| (section(index), data))
        .collect();
    let Some(written) = rewrite_streams(&mut opened, &changed)? else {
        return Ok(untouched(Some(RestoreSkip::Unreadable)));
    };
    Ok(RestoreResult {
        bytes: Cow::Owned(written),
        restored,
        skipped: None,
    })
}

/// The saved bytes with the kept lists put back in the sections that lack
/// them. The saved bytes come back untouched when no section lacks one, and
/// when putting them back cannot be shown to be right (`skipped`). Never
/// throws: a save does not fail on this.
pub fn restore_section_tails<'a>(saved: &'a [u8], kept: &SectionTails) -> RestoreResult<'a> {
    restore_inner(saved, kept).unwrap_or(RestoreResult {
        bytes: Cow::Borrowed(saved),
        restored: 0,
        skipped: Some(RestoreSkip::Unreadable),
    })
}
