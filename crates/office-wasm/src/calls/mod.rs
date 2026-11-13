//! Functions of the engines called by name, for the gate. Each group of ported
//! modules has a module here that answers to `<group>.<TypeScript name>`.

use ooxml_pkg::Package;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

mod altchunk;
mod blank;
mod blockpasses;
mod char_class;
mod chart;
mod checkbox;
mod docprops;
mod drawing;
mod fielddisplay;
mod fields;
mod gen_drawing;
mod gen_drawing_build;
mod gen_fields;
mod gen_paragraph;
mod gen_props;
mod gen_rpr;
mod gen_runs;
mod gen_table;
mod gen_text;
mod images;
mod ink;
mod markers;
mod math;
mod parse;
mod pptx_anim;
mod pptx_bytes;
mod pptx_chart;
mod pptx_deck;
mod pptx_deckcore;
mod pptx_deckgroups;
mod pptx_deckshape;
mod pptx_deckslides;
mod pptx_decktables;
mod pptx_decktext;
mod pptx_generate;
mod pptx_geom;
mod pptx_ident;
mod pptx_insert;
mod pptx_layout;
mod pptx_layouts;
mod pptx_leaves;
mod pptx_media;
mod pptx_mtx;
mod pptx_package;
mod pptx_packageparts;
mod pptx_parse;
mod pptx_placeholder;
mod pptx_tables;
mod pptx_tablestyle;
mod pptx_theme;
mod pptx_xml;
mod resolve;
mod revision;
pub(crate) mod save;
mod section;
mod vml;
mod withheld;
mod xml_tag;

/// What a call gives: a value, nothing where the TypeScript function returns
/// `undefined`, or an error where it throws.
pub type Returned = Result<Option<Value>, String>;

/// A returned value. A `None` inside it is `null`.
pub fn value(result: impl Serialize) -> Returned {
    serde_json::to_value(result)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// For a function that returns `undefined` where Rust has `None`.
pub fn optional(result: Option<impl Serialize>) -> Returned {
    result.map_or(Ok(None), value)
}

/// The argument `key`; `None` where it is absent or null.
pub fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<Option<T>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| format!("the {key} argument: {error}")),
    }
}

pub fn required<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    arg(args, key)?.ok_or_else(|| format!("the {key} argument is missing"))
}

/// The package of `args.parts`, a list of `[name, text]` pairs: what the
/// TypeScript side builds with `zipOf`.
pub fn package(args: &Value) -> Result<Package, String> {
    let parts: Vec<(String, String)> = required(args, "parts")?;
    Ok(Package::from_parts(parts))
}

/// `None` where no group of that name is built in.
pub fn dispatch(name: &str, text: &str, args: &Value) -> Option<Returned> {
    let (group, function) = name.split_once('.')?;
    match group {
        "altchunk" => Some(altchunk::dispatch(function, text, args)),
        "blank" => Some(blank::dispatch(function, text, args)),
        "blockpasses" => Some(blockpasses::dispatch(function, text, args)),
        "chart" => Some(chart::dispatch(function, text, args)),
        "charclass" => Some(char_class::dispatch(function, text, args)),
        "checkbox" => Some(checkbox::dispatch(function, text, args)),
        "docprops" => Some(docprops::dispatch(function, text, args)),
        "drawing" => Some(drawing::dispatch(function, text, args)),
        "fielddisplay" => Some(fielddisplay::dispatch(function, text, args)),
        "fields" => Some(fields::dispatch(function, text, args)),
        "images" => Some(images::dispatch(function, text, args)),
        "ink" => Some(ink::dispatch(function, text, args)),
        "parse" => Some(parse::dispatch(function, text, args)),
        "markers" => Some(markers::dispatch(function, text, args)),
        "math" => Some(math::dispatch(function, text, args)),
        "resolve" => Some(resolve::dispatch(function, text, args)),
        "revision" => Some(revision::dispatch(function, text, args)),
        "save" => Some(save::dispatch(function, text, args)),
        "section" => Some(section::dispatch(function, text, args)),
        "withheld" => Some(withheld::dispatch(function, text, args)),
        "genRpr" => Some(gen_rpr::dispatch(function, text, args)),
        "genProps" => Some(gen_props::dispatch(function, text, args)),
        "genDrawing" => Some(gen_drawing::dispatch(function, text, args)),
        "genDrawingBuild" => Some(gen_drawing_build::dispatch(function, text, args)),
        "genText" => Some(gen_text::dispatch(function, text, args)),
        "genTable" => Some(gen_table::dispatch(function, text, args)),
        "genFields" => Some(gen_fields::dispatch(function, text, args)),
        "genRuns" => Some(gen_runs::dispatch(function, text, args)),
        "genParagraph" => Some(gen_paragraph::dispatch(function, text, args)),
        "pptxAnim" => Some(pptx_anim::dispatch(function, text, args)),
        "pptxBytes" => Some(pptx_bytes::dispatch(function, text, args)),
        "pptxChart" => Some(pptx_chart::dispatch(function, text, args)),
        "pptxDeckcore" => Some(pptx_deckcore::dispatch(function, text, args)),
        "pptxDeckgroups" => Some(pptx_deckgroups::dispatch(function, text, args)),
        "pptxDeckshape" => Some(pptx_deckshape::dispatch(function, text, args)),
        "pptxDeckslides" => Some(pptx_deckslides::dispatch(function, text, args)),
        "pptxDecktables" => Some(pptx_decktables::dispatch(function, text, args)),
        "pptxDecktext" => Some(pptx_decktext::dispatch(function, text, args)),
        "pptxGenerate" => Some(pptx_generate::dispatch(function, text, args)),
        "pptxInsert" => Some(pptx_insert::dispatch(function, text, args)),
        "pptxLayouts" => Some(pptx_layouts::dispatch(function, text, args)),
        "pptxMedia" => Some(pptx_media::dispatch(function, text, args)),
        "pptxPackageparts" => Some(pptx_packageparts::dispatch(function, text, args)),
        "pptxGeom" => Some(pptx_geom::dispatch(function, text, args)),
        "pptxIdent" => Some(pptx_ident::dispatch(function, text, args)),
        "pptxLayout" => Some(pptx_layout::dispatch(function, text, args)),
        "pptxLeaves" => Some(pptx_leaves::dispatch(function, text, args)),
        "pptxMtx" => Some(pptx_mtx::dispatch(function, text, args)),
        "pptxPackage" => Some(pptx_package::dispatch(function, text, args)),
        "pptxParse" => Some(pptx_parse::dispatch(function, text, args)),
        "pptxPlaceholder" => Some(pptx_placeholder::dispatch(function, text, args)),
        "pptxTables" => Some(pptx_tables::dispatch(function, text, args)),
        "pptxTablestyle" => Some(pptx_tablestyle::dispatch(function, text, args)),
        "pptxTheme" => Some(pptx_theme::dispatch(function, text, args)),
        "pptxXml" => Some(pptx_xml::dispatch(function, text, args)),
        "vml" => Some(vml::dispatch(function, text, args)),
        "xmltag" => Some(xml_tag::dispatch(function, text, args)),
        _ => None,
    }
}
