//! index.ts lines 2906-3721 of the slides engine (charts, hidden/name, fonts,
//! find/replace, paragraph format), called as `index.<TypeScript name>`.
//! The deck operations open `args.deck` as tools/pptx-diff/deck-ops.ts does.
//!
//! `FontSizeMap` is a function argument: where `args.sizeStep` is true both
//! sides give the stand-in `(pt) => (pt ?? 18) + 2` ([`gate_size_map`]).

use pptx_engine::deck::{
    ChartEditPatch, ElementFontPatch, FontSizeMap, ParagraphFormatPatch, ReplaceOptions,
    apply_paragraph_format, edit_chart_element, get_chart_element_data, mark_chart_editable,
    replace_all_in_deck, set_element_font, set_element_hidden, set_element_name,
    set_element_paragraph_format, set_group_child_paragraph_format,
};
use pptx_engine::types::{PPrDirty, Paragraph, SlideElement};
use serde::Serialize;
use serde_json::{Map, Value};

use super::pptx_deck::{deck_op, element_id};
use super::{Returned, arg, required, value};

/// The stand-in `GATE_SIZE_MAP` of calls-decktext.ts.
fn gate_size_map(pt: Option<f64>) -> f64 {
    pt.unwrap_or(18.0) + 2.0
}

fn size_map(args: &Value) -> Result<Option<FontSizeMap<'static>>, String> {
    let step: Option<bool> = arg(args, "sizeStep")?;
    Ok((step == Some(true)).then_some(&gate_size_map as FontSizeMap<'static>))
}

/// `args.slide` and `args.element`.
fn indexes(args: &Value) -> Result<(usize, usize), String> {
    Ok((required(args, "slide")?, required(args, "element")?))
}

fn json(result: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// What `applyParagraphFormat` answers: the dirty flags and the paragraphs it changed.
#[derive(Serialize)]
struct Applied {
    dirty: PPrDirty,
    paragraphs: Vec<Paragraph>,
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "index.editChartElement" => deck_op(text, args, |opened| {
            let (s, e) = indexes(args)?;
            let id = element_id(opened, s, e);
            let patch: ChartEditPatch = required(args, "patch")?;
            json(edit_chart_element(opened, s, &id, &patch)?)
        }),
        "index.markChartEditable" => deck_op(text, args, |opened| {
            let (s, e) = indexes(args)?;
            let id = element_id(opened, s, e);
            let slide = opened
                .deck
                .slides
                .get_mut(s)
                .ok_or_else(|| "no such slide".to_owned())?;
            json(mark_chart_editable(slide, &id))
        }),
        "index.setElementHidden" => deck_op(text, args, |opened| {
            let (s, e) = indexes(args)?;
            let id = element_id(opened, s, e);
            let hidden: bool = required(args, "hidden")?;
            let slide = opened
                .deck
                .slides
                .get_mut(s)
                .ok_or_else(|| "no such slide".to_owned())?;
            json(set_element_hidden(slide, &id, hidden)?)
        }),
        "index.setElementName" => deck_op(text, args, |opened| {
            let (s, e) = indexes(args)?;
            let id = element_id(opened, s, e);
            let name: String = required(args, "name")?;
            let slide = opened
                .deck
                .slides
                .get_mut(s)
                .ok_or_else(|| "no such slide".to_owned())?;
            json(set_element_name(slide, &id, &name)?)
        }),
        "index.getChartElementData" => deck_op(text, args, |opened| {
            let (s, e) = indexes(args)?;
            let id = element_id(opened, s, e);
            let slide = opened
                .deck
                .slides
                .get(s)
                .ok_or_else(|| "no such slide".to_owned())?;
            json(get_chart_element_data(slide, &id))
        }),
        "index.setElementFont" => deck_op(text, args, |opened| {
            let (s, e) = indexes(args)?;
            let id = element_id(opened, s, e);
            let patch: ElementFontPatch = required(args, "patch")?;
            let map = size_map(args)?;
            let slide = opened
                .deck
                .slides
                .get_mut(s)
                .ok_or_else(|| "no such slide".to_owned())?;
            json(set_element_font(slide, &id, &patch, map)?)
        }),
        "index.replaceAllInDeck" => deck_op(text, args, |opened| {
            let find: String = required(args, "find")?;
            let replace: String = required(args, "replace")?;
            // `opts.elementAt`: an element of slide 0 by index, which the TypeScript names by id
            let mut opts: Map<String, Value> = required(args, "opts")?;
            if let Some(index) = opts.remove("elementAt") {
                let index = index.as_u64().unwrap_or(0) as usize;
                opts.insert(
                    "elementId".to_owned(),
                    Value::String(element_id(opened, 0, index)),
                );
            }
            let opts: ReplaceOptions =
                serde_json::from_value(Value::Object(opts)).map_err(|error| error.to_string())?;
            json(replace_all_in_deck(
                &mut opened.deck,
                &find,
                &replace,
                &opts,
            )?)
        }),
        "index.applyParagraphFormat" => {
            let mut paragraphs: Vec<Paragraph> = required(args, "paragraphs")?;
            let patch: ParagraphFormatPatch = required(args, "patch")?;
            let dirty = apply_paragraph_format(&mut paragraphs, &patch);
            value(Applied { dirty, paragraphs })
        }
        "index.setElementParagraphFormat" => deck_op(text, args, |opened| {
            let (s, e) = indexes(args)?;
            let id = element_id(opened, s, e);
            let patch: ParagraphFormatPatch = required(args, "patch")?;
            let indices: Option<Vec<f64>> = arg(args, "paraIndices")?;
            let then: Option<ParagraphFormatPatch> = arg(args, "then")?;
            let then_indices: Option<Vec<f64>> = arg(args, "thenIndices")?;
            let slide = opened
                .deck
                .slides
                .get_mut(s)
                .ok_or_else(|| "no such slide".to_owned())?;
            let first = set_element_paragraph_format(slide, &id, &patch, indices.as_deref())?;
            let Some(then) = then else {
                return json(first);
            };
            let second = set_element_paragraph_format(slide, &id, &then, then_indices.as_deref())?;
            json([first, second])
        }),
        "index.setGroupChildParagraphFormat" => deck_op(text, args, |opened| {
            let (s, e) = indexes(args)?;
            let id = element_id(opened, s, e);
            let child: usize = required(args, "child")?;
            let patch: ParagraphFormatPatch = required(args, "patch")?;
            let indices: Option<Vec<f64>> = arg(args, "paraIndices")?;
            let slide = opened
                .deck
                .slides
                .get_mut(s)
                .ok_or_else(|| "no such slide".to_owned())?;
            // `group.children[child].id`, '' where there is none
            let child_id = (*slide.elements)
                .as_deref()
                .and_then(|els| els.iter().find(|el| el.id() == id))
                .and_then(|el| match el {
                    SlideElement::Group(group) => (*group.children)
                        .as_deref()
                        .and_then(|children| children.get(child))
                        .map(|c| c.id().to_owned()),
                    _ => None,
                })
                .unwrap_or_default();
            json(set_group_child_paragraph_format(
                slide,
                &id,
                &child_id,
                &patch,
                indices.as_deref(),
            )?)
        }),
        _ => Err(format!("unknown function {function}")),
    }
}
