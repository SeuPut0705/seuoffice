//! parse.ts 179-297: `parseSlide` and `parseBackground`.

use jscompat::{Radix, Slot, js_regex, parse_int, truthy, value_to_string, value_truthy};
use std::sync::Arc;

use super::context::{ParseContext, SlideParseInput, parse_xml};
use crate::scan::{SpElement, scan_slide};
use crate::theme::resolve_scheme_color;
use crate::types::{ByteAnchor, Fill, PassthroughKind, Slide, SlideElement, assigned};

/// `slideXml.slice(start, end)` with offsets the scan took from that same
/// text.
fn fragment(xml: &str, start: u64, end: u64) -> &str {
    match (usize::try_from(start), usize::try_from(end)) {
        (Ok(start), Ok(end)) => xml.get(start..end).unwrap_or_default(),
        _ => "",
    }
}

/// `...(gapAfter ? { gapAfter } : {})`
fn gap_after(sp: &SpElement<'_>) -> Option<String> {
    truthy(sp.gap_after).map(str::to_owned)
}

/// `parseSlide`
pub fn parse_slide(input: SlideParseInput<'_>) -> Result<Slide, String> {
    let SlideParseInput {
        path,
        slide_xml,
        layout_path,
        master_path,
        ctx,
    } = input;
    let canonical = crate::xml_utils::canonical_xml(slide_xml)?;
    let slide_xml: &str = &canonical;
    let scan = scan_slide(slide_xml).map_err(|error| error.to_string())?;

    let budget = super::shape::MAX_GROUP_DESCENDANTS;
    let mut elements: Vec<SlideElement> = Vec::new();
    for (idx, sp) in scan.elements.iter().take(budget).enumerate() {
        let frag_xml = fragment(slide_xml, sp.start, sp.end);
        let anchor = ByteAnchor {
            sp_index: idx as i64,
            original_xml: Arc::from(frag_xml),
            range: [sp.start, sp.end],
            gap_after: gap_after(sp),
        };
        if let Some(el) = super::shape::parse_shape_fragment(sp, frag_xml, anchor, &ctx)? {
            elements.push(el);
        }
    }
    let surplus = scan.elements.get(budget..).unwrap_or_default();
    if let (Some(first), Some(last)) = (surplus.first(), surplus.last()) {
        elements.push(SlideElement::Passthrough(Box::new(
            super::shape::passthrough(
                ByteAnchor {
                    sp_index: budget as i64,
                    original_xml: Arc::from(fragment(slide_xml, first.start, last.end)),
                    range: [first.start, last.end],
                    gap_after: gap_after(last),
                },
                PassthroughKind::Unknown,
                None,
                &ctx,
            ),
        )));
    }
    let own_background = parse_background(slide_xml, &ctx);
    let has_own_background = own_background.is_some();
    let default_bg1 = resolve_scheme_color("bg1", ctx.theme, None);
    let background = own_background
        .or_else(|| {
            truthy(ctx.layout_bg).and_then(|layout_bg| {
                parse_background(
                    layout_bg,
                    &ParseContext {
                        media_rels: ctx.layout_media_rels.or(ctx.media_rels),
                        ..ctx
                    },
                )
            })
        })
        .or_else(|| {
            truthy(ctx.master_bg).and_then(|master_bg| {
                parse_background(
                    master_bg,
                    &ParseContext {
                        media_rels: ctx.master_media_rels.or(ctx.media_rels),
                        ..ctx
                    },
                )
            })
        })
        .or_else(|| {
            truthy(default_bg1)
                .filter(|color| color.to_uppercase() != "#FFFFFF")
                .map(|color| Fill::Solid {
                    color: color.to_owned(),
                })
        });
    let master_sp_hidden =
        js_regex!(r#"<p:sld\b[^>]*\bshowMasterSp=(?:"(?:0|false)"|'(?:0|false)')"#).test(slide_xml);
    let bg_own = has_own_background || js_regex!(r"<p:bg[\s>]").test(slide_xml);

    Ok(Slide {
        path: Slot::of(path.to_owned()),
        original_xml: Slot::of(slide_xml.to_owned()),
        body_prefix: Slot::of(scan.body_prefix.to_owned()),
        body_suffix: Slot::of(scan.body_suffix.to_owned()),
        elements: Slot::of(elements),
        layout_path: assigned(layout_path.map(str::to_owned)),
        master_path: assigned(master_path.map(str::to_owned)),
        background: Slot::maybe(background),
        bg_own: Slot::maybe(bg_own.then_some(true)),
        master_sp_hidden: Slot::maybe(master_sp_hidden.then_some(true)),
        ..Slide::default()
    })
}

/// `parseBackground`
pub fn parse_background(xml: &str, ctx: &ParseContext<'_>) -> Option<Fill> {
    let m = js_regex!(r"<p:bg\b[\s\S]*?<\/p:bg>").exec(xml)?;
    let doc = parse_xml(m.as_str()).ok()?;
    let bg = doc.get("p:bg");
    let bg_pr = bg.and_then(|bg| bg.get("p:bgPr"));
    if value_truthy(bg_pr) {
        return super::fill::parse_fill(bg_pr, ctx);
    }
    let bg_ref = bg.and_then(|bg| bg.get("p:bgRef"));
    if value_truthy(bg_ref) {
        let color = super::fill::resolve_color_node(bg_ref, ctx);
        let idx_attr = bg_ref
            .and_then(|bg_ref| bg_ref.get("@_idx"))
            .filter(|idx| !idx.is_null())
            .map_or_else(String::new, |idx| value_to_string(Some(idx)));
        let idx = parse_int(&idx_attr, Radix::Ten);
        let theme = ctx.theme;
        let tpl = if idx >= 1001.0 {
            theme.and_then(|theme| style_at(theme.bg_fill_styles.as_deref(), idx - 1001.0))
        } else if idx >= 1.0 {
            theme.and_then(|theme| style_at(theme.fill_styles.as_deref(), idx - 1.0))
        } else {
            None
        };
        if value_truthy(tpl) {
            let fill = super::fill::parse_fill(
                tpl,
                &ParseContext {
                    ph_clr: color.as_deref(),
                    media_rels: ctx.theme_media_rels.or(ctx.media_rels),
                    ..*ctx
                },
            );
            if fill.is_some() {
                return fill;
            }
        }
        if let Some(color) = truthy(color.as_deref()) {
            return Some(Fill::Solid {
                color: color.to_owned(),
            });
        }
    }
    None
}

/// `styles?.[i]` for an integer `i` (parseInt gives one, or NaN).
fn style_at(styles: Option<&[serde_json::Value]>, i: f64) -> Option<&serde_json::Value> {
    let styles = styles?;
    if i >= 0.0 && i < styles.len() as f64 {
        styles.get(i as usize)
    } else {
        None
    }
}
