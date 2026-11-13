//! Hierarchy-family (orgChart1, and the built-in hierarchy1) diagram layout
//! interpreter
//! (packages/pptx-engine/src/dgm-hier.ts). All geometry before the final
//! scaling is in units of one box width.

use jscompat::{JsNum, JsRegex, js_regex, math_max, math_min, parse_float, truthy};
use serde::ser::{SerializeStruct, Serializer};
use serde::{Deserialize, Serialize};

/// What `layoutHierTree` reads of a diagram tree node. The model port
/// replaces it with the parser's `DgmTreeNode`; `texts` and `spPr` are not
/// read here.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierTreeNode {
    pub children: Vec<HierTreeNode>,
    #[serde(default)]
    pub asst: Option<bool>,
    #[serde(default)]
    pub hier_branch: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierConstraints {
    pub box_aspect: JsNum,
    pub sib_sp: JsNum,
    pub sp: JsNum,
    pub trunk_off: JsNum,
    pub hang_indent: JsNum,
    pub font_max: JsNum,
}

/// A laid-out box: `node` is the tree node it draws.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HierBox<'a> {
    pub node: &'a HierTreeNode,
    pub x: JsNum,
    pub y: JsNum,
    pub w: JsNum,
    pub h: JsNum,
}

/// A connector as the rect it spans. `to` is the child node of the connection
/// this segment draws (the trunk segment shared by a parent's children points
/// at the first child).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HierLineRect<'a> {
    pub x: JsNum,
    pub y: JsNum,
    pub cx: JsNum,
    pub cy: JsNum,
    pub to: Option<&'a HierTreeNode>,
}

/// The layout of `layoutHierTree`. It serializes as
/// `{ boxes: [{ node, x, y, w, h }], lines: [{ x, y, cx, cy, to? }], boxW }`
/// where `node` and `to` are the index of the node in a depth-first pre-order
/// walk of `roots` (each root, then its children in order, recursively), so
/// the first root is 0 and its first child 1.
#[derive(Debug, Clone, PartialEq)]
pub struct HierLayout<'a> {
    pub roots: &'a [HierTreeNode],
    pub boxes: Vec<HierBox<'a>>,
    pub lines: Vec<HierLineRect<'a>>,
    pub box_w: JsNum,
}

fn preorder_index(
    nodes: &[HierTreeNode],
    into: &mut std::collections::HashMap<*const HierTreeNode, usize>,
) {
    for node in nodes {
        let next = into.len();
        into.insert(std::ptr::from_ref(node), next);
        preorder_index(&node.children, into);
    }
}

#[derive(Serialize)]
struct WireBox {
    node: usize,
    x: JsNum,
    y: JsNum,
    w: JsNum,
    h: JsNum,
}

#[derive(Serialize)]
struct WireLine {
    x: JsNum,
    y: JsNum,
    cx: JsNum,
    cy: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<usize>,
}

impl Serialize for HierLayout<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut index = std::collections::HashMap::new();
        preorder_index(self.roots, &mut index);
        let at = |node: &HierTreeNode| {
            index
                .get(&std::ptr::from_ref(node))
                .copied()
                .ok_or_else(|| serde::ser::Error::custom("a layout node that is not in the roots"))
        };
        let boxes = self
            .boxes
            .iter()
            .map(|b| {
                Ok(WireBox {
                    node: at(b.node)?,
                    x: b.x,
                    y: b.y,
                    w: b.w,
                    h: b.h,
                })
            })
            .collect::<Result<Vec<_>, S::Error>>()?;
        let lines = self
            .lines
            .iter()
            .map(|ln| {
                Ok(WireLine {
                    x: ln.x,
                    y: ln.y,
                    cx: ln.cx,
                    cy: ln.cy,
                    to: ln.to.map(at).transpose()?,
                })
            })
            .collect::<Result<Vec<_>, S::Error>>()?;
        let mut st = serializer.serialize_struct("HierLayout", 3)?;
        st.serialize_field("boxes", &boxes)?;
        st.serialize_field("lines", &lines)?;
        st.serialize_field("boxW", &self.box_w)?;
        st.end()
    }
}

const DEFAULTS: HierConstraints = HierConstraints {
    box_aspect: JsNum(0.5),
    sib_sp: JsNum(0.21),
    sp: JsNum(0.21),
    trunk_off: JsNum(0.1),
    hang_indent: JsNum(0.25),
    font_max: JsNum(65.0),
};

/// The factors this engine consumes, out of the layout part's constraint
/// lists. `None` is `undefined`.
pub fn parse_hier_constraints(layout_xml: Option<&str>) -> HierConstraints {
    let mut cons = DEFAULTS;
    let Some(layout_xml) = truthy(layout_xml) else {
        return cons;
    };
    let fact = |re: &JsRegex| -> Option<f64> {
        let m = re.exec(layout_xml)?;
        let v = parse_float(m.get(1).unwrap_or_default());
        if v.is_finite() && v > 0.0 {
            Some(v)
        } else {
            None
        }
    };
    // The box and gap facts hang off the node composite. Office's orgChart1 names
    // it rootComposite1; the built-in hierarchy1 layout names it composite.
    cons.box_aspect = fact(js_regex!(
        r#"<dgm:constr type="h" for="des" forName="(?:rootComposite1?|composite)"[^>]*refForName="(?:rootComposite1?|composite)"[^>]*fact="([\d.]+)""#
    ))
    .map_or(cons.box_aspect, JsNum);
    cons.sib_sp = fact(js_regex!(
        r#"<dgm:constr type="sibSp"[^>]*refForName="(?:rootComposite1?|composite)"[^>]*fact="([\d.]+)""#
    ))
    .map_or(cons.sib_sp, JsNum);
    // Row gap: measured against a sibling box width (orgChart1) or against the
    // composite height (hierarchy1), so a height reference scales by the aspect.
    if let Some(sp) = js_regex!(
        r#"<dgm:constr type="sp" for="des" forName="hierRoot1"[^>]*?refType="(w|h)"[^>]*?fact="([\d.]+)""#
    )
    .exec(layout_xml)
    {
        let v = parse_float(sp.get(2).unwrap_or_default());
        if v.is_finite() && v > 0.0 {
            cons.sp = JsNum(if sp.get(1) == Some("h") {
                v * cons.box_aspect.0
            } else {
                v
            });
        }
    } else {
        cons.sp = fact(js_regex!(
            r#"<dgm:constr type="sp" for="des" forName="hierRoot1"[^>]*fact="([\d.]+)""#
        ))
        .map_or(cons.sp, JsNum);
    }
    let conn_w = fact(js_regex!(
        r#"<dgm:constr type="w" for="ch" forName="rootConnector1?"[^>]*fact="([\d.]+)""#
    ));
    if let Some(conn_w) = conn_w {
        cons.trunk_off = JsNum(conn_w / 2.0);
    }
    if let Some(fsz) =
        js_regex!(r#"<dgm:constr type="primFontSz"[^>]*\bval="([\d.]+)""#).exec(layout_xml)
    {
        let v = parse_float(fsz.get(1).unwrap_or_default());
        // `parseFloat(...) || cons.fontMax`: 0 and NaN fall back
        if v != 0.0 && !v.is_nan() {
            cons.font_max = JsNum(v);
        }
    }
    cons
}

#[derive(Debug, Clone, Copy)]
struct Line<'a> {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    to: Option<&'a HierTreeNode>,
}

#[derive(Debug, Clone, Copy)]
struct SubBox<'a> {
    node: &'a HierTreeNode,
    cx: f64,
    row: usize,
}

/// A laid-out subtree. `l` and `r` are per-row x extents relative to the
/// subtree's root box center; `None` is an array hole of the TypeScript.
#[derive(Debug, Clone)]
struct Sub<'a> {
    rows: usize,
    l: Vec<Option<f64>>,
    r: Vec<Option<f64>>,
    boxes: Vec<SubBox<'a>>,
    lines: Vec<Line<'a>>,
}

/// `a[i]`, `None` where JavaScript reads `undefined`.
fn at(a: &[Option<f64>], i: usize) -> Option<f64> {
    a.get(i).copied().flatten()
}

/// `a[i]!` in arithmetic: `undefined` is NaN there.
fn num(a: &[Option<f64>], i: usize) -> f64 {
    at(a, i).unwrap_or(f64::NAN)
}

/// `a[i] = v`, growing the array with holes.
fn set(a: &mut Vec<Option<f64>>, i: usize, v: f64) {
    if a.len() <= i {
        a.resize(i + 1, None);
    }
    if let Some(slot) = a.get_mut(i) {
        *slot = Some(v);
    }
}

fn is_leaf_asst(c: &HierTreeNode) -> bool {
    c.asst == Some(true) && c.children.is_empty()
}

fn kids_of(n: &HierTreeNode) -> Vec<&HierTreeNode> {
    n.children.iter().filter(|c| !is_leaf_asst(c)).collect()
}

fn assts_of(n: &HierTreeNode) -> Vec<&HierTreeNode> {
    n.children.iter().filter(|c| is_leaf_asst(c)).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Branch {
    Std,
    HangR,
    HangL,
}

/// Whole-tree row count with every branch laid out standard.
fn std_rows_of(node: &HierTreeNode) -> usize {
    let kids = kids_of(node);
    let asst_rows = if assts_of(node).is_empty() { 0 } else { 1 };
    if kids.is_empty() {
        return 1 + asst_rows;
    }
    let mut deepest = 0;
    for kid in kids {
        let rows = std_rows_of(kid);
        if rows > deepest {
            deepest = rows;
        }
    }
    1 + asst_rows + deepest
}

fn branch_of(node: &HierTreeNode, depth: usize, kids: &[&HierTreeNode], std_rows: usize) -> Branch {
    if kids.is_empty() {
        return Branch::Std;
    }
    let all_leaves = node.children.iter().all(|c| c.children.is_empty());
    match node.hier_branch.as_deref() {
        Some("l") => return Branch::HangL,
        Some("r" | "hang") => return Branch::HangR,
        Some("std") => return Branch::Std,
        _ => {}
    }
    if std_rows >= 4 && depth >= 2 && kids.len() >= 2 && all_leaves {
        Branch::HangR
    } else {
        Branch::Std
    }
}

fn shift_sub<'a>(sub: &Sub<'a>, dx: f64, d_row: usize, into: &mut Sub<'a>, dy: f64) {
    for i in 0..sub.rows {
        let row = d_row + i;
        let sl = num(&sub.l, i) + dx;
        let sr = num(&sub.r, i) + dx;
        let l = match at(&into.l, row) {
            None => sl,
            Some(v) => math_min(v, sl),
        };
        set(&mut into.l, row, l);
        let r = match at(&into.r, row) {
            None => sr,
            Some(v) => math_max(v, sr),
        };
        set(&mut into.r, row, r);
    }
    for b in &sub.boxes {
        into.boxes.push(SubBox {
            node: b.node,
            cx: b.cx + dx,
            row: b.row + d_row,
        });
    }
    for ln in &sub.lines {
        into.lines.push(Line {
            to: ln.to,
            x1: ln.x1 + dx,
            y1: ln.y1 + dy,
            x2: ln.x2 + dx,
            y2: ln.y2 + dy,
        });
    }
    into.rows = into.rows.max(d_row + sub.rows);
}

/// Merges a subtree's extents, shifted by `dx`, into `merged`.
fn merge_extents(
    merged_l: &mut Vec<Option<f64>>,
    merged_r: &mut Vec<Option<f64>>,
    sub: &Sub<'_>,
    dx: f64,
) {
    for i in 0..sub.rows {
        let l = match at(merged_l, i) {
            None => num(&sub.l, i) + dx,
            Some(v) => math_min(v, num(&sub.l, i) + dx),
        };
        set(merged_l, i, l);
        let r = match at(merged_r, i) {
            None => num(&sub.r, i) + dx,
            Some(v) => math_max(v, num(&sub.r, i) + dx),
        };
        set(merged_r, i, r);
    }
}

struct Ctx {
    cons: HierConstraints,
    bh: f64,
    pitch: f64,
    std_rows: usize,
}

impl Ctx {
    fn row_top(&self, row: usize) -> f64 {
        row as f64 * self.pitch
    }

    fn layout<'a>(&self, node: &'a HierTreeNode, depth: usize) -> Sub<'a> {
        let cons = &self.cons;
        let bh = self.bh;
        let kids = kids_of(node);
        let assts = assts_of(node);
        let mut out = Sub {
            rows: 1,
            l: vec![Some(-0.5)],
            r: vec![Some(0.5)],
            boxes: vec![SubBox {
                node,
                cx: 0.0,
                row: 0,
            }],
            lines: Vec::new(),
        };
        if kids.is_empty() && assts.is_empty() {
            return out;
        }

        let branch = branch_of(node, depth, &kids, self.std_rows);
        let mir = if branch == Branch::HangL { -1.0 } else { 1.0 };
        let trunk_x = if branch == Branch::Std {
            0.0
        } else {
            mir * (cons.trunk_off.0 - 0.5)
        };
        let child_row0 = 1 + usize::from(!assts.is_empty());

        if !assts.is_empty() {
            let asst_mid_y = self.row_top(1) + bh / 2.0;
            for (j, &a) in assts.iter().enumerate() {
                let right = trunk_x - cons.sp.0 / 2.0 - j as f64 * (1.0 + cons.sib_sp.0);
                out.boxes.push(SubBox {
                    node: a,
                    cx: right - 0.5,
                    row: 1,
                });
                out.lines.push(Line {
                    x1: right,
                    y1: asst_mid_y,
                    x2: trunk_x,
                    y2: asst_mid_y,
                    to: Some(a),
                });
                let l = math_min(at(&out.l, 1).unwrap_or(f64::INFINITY), right - 1.0);
                set(&mut out.l, 1, l);
                let r = math_max(at(&out.r, 1).unwrap_or(f64::NEG_INFINITY), trunk_x);
                set(&mut out.r, 1, r);
            }
            out.rows = 2;
        }

        if kids.is_empty() {
            out.lines.push(Line {
                x1: trunk_x,
                y1: bh,
                x2: trunk_x,
                y2: self.row_top(1) + bh / 2.0,
                to: assts.first().copied(),
            });
            return out;
        }

        let subs: Vec<Sub<'a>> = kids.iter().map(|&k| self.layout(k, depth + 1)).collect();

        if branch == Branch::Std {
            let mut merged_l: Vec<Option<f64>> = Vec::new();
            let mut merged_r: Vec<Option<f64>> = Vec::new();
            let mut offs: Vec<f64> = Vec::new();
            for sub in &subs {
                let mut dx = 0.0;
                if !offs.is_empty() {
                    dx = f64::NEG_INFINITY;
                    for i in 0..sub.rows {
                        if let Some(mr) = at(&merged_r, i) {
                            dx = math_max(dx, mr + cons.sib_sp.0 - num(&sub.l, i));
                        }
                    }
                    if !dx.is_finite() {
                        dx = num(&merged_r, 0) + cons.sib_sp.0 - num(&sub.l, 0);
                    }
                }
                offs.push(dx);
                merge_extents(&mut merged_l, &mut merged_r, sub, dx);
            }
            let first = offs.first().copied().unwrap_or(f64::NAN);
            let last = offs.last().copied().unwrap_or(f64::NAN);
            let mid = (first + last) / 2.0;
            let bus_y = self.row_top(child_row0) - cons.sp.0 / 2.0;
            out.lines.push(Line {
                x1: trunk_x,
                y1: bh,
                x2: trunk_x,
                y2: bus_y,
                to: kids.first().copied(),
            });
            for (i, (sub, off)) in subs.iter().zip(&offs).enumerate() {
                let to = kids.get(i).copied();
                let cx = off - mid;
                out.lines.push(Line {
                    x1: trunk_x,
                    y1: bus_y,
                    x2: cx,
                    y2: bus_y,
                    to,
                });
                out.lines.push(Line {
                    x1: cx,
                    y1: bus_y,
                    x2: cx,
                    y2: self.row_top(child_row0),
                    to,
                });
                shift_sub(sub, cx, child_row0, &mut out, self.row_top(child_row0));
            }
        } else {
            let mut row = child_row0;
            let mut last_mid_y = bh;
            for (i, sub) in subs.iter().enumerate() {
                let cx = mir * (cons.hang_indent.0 - 0.5 + 0.5);
                let mid_y = self.row_top(row) + bh / 2.0;
                out.lines.push(Line {
                    x1: trunk_x,
                    y1: mid_y,
                    x2: cx - mir * 0.5,
                    y2: mid_y,
                    to: kids.get(i).copied(),
                });
                shift_sub(sub, cx, row, &mut out, self.row_top(row));
                last_mid_y = mid_y;
                row += sub.rows;
            }
            out.lines.push(Line {
                x1: trunk_x,
                y1: bh,
                x2: trunk_x,
                y2: last_mid_y,
                to: kids.first().copied(),
            });
        }
        out
    }
}

/// `layoutHierTree`: `None` is the TypeScript's `null` (no roots, or a
/// layout with no extent).
pub fn layout_hier_tree<'a>(
    roots: &'a [HierTreeNode],
    cons: HierConstraints,
    frame_cx: f64,
    frame_cy: f64,
) -> Option<HierLayout<'a>> {
    if roots.is_empty() {
        return None;
    }
    let bh = cons.box_aspect.0;
    let pitch = bh + cons.sp.0;
    let mut std_rows = 0;
    for root in roots {
        let rows = std_rows_of(root);
        if rows > std_rows {
            std_rows = rows;
        }
    }
    let ctx = Ctx {
        cons,
        bh,
        pitch,
        std_rows,
    };

    // Top level (hierChild1): root subtrees pack like siblings
    let mut top = Sub {
        rows: 0,
        l: Vec::new(),
        r: Vec::new(),
        boxes: Vec::new(),
        lines: Vec::new(),
    };
    let mut merged_l: Vec<Option<f64>> = Vec::new();
    let mut merged_r: Vec<Option<f64>> = Vec::new();
    for (placed, r) in roots.iter().enumerate() {
        let sub = ctx.layout(r, 1);
        let mut dx = 0.0;
        if placed != 0 {
            dx = f64::NEG_INFINITY;
            for i in 0..sub.rows {
                if let Some(mr) = at(&merged_r, i) {
                    dx = math_max(dx, mr + cons.sib_sp.0 - num(&sub.l, i));
                }
            }
            if !dx.is_finite() {
                dx = 0.0;
            }
        }
        merge_extents(&mut merged_l, &mut merged_r, &sub, dx);
        shift_sub(&sub, dx, 0, &mut top, 0.0);
    }

    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    for i in 0..top.rows {
        if let Some(l) = at(&top.l, i) {
            min_x = math_min(min_x, l);
        }
        if let Some(r) = at(&top.r, i) {
            max_x = math_max(max_x, r);
        }
    }
    for ln in &top.lines {
        min_x = math_min(math_min(min_x, ln.x1), ln.x2);
        max_x = math_max(math_max(max_x, ln.x1), ln.x2);
    }
    let unit_w = max_x - min_x;
    let rows = top.rows as f64;
    let unit_h = rows * bh + (rows - 1.0) * cons.sp.0;
    // `!(x > 0)`: a NaN goes this way too
    if unit_w.is_nan() || unit_w <= 0.0 || unit_h.is_nan() || unit_h <= 0.0 {
        return None;
    }
    let scale = math_min(frame_cx / unit_w, frame_cy / unit_h);
    let off_x = (frame_cx - unit_w * scale) / 2.0 - min_x * scale;
    let off_y = (frame_cy - unit_h * scale) / 2.0;

    let boxes = top
        .boxes
        .iter()
        .map(|b| HierBox {
            node: b.node,
            x: JsNum(off_x + (b.cx - 0.5) * scale),
            y: JsNum(off_y + ctx.row_top(b.row) * scale),
            w: JsNum(scale),
            h: JsNum(bh * scale),
        })
        .collect();
    let lines = top
        .lines
        .iter()
        .map(|ln| HierLineRect {
            x: JsNum(off_x + math_min(ln.x1, ln.x2) * scale),
            y: JsNum(off_y + math_min(ln.y1, ln.y2) * scale),
            cx: JsNum((ln.x2 - ln.x1).abs() * scale),
            cy: JsNum((ln.y2 - ln.y1).abs() * scale),
            to: ln.to,
        })
        .collect();
    Some(HierLayout {
        roots,
        boxes,
        lines,
        box_w: JsNum(scale),
    })
}
