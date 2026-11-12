//! `odtAssemble.*`: the plain-data exports of `packages/odt-engine/src/assemble`.
//!
//! Where the TypeScript takes an object the calls cannot carry:
//! - a `Map` argument (`commonLevels`) crosses as its entries `[[k, v], ...]`;
//! - `FontSet` is made fresh by the call; `textProps` answers
//!   `{ attrs, families }`, `defaultStyleXml` answers `{ xml, decls }`,
//!   `paragraphStylesXml` answers `{ xml, names, base, decls }` (`names` as
//!   entries, `families` and `decls` as the set holds them after the call);
//! - an `OdtDocument` argument is its text: `readMetaPeople` and `coreXmlFor`
//!   read `text` as `meta.xml` (`args.missing` is a package with none);
//!   `odtToDocxReport` reads `args.contentXml` (or `args.doc.contentXml`);
//! - `personalInfoRemoved` reads `text` as the edited core.xml (`args.missing`
//!   for `null`);
//! - `Uint8Array` is `{ "$bytes": base64 }`;
//! - `drawingXml` and `pictureRun` read `text` as the `name`;
//! - a `ParsedDoc` argument may be what `parseDocx` answers, `extras` included
//!   (the TypeScript type is a supertype of it): `extras` is dropped before the
//!   typed read; `styles` crosses as entries and is read as `new Map(entries)`
//!   is, a repeated key keeping its first place and its last value;
//! - `withRowFloors` answers the model with the keys in the order the
//!   TypeScript writes them (the keys of the given model, then the row heights
//!   it adds), as the typed `TableModel` has one fixed order;
//! - `TextFormat` is `Pick<Run, ...>` without `text`: a format without `text`
//!   is read with an empty one, a field no `textProps` reads;

use docx_engine::model::{Bytes, DocDefaults, ParaFormat, ParsedDoc, TableModel};
use docx_engine::section::{DEFAULT_SECTION, SectionSettings};
use jscompat::JsMap;
use odt_engine::assemble::export::headings::headings_as_paragraphs;
use odt_engine::assemble::export::objects::{
    ExportObjectKind, ObjectClass, classify_object, data_url_of, default_size, drawing_xml,
    fallback_picture_r_id, label_run, object_size, picture_run, solid_png,
};
use odt_engine::assemble::export::rows::with_row_floors;
use odt_engine::assemble::export::styles::{
    FontSet, MasterSpec, PageColumns, columns_xml, default_style_xml, document_defaults,
    master_page_xml, outline_style_xml, page_layout_xml, paragraph_props, paragraph_styles_xml,
    text_props,
};
use odt_engine::assemble::export::theme::{ThemeSources, unresolved_theme_references};
use odt_engine::assemble::meta::{
    BridgeCoreProps, core_xml_for_in, personal_info_removed, read_meta_people_in, scrub_meta_xml,
};
use odt_engine::assemble::report::odt_to_docx_report_over;
use odt_engine::core::{BridgeMap, OdtMasterPageRegionName};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Returned, arg, required, value};

/// The `MasterSpec` of the TypeScript as JSON.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MasterSpecArg {
    name: String,
    layout_name: String,
    settings: Value,
    header: bool,
    footer: bool,
    regions: Vec<String>,
    num_format: Option<String>,
    mirrored: bool,
    columns: ColumnsArg,
}

#[derive(Deserialize)]
struct ColumnsArg {
    count: f64,
    gap: f64,
}

impl MasterSpecArg {
    fn spec(self) -> Result<MasterSpec, String> {
        let mut regions = Vec::new();
        for region in &self.regions {
            regions.push(
                OdtMasterPageRegionName::parse(region)
                    .ok_or_else(|| format!("no region {region}"))?,
            );
        }
        Ok(MasterSpec {
            name: self.name,
            layout_name: self.layout_name,
            settings: settings_of(&self.settings),
            header: self.header,
            footer: self.footer,
            regions,
            num_format: self.num_format,
            mirrored: self.mirrored,
            columns: PageColumns {
                count: self.columns.count,
                gap: self.columns.gap,
            },
        })
    }
}

/// The page fields `pageLayoutXml` reads of `SectionSettings`, over the
/// defaults for the rest.
fn settings_of(v: &Value) -> SectionSettings {
    let mut s = DEFAULT_SECTION.clone();
    let n = |key: &str| v.get(key).and_then(Value::as_f64).map(jscompat::JsNum);
    if let Some(x) = n("pageWidth") {
        s.page_width = x;
    }
    if let Some(x) = n("pageHeight") {
        s.page_height = x;
    }
    if let Some(x) = n("marginTop") {
        s.margin_top = x;
    }
    if let Some(x) = n("marginRight") {
        s.margin_right = x;
    }
    if let Some(x) = n("marginBottom") {
        s.margin_bottom = x;
    }
    if let Some(x) = n("marginLeft") {
        s.margin_left = x;
    }
    s.gutter = n("gutter");
    s.header_dist = n("headerDist");
    s.footer_dist = n("footerDist");
    s.gutter_at_top = v.get("gutterAtTop").and_then(Value::as_bool);
    s.orientation = if v.get("orientation").and_then(Value::as_str) == Some("landscape") {
        "landscape"
    } else {
        "portrait"
    };
    s
}

fn kind_of(name: &str) -> Result<ExportObjectKind, String> {
    Ok(match name {
        "chart" => ExportObjectKind::Chart,
        "equation" => ExportObjectKind::Equation,
        "shape" => ExportObjectKind::Shape,
        "textbox" => ExportObjectKind::Textbox,
        other => return Err(format!("no object kind {other}")),
    })
}

/// `args.parsed` as a `ParsedDoc`, without the `extras` of a parse result.
fn parsed_of(args: &Value) -> Result<ParsedDoc, String> {
    let mut parsed = match args.get("parsed") {
        None | Some(Value::Null) => return Err("the parsed argument is missing".to_owned()),
        Some(parsed) => parsed.clone(),
    };
    if let Some(object) = parsed.as_object_mut() {
        object.remove("extras");
        if let Some(Value::Array(entries)) = object.get_mut("styles") {
            *entries = map_entries(std::mem::take(entries));
        }
    }
    serde_json::from_value(parsed).map_err(|error| format!("the parsed argument: {error}"))
}

/// `[...new Map(entries)]` for entries of string keys; an element that is not a
/// `[string, value]` pair stays for the typed reader to refuse.
fn map_entries(entries: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(entries.len());
    for entry in entries {
        let key = match &entry {
            Value::Array(pair) if pair.len() == 2 => pair[0].as_str(),
            _ => None,
        };
        let Some(key) = key else {
            out.push(entry);
            continue;
        };
        let place = out
            .iter()
            .position(|kept| kept.get(0).and_then(Value::as_str) == Some(key));
        match place {
            Some(place) => out[place] = entry,
            None => out.push(entry),
        }
    }
    out
}

/// `answer` with its keys in the order of `given`, then the rest in its own.
fn in_order_of(given: &Value, answer: Value) -> Value {
    match (given.as_object(), answer) {
        (Some(given), Value::Object(mut answer)) => {
            let mut out = serde_json::Map::new();
            for key in given.keys() {
                if let Some(value) = answer.remove(key) {
                    out.insert(key.clone(), value);
                }
            }
            out.extend(answer);
            Value::Object(out)
        }
        (_, answer) => answer,
    }
}

/// `args.format` as a `TextFormat`: a `Run` where `text` is not part of the type.
fn text_format_of(args: &Value) -> Result<docx_engine::model::Run, String> {
    let mut format = match args.get("format") {
        None | Some(Value::Null) => return Err("the format argument is missing".to_owned()),
        Some(format) => format.clone(),
    };
    if let Some(object) = format.as_object_mut() {
        object
            .entry("text")
            .or_insert_with(|| Value::String(String::new()));
    }
    serde_json::from_value(format).map_err(|error| format!("the format argument: {error}"))
}

fn num(args: &Value, key: &str) -> Result<f64, String> {
    required::<f64>(args, key)
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "headingsAsParagraphs" => {
            let entries: Vec<(String, f64)> = arg(args, "commonLevels")?.unwrap_or_default();
            let mut levels: JsMap<f64> = JsMap::new();
            for (key, level) in entries {
                levels.set(key, level);
            }
            value(headings_as_paragraphs(text, &levels).map_err(|e| e.to_string())?)
        }
        "unresolvedThemeReferences" => {
            let parsed = parsed_of(args)?;
            let styles_xml: String = required(args, "stylesXml")?;
            let parts: Vec<String> = arg(args, "parts")?.unwrap_or_default();
            value(unresolved_theme_references(
                &parsed,
                &ThemeSources {
                    document_xml: text,
                    styles_xml: &styles_xml,
                    parts: parts.iter().map(String::as_str).collect(),
                },
            ))
        }
        "withRowFloors" => {
            let model: TableModel = required(args, "model")?;
            let parsed = parsed_of(args)?;
            let floored = with_row_floors(&model, &parsed);
            let answer = serde_json::to_value(floored).map_err(|error| error.to_string())?;
            Ok(Some(in_order_of(&args["model"], answer)))
        }
        "paragraphProps" => {
            let format: ParaFormat = required(args, "format")?;
            value(paragraph_props(&format))
        }
        "textProps" => {
            let format = text_format_of(args)?;
            let mut fonts = FontSet::new();
            let attrs = text_props(&format, &mut fonts);
            value(json!({
                "attrs": attrs,
                "families": fonts.families.keys().collect::<Vec<_>>(),
            }))
        }
        "documentDefaults" => {
            let defaults: Option<DocDefaults> = arg(args, "defaults")?;
            value(document_defaults(defaults.as_ref()))
        }
        "defaultStyleXml" => {
            let defaults: Option<DocDefaults> = arg(args, "defaults")?;
            let mut fonts = FontSet::new();
            let xml =
                default_style_xml(defaults.as_ref(), &mut fonts).map_err(|e| e.to_string())?;
            value(json!({ "xml": xml, "decls": fonts.decls() }))
        }
        "outlineStyleXml" => value(outline_style_xml()),
        "paragraphStylesXml" => {
            let parsed = parsed_of(args)?;
            let mut fonts = FontSet::new();
            let styles = paragraph_styles_xml(&parsed, &mut fonts).map_err(|e| e.to_string())?;
            let names: Vec<(&str, &String)> = styles.names.iter().collect();
            value(json!({
                "xml": styles.xml,
                "names": names,
                "base": styles.base,
                "decls": fonts.decls(),
            }))
        }
        "pageLayoutXml" => {
            let spec: MasterSpecArg = required(args, "spec")?;
            value(page_layout_xml(&spec.spec()?))
        }
        "columnsXml" => {
            let columns: ColumnsArg = required(args, "columns")?;
            value(columns_xml(&PageColumns {
                count: columns.count,
                gap: columns.gap,
            }))
        }
        "masterPageXml" => {
            let spec: MasterSpecArg = required(args, "spec")?;
            value(master_page_xml(&spec.spec()?))
        }
        "classifyObject" => value(classify_object(text).map(ObjectClass::as_str)),
        "objectSize" => value(object_size(text).map(|s| json!({ "cx": s.cx, "cy": s.cy }))),
        "fallbackPictureRId" => value(fallback_picture_r_id(text)),
        "drawingXml" => value(drawing_xml(num(args, "cx")?, num(args, "cy")?, text)),
        "dataUrlOf" => {
            let bytes: Bytes = required(args, "bytes")?;
            value(data_url_of(&bytes.0))
        }
        "pictureRun" => {
            let bytes: Bytes = required(args, "bytes")?;
            value(picture_run(
                &bytes.0,
                num(args, "cx")?,
                num(args, "cy")?,
                text,
            ))
        }
        "labelRun" => {
            let kind: String = required(args, "kind")?;
            value(label_run(
                kind_of(&kind)?,
                num(args, "cx")?,
                num(args, "cy")?,
            ))
        }
        "defaultSize" => {
            let kind: String = required(args, "kind")?;
            let size = default_size(kind_of(&kind)?, text);
            value(json!({ "cx": size.cx, "cy": size.cy }))
        }
        "solidPng" => value(Bytes(solid_png(
            num(args, "r")?,
            num(args, "g")?,
            num(args, "b")?,
        ))),
        "readMetaPeople" => {
            let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
            value(read_meta_people_in((!missing).then_some(text)))
        }
        "coreXmlFor" => {
            let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
            let people: BridgeCoreProps = required(args, "people")?;
            value(core_xml_for_in((!missing).then_some(text), &people))
        }
        "personalInfoRemoved" => {
            let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
            let bridge: Option<BridgeCoreProps> = arg(args, "bridge")?;
            let flag = arg::<bool>(args, "editedFlag")?.unwrap_or(false);
            value(personal_info_removed(
                bridge.as_ref(),
                (!missing).then_some(text),
                flag,
            ))
        }
        "scrubMetaXml" => value(scrub_meta_xml(text)),
        "odtToDocxReport" => {
            let map: BridgeMap = required(args, "map")?;
            let content_xml: String = match arg::<String>(args, "contentXml")? {
                Some(xml) => xml,
                None => args
                    .get("doc")
                    .and_then(|doc| doc.get("contentXml"))
                    .and_then(Value::as_str)
                    .unwrap_or(text)
                    .to_owned(),
            };
            value(odt_to_docx_report_over(&content_xml, &map))
        }
        "constant" => constant(&required::<String>(args, "name")?),
        _ => Err(format!("no function {function}")),
    }
}

/// `odtAssemble.constant`: a constant of the assemble layer, by its TypeScript name.
fn constant(name: &str) -> Returned {
    match name {
        "ASSEMBLE_EXT_KEY" => value(odt_engine::assemble::odt::ASSEMBLE_EXT_KEY),
        "REPORT_FEATURES" => value(
            odt_engine::assemble::REPORT_FEATURES
                .iter()
                .map(|f| f.as_str())
                .collect::<Vec<_>>(),
        ),
        "LABEL_PREFIX" => value(odt_engine::assemble::export::objects::LABEL_PREFIX),
        "outlineStyleXml" => value(outline_style_xml()),
        other => Err(format!("no constant {other}")),
    }
}
