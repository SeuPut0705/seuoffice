//! `types.ts`: the book model `openEpub` returns (spec 3). Plain data, apart
//! from the entry readers of `EpubBook`; nothing here is read from the zip until
//! asked. The fields keep the order of the TypeScript interfaces, which is the
//! order of the objects `open.ts` and `toc.ts` build.

use std::collections::HashMap;

use serde::Serialize;

use crate::open::Archive;

/// Why a book was not opened (`EpubRefusalReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpubRefusalReason {
    Damaged,
    TooLarge,
    NotEpub,
    Drm,
}

impl EpubRefusalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Damaged => "damaged",
            Self::TooLarge => "too-large",
            Self::NotEpub => "not-epub",
            Self::Drm => "drm",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EpubIdentifier {
    /// the element's `id`, which `unique-identifier` may point at
    pub id: Option<String>,
    pub value: String,
    /// `opf:scheme` (EPUB 2), when given
    pub scheme: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubMetadata {
    pub title: String,
    pub titles: Vec<String>,
    pub creators: Vec<String>,
    pub languages: Vec<String>,
    pub identifiers: Vec<EpubIdentifier>,
    pub unique_identifier: Option<String>,
    /// `reflowable` or `pre-paginated`
    pub layout: &'static str,
    pub primary_writing_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubManifestItem {
    pub id: String,
    /// the href as written in the package document
    pub href: String,
    /// the zip entry path the href resolves to; `None` for an href with a scheme
    pub path: Option<String>,
    pub media_type: String,
    pub properties: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubSpineItem {
    /// position among the usable spine items, from 0
    pub index: usize,
    pub idref: String,
    /// zip entry path of the chapter; always present in the archive
    pub path: String,
    pub media_type: String,
    pub linear: bool,
    pub properties: Vec<String>,
    pub layout: Option<&'static str>,
    pub fixed_layout: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubSpine {
    pub items: Vec<EpubSpineItem>,
    /// `ltr`, `rtl` or `default`
    pub page_progression_direction: Option<String>,
    pub toc_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubTocEntry {
    pub title: String,
    pub path: Option<String>,
    pub fragment: Option<String>,
    pub depth: u32,
    pub spine_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EpubToc {
    /// `nav`, `ncx` or `spine`
    pub source: &'static str,
    pub entries: Vec<EpubTocEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EpubObfuscatedFont {
    pub path: String,
    pub algorithm: String,
}

/// Everything about an opened book that is plain data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubBookInfo {
    pub opf_path: String,
    /// major version: `3` for 3.x packages, `2` otherwise
    pub version: &'static str,
    pub package_version: String,
    pub metadata: EpubMetadata,
    pub manifest: Vec<EpubManifestItem>,
    pub spine: EpubSpine,
    pub toc: EpubToc,
    pub fixed_layout: bool,
    pub vertical_writing: bool,
    pub obfuscated_fonts: Vec<EpubObfuscatedFont>,
    /// every file entry in the archive, in the archive's order
    pub entry_names: Vec<String>,
}

/// The key a font entry is revealed with.
pub(crate) struct FontKey {
    pub algorithm: String,
    pub key: Vec<u8>,
}

/// An opened book: the plain data plus access to its entries. Only
/// `open_epub` makes one, so every book has passed the zip gate and holds the
/// archive it was read from, which `save_epub` writes again.
pub struct EpubBook {
    pub info: EpubBookInfo,
    pub(crate) archive: Archive,
    pub(crate) font_keys: HashMap<String, FontKey>,
}
