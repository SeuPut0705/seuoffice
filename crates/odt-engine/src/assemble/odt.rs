//! `assemble/odt.ts`: opening a received ODT for the Word editor and saving the
//! edited docx back into it.
//!
//! Save order (each layer documents its own step):
//!   prepareObjectWriteBack, preparePageWriteBack, rebuildOdtBody,
//!   updateOdtStyles, finish, applyTextPatches, objectPackageChanges,
//!   patchManifestXml, re-pack.
//! The bridge map is copied first: the page and objects pre-steps edit the map
//! they are given.

use std::borrow::Cow;
use std::rc::Rc;

use docx_engine::parse::drawings::host::NoHost;
use docx_engine::parse::parse_docx;
use jscompat::JsMap;
use ooxml_pkg::DEFAULT_ZIP_LIMITS;
use serde::Serialize;

use super::meta::{
    BridgeCoreProps, core_xml_for, personal_info_removed, read_meta_people, scrub_meta_xml,
};
use super::registry::odt_registry;
use super::report::{
    ConversionReport, ReportBuilder, ReportFeature, ReportKind, hidden_from_ai_marks,
    odt_to_docx_report,
};
use super::zip::{ZipEntryInput, write_zip};
use crate::core::{
    BridgeMap, DocxExtraPart, DocxPartData, HostNow, OdfToOoxmlContext, OdtDocument, OdtError,
    OoxmlToOdfContext, OoxmlToOdfOptions, OpenOdtOptions, apply_text_patches, build_bridge_docx,
    convert_odt_body, open_odt, read_docx_part, rebuild_odt_body,
};
use crate::objects::package::{FinalParts, OdtPackageChanges, object_package_changes};
use crate::objects::{patch_manifest_xml, prepare_object_write_back};
use crate::page::{convert_odt_page, prepare_page_write_back};
use crate::text::{convert_odt_styles, update_odt_styles};

/// `ASSEMBLE_EXT_KEY`: the assembly's own slot in the bridge map.
pub const ASSEMBLE_EXT_KEY: &str = "assemble";

/// `AssembleExt`
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AssembleExt {
    pub version: u32,
    /// people fields the bridge docx's core.xml shows, or `None` when it has none
    pub core: Option<BridgeCoreProps>,
}

/// `OdtToDocxResult`
#[derive(Debug)]
pub struct OdtToDocxResult {
    /// the bridge docx the Word editor opens
    pub docx_bytes: Vec<u8>,
    /// the bridge map (plain JSON): pass it back to `saveOdt`
    pub bridge: BridgeMap,
    /// what changes if this ODT is saved as docx
    pub report: ConversionReport,
}

/// `odtToDocx`: converts a received ODT for the Word editor. Fails with an
/// open error (encrypted, not an ODT, corrupt). `now` is the host's clock,
/// which the docx writer stamps its entries with.
pub fn odt_to_docx(odt_bytes: &[u8], now: HostNow) -> Result<OdtToDocxResult, OdtError> {
    let doc = Rc::new(open_odt(odt_bytes, &OpenOdtOptions::default())?);
    let mut ctx = OdfToOoxmlContext::new(Rc::clone(&doc), Rc::new(odt_registry()));
    convert_odt_styles(&mut ctx)?;
    convert_odt_body(&mut ctx)?;
    convert_odt_page(&mut ctx)?;
    let people = read_meta_people(&doc);
    let core = core_xml_for(&doc, &people);
    let has_core = core.is_some();
    if let Some(core) = core {
        ctx.docx.parts.push(DocxExtraPart {
            path: "docProps/core.xml".to_owned(),
            data: DocxPartData::Text(core),
            content_type: Some(
                "application/vnd.openxmlformats-package.core-properties+xml".to_owned(),
            ),
        });
    }
    ctx.ext_shared(ASSEMBLE_EXT_KEY, || AssembleExt {
        version: 1,
        core: has_core.then_some(people),
    });
    let docx_bytes = build_bridge_docx(&ctx, now)?;
    let bridge = ctx.take_map()?;
    let report = odt_to_docx_report(&doc, &bridge);
    Ok(OdtToDocxResult {
        docx_bytes,
        bridge,
        report,
    })
}

/// What `saveOdt` writes: the very bytes it was given, or the new package.
#[derive(Debug)]
pub enum SavedOdt {
    /// nothing changed: the original bytes come back as they are
    Unchanged,
    Bytes(Vec<u8>),
}

/// `SaveOdtResult`
#[derive(Debug)]
pub struct SaveOdtResult {
    pub saved: SavedOdt,
    /// what the saved ODT does not keep of the edited docx
    pub report: ConversionReport,
}

/// `saveOdt`: writes the edited docx back into the received ODT: only what
/// changed is rewritten, every untouched part keeps its bytes. With nothing
/// changed the original bytes come back as they are.
pub fn save_odt(
    original_odt: &[u8],
    bridge: &BridgeMap,
    edited_docx: &[u8],
    now: HostNow,
) -> Result<SaveOdtResult, OdtError> {
    let doc = Rc::new(open_odt(original_odt, &OpenOdtOptions::default())?);
    let map = bridge.clone();
    // `map.ext[ASSEMBLE_EXT_KEY]?.core ?? null`
    let bridge_core: Option<BridgeCoreProps> = map
        .ext
        .get(ASSEMBLE_EXT_KEY)
        .and_then(|ext| ext.get("core"))
        .and_then(|core| serde_json::from_value(core.clone()).ok());
    let edited = Rc::new(parse_docx(edited_docx, &NoHost).map_err(OdtError::thrown)?);
    // `JSZip.loadAsync(editedDocx)`: `parseDocx` already passed the gate
    let edited_zip = ooxml_pkg::load_package(edited_docx, &DEFAULT_ZIP_LIMITS, |_| Ok(()))
        .map_err(OdtError::thrown)?;
    let report = ReportBuilder::new()
        .add(
            ReportKind::Dropped,
            ReportFeature::HiddenFromAi,
            hidden_from_ai_marks(&edited_zip)?,
        )
        .build();
    let edited_styles_xml = read_docx_part(edited_docx, "word/styles.xml")?;
    let mut rctx = OoxmlToOdfContext::new(
        Rc::clone(&doc),
        map,
        Rc::clone(&edited),
        Rc::new(odt_registry()),
        OoxmlToOdfOptions { edited_styles_xml },
    );
    prepare_object_write_back(&mut rctx)?;
    let items = prepare_page_write_back(&mut rctx)?;
    rebuild_odt_body(&mut rctx, Some(items))?;
    update_odt_styles(&mut rctx)?;
    let patches = rctx.finish();
    let content_xml = apply_text_patches(&doc.content_xml.text, &patches.content)?;
    let styles_xml = match doc.styles_xml.as_ref() {
        None => None,
        Some(styles) => Some(apply_text_patches(&styles.text, &patches.styles)?),
    };
    let changes = object_package_changes(
        &mut rctx,
        &FinalParts {
            content_xml: &content_xml,
            styles_xml: styles_xml.as_deref(),
        },
    )?;

    let mut replaced: JsMap<Replacement> = JsMap::new();
    if content_xml != doc.content_xml.text {
        replaced.set("content.xml", Replacement::Text(content_xml.clone()));
    }
    if let Some(styles) = styles_xml.as_ref()
        && doc.styles_xml.as_ref().map(|s| s.text.as_str()) != Some(styles.as_str())
    {
        replaced.set("styles.xml", Replacement::Text(styles.clone()));
    }
    if let Some(manifest_xml) = doc.pkg.text("META-INF/manifest.xml") {
        let patched = patch_manifest_xml(&manifest_xml, &changes);
        if patched != manifest_xml {
            replaced.set("META-INF/manifest.xml", Replacement::Text(patched));
        }
    }
    if let Some(meta_xml) = doc.meta_xml.as_ref() {
        let core_xml = read_docx_part(edited_docx, "docProps/core.xml")?;
        if personal_info_removed(
            bridge_core.as_ref(),
            core_xml.as_deref(),
            edited.remove_personal_info,
        ) {
            let scrubbed = scrub_meta_xml(meta_xml);
            if &scrubbed != meta_xml {
                replaced.set("meta.xml", Replacement::Text(scrubbed));
            }
        }
    }
    if replaced.is_empty() && changes.add.is_empty() && changes.remove.is_empty() {
        return Ok(SaveOdtResult {
            saved: SavedOdt::Unchanged,
            report,
        });
    }
    Ok(SaveOdtResult {
        saved: SavedOdt::Bytes(repack_odt(&doc, &replaced, &changes, now)?),
        report,
    })
}

/// The value type of `repackOdt`'s `replaced` map: `string | Uint8Array`.
#[derive(Clone, Debug, PartialEq)]
pub enum Replacement {
    Text(String),
    Bytes(Vec<u8>),
}

/// `repackOdt`: re-packs the package: `mimetype` first and stored, the other
/// entries in their original order (untouched ones from their original
/// compressed data), removed entries left out, new entries at the end.
pub fn repack_odt(
    doc: &OdtDocument,
    replaced: &JsMap<Replacement>,
    changes: &OdtPackageChanges,
    now: HostNow,
) -> Result<Vec<u8>, OdtError> {
    let removed = |name: &str| {
        changes.remove.iter().any(|r| {
            let base = r.strip_suffix('/').unwrap_or(r);
            name == r
                || name == base
                || name
                    .strip_prefix(base)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    };
    let mut inputs: Vec<ZipEntryInput<'_>> = Vec::new();
    if let Some(mimetype) = doc.pkg.get("mimetype") {
        inputs.push(if mimetype.method == 0 {
            ZipEntryInput::Original {
                pkg: &doc.pkg,
                entry: mimetype,
            }
        } else {
            ZipEntryInput::Data {
                name: "mimetype".to_owned(),
                data: Cow::Borrowed(&mimetype.bytes),
                store: true,
                dos_date_time: Some(mimetype.dos_date_time),
            }
        });
    }
    let mut seen: JsMap<()> = JsMap::new();
    seen.set("mimetype", ());
    for entry in &doc.pkg.entries {
        if seen.has(&entry.name) {
            continue;
        }
        seen.set(entry.name.as_str(), ());
        if removed(&entry.name) {
            continue;
        }
        match replaced.get(&entry.name) {
            None => inputs.push(ZipEntryInput::Original {
                pkg: &doc.pkg,
                entry,
            }),
            Some(now_data) => inputs.push(ZipEntryInput::Data {
                name: entry.name.clone(),
                data: match now_data {
                    Replacement::Text(text) => Cow::Borrowed(text.as_bytes()),
                    Replacement::Bytes(bytes) => Cow::Borrowed(bytes.as_slice()),
                },
                store: false,
                dos_date_time: Some(entry.dos_date_time),
            }),
        }
    }
    for a in &changes.add {
        if seen.has(&a.path) {
            continue;
        }
        seen.set(a.path.as_str(), ());
        inputs.push(ZipEntryInput::Data {
            name: a.path.clone(),
            data: Cow::Borrowed(&a.data),
            store: false,
            dos_date_time: None,
        });
    }
    write_zip(&inputs, now)
}
