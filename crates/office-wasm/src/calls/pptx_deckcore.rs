//! index.ts 1-1155 of the slides engine (open, reparse, save, commit, the
//! slide patch, the backgrounds), `materializeSlide`, `appendRawElements`
//! and `addTable`, called as `index.<TypeScript name>` on an opened deck.
//! The inputs are those of tools/pptx-diff/calls-deckcore.ts: an edit is
//! made through the model before the operation (`args.edits`, read there).

use jscompat::JsNum;
use pptx_engine::deck::{
    BackgroundImageSource, OpenedPptx, SlideBackgroundFill, add_table, append_raw_elements,
    build_zip, commit_saved, materialize_slide, patch_slide_xml, patched_element_xml, reparse_deck,
    reset_slide_background, save_pptx, set_slide_background, set_slide_background_image,
    set_slide_bg_graphics_hidden, with_uuid,
};
use pptx_engine::insert::NewTableOptions;
use pptx_engine::types::{Fill, Insets, PPrDirty, SlideElement, Stroke};
use pptx_engine::with_element;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::pptx_deck::deck_op;
use super::{Returned, arg, required};

/// What `crypto.randomUUID` answers while an edit's bytes are patched.
const UUID: &str = "0b8f1c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b";

#[derive(Deserialize)]
struct EditSet {
    field: String,
    value: Value,
}

#[derive(Deserialize)]
struct Edit {
    slide: f64,
    #[serde(default)]
    element: Option<f64>,
    #[serde(default)]
    flags: Option<Vec<String>>,
    #[serde(default)]
    ppr: Option<Value>,
    #[serde(default)]
    set: Option<EditSet>,
    #[serde(default)]
    structure: Option<bool>,
}

/// The index of `n`: a negative or fractional number, as an array index, is no element.
fn as_index(n: f64) -> usize {
    if n >= 0.0 && n.fract() == 0.0 && n < usize::MAX as f64 {
        n as usize
    } else {
        usize::MAX
    }
}

fn index(args: &Value, key: &str) -> Result<usize, String> {
    Ok(arg::<f64>(args, key)?.map_or(usize::MAX, as_index))
}

fn missing(what: &str, at: usize) -> String {
    format!("no {what} at index {at}")
}

fn from_json<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|error| error.to_string())
}

/// `applyEdits` of the TypeScript spec.
fn apply_edits(opened: &mut OpenedPptx, edits: Option<Vec<Edit>>) -> Result<(), String> {
    for edit in edits.unwrap_or_default() {
        let Some(slide) = opened.deck.slides.get_mut(as_index(edit.slide)) else {
            continue;
        };
        if edit.structure == Some(true) {
            slide.structure_dirty.set(true);
        }
        let Some(element) = edit.element else {
            continue;
        };
        let Some(el) = slide
            .elements
            .as_mut()
            .and_then(|elements| elements.get_mut(as_index(element)))
        else {
            continue;
        };
        for flag in edit.flags.iter().flatten() {
            match flag.as_str() {
                "dirty" => with_element!(el, e => e.dirty.set(true)),
                "dirtyTransform" => with_element!(el, e => e.dirty_transform.set(true)),
                "dirtyFill" => with_element!(el, e => e.dirty_fill.set(true)),
                "dirtyStroke" => with_element!(el, e => e.dirty_stroke.set(true)),
                "dirtySrcRect" => with_element!(el, e => e.dirty_src_rect.set(true)),
                // the object of `ppr` replaces it
                _ => {}
            }
        }
        if let Some(ppr) = &edit.ppr {
            let dirty: PPrDirty = from_json(ppr)?;
            with_element!(el, e => e.dirty_p_pr.set(dirty));
        }
        let Some(set) = &edit.set else {
            continue;
        };
        match set.field.as_str() {
            "fill" => {
                let fill: Fill = from_json(&set.value)?;
                match el {
                    SlideElement::Text(t) => t.fill.set(fill),
                    SlideElement::Picture(p) => p.fill.set(fill),
                    _ => {}
                }
            }
            "stroke" => {
                let stroke: Stroke = from_json(&set.value)?;
                match el {
                    SlideElement::Text(t) => t.stroke.set(stroke),
                    SlideElement::Picture(p) => p.stroke.set(stroke),
                    _ => {}
                }
            }
            "srcRect" => {
                if let SlideElement::Picture(p) = el {
                    if set.value.is_null() {
                        p.src_rect.delete();
                    } else {
                        p.src_rect.set(from_json::<Insets>(&set.value)?);
                    }
                }
            }
            "offsetX" => {
                let x = set.value.as_f64().unwrap_or(f64::NAN);
                with_element!(el, e => {
                    if let Some(transform) = e.transform.as_mut() {
                        transform.offset.x = JsNum(x);
                    }
                });
            }
            "runText" => {
                let text = set.value.as_str().unwrap_or_default().to_owned();
                if let SlideElement::Text(t) = el
                    && let Some(run) = t
                        .text
                        .as_mut()
                        .and_then(|body| body.paragraphs.as_mut())
                        .and_then(|paragraphs| paragraphs.get_mut(0))
                        .and_then(|paragraph| paragraph.runs.as_mut())
                        .and_then(|runs| runs.get_mut(0))
                {
                    run.text.set(text);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn edits(args: &Value) -> Result<Option<Vec<Edit>>, String> {
    arg(args, "edits")
}

/// `savedEntries` of the TypeScript spec: `[path, text | 'bytes <n> <sha-256>', deflated]`
/// per file of the package a save writes, in order. JSZip stores an empty file.
fn saved_entries(opened: &mut OpenedPptx) -> Result<Value, String> {
    // the bytes are written first: a save that fails is a failed call
    save_pptx(opened)?;
    let entries: Vec<(String, String, bool)> = build_zip(opened)?
        .into_iter()
        .map(|(path, bytes, deflate)| {
            let lower = path.to_ascii_lowercase();
            let text = if lower.ends_with(".xml") || lower.ends_with(".rels") {
                jscompat::text_decoder_decode(&bytes).into_owned()
            } else {
                format!("bytes {} {:x}", bytes.len(), Sha256::digest(&bytes))
            };
            let deflated = deflate && !bytes.is_empty();
            (path, text, deflated)
        })
        .collect();
    serde_json::to_value(entries).map_err(|error| error.to_string())
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "index.openPptx" => deck_op(text, args, |_| Ok(Value::Null)),
        "index.reparseDeck" => deck_op(text, args, |opened| {
            apply_edits(opened, edits(args)?)?;
            reparse_deck(opened)?;
            Ok(Value::Null)
        }),
        "index.savePptx" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                apply_edits(opened, edits(args)?)?;
                saved_entries(opened)
            })
        }),
        "index.commitSaved" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                apply_edits(opened, edits(args)?)?;
                if arg::<bool>(args, "save")? != Some(false) {
                    save_pptx(opened)?;
                }
                // an edit made while the stream was running stays dirty
                apply_edits(opened, arg(args, "afterSave")?)?;
                commit_saved(opened);
                // a second save writes what the commit baked in
                if arg::<bool>(args, "again")? == Some(true) {
                    saved_entries(opened)
                } else {
                    Ok(Value::Null)
                }
            })
        }),
        "index.patchSlideXml" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                apply_edits(opened, edits(args)?)?;
                let at = index(args, "slide")?;
                let slide = opened
                    .deck
                    .slides
                    .get_mut(at)
                    .ok_or_else(|| missing("slide", at))?;
                Ok(Value::String(patch_slide_xml(slide)))
            })
        }),
        "index.patchedElementXml" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                apply_edits(opened, edits(args)?)?;
                let (s, e) = (index(args, "slide")?, index(args, "element")?);
                let el = opened
                    .deck
                    .slides
                    .get_mut(s)
                    .ok_or_else(|| missing("slide", s))?
                    .elements
                    .as_mut()
                    .and_then(|elements| elements.get_mut(e))
                    .ok_or_else(|| missing("element", e))?;
                Ok(Value::String(patched_element_xml(el)))
            })
        }),
        "index.setSlideBackground" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                apply_edits(opened, edits(args)?)?;
                let fill: SlideBackgroundFill = required(args, "fill")?;
                set_slide_background(opened, index(args, "slide")?, &fill)?;
                Ok(Value::Null)
            })
        }),
        "index.setSlideBackgroundImage" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                let source: BackgroundImageSource = required(args, "source")?;
                let tile: Option<bool> = arg(args, "tile")?;
                let used =
                    set_slide_background_image(opened, index(args, "slide")?, &source, tile)?;
                serde_json::to_value(used).map_err(|error| error.to_string())
            })
        }),
        "index.resetSlideBackground" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                apply_edits(opened, edits(args)?)?;
                reset_slide_background(opened, index(args, "slide")?)?;
                Ok(Value::Null)
            })
        }),
        "index.setSlideBgGraphicsHidden" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                let hidden: bool = required(args, "hidden")?;
                set_slide_bg_graphics_hidden(opened, index(args, "slide")?, hidden)?;
                Ok(Value::Null)
            })
        }),
        "index.materializeSlide" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                apply_edits(opened, edits(args)?)?;
                let found = materialize_slide(opened, index(args, "slide")?)?;
                Ok(Value::Bool(found))
            })
        }),
        "index.appendRawElements" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                let xmls: Vec<String> = required(args, "xmls")?;
                let ids = append_raw_elements(opened, index(args, "slide")?, &xmls)?;
                serde_json::to_value(ids).map_err(|error| error.to_string())
            })
        }),
        "index.addTable" => deck_op(text, args, |opened| {
            with_uuid(UUID, || {
                let opts: NewTableOptions = required(args, "opts")?;
                let id = add_table(opened, index(args, "slide")?, &opts)?;
                serde_json::to_value(id).map_err(|error| error.to_string())
            })
        }),
        _ => Err(format!("no function named {function}")),
    }
}
