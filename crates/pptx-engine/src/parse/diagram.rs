//! The SmartArt fallback of packages/pptx-engine/src/parse.ts (lines
//! 1743-3161): SmartArt without a usable prerendered drawing, laid out from
//! its data part. `layoutDiagramFallback` dispatches on the layout part's
//! uniqueId to one family of hand-written algorithms; each family lives in a
//! submodule, the submodules in the order of the TypeScript's if-chain.

mod chevron;
mod columns;
mod cycle;
mod grid;
mod org;
mod process;
mod rows;
mod shapes;

use std::collections::HashSet;
use std::sync::Arc;

use jscompat::{
    JsMap, Radix, js_regex, math_max, math_min, math_round, number_to_string, number_truthy,
    pad_start, parse_int, slice_utf16, sort_by_number, to_string_radix16, truthy, value_to_string,
    value_truthy,
};
use serde_json::{Map, Value, json};

use super::context::{Node, ParseContext, parse_xml};
use crate::types::{ByteAnchor, SlideElement};

/// `DgmTreeNode`: one dgm data node, its own text paragraphs, its explicit
/// `dgm:spPr` (kept only where it holds an `a:solidFill`) and its children in
/// `srcOrd` order. The TypeScript's `id` is written and never read, so it is
/// not kept.
pub(crate) struct DgmTreeNode<'d> {
    texts: Vec<String>,
    sp_pr: Option<&'d Value>,
    children: Vec<DgmTreeNode<'d>>,
    /// `dgm:pt type="asst"`: an org-chart assistant
    asst: bool,
    /// The explicit ST_HierBranchStyle of the presentation point (`init` omitted)
    hier_branch: Option<String>,
    /// The explicit run size (pt) of the node's text
    size_pt: Option<f64>,
    /// `styleLbl` and `styleIdx`: presStyleLbl and presStyleIdx of the node's
    /// own shape, which the TypeScript always sets together
    style: Option<(String, f64)>,
}

/// `MAX_DGM_TREE_DEPTH`
const MAX_DGM_TREE_DEPTH: u32 = 256;

/// An item of `dgmBulletLines`.
pub(crate) struct DgmBulletLine<'n> {
    text: &'n str,
    lvl: f64,
}

/// `dgmBulletLines`: the depth-first bullet lines of a node's descendants
/// (lvl 1 is a direct child). The tree is at most `MAX_DGM_TREE_DEPTH + 1`
/// deep, as `build` makes it.
pub(crate) fn dgm_bullet_lines<'n>(node: &'n DgmTreeNode<'_>, lvl: f64) -> Vec<DgmBulletLine<'n>> {
    let mut out = Vec::new();
    for c in &node.children {
        for t in &c.texts {
            if !t.is_empty() {
                out.push(DgmBulletLine { text: t, lvl });
            }
        }
        out.extend(dgm_bullet_lines(c, lvl + 1.0));
    }
    out
}

/// `Array.isArray(v) ? v : v ? [v] : []`
fn list(v: Node<'_>) -> &[Value] {
    match v {
        Some(Value::Array(items)) => items,
        Some(v) if value_truthy(Some(v)) => std::slice::from_ref(v),
        _ => &[],
    }
}

/// `v?.[key]`
fn get<'v>(v: Node<'v>, key: &str) -> Node<'v> {
    v.and_then(|v| v.get(key))
}

/// `parseInt(String(v), 10) || 0`
fn int_or_zero(v: Node<'_>) -> f64 {
    let n = parse_int(&value_to_string(v), Radix::Ten);
    if number_truthy(n) { n } else { 0.0 }
}

/// `diagramLabelFills`: colorsN.xml styleLbl to its fillClrLst colors
/// (modifiers applied), resolved against the theme.
pub(crate) fn diagram_label_fills(
    colors_xml: Option<&str>,
    ctx: &ParseContext<'_>,
) -> JsMap<Vec<String>> {
    let mut out = JsMap::new();
    let Some(colors_xml) = truthy(colors_xml) else {
        return out;
    };
    let Ok(doc) = parse_xml(colors_xml) else {
        return out;
    };
    let raw = get(get(Some(&doc), "dgm:colorsDef"), "dgm:styleLbl");
    for lbl in list(raw) {
        let Some(lst) = lbl.get("dgm:fillClrLst") else {
            continue;
        };
        if !value_truthy(Some(lst)) || !matches!(lst, Value::Object(_) | Value::Array(_)) {
            continue;
        }
        let mut fills = Vec::new();
        for tag in super::fill::COLOR_NODE_TAGS {
            for c in list(lst.get(tag)) {
                let mut node = Map::new();
                node.insert(tag.to_owned(), c.clone());
                let hex = super::fill::resolve_color_node(Some(&Value::Object(node)), ctx);
                if let Some(hex) = truthy(hex.as_deref()) {
                    fills.push(slice_utf16(hex, 0.0, Some(7.0)));
                }
            }
        }
        if !fills.is_empty() {
            out.set(value_to_string(lbl.get("@_name")), fills);
        }
    }
    out
}

/// The `box` of `dgmSp`, in EMU.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DgmBox {
    x: f64,
    y: f64,
    cx: f64,
    cy: f64,
}

/// `DgmBox { x, y, cx, cy }`
fn dgm_box(x: f64, y: f64, cx: f64, cy: f64) -> DgmBox {
    DgmBox { x, y, cx, cy }
}

/// The `fill` of `dgmSp`: `string | { spPr: any }`.
#[derive(Debug, Clone, Copy)]
pub(crate) enum DgmFill<'a> {
    Color(&'a str),
    SpPr(&'a Value),
}

impl<'a> DgmFill<'a> {
    /// `typeof fill === 'string' ? fill : undefined`
    fn hex(self) -> Option<&'a str> {
        match self {
            DgmFill::Color(c) => Some(c),
            DgmFill::SpPr(_) => None,
        }
    }
}

/// A line of `dgmSp`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DgmLine<'t> {
    text: &'t str,
    lvl: f64,
    size_pt: f64,
    bold: bool,
}

/// `texts.map((tx) => ({ text: tx, lvl: 0, sizePt }))`
fn text_lines(texts: &[String], size_pt: f64) -> Vec<DgmLine<'_>> {
    texts
        .iter()
        .map(|text| DgmLine {
            text,
            lvl: 0.0,
            size_pt,
            bold: false,
        })
        .collect()
}

/// `bullets.map((l) => ({ text: l.text, lvl: l.lvl, sizePt }))`
fn bullet_lines<'t>(bullets: &[DgmBulletLine<'t>], size_pt: f64) -> Vec<DgmLine<'t>> {
    bullets
        .iter()
        .map(|l| DgmLine {
            text: l.text,
            lvl: l.lvl,
            size_pt,
            bold: false,
        })
        .collect()
}

/// The `opts` of `dgmSp`.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct DgmSpOpts<'o> {
    prst: Option<&'static str>,
    text_color: Option<&'o str>,
    align: Option<&'static str>,
    anchor: Option<&'static str>,
    stroke: Option<&'o str>,
    no_fill: bool,
    adj: Option<f64>,
    /// Named adjust values (multi-adj presets like downArrow adj1/adj2)
    adjs: &'o [(&'static str, f64)],
    /// xfrm rotation (60000ths of a degree)
    rot: Option<f64>,
}

/// `String(Math.round(x))`
fn rounded(x: f64) -> Value {
    Value::String(number_to_string(math_round(x)))
}

/// `hex.replace('#', '')`
fn without_hash(hex: &str) -> String {
    hex.replacen('#', "", 1)
}

/// `'val ' + Math.round(val)`
fn fmla(val: f64) -> String {
    format!("val {}", number_to_string(math_round(val)))
}

/// `dgmSp`: the synthetic sp node of the diagram fallback, a box in EMU, a
/// solid fill and optional text lines.
pub(crate) fn dgm_sp(
    r#box: DgmBox,
    fill: DgmFill<'_>,
    lines: &[DgmLine<'_>],
    opts: &DgmSpOpts<'_>,
) -> Value {
    let fill_node: (&str, Option<Value>) = if opts.no_fill {
        ("a:noFill", Some(json!({})))
    } else {
        match fill {
            DgmFill::Color(fill) => (
                "a:solidFill",
                Some(json!({ "a:srgbClr": { "@_val": without_hash(fill) } })),
            ),
            DgmFill::SpPr(sp_pr) => ("a:solidFill", sp_pr.get("a:solidFill").cloned()),
        }
    };
    let mut xfrm = Map::new();
    if let Some(rot) = opts.rot.filter(|&rot| number_truthy(rot)) {
        xfrm.insert("@_rot".to_owned(), Value::String(number_to_string(rot)));
    }
    xfrm.insert(
        "a:off".to_owned(),
        json!({ "@_x": rounded(r#box.x), "@_y": rounded(r#box.y) }),
    );
    xfrm.insert(
        "a:ext".to_owned(),
        json!({ "@_cx": rounded(r#box.cx), "@_cy": rounded(r#box.cy) }),
    );
    let mut prst_geom = Map::new();
    prst_geom.insert("@_prst".to_owned(), json!(opts.prst.unwrap_or("rect")));
    if !opts.adjs.is_empty() {
        let gd: Vec<Value> = opts
            .adjs
            .iter()
            .map(|&(name, val)| json!({ "@_name": name, "@_fmla": fmla(val) }))
            .collect();
        prst_geom.insert("a:avLst".to_owned(), json!({ "a:gd": gd }));
    } else if let Some(adj) = opts.adj {
        prst_geom.insert(
            "a:avLst".to_owned(),
            json!({ "a:gd": { "@_name": "adj", "@_fmla": fmla(adj) } }),
        );
    }
    let mut sp_pr = Map::new();
    sp_pr.insert("a:xfrm".to_owned(), Value::Object(xfrm));
    sp_pr.insert("a:prstGeom".to_owned(), Value::Object(prst_geom));
    if let (key, Some(value)) = fill_node {
        sp_pr.insert(key.to_owned(), value);
    }
    if let Some(stroke) = truthy(opts.stroke) {
        let color = json!({ "a:srgbClr": { "@_val": without_hash(stroke) } });
        sp_pr.insert(
            "a:ln".to_owned(),
            json!({ "@_w": "9525", "a:solidFill": color }),
        );
    }
    let mut sp = Map::new();
    sp.insert("p:spPr".to_owned(), Value::Object(sp_pr));
    if !lines.is_empty() {
        let text_color = without_hash(opts.text_color.unwrap_or("#FFFFFF"));
        let paragraphs: Vec<Value> = lines
            .iter()
            .map(|l| {
                let mut p_pr = Map::new();
                p_pr.insert("@_algn".to_owned(), json!(opts.align.unwrap_or("ctr")));
                if l.lvl > 0.0 {
                    p_pr.insert(
                        "@_marL".to_owned(),
                        Value::String(number_to_string(228600.0 * l.lvl)),
                    );
                    p_pr.insert("@_indent".to_owned(), json!("-114300"));
                    p_pr.insert("a:buChar".to_owned(), json!({ "@_char": "\u{2022}" }));
                } else {
                    p_pr.insert("a:buNone".to_owned(), json!({}));
                }
                let mut r_pr = Map::new();
                r_pr.insert("@_sz".to_owned(), rounded(l.size_pt * 100.0));
                if l.bold {
                    r_pr.insert("@_b".to_owned(), json!("1"));
                }
                r_pr.insert(
                    "a:solidFill".to_owned(),
                    json!({ "a:srgbClr": { "@_val": text_color } }),
                );
                json!({ "a:pPr": p_pr, "a:r": { "a:rPr": r_pr, "a:t": l.text } })
            })
            .collect();
        sp.insert(
            "p:txBody".to_owned(),
            json!({ "a:bodyPr": { "@_anchor": opts.anchor.unwrap_or("ctr") }, "a:p": paragraphs }),
        );
    }
    Value::Object(sp)
}

/// `dgmTint`: a tint toward white keeping `pct` of the color.
pub(crate) fn dgm_tint(hex: &str, pct: f64) -> String {
    let h = without_hash(hex);
    let mix = |i: f64| {
        let channel = parse_int(&slice_utf16(&h, i, Some(i + 2.0)), Radix::Sixteen);
        let v = math_round(255.0 * (1.0 - pct) + channel * pct);
        pad_start(&to_string_radix16(v).to_ascii_uppercase(), 2, '0')
    };
    format!("#{}{}{}", mix(0.0), mix(2.0), mix(4.0))
}

/// What `build` of layoutDiagramFallback reads and writes.
struct TreeBuild<'m, 'd> {
    by_src: &'m JsMap<Vec<&'d Value>>,
    node_pts: &'m JsMap<&'d Value>,
    style_of: &'m JsMap<(String, f64)>,
    hier_branch_of: &'m JsMap<String>,
    seen: HashSet<String>,
}

/// `build` of layoutDiagramFallback. Every sibling is marked seen before
/// the first one's subtree is built, as the TypeScript's `filter` runs
/// whole before its `map`.
fn build<'d>(state: &mut TreeBuild<'_, 'd>, id: &str, depth: u32) -> Vec<DgmTreeNode<'d>> {
    let by_src = state.by_src;
    let ids: Vec<String> = by_src
        .get(id)
        .map(|cxns| {
            cxns.iter()
                .map(|c| value_to_string(c.get("@_destId")))
                .filter(|d| state.seen.insert(d.clone()))
                .collect()
        })
        .unwrap_or_default();
    let mut out = Vec::with_capacity(ids.len());
    for d in ids {
        let pt = state.node_pts.get(&d).copied();
        let size_pt = collect_dgm_run_size(pt);
        let style = state.style_of.get(&d).cloned();
        let texts = collect_dgm_texts(pt);
        let sp_pr = get(pt, "dgm:spPr").filter(|sp_pr| value_truthy(sp_pr.get("a:solidFill")));
        let asst = get(pt, "@_type").and_then(Value::as_str) == Some("asst");
        let hier_branch = state.hier_branch_of.get(&d).cloned();
        let children = if depth < MAX_DGM_TREE_DEPTH {
            build(state, &d, depth + 1)
        } else {
            Vec::new()
        };
        out.push(DgmTreeNode {
            texts,
            sp_pr,
            children,
            asst,
            hier_branch,
            size_pt: size_pt.filter(|&s| number_truthy(s)),
            style,
        });
    }
    out
}

/// `fitSize`: text sizes scale with the box and shrink with the line count
/// (SmartArt autofit, coarse). The callers pass `cap`'s default, 26.
fn fit_size(box_cy_emu: f64, n_lines: f64, cap: f64) -> f64 {
    let box_pt = box_cy_emu / 12700.0;
    math_max(
        8.0,
        math_min(cap, (box_pt * 0.82) / math_max(n_lines, 1.0) / 1.35),
    )
}

/// `text.length`
fn utf16_len(text: &str) -> f64 {
    text.encode_utf16().count() as f64
}

/// `fitSizeW`: also shrinks until the longest word fits the box width and
/// the wrapped line count fits the height (coarse 0.62em average advance).
/// `Math.max(0, ...lengths)` throws a RangeError in JavaScript past some
/// hundred thousand words; here it does not.
fn fit_size_w<T: AsRef<str>>(box_cy_emu: f64, box_cx_emu: f64, texts: &[T], cap: f64) -> f64 {
    let mut s = fit_size(box_cy_emu, math_max(texts.len() as f64, 1.0), cap);
    let box_w_pt = (box_cx_emu / 12700.0) * 0.92;
    let box_h_pt = (box_cy_emu / 12700.0) * 0.9;
    let mut longest = 0.0;
    for t in texts {
        for w in js_regex!(r"\s+").split(t.as_ref()) {
            longest = math_max(longest, utf16_len(w));
        }
    }
    if number_truthy(longest) {
        s = math_min(s, box_w_pt / (longest * 0.62));
    }
    for _ in 0..3 {
        let lines = texts.iter().fold(0.0, |acc, t| {
            acc + math_max(1.0, ((utf16_len(t.as_ref()) * 0.62 * s) / box_w_pt).ceil())
        });
        let need = lines * 1.35 * s;
        if need <= box_h_pt {
            break;
        }
        s *= (box_h_pt / need).sqrt();
    }
    math_max(6.0, s)
}

/// `Math.max(...values)` and `Math.min(...values)` folded as JavaScript
/// does: from -Infinity and +Infinity.
fn min_of(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(f64::INFINITY, math_min)
}

/// The tile grid of `flatGrid`, `cards` and `blocks`: the column count
/// whose tile width is the largest, and that width.
fn grid_columns(n: f64, frame_cx: f64, avail_cy: f64, gap: f64, aspect: f64) -> (f64, f64) {
    let mut cols = 1.0;
    let mut best = 0.0;
    let mut c = 1.0;
    while c <= n {
        let r = (n / c).ceil();
        let w = math_min(
            frame_cx / (c + (c - 1.0) * gap),
            avail_cy / (r * aspect + (r - 1.0) * gap),
        );
        if w > best {
            best = w;
            cols = c;
        }
        c += 1.0;
    }
    (cols, best)
}

/// The layout families of `byLayout`, and `flatGrid`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    FlatGrid,
    Equation,
    ColProcess,
    Columns,
    TableList,
    Stacked,
    Hierarchy,
    SideList,
    Stepped,
    ChevronList,
    ChevronRow,
    ArrowRing,
    CycleMatrix,
    Cycle,
    OrgChart,
    Cards,
    ArrowBands,
    ProcCards,
    Pyramid,
    Strips,
    PictureList,
    RuleArrow,
    BoxList,
    Blocks,
}

/// `byLayout`: the family of the layout part's uniqueId.
fn by_layout(layout_id: Option<&str>) -> Family {
    let Some(id) = layout_id else {
        return Family::Blocks;
    };
    if id == "cycle4" {
        Family::CycleMatrix
    } else if js_regex!(r"^arrow5").test(id) {
        Family::ArrowRing
    } else if js_regex!(r"^hProcess3(#|$)").test(id) {
        Family::RuleArrow
    } else if id == "hList1" || id == "hList2" {
        Family::Columns
    } else if id == "hList3" {
        Family::TableList
    } else if js_regex!(r"^pList").test(id) {
        Family::PictureList
    } else if js_regex!(r"^list").test(id) {
        Family::BoxList
    } else if id == "vList5" || js_regex!(r"^Bracket").test(id) {
        Family::SideList
    } else if id == "vProcess5" {
        Family::Stepped
    } else if js_regex!(r"^(vList|vProcess)").test(id) {
        Family::Stacked
    } else if js_regex!(r"^bList").test(id) {
        Family::Cards
    } else if js_regex!(r"^process4(#|$)").test(id) {
        Family::ArrowBands
    } else if js_regex!(r"^(process|hProcess|bProcess)").test(id) {
        Family::ProcCards
    } else if js_regex!(r"^lProcess").test(id) {
        Family::ColProcess
    } else if js_regex!(r"^equation").test(id) {
        Family::Equation
    } else if js_regex!(r"^pyramid").test(id) {
        Family::Pyramid
    } else if js_regex!(r"^Picture").test(id) {
        Family::Strips
    } else if id == "chevron2" {
        Family::ChevronList
    } else if js_regex!(r"^chevron").test(id) {
        Family::ChevronRow
    } else if js_regex!(r"^(cycle[127]|radial)").test(id) {
        Family::Cycle
    } else if js_regex!(r"orgchart", "i").test(id) {
        Family::OrgChart
    } else if js_regex!(r"^hierarchy").test(id) {
        Family::Hierarchy
    } else {
        Family::Blocks
    }
}

/// The state the families of layoutDiagramFallback share: its arguments,
/// the tree, the colors, and `sps`, the sp nodes laid out so far.
struct Fallback<'a> {
    ctx: &'a ParseContext<'a>,
    frame_cx: f64,
    frame_cy: f64,
    layout_id: Option<&'a str>,
    layout_xml: Option<&'a str>,
    roots: &'a [DgmTreeNode<'a>],
    label_fills: &'a JsMap<Vec<String>>,
    /// The node1 fillClrLst cycle (accent scheme colors), never empty
    colors: &'a [String],
    sps: Vec<Value>,
}

impl<'a> Fallback<'a> {
    /// `colorOf`. Where the recorded slot holds no entry at the index (a
    /// negative or infinite presStyleIdx) the TypeScript reads `undefined`
    /// and throws in `dgmSp`; here the node takes the cycle color instead.
    fn color_of(&self, node: &'a DgmTreeNode<'a>, i: usize) -> DgmFill<'a> {
        if let Some(sp_pr) = node.sp_pr {
            return DgmFill::SpPr(sp_pr);
        }
        let label_fills = self.label_fills;
        if let Some((lbl, idx)) = &node.style
            && let Some(slot) = label_fills.get(lbl)
        {
            let k = idx % slot.len() as f64;
            if k >= 0.0
                && let Some(color) = slot.get(k as usize)
            {
                return DgmFill::Color(color);
            }
        }
        self.cycle_color(i)
    }

    /// `colors[i % colors.length]`
    fn cycle_color(&self, i: usize) -> DgmFill<'a> {
        let colors = self.colors;
        DgmFill::Color(&colors[i % colors.len()])
    }

    /// `colors[0]`
    fn first_color(&self) -> &'a str {
        let colors = self.colors;
        &colors[0]
    }

    fn push(
        &mut self,
        r#box: DgmBox,
        fill: DgmFill<'_>,
        lines: &[DgmLine<'_>],
        opts: DgmSpOpts<'_>,
    ) {
        self.sps.push(dgm_sp(r#box, fill, lines, &opts));
    }
}

/// `layoutDiagramFallback`: SmartArt without a usable prerendered drawing,
/// its data tree laid out here. Flat lists keep the PowerPoint-measured
/// tile grid; hierarchical data dispatches on the layout part's uniqueId to
/// a small family of hand-written algorithms, defaulting to top-node tiles
/// with descendant bullet text.
pub fn layout_diagram_fallback(
    data_xml: &str,
    ctx: &ParseContext<'_>,
    frame_cx: f64,
    frame_cy: f64,
    layout_id: Option<&str>,
    colors_xml: Option<&str>,
    layout_xml: Option<&str>,
) -> Result<Vec<SlideElement>, String> {
    let Ok(doc) = parse_xml(data_xml) else {
        return Ok(Vec::new());
    };
    let model = doc.get("dgm:dataModel");
    let pts = list(get(get(model, "dgm:ptLst"), "dgm:pt"));
    let cxns = list(get(get(model, "dgm:cxnLst"), "dgm:cxn"));
    let doc_id = pts
        .iter()
        .find(|p| p.get("@_type").and_then(Value::as_str) == Some("doc"))
        .and_then(|p| p.get("@_modelId"));
    let Some(doc_id) = doc_id.filter(|id| !id.is_null()) else {
        return Ok(Vec::new());
    };
    // dgm:pt type defaults to 'node'; some writers emit it explicitly
    let mut node_pts: JsMap<&Value> = JsMap::new();
    for p in pts {
        let t = p.get("@_type");
        if matches!(t, None | Some(Value::Null))
            || matches!(t.and_then(Value::as_str), Some("node" | "asst"))
        {
            node_pts.set(value_to_string(p.get("@_modelId")), p);
        }
    }
    let mut pres_pts: JsMap<&Value> = JsMap::new();
    for p in pts {
        if p.get("@_type").and_then(Value::as_str) == Some("pres") {
            pres_pts.set(value_to_string(p.get("@_modelId")), p);
        }
    }
    let mut hier_branch_of: JsMap<String> = JsMap::new();
    let mut style_of: JsMap<(String, f64)> = JsMap::new();
    for pres in pres_pts.values() {
        let pr_set = pres.get("dgm:prSet");
        let hb = get(
            get(get(pr_set, "dgm:presLayoutVars"), "dgm:hierBranch"),
            "@_val",
        );
        let assoc = get(pr_set, "@_presAssocID");
        if value_truthy(hb)
            && hb.and_then(Value::as_str) != Some("init")
            && value_truthy(assoc)
            && !hier_branch_of.has(&value_to_string(assoc))
        {
            hier_branch_of.set(value_to_string(assoc), value_to_string(hb));
        }
        let lbl = get(pr_set, "@_presStyleLbl");
        if value_truthy(assoc)
            && value_truthy(lbl)
            && js_regex!(r"^node\d").test(&value_to_string(lbl))
            && !style_of.has(&value_to_string(assoc))
        {
            style_of.set(
                value_to_string(assoc),
                (
                    value_to_string(lbl),
                    int_or_zero(get(pr_set, "@_presStyleIdx")),
                ),
            );
        }
    }
    let mut by_src: JsMap<Vec<&Value>> = JsMap::new();
    for c in cxns {
        let t = c.get("@_type");
        if !matches!(t, None | Some(Value::Null)) && t.and_then(Value::as_str) != Some("parOf") {
            continue;
        }
        if !node_pts.has(&value_to_string(c.get("@_destId"))) {
            continue;
        }
        let k = value_to_string(c.get("@_srcId"));
        match by_src.get_mut(&k) {
            Some(arr) => arr.push(c),
            None => by_src.set(k, vec![c]),
        }
    }
    for arr in by_src.values_mut() {
        sort_by_number(arr, |a, b| {
            int_or_zero(a.get("@_srcOrd")) - int_or_zero(b.get("@_srcOrd"))
        });
    }
    let mut tree = TreeBuild {
        by_src: &by_src,
        node_pts: &node_pts,
        style_of: &style_of,
        hier_branch_of: &hier_branch_of,
        seen: HashSet::new(),
    };
    let roots = build(&mut tree, &value_to_string(Some(doc_id)), 0);
    if roots.is_empty() {
        return Ok(Vec::new());
    }

    let label_fills = diagram_label_fills(colors_xml, ctx);
    let accent1;
    let colors: &[String] = match label_fills
        .get("node1")
        .or_else(|| label_fills.get("node0"))
    {
        Some(colors) => colors.as_slice(),
        None => {
            accent1 = [super::fill::resolve_color_node(
                Some(&json!({ "a:schemeClr": { "@_val": "accent1" } })),
                ctx,
            )
            .unwrap_or_else(|| "#4472C4".to_owned())];
            &accent1
        }
    };
    let has_hierarchy = roots.iter().any(|r| !r.children.is_empty());
    let by_layout = by_layout(layout_id);
    let family = if by_layout == Family::Blocks && !has_hierarchy {
        Family::FlatGrid
    } else {
        by_layout
    };

    let mut f = Fallback {
        ctx,
        frame_cx,
        frame_cy,
        layout_id,
        layout_xml,
        roots: &roots,
        label_fills: &label_fills,
        colors,
        sps: Vec::new(),
    };
    match family {
        Family::FlatGrid => grid::flat_grid(&mut f),
        Family::Equation => grid::equation(&mut f),
        Family::ColProcess => columns::col_process(&mut f),
        Family::Columns => columns::columns(&mut f),
        Family::TableList => columns::table_list(&mut f),
        Family::Stacked => rows::stacked(&mut f),
        Family::Hierarchy => rows::hierarchy(&mut f),
        Family::SideList => rows::side_list(&mut f),
        Family::Stepped => rows::stepped(&mut f),
        Family::ChevronList => chevron::chevron_list(&mut f),
        Family::ChevronRow => chevron::chevron_row(&mut f),
        Family::ArrowRing => cycle::arrow_ring(&mut f),
        Family::CycleMatrix => cycle::cycle_matrix(&mut f),
        Family::Cycle => cycle::cycle(&mut f),
        Family::OrgChart => org::org_chart(&mut f),
        Family::Cards => process::cards(&mut f),
        Family::ArrowBands => process::arrow_bands(&mut f),
        Family::ProcCards => process::proc_cards(&mut f),
        Family::Pyramid => shapes::pyramid(&mut f),
        Family::Strips => shapes::strips(&mut f),
        Family::PictureList => shapes::picture_list(&mut f),
        Family::RuleArrow => shapes::rule_arrow(&mut f),
        Family::BoxList => shapes::box_list(&mut f),
        Family::Blocks => shapes::blocks(&mut f),
    }

    let anchor = ByteAnchor {
        sp_index: -1,
        original_xml: Arc::from(""),
        range: [0, 0],
        gap_after: None,
    };
    let mut out = Vec::with_capacity(f.sps.len());
    for sp in &f.sps {
        // parseSpShape never returns a passthrough, so the TypeScript's
        // `el.type !== 'passthrough'` keeps every element
        let el = super::shape::parse_sp_shape(Some(sp), anchor.clone(), ctx, None)?;
        out.push(SlideElement::Text(Box::new(el)));
    }
    Ok(out)
}

/// `collectDgmTexts`: the text of one dgm:pt, its paragraph strings.
pub(crate) fn collect_dgm_texts(pt: Node<'_>) -> Vec<String> {
    let Some(body) = get(pt, "dgm:t") else {
        return Vec::new();
    };
    if !value_truthy(Some(body)) || !matches!(body, Value::Object(_) | Value::Array(_)) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for p in list(body.get("a:p")) {
        let runs = list(p.get("a:r"));
        let t: String = runs
            .iter()
            .map(|r| match r.get("a:t") {
                Some(Value::String(v)) => v.clone(),
                v => match get(v, "#text") {
                    None | Some(Value::Null) => String::new(),
                    text => value_to_string(text),
                },
            })
            .collect();
        if !t.is_empty() {
            out.push(t);
        }
    }
    out
}

/// `collectDgmRunSize`: the explicit sz (pt) of the first run of a dgm:pt
/// text, if authored.
pub(crate) fn collect_dgm_run_size(pt: Node<'_>) -> Option<f64> {
    let body = get(pt, "dgm:t")?;
    if !value_truthy(Some(body)) || !matches!(body, Value::Object(_) | Value::Array(_)) {
        return None;
    }
    fn first(v: Node<'_>) -> Node<'_> {
        match v {
            Some(Value::Array(items)) => items.first(),
            v => v,
        }
    }
    let p = first(body.get("a:p"));
    let r = first(get(p, "a:r"));
    let sz = parse_int(&value_to_string(get(get(r, "a:rPr"), "@_sz")), Radix::Ten);
    (sz > 0.0).then_some(sz / 100.0)
}
