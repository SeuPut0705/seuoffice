//! The `stacked`, `hierarchy`, `sideList` and `stepped` families of
//! layoutDiagramFallback.

use jscompat::{math_max, math_min, truthy};

use super::{
    DgmFill, DgmLine, DgmSpOpts, Fallback, bullet_lines, dgm_box, dgm_bullet_lines, dgm_tint,
    fit_size, fit_size_w, text_lines,
};

/// Rounded blocks stacked vertically: the title and the descendant bullets
/// inside each.
pub(super) fn stacked(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap = frame_cy * 0.06;
    let bh = (frame_cy - gap * (n - 1.0)) / n;
    for (i, node) in roots.iter().enumerate() {
        let bullets = dgm_bullet_lines(node, 1.0);
        let n_lines = (node.texts.len() + bullets.len()) as f64;
        let t = fit_size(bh, math_max(n_lines, 1.0), 26.0);
        let mut lines: Vec<DgmLine<'_>> = node
            .texts
            .iter()
            .map(|text| DgmLine {
                text,
                lvl: 0.0,
                size_pt: t,
                bold: true,
            })
            .collect();
        lines.extend(bullet_lines(&bullets, t * 0.8));
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(0.0, i as f64 * (bh + gap), frame_cx, bh),
            fill,
            &lines,
            DgmSpOpts {
                prst: Some("roundRect"),
                align: Some("l"),
                anchor: Some("ctr"),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// Parent tiles in a row; each parent's children side by side beneath it.
pub(super) fn hierarchy(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap = frame_cx * 0.03;
    let col_w = (frame_cx - gap * (n - 1.0)) / n;
    let parent_cy = frame_cy * 0.42;
    let child_cy = frame_cy * 0.48;
    for (i, node) in roots.iter().enumerate() {
        let x = i as f64 * (col_w + gap);
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(x + col_w * 0.06, 0.0, col_w * 0.88, parent_cy),
            fill,
            &text_lines(
                &node.texts,
                fit_size(parent_cy, math_max(node.texts.len() as f64, 1.0), 26.0),
            ),
            DgmSpOpts {
                prst: Some("roundRect"),
                ..DgmSpOpts::default()
            },
        );
        let kids = &node.children;
        if kids.is_empty() {
            continue;
        }
        let kgap = col_w * 0.04;
        let n_kids = kids.len() as f64;
        let kw = (col_w - kgap * (n_kids - 1.0)) / n_kids;
        for (j, k) in kids.iter().enumerate() {
            let fill = f.color_of(k, i);
            f.push(
                dgm_box(
                    x + j as f64 * (kw + kgap),
                    frame_cy - child_cy,
                    kw,
                    child_cy,
                ),
                fill,
                &text_lines(
                    &k.texts,
                    fit_size(child_cy, math_max(k.texts.len() as f64, 1.0), 20.0),
                ),
                DgmSpOpts {
                    prst: Some("roundRect"),
                    ..DgmSpOpts::default()
                },
            );
        }
    }
}

/// Vertical Block List: compact rows top-aligned, an accent title box on
/// the left, a light bullet panel on the right.
pub(super) fn side_list(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap = frame_cy * 0.045;
    let ih = math_min((frame_cy * 0.98 - gap * (n - 1.0)) / n, frame_cy * 0.2);
    for (i, node) in roots.iter().enumerate() {
        let y = frame_cy * 0.02 + i as f64 * (ih + gap);
        let base = f.color_of(node, i);
        let base_hex = base.hex();
        let bullets = dgm_bullet_lines(node, 1.0);
        if !bullets.is_empty() {
            let tint = truthy(base_hex).map(|hex| dgm_tint(hex, 0.16));
            f.push(
                dgm_box(frame_cx * 0.2, y, frame_cx * 0.38, ih),
                tint.as_deref().map_or(base, DgmFill::Color),
                &bullet_lines(
                    &bullets,
                    fit_size(ih, math_max(bullets.len() as f64, 1.0), 15.0),
                ),
                DgmSpOpts {
                    text_color: Some("#333333"),
                    align: Some("l"),
                    ..DgmSpOpts::default()
                },
            );
        }
        f.push(
            dgm_box(0.0, y, frame_cx * 0.205, ih),
            base,
            &text_lines(
                &node.texts,
                fit_size(ih, math_max(node.texts.len() as f64, 1.0), 20.0),
            ),
            DgmSpOpts {
                prst: Some("roundRect"),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// vProcess5 (step-down process): boxes stagger right as they descend, a
/// small down arrow tucked into the gap under each box's trailing edge.
pub(super) fn stepped(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap_y = frame_cy * 0.055;
    let bh = (frame_cy - gap_y * (n - 1.0)) / n;
    let bw = frame_cx * 0.62;
    let step_x = if n > 1.0 {
        (frame_cx - bw) / (n - 1.0)
    } else {
        0.0
    };
    for (i, node) in roots.iter().enumerate() {
        let fi = i as f64;
        let x = fi * step_x;
        let y = fi * (bh + gap_y);
        let mut texts: Vec<&str> = node.texts.iter().map(String::as_str).collect();
        texts.extend(dgm_bullet_lines(node, 1.0).iter().map(|l| l.text));
        let t = fit_size_w(bh, bw, &texts, 16.0);
        let lines: Vec<DgmLine<'_>> = texts
            .iter()
            .map(|&text| DgmLine {
                text,
                lvl: 0.0,
                size_pt: t,
                bold: false,
            })
            .collect();
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(x, y, bw, bh),
            fill,
            &lines,
            DgmSpOpts {
                align: Some("l"),
                ..DgmSpOpts::default()
            },
        );
        if fi < n - 1.0 {
            let ah = gap_y * 0.95;
            let aw = ah * 1.1;
            let base = f.color_of(node, i);
            let tint = base.hex().map(|hex| dgm_tint(hex, 0.45));
            f.push(
                dgm_box(x + bw * 0.78 - aw / 2.0, y + bh + gap_y * 0.025, aw, ah),
                DgmFill::Color(tint.as_deref().unwrap_or("#BFBFBF")),
                &[],
                DgmSpOpts {
                    prst: Some("downArrow"),
                    ..DgmSpOpts::default()
                },
            );
        }
    }
}
