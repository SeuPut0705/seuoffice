//! `pptxDeckslides.*`: index.ts (new slides, merge, delete, reorder, connectors,
//! layout and size) and embedded-fonts.ts of the slides engine, called as
//! `<module>.<TypeScript name>` on an opened deck (see pptx_deck.rs). A second
//! deck (the source of a merge or a paste) is `args.other`, base64.

use std::collections::HashSet;

use jscompat::{JsNum, atob};
use pptx_engine::deck::{
    ConnectionPatch, ConnectionSide, DuplicateSlideOptions, MergeSlideOptions, OpenedPptx,
    PasteSlideOptions, ReorderDirection, connection_site_for_side, copy_slide, delete_slide,
    duplicate_slide, extract_merge_slide_source, insert_blank_slide, insert_slide_with_layout,
    merge_slide_from_pptx, merge_slide_from_source, open_pptx, paste_slide, reorder_element,
    reset_slide_layout, set_element_connection, set_slide_layout, set_slide_size,
    update_connectors_for_moved,
};
use pptx_engine::embedded_fonts::{
    EmbeddedFontStyle, GlyphDemand, GlyphSet, demand_key, edited_glyph_demand, eot_to_sfnt,
    list_embedded_fonts, sfnt_cmap_lookup, stale_embedded_typefaces, strip_embedded_fonts,
    strip_stale_embedded_fonts,
};
use pptx_engine::types::{ConnectionEnd, Slide};
use serde_json::Value;

use super::pptx_deck::{deck_op, element_id};
use super::{Returned, arg, required, value};

/// A numeric argument; `null` and an absent one read as NaN, which no slide has.
fn num(args: &Value, key: &str) -> Result<f64, String> {
    Ok(arg::<f64>(args, key)?.unwrap_or(f64::NAN))
}

/// `slides[index]` of a number.
fn index_of(index: f64) -> Option<usize> {
    (index.is_finite() && index.fract() == 0.0 && index >= 0.0 && index <= f64::from(u32::MAX))
        .then_some(index as usize)
}

/// `at.element(slide, element)`
fn elem_id(opened: &OpenedPptx, slide: f64, element: f64) -> String {
    match (index_of(slide), index_of(element)) {
        (Some(s), Some(e)) => element_id(opened, s, e),
        _ => String::new(),
    }
}

/// `at.slide(index)`: what the TypeScript passes as `undefined` throws in the callee.
fn slide_mut(opened: &mut OpenedPptx, index: f64) -> Result<&mut Slide, String> {
    index_of(index)
        .and_then(|i| opened.deck.slides.get_mut(i))
        .ok_or_else(|| "no slide at that index".to_owned())
}

/// The slide a function returned (`Slide | null`).
fn slide_value(opened: &OpenedPptx, at: Option<usize>) -> Result<Value, String> {
    match at.and_then(|i| opened.deck.slides.get(i)) {
        Some(slide) => serde_json::to_value(slide).map_err(|error| error.to_string()),
        None => Ok(Value::Null),
    }
}

fn json<T: serde::Serialize>(result: T) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// `Buffer.from(args.other, 'base64')`
fn other_bytes(args: &Value) -> Result<Vec<u8>, String> {
    let other: String = required(args, "other")?;
    atob(&other).map_err(|error| error.to_string())
}

/// `markDirty` of the TypeScript spec: the dirty flags the input asks for.
fn mark_dirty(opened: &mut OpenedPptx, args: &Value) -> Result<(), String> {
    let slide = num(args, "slide")?;
    let Some(slide) = index_of(slide).and_then(|i| opened.deck.slides.get_mut(i)) else {
        return Ok(());
    };
    let mode: Option<String> = arg(args, "dirty")?;
    match mode.as_deref() {
        Some("slide") => slide.structure_dirty.set(true),
        Some("element") => {
            let element = num(args, "dirtyElement")?;
            let at = index_of(element);
            if let Some(el) = at.and_then(|i| slide.elements.as_mut().and_then(|e| e.get_mut(i))) {
                pptx_engine::with_element!(el, e => e.dirty.set(true));
            }
        }
        _ => {}
    }
    Ok(())
}

/// `layoutFrom` of the merge options: the path of the target slide asked for, when there is one.
fn layout_from(opened: &OpenedPptx, args: &Value) -> Result<Option<String>, String> {
    let Some(index) = arg::<f64>(args, "layoutFrom")? else {
        return Ok(None);
    };
    Ok(index_of(index)
        .and_then(|i| opened.deck.slides.get(i))
        .and_then(|slide| slide.path.as_ref().cloned()))
}

/// `new Map(demand.map(([k, v]) => [k, new Set(v)]))`
fn demand_of(args: &Value) -> Result<GlyphDemand, String> {
    let pairs: Vec<(String, Vec<u32>)> = required(args, "demand")?;
    let mut demand = GlyphDemand::new();
    for (key, cps) in pairs {
        let mut set = GlyphSet::default();
        for cp in cps {
            set.add(cp);
        }
        demand.set(key, set);
    }
    Ok(demand)
}

fn style_of(name: &str) -> Result<EmbeddedFontStyle, String> {
    Ok(match name {
        "regular" => EmbeddedFontStyle::Regular,
        "bold" => EmbeddedFontStyle::Bold,
        "italic" => EmbeddedFontStyle::Italic,
        "boldItalic" => EmbeddedFontStyle::BoldItalic,
        other => return Err(format!("no embedded font style {other}")),
    })
}

/// One end of a connection patch: absent is `undefined`, `null` detaches.
fn patch_end(args: &Value, key: &str) -> Result<Option<Option<ConnectionEnd>>, String> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(end) => {
            let id = end.get("id").and_then(Value::as_f64).unwrap_or(f64::NAN);
            let idx = end.get("idx").and_then(Value::as_f64).unwrap_or(f64::NAN);
            Ok(Some(Some(ConnectionEnd {
                id: JsNum(id),
                idx: JsNum(idx),
            })))
        }
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "index.duplicateSlide" => deck_op(text, args, |opened| {
            let opts = arg::<bool>(args, "clearText")?.map(|clear_text| DuplicateSlideOptions {
                clear_text: Some(clear_text),
            });
            let at = duplicate_slide(opened, num(args, "slide")?, opts.as_ref())?;
            slide_value(opened, at)
        }),
        "index.copySlide" => deck_op(text, args, |opened| {
            json(copy_slide(opened, num(args, "slide")?)?)
        }),
        "index.pasteSlide" => {
            // the source deck opens before the target: its ids come first on both sides
            let mut other = match arg::<String>(args, "other")? {
                Some(_) => Some(open_pptx(&other_bytes(args)?)?),
                None => None,
            };
            deck_op(text, args, |opened| {
                let from = num(args, "from")?;
                let bundle = match other.as_mut() {
                    Some(other) => copy_slide(other, from)?,
                    None => copy_slide(opened, from)?,
                };
                let Some(bundle) = bundle else {
                    return Err("no bundle".to_owned());
                };
                let opts =
                    arg::<bool>(args, "keepSourceFormatting")?.map(|keep| PasteSlideOptions {
                        keep_source_formatting: Some(keep),
                    });
                let at = paste_slide(opened, num(args, "after")?, &bundle, opts.as_ref())?;
                slide_value(opened, at)
            })
        }
        "index.insertBlankSlide" => deck_op(text, args, |opened| {
            let at = insert_blank_slide(opened, num(args, "slide")?)?;
            slide_value(opened, at)
        }),
        "index.mergeSlideFromPptx" => deck_op(text, args, |opened| {
            let bytes = other_bytes(args)?;
            let from = layout_from(opened, args)?;
            let opts = MergeSlideOptions {
                layout_from: from.as_deref(),
            };
            let at = merge_slide_from_pptx(opened, &bytes, &opts)?;
            slide_value(opened, at)
        }),
        "index.extractMergeSlideSource" => value(extract_merge_slide_source(&other_bytes(args)?)?),
        "index.mergeSlideFromSource" => {
            let source = extract_merge_slide_source(&other_bytes(args)?)?;
            deck_op(text, args, |opened| {
                let Some(source) = source.as_ref() else {
                    return Err("no source".to_owned());
                };
                let from = layout_from(opened, args)?;
                let opts = MergeSlideOptions {
                    layout_from: from.as_deref(),
                };
                let at = merge_slide_from_source(opened, source, &opts)?;
                slide_value(opened, at)
            })
        }
        "index.insertSlideWithLayout" => deck_op(text, args, |opened| {
            let layout: String = required(args, "layout")?;
            let at = insert_slide_with_layout(opened, num(args, "slide")?, &layout)?;
            slide_value(opened, at)
        }),
        "index.deleteSlide" => deck_op(text, args, |opened| {
            json(delete_slide(opened, num(args, "slide")?)?)
        }),
        "index.reorderElement" => deck_op(text, args, |opened| {
            let slide = num(args, "slide")?;
            let id = elem_id(opened, slide, num(args, "element")?);
            let dir: String = required(args, "dir")?;
            let slide = slide_mut(opened, slide)?;
            // an unknown direction reads as `idx - 1` in the TypeScript (its last branch)
            let dir = match dir.as_str() {
                "front" => ReorderDirection::Front,
                "back" => ReorderDirection::Back,
                "forward" => ReorderDirection::Forward,
                _ => ReorderDirection::Backward,
            };
            json(reorder_element(slide, &id, dir))
        }),
        "index.setSlideLayout" => deck_op(text, args, |opened| {
            let layout: String = required(args, "layout")?;
            let at = set_slide_layout(opened, num(args, "slide")?, &layout)?;
            slide_value(opened, at)
        }),
        "index.resetSlideLayout" => deck_op(text, args, |opened| {
            let at = reset_slide_layout(opened, num(args, "slide")?)?;
            slide_value(opened, at)
        }),
        "index.setSlideSize" => deck_op(text, args, |opened| {
            json(set_slide_size(opened, num(args, "cx")?, num(args, "cy")?)?)
        }),
        "index.connectionSiteForSide" => deck_op(text, args, |opened| {
            let side: ConnectionSide = required(args, "side")?;
            let el = index_of(num(args, "slide")?)
                .and_then(|s| opened.deck.slides.get(s))
                .and_then(|slide| slide.elements.as_ref())
                .zip(index_of(num(args, "element")?))
                .and_then(|(elements, e)| elements.get(e))
                .ok_or_else(|| "no element at that index".to_owned())?;
            json(connection_site_for_side(el, side))
        }),
        "index.updateConnectorsForMoved" => deck_op(text, args, |opened| {
            let slide = num(args, "slide")?;
            let moved: Vec<f64> = required(args, "moved")?;
            let ids: Vec<String> = moved.iter().map(|e| elem_id(opened, slide, *e)).collect();
            let slide = slide_mut(opened, slide)?;
            json(update_connectors_for_moved(slide, &ids))
        }),
        "index.setElementConnection" => deck_op(text, args, |opened| {
            let slide = num(args, "slide")?;
            let element = num(args, "element")?;
            if arg::<bool>(args, "dirty")?.unwrap_or(false)
                && let Some(el) = index_of(slide)
                    .and_then(|s| opened.deck.slides.get_mut(s))
                    .and_then(|s| s.elements.as_mut())
                    .zip(index_of(element))
                    .and_then(|(elements, e)| elements.get_mut(e))
            {
                pptx_engine::with_element!(el, e => e.dirty_transform.set(true));
            }
            let id = elem_id(opened, slide, element);
            let patch = ConnectionPatch {
                start: patch_end(args, "start")?,
                end: patch_end(args, "end")?,
            };
            let slide = slide_mut(opened, slide)?;
            json(set_element_connection(slide, &id, &patch))
        }),
        "embeddedFonts.eotToSfnt" => {
            let bytes: Vec<u8> = required(args, "bytes")?;
            value(eot_to_sfnt(&bytes))
        }
        "embeddedFonts.demandKey" => {
            let style: String = required(args, "style")?;
            value(demand_key(text, style_of(&style)?))
        }
        "embeddedFonts.editedGlyphDemand" => deck_op(text, args, |opened| {
            mark_dirty(opened, args)?;
            json(edited_glyph_demand(&opened.deck.slides))
        }),
        "embeddedFonts.sfntCmapLookup" => {
            let bytes: Vec<u8> = required(args, "bytes")?;
            let probes: Vec<u32> = required(args, "probes")?;
            value(sfnt_cmap_lookup(&bytes).map(|lookup| {
                probes
                    .iter()
                    .map(|cp| lookup.covers(*cp))
                    .collect::<Vec<bool>>()
            }))
        }
        "embeddedFonts.staleEmbeddedTypefaces" => deck_op(text, args, |opened| {
            json(stale_embedded_typefaces(
                &opened.archive,
                &demand_of(args)?,
            )?)
        }),
        "embeddedFonts.stripEmbeddedFonts" => deck_op(text, args, |opened| {
            let typefaces: Option<Vec<String>> = arg(args, "typefaces")?;
            let set: Option<HashSet<String>> = typefaces.map(|list| list.into_iter().collect());
            json(strip_embedded_fonts(&mut opened.archive, set.as_ref()))
        }),
        "embeddedFonts.stripStaleEmbeddedFonts" => deck_op(text, args, |opened| {
            mark_dirty(opened, args)?;
            json(strip_stale_embedded_fonts(
                &opened.deck.slides,
                &mut opened.archive,
            )?)
        }),
        "embeddedFonts.listEmbeddedFonts" => deck_op(text, args, |opened| {
            json(list_embedded_fonts(&opened.archive)?)
        }),
        other => Err(format!("pptxDeckslides: no function {other}")),
    }
}
