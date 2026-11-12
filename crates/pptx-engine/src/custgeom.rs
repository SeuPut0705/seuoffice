//! `<a:custGeom>` custom geometry (packages/pptx-engine/src/custgeom.ts).
//!
//! The tags are scanned in document order over the raw XML: the object tree
//! of fast-xml-parser loses the order of mixed `moveTo`/`lnTo`/... children.
//! The result is a normalized SVG path, coordinates 0..1 relative to each
//! `<a:path>`'s declared w/h; arcTo becomes cubic beziers; the guides of
//! gdLst/avLst are evaluated first so pt/arcTo can reference them.

use std::f64::consts::PI;
use std::fmt::Write;

use jscompat::{
    JsObject, RegexLimit, js_regex, math_atan2, math_cos, math_max, math_min, math_round,
    math_sign, math_sin, math_tan, number_to_string, to_number, trim, truthy, try_js_regex,
    value_to_string,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `tagAttrs(tag)`: every `name="value"` pair, in order. Single-quoted values
/// are not read.
fn tag_attrs(tag: &str) -> Vec<(&str, &str)> {
    js_regex!(r#"([\w:]+)\s*=\s*"([^"]*)""#)
        .find_iter(tag)
        .filter_map(|found| Some((found.get(1)?, found.get(2)?)))
        .collect()
}

/// `tagAttrs(tag)[name]` for a literal name: a repeated attribute keeps the last value.
fn attr<'t>(attrs: &[(&'t str, &'t str)], name: &str) -> Option<&'t str> {
    attrs
        .iter()
        .rev()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| *value)
}

const DEG: f64 = PI / 180.0;

/// OOXML angle (1/60000 of a degree) to radians.
fn a2r(v: f64) -> f64 {
    (v / 60000.0) * DEG
}

/// `if (x)` on a number.
fn num_truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// One `a:gd` of a guide list.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Guide {
    pub name: String,
    pub fmla: String,
}

/// `val(tok)` of evalGuides and `resolve(tok)` of parseCustGeom: a number, or
/// the guide or built-in of that name (an own key of the table), else 0.
fn val(env: &JsObject<f64>, tok: Option<&str>) -> f64 {
    let Some(tok) = tok else { return 0.0 };
    let n = to_number(tok);
    if n.is_finite() {
        n
    } else {
        env.get(tok).copied().unwrap_or(0.0)
    }
}

/// gd formula evaluation (CT_GeomGuide fmla). Evaluated in order; may
/// reference earlier guides and the built-in variables, angles in 1/60000 of
/// a degree.
pub fn eval_guides(gds: &[Guide], w: f64, h: f64) -> JsObject<f64> {
    let ss = math_min(w, h);
    let mut env = JsObject::new();
    for (key, value) in [
        ("w", w),
        ("h", h),
        ("ss", ss),
        ("ls", math_max(w, h)),
        ("hc", w / 2.0),
        ("vc", h / 2.0),
        ("l", 0.0),
        ("t", 0.0),
        ("r", w),
        ("b", h),
        ("wd2", w / 2.0),
        ("wd3", w / 3.0),
        ("wd4", w / 4.0),
        ("wd5", w / 5.0),
        ("wd6", w / 6.0),
        ("wd8", w / 8.0),
        ("wd10", w / 10.0),
        ("wd12", w / 12.0),
        ("wd32", w / 32.0),
        ("hd2", h / 2.0),
        ("hd3", h / 3.0),
        ("hd4", h / 4.0),
        ("hd5", h / 5.0),
        ("hd6", h / 6.0),
        ("hd8", h / 8.0),
        ("hd10", h / 10.0),
        ("hd12", h / 12.0),
        ("ssd2", ss / 2.0),
        ("ssd4", ss / 4.0),
        ("ssd6", ss / 6.0),
        ("ssd8", ss / 8.0),
        ("ssd16", ss / 16.0),
        ("ssd32", ss / 32.0),
        ("cd2", 10800000.0),
        ("cd4", 5400000.0),
        ("cd8", 2700000.0),
        ("3cd4", 16200000.0),
        ("3cd8", 8100000.0),
        ("5cd8", 13500000.0),
        ("7cd8", 18900000.0),
    ] {
        env.set(key, value);
    }
    for gd in gds {
        let parts = js_regex!(r"\s+").split(trim(&gd.fmla));
        let op = parts.first().copied().unwrap_or("");
        let x = val(&env, parts.get(1).copied());
        let y = val(&env, parts.get(2).copied());
        let z = val(&env, parts.get(3).copied());
        let out = match op {
            "val" => x,
            "*/" => {
                if z == 0.0 {
                    0.0
                } else {
                    (x * y) / z
                }
            }
            "+-" => x + y - z,
            "+/" => {
                if z == 0.0 {
                    0.0
                } else {
                    (x + y) / z
                }
            }
            "?:" => {
                if x > 0.0 {
                    y
                } else {
                    z
                }
            }
            "abs" => x.abs(),
            "min" => math_min(x, y),
            "max" => math_max(x, y),
            "pin" => math_min(math_max(y, x), z),
            "mod" => (x * x + y * y + z * z).sqrt(),
            "sqrt" => math_max(x, 0.0).sqrt(),
            "at2" => (math_atan2(y, x) / DEG) * 60000.0,
            "cat2" => x * math_cos(math_atan2(z, y)),
            "sat2" => x * math_sin(math_atan2(z, y)),
            "cos" => x * math_cos(a2r(y)),
            "sin" => x * math_sin(a2r(y)),
            "tan" => x * math_tan(a2r(y)),
            _ => 0.0,
        };
        // the table has no prototype: a guide named `__proto__` is an entry like any other
        env.set(gd.name.clone(), out);
    }
    env
}

enum RawCmd<'a> {
    /// M/L/Q/C with their pt coordinate tokens (numbers or guide names).
    Pts {
        c: &'static str,
        pts: Vec<(&'a str, &'a str)>,
    },
    /// arcTo attribute tokens.
    Arc {
        w_r: &'a str,
        h_r: &'a str,
        st_ang: &'a str,
        sw_ang: &'a str,
    },
    Close,
}

struct RawPath<'a> {
    w: Option<f64>,
    h: Option<f64>,
    fill: Option<&'a str>,
    stroke: Option<&'a str>,
    cmds: Vec<RawCmd<'a>>,
}

struct Pending<'a> {
    c: &'static str,
    need: usize,
    pts: Vec<(&'a str, &'a str)>,
}

/// `CMD_LETTER[name]` and `CMD_PT_COUNT[name]`.
fn path_command(name: &str) -> Option<(&'static str, usize)> {
    match name {
        "a:moveTo" => Some(("M", 1)),
        "a:lnTo" => Some(("L", 1)),
        "a:quadBezTo" => Some(("Q", 2)),
        "a:cubicBezTo" => Some(("C", 3)),
        _ => None,
    }
}

/// `CustomGeometry` of types.ts; the model port replaces it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomGeometry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_path: Option<String>,
}

/// Extract and parse `<a:custGeom>` from a shape's raw XML.
/// `shape_w`/`shape_h`: element box in EMU (basis for guide evaluation;
/// fallback space when a path declares no w/h).
/// `RegexLimit` where the tag search passed the bound: a tag of millions of
/// characters outside quotes.
pub fn parse_cust_geom(
    shape_xml: &str,
    shape_w: f64,
    shape_h: f64,
) -> Result<Option<CustomGeometry>, RegexLimit> {
    let Some(start) = shape_xml.find("<a:custGeom") else {
        return Ok(None);
    };
    let Some(end) = shape_xml[start..]
        .find("</a:custGeom>")
        .map(|at| start + at)
    else {
        return Ok(None);
    };
    let xml = &shape_xml[start..end];

    let mut gds: Vec<Guide> = Vec::new();
    let mut paths: Vec<RawPath<'_>> = Vec::new();
    let mut in_guides = false;
    let mut cur: Option<RawPath<'_>> = None;
    let mut pending: Option<Pending<'_>> = None;

    for found in try_js_regex!(r#"<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>"#).try_find_iter(xml) {
        let found = found?;
        let tag = found.as_str();
        if tag.starts_with("<!--") || tag.starts_with("<![") || tag.starts_with("<?") {
            continue;
        }
        let closing = tag.starts_with("</");
        let name = js_regex!(r"^<\/?\s*([A-Za-z_][\w:.-]*)")
            .exec(tag)
            .and_then(|m| m.get(1))
            .unwrap_or("");
        if closing {
            if name == "a:avLst" || name == "a:gdLst" {
                in_guides = false;
            } else if name == "a:path"
                && let Some(path) = cur.take()
            {
                paths.push(path);
                pending = None;
            }
            continue;
        }
        let self_closing = tag.ends_with("/>");
        match name {
            "a:avLst" | "a:gdLst" => {
                if !self_closing {
                    in_guides = true;
                }
            }
            "a:gd" => {
                // gd elsewhere (e.g. cxnLst) does not participate
                if !in_guides {
                    continue;
                }
                let a = tag_attrs(tag);
                if let (Some(name), Some(fmla)) =
                    (truthy(attr(&a, "name")), truthy(attr(&a, "fmla")))
                {
                    gds.push(Guide {
                        name: name.to_owned(),
                        fmla: fmla.to_owned(),
                    });
                }
            }
            "a:path" => {
                let a = tag_attrs(tag);
                // `Number(a.w) || 0`: NaN and -0 read as 0
                let extent = |key: &str| {
                    truthy(attr(&a, key)).map(|text| {
                        let n = to_number(text);
                        if num_truthy(n) { n } else { 0.0 }
                    })
                };
                let path = RawPath {
                    w: extent("w"),
                    h: extent("h"),
                    fill: attr(&a, "fill"),
                    stroke: attr(&a, "stroke"),
                    cmds: Vec::new(),
                };
                if self_closing {
                    paths.push(path);
                    cur = None;
                } else {
                    cur = Some(path);
                }
            }
            "a:moveTo" | "a:lnTo" | "a:quadBezTo" | "a:cubicBezTo" => {
                if cur.is_some()
                    && let Some((c, need)) = path_command(name)
                {
                    pending = Some(Pending {
                        c,
                        need,
                        pts: Vec::new(),
                    });
                }
            }
            "a:pt" => {
                let (Some(path), Some(open)) = (cur.as_mut(), pending.as_mut()) else {
                    continue;
                };
                let a = tag_attrs(tag);
                open.pts
                    .push((attr(&a, "x").unwrap_or("0"), attr(&a, "y").unwrap_or("0")));
                if open.pts.len() >= open.need
                    && let Some(Pending { c, pts, .. }) = pending.take()
                {
                    path.cmds.push(RawCmd::Pts { c, pts });
                }
            }
            "a:arcTo" => {
                let Some(path) = cur.as_mut() else { continue };
                let a = tag_attrs(tag);
                path.cmds.push(RawCmd::Arc {
                    w_r: attr(&a, "wR").unwrap_or("0"),
                    h_r: attr(&a, "hR").unwrap_or("0"),
                    st_ang: attr(&a, "stAng").unwrap_or("0"),
                    sw_ang: attr(&a, "swAng").unwrap_or("0"),
                });
            }
            "a:close" => {
                if let Some(path) = cur.as_mut() {
                    path.cmds.push(RawCmd::Close);
                }
            }
            _ => {}
        }
    }

    let env = eval_guides(&gds, shape_w, shape_h);

    let abs_list: Vec<Vec<AbsCmd>> = paths.iter().map(|p| to_abs_cmds(p, &env)).collect();
    // Fallback normalization space when a path declares no w/h and the element
    // box is 0: shared across paths (they live in one guide coordinate space;
    // per-path maxima would skew relative scale)
    let mut fw = 0.0;
    let mut fh = 0.0;
    for (p, abs) in paths.iter().zip(&abs_list) {
        if !num_truthy(p.w.unwrap_or(0.0)) {
            fw = math_max(fw, max_coord(abs, 0));
        }
        if !num_truthy(p.h.unwrap_or(0.0)) {
            fh = math_max(fh, max_coord(abs, 1));
        }
    }

    // Each path normalized independently, emitted in document order within its layer.
    let mut path_bucket: Vec<String> = Vec::new();
    let mut fill_bucket: Vec<String> = Vec::new();
    let mut stroke_bucket: Vec<String> = Vec::new();
    for (p, abs) in paths.iter().zip(&abs_list) {
        if abs.is_empty() {
            continue;
        }
        // `p.w || shapeW || fw || 1`
        let first_truthy =
            |values: [f64; 3]| values.into_iter().find(|v| num_truthy(*v)).unwrap_or(1.0);
        let vw = first_truthy([p.w.unwrap_or(0.0), shape_w, fw]);
        let vh = first_truthy([p.h.unwrap_or(0.0), shape_h, fh]);
        let d = emit_norm(abs, vw, vh);
        if d.is_empty() {
            continue;
        }
        let fill_none = p.fill == Some("none");
        let stroke_none = matches!(p.stroke, Some("0" | "false" | "none"));
        if fill_none && stroke_none {
            continue;
        }
        if fill_none {
            stroke_bucket.push(d);
        } else if stroke_none {
            fill_bucket.push(d);
        } else {
            path_bucket.push(d);
        }
    }

    let joined = |bucket: Vec<String>| (!bucket.is_empty()).then(|| bucket.join(" "));
    let out = CustomGeometry {
        path: joined(path_bucket),
        fill_path: joined(fill_bucket),
        stroke_path: joined(stroke_bucket),
    };
    Ok((out.path.is_some() || out.fill_path.is_some() || out.stroke_path.is_some()).then_some(out))
}

struct AbsCmd {
    c: &'static str,
    xy: Vec<f64>,
}

/// Ray angle to ellipse parametric angle, staying in the same revolution.
/// OOXML arcTo angles point at the ellipse from the center; the parametric
/// form (wR cos t, hR sin t) only matches when wR == hR.
fn param_angle(a: f64, w_r: f64, h_r: f64) -> f64 {
    if w_r == h_r || !num_truthy(w_r) || !num_truthy(h_r) {
        return a;
    }
    let t = math_atan2(math_sin(a) * w_r, math_cos(a) * h_r);
    t + 2.0 * PI * math_round((a - t) / (2.0 * PI))
}

/// Commands to absolute coordinates (path space); arcTo converted to cubics in place.
fn to_abs_cmds(p: &RawPath<'_>, env: &JsObject<f64>) -> Vec<AbsCmd> {
    let resolve = |tok: &str| val(env, Some(tok));
    let mut out = Vec::new();
    let mut cx = 0.0;
    let mut cy = 0.0;
    let mut sx = 0.0;
    let mut sy = 0.0;
    for cmd in &p.cmds {
        match cmd {
            RawCmd::Close => {
                out.push(AbsCmd {
                    c: "Z",
                    xy: Vec::new(),
                });
                // close returns the pen to the subpath start; a following arcTo derives its center from here
                cx = sx;
                cy = sy;
            }
            RawCmd::Arc {
                w_r,
                h_r,
                st_ang,
                sw_ang,
            } => {
                let w_r = resolve(w_r);
                let h_r = resolve(h_r);
                let st_ray = a2r(resolve(st_ang));
                let sw_ray = a2r(resolve(sw_ang));
                if sw_ray == 0.0 {
                    continue;
                }
                let st = param_angle(st_ray, w_r, h_r);
                // Endpoint-converted sweep, restored to swRay's revolution count
                let mut sw = param_angle(st_ray + sw_ray, w_r, h_r) - st;
                sw += 2.0 * PI * math_round((sw_ray - sw) / (2.0 * PI));
                // Repeated full revolutions retrace the same ellipse: keep one
                // loop and the final partial sweep
                let full_turn = 2.0 * PI;
                if sw.abs() > full_turn {
                    sw = math_sign(sw) * (full_turn + (sw.abs() % full_turn));
                }
                // Treat current point as at stAng on the ellipse and derive the center
                let ecx = cx - w_r * math_cos(st);
                let ecy = cy - h_r * math_sin(st);
                // at most 8 segments: |sw| is at most two turns, or NaN (no segment)
                let segs = math_max(1.0, (sw.abs() / (PI / 2.0)).ceil());
                let da = sw / segs;
                let k = (4.0 / 3.0) * math_tan(da / 4.0);
                let mut i = 0.0;
                while i < segs {
                    let a1 = st + i * da;
                    let a2 = a1 + da;
                    let x1 = ecx + w_r * math_cos(a1);
                    let y1 = ecy + h_r * math_sin(a1);
                    let x2 = ecx + w_r * math_cos(a2);
                    let y2 = ecy + h_r * math_sin(a2);
                    out.push(AbsCmd {
                        c: "C",
                        xy: vec![
                            x1 - k * w_r * math_sin(a1),
                            y1 + k * h_r * math_cos(a1),
                            x2 + k * w_r * math_sin(a2),
                            y2 - k * h_r * math_cos(a2),
                            x2,
                            y2,
                        ],
                    });
                    cx = x2;
                    cy = y2;
                    i += 1.0;
                }
            }
            RawCmd::Pts { c, pts } => {
                let xy: Vec<f64> = pts
                    .iter()
                    .flat_map(|&(xs, ys)| [resolve(xs), resolve(ys)])
                    .collect();
                if *c == "M"
                    && let [x, y, ..] = xy[..]
                {
                    sx = x;
                    sy = y;
                }
                if let [.., x, y] = xy[..] {
                    cx = x;
                    cy = y;
                }
                out.push(AbsCmd { c, xy });
            }
        }
    }
    out
}

fn max_coord(cmds: &[AbsCmd], axis: usize) -> f64 {
    let mut mx = 0.0;
    for c in cmds {
        for v in c.xy.iter().skip(axis).step_by(2) {
            mx = math_max(mx, *v);
        }
    }
    mx
}

fn emit_norm(cmds: &[AbsCmd], vw: f64, vh: f64) -> String {
    let r5 = |v: f64| math_round(v * 100000.0) / 100000.0;
    let mut parts: Vec<String> = Vec::new();
    for c in cmds {
        parts.push(c.c.to_owned());
        for pair in c.xy.chunks(2) {
            let x = pair.first().copied().unwrap_or(f64::NAN);
            let y = pair.get(1).copied().unwrap_or(f64::NAN);
            parts.push(number_to_string(r5(x / vw)));
            parts.push(number_to_string(r5(y / vh)));
        }
    }
    parts.join(" ")
}

/// The op of an absolute path command in `<a:path>` space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum CustGeomOp {
    M,
    L,
    C,
    Q,
    Z,
}

/// Absolute path command in `<a:path>` space (EMU when w/h are the element extents).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CustGeomPathCmd {
    pub op: CustGeomOp,
    pub pts: Vec<f64>,
}

/// Editable single-path custom geometry: what Edit Points writes back as `<a:custGeom>`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CustGeomPath {
    pub w: f64,
    pub h: f64,
    pub cmds: Vec<CustGeomPathCmd>,
}

pub const CUST_GEOM_PT_COUNT: [(&str, usize); 5] =
    [("M", 2), ("L", 2), ("C", 6), ("Q", 4), ("Z", 0)];

/// `CUST_GEOM_PT_COUNT[op]` for an own key only. The TypeScript's
/// `c.op in CUST_GEOM_PT_COUNT` also answers for `constructor`, `toString`,
/// `__proto__`...; the length test after it refuses those all the same.
fn pt_count(op: &str) -> Option<usize> {
    CUST_GEOM_PT_COUNT
        .iter()
        .find(|(key, _)| *key == op)
        .map(|(_, count)| *count)
}

/// `validCustGeomPath(p)` over a JSON value, `None` being `undefined`. Errs
/// where the TypeScript throws: a first command that is `null`.
pub fn valid_cust_geom_path(p: Option<&Value>) -> Result<bool, String> {
    // an array has no w, so only an object can pass
    let Some(Value::Object(p)) = p else {
        return Ok(false);
    };
    let finite = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|x| x.is_finite());
    let (Some(w), Some(h)) = (finite(p.get("w")), finite(p.get("h"))) else {
        return Ok(false);
    };
    if w <= 0.0 || h <= 0.0 {
        return Ok(false);
    }
    let Some(Value::Array(cmds)) = p.get("cmds") else {
        return Ok(false);
    };
    let Some(first) = cmds.first() else {
        return Ok(false);
    };
    if first.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'op')".to_owned());
    }
    let op_of = |c: &Value| c.as_object().and_then(|c| c.get("op")).cloned();
    if op_of(first).as_ref().and_then(Value::as_str) != Some("M") {
        return Ok(false);
    }
    Ok(cmds.iter().all(|c| {
        // an array command has no op, which reads as the key "undefined"
        let Some(c) = c.as_object() else {
            return false;
        };
        let Some(count) = pt_count(&value_to_string(c.get("op"))) else {
            return false;
        };
        let Some(Value::Array(pts)) = c.get("pts") else {
            return false;
        };
        pts.len() == count && pts.iter().all(|v| v.as_f64().is_some_and(f64::is_finite))
    }))
}

/// Serialize a path as a complete `<a:custGeom>` (integer coordinates, path w/h as the space).
pub fn cust_geom_xml(p: &CustGeomPath) -> String {
    let mut body = String::new();
    for c in &p.cmds {
        let tag = match c.op {
            CustGeomOp::Z => {
                body.push_str("<a:close/>");
                continue;
            }
            CustGeomOp::M => "a:moveTo",
            CustGeomOp::L => "a:lnTo",
            CustGeomOp::C => "a:cubicBezTo",
            CustGeomOp::Q => "a:quadBezTo",
        };
        let _ = write!(body, "<{tag}>");
        for pair in c.pts.chunks(2) {
            let x = pair.first().copied().unwrap_or(f64::NAN);
            let y = pair.get(1).copied().unwrap_or(f64::NAN);
            let _ = write!(
                body,
                r#"<a:pt x="{}" y="{}"/>"#,
                number_to_string(math_round(x)),
                number_to_string(math_round(y)),
            );
        }
        let _ = write!(body, "</{tag}>");
    }
    format!(
        r#"<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="{}" h="{}">{body}</a:path></a:pathLst></a:custGeom>"#,
        number_to_string(math_round(p.w)),
        number_to_string(math_round(p.h)),
    )
}
