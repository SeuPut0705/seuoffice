//! `buildRun` of parse.ts: one w:r as a model run.

use jscompat::{
    JsMap, JsObject, Radix, js_regex, math_round, parse_float, parse_int, to_number, truthy,
};
use ooxml_xml::{XNode, serialize};
use serde_json::{Map, Value};

use super::build_run_old::old_run_properties;
use super::convert::{PictureUrls, json, model_of, num, put_picture_urls, run_eff_to_model};
use super::emu_to_px;
use super::runs::{RunResolve, effective_run_of};
use super::{break_char_of, wt_text};
use crate::drawing_geometry::fill::{w14_glow_of, w14_text_fill_hex};
use crate::drawing_geometry::w14_text_outline_of;
use crate::model::{Run, RunLink, SharedStr};
use crate::package::Thrown;
use crate::parse::drawings::image::run_picture_anchor_of;
use crate::parse::drawings::picture::{group_picture_layers, pic_border_of, pic_transform_of};
use crate::parse::drawings::vml::vml_hr_rule;
use crate::props::{shd_display_fill, themed_r_fonts};
use crate::resolve::direct_run_format;
use crate::symbol_fonts::{decode_symbol_text, symbol_glyph};
use crate::theme::{ThemeColors, ThemeFonts};
use crate::vml::shape::vml_shape_svg;
use crate::vml::vml_rotation_deg;
use crate::xml_text::{auto_color_of, color_from, decode_numeric_char_refs, on_off_of, strip_hash};

/// `TEXT_EFFECTS`
/// `DIRECT_RUN_KEYS`: the direct run fields the resolver reads for extractRun
const DIRECT_RUN_KEYS: [&str; 14] = [
    "bold",
    "italic",
    "sizeHalfPoints",
    "underline",
    "strike",
    "caps",
    "charSpacingTwips",
    "kernHalfPoints",
    "vertAlign",
    "font",
    "fontAscii",
    "eastAsiaFont",
    "eaSlotEmpty",
    "csFont",
];

const TEXT_EFFECTS: [&str; 4] = ["outline", "emboss", "imprint", "shadow"];

/// `findChild(node, name)` over the children of a run.
pub fn find_in<'a>(children: &[&'a XNode], name: &str) -> Option<&'a XNode> {
    children
        .iter()
        .copied()
        .find(|child| child.name() == Some(name))
}

/// `attrsOf(findChild(node, name) ?? {})[key]`
fn child_attr<'a>(node: &'a XNode, name: &str, key: &str) -> Option<&'a str> {
    node.find_child(name).and_then(|child| child.attr(key))
}

/// `w:sym` state of the run: none seen, one, or more than one.
enum SymState {
    Unset,
    One {
        font: String,
        char: String,
        glyph: String,
    },
    Many,
}

/// `buildRun`: `children` are the run's child nodes (a synthetic run built
/// from some of them is just a shorter list). `None` where the run has no
/// text and no picture.
#[allow(clippy::too_many_arguments)]
pub fn build_run(
    children: &[&XNode],
    link: Option<&RunLink>,
    theme: Option<&ThemeColors>,
    theme_fonts: Option<&ThemeFonts>,
    media_by_rid: Option<&JsMap<SharedStr>>,
    res: &mut RunResolve<'_>,
    part_preserve: Option<bool>,
    vml_shape_types: Option<&JsMap<JsObject<String>>>,
) -> Result<Option<Run>, Thrown> {
    let mut text = String::new();
    let mut sym = SymState::Unset;
    for child in children {
        match child.name() {
            Some("w:t" | "w:delText") => {
                let own = child.attr("xml:space");
                let raw = child.text();
                text += &wt_text(
                    &decode_numeric_char_refs(&raw),
                    own == Some("preserve") || (own.is_none() && part_preserve == Some(true)),
                );
            }
            Some("w:tab" | "w:ptab") => text.push('\t'),
            // In-paragraph page breaks are encoded as \f; column/soft breaks become \n
            Some("w:br") => text.push(break_char_of(child.attr("w:clear"), child.attr("w:type"))),
            Some("w:cr") => text.push('\n'),
            Some("w:noBreakHyphen") => text.push('\u{2011}'),
            Some("w:softHyphen") => text.push('\u{ad}'),
            Some("w:sym") => {
                let font = child.attr("w:font").unwrap_or("");
                let char = child.attr("w:char").unwrap_or("");
                if let Some(glyph) = symbol_glyph(font, char) {
                    text += &glyph;
                    sym = match sym {
                        SymState::Unset => SymState::One {
                            font: font.to_owned(),
                            char: char.to_owned(),
                            glyph,
                        },
                        _ => SymState::Many,
                    };
                }
            }
            _ => {}
        }
    }
    let mut image: Option<Map<String, Value>> = None;
    // The picture's data URL and those of its layers stand empty in `image` and
    // are set on the run: a JSON value would copy each one for every run.
    let mut image_url: Option<SharedStr> = None;
    let mut layer_urls: Vec<SharedStr> = Vec::new();
    if let Some(media) = media_by_rid {
        // Word wraps modern drawings in mc:AlternateContent (Choice + VML twin)
        let alternate = find_in(children, "mc:AlternateContent");
        let choice = alternate.and_then(|alternate| alternate.find_child("mc:Choice"));
        let drawing = find_in(children, "w:drawing")
            .or_else(|| choice.and_then(|choice| choice.find_child("w:drawing")));
        if let Some(drawing) = drawing {
            let drawing_xml = serialize(drawing);
            let r_id = js_regex!(r#"<a:blip[^>]*r:(?:embed|link)\s*=\s*["']([^"']+)["']"#)
                .exec(&drawing_xml)
                .and_then(|found| found.get(1));
            let data_url = r_id.and_then(|r_id| media.get(r_id));
            if let Some(data_url) = data_url {
                let mut img = Map::new();
                img.insert("dataUrl".to_owned(), Value::from(""));
                image_url = Some(data_url.clone());
                img.insert("xml".to_owned(), Value::from(drawing_xml.as_str()));
                if let Some(mut layers) = group_picture_layers(drawing, media) {
                    layer_urls = layers
                        .iter_mut()
                        .map(|layer| std::mem::take(&mut layer.data_url))
                        .collect();
                    img.insert("layers".to_owned(), json(&layers));
                }
                let extent_tag = js_regex!(r"<wp:extent[^>]*\/?>")
                    .exec(&drawing_xml)
                    .map_or("", |found| found.as_str());
                let dim = |found: Option<jscompat::JsMatch<'_>>| match found
                    .and_then(|m| m.get(1).map(str::to_owned))
                {
                    Some(digits) => to_number(&digits),
                    None => f64::NAN,
                };
                let cx = dim(js_regex!(r#"\bcx\s*=\s*["'](\d+)["']"#).exec(extent_tag));
                let cy = dim(js_regex!(r#"\bcy\s*=\s*["'](\d+)["']"#).exec(extent_tag));
                if cx > 0.0 {
                    img.insert("widthPx".to_owned(), num(emu_to_px(cx)));
                }
                if cy > 0.0 {
                    img.insert("heightPx".to_owned(), num(emu_to_px(cy)));
                }
                if let Some(border) = pic_border_of(&drawing_xml) {
                    img.insert("border".to_owned(), json(&border));
                }
                let xf = pic_transform_of(&drawing_xml);
                if let Some(rot) = xf.rot_deg {
                    img.insert("rotDeg".to_owned(), json(&rot));
                }
                if xf.flip_h == Some(true) {
                    img.insert("flipH".to_owned(), Value::Bool(true));
                }
                if xf.flip_v == Some(true) {
                    img.insert("flipV".to_owned(), Value::Bool(true));
                }
                // anchored (floating) picture kept as a run image: carry the wrap kind and anchor offsets
                for (key, value) in
                    super::convert::into_map(json(&run_picture_anchor_of(&drawing_xml)?))
                {
                    img.insert(key, value);
                }
                image = Some(img);
            }
        }
        // legacy VML picture (w:pict + v:imagedata) or an inline OLE embed (w:object)
        if image.is_none() {
            let mut picts: Vec<&XNode> =
                [find_in(children, "w:pict"), find_in(children, "w:object")]
                    .into_iter()
                    .flatten()
                    .collect();
            if let Some(choice) = choice {
                picts.extend(
                    [choice.find_child("w:pict"), choice.find_child("w:object")]
                        .into_iter()
                        .flatten(),
                );
            }
            for pict in picts {
                let pict_xml = serialize(pict);
                let r_id = js_regex!(r#"<v:imagedata[^>]*r:id="([^"]+)""#)
                    .exec(&pict_xml)
                    .and_then(|found| found.get(1));
                let data_url = r_id.and_then(|r_id| media.get(r_id));
                if let Some(data_url) = data_url {
                    let mut img = Map::new();
                    img.insert("dataUrl".to_owned(), Value::from(""));
                    image_url = Some(data_url.clone());
                    img.insert("xml".to_owned(), Value::from(pict_xml.as_str()));
                    let style = js_regex!(r#"<v:shape [^>]*style="([^"]*)""#)
                        .exec(&pict_xml)
                        .and_then(|found| found.get(1))
                        .unwrap_or("");
                    let w = parse_float(
                        js_regex!(r"(?:^|;)width:([\d.]+)pt")
                            .exec(style)
                            .and_then(|found| found.get(1))
                            .unwrap_or(""),
                    );
                    let h = parse_float(
                        js_regex!(r"(?:^|;)height:([\d.]+)pt")
                            .exec(style)
                            .and_then(|found| found.get(1))
                            .unwrap_or(""),
                    );
                    // w:object declares its size in twips when the v:shape style is absent
                    let obj_attrs = js_regex!(r"<w:object\b[^>]*>")
                        .exec(&pict_xml)
                        .map_or("", |found| found.as_str());
                    let w_tw = parse_int(
                        js_regex!(r#"w:dxaOrig="(\d+)""#)
                            .exec(obj_attrs)
                            .and_then(|found| found.get(1))
                            .unwrap_or(""),
                        Radix::Ten,
                    );
                    let h_tw = parse_int(
                        js_regex!(r#"w:dyaOrig="(\d+)""#)
                            .exec(obj_attrs)
                            .and_then(|found| found.get(1))
                            .unwrap_or(""),
                        Radix::Ten,
                    );
                    if w > 0.0 {
                        img.insert("widthPx".to_owned(), num(math_round((w / 72.0) * 96.0)));
                    } else if w_tw > 0.0 {
                        img.insert("widthPx".to_owned(), num(math_round(w_tw / 15.0)));
                    }
                    if h > 0.0 {
                        img.insert("heightPx".to_owned(), num(math_round((h / 72.0) * 96.0)));
                    } else if h_tw > 0.0 {
                        img.insert("heightPx".to_owned(), num(math_round(h_tw / 15.0)));
                    }
                    image = Some(img);
                    break;
                }
                if let Some(hr_rect) =
                    js_regex!(r#"<v:rect\b[^>]*\bo:hr="t"[^>]*>"#).exec(&pict_xml)
                {
                    let mut img = Map::new();
                    img.insert("dataUrl".to_owned(), Value::from(""));
                    img.insert("xml".to_owned(), Value::from(pict_xml.as_str()));
                    img.insert("rule".to_owned(), json(&vml_hr_rule(hr_rect.as_str())));
                    image = Some(img);
                    break;
                }
                // textless inline VML geometry: floating shapes belong to extractTextboxes
                if pict.name() == Some("w:pict")
                    && !js_regex!(r"position:\s*absolute").test(&pict_xml)
                    && let Some(shape) = vml_shape_svg(&pict_xml, vml_shape_types)
                {
                    let mut img = Map::new();
                    img.insert("dataUrl".to_owned(), Value::from(shape.data_url.as_str()));
                    img.insert("xml".to_owned(), Value::from(pict_xml.as_str()));
                    img.insert("widthPx".to_owned(), json(&shape.width_px));
                    img.insert("heightPx".to_owned(), json(&shape.height_px));
                    if let Some(rot) = vml_rotation_deg(&shape.style) {
                        img.insert("rotDeg".to_owned(), num(rot));
                    }
                    image = Some(img);
                    break;
                }
            }
        }
    }
    if text.is_empty() && image.is_none() {
        return Ok(None);
    }

    let r_pr = find_in(children, "w:rPr");
    let mut run = Map::new();
    run.insert("text".to_owned(), Value::from(text.as_str()));
    // only a run that is nothing but one w:sym stays a symbol run
    if let SymState::One { font, char, glyph } = &sym
        && text == *glyph
    {
        let mut s = Map::new();
        s.insert("font".to_owned(), Value::from(font.as_str()));
        s.insert("char".to_owned(), Value::from(char.as_str()));
        run.insert("sym".to_owned(), Value::Object(s));
    }
    if let Some(image) = image {
        run.insert("image".to_owned(), Value::Object(image));
    }
    if let Some(link) = link {
        run.insert("link".to_owned(), json(link));
    }
    let raw_r_pr = r_pr.map(serialize);
    if let Some(raw) = &raw_r_pr {
        run.insert("rawRPr".to_owned(), Value::from(raw.as_str()));
    }
    // the chain-resolved view: rtl selection, inherited hidden text and borders
    let key = raw_r_pr.as_deref().unwrap_or("");
    let eff = effective_run_of(res, r_pr, key).clone();
    run.insert("effective".to_owned(), json(&run_eff_to_model(&eff)?));
    if eff.cs {
        run.insert("cs".to_owned(), Value::Bool(true));
    }
    if eff.vanish {
        run.insert("vanish".to_owned(), Value::Bool(true));
    }
    if let Some(bdr) = &eff.bdr {
        run.insert("bdr".to_owned(), json(bdr));
    }
    if let Some(r_pr) = r_pr {
        let styles = &res.rctx.styles;
        let r_style = child_attr(r_pr, "w:rStyle", "w:val");
        if let Some(r_style) = truthy(r_style) {
            run.insert("styleId".to_owned(), Value::from(r_style));
        }
        // w:specVanish (style separator) keeps the run visible
        let vanish_own = if on_off_of(r_pr, "w:specVanish") == Some(true) {
            None
        } else {
            on_off_of(r_pr, "w:vanish")
        };
        if let Some(vanish_own) = vanish_own {
            run.insert("vanishOwn".to_owned(), Value::Bool(vanish_own));
        }
        let style_of = |id: Option<&str>| {
            truthy(id)
                .and_then(|id| styles.get(id))
                .and_then(|style| style.display.as_ref())
        };
        let ea_lang = child_attr(r_pr, "w:lang", "w:eastAsia")
            .map(str::to_owned)
            .or_else(|| style_of(r_style).and_then(|d| (*d.east_asia_lang).clone()));
        if let Some(ea_lang) = truthy(ea_lang.as_deref()) {
            run.insert("eastAsiaLang".to_owned(), Value::from(ea_lang));
        }
        let inherited_rtl = style_of(r_style).and_then(|d| *d.rtl).or(res.para_rtl);
        for (key, value) in super::convert::into_map(json(&direct_run_format(&eff))) {
            run.insert(key, value);
        }
        if let Some(collector) = &res.diff {
            let legacy = json(&super::runs::legacy_direct_run_format(
                r_pr,
                eff.cs,
                theme_fonts,
            ));
            let resolved = Value::Object(run.clone());
            let keys: Vec<String> = DIRECT_RUN_KEYS
                .iter()
                .map(|key| (*key).to_owned())
                .collect();
            let units: Vec<u16> = text.encode_utf16().take(40).collect();
            let shown = String::from_utf16_lossy(&units);
            for diff in crate::resolve::shadow_compare(Some(&legacy), Some(&resolved), Some(&keys))
            {
                collector.borrow_mut().push(super::context::ShadowDiff {
                    surface: "run",
                    key: diff.key,
                    old: diff.old,
                    eff: diff.eff,
                    text: shown.clone(),
                });
            }
        }
        let color = color_from(Some(r_pr), theme)
            .filter(|c| !c.is_empty())
            .or_else(|| w14_text_fill_hex(r_pr, theme).filter(|c| !c.is_empty()))
            .or_else(|| auto_color_of(Some(r_pr)).map(str::to_owned));
        if let Some(color) = &color {
            run.insert("color".to_owned(), Value::from(color.as_str()));
        }
        if color.is_some()
            && theme.is_some()
            && truthy(child_attr(r_pr, "w:color", "w:themeColor")).is_some()
        {
            run.insert(
                "themeColor".to_owned(),
                Value::from(color.clone().unwrap_or_default()),
            );
        }
        let empty = XNode::empty();
        let rf_node = r_pr.find_child("w:rFonts").unwrap_or(&empty);
        let rf = themed_r_fonts(rf_node, theme_fonts);
        // record which resolved values came from theme refs (per winning slot)
        let font_themed = if rf.east_asia.is_some() {
            rf.themed.east_asia
        } else {
            rf.themed.ascii
        };
        let font_ascii_themed = rf.themed.ascii;
        let run_font = run
            .get("font")
            .and_then(Value::as_str)
            .filter(|f| !f.is_empty())
            .map(str::to_owned);
        let run_font_ascii = run
            .get("fontAscii")
            .and_then(Value::as_str)
            .filter(|f| !f.is_empty())
            .map(str::to_owned);
        if (font_themed && run_font.is_some()) || (font_ascii_themed && run_font_ascii.is_some()) {
            let mut themed = Map::new();
            if font_themed && let Some(font) = &run_font {
                themed.insert("font".to_owned(), Value::from(font.as_str()));
            }
            if font_ascii_themed && let Some(font) = &run_font_ascii {
                themed.insert("fontAscii".to_owned(), Value::from(font.as_str()));
            }
            run.insert("themeRFonts".to_owned(), Value::Object(themed));
        }
        // complex-script slot: literal attribute only
        if let Some(cs) = truthy(rf_node.attr("w:cs")) {
            run.insert("fontCs".to_owned(), Value::from(cs));
        }
        if let Some(rtl) = on_off_of(r_pr, "w:rtl") {
            run.insert("rtl".to_owned(), Value::Bool(rtl));
        }
        let w_scale = parse_int(child_attr(r_pr, "w:w", "w:val").unwrap_or(""), Radix::Ten);
        if w_scale > 0.0 && w_scale != 100.0 {
            run.insert("charScalePct".to_owned(), num(w_scale));
        }
        if let Some(highlight) =
            truthy(child_attr(r_pr, "w:highlight", "w:val")).filter(|h| *h != "none")
        {
            run.insert("highlight".to_owned(), Value::from(highlight));
        }
        let shd_node = r_pr.find_child("w:shd");
        let shd_fill = shd_node.and_then(|shd| shd.attr("w:fill"));
        if let Some(fill) = truthy(shd_fill).filter(|fill| *fill != "auto") {
            run.insert("shading".to_owned(), Value::from(strip_hash(fill)));
        }
        let shd_display = shd_display_fill(shd_node, theme);
        if let Some(display) = truthy(shd_display.as_deref())
            && Some(display) != run.get("shading").and_then(Value::as_str)
        {
            run.insert("shadingDisplay".to_owned(), Value::from(display));
        }
        if let Some(outline) = w14_text_outline_of(r_pr, theme) {
            run.insert("textOutline".to_owned(), json(&outline));
        }
        if let Some(effect) = TEXT_EFFECTS
            .iter()
            .find(|effect| on_off_of(r_pr, &format!("w:{effect}")) == Some(true))
        {
            run.insert("textEffect".to_owned(), Value::from(*effect));
        }
        if let Some(dstrike) = on_off_of(r_pr, "w:dstrike") {
            run.insert("dstrike".to_owned(), Value::Bool(dstrike));
        }
        if let Some(glow) = w14_glow_of(r_pr, theme) {
            run.insert("glow".to_owned(), json(&glow));
        }
        let position = parse_int(
            child_attr(r_pr, "w:position", "w:val").unwrap_or(""),
            Radix::Ten,
        );
        if position != 0.0 && !position.is_nan() {
            run.insert("positionHalfPoints".to_owned(), num(position));
        }
        if let Some(em) = truthy(child_attr(r_pr, "w:em", "w:val")).filter(|em| *em != "none") {
            run.insert("em".to_owned(), Value::from(em));
        }
        if let Some(r_pr_change) = r_pr.find_child("w:rPrChange") {
            let old_r_pr = r_pr_change.find_child("w:rPr");
            let old = old_r_pr
                .map(|old| old_run_properties(old, inherited_rtl, theme))
                .unwrap_or_default();
            let mut change = Map::new();
            change.insert(
                "author".to_owned(),
                Value::from(r_pr_change.attr("w:author").unwrap_or("")),
            );
            for (attr, key) in [
                ("w:date", "date"),
                ("w16du:dateUtc", "dateUtc"),
                ("w:id", "id"),
            ] {
                if let Some(value) = truthy(r_pr_change.attr(attr)) {
                    change.insert(key.to_owned(), Value::from(value));
                }
            }
            if !old.is_empty() {
                change.insert(
                    "old".to_owned(),
                    Value::Object(old.into_iter().filter(|(_, v)| !v.is_null()).collect()),
                );
            }
            if let Some(old_r_pr) = old_r_pr {
                let inner: String = old_r_pr.children().iter().map(serialize).collect();
                change.insert("oldRPr".to_owned(), Value::from(inner));
            }
            run.insert("rPrChange".to_owned(), Value::Object(change));
        }
    }
    // Symbol-encoded fonts: swap the glyph codes for their Unicode equivalents and drop the font
    let direct_h_ansi = r_pr.and_then(|r_pr| {
        let empty = XNode::empty();
        themed_r_fonts(r_pr.find_child("w:rFonts").unwrap_or(&empty), theme_fonts).h_ansi
    });
    let text_now = run
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let sym_font = run
        .get("fontAscii")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(direct_h_ansi)
        .or_else(|| run.get("font").and_then(Value::as_str).map(str::to_owned));
    if let Some(sym_font) = truthy(sym_font.as_deref())
        && !run.contains_key("sym")
        && let Some(decoded) = decode_symbol_text(sym_font, &text_now, true)
    {
        run.insert("text".to_owned(), Value::from(decoded));
        run.shift_remove("font");
        run.shift_remove("fontAscii");
        run.shift_remove("fontCs");
        if let Some(raw) = run.get("rawRPr").and_then(Value::as_str).map(str::to_owned) {
            let stripped = match js_regex!(r"<w:rFonts[^>]*\/>").exec(&raw) {
                Some(found) => format!("{}{}", &raw[..found.start()], &raw[found.end()..]),
                None => raw,
            };
            run.insert("rawRPr".to_owned(), Value::from(stripped));
        }
    }
    let mut built: Run = model_of(Value::Object(run))?;
    if let Some(image) = image_url {
        put_picture_urls(
            &mut built,
            PictureUrls {
                image,
                layers: layer_urls,
            },
        );
    }
    Ok(Some(built))
}
