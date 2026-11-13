//! The `chevronList` and `chevronRow` families of layoutDiagramFallback.

use jscompat::{math_max, math_min};

use super::{
    DgmFill, DgmSpOpts, DgmTreeNode, Fallback, bullet_lines, dgm_box, dgm_bullet_lines, fit_size,
    fit_size_w, text_lines,
};

/// chevron2 (vertical chevron list): a down-pointing chevron accent per row
/// on the left, the node's bullets in an outlined rounded card on the right.
pub(super) fn chevron_list(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap = frame_cy * 0.045;
    let ih = (frame_cy - gap * (n - 1.0)) / n;
    let ch_w = math_min(frame_cx * 0.16, ih * 0.75);
    for (i, node) in roots.iter().enumerate() {
        let y = i as f64 * (ih + gap);
        let base = f.color_of(node, i);
        let base_hex = base.hex();
        // rotated 90deg: the box swaps around the accent cell's center so it
        // points down
        f.push(
            dgm_box(ch_w / 2.0 - ih / 2.0, y + ih / 2.0 - ch_w / 2.0, ih, ch_w),
            base,
            &[],
            DgmSpOpts {
                prst: Some("chevron"),
                rot: Some(5400000.0),
                ..DgmSpOpts::default()
            },
        );
        // the label overlay stays horizontal (text inside the rotated shape
        // would rotate)
        let t = fit_size_w(ih * 0.9, ch_w * 0.85, &node.texts, 13.0);
        f.push(
            dgm_box(0.0, y, ch_w, ih),
            DgmFill::Color("#FFFFFF"),
            &text_lines(&node.texts, t),
            DgmSpOpts {
                no_fill: true,
                ..DgmSpOpts::default()
            },
        );
        let bullets = dgm_bullet_lines(node, 1.0);
        let bullet_texts: Vec<&str> = bullets.iter().map(|l| l.text).collect();
        let b = fit_size_w(
            ih * 0.92,
            (frame_cx - ch_w * 1.2) * 0.94,
            &bullet_texts,
            13.0,
        );
        f.push(
            dgm_box(ch_w * 1.2, y, frame_cx - ch_w * 1.2, ih),
            DgmFill::Color("#FFFFFF"),
            &bullet_lines(&bullets, b),
            DgmSpOpts {
                prst: Some("roundRect"),
                text_color: Some("#333333"),
                align: Some("l"),
                stroke: Some(base_hex.unwrap_or("#999999")),
                adj: Some(10000.0),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// chevron1: one horizontal band of chevron arrows, vertically centered.
pub(super) fn chevron_row(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let flat: Vec<&DgmTreeNode<'_>> = roots
        .iter()
        .flat_map(|r| std::iter::once(r).chain(r.children.iter()))
        .collect();
    let n = flat.len() as f64;
    // chevrons tuck into each other
    let overlap = 0.18;
    let ch = math_min(
        frame_cy * 0.34,
        (frame_cx / (n - (n - 1.0) * overlap)) * 0.42,
    );
    let cw = ch / 0.42;
    let step = cw * (1.0 - overlap);
    let row_w = cw + step * (n - 1.0);
    let x0 = (frame_cx - row_w) / 2.0;
    let y = (frame_cy - ch) / 2.0;
    for (i, node) in flat.into_iter().enumerate() {
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(x0 + i as f64 * step, y, cw, ch),
            fill,
            &text_lines(
                &node.texts,
                fit_size(ch, math_max(node.texts.len() as f64, 1.0), 20.0),
            ),
            DgmSpOpts {
                prst: Some("chevron"),
                ..DgmSpOpts::default()
            },
        );
    }
}
