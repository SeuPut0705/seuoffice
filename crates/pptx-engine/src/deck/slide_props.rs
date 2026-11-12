//! packages/pptx-engine/src/index.ts, slide transitions, auto-advance time,
//! hidden slides and `reassembleSlideXml` (4327-4377).

use crate::generate::{
    SlideTransitionKind, patch_slide_advance_time_xml, patch_slide_hidden_xml,
    patch_slide_transition_xml, read_slide_advance_time_xml, read_slide_hidden_xml,
    read_slide_transition_xml,
};
use crate::types::{ByteAnchor, Slide, SlideElement};

/// `slide.bodySuffix`; '' where the slide has none.
fn body_suffix(slide: &Slide) -> &str {
    slide.body_suffix.as_deref().unwrap_or("")
}

/// `slide.bodyPrefix`; '' where the slide has none.
fn body_prefix(slide: &Slide) -> &str {
    slide.body_prefix.as_deref().unwrap_or("")
}

/// `setSlideTransition`: set/clear the transition (writes bodySuffix).
pub fn set_slide_transition(slide: &mut Slide, kind: SlideTransitionKind) {
    let next = patch_slide_transition_xml(body_suffix(slide), kind);
    slide.body_suffix.set(next);
    slide.structure_dirty.set(true);
}

/// `getSlideTransition`
pub fn get_slide_transition(slide: &Slide) -> SlideTransitionKind {
    read_slide_transition_xml(body_suffix(slide))
}

/// `setSlideAdvanceTime`: set/clear the auto-advance time (advTm, ms).
pub fn set_slide_advance_time(slide: &mut Slide, ms: Option<f64>) {
    let next = patch_slide_advance_time_xml(body_suffix(slide), ms);
    slide.body_suffix.set(next);
    slide.structure_dirty.set(true);
}

/// `getSlideAdvanceTime`
pub fn get_slide_advance_time(slide: &Slide) -> Option<f64> {
    read_slide_advance_time_xml(body_suffix(slide))
}

/// `setSlideHidden`
pub fn set_slide_hidden(slide: &mut Slide, hidden: bool) {
    let next = patch_slide_hidden_xml(body_prefix(slide), hidden);
    slide.body_prefix.set(next);
    slide.structure_dirty.set(true);
}

/// `getSlideHidden`
pub fn get_slide_hidden(slide: &Slide) -> bool {
    read_slide_hidden_xml(body_prefix(slide))
}

/// `el.anchor` of any element.
fn anchor_of(el: &SlideElement) -> Option<&ByteAnchor> {
    crate::with_element!(el, e => (*e.anchor).as_ref())
}

/// `reassembleSlideXml`: the slide's prefix, every element's original bytes
/// with its gap, then the suffix.
pub fn reassemble_slide_xml(slide: &Slide) -> String {
    let mut out = String::from(body_prefix(slide));
    for el in (*slide.elements).as_deref().unwrap_or(&[]) {
        if let Some(anchor) = anchor_of(el) {
            out.push_str(&anchor.original_xml);
            // `if (el.anchor.gapAfter)`: an empty gap is falsy and adds nothing anyway
            if let Some(gap) = &anchor.gap_after {
                out.push_str(gap);
            }
        }
    }
    out.push_str(body_suffix(slide));
    out
}
