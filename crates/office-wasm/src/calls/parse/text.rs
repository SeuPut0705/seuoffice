//! The readers of runs, paragraphs and styles. A parsed node argument comes
//! as XML text with `args.node` naming the top-level element to take (none:
//! `undefined`). A `BuildContext` comes as `args.parts`, the package its
//! styles, numbering and theme are read from, and `args.ctx`, the names of
//! the members it has (`styles`, `numbering`, `numFormats`,
//! `defaultParaStyle`, `docDefaults`). A `ResolveCtx` comes as `args.parts`,
//! `args.compat` and `args.table`, as group `resolve` takes it.

use std::collections::BTreeMap;

use docx_engine::model::{
    EffectivePPr, EffectiveRPr, NoteInfo, NoteProps, ParaFormat, Run, TabStop,
};
use docx_engine::numbering::parse_numbering;
use docx_engine::parse::text::{self, ParaListRef, RunResolve, StyleCtx};
use docx_engine::props::XML_PARSER_MAX_NESTED_TAGS;
use docx_engine::resolve::{self, ResolveCtx};
use docx_engine::scan::BodyElement;
use docx_engine::theme::ThemeFonts;
use jscompat::{JsMap, JsNum};
use ooxml_xml::{XElement, XNode, parse_ordered};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::resolve::with_ctx;
use super::super::{Returned, arg, optional, package, required, value};

/// None: not a function of this module.
pub fn dispatch(function: &str, text_arg: &str, args: &Value) -> Option<Returned> {
    let call: fn(&str, &Value) -> Returned = match function {
        "breakCharOf" => break_char_of,
        "wtText" => wt_text,
        "emuToPx" => emu_to_px,
        "listRefOf" => list_ref_of,
        "listKindOf" => list_kind_of,
        "headingLevelOf" => heading_level_of,
        "styleBidiOf" => style_bidi_of,
        "normalSizeHalfPoints" => normal_size_half_points,
        "paraStyleDisplay" => para_style_display,
        "defaultParaStyle" => default_para_style,
        "inlineContentControlsOf" => inline_content_controls_of,
        "crossParagraphZoteroFields" => cross_paragraph_zotero_fields,
        "mathParaAlign" => math_para_align,
        "mathSizeHalfPoints" => math_size_half_points,
        "mathSourceXmlOf" => math_source_xml_of,
        "effectiveRunOf" => effective_run_of,
        "markSizeOf" => mark_size_of,
        "foldEffectiveFormat" => fold_effective_format,
        "legacyDirectRunFormat" => legacy_direct_run_format,
        "frameBoxOf" => frame_box_of,
        "paraFrameOf" => para_frame_of,
        "propChangeInfo" => prop_change_info,
        "mergeTabStops" => merge_tab_stops,
        "noteRunOf" => note_run_of,
        "noteNumbersOf" => note_numbers_of,
        _ => return None,
    };
    Some(call(text_arg, args))
}

fn break_char_of(_text: &str, args: &Value) -> Returned {
    let attrs = required::<BTreeMap<String, String>>(args, "attrs")?;
    value(
        text::break_char_of(
            attrs.get("w:clear").map(String::as_str),
            attrs.get("w:type").map(String::as_str),
        )
        .to_string(),
    )
}

fn wt_text(text_arg: &str, args: &Value) -> Returned {
    value(text::wt_text(text_arg, required::<bool>(args, "preserve")?))
}

fn emu_to_px(_text: &str, args: &Value) -> Returned {
    value(JsNum(text::emu_to_px(required::<f64>(args, "emu")?)))
}

/// The top-level element of `text` named `node` (none: `undefined`), as the
/// TypeScript side picks it from `xmlParser.parse(text)`; `Err` where the
/// parser refuses.
pub(super) fn with_named(
    text: &str,
    node: Option<&str>,
    call: impl FnOnce(Option<&XNode>) -> Returned,
) -> Returned {
    let nodes =
        parse_ordered(text, XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    call(node.and_then(|wanted| nodes.iter().find(|node| node.name() == Some(wanted))))
}

/// [`with_named`] with the element `args.node`.
pub(super) fn with_node(
    text: &str,
    args: &Value,
    call: impl FnOnce(Option<&XNode>) -> Returned,
) -> Returned {
    let node: Option<String> = arg(args, "node")?;
    with_named(text, node.as_deref(), call)
}

/// A node the TypeScript reads without a guard: it throws where there is none.
fn present(node: Option<&XNode>) -> Result<&XNode, String> {
    node.ok_or_else(|| "TypeError: no node".to_owned())
}

/// The `BuildContext` of `args`: the members `args.ctx` names, read from
/// `args.parts`.
fn with_style_ctx(args: &Value, call: impl FnOnce(&StyleCtx<'_>) -> Returned) -> Returned {
    let members: Vec<String> = required(args, "ctx")?;
    let has = |name: &str| members.iter().any(|member| member == name);
    let formats = if has("numFormats") {
        Some(parse_numbering(&package(args)?)?.formats)
    } else {
        None
    };
    with_ctx(args, |ctx: &ResolveCtx| {
        call(&StyleCtx {
            styles: has("styles").then_some(&ctx.styles),
            numbering: has("numbering").then_some(&ctx.numbering),
            num_formats: formats.as_ref(),
            default_para_style: ctx.default_para_style().filter(|_| has("defaultParaStyle")),
            doc_defaults: ctx.doc_defaults.as_ref().filter(|_| has("docDefaults")),
        })
    })
}

fn list_ref_of(text: &str, args: &Value) -> Returned {
    let style_id: Option<String> = arg(args, "styleId")?;
    with_style_ctx(args, |ctx| {
        with_node(text, args, |p_pr| {
            optional(text::list_ref_of(ctx, p_pr, style_id.as_deref())?)
        })
    })
}

fn list_kind_of(_text: &str, args: &Value) -> Returned {
    let num_id: String = required(args, "numId")?;
    let ilvl: JsNum = required(args, "ilvl")?;
    with_style_ctx(args, |ctx| value(text::list_kind_of(ctx, &num_id, ilvl.0)?))
}

fn heading_level_of(text: &str, args: &Value) -> Returned {
    let style_id: Option<String> = arg(args, "styleId")?;
    with_style_ctx(args, |ctx| {
        with_node(text, args, |p_pr| {
            optional(text::heading_level_of(p_pr, style_id.as_deref(), ctx)?)
        })
    })
}

fn style_bidi_of(_text: &str, args: &Value) -> Returned {
    let style_id: Option<String> = arg(args, "styleId")?;
    let list_ref: Option<ListRefArg> = arg(args, "listRef")?;
    let list_ref = list_ref.map(|list_ref| ParaListRef {
        num_id: list_ref.num_id,
        ilvl: list_ref.ilvl,
    });
    with_style_ctx(args, |ctx| {
        optional(text::style_bidi_of(
            ctx,
            style_id.as_deref(),
            list_ref.as_ref(),
        )?)
    })
}

/// `{ numId, ilvl }` as it crosses JSON.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListRefArg {
    num_id: String,
    ilvl: JsNum,
}

fn normal_size_half_points(_text: &str, args: &Value) -> Returned {
    with_style_ctx(args, |ctx| value(text::normal_size_half_points(ctx)))
}

fn para_style_display(_text: &str, args: &Value) -> Returned {
    let style_id: Option<String> = arg(args, "styleId")?;
    with_style_ctx(args, |ctx| {
        optional(text::para_style_display(ctx, style_id.as_deref()))
    })
}

/// `defaultParaStyle(styles)`: `ctx.defaultParaStyle` of the resolver, which
/// finds the same style; `undefined` without styles.
fn default_para_style(_text: &str, args: &Value) -> Returned {
    let members: Vec<String> = required(args, "ctx")?;
    if !members.iter().any(|member| member == "styles") {
        return Ok(None);
    }
    with_ctx(args, |ctx| optional(ctx.default_para_style()))
}

fn inline_content_controls_of(text: &str, _args: &Value) -> Returned {
    value(text::inline_content_controls_of(text).map_err(|limit| limit.to_string())?)
}

/// A `BodyElement` as it crosses JSON: its range in UTF-16 units.
#[derive(Deserialize)]
struct ElementArg {
    name: String,
    start: f64,
    end: f64,
}

/// `text.slice(start, end)` as a byte range: a negative index counts from the
/// end, an index past the end is the end. An index inside a surrogate pair
/// moves past the character at a start and before it at an end: half a pair
/// is in no token the readers match.
fn byte_range(text: &str, start: f64, end: f64) -> (usize, usize) {
    let length = text.encode_utf16().count() as f64;
    let clamp = |index: f64| {
        let index = if index.is_nan() { 0.0 } else { index.trunc() };
        if index < 0.0 {
            (length + index).max(0.0)
        } else {
            index.min(length)
        }
    };
    let byte_at = |unit: f64, after: bool| {
        let mut units = 0.0;
        for (byte, ch) in text.char_indices() {
            if units >= unit {
                return byte;
            }
            let width = ch.len_utf16() as f64;
            if units + width > unit {
                return if after { byte + ch.len_utf8() } else { byte };
            }
            units += width;
        }
        text.len()
    };
    (byte_at(clamp(start), true), byte_at(clamp(end), false))
}

fn cross_paragraph_zotero_fields(text: &str, args: &Value) -> Returned {
    let elements: Vec<ElementArg> = required(args, "elements")?;
    let ranges: Vec<(usize, usize)> = elements
        .iter()
        .map(|el| byte_range(text, el.start, el.end))
        .collect();
    let body: Vec<BodyElement<'_>> = elements
        .iter()
        .zip(&ranges)
        .map(|(el, &(start, end))| BodyElement {
            name: &el.name,
            start,
            end,
        })
        .collect();
    let found = text::cross_paragraph_zotero_fields(&body, text);
    // keyed by the start the TypeScript was given
    let entries: Vec<(JsNum, &text::ZoteroFieldParagraph)> = found
        .iter()
        .map(|(start, field)| {
            let at = ranges
                .iter()
                .position(|(byte, _)| byte == start)
                .unwrap_or_default();
            (JsNum(elements[at].start), field)
        })
        .collect();
    value(entries)
}

fn math_para_align(text: &str, args: &Value) -> Returned {
    let p_pr: String = required(args, "pPr")?;
    value(text::math_para_align(text, &p_pr).map_err(|error| error.to_string())?)
}

fn math_size_half_points(text: &str, args: &Value) -> Returned {
    let eff: EffectivePPr = required(args, "eff")?;
    value(text::math_size_half_points(text, &eff).map_err(|error| error.to_string())?)
}

fn math_source_xml_of(text: &str, _args: &Value) -> Returned {
    value(text::math_source_xml_of(text))
}

/// A call made earlier on the same `RunResolve`: its rPr as XML text.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EarlierArg {
    text: String,
    node: Option<String>,
    key: Option<String>,
}

fn effective_run_of(text: &str, args: &Value) -> Returned {
    let eff: resolve::EffectivePPr = required(args, "eff")?;
    let key: Option<String> = arg(args, "key")?;
    let earlier: Option<EarlierArg> = arg(args, "earlier")?;
    with_ctx(args, |rctx| {
        let mut res = RunResolve {
            eff: std::borrow::Cow::Borrowed(&eff),
            rctx,
            memo: JsMap::new(),
            para_rtl: None,
            diff: None,
        };
        if let Some(earlier) = &earlier {
            with_named(&earlier.text, earlier.node.as_deref(), |r_pr| {
                text::effective_run_of(&mut res, r_pr, earlier.key.as_deref().unwrap_or(""));
                Ok(None)
            })?;
        }
        with_node(text, args, |r_pr| {
            value(text::effective_run_of(
                &mut res,
                r_pr,
                key.as_deref().unwrap_or(""),
            ))
        })
    })
}

fn mark_size_of(text: &str, args: &Value) -> Returned {
    let eff: EffectivePPr = required(args, "eff")?;
    with_node(text, args, |p_pr| optional(text::mark_size_of(&eff, p_pr)))
}

fn fold_effective_format(text: &str, args: &Value) -> Returned {
    let format: Option<ParaFormat> = arg(args, "format")?;
    let eff: EffectivePPr = required(args, "eff")?;
    with_node(text, args, |p_pr| {
        value(text::fold_effective_format(format.as_ref(), p_pr, &eff))
    })
}

fn legacy_direct_run_format(text: &str, args: &Value) -> Returned {
    let cs: bool = required(args, "cs")?;
    let theme_fonts: Option<ThemeFonts> = arg(args, "themeFonts")?;
    with_node(text, args, |r_pr| {
        value(text::legacy_direct_run_format(
            present(r_pr)?,
            cs,
            theme_fonts.as_ref(),
        ))
    })
}

fn frame_box_of(text: &str, args: &Value) -> Returned {
    with_node(text, args, |p_pr| {
        optional(text::frame_box_of(present(p_pr)?))
    })
}

fn para_frame_of(_text: &str, args: &Value) -> Returned {
    let attrs: BTreeMap<String, String> = required(args, "attrs")?;
    let frame_pr = XNode::Element(XElement {
        name: "w:framePr".to_owned(),
        attrs: attrs.into_iter().collect(),
        children: Vec::new(),
    });
    optional(text::para_frame_of(&frame_pr))
}

fn prop_change_info(text: &str, args: &Value) -> Returned {
    let change_name: String = required(args, "changeName")?;
    optional(text::prop_change_info(text, &change_name))
}

fn merge_tab_stops(_text: &str, args: &Value) -> Returned {
    let style: Option<Vec<TabStop>> = arg(args, "style")?;
    let direct: Option<Vec<TabStop>> = arg(args, "direct")?;
    optional(text::merge_tab_stops(style.as_deref(), direct.as_deref()))
}

fn note_run_of(_text: &str, args: &Value) -> Returned {
    let run: Run = required(args, "run")?;
    let base: EffectiveRPr = required(args, "base")?;
    value(text::note_run_of(&run, &base))
}

/// A `Map` as it crosses JSON: its entries.
#[derive(Serialize)]
struct Entries<'a>(Vec<(&'a str, &'a JsNum)>);

fn note_numbers_of(text: &str, args: &Value) -> Returned {
    let footnotes: Vec<NoteInfo> = required(args, "footnotes")?;
    let endnotes: Vec<NoteInfo> = required(args, "endnotes")?;
    let footnote_props: Option<NoteProps> = arg(args, "footnoteProps")?;
    let endnote_props: Option<NoteProps> = arg(args, "endnoteProps")?;
    let numbers = text::note_numbers_of(
        text,
        &footnotes,
        &endnotes,
        footnote_props.as_ref(),
        endnote_props.as_ref(),
    );
    value(Entries(numbers.iter().collect()))
}
