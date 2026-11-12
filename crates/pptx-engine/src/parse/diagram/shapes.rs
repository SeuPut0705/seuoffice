//! The `pyramid`, `strips`, `pictureList`, `ruleArrow` and `boxList`
//! families of layoutDiagramFallback, and `blocks`, its default.

use jscompat::{math_max, math_min, math_round, truthy};

use super::{
    DgmFill, DgmLine, DgmSpOpts, Fallback, bullet_lines, dgm_box, dgm_bullet_lines, dgm_tint,
    fit_size, fit_size_w, grid_columns, text_lines,
};

/// Pyramid: a single node is the full triangle; several are the triangle
/// apex and widening trapezoid rows.
pub(super) fn pyramid(f: &mut Fallback<'_>) {
    let items = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = items.len() as f64;
    let w0 = math_min(frame_cx * 0.62, frame_cy * 1.05);
    let x0 = (frame_cx - w0) / 2.0;
    let row_h = frame_cy / n;
    // Side edges stay collinear: each trapezoid's per-side inset is w0/(2n),
    // expressed through the preset's adj (inset = min(w,h) * adj / 100000)
    for (i, node) in items.iter().enumerate() {
        let fi = i as f64;
        let bot_w = (w0 * (fi + 1.0)) / n;
        let lines = text_lines(
            &node.texts,
            fit_size(row_h, math_max(node.texts.len() as f64, 1.0), 22.0),
        );
        let fill = f.color_of(node, i);
        if i == 0 {
            f.push(
                dgm_box(x0 + (w0 - bot_w) / 2.0, 0.0, bot_w, row_h),
                fill,
                &lines,
                DgmSpOpts {
                    prst: Some("triangle"),
                    text_color: Some("#333333"),
                    ..DgmSpOpts::default()
                },
            );
        } else {
            let inset = w0 / (2.0 * n);
            let adj = (inset / math_min(bot_w, row_h)) * 100000.0;
            f.push(
                dgm_box(x0 + (w0 - bot_w) / 2.0, fi * row_h, bot_w, row_h),
                fill,
                &lines,
                DgmSpOpts {
                    prst: Some("trapezoid"),
                    text_color: Some("#333333"),
                    adj: Some(adj),
                    ..DgmSpOpts::default()
                },
            );
        }
    }
}

/// Picture strips: stacked outlined rows with a large dark label.
pub(super) fn strips(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap = frame_cy * 0.05;
    let ih = (frame_cy - gap * (n - 1.0)) / n;
    let x = frame_cx * 0.2;
    let w = frame_cx * 0.45;
    for (i, node) in roots.iter().enumerate() {
        let base = f.color_of(node, i);
        let base_hex = base.hex().unwrap_or("#4472C4");
        f.push(
            dgm_box(x, i as f64 * (ih + gap), w, ih),
            base,
            &text_lines(
                &node.texts,
                fit_size(ih, math_max(node.texts.len() as f64, 1.0) * 1.4, 24.0),
            ),
            DgmSpOpts {
                text_color: Some("#333333"),
                align: Some("l"),
                no_fill: true,
                stroke: Some(base_hex),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// Picture List: a light container with per-item picture boxes on top and
/// per-item text columns (title and child bullets) below.
pub(super) fn picture_list(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let cont_cy = frame_cy * 0.44;
    let first = truthy(Some(f.first_color()));
    let cont = first.map(|c| dgm_tint(c, 0.25));
    f.push(
        dgm_box(0.0, 0.0, frame_cx, cont_cy),
        DgmFill::Color(cont.as_deref().unwrap_or("#DCE3F2")),
        &[],
        DgmSpOpts {
            prst: Some("roundRect"),
            ..DgmSpOpts::default()
        },
    );
    let gap = frame_cx * 0.03;
    let cw = (frame_cx - gap * (n - 1.0) - frame_cx * 0.04) / n;
    for (i, node) in roots.iter().enumerate() {
        let x = frame_cx * 0.02 + i as f64 * (cw + gap);
        let picture = first.map(|c| dgm_tint(c, 0.12));
        f.push(
            dgm_box(x, cont_cy * 0.12, cw, cont_cy * 0.76),
            DgmFill::Color(picture.as_deref().unwrap_or("#E8ECF7")),
            &[],
            DgmSpOpts {
                prst: Some("roundRect"),
                ..DgmSpOpts::default()
            },
        );
        let bullets = dgm_bullet_lines(node, 1.0);
        let body_cy = frame_cy - cont_cy - frame_cy * 0.02;
        let t = fit_size(
            body_cy,
            math_max((node.texts.len() + bullets.len()) as f64, 1.0),
            18.0,
        );
        let mut lines = text_lines(&node.texts, t);
        lines.extend(bullet_lines(&bullets, t * 0.85));
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(x, cont_cy + frame_cy * 0.02, cw, body_cy),
            fill,
            &lines,
            DgmSpOpts {
                prst: Some("roundRect"),
                align: Some("l"),
                anchor: Some("t"),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// hProcess3 (linear rule): one big frame-wide rightArrow, the top-node
/// texts spread across the shaft (arrow 90% of the frame height centered,
/// shaft 40% of the arrow box, head about 25% of the width).
pub(super) fn rule_arrow(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let Some(first) = roots.first() else {
        return;
    };
    let n = math_max(roots.len() as f64, 1.0);
    let ah = frame_cy * 0.9;
    let ay = (frame_cy - ah) / 2.0;
    let head_len = math_min(frame_cx * 0.255, ah * 0.554);
    let fill = f.color_of(first, 0);
    f.push(
        dgm_box(0.0, ay, frame_cx, ah),
        fill,
        &[],
        DgmSpOpts {
            prst: Some("rightArrow"),
            adjs: &[
                ("adj1", 40400.0),
                (
                    "adj2",
                    math_round((head_len / math_min(frame_cx, ah)) * 100000.0),
                ),
            ],
            ..DgmSpOpts::default()
        },
    );
    let body_w = frame_cx - head_len;
    let slot = body_w / n;
    let shaft_h = ah * 0.404;
    for (i, node) in roots.iter().enumerate() {
        let size_pt = fit_size(shaft_h, math_max(node.texts.len() as f64, 1.0), 26.0);
        let lines: Vec<DgmLine<'_>> = node
            .texts
            .iter()
            .map(|text| DgmLine {
                text,
                lvl: 0.0,
                size_pt,
                bold: true,
            })
            .collect();
        f.push(
            dgm_box(i as f64 * slot, ay + (ah - shaft_h) / 2.0, slot, shaft_h),
            DgmFill::Color("#FFFFFF"),
            &lines,
            DgmSpOpts {
                no_fill: true,
                ..DgmSpOpts::default()
            },
        );
    }
}

/// Vertical Box List: per item a rounded title pill (69% width, inset
/// 5.3%) over a full-width outlined body panel that starts at the pill's
/// vertical middle and runs to just above the next pill.
pub(super) fn box_list(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let pitch = frame_cy / math_max(n, 1.0);
    for (i, node) in roots.iter().enumerate() {
        let y = i as f64 * pitch + pitch * 0.04;
        let base = f.color_of(node, i);
        let base_hex = base.hex();
        let title_cy = pitch * 0.7;
        f.push(
            dgm_box(frame_cx * 0.053, y, frame_cx * 0.692, title_cy),
            base,
            &text_lines(
                &node.texts,
                fit_size(title_cy, math_max(node.texts.len() as f64, 1.0) * 2.0, 14.0),
            ),
            DgmSpOpts {
                prst: Some("roundRect"),
                align: Some("l"),
                ..DgmSpOpts::default()
            },
        );
        let bullets = dgm_bullet_lines(node, 1.0);
        let body_cy = title_cy * 0.9;
        f.push(
            dgm_box(0.0, y + title_cy * 0.5, frame_cx, body_cy),
            base,
            &bullet_lines(
                &bullets,
                fit_size(body_cy, math_max(bullets.len() as f64, 1.0), 16.0),
            ),
            DgmSpOpts {
                text_color: Some("#333333"),
                align: Some("l"),
                anchor: Some("t"),
                no_fill: true,
                stroke: Some(base_hex.unwrap_or("#4472C4")),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// blocks: the top-node tile grid with descendant bullet text inside each
/// tile.
pub(super) fn blocks(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    const GAP: f64 = 0.115;
    const ASPECT: f64 = 0.62;
    let avail_cy = frame_cy * 0.98;
    let (cols, best) = grid_columns(n, frame_cx, avail_cy, GAP, ASPECT);
    let rows = (n / cols).ceil();
    let bw = best;
    let bh = bw * ASPECT;
    let gap = bw * GAP;
    let grid_w = cols * bw + (cols - 1.0) * gap;
    let grid_h = rows * bh + (rows - 1.0) * gap;
    // PowerPoint centers the tile grid inside the frame on both axes
    let x_off = (frame_cx - grid_w) / 2.0;
    let y_off = (frame_cy - grid_h) / 2.0;
    for (i, node) in roots.iter().enumerate() {
        let fi = i as f64;
        let row = (fi / cols).floor();
        let in_row = if row == rows - 1.0 {
            n - (rows - 1.0) * cols
        } else {
            cols
        };
        let col = fi - row * cols;
        let row_w = in_row * bw + (in_row - 1.0) * gap;
        let x = x_off + (grid_w - row_w) / 2.0 + col * (bw + gap);
        let y = y_off + row * (bh + gap);
        let bullets = dgm_bullet_lines(node, 1.0);
        let mut texts: Vec<&str> = node.texts.iter().map(String::as_str).collect();
        texts.extend(bullets.iter().map(|l| l.text));
        let t = fit_size_w(bh, bw, &texts, 26.0);
        let mut lines = text_lines(&node.texts, t);
        lines.extend(bullet_lines(&bullets, t * 0.8));
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(x, y, bw, bh),
            fill,
            &lines,
            DgmSpOpts {
                align: Some("l"),
                anchor: Some("ctr"),
                ..DgmSpOpts::default()
            },
        );
    }
}
