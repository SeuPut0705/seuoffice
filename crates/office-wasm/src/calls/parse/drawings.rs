//! The drawing, VML, media and settings functions of parse.ts. A function over
//! a node takes its XML text (the first element `xmlParser.parse` gives, `{}`
//! for none); one over the package takes `args.parts`; a Map crosses as its
//! entries. A function that writes into its argument answers the argument
//! after the call.

use docx_engine::model::{
    Block, HfImage, HfTextBox, SectionSettings, TextboxDisplay, TextboxParaDisplay,
};
use docx_engine::numbering::parse_numbering;
use docx_engine::package::RelInfo;
use docx_engine::parse::drawings::host::{MediaEnv, NoHost};
use docx_engine::parse::drawings::media::{self, ChartContext};
use docx_engine::parse::drawings::picture::{self, AnchorPos};
use docx_engine::parse::drawings::settings::parse_settings_flag;
use docx_engine::parse::drawings::{diagram, hf_textbox, image, settings, textbox, vml};
use docx_engine::parse::text::{BuildContext, SectionIndex};
use docx_engine::props::XML_PARSER_MAX_NESTED_TAGS;
use docx_engine::scan::scan_body;
use docx_engine::theme::ThemeColors;
use ooxml_pkg::Package;
use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsMap, JsNum, JsObject};
use ooxml_xml::{XNode, parse_ordered};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::resolve::with_ctx;
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
        "imagePartMime" => |_, args| {
            let media = MediaEnv::new(&NoHost);
            optional(media::image_part_mime(
                &package(args)?,
                &required::<String>(args, "path")?,
                &media,
            )?)
        },
        "pictureColumnGeom" => |text, args| {
            value(picture::picture_column_geom(
                &meta_of(args)?,
                text,
                section_arg(args)?.as_ref(),
            ))
        },
        "pictureBesideFloatTable" => picture_beside_float_table,
        "pictureOverhangsColumn" => |text, args| {
            value(picture::picture_overhangs_column(
                &meta_of(args)?,
                text,
                section_arg(args)?.as_ref(),
            ))
        },
        "vmlStrokeChildOff" => |text, _| value(vml::vml_stroke_child_off(&node_of(text)?)),
        "hasDeepChild" => |text, args| {
            let names: Vec<String> = required(args, "names")?;
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            value(vml::has_deep_child(&node_of(text)?, &names))
        },
        "hasFloatingVmlPicture" => |text, _| value(vml::has_floating_vml_picture(&node_of(text)?)),
        "hfTextBoxOfAnchor" => {
            |text, _| without_id(value(hf_textbox::hf_text_box_of_anchor(&node_of(text)?)))
        }
        "hfTextBoxOfVml" => {
            |text, _| without_id(value(hf_textbox::hf_text_box_of_vml(&node_of(text)?)?))
        }
        "readVmlInset" => |text, args| {
            let mut box_: HfTextBox = required(args, "box")?;
            hf_textbox::read_vml_inset(&node_of(text)?, &mut box_);
            value(box_)
        },
        "blipEffectsOf" => |text, _| optional(image::blip_effects_of(text)?),
        "extractDiagramText" => |text, args| {
            with_build_ctx(args, |ctx| value(diagram::extract_diagram_text(text, ctx)?))
        },
        "extractLockedCanvas" => |text, args| {
            with_build_ctx(args, |ctx| {
                value(diagram::extract_locked_canvas(text, ctx)?)
            })
        },
        "extractDiagramDrawing" => |text, args| {
            with_build_ctx(args, |ctx| {
                value(diagram::extract_diagram_drawing(text, ctx)?)
            })
        },
        "imageMeta" => |text, args| {
            if args.get("parts").is_none() {
                return value(image::image_meta(text, None)?);
            }
            with_build_ctx(args, |ctx| value(image::image_meta(text, Some(ctx))?))
        },
        "runPictureAnchorOf" => |text, _| value(image::run_picture_anchor_of(text)?),
        "readMediaPartDataUrl" => |_, args| {
            let media = MediaEnv::new(&NoHost);
            value(media::read_media_part_data_url(
                &package(args)?,
                &required::<String>(args, "partPath")?,
                &media,
            )?)
        },
        "mediaPartDataUrl" => |_, args| {
            let media = MediaEnv::new(&NoHost);
            value(media::media_part_data_url(
                &package(args)?,
                &required::<String>(args, "partPath")?,
                &media,
            )?)
        },
        "mediaDataUrl" => |_, args| {
            let media = MediaEnv::new(&NoHost);
            value(media::media_data_url(
                &package(args)?,
                &rels_of(args)?,
                &required::<String>(args, "rId")?,
                arg::<String>(args, "sourcePath")?
                    .as_deref()
                    .unwrap_or("word/document.xml"),
                &media,
            )?)
        },
        "oleDisplay" => {
            |text, args| with_build_ctx(args, |ctx| value(media::ole_display(text, ctx)?))
        }
        "extractImage" => {
            |text, args| with_build_ctx(args, |ctx| value(media::extract_image(text, ctx)?))
        }
        "resolvePicBullets" => resolve_pic_bullets,
        "tableBlipMedia" => table_blip_media,
        "resolveBlipMedia" => |text, args| {
            with_build_ctx_media(args, |ctx| {
                media::resolve_blip_media(text, ctx)?;
                Ok(None)
            })
        },
        "hasResolvablePicture" => |text, args| {
            with_build_ctx_media(args, |ctx| value(media::has_resolvable_picture(text, ctx)?))
        },
        "paragraphStrayBox" => {
            |text, args| with_build_ctx(args, |ctx| value(textbox::paragraph_stray_box(text, ctx)?))
        }
        "textboxParagraphs" => |text, args| {
            with_build_ctx(args, |ctx| {
                renumbered(value(textbox::textbox_paragraphs(&node_of(text)?, ctx)?))
            })
        },
        "txbxTableParas" => |text, args| {
            with_build_ctx(args, |ctx| {
                value(textbox::txbx_table_paras(&node_of(text)?, ctx)?)
            })
        },
        "collectTxbxParas" => collect_txbx_paras,
        "txbxContentParas" => |text, args| {
            let doc_offset: Option<usize> = arg(args, "docOffset")?;
            with_build_ctx(args, |ctx| {
                value(textbox::txbx_content_paras(
                    &node_of(text)?,
                    ctx,
                    doc_offset,
                )?)
            })
        },
        "extractTextboxes" => extract_textboxes,
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
        // `nameOf(node) !== undefined`: an element named "" (a tag that starts
        // with white space) counts, though `XNode::name` reads it as nameless
        .find(|node| {
            matches!(node, XNode::Element(element) if !matches!(&*element.name, ":@" | "#text"))
        })
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
    let media = MediaEnv::new(&NoHost);
    let src = media::media_part_src(file, &part_path, &required::<String>(args, "mime")?, &media)?;
    value(MediaPartSrc {
        src,
        lazy_hashes: media.lazy_hashes(),
    })
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
    let display = media::extract_chart_part(
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

/// `args.sect`: the section of the call, `None` where the TypeScript passes
/// `undefined`.
fn section_arg(args: &Value) -> Result<Option<SectionSettings>, String> {
    arg(args, "sect")
}

/// The `image*` keys of `args.meta` the picture readers read, as a `Block`
/// holding only those keys that are present. A wrap the model does not name
/// is not kept.
fn meta_of(args: &Value) -> Result<Block, String> {
    let meta: Value = required(args, "meta")?;
    let mut block = Block::default();
    block.image_wrap.set_some(
        meta.get("imageWrap")
            .and_then(|wrap| serde_json::from_value(wrap.clone()).ok()),
    );
    block.image_width_px.set_some(arg(&meta, "imageWidthPx")?);
    block.image_height_px.set_some(arg(&meta, "imageHeightPx")?);
    block.image_rot_deg.set_some(arg(&meta, "imageRotDeg")?);
    block
        .image_offset_x_emu
        .set_some(arg(&meta, "imageOffsetXEmu")?);
    block
        .image_wrap_dist_left_emu
        .set_some(arg(&meta, "imageWrapDistLeftEmu")?);
    block
        .image_wrap_dist_right_emu
        .set_some(arg(&meta, "imageWrapDistRightEmu")?);
    Ok(block)
}

fn picture_beside_float_table(text: &str, args: &Value) -> Returned {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Table {
        left_twips: JsNum,
        right_twips: JsNum,
    }
    let table: Table = required(args, "table")?;
    value(picture::picture_beside_float_table(
        &meta_of(args)?,
        text,
        &docx_engine::parse::text::FloatTableAhead {
            left_twips: table.left_twips,
            right_twips: table.right_twips,
        },
        section_arg(args)?.as_ref(),
    ))
}

/// A text box's `id` is the count of the boxes the process built: the two
/// sides do not share it, so it is left out.
fn without_id(result: Returned) -> Returned {
    result.map(|answer| {
        answer.map(|mut answer| {
            if let Value::Object(map) = &mut answer {
                map.shift_remove("id");
            }
            answer
        })
    })
}

/// The ids of the text boxes in paragraphs, numbered in the order they first
/// appear (`box.id` of each `HfParagraph`).
fn renumbered(result: Returned) -> Returned {
    result.map(|answer| {
        answer.map(|mut answer| {
            let mut seen: Vec<Value> = Vec::new();
            if let Value::Array(paras) = &mut answer {
                for para in paras {
                    let id = para.pointer_mut("/box/id");
                    if let Some(id) = id {
                        let at = match seen.iter().position(|known| known == id) {
                            Some(at) => at,
                            None => {
                                seen.push(id.clone());
                                seen.len() - 1
                            }
                        };
                        *id = Value::from(at + 1);
                    }
                }
            }
            answer
        })
    })
}

/// The document.xml `args.sectSlices` stand for: each `[index, text]` of the
/// w:sectPr slices at its index, ASCII spaces between.
fn document_of_slices(slices: &[(usize, String)]) -> String {
    let mut xml = String::new();
    for (index, text) in slices {
        while xml.len() < *index {
            xml.push(' ');
        }
        xml.push_str(text);
    }
    xml
}

/// A `BuildContext` of the arguments, the way the TypeScript spec builds it:
/// `args.parts` hold what the context's styles, numbering and theme come
/// from; `args.extra` the package the call reads through `ctx.zip`;
/// `args.hf` makes it a header's (no zip, numbering or chart parts); the rest
/// are the members the document's own context holds.
fn with_build_ctx(args: &Value, call: impl FnOnce(&BuildContext<'_>) -> Returned) -> Returned {
    let extra: Vec<(String, String)> = arg(args, "extra")?.unwrap_or_default();
    let zip = Package::from_parts(extra);
    let media = MediaEnv::new(&NoHost);
    let hf = arg::<bool>(args, "hf")?.unwrap_or(false);
    let package = package(args)?;
    with_ctx(args, |resolver| {
        let mut ctx = BuildContext::bare(&zip, Rc::new(resolver.clone()), &media);
        if !hf {
            ctx.has_numbering = true;
            ctx.num_formats = Some(parse_numbering(&package)?.formats);
            ctx.source_path = arg(args, "sourcePath")?;
        }
        ctx.rels = rels_of(args)?;
        if let Some(chart_parts) = arg::<JsObject<String>>(args, "chartParts")? {
            ctx.chart_parts = RefCell::new(chart_parts);
        }
        if args.get("mediaByRid").is_some_and(|media| !media.is_null()) {
            ctx.media_by_rid = Some(RefCell::new(map_of::<String>(args, "mediaByRid")?));
        }
        if args
            .get("externalTxbxByRid")
            .is_some_and(|parts| !parts.is_null())
        {
            ctx.external_txbx_by_rid = Some(map_of::<String>(args, "externalTxbxByRid")?);
        }
        if args
            .get("vmlShapeTypes")
            .is_some_and(|types| !types.is_null())
        {
            ctx.vml_shape_types = Some(map_of::<JsObject<String>>(args, "vmlShapeTypes")?);
        }
        if args.get("noteNumbers").is_some() {
            ctx.note_numbers = map_of::<JsNum>(args, "noteNumbers")?;
        }
        if args.get("partNamespaces").is_some() {
            ctx.part_namespaces = Some(map_of::<String>(args, "partNamespaces")?);
        }
        ctx.xml_space_preserve = arg::<bool>(args, "xmlSpacePreserve")?.unwrap_or(false);
        ctx.compatibility_mode = arg(args, "compatibilityMode")?;
        if let Some(id) = arg::<f64>(args, "nextZoteroFieldId")? {
            ctx.next_zotero_field_id.set(id);
        }
        if let Some(ids) = arg::<Vec<String>>(args, "referenceOnlyComments")? {
            ctx.reference_only_comments = Some(ids.into_iter().collect());
        }
        if let Some(slices) = arg::<Vec<(usize, String)>>(args, "sectSlices")? {
            ctx.section_at = Some(SectionIndex::new(
                &document_of_slices(&slices),
                Some(parse_settings_flag(&package, "w:gutterAtTop")?),
            ));
        }
        call(&ctx)
    })
}

/// [`with_build_ctx`] for a function that writes `ctx.mediaByRid`: the answer
/// is `{ value, mediaByRid }`, the map after the call.
fn with_build_ctx_media(
    args: &Value,
    call: impl FnOnce(&BuildContext<'_>) -> Returned,
) -> Returned {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct After {
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_by_rid: Option<JsMap<String>>,
    }
    with_build_ctx(args, |ctx| {
        let answered = call(ctx)?;
        value(After {
            value: answered,
            media_by_rid: ctx
                .media_by_rid
                .as_ref()
                .map(|media| media.borrow().clone()),
        })
    })
}

fn resolve_pic_bullets(_text: &str, args: &Value) -> Returned {
    let zip = package(args)?;
    let media = MediaEnv::new(&NoHost);
    let numbering = parse_numbering(&zip)?;
    let mut defs = numbering.defs;
    media::resolve_pic_bullets(&zip, &mut defs, &numbering.pic_bullets, &media)?;
    value(defs)
}

fn table_blip_media(text: &str, args: &Value) -> Returned {
    let zip = package(args)?;
    let media = MediaEnv::new(&NoHost);
    let scan = scan_body(text).map_err(|error| error.to_string())?;
    value(media::table_blip_media(
        &scan.elements,
        text,
        &zip,
        &rels_of(args)?,
        arg::<String>(args, "sourcePath")?
            .as_deref()
            .unwrap_or("word/document.xml"),
        &media,
    )?)
}

/// `collectTxbxParas` over a fresh output: the paragraphs, and the list items
/// by the index of their paragraph.
fn collect_txbx_paras(text: &str, args: &Value) -> Returned {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Item {
        index: usize,
        list_ref: docx_engine::parse::text::ParaListRef,
        text_size_half: JsNum,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Collected {
        out: Vec<TextboxParaDisplay>,
        list_items: Vec<Item>,
    }
    let doc_offset: Option<usize> = arg(args, "docOffset")?;
    with_build_ctx(args, |ctx| {
        let mut out = Vec::new();
        let mut items = Vec::new();
        textbox::collect_txbx_paras(&node_of(text)?, ctx, doc_offset, &mut out, &mut items)?;
        value(Collected {
            out,
            list_items: items
                .into_iter()
                .map(|item| Item {
                    index: item.index,
                    list_ref: item.list_ref,
                    text_size_half: item.text_size_half,
                })
                .collect(),
        })
    })
}

fn extract_textboxes(text: &str, args: &Value) -> Returned {
    /// `ExtractTextboxOpts`: what the TypeScript passes.
    #[derive(Default, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Opts {
        shapes: Option<bool>,
        pictures: Option<bool>,
        section: Option<SectionSettings>,
        doc_offset: Option<usize>,
        first_page: Option<bool>,
    }
    let opts: Opts = arg(args, "opts")?.unwrap_or_default();
    with_build_ctx(args, |ctx| {
        value(textbox::extract_textboxes(
            text,
            ctx,
            textbox::ExtractTextboxOpts {
                shapes: opts.shapes.unwrap_or(false),
                pictures: opts.pictures.unwrap_or(false),
                section: opts.section.as_ref(),
                doc_offset: opts.doc_offset,
                first_page: opts.first_page.unwrap_or(false),
            },
        )?)
    })
}
