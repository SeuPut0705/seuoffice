//! Port of packages/pptx-engine/src/index.ts lines 2408-2554: connector
//! move-following (`connectionSiteForSide`, `updateConnectorsForMoved`,
//! `setElementConnection`).

use std::collections::{HashMap, HashSet};

use jscompat::{
    JsNum, js_regex, math_cos, math_min, math_round, math_sin, number_to_string,
    replace_first_string, replace_first_with, to_number,
};
use serde::{Deserialize, Serialize};

use crate::deck::patched_element_xml;
use crate::types::{Connection, ConnectionEnd, ElementType, Slide, SlideElement, Transform};
use crate::with_element;

/// `ConnectionSide`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionSide {
    Top,
    Left,
    Bottom,
    Right,
}

/// `{ top, left, bottom, right }` of a site table.
struct Sides {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

// presetShapeDefinitions cxnLst order: most presets list the four edge
// midpoints as top/left/bottom/right; the ellipse interleaves four diagonal
// sites, so its edge midpoints sit at even indexes
const ELLIPSE_SIDES: Sides = Sides {
    top: 0.0,
    left: 2.0,
    bottom: 4.0,
    right: 6.0,
};
const RECT_SIDES: Sides = Sides {
    top: 0.0,
    left: 1.0,
    bottom: 2.0,
    right: 3.0,
};

/// `el.type === 'shape' || el.type === 'picture' ? el.presetGeometry : undefined`
fn preset_of(el: &SlideElement) -> Option<&str> {
    match el {
        SlideElement::Text(e) if *e.r#type == Some(ElementType::Shape) => {
            e.preset_geometry.as_deref()
        }
        SlideElement::Picture(e) => e.preset_geometry.as_deref(),
        _ => None,
    }
}

/// `el.transform`
fn transform_of(el: &SlideElement) -> Option<Transform> {
    with_element!(el, e => *e.transform)
}

/// `el.connection`
fn connection_of(el: &SlideElement) -> Option<Connection> {
    with_element!(el, e => *e.connection)
}

/// Connection-site index of a shape edge midpoint for the element's preset geometry.
pub fn connection_site_for_side(el: &SlideElement, side: ConnectionSide) -> f64 {
    let sides = if preset_of(el) == Some("ellipse") {
        &ELLIPSE_SIDES
    } else {
        &RECT_SIDES
    };
    match side {
        ConnectionSide::Top => sides.top,
        ConnectionSide::Left => sides.left,
        ConnectionSide::Bottom => sides.bottom,
        ConnectionSide::Right => sides.right,
    }
}

/// Connection site index → unit-box point (edge sites of the preset geometry, else center).
fn connection_site_local(el: &SlideElement, idx: f64) -> (f64, f64) {
    let prst = preset_of(el);
    let sides = if prst == Some("ellipse") {
        &ELLIPSE_SIDES
    } else {
        &RECT_SIDES
    };
    if idx == sides.top {
        return (0.5, 0.0);
    }
    if idx == sides.left {
        return (0.0, 0.5);
    }
    if idx == sides.bottom {
        return (0.5, 1.0);
    }
    if idx == sides.right {
        return (1.0, 0.5);
    }
    if prst == Some("ellipse") && (1.0..=7.0).contains(&idx) {
        // odd ellipse sites are the 45-degree points: inset (1 - 1/sqrt2)/2 of each extent
        let k = 0.1464;
        let left = idx == 1.0 || idx == 3.0;
        let top = idx == 1.0 || idx == 7.0;
        return (
            if left { k } else { 1.0 - k },
            if top { k } else { 1.0 - k },
        );
    }
    (0.5, 0.5)
}

/// Connection point in slide space: site mirrored by the shape flips, then rotated about the box centre.
fn connection_point(el: &SlideElement, idx: f64) -> Option<(f64, f64)> {
    let t = transform_of(el)?;
    let o = t.offset;
    let (u, v) = connection_site_local(el, idx);
    let dx = ((if t.flip_h { 1.0 - u } else { u }) - 0.5) * o.cx.0;
    let dy = ((if t.flip_v { 1.0 - v } else { v }) - 0.5) * o.cy.0;
    let cxx = o.x.0 + o.cx.0 / 2.0;
    let cyy = o.y.0 + o.cy.0 / 2.0;
    let rad = (t.rot.0 / 60000.0) * (std::f64::consts::PI / 180.0);
    if rad == 0.0 {
        return Some((cxx + dx, cyy + dy));
    }
    let cos = math_cos(rad);
    let sin = math_sin(rad);
    Some((cxx + dx * cos - dy * sin, cyy + dx * sin + dy * cos))
}

/// `elementSpid`: the element's own `<p:cNvPr id>` (the first one; group children follow).
fn element_spid(el: &SlideElement) -> Option<f64> {
    with_element!(el, e => {
        js_regex!(r#"<p:cNvPr\s[^>]*\bid=["'](\d+)["']"#)
            .exec(e.anchor.as_ref().map_or("", |a| &*a.original_xml))
            .map(|m| to_number(m.get(1).unwrap_or_default()))
    })
}

/// A number as a `Set`/`Map` key (SameValueZero: every NaN is one key).
fn key_of(n: f64) -> u64 {
    if n.is_nan() {
        f64::NAN.to_bits()
    } else if n == 0.0 {
        0.0f64.to_bits()
    } else {
        n.to_bits()
    }
}

/// Re-lay connectors after connected shapes move: the geometry box = the
/// bounding box of the two endpoints, direction expressed via flip. An
/// unattached end keeps its current endpoint. Returns the number of
/// connectors updated (>0 means each is flagged dirtyTransform).
pub fn update_connectors_for_moved(slide: &mut Slide, moved_ids: &[String]) -> f64 {
    let Some(elements) = slide.elements.as_mut() else {
        return 0.0;
    };
    let mut moved_spids: HashSet<u64> = HashSet::new();
    for id in moved_ids {
        let spid = elements
            .iter()
            .find(|e| e.id() == id)
            .and_then(element_spid);
        if let Some(spid) = spid {
            moved_spids.insert(key_of(spid));
        }
    }
    if moved_spids.is_empty() {
        return 0.0;
    }
    // Map.set: the last element of a spid wins; positions stand for the shared references
    let mut by_spid: HashMap<u64, usize> = HashMap::new();
    for (at, e) in elements.iter().enumerate() {
        if let Some(spid) = element_spid(e) {
            by_spid.insert(key_of(spid), at);
        }
    }
    let mut n = 0.0;
    for at in 0..elements.len() {
        let Some(el) = elements.get(at) else {
            continue;
        };
        let Some(cxn) = connection_of(el) else {
            continue;
        };
        let touches = |end: &Option<ConnectionEnd>| {
            end.as_ref()
                .is_some_and(|end| moved_spids.contains(&key_of(end.id.0)))
        };
        if !(touches(&cxn.start) || touches(&cxn.end)) {
            continue;
        }
        let Some(t) = transform_of(el) else {
            continue;
        };
        let o = t.offset;
        let cur_start = (
            if t.flip_h { o.x.0 + o.cx.0 } else { o.x.0 },
            if t.flip_v { o.y.0 + o.cy.0 } else { o.y.0 },
        );
        let cur_end = (
            if t.flip_h { o.x.0 } else { o.x.0 + o.cx.0 },
            if t.flip_v { o.y.0 } else { o.y.0 + o.cy.0 },
        );
        // a target read as it is now: an earlier connector of this loop may be one
        let point_of = |end: &Option<ConnectionEnd>, current: (f64, f64)| match end {
            Some(end) => match by_spid
                .get(&key_of(end.id.0))
                .and_then(|&i| elements.get(i))
            {
                Some(target) => connection_point(target, end.idx.0).unwrap_or(current),
                None => current,
            },
            None => current,
        };
        let p1 = point_of(&cxn.start, cur_start);
        let p2 = point_of(&cxn.end, cur_end);
        let Some(el) = elements.get_mut(at) else {
            continue;
        };
        with_element!(el, e => {
            if let Some(t) = e.transform.as_mut() {
                t.offset = crate::types::EmuRect {
                    x: JsNum(math_round(math_min(p1.0, p2.0))),
                    y: JsNum(math_round(math_min(p1.1, p2.1))),
                    cx: JsNum(math_round((p2.0 - p1.0).abs())),
                    cy: JsNum(math_round((p2.1 - p1.1).abs())),
                };
                t.flip_h = p1.0 > p2.0;
                t.flip_v = p1.1 > p2.1;
            }
            e.dirty_transform.set(true);
        });
        n += 1.0;
    }
    n
}

/// The patch of [`set_element_connection`]: per end, `None` leaves it
/// unchanged (`undefined`), `Some(None)` detaches it (`null`), `Some(Some(end))` attaches it.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ConnectionPatch {
    pub start: Option<Option<ConnectionEnd>>,
    pub end: Option<Option<ConnectionEnd>>,
}

/// `<a:stCxn id idx/>` / `<a:endCxn id idx/>`
fn cxn_tag(which: &str, v: &ConnectionEnd) -> String {
    format!(
        "<a:{which}Cxn id=\"{}\" idx=\"{}\"/>",
        number_to_string(v.id.0),
        number_to_string(v.idx.0)
    )
}

/// Write/clear a connector's shape attachments (`<a:stCxn>`/`<a:endCxn>` in
/// `p:cNvCxnSpPr`). Byte surgery baked directly into originalXml (pending
/// patches are materialized first).
pub fn set_element_connection(
    slide: &mut Slide,
    element_id: &str,
    patch: &ConnectionPatch,
) -> bool {
    let Some(elements) = slide.elements.as_mut() else {
        return false;
    };
    let Some(el) = elements.iter_mut().find(|e| e.id() == element_id) else {
        return false;
    };
    let mut xml = patched_element_xml(el);
    // Normalize self-closing <p:cNvCxnSpPr/> so children can be inserted
    xml = replace_first_with(js_regex!(r"<p:cNvCxnSpPr([^>]*)\/>"), &xml, |m| {
        format!(
            "<p:cNvCxnSpPr{}></p:cNvCxnSpPr>",
            m.get(1).unwrap_or_default()
        )
    });
    let Some(m) = js_regex!(r"<p:cNvCxnSpPr([^>]*)>([\s\S]*?)<\/p:cNvCxnSpPr>").exec(&xml) else {
        return false;
    };
    let attrs = m.get(1).unwrap_or_default();
    let inner = m.get(2).unwrap_or_default();
    let cur_st = js_regex!(r"<a:stCxn\b[^>]*\/>")
        .exec(inner)
        .map_or("", |f| f.as_str());
    let cur_end = js_regex!(r"<a:endCxn\b[^>]*\/>")
        .exec(inner)
        .map_or("", |f| f.as_str());
    let mut rest = js_regex!(r"<a:stCxn\b[^>]*\/>|<a:endCxn\b[^>]*\/>", "g")
        .replace_all(inner, |_| String::new());
    // Schema order: cxnSpLocks? stCxn? endCxn? extLst?
    let mut locks = String::new();
    let lock_m = js_regex!(r"<a:cxnSpLocks\b[^>]*(?:\/>|>[\s\S]*?<\/a:cxnSpLocks>)")
        .exec(&rest)
        .map(|f| f.as_str().to_owned());
    if let Some(lock) = lock_m {
        rest = replace_first_string(&rest, &lock, "");
        locks = lock;
    }
    let st_tag = match &patch.start {
        None => cur_st.to_owned(),
        Some(Some(v)) => cxn_tag("st", v),
        Some(None) => String::new(),
    };
    let end_tag = match &patch.end {
        None => cur_end.to_owned(),
        Some(Some(v)) => cxn_tag("end", v),
        Some(None) => String::new(),
    };
    xml = format!(
        "{}<p:cNvCxnSpPr{attrs}>{locks}{st_tag}{end_tag}{rest}</p:cNvCxnSpPr>{}",
        xml.get(..m.start()).unwrap_or_default(),
        xml.get(m.end()..).unwrap_or_default()
    );
    let previous = connection_of(el);
    let start = match &patch.start {
        None => previous.and_then(|c| c.start),
        Some(v) => *v,
    };
    let end = match &patch.end {
        None => previous.and_then(|c| c.end),
        Some(v) => *v,
    };
    with_element!(el, e => {
        e.dirty_stroke.set(false);
        e.dirty_fill.set(false);
        e.dirty_transform.set(false);
        e.dirty.set(false);
        e.dirty_p_pr.assign(None);
        if let Some(anchor) = e.anchor.as_mut() {
            anchor.original_xml = xml.into();
        }
        e.connection.assign(if start.is_some() || end.is_some() {
            Some(Connection { start, end })
        } else {
            None
        });
    });
    slide.structure_dirty.set(true);
    true
}
