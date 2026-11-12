//! The operations of packages/pptx-engine/src/index.ts on an opened deck.
//!
//! This file is the core of index.ts: `openPptx`, `reparseDeck`, `savePptx`,
//! `commitSaved`, the slide patch (`patchSlideXml`, `patchedElementXml`), the
//! slide parse that assembles the inheritance chain (`parseSlideFromArchive`,
//! `buildDecorations`), `materializeSlide`, `appendRawElements` and
//! `addTable`. The backgrounds live in [`background`]; every other section of
//! index.ts is its own submodule, and callers write `crate::deck::<name>`.
//!
//! `savePptxToFile` has no counterpart: there is no file system here, and
//! [`save_pptx`] gives the bytes.

use std::cell::RefCell;
use std::sync::Arc;

use jscompat::{JsMap, JsNum, js_regex, truthy};
use ooxml_pkg::Package;

use crate::embedded_fonts::strip_stale_embedded_fonts;
use crate::generate::{
    FillPatch, GradientFillPatch, StrokeGradient, StrokePatch, alternate_content_branches,
    patch_element_fill, patch_element_p_pr, patch_element_stroke, patch_element_xfrm,
    patch_picture_src_rect, patch_text_element_xml, rebuild_tx_body,
};
use crate::identity::ensure_creation_id;
use crate::insert::{NewTableOptions, build_table_xml};
use crate::model3d::{MODEL3D_REL_TYPE, sync_model3d_frame};
use crate::parse::context::AvRel;
use crate::parse::{
    DecorationOptions, ParseContext, ParseContextData, SlideParseInput, Uids, parse_decorations,
    parse_slide,
};
use crate::placeholder::{
    MasterTextStyles, PlaceholderMap, TextStyleLevels, parse_default_text_style,
    parse_master_text_styles, parse_placeholder_map,
};
use crate::theme::{Theme, parse_clr_map, parse_theme};
use crate::types::{
    ByteAnchor, ElementType, EmuRect, Fill, LineCap, LineCompound, LineJoin, PPrDirty,
    PassthroughElement, PassthroughKind, Slide, SlideDeck, SlideElement, SlideSize, Stroke,
    Transform,
};
use crate::with_element;
use crate::zip::{PackageArchive, resolve_target};

pub mod background;
pub mod charts;
pub mod clipboard;
pub mod connectors;
pub mod groups;
pub mod shape;
pub mod slide_props;
pub mod slides;
pub mod tables;
pub mod text;

// Every section's public items as `crate::deck::<name>`, and its crate
// items for the other sections.
pub use background::*;
#[allow(unused_imports)]
pub(crate) use background::*;
pub use charts::*;
#[allow(unused_imports)]
pub(crate) use charts::*;
pub use clipboard::*;
#[allow(unused_imports)]
pub(crate) use clipboard::*;
pub use connectors::*;
#[allow(unused_imports)]
pub(crate) use connectors::*;
pub use groups::*;
#[allow(unused_imports)]
pub(crate) use groups::*;
pub use shape::*;
#[allow(unused_imports)]
pub(crate) use shape::*;
pub use slide_props::*;
#[allow(unused_imports)]
pub(crate) use slide_props::*;
pub use slides::*;
#[allow(unused_imports)]
pub(crate) use slides::*;
pub use tables::*;
#[allow(unused_imports)]
pub(crate) use tables::*;
pub use text::*;
#[allow(unused_imports)]
pub(crate) use text::*;

/// The date a written zip entry carries: 1980-01-01 UTC, the first date a
/// DOS time can hold. JSZip stamps the clock; the engine has none.
const ZIP_DATE: f64 = 315_532_800_000.0;

/// `OpenedPptx`, with the id counter of parse.ts and `saveSnapshot` as fields.
pub struct OpenedPptx {
    pub deck: SlideDeck,
    pub archive: PackageArchive,
    /// The id counter of parse.ts: every slide parsed for this deck takes its ids here.
    pub uids: Uids,
    /// `saveSnapshot.get(opened)`: what the last `build_zip` patched, by slide path.
    pub save_snapshot: Option<JsMap<String>>,
}

// ── Randomness ─────────────────────────────────────────────────────────

thread_local! {
    /// What `with_uuid` makes `random_uuid` answer.
    static UUID_OVERRIDE: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Runs `run` with `random_uuid` answering `uuid` (the gate stubs
/// `crypto.randomUUID` on the TypeScript side the same way).
pub fn with_uuid<T>(uuid: &str, run: impl FnOnce() -> T) -> T {
    let previous = UUID_OVERRIDE.with(|slot| slot.replace(Some(uuid.to_owned())));
    let result = run();
    UUID_OVERRIDE.with(|slot| *slot.borrow_mut() = previous);
    result
}

/// `crypto.randomUUID()`, or the uuid of an enclosing [`with_uuid`].
pub(crate) fn random_uuid() -> String {
    if let Some(uuid) = UUID_OVERRIDE.with(|slot| slot.borrow().clone()) {
        return uuid;
    }
    jscompat::random_uuid()
}

// ── Slide field readers (every key of a model slot may be missing) ─────

/// `slide.path`
pub(crate) fn slide_path(slide: &Slide) -> &str {
    (*slide.path).as_deref().unwrap_or("")
}

/// A part's (layout/master) own image rels, for decoration-layer picture parsing.
pub(crate) fn part_media_rels(
    archive: &PackageArchive,
    part_path: &str,
) -> Result<JsMap<String>, String> {
    let mut media = JsMap::new();
    for rel in archive.read_rels(part_path)?.values() {
        if rel.r#type.ends_with("/image") {
            media.set(rel.id.clone(), resolve_target(part_path, &rel.target));
        }
    }
    Ok(media)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HfState {
    On,
    Off,
    Unset,
}

/// `<p:hf>` footer-family toggle state. `attr` is `ftr`, `sldNum` or `dt`.
fn hf_state(xml: Option<&str>, attr: &str) -> HfState {
    let Some(xml) = truthy(xml) else {
        return HfState::Unset;
    };
    let Some(hf) = js_regex!(r"<p:hf\b[^>]*\/?>").exec(xml).map(|m| m.as_str()) else {
        return HfState::Unset;
    };
    let (on, off) = match attr {
        "ftr" => (
            js_regex!(r#"\bftr="(?:1|true)""#),
            js_regex!(r#"\bftr="(?:0|false)""#),
        ),
        "sldNum" => (
            js_regex!(r#"\bsldNum="(?:1|true)""#),
            js_regex!(r#"\bsldNum="(?:0|false)""#),
        ),
        _ => (
            js_regex!(r#"\bdt="(?:1|true)""#),
            js_regex!(r#"\bdt="(?:0|false)""#),
        ),
    };
    if on.test(hf) {
        HfState::On
    } else if off.test(hf) {
        HfState::Off
    } else {
        HfState::Unset
    }
}

/// `hasPh`
fn has_ph(xml: Option<&str>, kind: &str) -> bool {
    let Some(xml) = truthy(xml) else {
        return false;
    };
    match kind {
        "ftr" => js_regex!(r#"<p:ph\b[^>]*type="ftr""#).test(xml),
        "sldNum" => js_regex!(r#"<p:ph\b[^>]*type="sldNum""#).test(xml),
        _ => js_regex!(r#"<p:ph\b[^>]*type="dt""#).test(xml),
    }
}

/// `(el as { placeholder?: string }).placeholder`
fn placeholder_of(el: &SlideElement) -> Option<&str> {
    with_element!(el, e => (*e.placeholder).as_deref())
}

/// The `parts` argument of `buildDecorations`.
pub(crate) struct DecorationParts<'a> {
    pub layout_path: Option<&'a str>,
    pub master_path: Option<&'a str>,
    pub theme: Option<&'a Theme>,
    pub master_placeholders: Option<&'a PlaceholderMap>,
    pub master_text_styles: Option<&'a MasterTextStyles>,
    pub default_text_style: Option<&'a TextStyleLevels>,
}

/// `buildDecorations`: a slide's decoration layer, master concrete shapes
/// (bottom-most) then layout concrete shapes.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_decorations(
    archive: &PackageArchive,
    slide_path: &str,
    slide_xml: &str,
    slide: &Slide,
    layout_xml: Option<&str>,
    master_xml: Option<&str>,
    parts: &DecorationParts<'_>,
    uids: &Uids,
) -> Result<Vec<SlideElement>, String> {
    let mut out: Vec<SlideElement> = Vec::new();
    // Slide number: this slide's index in presentation.xml's sldIdLst; a
    // missing substitution is acceptable
    let mut slide_num: Option<f64> = None;
    if let Ok(presentation) = archive.read_presentation()
        && let Some(idx) = presentation
            .slide_paths
            .iter()
            .position(|p| p == slide_path)
    {
        slide_num = Some(idx as f64 + 1.0);
    }

    const HF_ALL: [&str; 3] = ["ftr", "sldNum", "dt"];
    let enabled: Vec<&str> = HF_ALL
        .iter()
        .copied()
        .filter(|k| {
            let l = hf_state(layout_xml, k);
            let m = hf_state(master_xml, k);
            if l == HfState::Off || m == HfState::Off {
                return false;
            }
            l == HfState::On || m == HfState::On
        })
        .collect();
    // Footer-family placeholders the slide already has
    let elements: &[SlideElement] = (*slide.elements).as_deref().unwrap_or_default();
    let slide_ph: Vec<&str> = elements
        .iter()
        .filter_map(placeholder_of)
        .filter(|p| !p.is_empty())
        .collect();

    // Slide-level showMasterSp="0" hides both master and layout decoration
    // shapes; layout-level only stops the master's from showing through.
    let slide_hides_inherited =
        js_regex!(r#"<p:sld\b[^>]*showMasterSp=(?:"(?:0|false)"|'(?:0|false)')"#).test(slide_xml);
    let master_shown = !slide_hides_inherited
        && !truthy(layout_xml).is_some_and(|layout| {
            js_regex!(r#"<p:sldLayout\b[^>]*showMasterSp=(?:"(?:0|false)"|'(?:0|false)')"#)
                .test(layout)
        });

    let empty = ParseContextData::default();
    let base = empty.context(uids);

    if let (Some(master_xml), Some(master_path)) = (truthy(master_xml), truthy(parts.master_path)) {
        let hf_types: Vec<String> = enabled
            .iter()
            .filter(|k| !slide_ph.contains(k) && !has_ph(layout_xml, k))
            .map(|k| (*k).to_owned())
            .collect();
        if master_shown || !hf_types.is_empty() {
            let media = part_media_rels(archive, master_path)?;
            let ctx = ParseContext {
                theme: parts.theme,
                media_rels: Some(&media),
                default_text_style: parts.default_text_style,
                ..base
            };
            let opts = DecorationOptions {
                hf_types: Some(hf_types),
                hide_shapes: Some(!master_shown),
                slide_num,
            };
            out.extend(parse_decorations(master_xml, &ctx, &opts)?);
        }
    }
    if let (Some(layout_xml), Some(layout_path)) = (truthy(layout_xml), truthy(parts.layout_path)) {
        let hf_types: Vec<String> = enabled
            .iter()
            .filter(|k| !slide_ph.contains(k))
            .map(|k| (*k).to_owned())
            .collect();
        if !slide_hides_inherited || !hf_types.is_empty() {
            // Layout footer placeholders often omit xfrm/font size, inheriting from the master
            let media = part_media_rels(archive, layout_path)?;
            let ctx = ParseContext {
                theme: parts.theme,
                media_rels: Some(&media),
                master_placeholders: parts.master_placeholders,
                master_text_styles: parts.master_text_styles,
                default_text_style: parts.default_text_style,
                ..base
            };
            let opts = DecorationOptions {
                hf_types: Some(hf_types),
                hide_shapes: Some(slide_hides_inherited),
                slide_num,
            };
            out.extend(parse_decorations(layout_xml, &ctx, &opts)?);
        }
    }
    Ok(out)
}

/// `parseSlideFromArchive`: one slide from the archive, assembling the
/// inheritance-chain context; `None` is the TypeScript `null`.
pub(crate) fn parse_slide_from_archive(
    archive: &PackageArchive,
    slide_path: &str,
    uids: &Uids,
) -> Result<Option<Slide>, String> {
    let Some(slide_xml) = archive.read_text(slide_path) else {
        return Ok(None);
    };
    let slide_xml: &str = &slide_xml;

    let chain = archive.resolve_slide_chain(slide_path)?;
    let mut ctx = ParseContextData::default();
    // Placeholder geometry, text style and background inheritance: layout first, master fallback
    let layout_path = truthy(chain.layout_path.as_deref());
    let master_path = truthy(chain.master_path.as_deref());
    let layout_text = layout_path.and_then(|p| archive.read_text(p));
    let master_text = master_path.and_then(|p| archive.read_text(p));
    let layout_xml: Option<&str> = layout_text.as_deref();
    let master_xml: Option<&str> = master_text.as_deref();
    if let Some(theme_path) = truthy(chain.theme_path.as_deref()) {
        let theme_text = archive.read_text(theme_path);
        if let Some(theme_xml) = truthy(theme_text.as_deref()) {
            let mut theme = parse_theme(theme_xml)?;
            // Dark masters remap schemeClr names (bg1 to dk1 ...)
            theme
                .clr_map
                .assign(parse_clr_map(master_xml, layout_xml, Some(slide_xml)));
            ctx.theme = Some(theme);
            ctx.theme_media_rels = Some(part_media_rels(archive, theme_path)?);
        }
    }
    if let Some(layout_xml) = truthy(layout_xml) {
        if let Some(path) = layout_path {
            ctx.layout_media_rels = Some(part_media_rels(archive, path)?);
        }
        ctx.layout_placeholders = Some(parse_placeholder_map(
            layout_xml,
            ctx.theme.as_ref(),
            ctx.layout_media_rels.as_ref(),
        ));
        ctx.layout_bg = Some(layout_xml.to_owned());
    }
    if let Some(master_xml) = truthy(master_xml) {
        if let Some(path) = master_path {
            ctx.master_media_rels = Some(part_media_rels(archive, path)?);
        }
        ctx.master_placeholders = Some(parse_placeholder_map(
            master_xml,
            ctx.theme.as_ref(),
            ctx.master_media_rels.as_ref(),
        ));
        ctx.master_text_styles = Some(parse_master_text_styles(
            master_xml,
            ctx.theme.as_ref(),
            ctx.master_media_rels.as_ref(),
        ));
        ctx.master_bg = Some(master_xml.to_owned());
    }
    // presentation.xml <p:defaultTextStyle>: base text defaults for non-placeholder shapes
    let pres_text = archive.read_text("ppt/presentation.xml");
    if let Some(pres_xml) = truthy(pres_text.as_deref()) {
        ctx.default_text_style = parse_default_text_style(pres_xml, ctx.theme.as_ref());
    }
    // Media rId to zip path; chart rId to chart part content
    let rels = archive.read_rels(slide_path)?;
    let mut media_rels: JsMap<String> = JsMap::new();
    let mut chart_xmls: JsMap<String> = JsMap::new();
    let mut chart_media_rels: JsMap<JsMap<String>> = JsMap::new();
    let mut chart_user_shapes: JsMap<String> = JsMap::new();
    let mut chart_style_rels: Vec<String> = Vec::new();
    let mut chart_theme_overrides: JsMap<String> = JsMap::new();
    let mut av_rels: JsMap<AvRel> = JsMap::new();
    let mut diagram_drawings: JsMap<String> = JsMap::new();
    let mut diagram_datas: JsMap<String> = JsMap::new();
    let mut diagram_media_rels: JsMap<JsMap<String>> = JsMap::new();
    let mut diagram_layouts: JsMap<String> = JsMap::new();
    let mut diagram_colors: JsMap<String> = JsMap::new();
    let mut vml_previews: JsMap<String> = JsMap::new();
    let mut hlink_rels: JsMap<String> = JsMap::new();
    let mut model3d_rels: JsMap<String> = JsMap::new();
    let mut slide_order: Option<Vec<String>> = None;
    for rel in rels.values() {
        let ty = rel.r#type.as_str();
        if ty.ends_with("/hyperlink") {
            hlink_rels.set(rel.id.clone(), rel.target.clone());
        } else if ty.ends_with("/slide") {
            // Run-level slide jump: resolve the target slide file to its deck index
            if slide_order.is_none() {
                slide_order = Some(archive.read_presentation()?.slide_paths);
            }
            let target = resolve_target(slide_path, &rel.target);
            let idx = slide_order
                .as_ref()
                .and_then(|order| order.iter().position(|p| *p == target));
            if let Some(idx) = idx {
                hlink_rels.set(rel.id.clone(), format!("slide:{idx}"));
            }
        } else if ty.ends_with("/image") {
            media_rels.set(rel.id.clone(), resolve_target(slide_path, &rel.target));
        } else if ty.ends_with("/chart") || ty.ends_with("/chartEx") {
            let target = resolve_target(slide_path, &rel.target);
            let text = archive.read_text(&target);
            if let Some(xml) = truthy(text.as_deref()) {
                chart_xmls.set(rel.id.clone(), xml.to_owned());
                chart_media_rels.set(rel.id.clone(), part_media_rels(archive, &target)?);
                // User-drawn overlays live in a chartUserShapes drawing referenced from the chart part's own rels
                for sub in archive.read_rels(&target)?.values() {
                    if sub.r#type.ends_with("/chartUserShapes") {
                        let us = archive.read_text(&resolve_target(&target, &sub.target));
                        if let Some(us_xml) = truthy(us.as_deref()) {
                            chart_user_shapes.set(rel.id.clone(), us_xml.to_owned());
                        }
                    }
                    if sub.r#type.ends_with("/chartStyle") && !chart_style_rels.contains(&rel.id) {
                        chart_style_rels.push(rel.id.clone());
                    }
                    // Chart-local theme (accents remapped per chart)
                    if sub.r#type.ends_with("/themeOverride") {
                        let ov = archive.read_text(&resolve_target(&target, &sub.target));
                        if let Some(ov_xml) = truthy(ov.as_deref()) {
                            chart_theme_overrides.set(rel.id.clone(), ov_xml.to_owned());
                        }
                    }
                }
            }
        } else if ty.ends_with("/video") || ty.ends_with("/audio") || ty.ends_with("/media") {
            // Audio/video (r:link of a:videoFile/a:audioFile; embedded or external)
            let external = rel.target_mode.as_deref() == Some("External");
            av_rels.set(
                rel.id.clone(),
                AvRel {
                    target: if external {
                        rel.target.clone()
                    } else {
                        resolve_target(slide_path, &rel.target)
                    },
                    external: external.then_some(true),
                },
            );
        } else if ty == MODEL3D_REL_TYPE {
            model3d_rels.set(rel.id.clone(), resolve_target(slide_path, &rel.target));
        } else if ty.ends_with("/vmlDrawing") {
            // Legacy OLE previews: v:shape (matched by oleObj spid) to v:imagedata to the VML part's own image rel
            let vml_path = resolve_target(slide_path, &rel.target);
            let vml_text = archive.read_text(&vml_path);
            if let Some(vml) = truthy(vml_text.as_deref()) {
                let vml_rels = archive.read_rels(&vml_path)?;
                for m in js_regex!(r"<v:shape\b([^>]*)>([\s\S]*?)<\/v:shape>").find_iter(vml) {
                    let relid = js_regex!(r#"<v:imagedata\b[^>]*\bo:relid="([^"]+)""#)
                        .exec(m.get(2).unwrap_or_default())
                        .and_then(|r| r.get(1));
                    let img_rel = relid.and_then(|id| vml_rels.get(id));
                    let Some(img_rel) = img_rel else {
                        continue;
                    };
                    let target = resolve_target(&vml_path, &img_rel.target);
                    let attrs = m.get(1).unwrap_or_default();
                    let ids = [
                        js_regex!(r#"\bid="([^"]+)""#)
                            .exec(attrs)
                            .and_then(|r| r.get(1)),
                        js_regex!(r#"\bo:spid="([^"]+)""#)
                            .exec(attrs)
                            .and_then(|r| r.get(1)),
                    ];
                    for v in ids.into_iter().flatten() {
                        vml_previews.set(v.to_owned(), target.clone());
                    }
                }
            }
        } else if ty.ends_with("/diagramData") {
            // SmartArt prerendered drawing part: the data part's <dsp:dataModelExt relId="...">
            // points at a diagramDrawing relationship in the container part's (slide's) rels;
            // fall back to the data part's own rels
            let data_path = resolve_target(slide_path, &rel.target);
            let data_text = archive.read_text(&data_path);
            let data_xml = truthy(data_text.as_deref());
            if let Some(data_xml) = data_xml {
                diagram_datas.set(rel.id.clone(), data_xml.to_owned());
            }
            let rel_id = data_xml.and_then(|xml| {
                js_regex!(r#"<dsp:dataModelExt\b[^>]*\brelId="([^"]+)""#)
                    .exec(xml)
                    .and_then(|m| m.get(1))
            });
            if let Some(rel_id) = rel_id {
                let own = archive.read_rels(&data_path);
                let in_slide = rels.get(rel_id);
                let draw_rel = match in_slide {
                    Some(r) => Some(r.clone()),
                    None => own?.get(rel_id).cloned(),
                };
                let base_path = if in_slide.is_some() {
                    slide_path
                } else {
                    data_path.as_str()
                };
                let drawing_path = draw_rel.map(|r| resolve_target(base_path, &r.target));
                if let Some(drawing_path) = drawing_path {
                    let drawing_text = archive.read_text(&drawing_path);
                    if let Some(drawing_xml) = truthy(drawing_text.as_deref()) {
                        diagram_drawings.set(rel.id.clone(), drawing_xml.to_owned());
                        diagram_media_rels
                            .set(rel.id.clone(), part_media_rels(archive, &drawing_path)?);
                    }
                }
            }
        } else if ty.ends_with("/diagramLayout") {
            let text = archive.read_text(&resolve_target(slide_path, &rel.target));
            if let Some(xml) = truthy(text.as_deref()) {
                diagram_layouts.set(rel.id.clone(), xml.to_owned());
            }
        } else if ty.ends_with("/diagramColors") {
            let text = archive.read_text(&resolve_target(slide_path, &rel.target));
            if let Some(xml) = truthy(text.as_deref()) {
                diagram_colors.set(rel.id.clone(), xml.to_owned());
            }
        }
    }
    ctx.media_rels = Some(media_rels);
    ctx.chart_xmls = Some(chart_xmls);
    if !chart_media_rels.is_empty() {
        ctx.chart_media_rels = Some(chart_media_rels);
    }
    if !chart_user_shapes.is_empty() {
        ctx.chart_user_shapes = Some(chart_user_shapes);
    }
    if !chart_style_rels.is_empty() {
        ctx.chart_style_rels = Some(chart_style_rels);
    }
    ctx.chart_theme_overrides = Some(chart_theme_overrides);
    if !hlink_rels.is_empty() {
        ctx.hlink_rels = Some(hlink_rels);
    }
    if !av_rels.is_empty() {
        ctx.av_rels = Some(av_rels);
    }
    if !model3d_rels.is_empty() {
        ctx.model3d_rels = Some(model3d_rels);
    }
    if !diagram_drawings.is_empty() {
        ctx.diagram_drawings = Some(diagram_drawings);
    }
    if !diagram_datas.is_empty() {
        ctx.diagram_datas = Some(diagram_datas);
    }
    if !diagram_media_rels.is_empty() {
        ctx.diagram_media_rels = Some(diagram_media_rels);
    }
    if !diagram_layouts.is_empty() {
        ctx.diagram_layouts = Some(diagram_layouts);
    }
    if !diagram_colors.is_empty() {
        ctx.diagram_colors = Some(diagram_colors);
    }
    if !vml_previews.is_empty() {
        ctx.vml_previews = Some(vml_previews);
    }
    // Table style definitions (embedded custom styles; built-in styles are the fallback)
    ctx.table_styles = archive
        .read_text("ppt/tableStyles.xml")
        .map(|text| text.into_owned());

    let mut slide = parse_slide(SlideParseInput {
        path: slide_path,
        slide_xml,
        layout_path: chain.layout_path.as_deref(),
        master_path: chain.master_path.as_deref(),
        ctx: ctx.context(uids),
    })?;

    // master/layout decoration layer, read-only render
    let decorations = build_decorations(
        archive,
        slide_path,
        slide_xml,
        &slide,
        layout_xml,
        master_xml,
        &DecorationParts {
            layout_path: chain.layout_path.as_deref(),
            master_path: chain.master_path.as_deref(),
            theme: ctx.theme.as_ref(),
            master_placeholders: ctx.master_placeholders.as_ref(),
            master_text_styles: ctx.master_text_styles.as_ref(),
            default_text_style: ctx.default_text_style.as_ref(),
        },
        uids,
    )?;
    if !decorations.is_empty() {
        slide.decorations.set(decorations);
    }
    Ok(Some(slide))
}

// ── Open, reparse, save ────────────────────────────────────────────────

/// `slides` of an archive, parsed in `sldIdLst` order.
fn parse_slides(archive: &PackageArchive, uids: &Uids) -> Result<(Vec<Slide>, SlideSize), String> {
    let presentation = archive.read_presentation()?;
    let mut slides = Vec::new();
    for slide_path in &presentation.slide_paths {
        if let Some(slide) = parse_slide_from_archive(archive, slide_path, uids)? {
            slides.push(slide);
        }
    }
    let size = SlideSize {
        cx: presentation.size.cx,
        cy: presentation.size.cy,
    };
    Ok((slides, size))
}

/// `openPptx`
pub fn open_pptx(bytes: &[u8]) -> Result<OpenedPptx, String> {
    open_archive(PackageArchive::open(bytes)?)
}

/// `openPptx` once the zip is read.
pub fn open_archive(archive: PackageArchive) -> Result<OpenedPptx, String> {
    let uids = Uids::starting_at(0);
    let (slides, size) = parse_slides(&archive, &uids)?;
    let deck = SlideDeck {
        slides,
        size,
        original_hash: archive.original_hash().to_owned(),
    };
    Ok(OpenedPptx {
        deck,
        archive,
        uids,
        save_snapshot: None,
    })
}

/// `reparseDeck`: rebuilds the deck model from the archive's current entries
/// (pending edits must already be baked in, see [`commit_saved`]).
pub fn reparse_deck(opened: &mut OpenedPptx) -> Result<(), String> {
    let (slides, size) = parse_slides(&opened.archive, &opened.uids)?;
    opened.deck = SlideDeck {
        slides,
        size,
        original_hash: opened.archive.original_hash().to_owned(),
    };
    Ok(())
}

/// `savePptx`. The zip is written with every entry deflated: `build_zip`
/// says which entries JSZip stores, and `ooxml_pkg::write::generate` has no
/// per-entry method.
pub fn save_pptx(opened: &mut OpenedPptx) -> Result<Vec<u8>, String> {
    let written = build_zip(opened).and_then(|entries| {
        let package =
            Package::from_parts(entries.into_iter().map(|(path, bytes, _)| (path, bytes)));
        ooxml_pkg::write::generate(&package, ZIP_DATE).map_err(|error| error.to_string())
    });
    if written.is_err() {
        // A save that never landed cannot vouch for any edit: drop the snapshot
        opened.save_snapshot = None;
    }
    written
}

/// `commitSaved`: syncs the model with what the save wrote, without a reopen.
pub fn commit_saved(opened: &mut OpenedPptx) {
    let OpenedPptx {
        deck,
        archive,
        save_snapshot,
        ..
    } = opened;
    let snapshot = save_snapshot.take();
    for slide in deck.slides.iter_mut() {
        if !slide_is_dirty(slide) {
            continue;
        }
        let xml = patch_slide_xml(slide);
        let path = slide_path(slide).to_owned();
        if let Some(snapshot) = &snapshot
            && snapshot.get(&path).map(String::as_str) != Some(xml.as_str())
        {
            continue;
        }
        if let Some(elements) = slide.elements.as_mut() {
            for el in elements.iter_mut() {
                let patched = patched_element_xml(el);
                with_element!(el, e => {
                    if let Some(anchor) = e.anchor.as_mut() {
                        anchor.original_xml = Arc::from(patched.as_str());
                    }
                    e.dirty.delete();
                    e.dirty_transform.delete();
                    e.dirty_fill.delete();
                    e.dirty_stroke.delete();
                    e.dirty_src_rect.delete();
                    e.dirty_p_pr.delete();
                });
            }
        }
        slide.original_xml.set(xml.clone());
        slide.structure_dirty.delete();
        archive.entries_mut().set(path, xml.into_bytes());
    }
}

/// `el.dirty || el.dirtyTransform || ...`
fn element_is_dirty(el: &SlideElement) -> bool {
    with_element!(el, e =>
        *e.dirty == Some(true)
            || *e.dirty_transform == Some(true)
            || *e.dirty_fill == Some(true)
            || *e.dirty_stroke == Some(true)
            || *e.dirty_src_rect == Some(true)
            || e.dirty_p_pr.is_some())
}

/// `slideIsDirty`
pub(crate) fn slide_is_dirty(slide: &Slide) -> bool {
    *slide.structure_dirty == Some(true)
        || (*slide.elements)
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(element_is_dirty)
}

/// `buildZip`: the entries a save writes, `(path, bytes, deflate)`. Only XML
/// text parts are deflated; everything else (media, fonts, OLE blobs) is
/// stored verbatim.
pub fn build_zip(opened: &mut OpenedPptx) -> Result<Vec<(String, Vec<u8>, bool)>, String> {
    let OpenedPptx {
        deck,
        archive,
        save_snapshot,
        ..
    } = opened;
    strip_stale_embedded_fonts(&deck.slides, archive)?;
    let mut patched: JsMap<String> = JsMap::new();
    for slide in deck.slides.iter_mut() {
        if slide_is_dirty(slide) {
            let xml = try_patch_slide_xml(slide)?;
            patched.set(slide_path(slide).to_owned(), xml);
        }
    }
    *save_snapshot = Some(patched.clone());

    let mut out = Vec::with_capacity(archive.entries().len());
    for (path, data) in archive.entries().iter() {
        if let Some(xml) = patched.get(path) {
            out.push((path.to_owned(), xml.as_bytes().to_vec(), true));
            continue;
        }
        let ext = path
            .rfind('.')
            .and_then(|dot| path.get(dot + 1..))
            .unwrap_or(path)
            .to_lowercase();
        out.push((path.to_owned(), data.clone(), ext == "xml" || ext == "rels"));
    }
    Ok(out)
}

// ── Patch ──────────────────────────────────────────────────────────────

/// `patchSlideXml`: one slide's XML, dirty elements patch-regenerated, the
/// rest original bytes. A patch that fails (a regex past its bound) gives
/// the slide's last XML; [`try_patch_slide_xml`] reports it.
pub fn patch_slide_xml(slide: &mut Slide) -> String {
    try_patch_slide_xml(slide).unwrap_or_else(|_| (*slide.original_xml).clone().unwrap_or_default())
}

/// `patchSlideXml`, with the error of a patch that cannot run.
pub(crate) fn try_patch_slide_xml(slide: &mut Slide) -> Result<String, String> {
    let mut out = String::new();
    out.push_str((*slide.body_prefix).as_deref().unwrap_or(""));
    if let Some(elements) = slide.elements.as_mut() {
        for el in elements.iter_mut() {
            out.push_str(&try_patched_element_xml(el)?);
            let gap = with_element!(&*el, e =>
                (*e.anchor).as_ref().and_then(|a| a.gap_after.clone()));
            if let Some(gap) = gap {
                out.push_str(&gap);
            }
        }
    }
    out.push_str((*slide.body_suffix).as_deref().unwrap_or(""));
    Ok(out)
}

/// `patchAnchorXml`: a byte patch to an element's own XML. An element
/// anchored to a whole `<mc:AlternateContent>` block was modelled from one
/// branch, so the patch lands inside that branch only; spPr-level patches
/// (`mirror`) also go to sibling branches of the same tag.
pub(crate) fn patch_anchor_xml(
    el: &SlideElement,
    xml: &str,
    patch: impl Fn(&str) -> Result<String, String>,
    mirror: bool,
) -> Result<String, String> {
    let Some(branches) = alternate_content_branches(xml)? else {
        return patch(xml);
    };
    let from_fallback = matches!(
        el.element_type(),
        Some(ElementType::Text | ElementType::Shape | ElementType::Picture)
    );
    let own = if from_fallback {
        branches.iter().position(|b| b.fallback)
    } else {
        branches
            .iter()
            .position(|b| !b.fallback && b.tag == "p:graphicFrame")
    }
    .unwrap_or(0);
    let Some(own_tag) = branches.get(own).map(|b| b.tag.as_str()) else {
        return patch(xml);
    };
    let mut out = String::new();
    let mut cursor = 0usize;
    for (i, b) in branches.iter().enumerate() {
        if i != own && !(mirror && b.tag == own_tag) {
            continue;
        }
        out.push_str(xml.get(cursor..b.start).unwrap_or(""));
        out.push_str(&patch(xml.get(b.start..b.end).unwrap_or(""))?);
        cursor = b.end;
    }
    out.push_str(xml.get(cursor..).unwrap_or(""));
    Ok(out)
}

/// The text element of a `text` or `shape` typed element.
fn text_like(el: &SlideElement) -> Option<&crate::types::TextElement> {
    if !matches!(
        el.element_type(),
        Some(ElementType::Text | ElementType::Shape)
    ) {
        return None;
    }
    match el {
        SlideElement::Text(t) => Some(&**t),
        _ => None,
    }
}

/// `modelStrokeToPatch`: the in-memory Stroke as the save-time XML rewrite
/// takes it; `None` for fills a StrokePatch cannot express (image, pattern).
fn model_stroke_to_patch(stroke: &Stroke) -> Option<StrokePatch> {
    let cap = stroke.cap.map(|cap| {
        match cap {
            LineCap::Flat => "flat",
            LineCap::Round => "rnd",
            LineCap::Square => "sq",
        }
        .to_owned()
    });
    let join = stroke.join.map(|join| {
        match join {
            LineJoin::Round => "round",
            LineJoin::Bevel => "bevel",
            LineJoin::Miter => "miter",
        }
        .to_owned()
    });
    let compound = stroke.compound.map(|compound| {
        match compound {
            LineCompound::Sng => "sng",
            LineCompound::Dbl => "dbl",
            LineCompound::ThickThin => "thickThin",
            LineCompound::ThinThick => "thinThick",
            LineCompound::Tri => "tri",
        }
        .to_owned()
    });
    // 'solid' actively clears a stale prstDash left in the original bytes
    let dash = Some(stroke.dash.clone().unwrap_or_else(|| "solid".to_owned()));
    match &stroke.fill {
        Fill::Solid { color } => Some(StrokePatch {
            color: color.clone(),
            width_emu: stroke.width,
            dash,
            cap,
            compound,
            join,
            gradient: None,
        }),
        Fill::Gradient(gradient) => Some(StrokePatch {
            color: gradient
                .stops
                .first()
                .map_or_else(|| "#000000".to_owned(), |s| s.color.clone()),
            width_emu: stroke.width,
            dash,
            cap,
            compound,
            join,
            gradient: Some(StrokeGradient {
                stops: gradient.stops.clone(),
                angle: gradient.angle.unwrap_or(JsNum(0.0)),
            }),
        }),
        _ => None,
    }
}

/// `patchedElementXml`, with the error of a patch that cannot run.
pub(crate) fn try_patched_element_xml(el: &mut SlideElement) -> Result<String, String> {
    // Progressive identity hardening: an element whose bytes are being
    // rewritten anyway gets a creationId minted into its anchor (idempotent).
    // Clean elements pass through untouched, so unedited decks stay byte-identical.
    if element_is_dirty(el) {
        ensure_creation_id(el, &random_uuid());
    }
    let el: &SlideElement = el;
    let Some(original) =
        with_element!(el, e => (*e.anchor).as_ref().map(|a| a.original_xml.clone()))
    else {
        return Err("the element has no anchor".to_owned());
    };
    let mut xml: String = original.to_string();
    let is_dirty = with_element!(el, e => *e.dirty == Some(true));
    let text = text_like(el);
    if is_dirty && let Some(t) = text {
        xml = patch_anchor_xml(el, &xml, |x| patch_text_element_xml(t, x), false)?;
    }
    // Surgical paragraph-property patch (run bytes untouched); a paragraph
    // count mismatch (rare) falls back to a full rebuild
    let p_pr: Option<PPrDirty> = with_element!(el, e => (*e.dirty_p_pr).clone());
    if let (Some(dirty), Some(t)) = (p_pr, text)
        && t.text.is_some()
    {
        xml = patch_anchor_xml(
            el,
            &xml,
            |x| match patch_element_p_pr(t, x, &dirty)? {
                Some(patched) => Ok(patched),
                None => Ok(rebuild_tx_body(t, x)),
            },
            false,
        )?;
    }
    // graphicFrame (table/chart/passthrough) uses the p:xfrm patch, everything else a:xfrm
    if with_element!(el, e => *e.dirty_transform == Some(true)) {
        xml = patch_anchor_xml(el, &xml, |x| Ok(patch_element_xfrm(el, x)), true)?;
        // PowerPoint shows a model's Choice, while the editor moves its Fallback picture
        if let SlideElement::Picture(pic) = el
            && pic.model3d.is_some()
            && el.element_type() == Some(ElementType::Picture)
        {
            xml = sync_model3d_frame(&xml);
        }
    }
    if with_element!(el, e => *e.dirty_fill == Some(true))
        && let Some(t) = text
    {
        let patch: Option<FillPatch> = match (*t.fill).as_ref() {
            Some(Fill::Solid { color }) => Some(FillPatch::Color(color.clone())),
            Some(Fill::None) => Some(FillPatch::Color("none".to_owned())),
            Some(Fill::Gradient(g)) => Some(FillPatch::Gradient(GradientFillPatch {
                stops: g.stops.clone(),
                angle: g.angle,
                radial: None,
                path: g.path,
                fill_to: if g.path.is_some() { g.fill_to } else { None },
            })),
            _ => None,
        };
        if let Some(patch) = patch {
            xml = patch_anchor_xml(el, &xml, |x| patch_element_fill(x, &patch), true)?;
        }
    }
    if with_element!(el, e => *e.dirty_stroke == Some(true)) {
        let stroke: Option<&Stroke> = match el {
            SlideElement::Text(t) if text.is_some() => (*t.stroke).as_ref(),
            SlideElement::Picture(p) => (*p.stroke).as_ref(),
            _ => None,
        };
        let applies = text.is_some() || matches!(el, SlideElement::Picture(_));
        if applies {
            let patch = stroke.and_then(model_stroke_to_patch);
            xml = patch_anchor_xml(el, &xml, |x| patch_element_stroke(x, patch.as_ref()), true)?;
        }
    }
    if with_element!(el, e => *e.dirty_src_rect == Some(true))
        && let SlideElement::Picture(pic) = el
    {
        let src_rect = (*pic.src_rect).as_ref();
        xml = patch_anchor_xml(el, &xml, |x| patch_picture_src_rect(x, src_rect), true)?;
    }
    Ok(xml)
}

/// `patchedElementXml`: one element's current XML slice (dirty elements
/// patch-regenerated, clean elements original bytes). A patch that fails
/// gives the original bytes; [`try_patched_element_xml`] reports it.
pub fn patched_element_xml(el: &mut SlideElement) -> String {
    try_patched_element_xml(el).unwrap_or_else(|_| {
        with_element!(&*el, e => (*e.anchor).as_ref().map(|a| a.original_xml.to_string()))
            .unwrap_or_default()
    })
}

// ── Raw slice append + whole-slide reparse (shared by paste/table insert) ──

/// `materializeSlide`: writes the slide's current state (incl. unsaved
/// patches) back to the archive and reparses, replacing the model in the
/// deck. `false` is the TypeScript `null`; the fresh slide is
/// `opened.deck.slides[slide_index]`. After a reparse all element ids on the
/// slide change.
pub fn materialize_slide(opened: &mut OpenedPptx, slide_index: usize) -> Result<bool, String> {
    let OpenedPptx {
        deck,
        archive,
        uids,
        ..
    } = opened;
    let Some(slide) = deck.slides.get_mut(slide_index) else {
        return Ok(false);
    };
    let path = slide_path(slide).to_owned();
    let xml = try_patch_slide_xml(slide)?;
    archive.entries_mut().set(path.clone(), xml.into_bytes());
    let Some(mut fresh) = parse_slide_from_archive(archive, &path, uids)? else {
        return Ok(false);
    };
    // a reparse is not a save: the edits it baked into the XML are still unsaved
    if slide_is_dirty(slide) {
        fresh.structure_dirty.set(true);
    }
    *slide = fresh;
    Ok(true)
}

/// `appendRawElements`: appends a batch of raw shape slices at the slide end
/// and materializes; gives the new element ids (in append order), the slide
/// is `opened.deck.slides[slide_index]`.
pub fn append_raw_elements(
    opened: &mut OpenedPptx,
    slide_index: usize,
    xmls: &[String],
) -> Result<Option<Vec<String>>, String> {
    let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
        return Ok(None);
    };
    if xmls.is_empty() {
        return Ok(None);
    }
    let mut elements = (*slide.elements).clone().unwrap_or_default();
    let before = elements.len();
    for xml in xmls {
        let at = elements.len();
        let mut raw = PassthroughElement::default();
        raw.id.set(format!("rawnew_{at}"));
        raw.r#type.set(ElementType::Passthrough);
        raw.kind.set(PassthroughKind::Unknown);
        raw.anchor.set(ByteAnchor {
            sp_index: at as i64,
            original_xml: Arc::from(xml.as_str()),
            range: [0, 0],
            gap_after: None,
        });
        raw.transform.set(Transform {
            offset: EmuRect {
                x: JsNum(0.0),
                y: JsNum(0.0),
                cx: JsNum(0.0),
                cy: JsNum(0.0),
            },
            rot: JsNum(0.0),
            flip_h: false,
            flip_v: false,
        });
        elements.push(SlideElement::Passthrough(Box::new(raw)));
    }
    slide.elements.set(elements);
    slide.structure_dirty.set(true);
    if !materialize_slide(opened, slide_index)? {
        return Ok(None);
    }
    let ids = opened
        .deck
        .slides
        .get(slide_index)
        .and_then(|slide| (*slide.elements).as_deref())
        .and_then(|elements| elements.get(before..))
        .map(|fresh| fresh.iter().map(|el| el.id().to_owned()).collect())
        .unwrap_or_default();
    Ok(Some(ids))
}

/// `addTable`: builds a graphicFrame slice, appends and reparses. Gives the
/// id of the new table; the slide is `opened.deck.slides[slide_index]`.
pub fn add_table(
    opened: &mut OpenedPptx,
    slide_index: usize,
    opts: &NewTableOptions,
) -> Result<Option<String>, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Ok(None);
    };
    let xml = build_table_xml(slide, opts, &random_uuid());
    let ids = append_raw_elements(opened, slide_index, &[xml])?;
    Ok(ids.and_then(|ids| ids.last().cloned()))
}
