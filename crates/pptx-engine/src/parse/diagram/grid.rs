//! The `flatGrid` and `equation` families of layoutDiagramFallback.

use super::{
    DgmFill, DgmSpOpts, Fallback, dgm_box, dgm_tint, fit_size_w, grid_columns, text_lines,
};

/// Flat list: tile grid (PowerPoint-measured GAP/aspect).
pub(super) fn flat_grid(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    const GAP: f64 = 0.115;
    const ASPECT: f64 = 0.6;
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
        // PowerPoint's tile autofit fits wrapped text in about half the tile
        // height
        let t = fit_size_w(bh * 0.5, bw, &node.texts, 26.0);
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(x, y, bw, bh),
            fill,
            &text_lines(&node.texts, t),
            DgmSpOpts::default(),
        );
    }
}

/// equation1: operand circles joined by + and = operator glyphs.
pub(super) fn equation(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    const OP: f64 = 0.42;
    let d = jscompat::math_min(frame_cy * 0.92, frame_cx / (n + (n - 1.0) * OP));
    let op_w = d * OP;
    let total_w = n * d + (n - 1.0) * op_w;
    let x0 = (frame_cx - total_w) / 2.0;
    let y_c = (frame_cy - d) / 2.0;
    let op_color = f.first_color();
    for (i, node) in roots.iter().enumerate() {
        let fi = i as f64;
        let x = x0 + fi * (d + op_w);
        let size_pt = fit_size_w(d * 0.72, d * 0.78, &node.texts, 26.0);
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(x, y_c, d, d),
            fill,
            &text_lines(&node.texts, size_pt),
            DgmSpOpts {
                prst: Some("ellipse"),
                ..DgmSpOpts::default()
            },
        );
        if fi < n - 1.0 {
            let g = d * 0.3;
            let tint = dgm_tint(op_color, 0.25);
            f.push(
                dgm_box(x + d + (op_w - g) / 2.0, y_c + (d - g) / 2.0, g, g),
                DgmFill::Color(&tint),
                &[],
                DgmSpOpts {
                    prst: Some(if fi == n - 2.0 {
                        "mathEqual"
                    } else {
                        "mathPlus"
                    }),
                    ..DgmSpOpts::default()
                },
            );
        }
    }
}
