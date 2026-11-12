//! SmartArt and drawing canvases as display shapes: the node texts of a
//! diagram's data part, the layout Word saves next to it, and a locked
//! canvas of the paragraph itself.

use std::cmp::Ordering;
use std::collections::HashSet;

use jscompat::{JsMap, JsNum, Radix, Slot, js_regex, math_max, math_round, parse_int, trim};
use ooxml_xml::{XNode, parse_ordered, serialize};

use super::EMU_PER_PX;
use super::media::{image_part_mime, media_part_src, rel_part_path_of};
use super::picture::rect_frac;
use crate::drawing_geometry::fill::{color_node_hex, grad_fill_approx_hex};
use crate::image_kinds::is_metafile_mime;
use crate::model::{DiagramDisplay, DiagramShape, DiagramShapeFillRect, SharedStr};
use crate::package::{Thrown, parse_rels, part_text, resolve_relationship_target_path};
use crate::parse::text::{BuildContext, emu_to_px};
use crate::props::{XML_PARSER_MAX_NESTED_TAGS, collect_nodes};
use crate::theme::ThemeColors;
use crate::xml_text::{decode_entities, decode_numeric_char_refs};

/// A shape's numeric key; every shape built here has its four extents.
fn px(slot: &Slot<JsNum>) -> f64 {
    slot.map_or(f64::NAN, |value| value.0)
}

/// A display with no size, shapes or optional key.
fn blank_display() -> DiagramDisplay {
    DiagramDisplay {
        width_px: JsNum(0.0),
        height_px: JsNum(0.0),
        shapes: Vec::new(),
        offset_x_emu: None,
        offset_y_emu: None,
        floating: None,
        canvas: None,
    }
}

/// `ownValue(theme, scheme)` of a `ThemeColors`: the slots it holds.
fn theme_slot<'t>(theme: &'t ThemeColors, scheme: &str) -> Option<&'t str> {
    match scheme {
        "name" => theme.name.as_deref(),
        "dk1" => theme.dk1.as_deref(),
        "lt1" => theme.lt1.as_deref(),
        "dk2" => theme.dk2.as_deref(),
        "lt2" => theme.lt2.as_deref(),
        "accent1" => theme.accent1.as_deref(),
        "accent2" => theme.accent2.as_deref(),
        "accent3" => theme.accent3.as_deref(),
        "accent4" => theme.accent4.as_deref(),
        "accent5" => theme.accent5.as_deref(),
        "accent6" => theme.accent6.as_deref(),
        "hlink" => theme.hlink.as_deref(),
        "folHlink" => theme.fol_hlink.as_deref(),
        _ => None,
    }
}

/// `parseInt(attrsOf(node ?? {})[name] ?? '', 10)`
fn int_attr(node: Option<&XNode>, name: &str) -> f64 {
    parse_int(
        node.and_then(|node| node.attr(name)).unwrap_or(""),
        Radix::Ten,
    )
}

/// `Math.round(x)` as a model number.
fn rounded(x: f64) -> JsNum {
    JsNum(math_round(x))
}

/// The last `<wp:extent>` tag of `text`.
fn last_extent_tag(text: &str) -> &str {
    js_regex!(r"<wp:extent[^>]*\/?>")
        .find_iter(text)
        .last()
        .map_or("", |found| found.as_str())
}

/// The `cx` and `cy` of a wp:extent tag.
fn extent_of(tag: &str) -> (f64, f64) {
    let size = |pattern: &jscompat::JsRegex| {
        parse_int(
            pattern
                .exec(tag)
                .and_then(|found| found.get(1))
                .unwrap_or(""),
            Radix::Ten,
        )
    };
    (
        size(js_regex!(r#"\bcx\s*=\s*["'](\d+)["']"#)),
        size(js_regex!(r#"\bcy\s*=\s*["'](\d+)["']"#)),
    )
}

/// `extractDiagramText`: SmartArt degrade. The node texts of the diagram data
/// part (r:dm) become the preview, ordered by walking the diagram's
/// parent-child connections (dgm:cxn srcOrd): the file order of dgm:pt nodes
/// is arbitrary, while renderers lay shapes out in tree order.
pub fn extract_diagram_text(xml: &str, ctx: &BuildContext<'_>) -> Result<Option<String>, Thrown> {
    let path = rel_part_path_of(
        ctx,
        js_regex!(r#"r:dm\s*=\s*["']([^"']+)["']"#)
            .exec(xml)
            .and_then(|found| found.get(1)),
    );
    let Some(data_xml) = path
        .as_deref()
        .map(|path| part_text(ctx.zip, path))
        .transpose()?
        .flatten()
    else {
        return Ok(None);
    };
    // node texts by modelId (pres/transition points carry no content text)
    let mut pt_texts: JsMap<String> = JsMap::new();
    for found in
        js_regex!(r#"<dgm:pt modelId="([^"]+)"([^>]*)>([\s\S]*?)<\/dgm:pt>"#).find_iter(data_xml)
    {
        if js_regex!(r#"type="(?:pres|parTrans|sibTrans)""#).test(found.get(2).unwrap_or("")) {
            continue;
        }
        let joined: String = js_regex!(r"<a:t>[^<]*<\/a:t>")
            .find_iter(found.get(3).unwrap_or(""))
            .map(|t| decode_entities(&t.as_str()[5..t.as_str().len() - 6]))
            .collect();
        let text = trim(&joined);
        if !text.is_empty() {
            pt_texts.set(found.get(1).unwrap_or(""), text.to_owned());
        }
    }
    // parent-child edges: cxns without an explicit type (default parOf); typed
    // cxns (presOf/presParOf...) are layout wiring, not the content tree
    let mut children: JsMap<Vec<(f64, String)>> = JsMap::new();
    let mut has_parent: HashSet<String> = HashSet::new();
    for found in js_regex!(r"<dgm:cxn [^>]*\/?>").find_iter(data_xml) {
        let tag = found.as_str();
        if js_regex!(r#"type="(?!parOf")"#).test(tag) {
            continue;
        }
        let src = js_regex!(r#"srcId="([^"]+)""#)
            .exec(tag)
            .and_then(|found| found.get(1));
        let dst = js_regex!(r#"destId="([^"]+)""#)
            .exec(tag)
            .and_then(|found| found.get(1));
        let (Some(src), Some(dst)) = (src, dst) else {
            continue;
        };
        let ord = parse_int(
            js_regex!(r#"srcOrd="(\d+)""#)
                .exec(tag)
                .and_then(|found| found.get(1))
                .unwrap_or("0"),
            Radix::Ten,
        );
        if !children.has(src) {
            children.set(src, Vec::new());
        }
        if let Some(list) = children.get_mut(src) {
            list.push((ord, dst.to_owned()));
        }
        has_parent.insert(dst.to_owned());
    }
    let mut texts: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for root in children.keys() {
        if has_parent.contains(root) {
            continue;
        }
        // `visit(id)`, depth first, children in srcOrd order
        let mut stack = vec![root.to_owned()];
        while let Some(id) = stack.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(text) = pt_texts.get(&id) {
                texts.push(text.clone());
            }
            let mut kids = children.get(&id).cloned().unwrap_or_default();
            kids.sort_by(|a, b| (a.0 - b.0).partial_cmp(&0.0).unwrap_or(Ordering::Equal));
            for (_, kid) in kids.into_iter().rev() {
                stack.push(kid);
            }
        }
    }
    // isolated points (no tree info) keep file order
    for (id, text) in pt_texts.iter() {
        if !seen.contains(id) {
            texts.push(text.clone());
        }
    }
    Ok((!texts.is_empty()).then(|| texts.join("\n")))
}

/// The text paragraphs of an a:txBody / dsp:txBody: their texts, the first
/// declared size (hundredths of a point) and the first run colour.
struct BodyText {
    texts: Vec<String>,
    size_pt: Option<f64>,
    color: Option<String>,
}

fn body_text(body: &XNode, color_of: &dyn Fn(&XNode) -> Option<String>) -> BodyText {
    let mut texts = Vec::new();
    let mut size_pt: Option<f64> = None;
    let mut color: Option<String> = None;
    for p in body.find_children("a:p") {
        let mut parts: Vec<String> = Vec::new();
        for r in p.find_children("a:r") {
            if let Some(t) = r.find_child("a:t") {
                parts.push(decode_numeric_char_refs(&t.text()).into_owned());
            }
            if let Some(r_pr) = r.find_child("a:rPr")
                && size_pt.is_none()
            {
                let sz = int_attr(Some(r_pr), "sz");
                if sz.is_finite() && sz > 0.0 {
                    size_pt = Some(math_round(sz / 100.0));
                }
                if let Some(c) = color_of(r_pr) {
                    color = Some(c);
                }
            }
        }
        let joined = parts.concat();
        if !trim(&joined).is_empty() {
            texts.push(joined);
        }
    }
    BodyText {
        texts,
        size_pt,
        color,
    }
}

/// `if (sizePt)` of a number
fn truthy(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value != 0.0 && !value.is_nan())
}

/// `extractLockedCanvas`: a drawing canvas (a:graphicData lockedCanvas). Its
/// children carry absolute EMU geometry in the canvas child-coordinate space
/// (grpSpPr chOff/chExt), mapped onto the drawing's wp:extent. Geometry scales
/// through that mapping; text keeps its raw font size and overflows the scaled
/// boxes (LO behavior: the canvas is usually authored far larger than the
/// extent it is placed at).
pub fn extract_locked_canvas(
    xml: &str,
    ctx: &BuildContext<'_>,
) -> Result<Option<DiagramDisplay>, Thrown> {
    let Some(ci) = xml.find("<lc:lockedCanvas") else {
        return Ok(None);
    };
    let Some(end) = xml[ci..].find("</lc:lockedCanvas>").map(|at| ci + at) else {
        return Ok(None);
    };
    // display size: the nearest wp:extent before the canvas (its own inline/anchor)
    let (ext_cx, ext_cy) = extent_of(last_extent_tag(&xml[..ci]));
    if !ext_cx.is_finite() || !ext_cy.is_finite() || ext_cx <= 0.0 || ext_cy <= 0.0 {
        return Ok(None);
    }
    let Ok(parsed) = parse_ordered(
        &xml[ci..end + "</lc:lockedCanvas>".len()],
        XML_PARSER_MAX_NESTED_TAGS,
    ) else {
        return Ok(None);
    };
    let Some(canvas_node) = parsed
        .iter()
        .find(|node| node.name() == Some("lc:lockedCanvas"))
    else {
        return Ok(None);
    };
    let theme = ctx.resolver.theme_colors.as_ref();
    let grp_xfrm = canvas_node
        .find_child("a:grpSpPr")
        .and_then(|grp| grp.find_child("a:xfrm"));
    let emu_attr = |node: Option<&XNode>, name: &str, fallback: f64| {
        let v = int_attr(node, name);
        if v.is_finite() { v } else { fallback }
    };
    let ch_off = grp_xfrm.and_then(|xfrm| xfrm.find_child("a:chOff"));
    let ch_ext = grp_xfrm.and_then(|xfrm| xfrm.find_child("a:chExt"));
    let ch_off_x = emu_attr(ch_off, "x", 0.0);
    let ch_off_y = emu_attr(ch_off, "y", 0.0);
    let ch_ext_cx = emu_attr(ch_ext, "cx", ext_cx);
    let ch_ext_cy = emu_attr(ch_ext, "cy", ext_cy);
    let scale_x = if ch_ext_cx > 0.0 {
        ext_cx / ch_ext_cx
    } else {
        1.0
    };
    let scale_y = if ch_ext_cy > 0.0 {
        ext_cy / ch_ext_cy
    } else {
        1.0
    };
    let mut shapes: Vec<DiagramShape> = Vec::new();
    for child in canvas_node.children() {
        let name = child.name();
        if name != Some("a:sp") && name != Some("a:pic") {
            continue;
        }
        let sp_pr = child.find_child("a:spPr");
        let xfrm = sp_pr.and_then(|sp_pr| sp_pr.find_child("a:xfrm"));
        let off = xfrm.and_then(|xfrm| xfrm.find_child("a:off"));
        let ext = xfrm.and_then(|xfrm| xfrm.find_child("a:ext"));
        let (Some(off), Some(ext)) = (off, ext) else {
            continue;
        };
        let mut shape = DiagramShape {
            x_px: Slot::of(rounded(
                ((emu_attr(Some(off), "x", 0.0) - ch_off_x) * scale_x) / EMU_PER_PX,
            )),
            y_px: Slot::of(rounded(
                ((emu_attr(Some(off), "y", 0.0) - ch_off_y) * scale_y) / EMU_PER_PX,
            )),
            w_px: Slot::of(rounded(
                (emu_attr(Some(ext), "cx", 0.0) * scale_x) / EMU_PER_PX,
            )),
            h_px: Slot::of(rounded(
                (emu_attr(Some(ext), "cy", 0.0) * scale_y) / EMU_PER_PX,
            )),
            ..DiagramShape::default()
        };
        if px(&shape.w_px) <= 0.0 || px(&shape.h_px) <= 0.0 {
            continue;
        }
        let rot = int_attr(xfrm, "rot");
        if rot.is_finite() && rot != 0.0 {
            shape.rot_deg.set(rounded(rot / 60000.0));
        }
        let prst = sp_pr
            .and_then(|sp_pr| sp_pr.find_child("a:prstGeom"))
            .and_then(|geom| geom.attr("prst"));
        if let Some(prst) = prst.filter(|prst| !prst.is_empty() && *prst != "rect") {
            shape.prst.set(prst.to_owned());
        }
        if name == Some("a:pic") {
            let r_id = child
                .find_child("a:blipFill")
                .and_then(|fill| fill.find_child("a:blip"))
                .and_then(|blip| blip.attr("r:embed"));
            let data_url = r_id.and_then(|r_id| {
                ctx.media_by_rid
                    .as_ref()
                    .and_then(|media| media.borrow().get(r_id).cloned())
            });
            if let Some(data_url) = data_url.filter(|url| !url.is_empty()) {
                shape.image_data_url.set(data_url);
            }
        } else if let Some(sp_pr) = sp_pr
            && sp_pr.find_child("a:noFill").is_none()
        {
            let fill = color_node_hex(sp_pr.find_child("a:solidFill"), theme)
                .or_else(|| grad_fill_approx_hex(sp_pr, theme));
            if let Some(fill) = fill.filter(|fill| !fill.is_empty()) {
                shape.fill_hex.set(fill);
            }
        }
        let body = child
            .find_child("a:txSp")
            .and_then(|tx| tx.find_child("a:txBody"));
        if let Some(body) = body {
            let text = body_text(body, &|r_pr| {
                color_node_hex(r_pr.find_child("a:solidFill"), theme)
                    .filter(|color| !color.is_empty())
            });
            if !text.texts.is_empty() {
                shape.texts.set(text.texts);
                if let Some(size) = truthy(text.size_pt) {
                    shape.font_size_pt.set(JsNum(size));
                }
                if let Some(color) = text.color {
                    shape.text_color_hex.set(color);
                }
            }
        }
        shapes.push(shape);
    }
    if shapes.is_empty() {
        return Ok(None);
    }
    // LO parity for severely overflowing canvas text (the canvas is authored
    // several times larger than its placed extent, so raw-size text dwarfs the
    // scaled boxes): LO stacks the text shapes as columns, each next column
    // starting about halfway down the previous column's text run. Reproducing
    // that stacking keeps the glyph reading order identical to LO's render.
    let col_geom = |s: &DiagramShape| -> (f64, f64) {
        let font_px = (s.font_size_pt.map_or(f64::NAN, |pt| pt.0) * 96.0) / 72.0;
        let chars_per_line = math_max(1.0, (px(&s.w_px) / (font_px * 0.72)).floor());
        let chars = s
            .texts
            .as_ref()
            .map_or(0, |texts| texts.concat().encode_utf16().count()) as f64;
        ((chars / chars_per_line).ceil(), font_px * 1.2)
    };
    let text_shapes: Vec<usize> = (0..shapes.len())
        .filter(|&at| {
            let s = &shapes[at];
            s.texts.as_ref().is_some_and(|texts| !texts.is_empty())
                && truthy(s.font_size_pt.map(|pt| pt.0)).is_some()
        })
        .collect();
    let overflowing: Vec<usize> = text_shapes
        .into_iter()
        .filter(|&at| {
            let (lines, pitch) = col_geom(&shapes[at]);
            lines * pitch > 2.0 * px(&shapes[at].h_px)
        })
        .collect();
    if !overflowing.is_empty() {
        // the first overflowing column anchors at the canvas top (LO ignores the
        // scaled box offset once the text no longer fits the box)
        shapes[overflowing[0]].y_px.set(JsNum(0.0));
        for i in 1..overflowing.len() {
            let prev = overflowing[i - 1];
            let (lines, pitch) = col_geom(&shapes[prev]);
            let y = rounded(px(&shapes[prev].y_px) + (lines / 2.0).ceil() * pitch - 23.0);
            shapes[overflowing[i]].y_px.set(y);
        }
        // single-letter-per-line columns explode into per-letter shapes ordered
        // top-down: the exported PDF then emits glyphs in painter order like LO,
        // and text extraction reads the interleaved columns identically
        let mut order: Vec<usize> = (0..shapes.len()).collect();
        let mut pool: Vec<Option<DiagramShape>> = shapes.into_iter().map(Some).collect();
        let mut letter_shapes: Vec<DiagramShape> = Vec::new();
        for &id in &overflowing {
            let s = pool[id].clone().unwrap_or_default();
            let (lines, pitch) = col_geom(&s);
            let chars: Vec<String> = s.texts.as_ref().map_or_else(Vec::new, |texts| {
                texts.concat().chars().map(String::from).collect()
            });
            // wraps more than one char per line
            if lines < chars.len() as f64 {
                continue;
            }
            let Some(at) = order.iter().position(|&known| known == id) else {
                continue;
            };
            let first_letter = pool.len() + letter_shapes.len();
            let letters: Vec<usize> = chars
                .iter()
                .enumerate()
                .map(|(i, ch)| {
                    let mut letter = DiagramShape {
                        x_px: Slot::maybe(*s.x_px),
                        y_px: Slot::of(rounded(px(&s.y_px) + i as f64 * pitch)),
                        w_px: Slot::maybe(*s.w_px),
                        h_px: Slot::of(JsNum(pitch.ceil())),
                        texts: Slot::of(vec![ch.clone()]),
                        ..DiagramShape::default()
                    };
                    if truthy(s.font_size_pt.map(|pt| pt.0)).is_some() {
                        letter.font_size_pt.assign(*s.font_size_pt);
                    }
                    if s.text_color_hex.as_ref().is_some_and(|c| !c.is_empty()) {
                        letter.text_color_hex.assign((*s.text_color_hex).clone());
                    }
                    letter_shapes.push(letter);
                    first_letter + i
                })
                .collect();
            order.splice(at..=at, letters);
        }
        let mut all = pool.iter_mut().map(Option::take).collect::<Vec<_>>();
        all.extend(letter_shapes.into_iter().map(Some));
        let mut ordered: Vec<DiagramShape> =
            order.into_iter().filter_map(|at| all[at].take()).collect();
        ordered.sort_by(|a, b| {
            px(&a.y_px)
                .partial_cmp(&px(&b.y_px))
                .unwrap_or(Ordering::Equal)
        });
        return Ok(Some(DiagramDisplay {
            width_px: JsNum(emu_to_px(ext_cx)),
            height_px: JsNum(emu_to_px(ext_cy)),
            shapes: ordered,
            canvas: Some(true),
            ..blank_display()
        }));
    }
    Ok(Some(DiagramDisplay {
        width_px: JsNum(emu_to_px(ext_cx)),
        height_px: JsNum(emu_to_px(ext_cy)),
        shapes,
        canvas: Some(true),
        ..blank_display()
    }))
}

/// `extractDiagramDrawing`: SmartArt visual degrade. Word saves the resolved
/// layout in a companion diagrams/drawingN.xml (dsp:sp shapes with absolute
/// geometry, fills incl. pictures, and text bodies). Rendering those shapes
/// reproduces the diagram without a layout engine. `None` (null) when the
/// part is absent: then only the text degrade shows.
pub fn extract_diagram_drawing(
    xml: &str,
    ctx: &BuildContext<'_>,
) -> Result<Option<DiagramDisplay>, Thrown> {
    let dm_path = rel_part_path_of(
        ctx,
        js_regex!(r#"r:dm\s*=\s*["']([^"']+)["']"#)
            .exec(xml)
            .and_then(|found| found.get(1)),
    );
    let Some(dm_path) = dm_path else {
        return Ok(None);
    };
    let drawing_path = js_regex!(r"data(\d*)\.xml$").replace_all(&dm_path, |found| {
        format!("drawing{}.xml", found.get(1).unwrap_or(""))
    });
    let file = if drawing_path != dm_path {
        ctx.zip.file(&drawing_path)
    } else {
        None
    };
    let Some(file) = file else {
        return Ok(None);
    };
    // the owning drawing's extent is the last one before its dgm:relIds (a
    // paragraph can hold several drawings)
    let dm_at = js_regex!(r"r:dm\s*=").exec(xml).map(|found| found.start());
    let (ext_cx, ext_cy) = extent_of(last_extent_tag(dm_at.map_or(xml, |at| &xml[..at])));
    let extent = (ext_cx.is_finite() && ext_cy.is_finite()).then_some((ext_cx, ext_cy));
    let width_px = extent.map_or(0.0, |(cx, _)| math_round(cx / EMU_PER_PX));
    let height_px = extent.map_or(0.0, |(_, cy)| math_round(cy / EMU_PER_PX));
    if width_px == 0.0 || width_px.is_nan() || height_px == 0.0 || height_px.is_nan() {
        return Ok(None);
    }
    let parsed = match file.text() {
        Ok(text) => parse_ordered(text, XML_PARSER_MAX_NESTED_TAGS),
        Err(_) => return Ok(None),
    };
    let Ok(parsed) = parsed else {
        return Ok(None);
    };
    // picture fills resolve through the drawing part's own rels (../media/...)
    let rels_path = js_regex!(r"([^\/]+)$").replace_all(&drawing_path, |found| {
        format!("_rels/{}.rels", found.get(1).unwrap_or(""))
    });
    let rels = parse_rels(ctx.zip, &rels_path)?;
    let media_of = |r_id: &str| -> Result<Option<SharedStr>, Thrown> {
        let Some(rel) = rels.get(r_id) else {
            return Ok(None);
        };
        if rel.target_mode.as_deref() == Some("External") {
            return Ok(None);
        }
        let Some(path) = resolve_relationship_target_path(&drawing_path, &rel.target) else {
            return Ok(None);
        };
        let Some(f) = ctx.zip.file(&path) else {
            return Ok(None);
        };
        let Some(mime) = image_part_mime(ctx.zip, &path, ctx.media)? else {
            return Ok(None);
        };
        if is_metafile_mime(Some(&mime)) {
            let bytes = f.bytes().map_err(|error| error.to_string())?;
            return Ok(ctx
                .media
                .host
                .metafile_to_data_url(bytes, &mime)
                .map(SharedStr::from));
        }
        media_part_src(f, &path, &mime, ctx.media).map(|src| Some(SharedStr::from(src)))
    };
    let theme = ctx.resolver.theme_colors.as_ref();
    let mut sps: Vec<&XNode> = Vec::new();
    collect_nodes(&parsed, "dsp:sp", &mut sps);
    let mut shapes: Vec<DiagramShape> = Vec::new();
    for sp in sps {
        let Some(sp_pr) = sp.find_child("dsp:spPr") else {
            continue;
        };
        let xfrm = sp_pr.find_child("a:xfrm");
        let off = xfrm.and_then(|xfrm| xfrm.find_child("a:off"));
        let ext = xfrm.and_then(|xfrm| xfrm.find_child("a:ext"));
        let (Some(off), Some(ext)) = (off, ext) else {
            continue;
        };
        let attr_or_zero =
            |node: &XNode, name: &str| parse_int(node.attr(name).unwrap_or("0"), Radix::Ten);
        let mut shape = DiagramShape {
            x_px: Slot::of(rounded(attr_or_zero(off, "x") / EMU_PER_PX)),
            y_px: Slot::of(rounded(attr_or_zero(off, "y") / EMU_PER_PX)),
            w_px: Slot::of(rounded(attr_or_zero(ext, "cx") / EMU_PER_PX)),
            h_px: Slot::of(rounded(attr_or_zero(ext, "cy") / EMU_PER_PX)),
            ..DiagramShape::default()
        };
        let prst = sp_pr
            .find_child("a:prstGeom")
            .and_then(|geom| geom.attr("prst"))
            .filter(|prst| !prst.is_empty());
        if let Some(prst) = prst {
            shape.prst.set(prst.to_owned());
        }
        // connectors carry cy="0"/cx="0"; only they may be zero-extent
        let is_line = prst.is_some_and(|prst| prst == "line" || prst.contains("Connector"));
        let (w, h) = (px(&shape.w_px), px(&shape.h_px));
        if (w <= 0.0 || h <= 0.0) && !(is_line && (w > 0.0 || h > 0.0)) {
            continue;
        }
        let rot = int_attr(xfrm, "rot");
        if rot.is_finite() && rot != 0.0 {
            shape.rot_deg.set(rounded(rot / 60000.0));
        }
        if let Some(ln) = sp_pr.find_child("a:ln")
            && ln.find_child("a:noFill").is_none()
            && let Some(ln_hex) =
                color_node_hex(ln.find_child("a:solidFill"), theme).filter(|hex| !hex.is_empty())
        {
            shape.ln_hex.set(ln_hex);
            let w = int_attr(Some(ln), "w");
            shape.ln_w_px.set(if w.is_finite() && w > 0.0 {
                JsNum(math_max(1.0, math_round(w / EMU_PER_PX)))
            } else {
                JsNum(1.0)
            });
        }
        if let Some(blip_fill) = sp_pr.find_child("a:blipFill") {
            let r_id = blip_fill
                .find_child("a:blip")
                .and_then(|blip| blip.attr("r:embed"))
                .filter(|r_id| !r_id.is_empty());
            let data_url = match r_id {
                Some(r_id) => media_of(r_id)?,
                None => None,
            };
            if let Some(data_url) = data_url.filter(|url| !url.is_empty()) {
                shape.image_data_url.set(data_url);
                let fill = serialize(blip_fill);
                if let Some(fr) = js_regex!(r"<a:fillRect\s[^>]*\/>")
                    .exec(&fill)
                    .map(|found| found.as_str())
                {
                    let l = rect_frac(fr, "l").map_err(|e| e.to_string())?;
                    let t = rect_frac(fr, "t").map_err(|e| e.to_string())?;
                    let r = rect_frac(fr, "r").map_err(|e| e.to_string())?;
                    let b = rect_frac(fr, "b").map_err(|e| e.to_string())?;
                    let on = |v: f64| v != 0.0 && !v.is_nan();
                    if on(l) || on(t) || on(r) || on(b) {
                        shape.fill_rect.set(DiagramShapeFillRect {
                            l: JsNum(l),
                            t: JsNum(t),
                            r: JsNum(r),
                            b: JsNum(b),
                        });
                    }
                }
            }
        } else {
            let solid = sp_pr.find_child("a:solidFill");
            let color_val = |name: &str| {
                solid
                    .and_then(|solid| solid.find_child(name))
                    .and_then(|color| color.attr("val"))
                    .filter(|val| !val.is_empty())
            };
            let (srgb, scheme) = (color_val("a:srgbClr"), color_val("a:schemeClr"));
            if let Some(srgb) = srgb {
                shape.fill_hex.set(srgb.to_owned());
            } else if let Some(scheme) = scheme {
                shape.fill_hex.set(
                    theme
                        .and_then(|theme| theme_slot(theme, scheme))
                        .filter(|hex| !hex.is_empty())
                        .unwrap_or("9AB5E4")
                        .to_owned(),
                );
            }
        }
        if let Some(body) = sp.find_child("dsp:txBody") {
            let text = body_text(body, &|r_pr| {
                r_pr.find_child("a:solidFill")
                    .and_then(|fill| fill.find_child("a:srgbClr"))
                    .and_then(|color| color.attr("val"))
                    .filter(|val| !val.is_empty())
                    .map(str::to_owned)
            });
            if !text.texts.is_empty() {
                shape.texts.set(text.texts);
                if let Some(size) = truthy(text.size_pt) {
                    shape.font_size_pt.set(JsNum(size));
                }
                if let Some(color) = text.color {
                    shape.text_color_hex.set(color);
                }
            }
        }
        shapes.push(shape);
    }
    Ok((!shapes.is_empty()).then(|| DiagramDisplay {
        width_px: JsNum(width_px),
        height_px: JsNum(height_px),
        shapes,
        ..blank_display()
    }))
}
