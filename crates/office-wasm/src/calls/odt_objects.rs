//! `odtObjects.*`: the exports of `packages/odt-engine/src/objects` whose
//! arguments are plain data, answering to their TypeScript names.
//!
//! `text` is the first string parameter the function reads (`xml`, `url`,
//! `href`, `id`, `name`, `manifestXml`; `kind` for `noteKey`); every other
//! parameter is `args.<its TypeScript name>`. `Uint8Array` crosses as
//! `{ "$bytes": base64 }`. Offsets in arguments and results are UTF-16 code
//! units.
//!
//! The functions that take an `OdtDocument` (`entriesOf`, `graphicProps`,
//! `textWidthEmu`, `anchorOf`, `analyzeObject`) read it from `args.doc`, the
//! bytes of an ODT package, opened as `openOdt` opens it. A function that
//! takes a `PrefixMap` (`subElements`, `plainTextOf`, `analyzeObject`) gets
//! the map of the root element of `text`, `readRoot(text)?.prefixes`.
//! `paragraphNeedsRewrite`, `objectPackageChanges`, `prepareObjectWriteBack`,
//! `writeDrawing`, `registerObjectConverters`, `objectsExtOf`, `saveState`,
//! `sourceOf`, `addPictureEntry`, `editedNote`, `forwardState`, `bridgeMedia`,
//! `neutralMedia` and `lazyPart` take a conversion context and are not here.

use docx_engine::model::Bytes;
use jscompat::{JsNum, JsObject};
use std::rc::Rc;

use odt_engine::core::open::{OpenOdtOptions, open_odt};
use odt_engine::core::styles::OdtStylePart;
use odt_engine::core::xml::{PrefixMap, read_root};
use odt_engine::objects::analyze::{
    AnalysisImage, AnalysisPreview, AnalysisType, DRAW_OBJECT_NAMES, ObjectAnalysis,
    ObjectAnchorFacts, ObjectElement, SubElement, analyze_object, anchor_of, entries_of,
    graphic_props, href_path, plain_text_of, sub_elements, text_width_emu,
};
use odt_engine::objects::geometry::{
    DrawingSpec, EMU_PER_CM, drawing_xml, drawings_of, emu_to_cm, length_to_emu, read_drawing,
};
use odt_engine::objects::media::{
    ImageFormat, NEUTRAL_PLACEHOLDER_PNG, base64_decode, base64_encode, data_url_bytes, same_bytes,
    sniff_image,
};
use odt_engine::objects::model::{
    NoteKind, OBJECT_KINDS, OBJECTS_EXT_KEY, OBJECTS_OWNER, ODT_KEEP_PREFIX, ODT_PICTURE_PREFIX,
    ObjectKind, empty_objects_ext, keep_name, parse_keep_name, parse_picture_name, picture_name,
};
use odt_engine::objects::package::{OdtPackageChanges, patch_manifest_xml};
use odt_engine::objects::state::{AddedEntry, note_key};
use odt_engine::offset::{IndexedText, U16};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Returned, arg, byte_past_end, required, u16_past_end, value};

/// The `doc` argument: an ODT package, opened.
fn doc_of(args: &Value) -> Result<odt_engine::core::open::OdtDocument, String> {
    let bytes: Bytes = required(args, "doc")?;
    open_odt(&bytes.0, &OpenOdtOptions::default()).map_err(|error| error.to_string())
}

/// `readRoot(xml)?.prefixes`
fn prefixes_of(xml: &str) -> Rc<PrefixMap> {
    read_root(xml).map_or_else(|| Rc::new(PrefixMap::new()), |root| root.prefixes)
}

/// `SubElement` with its offsets as UTF-16 counts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubElementWire {
    name: String,
    start: U16,
    name_end: U16,
    open_end: U16,
    close_start: U16,
    end: U16,
    self_closing: bool,
    depth: usize,
    attrs: JsObject<String>,
}

fn sub_element_wire(xml: &IndexedText, sub: SubElement) -> SubElementWire {
    SubElementWire {
        start: U16(u16_past_end(xml, sub.start)),
        name_end: U16(u16_past_end(xml, sub.name_end)),
        open_end: U16(u16_past_end(xml, sub.open_end)),
        close_start: U16(u16_past_end(xml, sub.close_start)),
        end: U16(u16_past_end(xml, sub.end)),
        name: sub.name,
        self_closing: sub.self_closing,
        depth: sub.depth,
        attrs: sub.attrs,
    }
}

#[derive(Serialize)]
struct AnchorFactsWire {
    #[serde(rename = "type")]
    r#type: Option<String>,
    #[serde(rename = "xEmu")]
    x_emu: Option<JsNum>,
    #[serde(rename = "yEmu")]
    y_emu: Option<JsNum>,
    z: JsNum,
    #[serde(rename = "styleName")]
    style_name: Option<String>,
}

#[derive(Deserialize)]
struct AnchorFactsArg {
    #[serde(rename = "type", default)]
    r#type: Option<String>,
    #[serde(rename = "xEmu", default)]
    x_emu: Option<JsNum>,
    #[serde(rename = "yEmu", default)]
    y_emu: Option<JsNum>,
    z: JsNum,
    #[serde(rename = "styleName", default)]
    style_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageWire {
    href: String,
    entry: String,
    start: U16,
    open_end: U16,
    bytes: Bytes,
    format: ImageFormat,
}

#[derive(Serialize)]
struct PreviewWire {
    bytes: Bytes,
    format: ImageFormat,
}

#[derive(Serialize)]
struct AnalysisWire {
    #[serde(rename = "type")]
    r#type: &'static str,
    kind: ObjectKind,
    #[serde(rename = "widthEmu")]
    width_emu: JsNum,
    #[serde(rename = "heightEmu")]
    height_emu: JsNum,
    anchor: AnchorFactsWire,
    entries: Vec<String>,
    image: Option<ImageWire>,
    preview: Option<PreviewWire>,
}

fn analysis_wire(xml: &IndexedText, a: ObjectAnalysis) -> AnalysisWire {
    AnalysisWire {
        r#type: match a.r#type {
            AnalysisType::Skip => "skip",
            AnalysisType::Picture => "picture",
            AnalysisType::Placeholder => "placeholder",
        },
        kind: a.kind,
        width_emu: JsNum(a.width_emu),
        height_emu: JsNum(a.height_emu),
        anchor: AnchorFactsWire {
            r#type: a.anchor.r#type,
            x_emu: a.anchor.x_emu.map(JsNum),
            y_emu: a.anchor.y_emu.map(JsNum),
            z: JsNum(a.anchor.z),
            style_name: a.anchor.style_name,
        },
        entries: a.entries,
        image: a.image.map(
            |AnalysisImage {
                 href,
                 entry,
                 start,
                 open_end,
                 bytes,
                 format,
             }| ImageWire {
                href,
                entry,
                start: xml.to_u16(start),
                open_end: xml.to_u16(open_end),
                bytes: Bytes(bytes),
                format,
            },
        ),
        preview: a
            .preview
            .map(|AnalysisPreview { bytes, format }| PreviewWire {
                bytes: Bytes(bytes),
                format,
            }),
    }
}

/// The `el` argument of `analyzeObject`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElementArg {
    name: String,
    start: U16,
    name_end: U16,
    open_end: U16,
    close_start: U16,
}

/// The `changes` argument of `patchManifestXml`.
#[derive(Deserialize)]
struct ChangesArg {
    add: Vec<AddedArg>,
    remove: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddedArg {
    path: String,
    data: Bytes,
    media_type: String,
}

/// The constants of the layer, by TypeScript name.
fn constant(name: &str) -> Returned {
    match name {
        "EMU_PER_CM" => value(JsNum(EMU_PER_CM)),
        "OBJECTS_OWNER" => value(OBJECTS_OWNER),
        "OBJECTS_EXT_KEY" => value(OBJECTS_EXT_KEY),
        "ODT_KEEP_PREFIX" => value(ODT_KEEP_PREFIX),
        "ODT_PICTURE_PREFIX" => value(ODT_PICTURE_PREFIX),
        "OBJECT_KINDS" => value(OBJECT_KINDS),
        "DRAW_OBJECT_NAMES" => value(DRAW_OBJECT_NAMES),
        "NEUTRAL_PLACEHOLDER_PNG" => value(Bytes(NEUTRAL_PLACEHOLDER_PNG.to_vec())),
        "emptyObjectsExt" => value(empty_objects_ext()),
        _ => Err(format!("no constant {name}")),
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constant" => constant(&required::<String>(args, "name")?),
        // media.ts
        "sniffImage" => {
            let bytes: Bytes = required(args, "bytes")?;
            value(sniff_image(&bytes.0))
        }
        "base64Encode" => {
            let bytes: Bytes = required(args, "bytes")?;
            value(base64_encode(&bytes.0))
        }
        "base64Decode" => value(base64_decode(text).map(Bytes)),
        "dataUrlBytes" => value(data_url_bytes(Some(text)).map(Bytes)),
        "sameBytes" => {
            let a: Bytes = required(args, "a")?;
            let b: Bytes = required(args, "b")?;
            value(same_bytes(&a.0, &b.0))
        }
        // geometry.ts
        "lengthToEmu" => value(length_to_emu(Some(text)).map(JsNum)),
        "emuToCm" => {
            let emu: JsNum = required(args, "emu")?;
            value(emu_to_cm(emu.0))
        }
        "drawingXml" => {
            let spec: DrawingSpec = required(args, "spec")?;
            value(drawing_xml(&spec))
        }
        "readDrawing" => value(read_drawing(text)),
        "drawingsOf" => value(drawings_of(text)),
        // model.ts
        "keepName" => {
            let kind: ObjectKind = required(args, "kind")?;
            value(keep_name(text, kind))
        }
        "pictureName" => value(picture_name(text)),
        "parseKeepName" => value(parse_keep_name(text)),
        "parsePictureName" => value(parse_picture_name(text)),
        "emptyObjectsExt" => value(empty_objects_ext()),
        // state.ts
        "noteKey" => {
            let kind: NoteKind = serde_json::from_value(Value::String(text.to_string()))
                .map_err(|error| format!("the kind argument: {error}"))?;
            let id: String = required(args, "id")?;
            value(note_key(kind, &id))
        }
        // analyze.ts
        "subElements" => {
            let from: U16 = required(args, "from")?;
            let to: U16 = required(args, "to")?;
            let xml = IndexedText::new(text.to_string());
            let found = sub_elements(
                &xml.text,
                &prefixes_of(text),
                byte_past_end(&xml, f64::from(from.0)),
                byte_past_end(&xml, f64::from(to.0)),
            );
            value(
                found
                    .into_iter()
                    .map(|sub| sub_element_wire(&xml, sub))
                    .collect::<Vec<_>>(),
            )
        }
        "plainTextOf" => {
            let from: U16 = required(args, "from")?;
            let to: U16 = required(args, "to")?;
            let xml = IndexedText::new(text.to_string());
            value(plain_text_of(
                &xml.text,
                &prefixes_of(text),
                xml.to_byte(from),
                xml.to_byte(to),
            ))
        }
        "hrefPath" => value(href_path(text)),
        "entriesOf" => {
            let doc = doc_of(args)?;
            value(entries_of(&doc, text))
        }
        "graphicProps" => {
            let doc = doc_of(args)?;
            let part: OdtStylePart = required(args, "part")?;
            let style_name: Option<String> = arg(args, "styleName")?;
            value(graphic_props(&doc, part, style_name.as_deref()))
        }
        "textWidthEmu" => {
            let doc = doc_of(args)?;
            value(JsNum(text_width_emu(&doc)))
        }
        "anchorOf" => {
            let doc = doc_of(args)?;
            let part: OdtStylePart = required(args, "part")?;
            let facts: AnchorFactsArg = required(args, "facts")?;
            value(anchor_of(
                &doc,
                part,
                &ObjectAnchorFacts {
                    r#type: facts.r#type,
                    x_emu: facts.x_emu.map(|n| n.0),
                    y_emu: facts.y_emu.map(|n| n.0),
                    z: facts.z.0,
                    style_name: facts.style_name,
                },
            ))
        }
        "analyzeObject" => {
            let doc = doc_of(args)?;
            let part: OdtStylePart = required(args, "part")?;
            let el: ElementArg = required(args, "el")?;
            let xml = IndexedText::new(text.to_string());
            let analysis = analyze_object(
                &doc,
                part,
                &xml.text,
                &prefixes_of(text),
                &ObjectElement {
                    name: &el.name,
                    start: xml.to_byte(el.start),
                    name_end: xml.to_byte(el.name_end),
                    open_end: xml.to_byte(el.open_end),
                    close_start: xml.to_byte(el.close_start),
                },
            );
            value(analysis_wire(&xml, analysis))
        }
        // package.ts
        "patchManifestXml" => {
            let changes: ChangesArg = required(args, "changes")?;
            value(patch_manifest_xml(
                text,
                &OdtPackageChanges {
                    add: changes
                        .add
                        .into_iter()
                        .map(|a| AddedEntry {
                            path: a.path,
                            data: a.data.0,
                            media_type: a.media_type,
                        })
                        .collect(),
                    remove: changes.remove,
                },
            ))
        }
        _ => Err(format!("no function {function}")),
    }
}
