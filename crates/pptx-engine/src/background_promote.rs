//! Full-page background normalization (packages/pptx-engine/src/background-promote.ts):
//! `promote_slide_background` rewrites bottom-of-z-order full-page opaque
//! rectangles into a native `<p:bg>`; `is_background_like_element` is the loose
//! predicate the render layer uses to mark surviving full-page backgrounds.

use jscompat::{js_regex, number_to_string, trim};

use crate::animation::element_spid;
use crate::generate::{BackgroundFillPatch, patch_slide_background_xml};
use crate::types::{Fill, Slide, SlideElement, SlideSize, Stroke, TextElement, Transform};

const EMU_PER_PX: f64 = 9525.0;
const COVER_TOL: f64 = 2.0 * EMU_PER_PX;

fn covers_page(t: &Transform, size: &SlideSize, max_area_ratio: f64) -> bool {
    let o = &t.offset;
    o.x.0 <= COVER_TOL
        && o.y.0 <= COVER_TOL
        && o.x.0 + o.cx.0 >= size.cx.0 - COVER_TOL
        && o.y.0 + o.cy.0 >= size.cy.0 - COVER_TOL
        && o.cx.0 * o.cy.0 <= size.cx.0 * size.cy.0 * max_area_ratio
}

fn is_opaque_color(c: &str) -> bool {
    js_regex!(r"^#?[0-9a-fA-F]{6}$").test(c) || js_regex!(r"^#?[0-9a-fA-F]{6}[fF]{2}$").test(c)
}

/// No stroke, zero width, or a fully transparent stroke color (#RRGGBB00).
fn stroke_invisible(stroke: Option<&Stroke>) -> bool {
    let Some(stroke) = stroke else {
        return true;
    };
    if stroke.width.0 == 0.0 || matches!(stroke.fill, Fill::None) {
        return true;
    }
    match &stroke.fill {
        Fill::Solid { color } => color == "none" || js_regex!(r"^#?[0-9a-fA-F]{6}00$").test(color),
        _ => false,
    }
}

fn has_visible_text(el: &TextElement) -> bool {
    let Some(text) = el.text.as_ref() else {
        return false;
    };
    text.paragraphs.as_deref().unwrap_or(&[]).iter().any(|p| {
        p.runs
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|r| !trim(r.text.as_deref().unwrap_or("")).is_empty())
    })
}

/// `el.placeholder` is truthy.
fn has_placeholder(el: &SlideElement) -> bool {
    crate::with_element!(el, e => e.placeholder.as_deref().is_some_and(|p| !p.is_empty()))
}

/// The element as a text/shape element, when it is one.
fn as_text(el: &SlideElement) -> Option<&TextElement> {
    match el {
        SlideElement::Text(t) => Some(t),
        _ => None,
    }
}

/// Strict predicate for the destructive rewrite: the element's fill color
/// when it is an unrotated, unflipped, non-placeholder full-page rect with an
/// opaque solid fill, invisible stroke, no effects and no text.
fn promotable_background_color<'a>(el: &'a SlideElement, size: &SlideSize) -> Option<&'a str> {
    let t = as_text(el)?;
    let tr = (*t.transform).as_ref()?;
    let promotable = !has_placeholder(el)
        && tr.rot.0 == 0.0
        && !tr.flip_h
        && !tr.flip_v
        && covers_page(tr, size, 1.05)
        && t.preset_geometry.as_deref().unwrap_or("rect") == "rect"
        && t.custom_geometry.is_none()
        && match t.fill.as_ref() {
            Some(Fill::Solid { color }) => is_opaque_color(color),
            _ => false,
        }
        && stroke_invisible(t.stroke.as_ref())
        && t.shadow.is_none()
        && t.glow.is_none()
        && !has_visible_text(t);
    if !promotable {
        return None;
    }
    match t.fill.as_ref() {
        Some(Fill::Solid { color }) => Some(color),
        _ => None,
    }
}

/// Animations target shapes by cNvPr id; a referenced shape must not be deleted.
fn is_referenced_by_timing(slide: &Slide, el: &SlideElement) -> bool {
    let Some(id) = element_spid(el) else {
        return true;
    };
    let reference = format!("spid=\"{}\"", number_to_string(id.0));
    slide
        .body_suffix
        .as_deref()
        .unwrap_or("")
        .contains(&reference)
        || slide
            .body_prefix
            .as_deref()
            .unwrap_or("")
            .contains(&reference)
}

/// Promote the bottom-of-z-order contiguous run of full-page opaque solid
/// shapes into a native `<p:bg>` (topmost color wins) and delete them.
pub fn promote_slide_background(slide: &mut Slide, size: &SlideSize) -> bool {
    let mut count = 0usize;
    let mut last_color: Option<String> = None;
    for el in slide.elements.as_deref().unwrap_or(&[]) {
        let Some(color) = promotable_background_color(el, size) else {
            break;
        };
        if is_referenced_by_timing(slide, el) {
            break;
        }
        count += 1;
        last_color = Some(color.to_owned());
    }
    if count == 0 {
        return false;
    }
    let Some(color) = last_color else {
        return false;
    };
    if let Some(elements) = slide.elements.as_mut() {
        elements.drain(0..count);
    }
    let prefix = patch_slide_background_xml(
        slide.body_prefix.as_deref().unwrap_or(""),
        &BackgroundFillPatch::Color(color.clone()),
    );
    slide.body_prefix.set(prefix);
    slide.background.set(Fill::Solid { color });
    slide.structure_dirty.set(true);
    true
}

/// Loose predicate for interaction-layer marking: a full-page unrotated
/// textless fill (solid/gradient/image shape, or a picture) with an invisible
/// stroke.
pub fn is_background_like_element(el: &SlideElement, size: &SlideSize) -> bool {
    let transform = crate::with_element!(el, e => *e.transform);
    let Some(tr) = transform else {
        return false;
    };
    if has_placeholder(el) || tr.rot.0 != 0.0 {
        return false;
    }
    if !covers_page(&tr, size, 1.5) {
        return false;
    }
    if let SlideElement::Picture(p) = el {
        return p.media.is_none() && stroke_invisible(p.stroke.as_ref());
    }
    let Some(t) = as_text(el) else {
        return false;
    };
    matches!(
        t.fill.as_ref(),
        Some(Fill::Solid { .. } | Fill::Gradient(_) | Fill::Image(_))
    ) && t.preset_geometry.as_deref().unwrap_or("rect") == "rect"
        && t.custom_geometry.is_none()
        && stroke_invisible(t.stroke.as_ref())
        && !has_visible_text(t)
}
