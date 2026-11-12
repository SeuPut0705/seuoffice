//! parse.ts 4328-4401: the master and layout decoration layer
//! (`parseDecorations`, `substituteSlideNum`) and `intOr`.

use jscompat::{Radix, js_regex, number_to_string, parse_int, value_to_string};
use std::sync::Arc;

use super::context::{DecorationOptions, Node, ParseContext};
use crate::scan::scan_slide;
use crate::types::{ByteAnchor, SlideElement, TextBody};

/// `(el as { placeholder?: string }).placeholder`
fn placeholder_of(el: &SlideElement) -> Option<&str> {
    match el {
        SlideElement::Text(el) => el.placeholder.as_deref(),
        SlideElement::Picture(el) => el.placeholder.as_deref(),
        SlideElement::Group(el) => el.placeholder.as_deref(),
        SlideElement::Table(el) => el.placeholder.as_deref(),
        SlideElement::Chart(el) => el.placeholder.as_deref(),
        SlideElement::Passthrough(el) => el.placeholder.as_deref(),
    }
}

/// `parseDecorations`; `opts` defaults to `{}` at the callers.
pub fn parse_decorations(
    xml: &str,
    ctx: &ParseContext<'_>,
    opts: &DecorationOptions,
) -> Result<Vec<SlideElement>, String> {
    let Ok(scan) = scan_slide(xml) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (idx, sp) in scan.elements.iter().enumerate() {
        let frag_xml = match (usize::try_from(sp.start), usize::try_from(sp.end)) {
            (Ok(start), Ok(end)) => xml.get(start..end).unwrap_or_default(),
            _ => "",
        };
        let anchor = ByteAnchor {
            sp_index: -(idx as i64 + 1),
            original_xml: Arc::from(""),
            range: [0, 0],
            gap_after: None,
        };
        let Some(mut el) = super::shape::parse_shape_fragment(sp, frag_xml, anchor, ctx)? else {
            continue;
        };
        if matches!(el, SlideElement::Passthrough(_)) {
            continue;
        }
        if let Some(ph) = placeholder_of(&el) {
            let allowed = opts
                .hf_types
                .as_ref()
                .is_some_and(|types| types.iter().any(|t| t == ph));
            if !allowed {
                continue;
            }
        } else if js_regex!(r"<p:ph[\s/>]").test(frag_xml) || opts.hide_shapes == Some(true) {
            continue;
        }
        if let Some(num) = opts.slide_num {
            substitute_slide_num(&mut el, num);
        }
        out.push(el);
    }
    Ok(out)
}

/// `substituteSlideNum`. A group nests at most `MAX_GROUP_DEPTH` deep, so
/// the recursion is bounded by the parse that built it. A key slot gives no
/// mutable access to its value, so what changes is copied, written and set
/// back in its place; only an element with a `slidenum` field is copied.
pub(crate) fn substitute_slide_num(el: &mut SlideElement, num: f64) {
    if !has_slidenum_field(el) {
        return;
    }
    match el {
        SlideElement::Group(group) => {
            if let Some(mut children) = (*group.children).clone() {
                for c in children.iter_mut() {
                    substitute_slide_num(c, num);
                }
                group.children.set(children);
            }
        }
        SlideElement::Text(el) => {
            if let Some(mut body) = (*el.text).clone() {
                if let Some(mut paragraphs) = (*body.paragraphs).clone() {
                    for p in paragraphs.iter_mut() {
                        if let Some(mut runs) = (*p.runs).clone() {
                            for r in runs.iter_mut() {
                                if r.field.as_deref() == Some("slidenum") {
                                    r.text.set(number_to_string(num));
                                }
                            }
                            p.runs.set(runs);
                        }
                    }
                    body.paragraphs.set(paragraphs);
                }
                el.text.set(body);
            }
        }
        _ => {}
    }
}

/// Whether `substituteSlideNum` writes anything under this element.
fn has_slidenum_field(el: &SlideElement) -> bool {
    match el {
        SlideElement::Group(group) => group.children.iter().flatten().any(has_slidenum_field),
        SlideElement::Text(el) => el.text.iter().any(body_has_slidenum_field),
        _ => false,
    }
}

fn body_has_slidenum_field(body: &TextBody) -> bool {
    body.paragraphs.iter().flatten().any(|p| {
        p.runs
            .iter()
            .flatten()
            .any(|r| r.field.as_deref() == Some("slidenum"))
    })
}

/// `intOr`
pub(crate) fn int_or(v: Node<'_>, dflt: f64) -> f64 {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return dflt;
    };
    let n = parse_int(&value_to_string(Some(v)), Radix::Ten);
    if n.is_nan() { dflt } else { n }
}
