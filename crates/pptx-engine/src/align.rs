//! Alignment and even distribution of axis-aligned rects
//! (packages/pptx-engine/src/align.ts).

use jscompat::{JsNum, math_max, math_min, sort_by_number};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct AlignRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A new position: `{ x, y }`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct AlignPoint {
    pub x: JsNum,
    pub y: JsNum,
}

fn point(x: f64, y: f64) -> AlignPoint {
    AlignPoint {
        x: JsNum(x),
        y: JsNum(y),
    }
}

fn bounding_box(rects: &[AlignRect]) -> AlignRect {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for r in rects {
        min_x = math_min(min_x, r.x);
        min_y = math_min(min_y, r.y);
        max_x = math_max(max_x, r.x + r.w);
        max_y = math_max(max_y, r.y + r.h);
    }
    AlignRect {
        x: min_x,
        y: min_y,
        w: max_x - min_x,
        h: max_y - min_y,
    }
}

/// `alignRects`: `kind` is an `AlignKind`; any other leaves every rect where
/// it is. `None` for `container_rect` aligns to the selection's bounding box.
pub fn align_rects(
    rects: &[AlignRect],
    kind: &str,
    container_rect: Option<AlignRect>,
) -> Vec<AlignPoint> {
    let b = container_rect.unwrap_or_else(|| bounding_box(rects));

    rects
        .iter()
        .map(|r| {
            let mut x = r.x;
            let mut y = r.y;
            match kind {
                "left" => x = b.x,
                "center-h" => x = b.x + (b.w - r.w) / 2.0,
                "right" => x = b.x + b.w - r.w,
                "top" => y = b.y,
                "center-v" => y = b.y + (b.h - r.h) / 2.0,
                "bottom" => y = b.y + b.h - r.h,
                _ => {}
            }
            point(x, y)
        })
        .collect()
}

/// `distributeRects`: `"horizontal"` spreads along x, any other kind along y.
pub fn distribute_rects(rects: &[AlignRect], kind: &str) -> Vec<AlignPoint> {
    if rects.len() < 3 {
        return rects.iter().map(|r| point(r.x, r.y)).collect();
    }
    let mut indexed: Vec<(usize, AlignRect)> = rects.iter().copied().enumerate().collect();
    let divisor = rects.len() as f64 - 1.0;
    let mut result: Vec<AlignPoint> = rects.iter().map(|r| point(r.x, r.y)).collect();

    if kind == "horizontal" {
        sort_by_number(&mut indexed, |a, b| a.1.x - b.1.x);
        let (Some(&(_, first)), Some(&(_, last))) = (indexed.first(), indexed.last()) else {
            return result;
        };
        let total_span = last.x + last.w - first.x;
        let total_width = indexed.iter().fold(0.0, |s, (_, r)| s + r.w);
        let gap = (total_span - total_width) / divisor;
        let mut cursor = first.x;
        for &(i, r) in &indexed {
            result[i] = point(cursor, rects[i].y);
            cursor += r.w + gap;
        }
    } else {
        sort_by_number(&mut indexed, |a, b| a.1.y - b.1.y);
        let (Some(&(_, first)), Some(&(_, last))) = (indexed.first(), indexed.last()) else {
            return result;
        };
        let total_span = last.y + last.h - first.y;
        let total_height = indexed.iter().fold(0.0, |s, (_, r)| s + r.h);
        let gap = (total_span - total_height) / divisor;
        let mut cursor = first.y;
        for &(i, r) in &indexed {
            result[i] = point(rects[i].x, cursor);
            cursor += r.h + gap;
        }
    }
    result
}
