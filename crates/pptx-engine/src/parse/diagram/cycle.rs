//! The `arrowRing`, `cycleMatrix` and `cycle` families of
//! layoutDiagramFallback.

use std::f64::consts::PI;

use jscompat::{js_regex, math_cos, math_max, math_min, math_round, math_sin};

use super::super::fill::resolve_color_node;
use super::{
    DgmFill, DgmLine, DgmSpOpts, DgmTreeNode, Fallback, bullet_lines, dgm_box, dgm_bullet_lines,
    dgm_sp, dgm_tint, fit_size, text_lines,
};

/// arrow5 (cycle alg, rotPath=alongPath): downArrows on a ring all pointing
/// at the center, the first at 12 o'clock going clockwise, tails on the
/// ring's outer edge. Length is R x min(0.98, 4.66/n); the aspect widens as
/// the ring crowds.
pub(super) fn arrow_ring(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let n = math_max(roots.len() as f64, 1.0);
    let r = math_min(frame_cx, frame_cy) / 2.0;
    let bh = r * math_min(0.98, 4.66 / n);
    let aspect = math_min(1.8, math_max(0.8, 0.885 + (n - 3.0) * 0.055));
    let bw = bh * aspect;
    let rc = r - bh / 2.0;
    let cxr = frame_cx / 2.0;
    let cyr = frame_cy / 2.0;
    let size_pt = math_max(5.0, math_min(20.0, 2.0 + (bh / 12700.0) * 0.08));
    for (i, node) in roots.iter().enumerate() {
        let ang = -PI / 2.0 + (i as f64 * 2.0 * PI) / n;
        let x = cxr + math_cos(ang) * rc;
        let y = cyr + math_sin(ang) * rc;
        let fill = f.color_of(node, i);
        f.push(
            dgm_box(x - bw / 2.0, y - bh / 2.0, bw, bh),
            fill,
            &text_lines(&node.texts, size_pt),
            DgmSpOpts {
                prst: Some("downArrow"),
                // Head shorter than the preset default
                adjs: &[("adj1", 50000.0), ("adj2", 32000.0)],
                rot: Some(math_round(((ang * 180.0) / PI + 90.0) * 60000.0)),
                ..DgmSpOpts::default()
            },
        );
    }
}

/// A quadrant of `cycleMatrix`: its start angle, its diagonal and the
/// corner of its card.
struct Quad {
    a1: f64,
    dx: f64,
    dy: f64,
    x: f64,
    y: f64,
}

/// Cycle Matrix (cycle4): four quadrant wedges around the center, one
/// corner child card per quadrant, clockwise from top-left.
pub(super) fn cycle_matrix(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let nodes = &roots[..roots.len().min(4)];
    let cxr = frame_cx / 2.0;
    let cyr = frame_cy / 2.0;
    let r = frame_cy * 0.44;
    let gap = frame_cy * 0.015;
    let bw = frame_cx * 0.333;
    let bh = frame_cy * 0.316;
    let bx = frame_cx * 0.064;
    let quads = [
        Quad {
            a1: 10800000.0,
            dx: -1.0,
            dy: -1.0,
            x: bx,
            y: 0.0,
        },
        Quad {
            a1: 16200000.0,
            dx: 1.0,
            dy: -1.0,
            x: frame_cx - bx - bw,
            y: 0.0,
        },
        Quad {
            a1: 0.0,
            dx: 1.0,
            dy: 1.0,
            x: frame_cx - bx - bw,
            y: frame_cy - bh,
        },
        Quad {
            a1: 5400000.0,
            dx: -1.0,
            dy: 1.0,
            x: bx,
            y: frame_cy - bh,
        },
    ];
    let label_pt = math_max(10.0, math_min(24.0, (r / 12700.0) * 0.115));
    // Corner cards first: PowerPoint tucks them behind the wedge circle
    for (node, q) in nodes.iter().zip(&quads) {
        let bullets = dgm_bullet_lines(node, 1.0);
        let resolved = node
            .sp_pr
            .and_then(|sp_pr| resolve_color_node(sp_pr.get("a:solidFill"), f.ctx));
        let stroke_color = resolved.as_deref().unwrap_or(f.first_color());
        f.push(
            dgm_box(q.x, q.y, bw, bh),
            DgmFill::Color("#FFFFFF"),
            &bullet_lines(&bullets, math_max(8.0, math_min(12.0, label_pt * 0.45))),
            DgmSpOpts {
                prst: Some("roundRect"),
                adj: Some(9000.0),
                stroke: Some(stroke_color),
                align: Some("l"),
                anchor: Some("t"),
                text_color: Some("#000000"),
                ..DgmSpOpts::default()
            },
        );
    }
    for (node, q) in nodes.iter().zip(&quads) {
        let fill = match node.sp_pr {
            Some(sp_pr) => DgmFill::SpPr(sp_pr),
            None => DgmFill::Color(f.first_color()),
        };
        let wcx = cxr + q.dx * gap;
        let wcy = cyr + q.dy * gap;
        f.push(
            dgm_box(wcx - r, wcy - r, 2.0 * r, 2.0 * r),
            fill,
            &[],
            DgmSpOpts {
                prst: Some("pie"),
                adjs: &[("adj1", q.a1), ("adj2", q.a1 + 5400000.0)],
                ..DgmSpOpts::default()
            },
        );
        // The quadrant label sits halfway out along the quadrant diagonal
        let lw = r * 0.9;
        let lh = label_pt * 12700.0 * 1.6;
        let labels: Vec<DgmLine<'_>> = node
            .texts
            .iter()
            .filter(|t| !t.is_empty())
            .map(|text| DgmLine {
                text,
                lvl: 0.0,
                size_pt: label_pt,
                bold: false,
            })
            .collect();
        f.push(
            dgm_box(
                wcx + q.dx * r * 0.5 - lw / 2.0,
                wcy + q.dy * r * 0.5 - lh / 2.0,
                lw,
                lh,
            ),
            DgmFill::Color("#FFFFFF"),
            &labels,
            DgmSpOpts {
                no_fill: true,
                ..DgmSpOpts::default()
            },
        );
    }
    // Center hub: a white ring (stand-in for PowerPoint's circular-arrows
    // glyph)
    let r0 = frame_cy * 0.07;
    f.push(
        dgm_box(cxr - r0, cyr - r0, 2.0 * r0, 2.0 * r0),
        DgmFill::Color("#FFFFFF"),
        &[],
        DgmSpOpts {
            prst: Some("donut"),
            adj: Some(28000.0),
            ..DgmSpOpts::default()
        },
    );
}

/// `circle` of the radial `cycle`: a tinted circle centered on (cx0, cy0).
fn circle(
    node: &DgmTreeNode<'_>,
    cx0: f64,
    cy0: f64,
    rad: f64,
    cap: f64,
    light: &str,
) -> serde_json::Value {
    dgm_sp(
        dgm_box(cx0 - rad, cy0 - rad, rad * 2.0, rad * 2.0),
        DgmFill::Color(light),
        &text_lines(
            &node.texts,
            fit_size(rad * 2.0, math_max(node.texts.len() as f64, 1.0) * 1.6, cap),
        ),
        &DgmSpOpts {
            prst: Some("ellipse"),
            text_color: Some("#333333"),
            ..DgmSpOpts::default()
        },
    )
}

/// Nodes on a circle; radial* is a big center circle with satellite
/// circles touching it.
pub(super) fn cycle(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let Some(first) = roots.first() else {
        return;
    };
    let central = f.layout_id.is_some_and(|id| js_regex!(r"^radial").test(id));
    let ring: &[DgmTreeNode<'_>] = if central {
        if first.children.is_empty() {
            &roots[1..]
        } else {
            &first.children
        }
    } else {
        roots
    };
    let n = math_max(ring.len() as f64, 1.0);
    let cxr = frame_cx / 2.0;
    let cyr = frame_cy / 2.0;
    if central {
        let min_dim = math_min(frame_cx, frame_cy);
        let big_r = min_dim * 0.28;
        let r = min_dim * 0.17;
        let base = f.first_color();
        let light = dgm_tint(base, 0.45);
        for (i, node) in ring.iter().enumerate() {
            let ang = -PI / 2.0 + (i as f64 * 2.0 * PI) / n;
            f.sps.push(circle(
                node,
                cxr + math_cos(ang) * (big_r + r * 0.82),
                cyr + math_sin(ang) * (big_r + r * 0.82),
                r,
                20.0,
                &light,
            ));
        }
        f.sps.push(circle(first, cxr, cyr, big_r, 26.0, &light));
    } else {
        let bw = math_min(frame_cx / 3.6, frame_cy / 2.6);
        let bh = bw * 0.6;
        let rx = frame_cx / 2.0 - bw / 2.0;
        let ry = frame_cy / 2.0 - bh / 2.0;
        for (i, node) in ring.iter().enumerate() {
            let ang = -PI / 2.0 + (i as f64 * 2.0 * PI) / n;
            let x = cxr + math_cos(ang) * rx;
            let y = cyr + math_sin(ang) * ry;
            let fill = f.color_of(node, i);
            f.push(
                dgm_box(x - bw / 2.0, y - bh / 2.0, bw, bh),
                fill,
                &text_lines(
                    &node.texts,
                    fit_size(bh, math_max(node.texts.len() as f64, 1.0), 18.0),
                ),
                DgmSpOpts {
                    prst: Some("roundRect"),
                    ..DgmSpOpts::default()
                },
            );
        }
    }
}
