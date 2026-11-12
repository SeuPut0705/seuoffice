//! The drawing, VML, media and settings functions of parse.ts. A function over
//! a node takes its XML text (the first element `xmlParser.parse` gives, `{}`
//! for none); one over the package takes `args.parts`; a Map crosses as its
//! entries. A function that writes into its argument answers the argument
//! after the call.

use docx_engine::model::{
    Block, HfImage, HfTextBox, SectionSettings, TextboxDisplay, TextboxParaDisplay,
};
use docx_engine::package::RelInfo;
use docx_engine::parse::drawings::media::{self, ChartContext};
use docx_engine::parse::drawings::picture::{self, AnchorPos};
use docx_engine::parse::drawings::{settings, vml};
use docx_engine::props::XML_PARSER_MAX_NESTED_TAGS;
use docx_engine::theme::ThemeColors;
use jscompat::{JsMap, JsNum, JsObject};
use ooxml_xml::{XNode, parse_ordered};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::{Returned, arg, optional, package, required, value};

/// None: not a function of this module.
pub fn dispatch(function: &str, text_arg: &str, args: &Value) -> Option<Returned> {
    let call: fn(&str, &Value) -> Returned = match function {
        "alignedPictureXEmu" => aligned_picture_x_emu,
        "vmlHrRule" => |text, _| value(vml::vml_hr_rule(text)),
        "txbxParaVisible" => |_, args| {
            value(picture::txbx_para_visible(&required::<TextboxParaDisplay>(
                args, "p",
            )?))
        },
        "hasFloatingVmlGeometry" => |text, _| value(vml::has_floating_vml_geometry(text)),
        "vmlPictsInlineOnly" => vml_picts_inline_only,
        "vmlFlagOff" => {
            |_, args| value(vml::vml_flag_off(arg::<String>(args, "value")?.as_deref()))
        }
        "vmlStrokeWeightPx" => |_, args| {
            optional(vml::vml_stroke_weight_px(arg::<String>(args, "value")?.as_deref()).map(JsNum))
        },
        "applyVmlMsoPosition" => apply_vml_mso_position,
        "readAnchorPos" => read_anchor_pos,
        "hfShapeDrawingSvg" => {
            |text, _| value(picture::hf_shape_drawing_svg(text).map_err(|limit| limit.to_string())?)
        }
        "vmlLengthPx" => |_, args| {
            optional(vml::vml_length_px(arg::<String>(args, "raw")?.as_deref()).map(JsNum))
        },
        "readBodyPr" => read_body_pr,
        "rectFrac" => |text, args| {
            let name: String = required(args, "name")?;
            value(JsNum(
                picture::rect_frac(text, &name).map_err(|error| error.to_string())?,
            ))
        },
        "picBorderOf" => |text, _| optional(picture::pic_border_of(text)),
        "groupPictureLayers" => group_picture_layers,
        "picTransformOf" => |text, _| value(picture::pic_transform_of(text)),
        "vmlImageMeta" => |text, _| value(vml::vml_image_meta(text)),
        "relPartPath" => |_, args| {
            value(media::rel_part_path(
                &rels_of(args)?,
                arg::<String>(args, "sourcePath")?.as_deref(),
                arg::<String>(args, "rId")?.as_deref(),
            ))
        },
        "parseCompatibilityMode" => {
            |_, args| value(JsNum(settings::parse_compatibility_mode(&package(args)?)?))
        }
        "parseLayoutSettings" => |_, args| value(settings::parse_layout_settings(&package(args)?)?),
        "parseNoteProps" => |text, args| value(settings::parse_note_props(&package(args)?, text)?),
        "parseSettingsFlag" => |_, args| {
            value(settings::parse_settings_flag(
                &package(args)?,
                &required::<String>(args, "tag")?,
            )?)
        },
        "parseSources" => |_, args| value(settings::parse_sources(&package(args)?)?),
        "readThemeFontLang" => |_, args| value(settings::read_theme_font_lang(&package(args)?)?),
        "mediaPartSrc" => media_part_src,
        "externalTxbxParts" => |text, args| {
            value(media::external_txbx_parts(
                text,
                &package(args)?,
                &rels_of(args)?,
                arg::<String>(args, "sourcePath")?.as_deref(),
            )?)
        },
        "extractChart" => extract_chart,
        _ => return None,
    };
    Some(call(text_arg, args))
}

/// The first element of `xmlParser.parse(text)`, `{}` where it has none.
fn node_of(text: &str) -> Result<XNode, String> {
    let nodes =
        parse_ordered(text, XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    Ok(nodes
        .into_iter()
        .find(|node| node.name().is_some())
        .unwrap_or_else(XNode::empty))
}

/// `new Map(args[key])`: `[key, value]` pairs.
fn map_of<V: DeserializeOwned>(args: &Value, key: &str) -> Result<JsMap<V>, String> {
    let entries: Vec<(String, V)> = required(args, key)?;
    Ok(entries.into_iter().collect())
}

/// One relationship of `args.rels`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelArg {
    target: String,
    #[serde(rename = "type")]
    rel_type: String,
    target_mode: Option<String>,
}

/// `new Map(args.rels)`: `[id, { target, type, targetMode? }]` pairs.
fn rels_of(args: &Value) -> Result<JsMap<RelInfo>, String> {
    let entries: Vec<(String, RelArg)> = required(args, "rels")?;
    Ok(entries
        .into_iter()
        .map(|(id, rel)| {
            let info = RelInfo {
                target: rel.target,
                rel_type: rel.rel_type,
                target_mode: rel.target_mode,
            };
            (id, info)
        })
        .collect())
}

/// `args.meta` is an `ImageMeta`, a `Block` without its required keys: only
/// the key the function reads is taken.
fn aligned_picture_x_emu(text: &str, args: &Value) -> Returned {
    let meta_arg: Value = required(args, "meta")?;
    let mut meta = Block::default();
    meta.image_width_px
        .set_some(arg::<JsNum>(&meta_arg, "imageWidthPx")?);
    let sect: SectionSettings = required(args, "sect")?;
    optional(picture::aligned_picture_x_emu(&meta, text, &sect).map(JsNum))
}

fn vml_picts_inline_only(text: &str, args: &Value) -> Returned {
    let shape_types = match args.get("shapeTypes") {
        None | Some(Value::Null) => None,
        Some(_) => Some(map_of::<JsObject<String>>(args, "shapeTypes")?),
    };
    value(vml::vml_picts_inline_only(text, shape_types.as_ref()))
}

fn apply_vml_mso_position(text: &str, args: &Value) -> Returned {
    let mut box_: TextboxDisplay = required(args, "box")?;
    let sect: SectionSettings = required(args, "sect")?;
    vml::apply_vml_mso_position(&mut box_, text, &sect);
    value(box_)
}

/// The keys of `AnchorPos`.
const ANCHOR_POS_KEYS: [&str; 6] = ["posH", "posV", "posXPx", "posYPx", "posHRel", "posVRel"];

/// `readAnchorPos` writes into `args.image`: an `HfImage` where it has a
/// `dataUrl`, an `HfTextBox` where it has an `id`, else the six anchor keys
/// alone.
fn read_anchor_pos(text: &str, args: &Value) -> Returned {
    fn written<T: DeserializeOwned + Serialize + picture::AnchorPosTarget>(
        text: &str,
        args: &Value,
    ) -> Returned {
        let mut image: T = required(args, "image")?;
        picture::read_anchor_pos(text, &mut image);
        value(image)
    }
    let image = args.get("image").and_then(Value::as_object);
    if image.is_some_and(|image| image.contains_key("dataUrl")) {
        written::<HfImage>(text, args)
    } else if image.is_some_and(|image| image.contains_key("id")) {
        written::<HfTextBox>(text, args)
    } else if let Some(key) = image
        .into_iter()
        .flat_map(|image| image.keys())
        .find(|key| !ANCHOR_POS_KEYS.contains(&key.as_str()))
    {
        // `AnchorPos` reads past a key it does not hold
        Err(format!("the image argument: no key {key} in AnchorPos"))
    } else {
        written::<AnchorPos>(text, args)
    }
}

fn read_body_pr(text: &str, args: &Value) -> Returned {
    let mut box_: HfTextBox = required(args, "box")?;
    picture::read_body_pr(&node_of(text)?, &mut box_);
    value(box_)
}

fn group_picture_layers(text: &str, args: &Value) -> Returned {
    let media_by_rid = map_of::<String>(args, "mediaByRid")?;
    value(picture::group_picture_layers(
        &node_of(text)?,
        &media_by_rid,
    ))
}

/// What the TypeScript side answers for `mediaPartSrc`: the URL, and the
/// hashes `lazyHashesByZip` holds for the zip after the call.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaPartSrc {
    src: String,
    lazy_hashes: Vec<String>,
}

fn media_part_src(_text: &str, args: &Value) -> Returned {
    let zip = package(args)?;
    let part_path: String = required(args, "partPath")?;
    // `file` is `zip.file(partPath)`; the TypeScript reads `file._data` of null
    let file = zip
        .file(&part_path)
        .ok_or("TypeError: Cannot read properties of null")?;
    let mut lazy_hashes = Vec::new();
    let src = media::media_part_src(
        file,
        &part_path,
        &required::<String>(args, "mime")?,
        &mut lazy_hashes,
    )?;
    value(MediaPartSrc { src, lazy_hashes })
}

/// What the TypeScript side answers for `extractChart`: the display, and
/// `ctx.chartParts` after the call.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractChart {
    display: Option<docx_engine::model::ChartDisplay>,
    chart_parts: JsObject<String>,
}

fn extract_chart(text: &str, args: &Value) -> Returned {
    let zip = package(args)?;
    let rels = rels_of(args)?;
    let source_path: Option<String> = arg(args, "sourcePath")?;
    let theme_colors: Option<ThemeColors> = arg(args, "themeColors")?;
    let mut chart_parts: JsObject<String> = required(args, "chartParts")?;
    let display = media::extract_chart(
        text,
        &mut ChartContext {
            zip: &zip,
            rels: &rels,
            source_path: source_path.as_deref(),
            theme_colors: theme_colors.as_ref(),
            chart_parts: &mut chart_parts,
        },
    )?;
    value(ExtractChart {
        display,
        chart_parts,
    })
}
