//! Header/footer (packages/pptx-engine/src/headerfooter.ts): "Apply to All"
//! writes dt / ftr / sldNum placeholder entities into each slide.

use std::sync::Arc;

use jscompat::{JsNum, Slot, math_round, number_to_string, trim};
use serde::{Deserialize, Serialize};

use crate::animation::{c_nv_pr_ids_in_xml, prune_timing_for_spids};
use crate::deck::{OpenedPptx, materialize_slide};
use crate::generate::{generate_paragraph_xml, tag_hangul_run};
use crate::insert::next_c_nv_pr_id;
use crate::types::{
    ByteAnchor, ElementType, EmuRect, Paragraph, Slide, SlideElement, TextAlign, TextElement,
    TextRun, Transform,
};

/// `HeaderFooterOptions`
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFooterOptions {
    /// Footer text; null/undefined/'' = no footer
    #[serde(default)]
    pub footer: Option<String>,
    /// Whether to show the slide number
    #[serde(default)]
    pub slide_num: Option<bool>,
    /// Date text; null/'' = hidden
    #[serde(default)]
    pub date: Option<String>,
    /// Use a dynamic date field
    #[serde(default)]
    pub date_auto: Option<bool>,
}

fn is_hf_type(placeholder: &str) -> bool {
    matches!(placeholder, "ftr" | "sldNum" | "dt")
}

/// `el.placeholder && HF_TYPES.has(el.placeholder)`
fn is_hf_element(el: &SlideElement) -> bool {
    crate::with_element!(el, e => e.placeholder.as_deref().is_some_and(|p| !p.is_empty() && is_hf_type(p)))
}

#[derive(Clone, Copy)]
struct HfBox {
    x: f64,
    y: f64,
    cx: f64,
    cy: f64,
}

fn hf_sp_xml(slide: &Slide, kind: &str, idx: u32, b: HfBox, para: &Paragraph) -> String {
    let id = number_to_string(next_c_nv_pr_id(slide));
    let name = match kind {
        "dt" => "Date Placeholder",
        "ftr" => "Footer Placeholder",
        _ => "Slide Number Placeholder",
    };
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name} {id}\"/>\
         <p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr>\
         <p:nvPr><p:ph type=\"{kind}\" sz=\"{sz}\" idx=\"{idx}\"/></p:nvPr></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\
         <p:txBody><a:bodyPr vert=\"horz\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" rtlCol=\"0\" anchor=\"ctr\"/><a:lstStyle/>\
         {para}</p:txBody></p:sp>",
        sz = if kind == "dt" { "half" } else { "quarter" },
        x = number_to_string(b.x),
        y = number_to_string(b.y),
        cx = number_to_string(b.cx),
        cy = number_to_string(b.cy),
        para = generate_paragraph_xml(para),
    )
}

/// `x.toString(36)` for the non-negative integer `Date.now()` gives.
fn radix36(x: f64) -> String {
    if !x.is_finite() || x < 0.0 || x.fract() != 0.0 || x >= 18_446_744_073_709_551_616.0 {
        return number_to_string(x);
    }
    let mut value = x as u64;
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits: Vec<u8> = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// `{ text, field?, fontSize: 12, color: '898989' }`
fn hf_run(text: &str, field: Option<&str>) -> TextRun {
    TextRun {
        text: Slot::of(text.to_owned()),
        field: Slot::maybe(field.map(str::to_owned)),
        font_size: Slot::of(JsNum(12.0)),
        color: Slot::of("898989".to_owned()),
        ..TextRun::default()
    }
}

fn hf_paragraph(align: TextAlign, run: TextRun) -> Paragraph {
    Paragraph {
        align: Slot::of(align),
        runs: Slot::of(vec![run]),
        ..Paragraph::default()
    }
}

/// Apply header/footer to the given slides (all slides by default). Removes
/// existing dt/ftr/sldNum placeholder elements first, then appends new ones
/// per the toggles. Returns whether any slide was modified. `now_ms` is
/// `Date.now()`.
pub fn apply_header_footer(
    opened: &mut OpenedPptx,
    opts: &HeaderFooterOptions,
    slide_indexes: Option<&[f64]>,
    now_ms: f64,
) -> Result<bool, String> {
    let targets: Vec<f64> = match slide_indexes {
        Some(list) => list.to_vec(),
        None => (0..opened.deck.slides.len()).map(|i| i as f64).collect(),
    };
    let cx = opened.deck.size.cx.0;
    let cy = opened.deck.size.cy.0;
    let bar_h = math_round(cy * 0.045);
    let bar_y = math_round(cy * 0.93);
    let mut changed = false;

    for target in targets {
        // deck.slides[i] for a non-index (fraction, negative) is undefined
        if target < 0.0 || target.fract() != 0.0 {
            continue;
        }
        let i = target as usize;
        let mut dirty = false;
        {
            let Some(slide) = opened.deck.slides.get_mut(i) else {
                continue;
            };
            // 1) Remove existing footer-family placeholders (and their animations)
            let elements = std::mem::take(
                slide
                    .elements
                    .as_mut()
                    .ok_or_else(|| "the slide has no elements".to_owned())?,
            );
            let before = elements.len();
            let (removed, kept): (Vec<SlideElement>, Vec<SlideElement>) =
                elements.into_iter().partition(is_hf_element);
            let mut removed_ids: Vec<f64> = Vec::new();
            for el in &removed {
                let xml = crate::with_element!(el, e => (*e.anchor).as_ref().map(|a| a.original_xml.clone()));
                if let Some(xml) = xml {
                    for id in c_nv_pr_ids_in_xml(&xml) {
                        if !removed_ids.contains(&id.0) {
                            removed_ids.push(id.0);
                        }
                    }
                }
            }
            if let Some(list) = slide.elements.as_mut() {
                *list = kept;
            }
            prune_timing_for_spids(slide, &removed_ids)?;
            dirty = slide.elements.as_deref().map_or(0, <[_]>::len) != before || dirty;

            // 2) Append enabled placeholders (dt left -> ftr center -> sldNum right)
            let mut specs: Vec<(&str, u32, HfBox, Paragraph)> = Vec::new();
            if let Some(date) = opts.date.as_deref().filter(|d| !d.is_empty()) {
                let field = (opts.date_auto == Some(true)).then_some("datetime1");
                specs.push((
                    "dt",
                    10,
                    HfBox {
                        x: math_round(cx * 0.05),
                        y: bar_y,
                        cx: math_round(cx * 0.22),
                        cy: bar_h,
                    },
                    hf_paragraph(TextAlign::Left, tag_hangul_run(&hf_run(date, field))),
                ));
            }
            if let Some(footer) = opts.footer.as_deref().filter(|f| !f.is_empty()) {
                specs.push((
                    "ftr",
                    11,
                    HfBox {
                        x: math_round(cx * 0.3),
                        y: bar_y,
                        cx: math_round(cx * 0.4),
                        cy: bar_h,
                    },
                    hf_paragraph(TextAlign::Center, tag_hangul_run(&hf_run(footer, None))),
                ));
            }
            if opts.slide_num == Some(true) {
                specs.push((
                    "sldNum",
                    12,
                    HfBox {
                        x: math_round(cx * 0.86),
                        y: bar_y,
                        cx: math_round(cx * 0.09),
                        cy: bar_h,
                    },
                    hf_paragraph(
                        TextAlign::Right,
                        hf_run(&(i + 1).to_string(), Some("slidenum")),
                    ),
                ));
            }
            for (kind, idx, b, para) in specs {
                let xml = hf_sp_xml(slide, kind, idx, b, &para);
                let len = slide.elements.as_deref().map_or(0, <[_]>::len);
                let el = TextElement {
                    // materialize reparses the whole slide, so these temporary model fields suffice
                    id: Slot::of(format!("hfnew_{len}_{}", radix36(now_ms))),
                    r#type: Slot::of(ElementType::Text),
                    anchor: Slot::of(ByteAnchor {
                        sp_index: len as i64,
                        original_xml: Arc::from(xml),
                        range: [0, 0],
                        gap_after: None,
                    }),
                    transform: Slot::of(Transform {
                        offset: EmuRect {
                            x: JsNum(0.0),
                            y: JsNum(0.0),
                            cx: JsNum(0.0),
                            cy: JsNum(0.0),
                        },
                        rot: JsNum(0.0),
                        flip_h: false,
                        flip_v: false,
                    }),
                    ..TextElement::default()
                };
                if let Some(list) = slide.elements.as_mut() {
                    list.push(SlideElement::Text(Box::new(el)));
                }
                dirty = true;
            }

            if dirty {
                slide.structure_dirty.set(true);
            }
        }
        if dirty {
            materialize_slide(opened, i)?;
            changed = true;
        }
    }
    Ok(changed)
}

/// `readHeaderFooter` result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFooterState {
    pub footer: Option<String>,
    pub slide_num: bool,
    pub date: Option<String>,
}

/// Read a slide's current footer state (for dialog echo-back).
pub fn read_header_footer(slide: &Slide) -> HeaderFooterState {
    let mut footer: Option<String> = None;
    let mut date: Option<String> = None;
    let mut slide_num = false;
    for el in slide.elements.as_deref().unwrap_or(&[]) {
        let SlideElement::Text(t) = el else {
            continue;
        };
        let text = t.text.as_ref().map(|body| {
            let joined = body
                .paragraphs
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(|p| {
                    p.runs
                        .as_deref()
                        .unwrap_or(&[])
                        .iter()
                        .map(|r| r.text.as_deref().unwrap_or(""))
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n");
            trim(&joined).to_owned()
        });
        let non_empty = text.filter(|s| !s.is_empty());
        match t.placeholder.as_deref() {
            Some("ftr") => footer = non_empty,
            Some("dt") => date = non_empty,
            Some("sldNum") => slide_num = true,
            _ => {}
        }
    }
    HeaderFooterState {
        footer,
        slide_num,
        date,
    }
}
