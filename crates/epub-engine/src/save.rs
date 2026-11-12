//! `save.ts`: saving a book (spec 6, invariant 12.1). The zip is written anew:
//!
//! - `mimetype` first, stored, with no extra field; added when the original
//!   lacks it (its content is kept when it has one);
//! - every other entry in the original archive order, with its original date,
//!   compression method and, when unchanged, its original compressed bytes;
//! - an edited chapter is its original decoded text with only the given range
//!   replacements applied, encoded back with its original encoding and BOM;
//! - an EPUB 3 package document gets its `dcterms:modified` value set to the
//!   save time, as one more range replacement (or one inserted `meta` line).
//!   An EPUB 2 package document is never touched.
//!
//! Nothing is serialised from a tree. When no entry's text would change the
//! result says so and the caller must not write the file at all.
//!
//! JSZip is `ooxml-pkg`: the entries copied through are the raw records the
//! book was loaded with, and the zip is written by `ooxml_pkg::write`. The
//! deflate stream of an entry whose bytes changed is not pako's, so the bytes
//! of such an entry differ from the TypeScript's, and so do the sizes that
//! follow from them; what it inflates to is the same. The save time is a
//! parameter, a `Date` as its time value: the engine has no clock.

use jscompat::trim;
use ooxml_pkg::write::{Record, RecordData, UtcDate, generate_records};
use ooxml_pkg::{Part, ZipLimits};

use crate::open::{EpubOpenResult, open_epub};
use crate::primitives::{decode_entry_text, encode_entry_text};
use crate::ranges::{RangeReplacement, apply_replacements, validate_replacements};
use crate::types::EpubBook;
use crate::utf16::{is_space, last_index_of_unit, lossy, units};
use crate::xml_positions::{check_well_formed, parse_xml};
use crate::xml_positions_types::{
    ElementId, Thrown, XmlDocument, XmlElement, XmlNode, XmlParseResult,
};

const MIMETYPE: &str = "mimetype";
const MIMETYPE_CONTENT: &str = "application/epub+zip";
const MODIFIED_PROPERTY: &str = "dcterms:modified";

/// `EpubSaveRefusalReason`: why a save was refused. Nothing is written in any
/// of these cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpubSaveRefusalReason {
    /// the original bytes do not open as a book
    NotOpened,
    /// an edit names a path the archive does not have
    UnknownEntry,
    /// the entry was not well-formed (or not valid in its encoding) to begin
    /// with; such an entry is never edited
    Broken,
    /// the replacements overlap or fall outside the text
    InvalidReplacements,
    /// the entry is not well-formed after the replacements
    NotWellFormed,
}

impl EpubSaveRefusalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotOpened => "not-opened",
            Self::UnknownEntry => "unknown-entry",
            Self::Broken => "broken",
            Self::InvalidReplacements => "invalid-replacements",
            Self::NotWellFormed => "not-well-formed",
        }
    }
}

/// `EpubSaveResult`
#[derive(Debug, PartialEq)]
pub enum EpubSaveResult {
    /// nothing changed: do not write the file
    Unchanged,
    Saved {
        bytes: Vec<u8>,
        /// archive paths of the edited entries whose text changed, in archive order
        changed_chapters: Vec<String>,
    },
    Refused {
        reason: EpubSaveRefusalReason,
        /// the entry the refusal is about; `None` for `not-opened`
        path: Option<String>,
        /// English, for the log; not for the screen
        detail: String,
    },
}

/// What `saveEpub` is given to save: the book's bytes, which pass the zip gate
/// again here, or a book `open_epub` opened (and so gated) already, which is
/// saved from the archive it reads without opening it again.
pub enum SaveOriginal<'a> {
    Bytes(&'a [u8]),
    Book(&'a EpubBook),
}

/// Range replacements per entry path, each against that entry's decoded text,
/// in the order the TypeScript map (or record) lists them.
pub type EpubChapterEdits = [(String, Vec<RangeReplacement>)];

/// `EpubSaveOptions`
pub struct EpubSaveOptions<'a> {
    pub limits: &'a ZipLimits,
    /// the save time for `dcterms:modified`, a `Date` as its time value
    pub now: f64,
}

/// `new Date(time)`: the time value kept, or `None` for an invalid date.
fn time_clip(time: f64) -> Option<f64> {
    (time.is_finite() && time.abs() <= 8.64e15).then(|| time.trunc() + 0.0)
}

/// `formatModifiedTimestamp`: `YYYY-MM-DDThh:mm:ssZ` in UTC, as
/// `dcterms:modified` wants it. `toISOString` throws for an invalid date.
pub fn format_modified_timestamp(date: f64) -> Result<String, Thrown> {
    let Some(utc) = time_clip(date).and_then(UtcDate::from_time_value) else {
        return Err(Thrown::new("RangeError", "Invalid time value"));
    };
    let year = if (0..=9999).contains(&utc.year) {
        format!("{:04}", utc.year)
    } else {
        format!(
            "{}{:06}",
            if utc.year < 0 { '-' } else { '+' },
            utc.year.abs()
        )
    };
    Ok(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        utc.month, utc.day, utc.hours, utc.minutes, utc.seconds
    ))
}

/// `/[\w.-]/`
fn is_name_rest(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// `maskUndefinedEntities`: hides named references XML does not define
/// (`&nbsp;` in a title) behind filler of the same length, so the package can
/// be read for positions only. `/&([A-Za-z_][\w.-]*);/g`
pub fn mask_undefined_entities(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i] == 0x26
            && let Some(&first) = text.get(i + 1)
            && u8::try_from(first).is_ok_and(|b| b.is_ascii_alphabetic() || b == b'_')
        {
            let mut end = i + 2;
            while end < text.len() && is_name_rest(text[end]) {
                end += 1;
            }
            if text.get(end) == Some(&0x3B) {
                let name = &text[i + 1..end];
                let is_xml = [&b"amp"[..], b"lt", b"gt", b"quot", b"apos"]
                    .iter()
                    .any(|known| {
                        known.len() == name.len()
                            && known.iter().zip(name).all(|(k, n)| u16::from(*k) == *n)
                    });
                if is_xml {
                    out.extend_from_slice(&text[i..=end]);
                } else {
                    out.extend(std::iter::repeat_n(u16::from(b'x'), end + 1 - i));
                }
                i = end + 1;
                continue;
            }
        }
        out.push(text[i]);
        i += 1;
    }
    out
}

/// `prefixOf`: the prefix of a name with its colon, or `""`.
fn prefix_of(name: &str) -> &str {
    name.find(':').map_or("", |colon| &name[..=colon])
}

fn element_children(doc: &XmlDocument, id: ElementId) -> Vec<ElementId> {
    doc.element(id)
        .children
        .iter()
        .filter_map(|node| match node {
            XmlNode::Element(child) => Some(*child),
            _ => None,
        })
        .collect()
}

/// `attribute`: by the name as written, the first one.
fn attribute<'a>(element: &'a XmlElement, name: &str) -> Option<&'a str> {
    element
        .attributes
        .iter()
        .find(|a| a.name == name)
        .map(|a| a.value.as_str())
}

fn replacement(start: usize, end: usize, text: &str) -> RangeReplacement {
    RangeReplacement {
        start: start as f64,
        end: end as f64,
        text: units(text),
    }
}

/// `modifiedReplacements`: the range replacements that set an EPUB 3 package
/// document's `dcterms:modified` to `timestamp`: the value of each such `meta`
/// that does not refine another element, or one inserted `meta` line at the
/// end of `metadata` when there is none. `None` when the package has no
/// `metadata`.
pub fn modified_replacements(opf_text: &[u16], timestamp: &str) -> Option<Vec<RangeReplacement>> {
    let XmlParseResult::Ok(doc) = parse_xml(&mask_undefined_entities(opf_text)) else {
        return None;
    };
    let metadata_id = element_children(&doc, doc.root)
        .into_iter()
        .find(|&child| doc.element(child).local == "metadata")?;
    let metadata = doc.element(metadata_id);

    let metas: Vec<&XmlElement> = element_children(&doc, metadata_id)
        .into_iter()
        .map(|child| doc.element(child))
        .filter(|el| {
            el.local == "meta"
                && attribute(el, "property").map(trim) == Some(MODIFIED_PROPERTY)
                && attribute(el, "refines").is_none()
        })
        .collect();
    if !metas.is_empty() {
        return Some(
            metas
                .into_iter()
                .map(|el| {
                    if el.self_closing {
                        replacement(el.end - 2, el.end, &format!(">{timestamp}</{}>", el.name))
                    } else {
                        replacement(el.start_tag_end, el.end_tag_start, timestamp)
                    }
                })
                .collect(),
        );
    }

    let meta = format!("{}meta", prefix_of(&metadata.name));
    let line = format!("<{meta} property=\"{MODIFIED_PROPERTY}\">{timestamp}</{meta}>");
    Some(vec![metadata_line_insertion(
        opf_text,
        &doc,
        metadata_id,
        &line,
    )])
}

/// `/\S/.test(text)`
fn has_non_space(text: &[u16]) -> bool {
    text.iter().any(|&unit| !is_space(unit))
}

/// `metadataLineInsertion`: the replacement that adds `line` as the last child
/// of a package document's `metadata`: on a line of its own, with the
/// document's indentation and line end, when the end tag starts its own line;
/// else right before the end tag (a self-closing `metadata` gets a start and
/// end tag). `doc` is the parse of the masked text of `opf_text`, whose
/// offsets are those of `opf_text`.
pub fn metadata_line_insertion(
    opf_text: &[u16],
    doc: &XmlDocument,
    metadata_id: ElementId,
    line: &str,
) -> RangeReplacement {
    let metadata = doc.element(metadata_id);
    if metadata.self_closing {
        return replacement(
            metadata.end - 2,
            metadata.end,
            &format!(">{line}</{}>", metadata.name),
        );
    }
    let at = metadata.end_tag_start;
    let line_start = last_index_of_unit(opf_text, 0x0A, at as isize - 1).map_or(0, |at| at + 1);
    if line_start == 0 || has_non_space(&opf_text[line_start..at]) {
        return replacement(at, at, line);
    }
    let newline = if line_start >= 2 && opf_text[line_start - 2] == 0x0D {
        "\r\n"
    } else {
        "\n"
    };
    let last = element_children(doc, metadata_id).last().copied();
    let mut indent = lossy(&opf_text[line_start..at]);
    if let Some(last) = last {
        let last_start = doc.element(last).start;
        let last_line_start =
            last_index_of_unit(opf_text, 0x0A, last_start as isize - 1).map_or(0, |at| at + 1);
        let before = &opf_text[last_line_start..last_start];
        if !has_non_space(before) {
            indent = lossy(before);
        }
    }
    replacement(line_start, line_start, &format!("{indent}{line}{newline}"))
}

fn refusal(
    reason: EpubSaveRefusalReason,
    path: Option<&str>,
    detail: String,
) -> Result<EpubSaveResult, Thrown> {
    Ok(EpubSaveResult::Refused {
        reason,
        path: path.map(str::to_owned),
        detail,
    })
}

fn read_error(message: String) -> Thrown {
    Thrown::new("Error", message)
}

/// `saveEpub`: writes `original` again with the edits applied (see the module
/// comment). `Err` is what the promise of the TypeScript rejects with.
pub fn save_epub(
    original: SaveOriginal<'_>,
    edits: &EpubChapterEdits,
    options: &EpubSaveOptions<'_>,
) -> Result<EpubSaveResult, Thrown> {
    let opened;
    let book = match original {
        SaveOriginal::Bytes(bytes) => {
            opened = match open_epub(bytes, options.limits) {
                EpubOpenResult::Opened(book) => book,
                EpubOpenResult::Refused { reason, detail } => {
                    return refusal(
                        EpubSaveRefusalReason::NotOpened,
                        None,
                        format!("{}: {detail}", reason.as_str()),
                    );
                }
            };
            &*opened
        }
        SaveOriginal::Book(book) => book,
    };
    let archive = &book.archive;
    let package = &archive.package;

    // Merge the edits per archive entry.
    let mut wanted: Vec<(String, Vec<RangeReplacement>)> = Vec::new();
    for (path, replacements) in edits {
        if replacements.is_empty() {
            continue;
        }
        let Some(name) = archive.find(path) else {
            return refusal(
                EpubSaveRefusalReason::UnknownEntry,
                Some(path),
                format!("the archive has no entry {path}"),
            );
        };
        match wanted.iter_mut().find(|(known, _)| *known == name) {
            Some((_, merged)) => merged.extend(replacements.iter().cloned()),
            None => wanted.push((name, replacements.clone())),
        }
    }

    // Apply them; an entry whose text comes out the same is not changed.
    let mut texts: Vec<(String, Vec<u16>, String)> = Vec::new();
    for (name, replacements) in &wanted {
        let bytes = package
            .bytes(name)
            .map_err(|error| read_error(error.reason))?
            .unwrap_or_default();
        let decoded = decode_entry_text(bytes);
        let encoding = decoded.encoding.label();
        if !decoded.valid {
            return refusal(
                EpubSaveRefusalReason::Broken,
                Some(name),
                format!("{name} is not valid {encoding}"),
            );
        }
        let source = units(&decoded.text);
        if let Err((error, _)) = check_well_formed(&source) {
            return refusal(
                EpubSaveRefusalReason::Broken,
                Some(name),
                format!("{name} was not well-formed: {error}"),
            );
        }
        if let Some(problem) = validate_replacements(replacements, source.len() as f64) {
            return refusal(
                EpubSaveRefusalReason::InvalidReplacements,
                Some(name),
                format!("{name}: {problem}"),
            );
        }
        let text = apply_replacements(&source, replacements)
            .map_err(|error| Thrown::new("RangeError", error.0))?;
        if text == source {
            continue;
        }
        if let Err((error, _)) = check_well_formed(&text) {
            return refusal(
                EpubSaveRefusalReason::NotWellFormed,
                Some(name),
                format!("{name} after the edit: {error}"),
            );
        }
        texts.push((name.clone(), text, encoding.to_owned()));
    }
    if texts.is_empty() {
        return Ok(EpubSaveResult::Unchanged);
    }
    let changed_chapters: Vec<String> = package
        .parts()
        .iter()
        .filter(|part| texts.iter().any(|(name, _, _)| part.name == name.as_str()))
        .map(|part| part.name.to_string())
        .collect();
    let now = options.now;

    // EPUB 3: stamp the save time into the package document.
    let opf_path = &book.info.opf_path;
    if book.info.version == "3" {
        let (source, encoding) = match texts.iter().find(|(name, _, _)| name == opf_path) {
            Some((_, text, encoding)) => (text.clone(), encoding.clone()),
            None => {
                let decoded = book
                    .read_text(opf_path)
                    .map_err(read_error)?
                    .ok_or_else(|| {
                        Thrown::new("TypeError", "the package document is not an entry")
                    })?;
                let encoding = decoded.encoding.label();
                if !decoded.valid {
                    return refusal(
                        EpubSaveRefusalReason::Broken,
                        Some(opf_path),
                        format!("{opf_path} is not valid {encoding}"),
                    );
                }
                (units(&decoded.text), encoding.to_owned())
            }
        };
        let timestamp = format_modified_timestamp(now)?;
        let Some(replacements) = modified_replacements(&source, &timestamp) else {
            return refusal(
                EpubSaveRefusalReason::Broken,
                Some(opf_path),
                format!("{opf_path} has no metadata to stamp"),
            );
        };
        let text = apply_replacements(&source, &replacements)
            .map_err(|error| Thrown::new("RangeError", error.0))?;
        match texts.iter_mut().find(|(name, _, _)| name == opf_path) {
            Some(entry) => *entry = (opf_path.clone(), text, encoding),
            None => texts.push((opf_path.clone(), text, encoding)),
        }
    }

    let replaced: Vec<(&str, Vec<u8>)> = texts
        .iter()
        .map(|(name, text, encoding)| (name.as_str(), encode_entry_text(text, encoding)))
        .collect();
    let bytes = write_epub_archive(package, &replaced, now)?;
    Ok(EpubSaveResult::Saved {
        bytes,
        changed_chapters,
    })
}

/// `writeEpubArchive`: writes the archive `package` was loaded from again:
/// `mimetype` first, stored, with no extra field (added, dated `now`, when
/// missing), then every other entry in archive order with its date, attributes
/// and compression method. An entry named in `replaced` (by its archive name)
/// gets those bytes; every other file keeps its original compressed data.
pub fn write_epub_archive(
    package: &ooxml_pkg::Package,
    replaced: &[(&str, Vec<u8>)],
    now: f64,
) -> Result<Vec<u8>, Thrown> {
    let mut records: Vec<Record<'_>> = Vec::new();
    match package.file(MIMETYPE) {
        Some(part) => {
            let raw = part.raw();
            let date = raw.map_or(now, |raw| raw.date);
            let data = match raw.and_then(|raw| raw.compressed.as_ref()) {
                // JSZip copies the compressed data through when its method is the one asked for
                Some(compressed) if compressed.stored => RecordData::Copied(compressed),
                _ => RecordData::Content {
                    bytes: part.bytes().map_err(|error| read_error(error.reason))?,
                    deflate: false,
                },
            };
            records.push(Record {
                name: MIMETYPE,
                comment: "",
                dir: false,
                date,
                dos_permissions: None,
                data,
            });
        }
        None => records.push(Record {
            name: MIMETYPE,
            comment: "",
            dir: false,
            date: now,
            dos_permissions: None,
            data: RecordData::Content {
                bytes: MIMETYPE_CONTENT.as_bytes(),
                deflate: false,
            },
        }),
    }
    for part in package.parts() {
        if part.name == MIMETYPE && !part.is_dir {
            continue;
        }
        records.push(record_of(part, replaced, now)?);
    }
    generate_records(&records).map_err(|error| read_error(error.to_string()))
}

fn record_of<'a>(
    part: &'a Part,
    replaced: &'a [(&str, Vec<u8>)],
    now: f64,
) -> Result<Record<'a>, Thrown> {
    let raw = part.raw();
    let compressed = raw.and_then(|raw| raw.compressed.as_ref());
    let data = if part.is_dir {
        RecordData::Content {
            bytes: &[],
            deflate: false,
        }
    } else if let Some((_, bytes)) = replaced.iter().find(|(name, _)| part.name == *name) {
        RecordData::Content {
            bytes,
            deflate: !compressed.is_some_and(|c| c.stored),
        }
    } else if let Some(compressed) = compressed {
        RecordData::Copied(compressed)
    } else {
        RecordData::Content {
            bytes: part.bytes().map_err(|error| read_error(error.reason))?,
            deflate: true,
        }
    };
    Ok(Record {
        name: &part.name,
        comment: raw
            .and_then(|raw| raw.comment.as_deref())
            .unwrap_or_default(),
        dir: part.is_dir,
        date: raw.map_or(now, |raw| raw.date),
        dos_permissions: raw.and_then(|raw| raw.dos_permissions),
        data,
    })
}
