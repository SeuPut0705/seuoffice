//! `core/open.ts`: `open_odt`, the one entry point that turns ODT bytes into
//! the core model: the package (raw entries in original order), the
//! manifest, the body's position map and the style table. Rejections are
//! typed (`OdtError::Open`).

use std::rc::Rc;

use super::body::{OdtBody, scan_odt_body};
use super::errors::{OdtError, OdtOpenErrorCode};
use super::manifest::{OdtManifest, read_manifest};
use super::meta::{OdtGenerator, detect_generator};
use super::package::{ODT_TEXT_MEDIA_TYPE, OdtPackage, ReadOdtPackageOptions, read_odt_package};
use super::styles::{OdtStyleTable, read_odt_styles};
use super::xml::{decode_xml_entities, read_root};
use crate::offset::IndexedText;

/// `OdtDocument`
pub struct OdtDocument {
    pub pkg: OdtPackage,
    pub manifest: OdtManifest,
    /// decoded content.xml; every body offset indexes this string (bytes
    /// inside the engine, `U16` through `IndexedText` where JSON holds them)
    pub content_xml: Rc<IndexedText>,
    /// decoded styles.xml, or `None` when the package has none
    pub styles_xml: Option<Rc<IndexedText>>,
    /// decoded meta.xml, or `None`
    pub meta_xml: Option<String>,
    pub body: OdtBody,
    pub styles: OdtStyleTable,
    pub generator: OdtGenerator,
    /// `office:version` of the content (or styles/meta) root; `None` when absent, as in Hancom files
    pub office_version: Option<String>,
}

/// `OpenOdtOptions`
pub type OpenOdtOptions = ReadOdtPackageOptions;

/// `openOdt`: opens an ODT leniently: `mimetype` anywhere and in any
/// compression, no `office:version`, schema errors. Fails with `OdtError::Open`:
/// `zip-rejected` (size / bomb gate), `corrupt`, `not-odt-text`, `encrypted`.
pub fn open_odt(bytes: &[u8], options: &OpenOdtOptions) -> Result<OdtDocument, OdtError> {
    let pkg = read_odt_package(bytes, options)?;
    if pkg.mimetype.as_deref() != Some(ODT_TEXT_MEDIA_TYPE) {
        return Err(OdtError::not_text(pkg.mimetype.as_deref()));
    }
    let manifest = read_manifest(pkg.text("META-INF/manifest.xml").as_deref());
    if manifest.encrypted {
        return Err(OdtError::encrypted());
    }
    let Some(content) = pkg.text("content.xml") else {
        return Err(OdtError::open(
            OdtOpenErrorCode::Corrupt,
            "odt: content.xml is missing",
        ));
    };
    let styles_xml = pkg.text("styles.xml");
    let meta_xml = pkg.text("meta.xml");
    let content_xml = Rc::new(IndexedText::new(content));
    let body = scan_odt_body(Rc::clone(&content_xml))?;
    let styles = read_odt_styles(styles_xml.as_deref(), &content_xml.text);
    let generator = detect_generator(meta_xml.as_deref());
    let office_version = office_version_of(Some(&content_xml.text))
        .or_else(|| office_version_of(styles_xml.as_deref()))
        .or_else(|| office_version_of(meta_xml.as_deref()));
    Ok(OdtDocument {
        pkg,
        manifest,
        content_xml,
        styles_xml: styles_xml.map(|xml| Rc::new(IndexedText::new(xml))),
        meta_xml,
        body,
        styles,
        generator,
        office_version,
    })
}

/// `officeVersionOf`
fn office_version_of(xml: Option<&str>) -> Option<String> {
    let root = xml.filter(|x| !x.is_empty()).and_then(read_root)?;
    root.attributes
        .iter()
        .find(|a| root.prefixes.canonical(&a.name) == "office:version")
        .map(|a| decode_xml_entities(&a.raw))
}
