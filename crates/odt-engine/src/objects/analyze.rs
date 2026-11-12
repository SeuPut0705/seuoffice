//! `objects/analyze.ts`: reads a drawing element of the ODF body
//! (`draw:frame`, shapes, groups ...) from its source range: what it is (an
//! editable picture, an object the editor cannot change, or something another
//! owner takes), its size and placement, the picture that can stand for it,
//! and the package entries it references.
//!
//! Offsets here are UTF-8 byte offsets of the part string, as everywhere
//! inside the engine; the records of `model.rs` hold them as `U16`.

use jscompat::{
    JsObject, Radix, decode_uri_component, js_regex, math_max, math_round, parse_int, trim,
};

use crate::core::open::OdtDocument;
use crate::core::styles::OdtStylePart;
use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementVisitor, OpenVerdict, PrefixMap, XmlTokenKind,
    attribute_map, decode_xml_entities, walk_elements,
};

use super::geometry::{AnchorAxis, AnchorWrap, DrawingAnchor, EMU_PER_CM, length_to_emu};
use super::media::{ImageFormat, sniff_image};
use super::model::ObjectKind;
use jscompat::JsNum;

/// `SubElement`: one element inside the analysed subtree.
#[derive(Debug, Clone, PartialEq)]
pub struct SubElement {
    pub name: String,
    pub start: usize,
    pub name_end: usize,
    pub open_end: usize,
    pub close_start: usize,
    pub end: usize,
    pub self_closing: bool,
    /// 0 is a direct child of the analysed element
    pub depth: usize,
    pub attrs: JsObject<String>,
}

/// `subElements`: every element strictly inside `[from, to)`, in document
/// order.
pub fn sub_elements(xml: &str, prefixes: &PrefixMap, from: usize, to: usize) -> Vec<SubElement> {
    struct Collect<'a> {
        xml: &'a str,
        prefixes: &'a PrefixMap,
        to: usize,
        out: Vec<SubElement>,
        depth: usize,
    }
    impl ElementVisitor for Collect<'_> {
        /// the index of the element in `out`
        type Data = usize;

        fn open(
            &mut self,
            el: &mut ElementFrame<usize>,
            _parent: Option<&ElementFrame<usize>>,
        ) -> OpenVerdict {
            let sub = SubElement {
                name: el.name.clone(),
                start: el.start,
                name_end: el.name_end,
                open_end: el.open_end,
                close_start: el.open_end,
                end: el.open_end,
                self_closing: el.self_closing,
                depth: self.depth,
                attrs: attribute_map(self.xml, el.name_end, el.open_end, self.prefixes),
            };
            el.data = Some(self.out.len());
            self.out.push(sub);
            self.depth += 1;
            OpenVerdict::Continue
        }

        fn close(
            &mut self,
            el: &mut ElementFrame<usize>,
            _parent: Option<&ElementFrame<usize>>,
        ) -> CloseVerdict {
            self.depth = self.depth.saturating_sub(1);
            if let Some(at) = el.data {
                let sub = &mut self.out[at];
                sub.close_start = el.close_start.unwrap_or(el.open_end);
                sub.end = el.end.unwrap_or(self.to);
            }
            CloseVerdict::Continue
        }
    }
    let mut collect = Collect {
        xml,
        prefixes,
        to,
        out: Vec::new(),
        depth: 0,
    };
    walk_elements(xml, prefixes, &mut collect, from, to);
    collect.out
}

/// `plainTextOf`: plain text content of a range (entities decoded, tags
/// dropped).
pub fn plain_text_of(xml: &str, prefixes: &PrefixMap, from: usize, to: usize) -> String {
    struct Text<'a> {
        xml: &'a str,
        out: String,
    }
    impl ElementVisitor for Text<'_> {
        type Data = ();

        fn open(
            &mut self,
            _el: &mut ElementFrame<()>,
            _parent: Option<&ElementFrame<()>>,
        ) -> OpenVerdict {
            OpenVerdict::Continue
        }

        fn other(
            &mut self,
            kind: XmlTokenKind,
            start: usize,
            end: usize,
            _parent: Option<&ElementFrame<()>>,
        ) {
            if kind == XmlTokenKind::Text {
                self.out
                    .push_str(&decode_xml_entities(&self.xml[start..end]));
            }
        }
    }
    let mut text = Text {
        xml,
        out: String::new(),
    };
    walk_elements(xml, prefixes, &mut text, from, to);
    text.out
}

/// `DRAW_OBJECT_NAMES`: names of the drawing elements that are objects in a
/// paragraph.
pub const DRAW_OBJECT_NAMES: [&str; 18] = [
    "draw:frame",
    "draw:a",
    "draw:rect",
    "draw:line",
    "draw:polyline",
    "draw:polygon",
    "draw:regular-polygon",
    "draw:path",
    "draw:circle",
    "draw:ellipse",
    "draw:g",
    "draw:page-thumbnail",
    "draw:connector",
    "draw:caption",
    "draw:measure",
    "draw:control",
    "draw:custom-shape",
    "dr3d:scene",
];

/// `ENTRY_HREF_ELEMENTS`: elements whose `xlink:href` names a package entry
/// (hyperlinks excluded).
const ENTRY_HREF_ELEMENTS: [&str; 7] = [
    "draw:image",
    "draw:object",
    "draw:object-ole",
    "draw:plugin",
    "draw:applet",
    "draw:floating-frame",
    "draw:fill-image",
];

/// `hrefPath`: a package path from an `xlink:href`, or `None` for external
/// links.
pub fn href_path(href: &str) -> Option<String> {
    let mut h = trim(href);
    if h.is_empty() || h.starts_with('#') || h.starts_with('/') {
        return None;
    }
    if js_regex!(r"^[A-Za-z][A-Za-z0-9+.-]*:").test(h) {
        return None;
    }
    while let Some(rest) = h.strip_prefix("./") {
        h = rest;
    }
    Some(h.to_string())
}

/// `[...].sort()`: the default sort of JavaScript compares UTF-16 code units.
pub fn js_sort(values: &mut [String]) {
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `entriesOf`: the package entries an href names: a file, or every entry of
/// a directory (sorted).
pub fn entries_of(doc: &OdtDocument, href: &str) -> Vec<String> {
    let Some(raw) = href_path(href) else {
        return Vec::new();
    };
    let mut candidates = vec![raw.clone()];
    if let Ok(decoded) = decode_uri_component(&raw) {
        if decoded != raw {
            candidates.push(decoded);
        }
    }
    for path in candidates {
        if let Some(file) = doc.pkg.get(&path) {
            if !file.directory {
                return vec![path];
            }
        }
        let dir = if path.ends_with('/') {
            path.clone()
        } else {
            format!("{path}/")
        };
        let mut inside: Vec<String> = Vec::new();
        for e in doc.pkg.entries.iter() {
            if e.name.starts_with(&dir) && !inside.contains(&e.name) {
                inside.push(e.name.clone());
            }
        }
        if !inside.is_empty() {
            js_sort(&mut inside);
            return inside;
        }
    }
    Vec::new()
}

/// `ObjectAnchorFacts`
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectAnchorFacts {
    /// `text:anchor-type` (`None` when absent)
    pub r#type: Option<String>,
    /// position relative to the anchor
    pub x_emu: Option<f64>,
    pub y_emu: Option<f64>,
    pub z: f64,
    pub style_name: Option<String>,
}

/// `ObjectAnalysis.type`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisType {
    /// not ours (a text box holding a table belongs to the table owner)
    Skip,
    Picture,
    Placeholder,
}

/// `ObjectAnalysis.image`: the `draw:image` and its bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisImage {
    pub href: String,
    pub entry: String,
    pub start: usize,
    pub open_end: usize,
    pub bytes: Vec<u8>,
    pub format: ImageFormat,
}

/// `ObjectAnalysis.preview`: a picture stored in the file that shows the
/// object.
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisPreview {
    pub bytes: Vec<u8>,
    pub format: ImageFormat,
}

/// `ObjectAnalysis`
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectAnalysis {
    pub r#type: AnalysisType,
    pub kind: ObjectKind,
    pub width_emu: f64,
    pub height_emu: f64,
    pub anchor: ObjectAnchorFacts,
    /// package entries referenced anywhere inside
    pub entries: Vec<String>,
    pub image: Option<AnalysisImage>,
    pub preview: Option<AnalysisPreview>,
}

const DEFAULT_W: f64 = 2.0 * EMU_PER_CM;
const DEFAULT_H: f64 = EMU_PER_CM;
const MIN_SIZE: f64 = EMU_PER_CM / 10.0;

/// `Box`
#[derive(Debug, Clone, Copy)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn attr<'a>(attrs: &'a JsObject<String>, name: &str) -> Option<&'a str> {
    attrs.get(name).map(String::as_str)
}

/// `boxOf`
fn box_of(attrs: &JsObject<String>) -> Option<Bounds> {
    if attr(attrs, "svg:x1").is_some() || attr(attrs, "svg:x2").is_some() {
        let x1 = length_to_emu(attr(attrs, "svg:x1")).unwrap_or(0.0);
        let x2 = length_to_emu(attr(attrs, "svg:x2")).unwrap_or(0.0);
        let y1 = length_to_emu(attr(attrs, "svg:y1")).unwrap_or(0.0);
        let y2 = length_to_emu(attr(attrs, "svg:y2")).unwrap_or(0.0);
        return Some(Bounds {
            x: jscompat::math_min(x1, x2),
            y: jscompat::math_min(y1, y2),
            w: (x2 - x1).abs(),
            h: (y2 - y1).abs(),
        });
    }
    let w = length_to_emu(attr(attrs, "svg:width"));
    let h = length_to_emu(attr(attrs, "svg:height"));
    let (Some(w), Some(h)) = (w, h) else {
        return None;
    };
    Some(Bounds {
        x: length_to_emu(attr(attrs, "svg:x")).unwrap_or(0.0),
        y: length_to_emu(attr(attrs, "svg:y")).unwrap_or(0.0),
        w,
        h,
    })
}

/// `Math.min(...values)` of a non-empty list
fn min_of(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(f64::INFINITY, jscompat::math_min)
}

/// `Math.max(...values)` of a non-empty list
fn max_of(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(f64::NEG_INFINITY, math_max)
}

/// `union`
fn union(boxes: &[Bounds]) -> Option<Bounds> {
    if boxes.is_empty() {
        return None;
    }
    let x = min_of(boxes.iter().map(|b| b.x));
    let y = min_of(boxes.iter().map(|b| b.y));
    let r = max_of(boxes.iter().map(|b| b.x + b.w));
    let btm = max_of(boxes.iter().map(|b| b.y + b.h));
    Some(Bounds {
        x,
        y,
        w: r - x,
        h: btm - y,
    })
}

/// `graphicProps`: own graphic-properties of a drawing's style (resolved
/// through its parents).
pub fn graphic_props(
    doc: &OdtDocument,
    part: OdtStylePart,
    style_name: Option<&str>,
) -> JsObject<String> {
    let Some(style_name) = jscompat::truthy(style_name) else {
        return JsObject::new();
    };
    doc.styles
        .resolve(style_name, "graphic", part.scope())
        .and_then(|resolved| resolved.properties.get("style:graphic-properties").cloned())
        .unwrap_or_default()
}

/// `embeddedKind`: the kind of an embedded object (`draw:object`) by its
/// package media type or content.
fn embedded_kind(doc: &OdtDocument, href: &str) -> ObjectKind {
    let Some(path) = href_path(href) else {
        return ObjectKind::Object;
    };
    let dir = if path.ends_with('/') {
        path.clone()
    } else {
        format!("{path}/")
    };
    let media = doc
        .manifest
        .entries
        .iter()
        .find(|e| e.full_path == dir || e.full_path == path)
        .and_then(|e| e.media_type.as_deref())
        .unwrap_or("");
    if media.contains("formula") {
        return ObjectKind::Equation;
    }
    if media.contains("chart") {
        return ObjectKind::Chart;
    }
    let content = doc
        .pkg
        .text(&format!("{dir}content.xml"))
        .unwrap_or_default();
    if js_regex!(r"<(?:[\w-]+:)?math[\s>]").test(&content) {
        return ObjectKind::Equation;
    }
    if js_regex!(r"<[\w-]+:chart[\s>]").test(&content) {
        return ObjectKind::Chart;
    }
    ObjectKind::Object
}

/// `DIRECT_FORMATS`: formats the docx engine shows without converting them
/// (metafiles need a canvas).
const DIRECT_FORMATS: [&str; 5] = ["png", "jpeg", "gif", "bmp", "svg"];

/// The result of `displayable`.
struct Displayable {
    entry: String,
    bytes: Vec<u8>,
    format: ImageFormat,
}

/// `displayable`: picture bytes for an href when the bridge docx can show
/// them. A preview standing for a locked object must be shown as it is
/// (`direct`).
fn displayable(doc: &OdtDocument, href: &str, direct: bool) -> Option<Displayable> {
    let entries = entries_of(doc, href);
    if entries.len() != 1 {
        return None;
    }
    let entry = doc.pkg.get(&entries[0])?;
    if entry.directory {
        return None;
    }
    let format = sniff_image(&entry.bytes)?;
    if direct && !DIRECT_FORMATS.contains(&format.ext.as_str()) {
        return None;
    }
    Some(Displayable {
        entry: entry.name.clone(),
        bytes: entry.bytes.clone(),
        format,
    })
}

/// The element `analyzeObject` is given (`{ name, start, nameEnd, openEnd,
/// closeStart }`).
#[derive(Debug, Clone, Copy)]
pub struct ObjectElement<'a> {
    pub name: &'a str,
    pub start: usize,
    pub name_end: usize,
    pub open_end: usize,
    pub close_start: usize,
}

/// `analyzeObject`: analyses the drawing element `el` (its source range in
/// `xml`). `el.name` is its canonical element name.
pub fn analyze_object(
    doc: &OdtDocument,
    part: OdtStylePart,
    xml: &str,
    prefixes: &PrefixMap,
    el: &ObjectElement<'_>,
) -> ObjectAnalysis {
    let attrs = attribute_map(xml, el.name_end, el.open_end, prefixes);
    let subs = if el.open_end < el.close_start {
        sub_elements(xml, prefixes, el.open_end, el.close_start)
    } else {
        Vec::new()
    };
    let children: Vec<&SubElement> = subs.iter().filter(|s| s.depth == 0).collect();
    let mut entries: Vec<String> = Vec::new();
    for s in &subs {
        if let Some(href) = attr(&s.attrs, "xlink:href") {
            if ENTRY_HREF_ELEMENTS.contains(&s.name.as_str()) {
                for e in entries_of(doc, href) {
                    if !entries.contains(&e) {
                        entries.push(e);
                    }
                }
            }
        }
    }
    let style_name = attr(&attrs, "draw:style-name").map(str::to_string);
    let props = graphic_props(doc, part, style_name.as_deref());

    // size: own box, else min sizes, else the union of the parts
    let mut bounds = box_of(&attrs);
    if bounds.is_none() {
        let text_box = children.iter().find(|c| c.name == "draw:text-box");
        let w = length_to_emu(attr(&attrs, "svg:width"))
            .or_else(|| length_to_emu(text_box.and_then(|t| attr(&t.attrs, "fo:min-width"))))
            .or_else(|| length_to_emu(attr(&props, "fo:min-width")));
        let h = length_to_emu(attr(&attrs, "svg:height"))
            .or_else(|| length_to_emu(text_box.and_then(|t| attr(&t.attrs, "fo:min-height"))))
            .or_else(|| length_to_emu(attr(&props, "fo:min-height")));
        if w.is_some() || h.is_some() {
            bounds = Some(Bounds {
                x: length_to_emu(attr(&attrs, "svg:x")).unwrap_or(0.0),
                y: length_to_emu(attr(&attrs, "svg:y")).unwrap_or(0.0),
                w: w.unwrap_or(DEFAULT_W),
                h: h.unwrap_or(DEFAULT_H),
            });
        }
    }
    if bounds.is_none() {
        let parts: Vec<Bounds> = subs
            .iter()
            .filter(|s| js_regex!(r"^(draw|dr3d):").test(&s.name))
            .filter_map(|s| box_of(&s.attrs))
            .collect();
        bounds = union(&parts);
    }
    let size_w = math_max(MIN_SIZE, bounds.map_or(DEFAULT_W, |b| b.w));
    let size_h = math_max(MIN_SIZE, bounds.map_or(DEFAULT_H, |b| b.h));
    let z = parse_int(attr(&attrs, "draw:z-index").unwrap_or("0"), Radix::Ten);
    let anchor = ObjectAnchorFacts {
        r#type: attr(&attrs, "text:anchor-type").map(str::to_string),
        x_emu: length_to_emu(attr(&attrs, "svg:x")).or(bounds.map(|b| b.x)),
        y_emu: length_to_emu(attr(&attrs, "svg:y")).or(bounds.map(|b| b.y)),
        z: if z.is_finite() { z } else { 0.0 },
        style_name,
    };
    js_sort(&mut entries);
    let result = ObjectAnalysis {
        r#type: AnalysisType::Placeholder,
        kind: ObjectKind::Object,
        width_emu: size_w,
        height_emu: size_h,
        anchor,
        entries,
        image: None,
        preview: None,
    };

    if el.name == "draw:frame" {
        let text_box = children.iter().find(|c| c.name == "draw:text-box");
        let object = children
            .iter()
            .find(|c| c.name == "draw:object" || c.name == "draw:object-ole");
        let image = children.iter().find(|c| c.name == "draw:image");
        if let Some(text_box) = text_box {
            let has_table = subs.iter().any(|s| {
                s.name == "table:table" && s.start >= text_box.start && s.end <= text_box.end
            });
            if has_table {
                return ObjectAnalysis {
                    r#type: AnalysisType::Skip,
                    ..result
                };
            }
            return ObjectAnalysis {
                kind: ObjectKind::Textbox,
                ..result
            };
        }
        if let Some(object) = object {
            let kind = if object.name == "draw:object" {
                embedded_kind(doc, attr(&object.attrs, "xlink:href").unwrap_or(""))
            } else {
                ObjectKind::Object
            };
            let shown = image
                .and_then(|i| displayable(doc, attr(&i.attrs, "xlink:href").unwrap_or(""), true));
            return ObjectAnalysis {
                kind,
                preview: shown.map(|s| AnalysisPreview {
                    bytes: s.bytes,
                    format: s.format,
                }),
                ..result
            };
        }
        if let Some(image) = image {
            let href = attr(&image.attrs, "xlink:href").unwrap_or("");
            if let Some(shown) = displayable(doc, href, false) {
                return ObjectAnalysis {
                    r#type: AnalysisType::Picture,
                    image: Some(AnalysisImage {
                        href: href.to_string(),
                        entry: shown.entry,
                        start: image.start,
                        open_end: image.open_end,
                        bytes: shown.bytes,
                        format: shown.format,
                    }),
                    ..result
                };
            }
            return result;
        }
        return result;
    }

    // shapes and groups: a picture covering (nearly) the whole object stands for it
    let kind = if el.name == "draw:a" || el.name == "draw:control" {
        ObjectKind::Object
    } else {
        ObjectKind::Shape
    };
    let area = size_w * size_h;
    let mut best: Option<(AnalysisPreview, f64)> = None;
    for s in &subs {
        if s.name != "draw:frame" {
            continue;
        }
        let img = subs.iter().find(|c| {
            c.name == "draw:image" && c.depth == s.depth + 1 && c.start > s.start && c.end <= s.end
        });
        let b = box_of(&s.attrs);
        let (Some(img), Some(b)) = (img, b) else {
            continue;
        };
        let shown = displayable(doc, attr(&img.attrs, "xlink:href").unwrap_or(""), true);
        let a = b.w * b.h;
        if let Some(shown) = shown {
            if a >= area * 0.9 && best.as_ref().is_none_or(|(_, best_area)| a > *best_area) {
                best = Some((
                    AnalysisPreview {
                        bytes: shown.bytes,
                        format: shown.format,
                    },
                    a,
                ));
            }
        }
    }
    ObjectAnalysis {
        kind,
        preview: best.map(|(preview, _)| preview),
        ..result
    }
}

/// An own-key table lookup: `table[key]` of a plain object literal, which in
/// JavaScript also answers for `constructor`, `toString` and the rest of the
/// prototype (a TypeScript defect, ported as an own-key lookup).
fn own(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// `anchorOf`: OOXML placement of a floating object, or `None` for an
/// as-character (inline) one.
pub fn anchor_of(
    doc: &OdtDocument,
    part: OdtStylePart,
    facts: &ObjectAnchorFacts,
) -> Option<DrawingAnchor> {
    let r#type = facts.r#type.as_deref().unwrap_or("paragraph");
    if r#type == "as-char" {
        return None;
    }
    let props = graphic_props(doc, part, facts.style_name.as_deref());
    let page = r#type == "page";
    const H_REL: [(&str, &str); 5] = [
        ("page", "page"),
        ("page-content", "margin"),
        ("page-start-margin", "leftMargin"),
        ("page-end-margin", "rightMargin"),
        ("char", "character"),
    ];
    const V_REL: [(&str, &str); 6] = [
        ("page", "page"),
        ("page-content", "margin"),
        ("line", "line"),
        ("char", "line"),
        ("text", "line"),
        ("baseline", "line"),
    ];
    let h_pos = attr(&props, "style:horizontal-pos").unwrap_or("from-left");
    let v_pos = attr(&props, "style:vertical-pos").unwrap_or("from-top");
    const H_ALIGN: [(&str, &str); 5] = [
        ("left", "left"),
        ("center", "center"),
        ("right", "right"),
        ("inside", "inside"),
        ("outside", "outside"),
    ];
    const V_ALIGN: [(&str, &str); 3] = [("top", "top"), ("middle", "center"), ("bottom", "bottom")];
    let wrap_prop = attr(&props, "style:wrap").unwrap_or("none");
    let h_align = own(&H_ALIGN, h_pos);
    let v_align = own(&V_ALIGN, v_pos);
    Some(DrawingAnchor {
        h: AnchorAxis {
            relative_from: if page {
                "page".to_string()
            } else {
                own(&H_REL, attr(&props, "style:horizontal-rel").unwrap_or(""))
                    .unwrap_or("column")
                    .to_string()
            },
            offset: if h_align.is_some() {
                None
            } else {
                Some(JsNum(facts.x_emu.unwrap_or(0.0)))
            },
            align: h_align.map(str::to_string),
        },
        v: AnchorAxis {
            relative_from: if page {
                "page".to_string()
            } else {
                own(&V_REL, attr(&props, "style:vertical-rel").unwrap_or(""))
                    .unwrap_or("paragraph")
                    .to_string()
            },
            offset: if v_align.is_some() {
                None
            } else {
                Some(JsNum(facts.y_emu.unwrap_or(0.0)))
            },
            align: v_align.map(str::to_string),
        },
        wrap: if wrap_prop == "run-through" {
            AnchorWrap::None
        } else if wrap_prop == "none" {
            AnchorWrap::TopAndBottom
        } else {
            AnchorWrap::Square
        },
        behind: wrap_prop == "run-through"
            && attr(&props, "style:run-through") == Some("background"),
        z: JsNum(facts.z),
    })
}

/// `textWidthEmu`: width of the text area of the default page (EMU), for
/// block placeholders.
pub fn text_width_emu(doc: &OdtDocument) -> f64 {
    let master = doc
        .styles
        .master_page("Standard")
        .or_else(|| doc.styles.master_pages.first().cloned());
    let layout = master
        .and_then(|m| jscompat::truthy(m.page_layout_name.as_deref()).map(str::to_string))
        .and_then(|name| doc.styles.page_layout(&name));
    let empty = JsObject::new();
    let p = layout
        .as_ref()
        .and_then(|l| l.properties.get("style:page-layout-properties"))
        .unwrap_or(&empty);
    let width =
        length_to_emu(attr(p, "fo:page-width")).unwrap_or_else(|| math_round(21.0 * EMU_PER_CM));
    let left = length_to_emu(attr(p, "fo:margin-left")).unwrap_or(2.0 * EMU_PER_CM);
    let right = length_to_emu(attr(p, "fo:margin-right")).unwrap_or(2.0 * EMU_PER_CM);
    math_max(2.0 * EMU_PER_CM, width - left - right)
}
