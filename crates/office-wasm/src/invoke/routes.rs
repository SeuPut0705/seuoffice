//! The exports of `@seuoffice/docx-engine` whose Rust ports had no route
//! before the binding: each answers `invoke`'s positional JSON arguments. A
//! `Uint8Array` is a blob (see [`super`]); a `JSZip` is `[[name, text]]`, the
//! parts the function reads; a `Date` is its time value in milliseconds.

use docx_engine::blank::{self, BlankDocxOptions};
use docx_engine::block_passes;
use docx_engine::font_table::{self, EmbedSlots, EmbeddedFontRef, FontTableEntry};
use docx_engine::lazy_media;
use docx_engine::list_markers::{self, ListItemRef};
use docx_engine::model::{self, MapEntries};
use docx_engine::numbering::{NumberingDef, NumberingLevel};
use docx_engine::revision_xml;
use docx_engine::save::features::index_exports;
use docx_engine::save::parts::style_upsert::{DefaultFonts, StyleUpsert};
use docx_engine::save::save::helpers;
use docx_engine::styles::{self, DocDefaults, StyleDisplay};
use docx_engine::theme::{self, ThemeColors, ThemeFonts};
use jscompat::{JsMap, JsNum};
use ooxml_pkg::Package;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::InvokeEnv;

/// What a route answers: `None` is `undefined`.
pub type Out = Result<Option<Value>, String>;

/// The argument `index` of `args`, as `T`; absent and `null` are `None`.
fn opt<T: serde::de::DeserializeOwned>(args: &[Value], index: usize) -> Result<Option<T>, String> {
    match args.get(index) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| format!("TypeError: argument {index}: {error}")),
    }
}

fn req<T: serde::de::DeserializeOwned>(args: &[Value], index: usize) -> Result<T, String> {
    opt(args, index)?.ok_or_else(|| format!("TypeError: argument {index} is missing"))
}

fn some(value: impl Serialize) -> Out {
    serde_json::to_value(value)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// `deobfuscateOdttf(bytes, fontKey)`
pub fn deobfuscate_odttf(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let bytes = env.blob(args.first().unwrap_or(&Value::Null))?;
    let key: Option<String> = opt(args, 1)?;
    let out =
        font_table::deobfuscate_odttf(bytes, key.as_deref()).unwrap_or_else(|| bytes.to_vec());
    Ok(Some(env.put_blob(out)))
}

/// `isSfnt(bytes)`
pub fn is_sfnt(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let bytes = env.blob(args.first().unwrap_or(&Value::Null))?;
    some(font_table::is_sfnt(bytes))
}

/// `sfntLineMetrics(bytes)`: `null` for a font without head/hhea
pub fn sfnt_line_metrics(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let bytes = env.blob(args.first().unwrap_or(&Value::Null))?;
    some(font_table::sfnt_line_metrics(bytes))
}

/// `parseFontTable(xml)`
pub fn parse_font_table(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let xml: String = req(args, 0)?;
    some(font_table::parse_font_table(&xml))
}

/// `[name, text | {"$blob"}]`: a part of the zip the function reads.
pub(super) fn package_of(env: &InvokeEnv<'_>, value: &Value) -> Result<Package, String> {
    let parts: Vec<(String, Value)> = serde_json::from_value(value.clone())
        .map_err(|error| format!("TypeError: parts: {error}"))?;
    let mut package = Package::default();
    for (name, content) in parts {
        let bytes = match &content {
            Value::String(text) => text.clone().into_bytes(),
            other => env.blob(other)?.to_vec(),
        };
        package.set_file(name, bytes);
    }
    Ok(package)
}

/// `readEmbeddedFonts(zip, fontTable)`: `args[0]` the parts of the zip
pub fn read_embedded_fonts(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let package = package_of(env, args.first().unwrap_or(&Value::Null))?;
    let table: Vec<model::FontTableEntry> = req(args, 1)?;
    let slot = |slot: &Option<model::EmbeddedFontRef>| {
        slot.as_ref().map(|r| EmbeddedFontRef {
            r_id: r.r_id.clone(),
            font_key: r.font_key.clone(),
        })
    };
    let entries: Vec<FontTableEntry> = table
        .iter()
        .map(|entry| FontTableEntry {
            name: entry.name.clone(),
            embedded: entry.embedded.as_ref().map(|e| EmbedSlots {
                regular: slot(&e.regular),
                bold: slot(&e.bold),
                italic: slot(&e.italic),
                bold_italic: slot(&e.bold_italic),
            }),
            ..FontTableEntry::default()
        })
        .collect();
    let fonts = font_table::read_embedded_fonts(&package, &entries)?;
    let mut out = Vec::with_capacity(fonts.len());
    for font in fonts {
        let mut object = serde_json::Map::new();
        object.insert("family".to_owned(), Value::from(font.family));
        object.insert("bold".to_owned(), Value::Bool(font.bold));
        object.insert("italic".to_owned(), Value::Bool(font.italic));
        object.insert("data".to_owned(), env.put_blob(font.data));
        if let Some(metrics) = font.line_metrics {
            object.insert(
                "lineMetrics".to_owned(),
                serde_json::to_value(metrics).map_err(|error| error.to_string())?,
            );
        }
        out.push(Value::Object(object));
    }
    Ok(Some(Value::Array(out)))
}

/// The fields of a `StyleDisplay` the character-script readers use.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DisplayArg {
    size_half_points: Option<f64>,
    bold: Option<bool>,
    italic: Option<bool>,
    size_cs_half_points: Option<f64>,
    bold_cs: Option<bool>,
    italic_cs: Option<bool>,
}

fn display_of(arg: Option<DisplayArg>) -> Option<StyleDisplay> {
    arg.map(|arg| {
        let mut display = StyleDisplay::default();
        if let Some(n) = arg.size_half_points {
            display.size_half_points.set(JsNum(n));
        }
        if let Some(b) = arg.bold {
            display.bold.set(b);
        }
        if let Some(b) = arg.italic {
            display.italic.set(b);
        }
        if let Some(n) = arg.size_cs_half_points {
            display.size_cs_half_points.set(JsNum(n));
        }
        if let Some(b) = arg.bold_cs {
            display.bold_cs.set(b);
        }
        if let Some(b) = arg.italic_cs {
            display.italic_cs.set(b);
        }
        display
    })
}

/// `paraCsFormat(paraStyle, docDefaults)`
pub fn para_cs_format(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let display = display_of(opt(args, 0)?);
    let defaults: Option<DisplayArg> = opt(args, 1)?;
    let defaults = display_of(defaults).map(|d| {
        let mut dd = DocDefaults::default();
        if let Some(n) = *d.size_cs_half_points {
            dd.size_cs_half_points.set(n);
        }
        if let Some(b) = *d.bold_cs {
            dd.bold_cs.set(b);
        }
        if let Some(b) = *d.italic_cs {
            dd.italic_cs.set(b);
        }
        dd
    });
    some(styles::para_cs_format(display.as_ref(), defaults.as_ref()))
}

/// `styleRunFormat(display, cs)`
pub fn style_run_format(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let display = display_of(opt(args, 0)?);
    let cs: bool = req(args, 1)?;
    some(styles::style_run_format(display.as_ref(), cs))
}

/// `isLazyMediaPart(partPath)`
pub fn is_lazy_media_part(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let path: String = req(args, 0)?;
    some(lazy_media::is_lazy_media_part(&path))
}

/// `lazyMediaUrl(hash, partPath)`
pub fn lazy_media_url(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let hash: String = req(args, 0)?;
    let path: String = req(args, 1)?;
    some(lazy_media::lazy_media_url_checked(&hash, &path)?)
}

/// `newDocumentAppPropertiesXml(opts?)`
pub fn new_document_app_properties_xml(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let options: BlankDocxOptions = opt(args, 0)?.unwrap_or_default();
    some(blank::new_document_app_properties_xml(&options))
}

/// `newDocumentCorePropertiesXml(created?)`: `created` is a time value; absent, the host's clock
pub fn new_document_core_properties_xml(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let created: Option<f64> = opt(args, 0)?;
    some(blank::new_document_core_properties_xml(
        created.unwrap_or(env.now_ms),
    )?)
}

/// `w3cdtfStamp(date)`: `date` is a time value; an invalid one throws
pub fn w3cdtf_stamp(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let time = opt::<f64>(args, 0)?.unwrap_or(f64::NAN);
    some(blank::w3cdtf_stamp(time)?)
}

/// `findChartWorkbookPath(docxBytes, chartPath)`: `null` where there is none
pub fn find_chart_workbook_path(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let bytes = env.blob(args.first().unwrap_or(&Value::Null))?;
    let chart_path: String = req(args, 1)?;
    some(helpers::find_chart_workbook_path(bytes, &chart_path))
}

/// `readDocxPartBase64(docxBytes, path)`: `null` where the part does not exist
pub fn read_docx_part_base64(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let bytes = env.blob(args.first().unwrap_or(&Value::Null))?;
    let path: String = req(args, 1)?;
    some(helpers::read_docx_part_base64(bytes, &path))
}

/// `readThemeColors(themeXml)`
pub fn read_theme_colors(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let xml: String = req(args, 0)?;
    some(theme::read_theme_colors(&xml).map_err(|limit| limit.to_string())?)
}

/// `readThemeFonts(themeXml)`
pub fn read_theme_fonts(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let xml: String = req(args, 0)?;
    some(theme::read_theme_fonts(&xml))
}

/// The engine's `NumberingDef` of a model one: the same values, the keys set in the model's order.
fn engine_def_of(def: &model::NumberingDef) -> NumberingDef {
    let mut levels = jscompat::JsObject::new();
    for (key, level) in def.levels.0.entries() {
        let mut out = NumberingLevel::default();
        out.num_fmt.set(level.num_fmt.clone());
        out.lvl_text.set(level.lvl_text.clone());
        out.start.set(level.start);
        if let Some(v) = &level.custom_format {
            out.custom_format.set(v.clone());
        }
        if let Some(v) = level.suff {
            out.suff.set(v.as_str().to_owned());
        }
        if let Some(v) = level.is_lgl {
            out.is_lgl.set(v);
        }
        if let Some(v) = level.lvl_jc {
            out.lvl_jc.set(v.as_str());
        }
        if let Some(v) = &level.p_style {
            out.p_style.set(v.clone());
        }
        if let Some(v) = level.lvl_restart {
            out.lvl_restart.set(v);
        }
        if let Some(v) = level.bidi {
            out.bidi.set(v);
        }
        if let Some(v) = level.tab_stop {
            out.tab_stop.set(v);
        }
        if let Some(v) = level.indent_left {
            out.indent_left.set(v);
        }
        if let Some(v) = level.indent_right {
            out.indent_right.set(v);
        }
        if let Some(v) = level.hanging {
            out.hanging.set(v);
        }
        if let Some(v) = level.first_line {
            out.first_line.set(v);
        }
        if let Some(v) = level.sz_half_points {
            out.sz_half_points.set(v);
        }
        if let Some(v) = &level.color {
            out.color.set(v.clone());
        }
        if let Some(v) = level.bold {
            out.bold.set(v);
        }
        if let Some(v) = level.italic {
            out.italic.set(v);
        }
        if let Some(v) = &level.font {
            out.font.set(v.clone());
        }
        if let Some(v) = level.pic_bullet_id {
            out.pic_bullet_id.set(v);
        }
        if let Some(v) = &level.pic_bullet_src {
            out.pic_bullet_src.set(v.clone());
        }
        levels.set(key, out);
    }
    let mut start_overrides = jscompat::JsObject::new();
    for (key, value) in def.start_overrides.0.entries() {
        start_overrides.set(key, *value);
    }
    NumberingDef {
        num_id: def.num_id.clone(),
        abstract_num_id: def.abstract_num_id.clone(),
        levels,
        start_overrides,
    }
}

/// `computeListMarkers(items, defs)`: `defs` is the Map as its entries
pub fn compute_list_markers(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let items: Vec<ListItemRef> = req(args, 0)?;
    let defs: MapEntries<String, model::NumberingDef> = req(args, 1)?;
    let mut map = JsMap::new();
    for (key, def) in defs.0 {
        map.set(key, engine_def_of(&def));
    }
    some(list_markers::compute_list_markers(&items, &map))
}

/// What `previewFontSettings` reads of the parsed document.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewArg {
    original_bytes: Value,
    #[serde(default)]
    theme_colors: Option<ThemeColors>,
    #[serde(default)]
    theme_fonts: Option<ThemeFonts>,
}

/// `previewFontSettings(parsed, upserts, defaults?)`: `parsed` carries only
/// `internal.originalBytes` (as a blob), `themeColors` and `themeFonts`;
/// answers `{ styles: [[id, StyleInfo]], docDefaults? }`
pub fn preview_font_settings(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let parsed: PreviewArg = req(args, 0)?;
    let bytes = env.blob(&parsed.original_bytes)?;
    let upserts: Vec<StyleUpsert> = req(args, 1)?;
    let defaults: Option<DefaultFonts> = opt(args, 2)?;
    let preview = index_exports::preview_font_settings(
        bytes,
        parsed.theme_colors.as_ref(),
        parsed.theme_fonts.as_ref(),
        &upserts,
        defaults.as_ref(),
    )?;
    let styles: Vec<Value> = preview
        .styles
        .iter()
        .map(|(id, info)| {
            Ok(json!([
                id,
                serde_json::to_value(info).map_err(|e: serde_json::Error| e.to_string())?
            ]))
        })
        .collect::<Result<_, String>>()?;
    let mut object = serde_json::Map::new();
    object.insert("styles".to_owned(), Value::Array(styles));
    if let Some(defaults) = &preview.doc_defaults {
        object.insert(
            "docDefaults".to_owned(),
            serde_json::to_value(defaults).map_err(|error| error.to_string())?,
        );
    }
    Ok(Some(Value::Object(object)))
}

/// `revisionDateMs(iso)`
pub fn revision_date_ms(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let iso: String = req(args, 0)?;
    some(JsNum(revision_xml::revision_date_ms(&iso)))
}

/// `keepsHangulKanaSingle(font)`
pub fn keeps_hangul_kana_single(_env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let font: Option<String> = opt(args, 0)?;
    some(block_passes::keeps_hangul_kana_single(font.as_deref()))
}
