//! `translate/output.ts`: the translated and the bilingual book (spec 8,
//! "Result files"), built from the stored book's bytes and the stored
//! translation results. The original is never changed.
//!
//! The result is written the way a save is: every entry in the original
//! order, `mimetype` first and stored, untouched entries with their original
//! compressed bytes, and the changed text entries edited by range replacements
//! only (nothing is serialised from a tree):
//!
//! - a translated block: its content replaced by the translation (translated
//!   book; ruby readings are not in the translation), or a copy of the block
//!   inserted right after it with no `id` anywhere in it, marked with the
//!   target language and `EPUB_TRANSLATION_CLASS` (bilingual book). A
//!   structural text block (td, th, figcaption, dt, dd) and a list item keep
//!   their place in the table, figure or list instead: the bilingual book
//!   appends a line break and a marked span with the translation inside it;
//! - a translated chapter of the translated book: `lang` and `xml:lang` of its
//!   `html` set to the target, `dir="rtl"` for Arabic and Hebrew;
//! - the package document: titles, `dc:language`, a new `urn:uuid` unique
//!   identifier with the old one kept as `dc:source`, `dcterms:modified`
//!   (EPUB 3) and, for a vertical book going into a language that is not
//!   written vertically, `page-progression-direction="ltr"` on the spine;
//! - the contents labels of the nav and the NCX: the translation only;
//! - obfuscated fonts: revealed with the old key, hidden with the new one.
//!
//! The engine has no clock and no randomness: the build time and the UUID of
//! the new identifier are parameters. Markup and notation are UTF-16 units, as
//! in the other modules: a model can write a lone surrogate.

use std::collections::{HashMap, HashSet};

use jscompat::{number_to_string, trim as trim_str};

use crate::blocks::{ChapterBlock, ChapterMap, OpenChapter, open_chapter};
use crate::notation::{
    NotationContext, NotationError, NotationNode, notation_plain_text, notation_tree_to_xhtml,
    parse_block_notation,
};
use crate::open::{EpubOpenResult, open_epub};
use crate::pdf_structure::{TranslationMode, translation_language_of};
use crate::primitives::{
    ADOBE_FONT_OBFUSCATION, encode_entry_text, font_obfuscation_key, obfuscate_font, resolve_href,
};
use crate::ranges::{RangeReplacement, apply_replacements, validate_replacements};
use crate::save::{
    format_modified_timestamp, mask_undefined_entities, metadata_line_insertion,
    modified_replacements, write_epub_archive,
};
use crate::translate::book_units::epub_toc_labels;
use crate::translate::keys::epub_block_key_string;
use crate::translate::output_markup::{
    attribute_of, child_elements, element_text, element_text_replacement, escape_attribute,
    id_attributes, insertion_after, local_is, namespace_of, prefix_of, read_start_tag, remove_ids,
    remove_tag_attributes, set_tag_attribute, start_tag_replacement, tag_attribute, walk_elements,
    whitespace_start, write_start_tag,
};
use crate::translate::units::{
    EpubMetadataLabels, EpubTranslationUnit, EpubUnitSource, chapter_translation_units,
    metadata_translation_units,
};
use crate::types::EpubBook;
use crate::utf16::{is_space, lossy, trim, units};
use crate::xml_positions::{PositionsHost, check_well_formed, parse_xml};
use crate::xml_positions_types::{ElementId, Thrown, XmlDocument, XmlParseResult, deeper};
use ooxml_pkg::ZipLimits;

/// the class token that marks a translation copy in a bilingual book
pub const EPUB_TRANSLATION_CLASS: &str = "ieum-translation";

const RTL_LANGUAGES: [&str; 2] = ["ar", "he"];
/// targets a vertical book stays vertical in
const VERTICAL_LANGUAGES: [&str; 3] = ["ja", "zh", "ko"];
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
const OPS_NS: &str = "http://www.idpf.org/2007/ops";
const NCX_MEDIA_TYPE: &str = "application/x-dtbncx+xml";

const HORIZONTAL_STYLE: &str = ":root, :root * { -epub-writing-mode: horizontal-tb !important; -webkit-writing-mode: horizontal-tb !important; writing-mode: horizontal-tb !important; }";

/// `EpubTranslationOutputKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpubTranslationOutputKind {
    Translated,
    Bilingual,
}

/// `EpubTranslationOutcome`: a stored result of one unit, keyed by
/// `epubBlockKeyString(unit.key)`.
#[derive(Debug, Clone, PartialEq)]
pub struct EpubTranslationOutcome {
    /// `status: 'translated'`; otherwise `'failed'`
    pub translated: bool,
    /// the translation in the block notation; required when translated
    pub text: Option<Vec<u16>>,
    /// why the unit stayed in the source language
    pub reason: Option<String>,
}

pub struct BuildTranslatedEpubOptions<'a> {
    /// zip limits to open with (`EPUB_ZIP_LIMITS`)
    pub limits: &'a ZipLimits,
    pub kind: EpubTranslationOutputKind,
    /// target language code (a BCP 47 tag such as `en`, `zh-TW`)
    pub lang: &'a str,
    /// spine indices that were chosen for translation; default every chapter
    pub chapters: Option<&'a [f64]>,
    pub results: &'a HashMap<String, EpubTranslationOutcome>,
    /// the build time for `dcterms:modified`, a `Date` as its time value
    pub now: f64,
    /// the new identifier's UUID (`xxxxxxxx-xxxx-...`)
    pub uuid: &'a str,
    /// 'easy': the results are an easy explanation's, and the titles carry the
    /// easy-explanation marker in `lang`
    pub mode: TranslationMode,
}

/// `EpubUntranslatedBlock`: a block of a chosen chapter left in the source
/// language. `reason` is the stored reason of a failed result,
/// `not-translated` when there is no result, `placeholder-mismatch` when the
/// stored translation does not fit the block as it is now, `empty-translation`
/// when it has no text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubUntranslatedBlock {
    /// spine index
    pub chapter: usize,
    pub path: String,
    /// the block id of `openChapter`
    pub block_id: String,
    pub reason: String,
}

/// `EpubOriginalChapter`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubOriginalChapter {
    pub chapter: usize,
    pub path: String,
    /// `not-chosen`, `broken` or `fixed-layout`
    pub reason: &'static str,
}

/// `EpubTranslationReport`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubTranslationReport {
    /// chapter blocks that carry their translation
    pub translated_blocks: usize,
    /// blocks of the chosen chapters left in the source language, in book order
    pub untranslated_blocks: Vec<EpubUntranslatedBlock>,
    /// spine items copied as they were, in spine order
    pub original_chapters: Vec<EpubOriginalChapter>,
}

/// `BuildTranslatedEpubRefusal`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildTranslatedEpubRefusal {
    /// the bytes do not open as a book
    NotOpened,
    /// the whole book is fixed-layout (it is not translated)
    FixedLayout,
    /// `lang` is not a language tag
    InvalidLanguage,
    /// a chosen index is not a spine index
    UnknownChapter,
    /// the package document cannot be edited
    BrokenPackage,
    /// an edited entry came out not well-formed (a bug)
    NotWellFormed,
}

impl BuildTranslatedEpubRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotOpened => "not-opened",
            Self::FixedLayout => "fixed-layout",
            Self::InvalidLanguage => "invalid-language",
            Self::UnknownChapter => "unknown-chapter",
            Self::BrokenPackage => "broken-package",
            Self::NotWellFormed => "not-well-formed",
        }
    }
}

/// `BuildTranslatedEpubResult`
#[derive(Debug, PartialEq)]
pub enum BuildTranslatedEpubResult {
    Built {
        bytes: Vec<u8>,
        report: EpubTranslationReport,
        /// the result book's unique identifier (`urn:uuid:...`)
        identifier: String,
    },
    Refused {
        reason: BuildTranslatedEpubRefusal,
        /// English, for the log; not for the screen
        detail: String,
    },
}

/// What `build` stops with: a `Refusal` (an answer), or what it throws.
enum Stop {
    Refusal(BuildTranslatedEpubRefusal, String),
    Thrown(Thrown),
}

impl From<Thrown> for Stop {
    fn from(error: Thrown) -> Self {
        Self::Thrown(error)
    }
}

impl From<NotationError> for Stop {
    fn from(error: NotationError) -> Self {
        match error {
            NotationError::Thrown(thrown) => Self::Thrown(thrown),
            NotationError::Invalid(_) => Self::Thrown(Thrown::new(
                "Error",
                "a notation check answered where a throw was expected",
            )),
        }
    }
}

fn u(text: &str) -> Vec<u16> {
    units(text)
}

fn cat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}

/// `tag.tail.replace(/\s*\/>$/, '>')` of a tail the reader made (`\s*\/?>`)
fn open_the_tail(tail: &mut Vec<u16>) {
    if tail.ends_with(&[0x2F, 0x3E]) && tail[..tail.len() - 2].iter().all(|&unit| is_space(unit)) {
        *tail = vec![0x3E];
    }
}

fn primary_subtag(tag: &str) -> String {
    tag.to_lowercase()
        .split('-')
        .next()
        .unwrap_or("")
        .to_owned()
}

/// `LANGUAGE_TAG`: `/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/`
fn is_language_tag(lang: &str) -> bool {
    let mut parts = lang.split('-');
    let first = parts.next().unwrap_or("");
    (2..=8).contains(&first.len())
        && first.bytes().all(|b| b.is_ascii_alphabetic())
        && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

/// `UUID`: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(at, b)| match at {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// `EASY_EXPLANATION_LABELS`
fn easy_label_of(lang: &str) -> &'static str {
    match lang {
        "zh" => "\u{901a}\u{4fd7}\u{6613}\u{61c2}\u{7248}",
        "en" => "Plain-language version",
        "ja" => "\u{3084}\u{3055}\u{3057}\u{3044}\u{8a00}\u{8449}\u{7248}",
        "ko" => "\u{c26c}\u{c6b4} \u{d480}\u{c774}",
        "fr" => "Version facile \u{e0} lire",
        "de" => "Fassung in einfacher Sprache",
        "es" => "Versi\u{f3}n de lectura f\u{e1}cil",
        "th" => {
            "\u{e09}\u{e1a}\u{e31}\u{e1a}\u{e2d}\u{e48}\u{e32}\u{e19}\u{e07}\u{e48}\u{e32}\u{e22}"
        }
        "id" => "Versi bahasa sederhana",
        "ru" => {
            "\u{412}\u{435}\u{440}\u{441}\u{438}\u{44f} \u{43f}\u{440}\u{43e}\u{441}\u{442}\u{44b}\u{43c} \u{44f}\u{437}\u{44b}\u{43a}\u{43e}\u{43c}"
        }
        "ar" => {
            "\u{646}\u{633}\u{62e}\u{629} \u{628}\u{644}\u{63a}\u{629} \u{645}\u{628}\u{633}\u{637}\u{629}"
        }
        "pt" => "Vers\u{e3}o em linguagem simples",
        "it" => "Versione in linguaggio semplice",
        "pl" => "Wersja w prostym j\u{119}zyku",
        "cs" => "Verze v jednoduch\u{e9}m jazyce",
        "nl" => "Versie in eenvoudige taal",
        "ms" => "Versi bahasa mudah",
        "he" => {
            "\u{5d2}\u{5e8}\u{5e1}\u{5d4} \u{5d1}\u{5e9}\u{5e4}\u{5d4} \u{5e4}\u{5e9}\u{5d5}\u{5d8}\u{5d4}"
        }
        "hi" => {
            "\u{938}\u{930}\u{932} \u{92d}\u{93e}\u{937}\u{93e} \u{938}\u{902}\u{938}\u{94d}\u{915}\u{930}\u{923}"
        }
        "zh-TW" => "\u{6dfa}\u{986f}\u{6613}\u{61c2}\u{7248}",
        "vi" => "B\u{1ea3}n d\u{1ec5} hi\u{1ec3}u",
        _ => "Plain-language version",
    }
}

/// `easyExplanationLabel`: the easy-explanation marker in `lang`; a tag that
/// is not one of the 21 is read as a locale (`zh-Hant` is `zh-TW`, unknown is
/// English).
pub fn easy_explanation_label(lang: &str) -> &'static str {
    easy_label_of(translation_language_of(Some(lang)))
}

/// `escapeText`: text escaped for XML content (characters XML does not allow
/// are left out).
fn escape_text(text: &[u16]) -> Result<Vec<u16>, Thrown> {
    notation_tree_to_xhtml(
        &[NotationNode::Text(text.to_vec())],
        &NotationContext::default(),
    )
}

/// `collapse`: `text.replace(/\s+/g, ' ').trim()`
fn collapse(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut in_run = false;
    for &unit in text {
        if is_space(unit) {
            if !in_run {
                out.push(0x20);
            }
            in_run = true;
        } else {
            out.push(unit);
            in_run = false;
        }
    }
    trim(&out).to_vec()
}

/// `plainLabel`: plain text of a title or contents translation: marks dropped,
/// line breaks as spaces.
fn plain_label(text: &[u16]) -> Result<Option<Vec<u16>>, Thrown> {
    let parsed = match parse_block_notation(trim(text), &NotationContext::default()) {
        Ok(tree) => tree,
        Err(NotationError::Invalid(_)) => return Ok(None),
        Err(NotationError::Thrown(thrown)) => return Err(thrown),
    };
    fn flatten(nodes: &[NotationNode], out: &mut Vec<u16>, depth: usize) -> Result<(), Thrown> {
        let depth = deeper(depth)?;
        for node in nodes {
            match node {
                NotationNode::Text(value) => out.extend_from_slice(value),
                NotationNode::Br { .. } => out.push(0x20),
                NotationNode::X { .. } => {}
                NotationNode::Mark { c, .. } => flatten(c, out, depth)?,
            }
        }
        Ok(())
    }
    let mut flat = Vec::new();
    flatten(&parsed, &mut flat, 0)?;
    let plain = collapse(&flat);
    Ok(if plain.is_empty() { None } else { Some(plain) })
}

/// `BlockOutcome`
enum BlockOutcome {
    Ok(Vec<u16>),
    Untranslated(String),
}

/// `blockOutcome`: the stored result of a block unit, checked again against
/// the block as it is now.
fn block_outcome(
    unit: &EpubTranslationUnit,
    results: &HashMap<String, EpubTranslationOutcome>,
) -> Result<BlockOutcome, Thrown> {
    let Some(result) = results.get(&epub_block_key_string(&unit.key)) else {
        return Ok(BlockOutcome::Untranslated("not-translated".to_owned()));
    };
    if !result.translated {
        return Ok(BlockOutcome::Untranslated(
            result.reason.clone().unwrap_or_else(|| "failed".to_owned()),
        ));
    }
    let Some(text) = &result.text else {
        return Ok(BlockOutcome::Untranslated("empty-translation".to_owned()));
    };
    let tree = match parse_block_notation(trim(text), &unit.context) {
        Ok(tree) => tree,
        Err(NotationError::Invalid(_)) => {
            return Ok(BlockOutcome::Untranslated(
                "placeholder-mismatch".to_owned(),
            ));
        }
        Err(NotationError::Thrown(thrown)) => return Err(thrown),
    };
    if trim(&notation_plain_text(&tree)?).is_empty() {
        return Ok(BlockOutcome::Untranslated("empty-translation".to_owned()));
    }
    Ok(BlockOutcome::Ok(notation_tree_to_xhtml(
        &tree,
        &unit.context,
    )?))
}

// ---------------------------------------------------------------------------
// Text entries being edited

struct TextEntry {
    text: Vec<u16>,
    encoding: String,
    replacements: Vec<RangeReplacement>,
    /// checked as a chapter (HTML entities need the doctype) or masked (package files)
    chapter: bool,
}

struct TextEdits<'a> {
    book: &'a EpubBook,
    entries: Vec<(String, TextEntry)>,
}

impl<'a> TextEdits<'a> {
    fn new(book: &'a EpubBook) -> Self {
        Self {
            book,
            entries: Vec::new(),
        }
    }

    /// The entry's decoded text (its place in `entries`), or `None` when it is
    /// missing or not valid in its encoding.
    fn open(&mut self, path: &str, chapter: bool) -> Result<Option<usize>, Thrown> {
        if let Some(at) = self.entries.iter().position(|(known, _)| known == path) {
            self.entries[at].1.chapter |= chapter;
            return Ok(Some(at));
        }
        let decoded = self
            .book
            .read_text(path)
            .map_err(|message| Thrown::new("Error", message))?;
        let Some(decoded) = decoded.filter(|decoded| decoded.valid) else {
            return Ok(None);
        };
        self.entries.push((
            path.to_owned(),
            TextEntry {
                text: units(&decoded.text),
                encoding: decoded.encoding.label().to_owned(),
                replacements: Vec::new(),
                chapter,
            },
        ));
        Ok(Some(self.entries.len() - 1))
    }

    /// The changed entries' bytes; refuses an entry that would not be well-formed.
    fn encoded(&self) -> Result<Vec<(String, Vec<u8>)>, Stop> {
        let mut out: Vec<(String, Vec<u8>)> = Vec::new();
        for (path, entry) in &self.entries {
            if entry.replacements.is_empty() {
                continue;
            }
            if let Some(problem) =
                validate_replacements(&entry.replacements, entry.text.len() as f64)
            {
                return Err(Stop::Refusal(
                    BuildTranslatedEpubRefusal::NotWellFormed,
                    format!("{path}: {problem}"),
                ));
            }
            let text = apply_replacements(&entry.text, &entry.replacements)
                .map_err(|error| Thrown::new("RangeError", error.0))?;
            if text == entry.text {
                continue;
            }
            let checked = if entry.chapter {
                check_well_formed(&text)
            } else {
                check_well_formed(&mask_undefined_entities(&text))
            };
            if let Err((error, _)) = checked {
                return Err(Stop::Refusal(
                    BuildTranslatedEpubRefusal::NotWellFormed,
                    format!("{path}: {error}"),
                ));
            }
            out.push((path.clone(), encode_entry_text(&text, &entry.encoding)));
        }
        Ok(out)
    }
}

/// `parsePositions`: reads a package-like file for positions, with undefined
/// named references masked. Offsets are those of `text`, which the document
/// takes for its source, as the TypeScript slices `text` with them.
fn parse_positions(text: &[u16]) -> Option<XmlDocument> {
    match parse_xml(&mask_undefined_entities(text)) {
        XmlParseResult::Ok(mut doc) => {
            doc.source = text.to_vec();
            Some(doc)
        }
        XmlParseResult::Err { .. } => None,
    }
}

// ---------------------------------------------------------------------------
// Contents labels

/// A `Map<number, string>`: a key set again keeps its place.
#[derive(Default)]
struct IndexMap(Vec<(usize, Vec<u16>)>);

impl IndexMap {
    fn set(&mut self, index: usize, value: Vec<u16>) {
        match self.0.iter_mut().find(|(known, _)| *known == index) {
            Some(entry) => entry.1 = value,
            None => self.0.push((index, value)),
        }
    }

    fn get(&self, index: usize) -> Option<&[u16]> {
        self.0
            .iter()
            .find(|(known, _)| *known == index)
            .map(|(_, value)| value.as_slice())
    }
}

#[derive(Default)]
struct Labels {
    titles: IndexMap,
    nav: IndexMap,
    ncx: IndexMap,
}

/// `translatedLabels`: the translated title and contents labels by their
/// place, as plain text.
fn translated_labels(
    units: &[EpubTranslationUnit],
    results: &HashMap<String, EpubTranslationOutcome>,
) -> Result<Labels, Thrown> {
    let mut labels = Labels::default();
    for unit in units {
        let Some(result) = results.get(&epub_block_key_string(&unit.key)) else {
            continue;
        };
        let (true, Some(text)) = (result.translated, &result.text) else {
            continue;
        };
        let Some(plain) = plain_label(text)? else {
            continue;
        };
        for source in &unit.sources {
            match source {
                EpubUnitSource::Title { index } => labels.titles.set(*index, plain.clone()),
                EpubUnitSource::Nav { index } => labels.nav.set(*index, plain.clone()),
                EpubUnitSource::Ncx { index } => labels.ncx.set(*index, plain.clone()),
                EpubUnitSource::Block { .. } => {}
            }
        }
    }
    Ok(labels)
}

fn skip_in_titles() -> HashSet<String> {
    ["rt", "rp"].iter().map(|s| (*s).to_owned()).collect()
}

/// `isToc` of `navLabelElements`
fn is_toc(doc: &XmlDocument, el: ElementId) -> bool {
    let namespaced = doc.element(el).attributes.iter().find(|a| {
        a.name.ends_with(":type")
            && namespace_of(doc, el, &a.name[..a.name.len() - 5]).as_deref() == Some(OPS_NS)
    });
    let kind = namespaced
        .map(|a| a.value.as_str())
        .or_else(|| attribute_of(doc, el, "epub:type"))
        .unwrap_or("");
    kind.split([' ', '\t', '\r', '\n'])
        .any(|token| token == "toc")
}

/// `navLabelElements`: the label element of each nav `toc` entry, in the
/// order and with the filter of `navTocEntries`; `None` for an entry whose
/// title is not its text (a `title` attribute or an image's `alt`), which is
/// left as it is.
fn nav_label_elements(
    doc: &XmlDocument,
    root: ElementId,
    nav_path: &str,
) -> Result<Vec<Option<ElementId>>, Thrown> {
    fn list(
        doc: &XmlDocument,
        ol: ElementId,
        nav_path: &str,
        out: &mut Vec<Option<ElementId>>,
        depth: usize,
    ) -> Result<(), Thrown> {
        let depth = deeper(depth)?;
        let skip = skip_in_titles();
        for li in child_elements(doc, ol) {
            if !local_is(doc, li, "li") {
                continue;
            }
            let label = child_elements(doc, li)
                .into_iter()
                .find(|&el| local_is(doc, el, "a") || local_is(doc, el, "span"));
            if let Some(label) = label {
                let text = collapse(&element_text(doc, label, &skip, 0)?);
                let mut title_empty = text.is_empty();
                if title_empty {
                    title_empty = attribute_of(doc, label, "title")
                        .map(trim_str)
                        .unwrap_or("")
                        .is_empty();
                }
                if title_empty {
                    for el in walk_elements(doc, label)? {
                        let alt = if local_is(doc, el, "img") {
                            attribute_of(doc, el, "alt").map(trim_str)
                        } else {
                            None
                        };
                        if alt.is_some_and(|alt| !alt.is_empty()) {
                            title_empty = false;
                            break;
                        }
                    }
                }
                let href = if local_is(doc, label, "a") {
                    attribute_of(doc, label, "href")
                } else {
                    None
                };
                let has_path = href.and_then(|href| resolve_href(nav_path, href)).is_some();
                if !title_empty || has_path {
                    out.push(if text.is_empty() { None } else { Some(label) });
                }
            }
            let nested = child_elements(doc, li)
                .into_iter()
                .find(|&el| local_is(doc, el, "ol"));
            if let Some(nested) = nested {
                list(doc, nested, nav_path, out, depth)?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    for el in walk_elements(doc, root)? {
        if !local_is(doc, el, "nav") || !is_toc(doc, el) {
            continue;
        }
        let ol = walk_elements(doc, el)?
            .into_iter()
            .find(|&child| local_is(doc, child, "ol"));
        if let Some(ol) = ol {
            list(doc, ol, nav_path, &mut out, 0)?;
        }
        return Ok(out);
    }
    Ok(out)
}

/// `ncxLabelElements`: the `text` element of each NCX navPoint, in the order
/// and with the filter of `ncxEntries`.
fn ncx_label_elements(
    doc: &XmlDocument,
    root: ElementId,
    ncx_path: &str,
) -> Result<Vec<Option<ElementId>>, Thrown> {
    fn points(
        doc: &XmlDocument,
        parent: ElementId,
        ncx_path: &str,
        out: &mut Vec<Option<ElementId>>,
        depth: usize,
    ) -> Result<(), Thrown> {
        let depth = deeper(depth)?;
        let skip = skip_in_titles();
        for point in child_elements(doc, parent) {
            if !local_is(doc, point, "navpoint") {
                continue;
            }
            let label = child_elements(doc, point)
                .into_iter()
                .find(|&el| local_is(doc, el, "navlabel"));
            let text = label.and_then(|label| {
                child_elements(doc, label)
                    .into_iter()
                    .find(|&el| local_is(doc, el, "text"))
            });
            let content = child_elements(doc, point)
                .into_iter()
                .find(|&el| local_is(doc, el, "content"));
            let title = match text {
                Some(text) => collapse(&element_text(doc, text, &skip, 0)?),
                None => Vec::new(),
            };
            let src = content.and_then(|content| attribute_of(doc, content, "src"));
            let has_path = src.and_then(|src| resolve_href(ncx_path, src)).is_some();
            if !title.is_empty() || has_path {
                out.push(if title.is_empty() { None } else { text });
            }
            points(doc, point, ncx_path, out, depth)?;
        }
        Ok(())
    }
    let mut out = Vec::new();
    let nav_map = walk_elements(doc, root)?
        .into_iter()
        .find(|&el| local_is(doc, el, "navmap"));
    if let Some(nav_map) = nav_map {
        points(doc, nav_map, ncx_path, &mut out, 0)?;
    }
    Ok(out)
}

type FindLabels = fn(&XmlDocument, ElementId, &str) -> Result<Vec<Option<ElementId>>, Thrown>;

/// `labelEdits`: replaces the labels of one table of contents. Skipped as a
/// whole when the file cannot be read for positions or its entries do not line
/// up with the ones the units were made from. Returns the replaced ranges.
fn label_edits(
    edits: &mut TextEdits,
    path: Option<&str>,
    expected: usize,
    translations: &IndexMap,
    find: FindLabels,
    chapter: bool,
) -> Result<Vec<RangeReplacement>, Thrown> {
    let Some(path) = path.filter(|_| !translations.0.is_empty()) else {
        return Ok(Vec::new());
    };
    let Some(at) = edits.open(path, chapter)? else {
        return Ok(Vec::new());
    };
    let Some(doc) = parse_positions(&edits.entries[at].1.text) else {
        return Ok(Vec::new());
    };
    let labels = find(&doc, doc.root, path)?;
    if labels.len() != expected {
        return Ok(Vec::new());
    }
    let mut done = Vec::new();
    for (index, text) in &translations.0 {
        let Some(Some(label)) = labels.get(*index) else {
            continue;
        };
        if doc.element(*label).self_closing {
            continue;
        }
        let replacement = element_text_replacement(&doc, *label, &escape_text(text)?)?;
        edits.entries[at].1.replacements.push(replacement.clone());
        done.push(replacement);
    }
    Ok(done)
}

// ---------------------------------------------------------------------------
// The package document

struct PackageEditInput<'a> {
    book: &'a EpubBook,
    kind: EpubTranslationOutputKind,
    lang: &'a str,
    identifier: &'a str,
    titles: &'a IndexMap,
    horizontal: bool,
    now: f64,
    /// the easy-explanation marker the titles carry; absent for a plain translation
    easy_label: Option<&'a str>,
}

/// `isDc`
fn is_dc(doc: &XmlDocument, el: ElementId, local: &str) -> bool {
    if doc.element(el).local.to_lowercase() != local {
        return false;
    }
    let name = &doc.element(el).name;
    if name.to_lowercase().starts_with("dc:") {
        return true;
    }
    let prefix = prefix_of(name);
    namespace_of(doc, el, &prefix[..prefix.len().saturating_sub(1)]).as_deref() == Some(DC_NS)
}

/// `freshId`
fn fresh_id(doc: &XmlDocument, root: ElementId, base: &str) -> Result<String, Thrown> {
    let mut used: HashSet<&str> = HashSet::new();
    for el in walk_elements(doc, root)? {
        if let Some(id) = attribute_of(doc, el, "id") {
            used.insert(id);
        }
    }
    let mut id = base.to_owned();
    let mut n = 2;
    while used.contains(id.as_str()) {
        id = format!("{base}-{n}");
        n += 1;
    }
    Ok(id)
}

fn package_edits(entry: &mut TextEntry, o: &PackageEditInput) -> Result<(), Stop> {
    let book = o.book;
    let opf_path = &book.info.opf_path;
    let source = entry.text.clone();
    let doc = parse_positions(&source);
    let root = doc.as_ref().map(|doc| doc.root);
    let metadata = doc.as_ref().zip(root).and_then(|(doc, root)| {
        child_elements(doc, root)
            .into_iter()
            .find(|&el| doc.element(el).local == "metadata")
    });
    let (Some(doc), Some(root), Some(metadata)) = (doc.as_ref(), root, metadata) else {
        return Err(Stop::Refusal(
            BuildTranslatedEpubRefusal::BrokenPackage,
            format!("{opf_path} cannot be read for editing"),
        ));
    };
    let out = &mut entry.replacements;
    let titles_before = &book.info.metadata.titles;

    let dc = |local: &str| -> Result<Vec<ElementId>, Thrown> {
        Ok(walk_elements(doc, metadata)?
            .into_iter()
            .filter(|&el| is_dc(doc, el, local))
            .collect())
    };
    let any_dc = walk_elements(doc, metadata)?.into_iter().find(|&el| {
        is_dc(doc, el, "identifier") || is_dc(doc, el, "title") || is_dc(doc, el, "language")
    });
    let dc_prefix = any_dc.map_or_else(|| "dc:".to_owned(), |el| prefix_of(&doc.element(el).name));
    let dc_line = |local: &str, escaped: &[u16]| -> Vec<u16> {
        cat(&[
            &u(&format!("<{dc_prefix}{local}>")),
            escaped,
            &u(&format!("</{dc_prefix}{local}>")),
        ])
    };
    let line_insertion =
        |line: &[u16]| metadata_line_insertion(&source, doc, metadata, &lossy(line));

    // Titles
    let titles = dc("title")?;
    if titles.len() == titles_before.len() {
        match o.easy_label {
            None => {
                for (index, translation) in &o.titles.0 {
                    let Some(&el) = titles.get(*index) else {
                        continue;
                    };
                    let text = if o.kind == EpubTranslationOutputKind::Translated {
                        translation.clone()
                    } else {
                        cat(&[&u(&titles_before[*index]), &u(" ("), translation, &u(")")])
                    };
                    out.push(element_text_replacement(doc, el, &escape_text(&text)?)?);
                }
            }
            Some(label) => {
                // every title says it is an easy explanation, also one left in the source language
                for (index, &el) in titles.iter().enumerate() {
                    let original = u(&titles_before[index]);
                    let text = match o.titles.get(index) {
                        None => cat(&[&original, &u(&format!(" ({label})"))]),
                        Some(translation) if o.kind == EpubTranslationOutputKind::Translated => {
                            cat(&[translation, &u(&format!(" ({label})"))])
                        }
                        Some(translation) => cat(&[
                            &original,
                            &u(" ("),
                            translation,
                            &u(&format!(" \u{b7} {label})")),
                        ]),
                    };
                    out.push(element_text_replacement(doc, el, &escape_text(&text)?)?);
                }
            }
        }
    }

    // Languages: an easy explanation is in the target language only, also with the original
    let languages = dc("language")?;
    let lang = escape_text(&u(o.lang))?;
    if o.kind == EpubTranslationOutputKind::Translated || o.easy_label.is_some() {
        if languages.is_empty() {
            out.push(line_insertion(&dc_line("language", &lang)));
        }
        for (i, &el) in languages.iter().enumerate() {
            if i == 0 {
                out.push(element_text_replacement(doc, el, &lang)?);
            } else {
                out.push(RangeReplacement {
                    start: whitespace_start(&source, doc.element(el).start) as f64,
                    end: doc.element(el).end as f64,
                    text: Vec::new(),
                });
            }
        }
    } else {
        let has = book
            .info
            .metadata
            .languages
            .iter()
            .any(|l| l.to_lowercase() == o.lang.to_lowercase());
        if !has {
            out.push(match languages.last() {
                Some(&last) => insertion_after(doc, last, &dc_line("language", &lang)),
                None => line_insertion(&dc_line("language", &lang)),
            });
        }
    }

    // Identifier
    let uid_ref = attribute_of(doc, root, "unique-identifier")
        .map(trim_str)
        .filter(|uid| !uid.is_empty());
    let unique = match uid_ref {
        Some(uid) => dc("identifier")?
            .into_iter()
            .find(|&el| attribute_of(doc, el, "id") == Some(uid)),
        None => None,
    };
    let identifier = escape_text(&u(o.identifier))?;
    if let Some(unique) = unique {
        let element = doc.element(unique);
        // an `opf:scheme` other than UUID would misname the new value
        let end = if element.self_closing {
            element.end
        } else {
            element.start_tag_end
        };
        let read = read_start_tag(&source[element.start..end], 0);
        let scheme = read.as_ref().and_then(|(tag, _)| {
            tag.attributes
                .iter()
                .find(|a| a.name == u("scheme") || a.name.ends_with(&u(":scheme")))
                .map(|a| (a.name.clone(), a.value.clone()))
        });
        match (read, scheme) {
            (Some((mut tag, _)), Some((name, value))) if value != u("UUID") => {
                set_tag_attribute(&mut tag, &name, &u("UUID"))?;
                open_the_tail(&mut tag.tail);
                let mut text = write_start_tag(&tag);
                if element.self_closing {
                    text.extend_from_slice(&identifier);
                    text.extend(u(&format!("</{}>", element.name)));
                }
                out.push(RangeReplacement {
                    start: element.start as f64,
                    end: end as f64,
                    text,
                });
                if !element.self_closing {
                    out.push(element_text_replacement(doc, unique, &identifier)?);
                }
            }
            _ => out.push(element_text_replacement(doc, unique, &identifier)?),
        }
        if let Some(old) = book
            .info
            .metadata
            .unique_identifier
            .as_deref()
            .filter(|old| !old.is_empty())
        {
            out.push(insertion_after(
                doc,
                unique,
                &dc_line("source", &escape_text(&u(old))?),
            ));
        }
    } else {
        let id = fresh_id(doc, root, "uid")?;
        out.push(line_insertion(&cat(&[
            &u(&format!("<{dc_prefix}identifier id=\"{id}\">")),
            &identifier,
            &u(&format!("</{dc_prefix}identifier>")),
        ])));
        if let Some(old) = book
            .info
            .metadata
            .identifiers
            .first()
            .map(|i| i.value.as_str())
            .filter(|old| !old.is_empty())
        {
            out.push(line_insertion(&dc_line("source", &escape_text(&u(old))?)));
        }
        if let Some(replacement) = start_tag_replacement(doc, root, |tag| {
            set_tag_attribute(tag, &u("unique-identifier"), &u(&id))
        })? {
            out.push(replacement);
        }
    }

    // Spine direction
    if o.horizontal {
        let spine = child_elements(doc, root)
            .into_iter()
            .find(|&el| doc.element(el).local == "spine");
        if let Some(spine) = spine
            && attribute_of(doc, spine, "page-progression-direction").map(trim_str) != Some("ltr")
            && let Some(replacement) = start_tag_replacement(doc, spine, |tag| {
                set_tag_attribute(tag, &u("page-progression-direction"), &u("ltr"))
            })?
        {
            out.push(replacement);
        }
    }

    // dcterms:modified (EPUB 3)
    if book.info.version == "3" {
        let Some(modified) = modified_replacements(&source, &format_modified_timestamp(o.now)?)
        else {
            return Err(Stop::Refusal(
                BuildTranslatedEpubRefusal::BrokenPackage,
                format!("{opf_path} has no metadata"),
            ));
        };
        out.extend(modified);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Chapters

struct ChapterInput<'a> {
    kind: EpubTranslationOutputKind,
    lang: &'a str,
    rtl: bool,
    horizontal: bool,
    results: &'a HashMap<String, EpubTranslationOutcome>,
}

/// `overlaps`
fn overlaps(block: &ChapterBlock, ranges: &[RangeReplacement]) -> bool {
    ranges
        .iter()
        .any(|r| r.start < block.outer.end as f64 && (block.outer.start as f64) < r.end)
}

/// `copyStartTag`: the start tag of a bilingual copy: no id, the target
/// language and the translation class.
fn copy_start_tag(
    map: &OpenChapter,
    block: &ChapterBlock,
    o: &ChapterInput,
    rtl_chapter: bool,
) -> Result<Vec<u16>, Thrown> {
    let el = map.doc.element(block.element);
    let end = if el.self_closing {
        el.end
    } else {
        el.start_tag_end
    };
    let Some((mut tag, _)) = read_start_tag(&map.source()[el.start..end], 0) else {
        return Err(Thrown::new(
            "TypeError",
            "Cannot read properties of null (reading 'tag')",
        ));
    };
    open_the_tail(&mut tag.tail);
    remove_tag_attributes(&mut tag, &id_attributes());
    let lang = escape_attribute(&u(o.lang));
    set_tag_attribute(&mut tag, &u("lang"), &lang)?;
    set_tag_attribute(&mut tag, &u("xml:lang"), &lang)?;
    let class = match tag_attribute(&tag, &u("class")) {
        Some(cls) if !trim(cls).is_empty() => {
            let mut kept = cls.to_vec();
            while kept.last().is_some_and(|&unit| is_space(unit)) {
                kept.pop();
            }
            cat(&[&kept, &u(&format!(" {EPUB_TRANSLATION_CLASS}"))])
        }
        _ => u(EPUB_TRANSLATION_CLASS),
    };
    set_tag_attribute(&mut tag, &u("class"), &class)?;
    if o.rtl {
        set_tag_attribute(&mut tag, &u("dir"), &u("rtl"))?;
    } else if tag_attribute(&tag, &u("dir")).is_some() || rtl_chapter {
        set_tag_attribute(&mut tag, &u("dir"), &u("ltr"))?;
    }
    Ok(write_start_tag(&tag))
}

/// `inlineTranslation`: the translation of a structural text block (td, th,
/// figcaption, dt, dd) or a list item in a bilingual book: a line break and a
/// marked span appended inside the block, so the table, figure or list keeps
/// its structure.
fn inline_translation(
    map: &OpenChapter,
    block: &ChapterBlock,
    o: &ChapterInput,
    rtl_chapter: bool,
    xhtml: &[u16],
) -> Result<Vec<u16>, Thrown> {
    let element = map.doc.element(block.element);
    let prefix = prefix_of(&element.name);
    let lang = escape_attribute(&u(o.lang));
    let dir = if o.rtl {
        " dir=\"rtl\""
    } else if attribute_of(&map.doc, block.element, "dir").is_some() || rtl_chapter {
        " dir=\"ltr\""
    } else {
        ""
    };
    Ok(cat(&[
        &u(&format!(
            "<{prefix}br/><{prefix}span class=\"{EPUB_TRANSLATION_CLASS}\" lang=\""
        )),
        &lang,
        &u("\" xml:lang=\""),
        &lang,
        &u(&format!("\"{dir}>")),
        &remove_ids(xhtml),
        &u(&format!("</{prefix}span>")),
    ]))
}

/// `horizontalStyle`: the style element that forces horizontal writing, at
/// the end of the chapter's head.
fn horizontal_style(doc: &XmlDocument) -> Option<RangeReplacement> {
    let root = doc.element(doc.root);
    let head = child_elements(doc, doc.root)
        .into_iter()
        .find(|&el| doc.element(el).local == "head");
    let style = |prefix: &str| format!("<{prefix}style>{HORIZONTAL_STYLE}</{prefix}style>");
    let replacement = |start: usize, end: usize, text: String| RangeReplacement {
        start: start as f64,
        end: end as f64,
        text: u(&text),
    };
    if let Some(head) = head {
        let head = doc.element(head);
        let markup = style(&prefix_of(&head.name));
        return Some(if head.self_closing {
            replacement(head.end - 2, head.end, format!(">{markup}</{}>", head.name))
        } else {
            replacement(head.end_tag_start, head.end_tag_start, markup)
        });
    }
    if root.self_closing {
        return None;
    }
    let prefix = prefix_of(&root.name);
    Some(replacement(
        root.start_tag_end,
        root.start_tag_end,
        format!("<{prefix}head>{}</{prefix}head>", style(&prefix)),
    ))
}

/// `chapterEdits`: edits one open chapter; returns how many blocks carry
/// their translation.
fn chapter_edits(
    entry: &mut TextEntry,
    map: &OpenChapter,
    index: usize,
    path: &str,
    reserved: &[RangeReplacement],
    o: &ChapterInput,
    untranslated: &mut Vec<EpubUntranslatedBlock>,
) -> Result<usize, Stop> {
    let source = map.source();
    let doc = &map.doc;
    let root = doc.element(doc.root);
    let is_html = root.local == "html";
    let rtl_chapter = is_html
        && attribute_of(doc, doc.root, "dir")
            .map(|dir| trim_str(dir).to_lowercase())
            .as_deref()
            == Some("rtl");
    let mut translated = 0;
    let mut touched = false;
    for unit in chapter_translation_units(map, index as f64, path)? {
        let Some(EpubUnitSource::Block { block_id, .. }) = unit.sources.first() else {
            continue;
        };
        let block = map
            .blocks
            .iter()
            .find(|b| &b.id == block_id)
            .ok_or_else(|| {
                Thrown::new(
                    "TypeError",
                    "Cannot read properties of undefined (reading 'outer')",
                )
            })?;
        // a contents entry of a nav document that is also a chapter: the label edit wins
        if overlaps(block, reserved) {
            touched = true;
            continue;
        }
        let xhtml = match block_outcome(&unit, o.results)? {
            BlockOutcome::Ok(xhtml) => xhtml,
            BlockOutcome::Untranslated(reason) => {
                untranslated.push(EpubUntranslatedBlock {
                    chapter: index,
                    path: path.to_owned(),
                    block_id: block.id.clone(),
                    reason,
                });
                continue;
            }
        };
        translated += 1;
        touched = true;
        let el = doc.element(block.element);
        if o.kind == EpubTranslationOutputKind::Translated {
            entry.replacements.push(RangeReplacement {
                start: block.inner.start as f64,
                end: block.inner.end as f64,
                text: xhtml,
            });
        } else if !block.flowing || block.kind == crate::blocks::BlockKind::Li {
            // td, th, figcaption, dt, dd: a sibling copy would change the table, figure or
            // list structure, so the translation goes inside, after the original content.
            // A list item likewise: a copied li would renumber an ordered list
            let inline = inline_translation(map, block, o, rtl_chapter, &xhtml)?;
            entry.replacements.push(if el.self_closing {
                RangeReplacement {
                    start: (el.end - 2) as f64,
                    end: el.end as f64,
                    text: cat(&[&u(">"), &inline, &u(&format!("</{}>", el.name))]),
                }
            } else {
                RangeReplacement {
                    start: block.inner.end as f64,
                    end: block.inner.end as f64,
                    text: inline,
                }
            });
        } else {
            let indent = &source[whitespace_start(source, el.start)..el.start];
            let close = if el.self_closing {
                u(&format!("</{}>", el.name))
            } else {
                source[el.end_tag_start..el.end].to_vec()
            };
            let copy = cat(&[
                &copy_start_tag(map, block, o, rtl_chapter)?,
                &remove_ids(&xhtml),
                &close,
            ]);
            entry.replacements.push(RangeReplacement {
                start: el.end as f64,
                end: el.end as f64,
                text: cat(&[indent, &copy]),
            });
        }
    }
    if !touched {
        return Ok(translated);
    }
    if o.kind == EpubTranslationOutputKind::Translated && is_html {
        let lang = escape_attribute(&u(o.lang));
        let replacement = start_tag_replacement(doc, doc.root, |tag| {
            set_tag_attribute(tag, &u("lang"), &lang)?;
            set_tag_attribute(tag, &u("xml:lang"), &lang)?;
            if o.rtl {
                set_tag_attribute(tag, &u("dir"), &u("rtl"))?;
            } else if rtl_chapter {
                set_tag_attribute(tag, &u("dir"), &u("ltr"))?;
            }
            Ok(())
        })?;
        entry.replacements.extend(replacement);
    }
    if o.horizontal {
        entry.replacements.extend(horizontal_style(doc));
    }
    Ok(translated)
}

// ---------------------------------------------------------------------------
// Fonts

/// `hasOriginalFontKey`: whether opening could reveal the font: the key its
/// algorithm needs exists.
fn has_original_font_key(book: &EpubBook, algorithm: &str) -> bool {
    let candidates: Vec<&str> = book
        .info
        .metadata
        .unique_identifier
        .as_deref()
        .into_iter()
        .chain(
            book.info
                .metadata
                .identifiers
                .iter()
                .map(|i| i.value.as_str()),
        )
        .collect();
    if algorithm != ADOBE_FONT_OBFUSCATION {
        return !candidates.is_empty();
    }
    candidates
        .iter()
        .any(|candidate| font_obfuscation_key(ADOBE_FONT_OBFUSCATION, candidate).is_some())
}

// ---------------------------------------------------------------------------

/// A spine item that is translated, or why it is not.
enum State {
    Chapter { index: usize, map: Box<OpenChapter> },
    Original(&'static str),
}

/// `buildTranslatedEpub`: builds the translated or bilingual book from the
/// stored book's bytes and the stored results (see the module comment).
/// `results` holds the results of `epubTranslationUnits(book, { chapters })`
/// keyed by `epubBlockKeyString(unit.key)`; any subset of them works. `Err` is
/// what the TypeScript throws.
pub fn build_translated_epub(
    original: &[u8],
    options: &BuildTranslatedEpubOptions,
) -> Result<BuildTranslatedEpubResult, Thrown> {
    match build(original, options) {
        Ok(result) => Ok(result),
        Err(Stop::Refusal(reason, detail)) => {
            Ok(BuildTranslatedEpubResult::Refused { reason, detail })
        }
        Err(Stop::Thrown(thrown)) => Err(thrown),
    }
}

fn refuse(reason: BuildTranslatedEpubRefusal, detail: String) -> Stop {
    Stop::Refusal(reason, detail)
}

fn build(
    original: &[u8],
    options: &BuildTranslatedEpubOptions,
) -> Result<BuildTranslatedEpubResult, Stop> {
    let (kind, lang, results) = (options.kind, options.lang, options.results);
    if !is_language_tag(lang) {
        return Err(refuse(
            BuildTranslatedEpubRefusal::InvalidLanguage,
            format!("not a language tag: {lang}"),
        ));
    }
    let easy_label = (options.mode == TranslationMode::Easy).then(|| easy_explanation_label(lang));
    let book = match open_epub(original, options.limits) {
        EpubOpenResult::Opened(book) => book,
        EpubOpenResult::Refused { reason, detail } => {
            return Err(refuse(
                BuildTranslatedEpubRefusal::NotOpened,
                format!("{}: {detail}", reason.as_str()),
            ));
        }
    };
    let book = &*book;
    if book.info.fixed_layout {
        return Err(refuse(
            BuildTranslatedEpubRefusal::FixedLayout,
            "the book is fixed-layout".to_owned(),
        ));
    }

    let count = book.info.spine.items.len();
    let mut chosen: HashSet<usize> = HashSet::new();
    let all: Vec<f64> = book
        .info
        .spine
        .items
        .iter()
        .map(|i| i.index as f64)
        .collect();
    for &index in options.chapters.unwrap_or(&all) {
        if index.fract() != 0.0 || index < 0.0 || index >= count as f64 || index.is_nan() {
            return Err(refuse(
                BuildTranslatedEpubRefusal::UnknownChapter,
                format!(
                    "no chapter {} (the book has {count})",
                    number_to_string(index)
                ),
            ));
        }
        chosen.insert(index as usize);
    }
    if !is_uuid(options.uuid) {
        return Err(Thrown::new(
            "RangeError",
            format!("epub translation: not a UUID: {}", options.uuid),
        )
        .into());
    }
    let identifier = format!("urn:uuid:{}", options.uuid.to_lowercase());
    let now = options.now;
    let target = primary_subtag(lang);
    let rtl = RTL_LANGUAGES.contains(&target.as_str());
    let horizontal = book.info.vertical_writing && !VERTICAL_LANGUAGES.contains(&target.as_str());
    let mut edits = TextEdits::new(book);

    // Which chapters are translated, and why the others are not (as epubTranslationUnits decides).
    let mut states: Vec<(String, State)> = Vec::new();
    for item in &book.info.spine.items {
        if !chosen.contains(&item.index) || states.iter().any(|(path, _)| *path == item.path) {
            continue;
        }
        if item.fixed_layout {
            states.push((item.path.clone(), State::Original("fixed-layout")));
            continue;
        }
        let map = match edits.open(&item.path, true)? {
            Some(at) => Some(open_chapter(&PositionsHost, &edits.entries[at].1.text)?),
            None => None,
        };
        states.push((
            item.path.clone(),
            match map {
                Some(ChapterMap::Open(map)) => State::Chapter {
                    index: item.index,
                    map: Box::new(map),
                },
                _ => State::Original("broken"),
            },
        ));
    }
    let mut original_chapters = Vec::new();
    for item in &book.info.spine.items {
        let state = states
            .iter()
            .find(|(path, _)| *path == item.path)
            .map(|(_, state)| state);
        if matches!(state, Some(State::Chapter { .. })) {
            continue;
        }
        let reason = match state {
            Some(State::Original(reason)) if chosen.contains(&item.index) => reason,
            _ => "not-chosen",
        };
        original_chapters.push(EpubOriginalChapter {
            chapter: item.index,
            path: item.path.clone(),
            reason,
        });
    }

    // Title and contents labels.
    let toc_labels = epub_toc_labels(book).map_err(|message| Thrown::new("Error", message))?;
    let metadata_labels = EpubMetadataLabels {
        titles: book.info.metadata.titles.iter().map(|t| u(t)).collect(),
        nav: toc_labels.nav.iter().map(|t| u(t)).collect(),
        ncx: toc_labels.ncx.iter().map(|t| u(t)).collect(),
    };
    let labels = translated_labels(&metadata_translation_units(&metadata_labels), results)?;
    let nav_item = book
        .info
        .manifest
        .iter()
        .find(|m| m.properties.iter().any(|p| p == "nav") && m.path.is_some());
    let ncx_by_id = book.info.spine.toc_id.as_deref().and_then(|toc_id| {
        book.info
            .manifest
            .iter()
            .find(|m| m.id == toc_id && m.path.is_some())
    });
    let ncx_item = ncx_by_id.or_else(|| {
        book.info
            .manifest
            .iter()
            .find(|m| m.media_type == NCX_MEDIA_TYPE && m.path.is_some())
    });
    let mut reserved: HashMap<String, Vec<RangeReplacement>> = HashMap::new();
    let tables: [(Option<&str>, usize, &IndexMap, FindLabels); 2] = [
        (
            nav_item.and_then(|m| m.path.as_deref()),
            toc_labels.nav.len(),
            &labels.nav,
            nav_label_elements,
        ),
        (
            ncx_item.and_then(|m| m.path.as_deref()),
            toc_labels.ncx.len(),
            &labels.ncx,
            ncx_label_elements,
        ),
    ];
    for (path, expected, translations, find) in tables {
        let Some(path) = path.filter(|path| book.has(path)) else {
            continue;
        };
        let is_chapter = states
            .iter()
            .any(|(known, state)| known == path && matches!(state, State::Chapter { .. }));
        let done = label_edits(
            &mut edits,
            Some(path),
            expected,
            translations,
            find,
            is_chapter,
        )?;
        reserved.entry(path.to_owned()).or_default().extend(done);
    }

    // Chapters.
    let mut untranslated_blocks = Vec::new();
    let mut translated_blocks = 0;
    let chapter_input = ChapterInput {
        kind,
        lang,
        rtl,
        horizontal,
        results,
    };
    for (path, state) in &states {
        let State::Chapter { index, map } = state else {
            continue;
        };
        let at = edits
            .open(path, true)?
            .ok_or_else(|| Thrown::new("TypeError", "the chapter is not an entry"))?;
        translated_blocks += chapter_edits(
            &mut edits.entries[at].1,
            map,
            *index,
            path,
            reserved.get(path).map_or(&[][..], Vec::as_slice),
            &chapter_input,
            &mut untranslated_blocks,
        )?;
    }

    // The package document.
    let opf_path = &book.info.opf_path;
    let Some(opf) = edits.open(opf_path, false)? else {
        return Err(refuse(
            BuildTranslatedEpubRefusal::BrokenPackage,
            format!("{opf_path} is not valid text"),
        ));
    };
    package_edits(
        &mut edits.entries[opf].1,
        &PackageEditInput {
            book,
            kind,
            lang,
            identifier: &identifier,
            titles: &labels.titles,
            horizontal,
            now,
            easy_label,
        },
    )?;

    // Write.
    let mut replaced = edits.encoded()?;
    for font in &book.info.obfuscated_fonts {
        if !has_original_font_key(book, &font.algorithm) {
            continue;
        }
        let revealed = book
            .read_for_rendering(&font.path)
            .map_err(|message| Thrown::new("Error", message))?;
        let hidden =
            revealed.and_then(|bytes| obfuscate_font(&bytes, &font.algorithm, &identifier));
        if let Some(hidden) = hidden {
            match replaced.iter_mut().find(|(path, _)| *path == font.path) {
                Some(entry) => entry.1 = hidden,
                None => replaced.push((font.path.clone(), hidden)),
            }
        }
    }
    let replaced_refs: Vec<(&str, Vec<u8>)> = replaced
        .iter()
        .map(|(path, bytes)| (path.as_str(), bytes.clone()))
        .collect();
    let bytes = write_epub_archive(&book.archive.package, &replaced_refs, now)?;
    Ok(BuildTranslatedEpubResult::Built {
        bytes,
        identifier,
        report: EpubTranslationReport {
            translated_blocks,
            untranslated_blocks,
            original_chapters,
        },
    })
}
