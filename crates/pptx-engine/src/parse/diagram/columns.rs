//! The `colProcess`, `columns` and `tableList` families of
//! layoutDiagramFallback.

use jscompat::{math_max, math_min, truthy};

use super::{
    DgmFill, DgmSpOpts, Fallback, bullet_lines, dgm_box, dgm_bullet_lines, dgm_tint, fit_size,
    fit_size_w, text_lines,
};

/// lProcess1-style linear process: one column per top node, a colored
/// header block, then each child in its own tinted block, with a small
/// connector dot in every gap.
pub(super) fn col_process(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap = frame_cx * 0.045;
    let cw = (frame_cx - gap * (n - 1.0)) / n;
    let k_max = math_max(
        roots
            .iter()
            .map(|r| r.children.len() as f64)
            .fold(f64::NEG_INFINITY, math_max),
        1.0,
    );
    // Columns fill ~78% of the frame height, roughly centered
    let used_cy = frame_cy * 0.78;
    let y_top = (frame_cy - used_cy) * 0.55;
    let bh = used_cy / (1.0 + 1.48 * k_max);
    let v_gap = bh * 0.48;
    let childless = !roots.iter().any(|r| !r.children.is_empty());
    for (i, node) in roots.iter().enumerate() {
        let x = i as f64 * (cw + gap);
        let base = f.color_of(node, i);
        let base_hex = base.hex();
        if childless {
            // Childless nodes render as the layout's background shape: a large
            // tinted rounded panel with dark top-anchored text
            let pw = math_min(cw, frame_cy * 1.5);
            let pt = fit_size_w(frame_cy * 0.25, pw, &node.texts, 22.0);
            let tint = truthy(base_hex).map(|hex| dgm_tint(hex, 0.22));
            f.push(
                dgm_box(x + (cw - pw) / 2.0, frame_cy * 0.06, pw, frame_cy * 0.88),
                tint.as_deref().map_or(base, DgmFill::Color),
                &text_lines(&node.texts, pt),
                DgmSpOpts {
                    text_color: Some("#000000"),
                    anchor: Some("t"),
                    prst: Some("roundRect"),
                    adj: Some(10000.0),
                    ..DgmSpOpts::default()
                },
            );
            continue;
        }
        let t = fit_size_w(bh * 0.9, cw, &node.texts, 26.0);
        f.push(
            dgm_box(x, y_top, cw, bh),
            base,
            &text_lines(&node.texts, t),
            DgmSpOpts::default(),
        );
        for (k, kid) in node.children.iter().enumerate() {
            let y = y_top + bh + k as f64 * (v_gap + bh);
            let dot_d = bh * 0.14;
            f.push(
                dgm_box(
                    x + cw / 2.0 - dot_d / 2.0,
                    y + v_gap / 2.0 - dot_d / 2.0,
                    dot_d,
                    dot_d,
                ),
                base,
                &[],
                DgmSpOpts {
                    prst: Some("ellipse"),
                    ..DgmSpOpts::default()
                },
            );
            let kt = fit_size_w(bh * 0.7, cw, &kid.texts, 17.0);
            let tint = truthy(base_hex).map(|hex| dgm_tint(hex, 0.25));
            f.push(
                dgm_box(x, y + v_gap, cw, bh),
                tint.as_deref().map_or(base, DgmFill::Color),
                &text_lines(&kid.texts, kt),
                DgmSpOpts {
                    text_color: Some("#404040"),
                    prst: Some("roundRect"),
                    adj: Some(8000.0),
                    ..DgmSpOpts::default()
                },
            );
        }
    }
}

/// Per top node: colored header (title) and tinted body (descendant
/// bullets); the column width caps at 0.52 x the available height and the
/// group centers (PowerPoint's hList look).
pub(super) fn columns(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = roots.len() as f64;
    let gap = frame_cy * 0.055;
    let avail_cy = frame_cy * 0.92;
    let y0 = frame_cy * 0.04;
    let cw = math_min((frame_cx - gap * (n - 1.0)) / n, avail_cy * 0.52);
    let x0 = (frame_cx - (cw * n + gap * (n - 1.0))) / 2.0;
    let head_cy = avail_cy * 0.18;
    for (i, node) in roots.iter().enumerate() {
        let x = x0 + i as f64 * (cw + gap);
        let base = f.color_of(node, i);
        let base_hex = base.hex();
        let t = fit_size(head_cy, math_max(node.texts.len() as f64, 1.0), 20.0);
        f.push(
            dgm_box(x, y0, cw, head_cy),
            base,
            &text_lines(&node.texts, t),
            DgmSpOpts::default(),
        );
        let bullets = dgm_bullet_lines(node, 1.0);
        let body_cy = avail_cy - head_cy - frame_cy * 0.01;
        let b = fit_size(body_cy, math_max(bullets.len() as f64, 1.0), 16.0);
        let tint = truthy(base_hex).map(|hex| dgm_tint(hex, 0.2));
        f.push(
            dgm_box(x, y0 + head_cy + frame_cy * 0.01, cw, body_cy),
            tint.as_deref().map_or(base, DgmFill::Color),
            &bullet_lines(&bullets, b),
            DgmSpOpts {
                text_color: Some("#333333"),
                align: Some("l"),
                anchor: Some("t"),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// A single parent banner on top, its children as equal cells below.
pub(super) fn table_list(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let Some(parent) = roots.first() else {
        return;
    };
    let head_cy = frame_cy * 0.28;
    let fill = f.color_of(parent, 0);
    f.push(
        dgm_box(0.0, 0.0, frame_cx, head_cy),
        fill,
        &text_lines(
            &parent.texts,
            fit_size(head_cy, math_max(parent.texts.len() as f64, 1.0), 26.0),
        ),
        DgmSpOpts::default(),
    );
    let kids = if parent.children.is_empty() {
        roots.get(1..).unwrap_or_default()
    } else {
        &parent.children[..]
    };
    let n = math_max(kids.len() as f64, 1.0);
    let gap = frame_cx * 0.012;
    let cw = (frame_cx - gap * (n - 1.0)) / n;
    for (i, k) in kids.iter().enumerate() {
        let fill = f.color_of(k, i + 1);
        f.push(
            dgm_box(
                i as f64 * (cw + gap),
                head_cy + frame_cy * 0.012,
                cw,
                frame_cy * 0.62,
            ),
            fill,
            &text_lines(
                &k.texts,
                fit_size(frame_cy * 0.62, math_max(k.texts.len() as f64, 1.0), 26.0),
            ),
            DgmSpOpts::default(),
        );
    }
    let fill = f.color_of(parent, 0);
    f.push(
        dgm_box(0.0, frame_cy * 0.945, frame_cx, frame_cy * 0.055),
        fill,
        &[],
        DgmSpOpts::default(),
    );
}
