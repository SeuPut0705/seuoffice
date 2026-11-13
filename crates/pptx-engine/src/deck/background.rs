//! index.ts 971-1148: the slide background (solid, gradient, picture), its
//! reset to the layout/master definition, "hide background graphics", and
//! the layout/master inheritance bundle they read.

use jscompat::{JsMap, JsNum, math_round, number_to_string, truthy};
use serde::Deserialize;

use super::{
    DecorationParts, OpenedPptx, build_decorations, part_media_rels, slide_path,
    try_patch_slide_xml,
};
use crate::generate::{
    BackgroundFillPatch, BackgroundImagePatch, GradientFillPatch, patch_slide_background_xml,
    patch_slide_show_master_sp_xml, remove_slide_background_xml,
};
use crate::insert::add_image_media_and_rel;
use crate::parse::{ParseContext, ParseContextData, parse_background};
use crate::placeholder::{
    MasterTextStyles, PlaceholderMap, TextStyleLevels, parse_default_text_style,
    parse_master_text_styles, parse_placeholder_map,
};
use crate::resource_cleanup::cleanup_superseded_slide_resources;
use crate::theme::{Theme, parse_clr_map, parse_theme};
use crate::types::{Fill, GradientFill, GradientPath, GradientStop, ImageFill, ImageMode, Slide};
use crate::xml_utils::{escape_xml_attr, max_relationship_id_number};
use crate::zip::{PackageArchive, rels_path_for, resolve_target};

/// `fill: string | GradientFillPatch` of `setSlideBackground`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SlideBackgroundFill {
    Color(String),
    Gradient(GradientFillPatch),
}

/// `source: { bytes, ext } | { mediaPath }` of `setSlideBackgroundImage`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum BackgroundImageSource {
    #[serde(rename_all = "camelCase")]
    Bytes {
        #[serde(deserialize_with = "crate::json_bytes::bytes")]
        bytes: Vec<u8>,
        ext: String,
    },
    #[serde(rename_all = "camelCase")]
    MediaPath { media_path: String },
}

fn no_slide(slide_index: usize) -> String {
    format!("no slide at index {slide_index}")
}

/// `setSlideBackground`: sets a solid or gradient slide background: patches
/// the bodyPrefix and syncs the model (written back with the whole-slide
/// rebuild on save).
pub fn set_slide_background(
    opened: &mut OpenedPptx,
    slide_index: usize,
    fill: &SlideBackgroundFill,
) -> Result<(), String> {
    let (previous, current) = {
        let slide = opened
            .deck
            .slides
            .get_mut(slide_index)
            .ok_or_else(|| no_slide(slide_index))?;
        let previous = try_patch_slide_xml(slide)?;
        let patch = match fill {
            SlideBackgroundFill::Color(color) => BackgroundFillPatch::Color(color.clone()),
            SlideBackgroundFill::Gradient(gradient) => {
                BackgroundFillPatch::Gradient(gradient.clone())
            }
        };
        let prefix = (*slide.body_prefix).clone().unwrap_or_default();
        slide
            .body_prefix
            .set(patch_slide_background_xml(&prefix, &patch));
        let model = match fill {
            SlideBackgroundFill::Color(color) => Fill::Solid {
                color: color.clone(),
            },
            SlideBackgroundFill::Gradient(gradient) => {
                let radial = gradient.radial == Some(true);
                Fill::Gradient(GradientFill {
                    stops: gradient
                        .stops
                        .iter()
                        .map(|s| GradientStop {
                            pos: s.pos,
                            color: s.color.clone(),
                        })
                        .collect(),
                    angle: if radial {
                        None
                    } else {
                        Some(JsNum(math_round(gradient.angle.map_or(0.0, |a| a.0))))
                    },
                    scaled: None,
                    path: radial.then_some(GradientPath::Circle),
                    fill_to: None,
                    tile_rect: None,
                })
            }
        };
        slide.background.set(model);
        slide.bg_own.set(true);
        slide.structure_dirty.set(true);
        (previous, try_patch_slide_xml(slide)?)
    };
    cleanup_superseded_slide_resources(opened, slide_index, &previous, &current)?;
    Ok(())
}

/// `setSlideBackgroundImage`: a picture slide background. The source is
/// either fresh bytes (lands a new media part) or an existing media path
/// (only a rel is added). Gives the media path used, `None` for an
/// unsupported format.
pub fn set_slide_background_image(
    opened: &mut OpenedPptx,
    slide_index: usize,
    source: &BackgroundImageSource,
    tile: Option<bool>,
) -> Result<Option<String>, String> {
    let (rid, media_path) = match source {
        BackgroundImageSource::Bytes { bytes, ext } => {
            let Some(added) = add_image_media_and_rel(opened, slide_index, bytes, ext)? else {
                return Ok(None);
            };
            (added.rid, added.media_path)
        }
        BackgroundImageSource::MediaPath { media_path } => {
            if !opened.archive.entries().has(media_path) {
                return Ok(None);
            }
            let OpenedPptx { deck, archive, .. } = opened;
            let slide = deck
                .slides
                .get(slide_index)
                .ok_or_else(|| no_slide(slide_index))?;
            let Some(rid) = image_rel_for(archive, slide, media_path)? else {
                return Ok(None);
            };
            (rid, media_path.clone())
        }
    };
    let tiled = tile == Some(true);
    let (previous, current) = {
        let slide = opened
            .deck
            .slides
            .get_mut(slide_index)
            .ok_or_else(|| no_slide(slide_index))?;
        let previous = try_patch_slide_xml(slide)?;
        let prefix = (*slide.body_prefix).clone().unwrap_or_default();
        slide.body_prefix.set(patch_slide_background_xml(
            &prefix,
            &BackgroundFillPatch::Image(BackgroundImagePatch {
                image_rid: rid,
                tile: tiled.then_some(true),
            }),
        ));
        slide.background.set(Fill::Image(ImageFill {
            media_ref: media_path.clone(),
            mode: Some(if tiled {
                ImageMode::Tile
            } else {
                ImageMode::Stretch
            }),
            alpha: None,
            fill_rect: None,
            duotone: None,
            clr_change: None,
            lum: None,
            bi_level: None,
            tile: None,
        }));
        slide.bg_own.set(true);
        slide.structure_dirty.set(true);
        (previous, try_patch_slide_xml(slide)?)
    };
    cleanup_superseded_slide_resources(opened, slide_index, &previous, &current)?;
    Ok(Some(media_path))
}

/// `imageRelFor`: the slide's image rel for a media path, adding one when
/// missing. `None` where the rel found has an empty id: every caller's
/// `if (!rid) return null`.
pub(crate) fn image_rel_for(
    archive: &mut PackageArchive,
    slide: &Slide,
    media_path: &str,
) -> Result<Option<String>, String> {
    let path = slide_path(slide);
    for rel in archive.read_rels(path)?.values() {
        if rel.r#type.ends_with("/image") && resolve_target(path, &rel.target) == media_path {
            return Ok((!rel.id.is_empty()).then(|| rel.id.clone()));
        }
    }
    let rels_path = rels_path_for(path);
    let rels = match archive.read_text(&rels_path) {
        Some(text) => text.into_owned(),
        None => "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".to_owned(),
    };
    let max_rid = max_relationship_id_number(&rels);
    let rid = format!("rId{}", number_to_string(max_rid + 1.0));
    // slide parts live in ppt/slides/, media in ppt/media/
    let target = match media_path.strip_prefix("ppt/") {
        Some(rest) => format!("../{rest}"),
        None => media_path.to_owned(),
    };
    let rel_xml = format!(
        "<Relationship Id=\"{rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{}\"/>",
        escape_xml_attr(&target)
    );
    // a function replacement in the TypeScript: the value goes in as written
    let updated = match rels.find("</Relationships>") {
        Some(at) => {
            let (head, tail) = rels.split_at(at);
            format!("{head}{rel_xml}{tail}")
        }
        None => rels,
    };
    archive.entries_mut().set(rels_path, updated.into_bytes());
    Ok(Some(rid))
}

/// `resetSlideBackground`: removes the slide's own `<p:bg>` override; the
/// background falls back to the layout/master definition, recomputed here
/// so rendering updates without a reopen.
pub fn reset_slide_background(opened: &mut OpenedPptx, slide_index: usize) -> Result<(), String> {
    let previous = {
        let slide = opened
            .deck
            .slides
            .get_mut(slide_index)
            .ok_or_else(|| no_slide(slide_index))?;
        let previous = try_patch_slide_xml(slide)?;
        let prefix = (*slide.body_prefix).clone().unwrap_or_default();
        slide.body_prefix.set(remove_slide_background_xml(&prefix));
        slide.bg_own.delete();
        slide.structure_dirty.set(true);
        previous
    };
    let path = opened
        .deck
        .slides
        .get(slide_index)
        .map(|slide| slide_path(slide).to_owned())
        .unwrap_or_default();
    let inherit = slide_inheritance_ctx(&opened.archive, &path)?;
    let inherited = {
        let empty = ParseContextData::default();
        let base = empty.context(&opened.uids);
        let from_layout = truthy(inherit.layout_xml.as_deref()).and_then(|xml| {
            parse_background(
                xml,
                &ParseContext {
                    theme: inherit.theme.as_ref(),
                    media_rels: inherit.layout_media_rels.as_ref(),
                    theme_media_rels: inherit.theme_media_rels.as_ref(),
                    ..base
                },
            )
        });
        from_layout.or_else(|| {
            truthy(inherit.master_xml.as_deref()).and_then(|xml| {
                parse_background(
                    xml,
                    &ParseContext {
                        theme: inherit.theme.as_ref(),
                        media_rels: inherit.master_media_rels.as_ref(),
                        theme_media_rels: inherit.theme_media_rels.as_ref(),
                        ..base
                    },
                )
            })
        })
    };
    let current = {
        let slide = opened
            .deck
            .slides
            .get_mut(slide_index)
            .ok_or_else(|| no_slide(slide_index))?;
        match inherited {
            Some(fill) => slide.background.set(fill),
            None => slide.background.delete(),
        }
        try_patch_slide_xml(slide)?
    };
    cleanup_superseded_slide_resources(opened, slide_index, &previous, &current)?;
    Ok(())
}

/// `setSlideBgGraphicsHidden`: toggles "hide background graphics"
/// (`<p:sld showMasterSp="0">`) and rebuilds the slide's decoration layer so
/// rendering reflects the change immediately.
pub fn set_slide_bg_graphics_hidden(
    opened: &mut OpenedPptx,
    slide_index: usize,
    hidden: bool,
) -> Result<(), String> {
    let OpenedPptx {
        deck,
        archive,
        uids,
        ..
    } = opened;
    let slide = deck
        .slides
        .get_mut(slide_index)
        .ok_or_else(|| no_slide(slide_index))?;
    let prefix = (*slide.body_prefix).clone().unwrap_or_default();
    slide
        .body_prefix
        .set(patch_slide_show_master_sp_xml(&prefix, hidden)?);
    if hidden {
        slide.master_sp_hidden.set(true);
    } else {
        slide.master_sp_hidden.delete();
    }
    slide.structure_dirty.set(true);
    let path = slide_path(slide).to_owned();
    let inherit = slide_inheritance_ctx(archive, &path)?;
    let body_prefix = (*slide.body_prefix).clone().unwrap_or_default();
    let decorations = build_decorations(
        archive,
        &path,
        &body_prefix, // carries the fresh showMasterSp attribute
        slide,
        inherit.layout_xml.as_deref(),
        inherit.master_xml.as_deref(),
        &DecorationParts {
            layout_path: inherit.layout_path.as_deref(),
            master_path: inherit.master_path.as_deref(),
            theme: inherit.theme.as_ref(),
            master_placeholders: inherit.master_placeholders.as_ref(),
            master_text_styles: inherit.master_text_styles.as_ref(),
            default_text_style: inherit.default_text_style.as_ref(),
        },
        uids,
    )?;
    if decorations.is_empty() {
        slide.decorations.delete();
    } else {
        slide.decorations.set(decorations);
    }
    Ok(())
}

/// What `slideInheritanceCtx` gives: the layout/master inheritance bundle
/// for one slide (theme + placeholder maps + part media rels).
pub(crate) struct InheritanceCtx {
    pub layout_path: Option<String>,
    pub master_path: Option<String>,
    pub layout_xml: Option<String>,
    pub master_xml: Option<String>,
    pub theme: Option<Theme>,
    pub master_placeholders: Option<PlaceholderMap>,
    pub master_text_styles: Option<MasterTextStyles>,
    pub default_text_style: Option<TextStyleLevels>,
    pub layout_media_rels: Option<JsMap<String>>,
    pub master_media_rels: Option<JsMap<String>>,
    pub theme_media_rels: Option<JsMap<String>>,
}

/// `slideInheritanceCtx`
pub(crate) fn slide_inheritance_ctx(
    archive: &PackageArchive,
    slide_path: &str,
) -> Result<InheritanceCtx, String> {
    let chain = archive.resolve_slide_chain(slide_path)?;
    let layout_path = truthy(chain.layout_path.as_deref());
    let master_path = truthy(chain.master_path.as_deref());
    let layout_text = layout_path.and_then(|p| archive.read_text(p));
    let master_text = master_path.and_then(|p| archive.read_text(p));
    let layout_xml: Option<&str> = layout_text.as_deref();
    let master_xml: Option<&str> = master_text.as_deref();
    let mut theme: Option<Theme> = None;
    if let Some(theme_path) = truthy(chain.theme_path.as_deref()) {
        let theme_text = archive.read_text(theme_path);
        if let Some(theme_xml) = truthy(theme_text.as_deref()) {
            let mut parsed = parse_theme(theme_xml)?;
            let slide_text = archive.read_text(slide_path);
            parsed
                .clr_map
                .assign(parse_clr_map(master_xml, layout_xml, slide_text.as_deref()));
            theme = Some(parsed);
        }
    }
    let pres_text = archive.read_text("ppt/presentation.xml");
    let master_media_rels = match master_path {
        Some(path) => Some(part_media_rels(archive, path)?),
        None => None,
    };
    let master_placeholders = truthy(master_xml)
        .map(|xml| parse_placeholder_map(xml, theme.as_ref(), master_media_rels.as_ref()));
    let master_text_styles = truthy(master_xml)
        .map(|xml| parse_master_text_styles(xml, theme.as_ref(), master_media_rels.as_ref()));
    let default_text_style =
        truthy(pres_text.as_deref()).and_then(|xml| parse_default_text_style(xml, theme.as_ref()));
    let layout_media_rels = match layout_path {
        Some(path) => Some(part_media_rels(archive, path)?),
        None => None,
    };
    let theme_media_rels = match truthy(chain.theme_path.as_deref()) {
        Some(path) => Some(part_media_rels(archive, path)?),
        None => None,
    };
    Ok(InheritanceCtx {
        layout_path: chain.layout_path.clone(),
        master_path: chain.master_path.clone(),
        layout_xml: layout_xml.map(str::to_owned),
        master_xml: master_xml.map(str::to_owned),
        theme,
        master_placeholders,
        master_text_styles,
        default_text_style,
        layout_media_rels,
        master_media_rels,
        theme_media_rels,
    })
}
