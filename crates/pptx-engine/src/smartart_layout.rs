//! SmartArt preset layout math (packages/pptx-engine/src/smartart-layout.ts).

use std::f64::consts::PI;

use jscompat::{JsNum, math_cos, math_max, math_min, math_round, math_sin};
use serde::Serialize;

/// PowerPoint default theme accent series (colors picked in order).
pub const SMARTART_PALETTE: [&str; 8] = [
    "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "264478", "9E480E",
];

/// `EmuRect` of types.ts; the model port replaces it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct EmuRect {
    pub x: JsNum,
    pub y: JsNum,
    pub cx: JsNum,
    pub cy: JsNum,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartArtChildShape {
    pub prst: &'static str,
    #[serde(rename = "box")]
    pub r#box: EmuRect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub color: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<JsNum>,
    /// Fill opacity 0..1 (venn overlaps); `None` is opaque.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha: Option<JsNum>,
}

fn rect(x: f64, y: f64, cx: f64, cy: f64) -> EmuRect {
    EmuRect {
        x: JsNum(x),
        y: JsNum(y),
        cx: JsNum(cx),
        cy: JsNum(cy),
    }
}

fn color(i: usize) -> &'static str {
    SMARTART_PALETTE[i % SMARTART_PALETTE.len()]
}

/// `layoutShapes`: child shapes in the group's own coordinates (EMU).
/// `layout` is a `SmartArtLayout`; any other name lays out a hierarchy.
pub fn layout_shapes(layout: &str, items: &[String], cx: f64, cy: f64) -> Vec<SmartArtChildShape> {
    let n = math_min(math_max(items.len() as f64, 1.0), 8.0);
    let texts = &items[..items.len().min(n as usize)];
    let mut out: Vec<SmartArtChildShape> = Vec::new();
    let twelve = Some(JsNum(12.0));

    if layout == "list" {
        let gap = math_round(cy * 0.04);
        let h = math_round((cy - gap * (n - 1.0)) / n);
        for (i, t) in texts.iter().enumerate() {
            out.push(SmartArtChildShape {
                prst: "roundRect",
                r#box: rect(0.0, i as f64 * (h + gap), cx, h),
                text: Some(t.clone()),
                color: color(i),
                font_size: None,
                alpha: None,
            });
        }
    } else if layout == "process" {
        let overlap = 0.25;
        let w = math_round(cx / (n - (n - 1.0) * overlap));
        let h = math_round(cy * 0.6);
        let y = math_round((cy - h) / 2.0);
        for (i, t) in texts.iter().enumerate() {
            out.push(SmartArtChildShape {
                prst: if i == 0 { "homePlate" } else { "chevron" },
                r#box: rect(math_round(i as f64 * w * (1.0 - overlap)), y, w, h),
                text: Some(t.clone()),
                color: color(i),
                font_size: twelve,
                alpha: None,
            });
        }
    } else if layout == "cycle" {
        let node_w = math_round(cx * 0.3);
        let node_h = math_round(cy * 0.26);
        let rx = (cx - node_w) / 2.0;
        let ry = (cy - node_h) / 2.0;
        for (i, t) in texts.iter().enumerate() {
            let ang = -PI / 2.0 + (i as f64 * 2.0 * PI) / n;
            out.push(SmartArtChildShape {
                prst: "ellipse",
                r#box: rect(
                    math_round(cx / 2.0 - node_w / 2.0 + math_cos(ang) * rx),
                    math_round(cy / 2.0 - node_h / 2.0 + math_sin(ang) * ry),
                    node_w,
                    node_h,
                ),
                text: Some(t.clone()),
                color: color(i),
                font_size: twelve,
                alpha: None,
            });
        }
    } else if layout == "pyramid" {
        let h = math_round(cy / n);
        for (i, t) in texts.iter().enumerate() {
            let w = math_round((cx * (i as f64 + 1.0)) / n);
            out.push(SmartArtChildShape {
                prst: if i == 0 { "triangle" } else { "trapezoid" },
                r#box: rect(math_round((cx - w) / 2.0), i as f64 * h, w, h),
                text: Some(t.clone()),
                color: color(i),
                font_size: twelve,
                alpha: None,
            });
        }
    } else if layout == "matrix" {
        let gap = math_round(math_min(cx, cy) * 0.03);
        let rows = (n / 2.0).ceil();
        let w = math_round((cx - gap) / 2.0);
        let h = math_round((cy - gap * (rows - 1.0)) / rows);
        for (i, t) in texts.iter().enumerate() {
            out.push(SmartArtChildShape {
                prst: "roundRect",
                r#box: rect(
                    (i % 2) as f64 * (w + gap),
                    (i as f64 / 2.0).floor() * (h + gap),
                    w,
                    h,
                ),
                text: Some(t.clone()),
                color: color(i),
                font_size: twelve,
                alpha: None,
            });
        }
    } else if layout == "venn" {
        let m = math_min(n, 4.0);
        let s = math_min(cx, cy);
        let d = math_round(s * 0.6);
        let ring_r = math_round(s * 0.2);
        let start = if m == 2.0 { 0.0 } else { -PI / 2.0 };
        for (i, t) in texts.iter().take(m as usize).enumerate() {
            let ang = start + (i as f64 * 2.0 * PI) / m;
            out.push(SmartArtChildShape {
                prst: "ellipse",
                r#box: rect(
                    math_round(cx / 2.0 - d / 2.0 + math_cos(ang) * ring_r),
                    math_round(cy / 2.0 - d / 2.0 + math_sin(ang) * ring_r),
                    d,
                    d,
                ),
                text: Some(t.clone()),
                color: color(i),
                font_size: twelve,
                alpha: Some(JsNum(0.55)),
            });
        }
    } else {
        // hierarchy: first item centered on top, the rest in the bottom row
        let top = texts.first().cloned();
        let rest = texts.get(1..).unwrap_or_default();
        let h = math_round(cy * 0.32);
        let top_w = math_round(cx * 0.36);
        out.push(SmartArtChildShape {
            prst: "roundRect",
            r#box: rect(math_round((cx - top_w) / 2.0), 0.0, top_w, h),
            text: top,
            color: color(0),
            font_size: None,
            alpha: None,
        });
        if !rest.is_empty() {
            let count = rest.len() as f64;
            let gap = math_round(cx * 0.03);
            let w = math_round((cx - gap * (count - 1.0)) / count);
            for (i, t) in rest.iter().enumerate() {
                let node_x = i as f64 * (w + gap);
                out.push(SmartArtChildShape {
                    prst: "rect",
                    r#box: rect(
                        math_round(node_x + w / 2.0 - cx * 0.002),
                        h,
                        math_max(math_round(cx * 0.004), 9525.0),
                        math_round(cy * 0.18),
                    ),
                    text: None,
                    color: "A5A5A5",
                    font_size: None,
                    alpha: None,
                });
                out.push(SmartArtChildShape {
                    prst: "roundRect",
                    r#box: rect(node_x, math_round(cy * 0.5), w, math_round(cy * 0.5)),
                    text: Some(t.clone()),
                    color: color(i + 1),
                    font_size: twelve,
                    alpha: None,
                });
            }
        }
    }
    out
}
