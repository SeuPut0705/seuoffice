//! `translate/units.ts`: translation units of a book (spec 8): every editable
//! block of the chosen chapters, in the block notation with ruby readings left
//! out, and the book's title (`dc:title`) and contents labels (`nav` and
//! `toc.ncx`).
//!
//! Left out here: `epubTocLabels` and `epubTranslationUnits`, which read the
//! chapters and the navigation documents from an opened book (`EpubBook`,
//! `parseXml`, `parseHtml`, `navTocEntries`); their callers pass what they read
//! to the two functions below.

use std::collections::HashMap;

use jscompat::js_regex;

use crate::blocks::OpenChapter;
use crate::notation::{
    NotationContext, NotationOptions, encode_block, escape_notation_text, notation_plain_text,
    serialize_notation,
};
use crate::pdf_structure::{InlineRun, TranslationBlockKey, nfc};
use crate::translate::keys::{
    collapse_spaces, epub_chapter_fingerprint, epub_metadata_fingerprint, epub_translation_keys,
};
use crate::utf16::{lossy, trim, units};
use crate::xml_positions_types::Thrown;

/// the `page` of title and contents units (chapter blocks carry their spine index)
pub const EPUB_METADATA_PAGE: f64 = -1.0;

/// where a unit's text is in the book
#[derive(Debug, Clone, PartialEq)]
pub enum EpubUnitSource {
    /// a block of a chapter: the spine index, the chapter's zip path and the block id of `openChapter`
    Block {
        spine_index: f64,
        path: String,
        block_id: String,
    },
    /// the `index`-th `dc:title` (`metadata.titles`)
    Title { index: usize },
    /// the `index`-th entry of the nav `toc` list, as `navTocEntries` lists them
    Nav { index: usize },
    /// the `index`-th NCX navPoint, as `ncxEntries` lists them
    Ncx { index: usize },
}

/// One unit to translate. It fills the job engine's `TranslationSourceBlock`:
/// `runs` is one text run holding the notation text (so the store key follows
/// the formatting too), `page` the spine index (`EPUB_METADATA_PAGE` for title
/// and contents units).
#[derive(Debug, Clone, PartialEq)]
pub struct EpubTranslationUnit {
    pub runs: Vec<InlineRun>,
    pub page_fingerprint: String,
    pub page: f64,
    /// the unit's store key
    pub key: TranslationBlockKey,
    /// the notation text sent to the model
    pub text: Vec<u16>,
    /// the text without notation, for language guessing
    pub plain_text: Vec<u16>,
    /// what a returned notation must match (no placeholders for title and contents)
    pub context: NotationContext,
    /// a chapter block: one source; title and contents: every place with this text
    pub sources: Vec<EpubUnitSource>,
}

/// `Omit<EpubTranslationUnit, 'key'>`
struct Draft {
    runs: Vec<InlineRun>,
    page_fingerprint: String,
    page: f64,
    text: Vec<u16>,
    plain_text: Vec<u16>,
    context: NotationContext,
    sources: Vec<EpubUnitSource>,
}

/// `HAS_LETTER`: `/\p{L}/u`, on a text that has no lone surrogate worth the name
/// (one is no letter, and neither is the U+FFFD it is read as here).
fn has_letter(text: &[u16]) -> bool {
    js_regex!(r"\p{L}", "u").test(&lossy(text))
}

fn text_run(text: &[u16]) -> Vec<InlineRun> {
    vec![InlineRun::text(text.to_vec())]
}

fn with_keys(draft: Vec<Draft>) -> Vec<EpubTranslationUnit> {
    let keys = epub_translation_keys(
        &draft
            .iter()
            .map(|d| (d.runs.as_slice(), d.page_fingerprint.as_str()))
            .collect::<Vec<_>>(),
    );
    draft
        .into_iter()
        .zip(keys)
        .map(|(d, key)| EpubTranslationUnit {
            runs: d.runs,
            page_fingerprint: d.page_fingerprint,
            page: d.page,
            key,
            text: d.text,
            plain_text: d.plain_text,
            context: d.context,
            sources: d.sources,
        })
        .collect()
}

/// `chapterTranslationUnits`: the units of one open chapter, keyed by its path.
pub fn chapter_translation_units(
    map: &OpenChapter,
    index: f64,
    path: &str,
) -> Result<Vec<EpubTranslationUnit>, Thrown> {
    let page_fingerprint = epub_chapter_fingerprint(&units(path));
    let mut draft = Vec::new();
    for block in &map.blocks {
        let (tree, context) = encode_block(map, block, NotationOptions { drop_ruby: true })?;
        let plain_text = notation_plain_text(&tree)?;
        if !has_letter(&plain_text) {
            continue;
        }
        let text = serialize_notation(&tree)?;
        draft.push(Draft {
            runs: text_run(&text),
            page_fingerprint: page_fingerprint.clone(),
            page: index,
            text,
            plain_text,
            context,
            sources: vec![EpubUnitSource::Block {
                spine_index: index,
                path: path.to_owned(),
                block_id: block.id.clone(),
            }],
        });
    }
    Ok(with_keys(draft))
}

/// `EpubMetadataLabels`: the labels title and contents units are made of
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EpubMetadataLabels {
    /// every `dc:title`, in order
    pub titles: Vec<Vec<u16>>,
    /// the nav `toc` entries' titles, in `navTocEntries` order
    pub nav: Vec<Vec<u16>>,
    /// the NCX navPoints' labels, in `ncxEntries` order
    pub ncx: Vec<Vec<u16>>,
}

/// `collapse`
fn collapse(text: &[u16]) -> Vec<u16> {
    trim(&collapse_spaces(text)).to_vec()
}

/// `metadataTranslationUnits`: one unit per distinct label text (whitespace
/// collapsed), listing every place it appears, so the same label is translated
/// once and the same way everywhere. Labels are plain text: the unit text only
/// escapes `&`, `<`, `>`.
pub fn metadata_translation_units(labels: &EpubMetadataLabels) -> Vec<EpubTranslationUnit> {
    // a `Map` in the order its keys were first set
    let mut by_text: HashMap<Vec<u16>, usize> = HashMap::new();
    let mut drafts: Vec<Draft> = Vec::new();
    let fingerprint = epub_metadata_fingerprint();
    let mut add = |label: &[u16], source: EpubUnitSource| {
        let plain_text = collapse(label);
        if !has_letter(&plain_text) {
            return;
        }
        let fold = nfc(&plain_text);
        if let Some(&known) = by_text.get(&fold) {
            drafts[known].sources.push(source);
            return;
        }
        let text = escape_notation_text(&plain_text);
        by_text.insert(fold, drafts.len());
        drafts.push(Draft {
            runs: text_run(&text),
            page_fingerprint: fingerprint.clone(),
            page: EPUB_METADATA_PAGE,
            text,
            plain_text,
            context: NotationContext::default(),
            sources: vec![source],
        });
    };
    for (index, title) in labels.titles.iter().enumerate() {
        add(title, EpubUnitSource::Title { index });
    }
    for (index, title) in labels.nav.iter().enumerate() {
        add(title, EpubUnitSource::Nav { index });
    }
    for (index, title) in labels.ncx.iter().enumerate() {
        add(title, EpubUnitSource::Ncx { index });
    }
    with_keys(drafts)
}
