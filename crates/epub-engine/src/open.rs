//! `open.ts`: opening a book (spec 3). The checks run in the spec's order and
//! the first one that fails decides the refusal:
//!
//! 1. the zip gate (metered inflation, then declared sizes), `damaged` or `too-large`
//! 2. `META-INF/container.xml` names a package document, `not-epub`
//! 3. no `rights.xml`; `encryption.xml` lists only obfuscated fonts, `drm`
//! 4. the package document is XML with a manifest and a spine, `not-epub`
//!
//! The order and compression of the `mimetype` entry are not checked. Nothing
//! is unpacked before the zip gate passes, and chapters are read only when
//! asked for (the spine-built table of contents, used when a book has none, is
//! the one exception).
//!
//! `openEpub` and the readers of `EpubBook` were async; they are synchronous
//! here, and the `Err` of a reader is the message of what its promise rejects
//! with. The JSZip of the TypeScript is `ooxml-pkg`, loaded with the raw record
//! of every entry so that `save.rs` can copy untouched entries through.

use std::collections::HashMap;

use ooxml_pkg::{DEFAULT_ZIP_LIMITS, LoadFailure, Package, ZipLimits, load_zip_package_staged};

use crate::package::{
    CONTAINER_PATH, ENCRYPTION_PATH, Identifier, NotEpubError, ParsedPackage, RIGHTS_PATH,
    package_path_from_container, parse_package, scan_encryption,
};
use crate::primitives::{
    ADOBE_FONT_OBFUSCATION, DecodedText, decode_entry_text, font_obfuscation_key,
    normalize_zip_path, obfuscate_font_with_key,
};
use crate::ranges::writing_mode::{css_declares_vertical_writing, is_vertical_writing_mode};
use crate::toc::{TocSources, build_toc};
use crate::types::{
    EpubBook, EpubBookInfo, EpubIdentifier, EpubManifestItem, EpubMetadata, EpubObfuscatedFont,
    EpubRefusalReason, EpubSpine, EpubSpineItem, FontKey,
};
use crate::xml::{XmlElement, parse_xml};
use crate::xml_positions_types::Thrown;

/// The limits a book is opened with: the ones the other document engines share.
pub const EPUB_ZIP_LIMITS: ZipLimits = DEFAULT_ZIP_LIMITS;

/// `EpubOpenResult`
pub enum EpubOpenResult {
    Opened(Box<EpubBook>),
    Refused {
        reason: EpubRefusalReason,
        /// English, for the log; not for the screen
        detail: String,
    },
}

/// What `openOrRefuse` throws: a `Refusal`, a `NotEpubError`, or anything else
/// (the message of an `Error` is all that is kept).
enum Failure {
    Refusal(EpubRefusalReason, String),
    NotEpub(String),
    Other(String),
}

impl From<NotEpubError> for Failure {
    fn from(error: NotEpubError) -> Self {
        Self::NotEpub(error.0)
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl From<Thrown> for Failure {
    fn from(error: Thrown) -> Self {
        Self::Other(error.message)
    }
}

/// `gateReason`: a limit or a forged size is "too large"; anything
/// structural, including deflate data that does not inflate, is "damaged".
fn gate_reason(message: &str) -> EpubRefusalReason {
    if message.starts_with("zip rejected:") && !message.contains("cannot be inflated") {
        EpubRefusalReason::TooLarge
    } else {
        EpubRefusalReason::Damaged
    }
}

/// File entries of a loaded archive, looked up exactly or, failing that,
/// ignoring case.
pub(crate) struct Archive {
    pub(crate) package: Package,
    pub(crate) names: Vec<String>,
    by_lower_case: HashMap<String, String>,
}

impl Archive {
    fn new(package: Package) -> Self {
        let names: Vec<String> = package
            .parts()
            .iter()
            .filter(|part| !part.is_dir)
            .map(|part| part.name.to_string())
            .collect();
        let mut by_lower_case = HashMap::new();
        for name in &names {
            by_lower_case
                .entry(name.to_lowercase())
                .or_insert_with(|| name.clone());
        }
        Self {
            package,
            names,
            by_lower_case,
        }
    }

    /// The archive's own name for `path`, or `None` when there is no such file entry.
    pub(crate) fn find(&self, path: &str) -> Option<String> {
        let normalized = normalize_zip_path(path);
        if self.package.has(&normalized) {
            return Some(normalized);
        }
        self.by_lower_case.get(&normalized.to_lowercase()).cloned()
    }

    fn read(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(name) = self.find(path) else {
            return Ok(None);
        };
        match self.package.bytes(&name) {
            Ok(bytes) => Ok(bytes.map(<[u8]>::to_vec)),
            Err(error) => Err(error.reason),
        }
    }

    fn read_text(&self, path: &str) -> Result<Option<DecodedText>, String> {
        Ok(self.read(path)?.map(|bytes| decode_entry_text(&bytes)))
    }
}

impl EpubBook {
    /// `has`: whether `path` (normalised; `..` stops at the root) is a file entry.
    pub fn has(&self, path: &str) -> bool {
        self.archive.find(path).is_some()
    }

    /// `read`: the entry's stored bytes (fonts still obfuscated), a fresh copy.
    pub fn read(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        self.archive.read(path)
    }

    /// `readText`: the entry decoded as text (see `decode_entry_text`).
    pub fn read_text(&self, path: &str) -> Result<Option<DecodedText>, String> {
        self.archive.read_text(path)
    }

    /// `readForRendering`: the bytes to draw with, an obfuscated font
    /// revealed. Never use this for saving.
    pub fn read_for_rendering(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(name) = self.archive.find(path) else {
            return Ok(None);
        };
        let Some(bytes) = self.archive.read(&name)? else {
            return Ok(None);
        };
        Ok(Some(match self.font_keys.get(&name) {
            Some(font) => obfuscate_font_with_key(&bytes, &font.algorithm, &font.key),
            None => bytes,
        }))
    }
}

/// `keyFor`: the identifier each algorithm keys from. IDPF uses the unique
/// identifier; Adobe needs a UUID, so it falls back to the first identifier
/// that is one.
fn key_for(
    algorithm: &str,
    unique: Option<&str>,
    identifiers: &[EpubIdentifier],
) -> Option<Vec<u8>> {
    let candidates: Vec<&str> = unique
        .into_iter()
        .chain(
            identifiers
                .iter()
                .map(|identifier| identifier.value.as_str()),
        )
        .collect();
    if algorithm != ADOBE_FONT_OBFUSCATION {
        return candidates
            .first()
            .and_then(|candidate| font_obfuscation_key(algorithm, candidate));
    }
    candidates
        .iter()
        .find_map(|candidate| font_obfuscation_key(algorithm, candidate))
}

/// `openEpub`: opens a book held in memory. Never fails for anything in the
/// file and never changes the bytes it is given.
pub fn open_epub(input: &[u8], limits: &ZipLimits) -> EpubOpenResult {
    match open_or_refuse(input, limits) {
        Ok(book) => EpubOpenResult::Opened(Box::new(book)),
        Err(Failure::Refusal(reason, detail)) => EpubOpenResult::Refused { reason, detail },
        Err(Failure::NotEpub(detail)) => EpubOpenResult::Refused {
            reason: EpubRefusalReason::NotEpub,
            detail,
        },
        Err(Failure::Other(detail)) => EpubOpenResult::Refused {
            reason: EpubRefusalReason::Damaged,
            detail,
        },
    }
}

/// `parseOrNotEpub`
fn parse_or_not_epub(decoded: &DecodedText, path: &str) -> Result<XmlElement, Failure> {
    parse_xml(&decoded.text).map_err(|error| {
        let message = if error.message.is_empty() {
            error.name
        } else {
            error.message
        };
        Failure::NotEpub(format!("{path} is not well-formed XML: {message}"))
    })
}

fn identifier_of(identifier: &Identifier<'_>) -> EpubIdentifier {
    EpubIdentifier {
        id: identifier.id.map(str::to_owned),
        value: identifier.value.clone(),
        scheme: identifier.scheme.map(str::to_owned),
    }
}

fn metadata_of(parsed: &ParsedPackage<'_>) -> EpubMetadata {
    let metadata = &parsed.metadata;
    EpubMetadata {
        title: metadata.title.clone(),
        titles: metadata.titles.clone(),
        creators: metadata.creators.clone(),
        languages: metadata.languages.clone(),
        identifiers: metadata.identifiers.iter().map(identifier_of).collect(),
        unique_identifier: metadata.unique_identifier.clone(),
        layout: metadata.layout,
        primary_writing_mode: metadata.primary_writing_mode.map(str::to_owned),
    }
}

fn open_or_refuse(bytes: &[u8], limits: &ZipLimits) -> Result<EpubBook, Failure> {
    // 1. zip gate
    let package =
        load_zip_package_staged(bytes, limits, true).map_err(|failure| match failure {
            LoadFailure::Gate(message) => Failure::Refusal(gate_reason(&message), message),
            LoadFailure::Archive(message) => Failure::Refusal(
                EpubRefusalReason::Damaged,
                format!("the archive cannot be read: {message}"),
            ),
            LoadFailure::Declared(message) => {
                Failure::Refusal(EpubRefusalReason::TooLarge, message)
            }
        })?;
    let archive = Archive::new(package);

    // 2. container
    let Some(container) = archive.read_text(CONTAINER_PATH)? else {
        return Err(NotEpubError(format!("the archive has no {CONTAINER_PATH}")).into());
    };
    let package_path =
        package_path_from_container(&parse_or_not_epub(&container, CONTAINER_PATH)?)?;
    let Some(opf_path) = archive.find(&package_path) else {
        return Err(NotEpubError(format!(
            "the package document named in {CONTAINER_PATH} is missing"
        ))
        .into());
    };

    // 3. DRM
    if archive.find(RIGHTS_PATH).is_some() {
        return Err(Failure::Refusal(
            EpubRefusalReason::Drm,
            format!("the archive has {RIGHTS_PATH}"),
        ));
    }
    let encryption_tree = match archive.read_text(ENCRYPTION_PATH)? {
        Some(encryption) => Some(parse_or_not_epub(&encryption, ENCRYPTION_PATH)?),
        None => None,
    };
    let scan = encryption_tree.as_ref().map(scan_encryption);
    if let Some(reason) = scan.as_ref().and_then(|scan| scan.drm.as_ref()) {
        return Err(Failure::Refusal(
            EpubRefusalReason::Drm,
            format!("{ENCRYPTION_PATH}: {reason}"),
        ));
    }

    // 4. package document
    let opf_text = archive
        .read_text(&opf_path)?
        .ok_or_else(|| Failure::Other("the package document is not an entry".to_owned()))?;
    let opf_tree = parse_or_not_epub(&opf_text, &opf_path)?;
    let parsed = parse_package(&opf_tree, &opf_path, |path| archive.find(path))?;
    let fixed_layout = parsed.metadata.layout == "pre-paginated";
    let manifest: Vec<EpubManifestItem> = parsed
        .manifest
        .iter()
        .map(|item| EpubManifestItem {
            id: item.id.to_owned(),
            href: item.href.to_owned(),
            path: item.path.clone(),
            media_type: item.media_type.to_owned(),
            properties: item.properties.iter().map(|p| (*p).to_owned()).collect(),
        })
        .collect();
    // `new Map(manifest.map(...))`: of two items with one id, the later is found
    let mut manifest_by_id: HashMap<&str, &EpubManifestItem> = HashMap::new();
    for item in &manifest {
        manifest_by_id.insert(item.id.as_str(), item);
    }
    let mut spine_items: Vec<EpubSpineItem> = Vec::new();
    for reference in &parsed.spine_refs {
        let Some(item) = manifest_by_id.get(reference.idref).copied() else {
            continue;
        };
        let Some(path) = item.path.as_deref().and_then(|path| archive.find(path)) else {
            continue;
        };
        spine_items.push(EpubSpineItem {
            index: spine_items.len(),
            idref: reference.idref.to_owned(),
            path,
            media_type: item.media_type.clone(),
            linear: reference.linear,
            properties: reference
                .properties
                .iter()
                .map(|p| (*p).to_owned())
                .collect(),
            layout: reference.layout,
            fixed_layout: fixed_layout || reference.layout == Some("pre-paginated"),
        });
    }
    if spine_items.is_empty() {
        return Err(NotEpubError(format!("{opf_path} has no chapter in the archive")).into());
    }
    let spine = EpubSpine {
        items: spine_items,
        page_progression_direction: parsed.page_progression_direction.map(str::to_owned),
        toc_id: parsed.toc_id.map(str::to_owned),
    };

    let metadata = metadata_of(&parsed);
    let mut font_keys: HashMap<String, FontKey> = HashMap::new();
    let mut obfuscated_fonts: Vec<EpubObfuscatedFont> = Vec::new();
    for font in scan.iter().flat_map(|scan| scan.fonts.iter()) {
        let Some(name) = archive.find(&font.path) else {
            continue;
        };
        if obfuscated_fonts.iter().any(|f| f.path == name) {
            continue;
        }
        obfuscated_fonts.push(EpubObfuscatedFont {
            path: name.clone(),
            algorithm: font.algorithm.to_owned(),
        });
        if let Some(key) = key_for(
            font.algorithm,
            metadata.unique_identifier.as_deref(),
            &metadata.identifiers,
        ) {
            font_keys.insert(
                name,
                FontKey {
                    algorithm: font.algorithm.to_owned(),
                    key,
                },
            );
        }
    }

    let toc = build_toc(&TocSources {
        manifest: &manifest,
        spine: &spine,
        find_entry: &|path| archive.find(path),
        read_text: &|path| archive.read_text(path),
    })?;

    let vertical_writing = detect_vertical_writing(&archive, &metadata, &manifest)?;
    let info = EpubBookInfo {
        opf_path,
        version: parsed.version,
        package_version: parsed.package_version.to_owned(),
        metadata,
        manifest,
        spine,
        toc,
        fixed_layout,
        vertical_writing,
        obfuscated_fonts,
        entry_names: archive.names.clone(),
    };
    Ok(EpubBook {
        info,
        archive,
        font_keys,
    })
}

/// `detectVerticalWriting`
fn detect_vertical_writing(
    archive: &Archive,
    metadata: &EpubMetadata,
    manifest: &[EpubManifestItem],
) -> Result<bool, Failure> {
    if is_vertical_writing_mode(metadata.primary_writing_mode.as_deref()) {
        return Ok(true);
    }
    for item in manifest {
        let Some(path) = item.path.as_deref() else {
            continue;
        };
        if item.media_type != "text/css" {
            continue;
        }
        if let Some(css) = archive.read_text(path)?
            && css_declares_vertical_writing(&css.text)
        {
            return Ok(true);
        }
    }
    Ok(false)
}
