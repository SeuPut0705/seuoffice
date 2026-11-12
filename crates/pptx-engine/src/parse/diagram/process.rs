//! The `cards`, `arrowBands` and `procCards` families of
//! layoutDiagramFallback.

use jscompat::{math_max, math_min, truthy};

use super::{
    DgmBox, DgmFill, DgmSpOpts, DgmTreeNode, Fallback, bullet_lines, dgm_box, dgm_bullet_lines,
    dgm_tint, fit_size, fit_size_w, grid_columns, min_of, text_lines,
};

/// bList cards: an outlined white card with the child bullets, an accent
/// footer strip with the parent title.
pub(super) fn cards(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    const GAP: f64 = 0.14;
    const ASPECT: f64 = 1.05;
    let avail_cy = frame_cy * 0.96;
    let (cols, best) = grid_columns(n, frame_cx, avail_cy, GAP, ASPECT);
    let rows = (n / cols).ceil();
    let bw = best;
    let bh = bw * ASPECT;
    let gap = bw * GAP;
    let grid_w = cols * bw + (cols - 1.0) * gap;
    let grid_h = rows * bh + (rows - 1.0) * gap;
    let y00 = (frame_cy - grid_h) / 2.0;
    for (i, node) in roots.iter().enumerate() {
        let fi = i as f64;
        let row = (fi / cols).floor();
        let col = fi - row * cols;
        let x = (frame_cx - grid_w) / 2.0 + col * (bw + gap);
        let y = y00 + row * (bh + gap);
        let base = f.color_of(node, i);
        let base_hex = base.hex().unwrap_or("#4472C4");
        let bullets = dgm_bullet_lines(node, 1.0);
        let foot_cy = bh * 0.28;
        f.push(
            dgm_box(x, y, bw, bh - foot_cy),
            base,
            &bullet_lines(
                &bullets,
                fit_size(
                    bh - foot_cy,
                    math_max(bullets.len() as f64, 1.0) * 2.0,
                    14.0,
                ),
            ),
            DgmSpOpts {
                text_color: Some("#333333"),
                align: Some("l"),
                anchor: Some("t"),
                no_fill: true,
                stroke: Some(base_hex),
                ..DgmSpOpts::default()
            },
        );
        f.push(
            dgm_box(x, y + bh - foot_cy, bw, foot_cy),
            base,
            &text_lines(
                &node.texts,
                fit_size(foot_cy, math_max(node.texts.len() as f64, 1.0), 12.0),
            ),
            DgmSpOpts {
                align: Some("l"),
                ..DgmSpOpts::default()
            },
        );
        let r = foot_cy * 0.55;
        let tint = truthy(Some(base_hex)).map(|hex| dgm_tint(hex, 0.35));
        f.push(
            dgm_box(
                x + bw - r * 1.6,
                y + bh - foot_cy - r * 0.45,
                r * 2.0,
                r * 2.0,
            ),
            tint.as_deref().map_or(base, DgmFill::Color),
            &[],
            DgmSpOpts {
                prst: Some("ellipse"),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// A header or a child cell of `arrowBands`, sized after every band is laid.
struct Band<'a> {
    node: &'a DgmTreeNode<'a>,
    r#box: DgmBox,
}

/// process4 (Detailed Process, lin fromB): full-width bands stacked top
/// down. Every band but the last is a downArrowCallout 1.538x the height of
/// the closing rect; bands overlap by 0.015. The header text sits in the
/// callout's top 0.351 (rect: 0.54), the children fill 0.351..0.65 (rect:
/// 0.52..0.98) side by side. PowerPoint paints the closing rect with node1
/// slot 0 and every callout with slot 1; child cells are fgAccFollowNode1.
pub(super) fn arrow_bands(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    const OVER: f64 = 0.015;
    let unit = frame_cy / (1.0 + 1.538 * (n - 1.0) - OVER * (n - 1.0));
    let stroke = "#FFFFFF";
    let label_fills = f.label_fills;
    let node1: &[String] = match label_fills.get("node1") {
        Some(node1) => node1,
        None => f.colors,
    };
    let follow = label_fills
        .get("fgAccFollowNode1")
        .and_then(|fills| fills.first());
    let tint;
    let cell_fill: &str = match follow {
        Some(fill) => fill,
        None => {
            tint = dgm_tint(f.first_color(), 0.35);
            &tint
        }
    };
    let mut heads: Vec<Band<'_>> = Vec::new();
    let mut cells: Vec<Band<'_>> = Vec::new();
    let mut y = 0.0;
    for (i, node) in roots.iter().enumerate() {
        let last = i as f64 == n - 1.0;
        let bh = if last { unit } else { unit * 1.538 };
        let kids = &node.children;
        let base = match node.sp_pr {
            Some(sp_pr) => DgmFill::SpPr(sp_pr),
            None => DgmFill::Color(&node1[if last { 0 } else { 1 % node1.len() }]),
        };
        f.push(
            dgm_box(0.0, y, frame_cx, bh),
            base,
            &[],
            DgmSpOpts {
                prst: Some(if last { "rect" } else { "downArrowCallout" }),
                stroke: Some(stroke),
                ..DgmSpOpts::default()
            },
        );
        let head_cy = if kids.is_empty() {
            bh * (if last { 1.0 } else { 0.65 })
        } else {
            bh * (if last { 0.54 } else { 0.351 })
        };
        heads.push(Band {
            node,
            r#box: dgm_box(0.0, y, frame_cx, head_cy),
        });
        if !kids.is_empty() {
            let top = y + bh * (if last { 0.52 } else { 0.351 });
            let cy = bh * (if last { 0.46 } else { 0.299 });
            let cw = frame_cx / kids.len() as f64;
            for (k, kid) in kids.iter().enumerate() {
                cells.push(Band {
                    node: kid,
                    r#box: dgm_box(k as f64 * cw, top, cw, cy),
                });
            }
        }
        y += bh - unit * OVER;
    }
    // primFontSz op=equ: all headers share one size, all cells share one size
    let head_pt = min_of(heads.iter().map(|h| {
        h.node
            .size_pt
            .unwrap_or_else(|| fit_size_w(h.r#box.cy * 0.78, h.r#box.cx, &h.node.texts, 65.0))
    }));
    let cell_pt = if cells.is_empty() {
        0.0
    } else {
        min_of(cells.iter().map(|c| {
            c.node
                .size_pt
                .unwrap_or_else(|| fit_size_w(c.r#box.cy * 0.8, c.r#box.cx, &c.node.texts, 65.0))
        }))
    };
    for c in &cells {
        f.push(
            c.r#box,
            DgmFill::Color(cell_fill),
            &text_lines(&c.node.texts, cell_pt),
            DgmSpOpts {
                stroke: Some(stroke),
                text_color: Some("#000000"),
                ..DgmSpOpts::default()
            },
        );
    }
    for h in &heads {
        f.push(
            h.r#box,
            DgmFill::Color("#000000"),
            &text_lines(&h.node.texts, head_pt),
            DgmSpOpts {
                no_fill: true,
                ..DgmSpOpts::default()
            },
        );
    }
}

/// Process cards: items in a row, an accent title box, an outlined child
/// panel offset below right, a small arrow between items.
pub(super) fn proc_cards(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap_x = frame_cx * 0.1;
    let iw = (frame_cx - gap_x * (n - 1.0)) / n;
    let ih = math_min(frame_cy * 0.5, iw * 1.1);
    let y00 = (frame_cy - ih) / 2.0;
    for (i, node) in roots.iter().enumerate() {
        let fi = i as f64;
        let x = fi * (iw + gap_x);
        let base = f.color_of(node, i);
        let base_hex = base.hex().unwrap_or("#4472C4");
        let title_cy = ih * 0.42;
        f.push(
            dgm_box(x, y00, iw * 0.62, title_cy),
            base,
            &text_lines(
                &node.texts,
                fit_size(title_cy, math_max(node.texts.len() as f64, 1.0), 18.0),
            ),
            DgmSpOpts {
                prst: Some("roundRect"),
                align: Some("l"),
                ..DgmSpOpts::default()
            },
        );
        let bullets = dgm_bullet_lines(node, 1.0);
        f.push(
            dgm_box(
                x + iw * 0.14,
                y00 + title_cy * 0.62,
                iw * 0.66,
                ih - title_cy * 0.62,
            ),
            base,
            &bullet_lines(
                &bullets,
                fit_size(
                    ih - title_cy,
                    math_max(bullets.len() as f64, 1.0) * 1.6,
                    15.0,
                ),
            ),
            DgmSpOpts {
                prst: Some("roundRect"),
                text_color: Some("#333333"),
                align: Some("l"),
                anchor: Some("t"),
                no_fill: true,
                stroke: Some(base_hex),
                ..DgmSpOpts::default()
            },
        );
        if fi < n - 1.0 {
            let aw = gap_x * 0.55;
            let tint = truthy(Some(base_hex)).map(|hex| dgm_tint(hex, 0.45));
            f.push(
                dgm_box(
                    x + iw + (gap_x - aw) / 2.0,
                    y00 + title_cy * 0.28,
                    aw,
                    title_cy * 0.45,
                ),
                tint.as_deref().map_or(base, DgmFill::Color),
                &[],
                DgmSpOpts {
                    prst: Some("rightArrow"),
                    ..DgmSpOpts::default()
                },
            );
        }
    }
}
