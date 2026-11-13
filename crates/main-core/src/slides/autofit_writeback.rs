//! `apps/slides/src/main/autofit-writeback.ts`: text-edit autofit write-back.
//! After a text change the rendered layout decides the box size (spAutoFit)
//! or the shrink ratio (normAutofit), and the model follows it so the saved
//! file opens at the same size.
//!
//! What moved is the numeric judgment: `needH`, `needW`, the thresholds,
//! `toEmu`, the alignment shift, `nowrapContentWidth` and the decision whether
//! the fontScale/lnSpcReduction pair changed. The render node and the text
//! layout are plain data ([`TextNode`], [`RenderTextLayout`]); the deck's
//! element, `layoutText`, `patchBodyPrAutofit`, `rebuildSlide` and
//! `matchesElementRef` (pptx-engine and pptx-render are engine-waiting) are the
//! [`AutofitHost`] the caller implements over its session.

use jscompat::{math_max, math_min, math_round, number_truthy, truthy};

/// `EMU_PER_PX_96` of pptx-render
pub const EMU_PER_PX_96: f64 = 9525.0;

/// `RenderTextLayout.insets`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextInsets {
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

/// one run of a laid-out line: `x` and `widthPx`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextRun {
    pub x: f64,
    pub width_px: f64,
}

/// one laid-out line: its `align` and its runs
#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    pub align: Option<String>,
    pub runs: Vec<TextRun>,
}

/// `RenderTextLayout`, as far as the write-back reads it
#[derive(Debug, Clone, PartialEq)]
pub struct RenderTextLayout {
    pub lines: Vec<TextLine>,
    pub insets: TextInsets,
    pub content_height: f64,
    /// bodyPr wrap (false = no wrapping)
    pub wrap: bool,
    /// bodyPr vert; `None` is `undefined`
    pub vert: Option<String>,
}

/// a render node found by its `sourceId`: its `type`, its box and its text
#[derive(Debug, Clone, PartialEq)]
pub struct TextNode {
    /// `'shape'`, `'text'` or another kind of node
    pub node_type: String,
    pub box_w: f64,
    pub box_h: f64,
    pub text: Option<RenderTextLayout>,
}

/// the render slide `rebuildSlide` answers
pub trait AutofitRendered {
    /// `rendered.nodes.find((n) => n.sourceId === id)`
    fn node_of(&self, source_id: &str) -> Option<TextNode>;
}

/// the `text` body of a model element, as far as the write-back reads it
#[derive(Debug, Clone, PartialEq)]
pub struct AutofitText {
    /// `autofit`: `'resize'`, `'shrink'`, `'none'` or none
    pub autofit: Option<String>,
    pub font_scale: Option<f64>,
    pub ln_spc_reduction: Option<f64>,
}

/// a model element of the deck's slide
#[derive(Debug, Clone, PartialEq)]
pub struct AutofitElement {
    /// `el.id`
    pub id: String,
    /// `el.type`: `'text'`, `'shape'` or another
    pub el_type: String,
    pub text: Option<AutofitText>,
    /// `el.transform.offset.x`
    pub offset_x: f64,
}

/// what `layoutText({ ..., refitAutofit: true })` answers, as far as it is read
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextRefit {
    pub font_scale: f64,
    pub ln_spc_reduction: Option<f64>,
}

/// The session as the write-back reaches it.
pub trait AutofitHost {
    type Rendered: AutofitRendered;

    /// `session.opened.deck.slides[slideIndex]`, then
    /// `slide.elements.find((e) => matchesElementRef(e, sourceId))`: `None`
    /// when there is no slide or no such element
    fn find_element(&mut self, slide_index: usize, source_id: &str) -> Option<AutofitElement>;
    /// `session.opened.deck.size.cx`
    fn deck_width_emu(&mut self) -> f64;
    /// `session.fitWidthPx`
    fn fit_width_px(&mut self) -> f64;
    /// `rebuildSlide(session, slideIndex)`
    fn rebuild_slide(&mut self, slide_index: usize) -> Option<Self::Rendered>;
    /// `el.transform = { ...el.transform, offset: { ...el.transform.offset, x, cx, cy } }`
    /// and `el.dirtyTransform = true`
    fn write_resized_transform(
        &mut self,
        slide_index: usize,
        source_id: &str,
        x: f64,
        cx: f64,
        cy: f64,
    );
    /// `layoutText({ body: el.text, boxWidthPx, boxHeightPx, metrics: getFontMetrics(),
    /// vp: makeViewport(size, fitWidthPx), refitAutofit: true })`
    fn refit_layout(
        &mut self,
        slide_index: usize,
        source_id: &str,
        box_width_px: f64,
        box_height_px: f64,
    ) -> TextRefit;
    /// `el.text.fontScale = value`
    fn set_font_scale(&mut self, slide_index: usize, source_id: &str, value: f64);
    /// `el.text.lnSpcReduction = value`, or `delete el.text.lnSpcReduction` for `None`
    fn set_ln_spc_reduction(&mut self, slide_index: usize, source_id: &str, value: Option<f64>);
    /// `el.anchor.originalXml = patchBodyPrAutofit(el.anchor.originalXml, fontScale, lnSpcReduction)`
    fn patch_body_pr_autofit(
        &mut self,
        slide_index: usize,
        source_id: &str,
        font_scale: f64,
        ln_spc_reduction: f64,
    );
    /// `slide.structureDirty = true`
    fn mark_structure_dirty(&mut self, slide_index: usize);
}

/// `findEl(slide, sourceId)`: a text or shape element of the slide
fn find_el<H: AutofitHost>(
    host: &mut H,
    slide_index: usize,
    source_id: &str,
) -> Option<AutofitElement> {
    let el = host.find_element(slide_index, source_id)?;
    if el.el_type == "text" || el.el_type == "shape" {
        Some(el)
    } else {
        None
    }
}

/// Box width a nowrap body needs: widest laid-out line plus the insets (an
/// empty body keeps the insets alone).
fn nowrap_content_width(text: &RenderTextLayout) -> f64 {
    let mut left = f64::INFINITY;
    let mut right = f64::NEG_INFINITY;
    for line in &text.lines {
        for run in &line.runs {
            left = math_min(left, run.x);
            right = math_max(right, run.x + run.width_px);
        }
    }
    let content = if right > left { right - left } else { 0.0 };
    content + text.insets.l + text.insets.r
}

/// The text node of a rendered slide a write-back may act on: a shape or text
/// node that has a text layout.
fn text_node_of<R: AutofitRendered>(rendered: &R, el: &AutofitElement) -> Option<TextNode> {
    let node = rendered.node_of(&el.id)?;
    if node.node_type != "shape" && node.node_type != "text" {
        return None;
    }
    node.text.as_ref()?;
    Some(node)
}

/// `applyAutofitResize(session, slideIndex, sourceId, rendered)`: spAutoFit
/// (`autofit = 'resize'`): after a text change, the box height grows/shrinks
/// with the content and is written back to cy; a wrap="none" body also follows
/// its widest line in cx. `rendered` is the rebuilt result after this change;
/// when the size changed, the transform is updated and the slide rebuilt once
/// more. Top-level elements only.
pub fn apply_autofit_resize<H: AutofitHost>(
    host: &mut H,
    slide_index: usize,
    source_id: &str,
    rendered: Option<H::Rendered>,
) -> Option<H::Rendered> {
    let rendered = rendered?;
    let el = find_el(host, slide_index, source_id);
    let Some(el) = el else {
        return Some(rendered);
    };
    let resize = el
        .text
        .as_ref()
        .is_some_and(|text| text.autofit.as_deref() == Some("resize"));
    if !resize {
        return Some(rendered);
    }
    let Some(node) = text_node_of(&rendered, &el) else {
        return Some(rendered);
    };
    let text = node.text.as_ref().expect("checked by text_node_of");
    let need_h = text.content_height + text.insets.t + text.insets.b;
    let need_w = if !text.wrap && truthy(text.vert.as_deref()).is_none() {
        nowrap_content_width(text)
    } else {
        node.box_w
    };
    if (need_h - node.box_h).abs() < 1.0 && (need_w - node.box_w).abs() < 1.0 {
        return Some(rendered);
    }
    let base_width_px = host.deck_width_emu() / EMU_PER_PX_96;
    let scale = host.fit_width_px() / base_width_px;
    let to_emu = |px: f64| math_max(math_round((px / scale) * EMU_PER_PX_96), 1.0);
    // A nowrap box grows around its alignment: right-aligned text keeps the
    // right edge, centered keeps the center
    let align = text.lines.first().and_then(|line| line.align.as_deref());
    let shift_x = match align {
        Some("right") => node.box_w - need_w,
        Some("center") => (node.box_w - need_w) / 2.0,
        _ => 0.0,
    };
    let x = el.offset_x + math_round((shift_x / scale) * EMU_PER_PX_96);
    host.write_resized_transform(slide_index, source_id, x, to_emu(need_w), to_emu(need_h));
    host.rebuild_slide(slide_index)
}

/// `syncAutofitScale(session, slideIndex, sourceId, rendered)`: normAutofit
/// fontScale write-back. When the shrink ratio the layout actually used after
/// a text edit (at most the stored cap, shrink-only) differs from the stored
/// model value, the model is synced and the bodyPr attribute patched, so
/// PowerPoint shows the same size on open. Triggered only by text edits;
/// top-level elements only.
pub fn sync_autofit_scale<H: AutofitHost>(
    host: &mut H,
    slide_index: usize,
    source_id: &str,
    rendered: Option<H::Rendered>,
) -> Option<H::Rendered> {
    let rendered = rendered?;
    let el = find_el(host, slide_index, source_id);
    let Some(el) = el else {
        return Some(rendered);
    };
    let Some(body) = el
        .text
        .as_ref()
        .filter(|text| text.autofit.as_deref() == Some("shrink"))
    else {
        return Some(rendered);
    };
    let Some(node) = text_node_of(&rendered, &el) else {
        return Some(rendered);
    };
    // The plain render honors the stored fontScale as-is; after a text edit,
    // re-run the layout with the autofit ladder enabled to find the ratio
    // PowerPoint would now use (still capped at the stored value).
    let refit = host.refit_layout(slide_index, source_id, node.box_w, node.box_h);
    let effective = refit.font_scale;
    let effective_red = refit.ln_spc_reduction.unwrap_or(0.0);
    if (effective - body.font_scale.unwrap_or(1.0)).abs() < 0.005
        && (effective_red - body.ln_spc_reduction.unwrap_or(0.0)).abs() < 0.005
    {
        return Some(rendered);
    }
    host.set_font_scale(slide_index, source_id, effective);
    host.set_ln_spc_reduction(
        slide_index,
        source_id,
        if number_truthy(effective_red) {
            Some(effective_red)
        } else {
            None
        },
    );
    host.patch_body_pr_autofit(slide_index, source_id, effective, effective_red);
    host.mark_structure_dirty(slide_index);
    // The render above used the pre-edit stored scale; redo it at the written-back value
    Some(host.rebuild_slide(slide_index).unwrap_or(rendered))
}
