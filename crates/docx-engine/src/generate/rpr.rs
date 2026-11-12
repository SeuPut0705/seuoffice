//! The run property builders of generate.ts: `RPR_CHILD_ORDER` through
//! `mergeRPrModel`, and `runRPrXml`.

use jscompat::{JsNum, Radix, RegexLimit, js_regex, number_to_string, parse_int};

use super::{escape_xml_attr, split_xml_children};
use crate::model::Run;

/// CT_RPr child sequence (subset), for schema-ordered assembly and merging
pub const RPR_CHILD_ORDER: [&str; 40] = [
    "w:rStyle",
    "w:rFonts",
    "w:b",
    "w:bCs",
    "w:i",
    "w:iCs",
    "w:caps",
    "w:smallCaps",
    "w:strike",
    "w:dstrike",
    "w:outline",
    "w:shadow",
    "w:emboss",
    "w:imprint",
    "w:noProof",
    "w:snapToGrid",
    "w:vanish",
    "w:webHidden",
    "w:color",
    "w:spacing",
    "w:w",
    "w:kern",
    "w:position",
    "w:sz",
    "w:szCs",
    "w:highlight",
    "w:u",
    "w:effect",
    "w:bdr",
    "w:shd",
    "w:fitText",
    "w:vertAlign",
    "w:rtl",
    "w:cs",
    "w:em",
    "w:lang",
    "w:eastAsianLayout",
    "w:specVanish",
    "w:oMath",
    "w:rPrChange",
];

#[derive(Clone, Copy, PartialEq)]
enum Group {
    RStyle,
    RFonts,
    Bold,
    Italic,
    Strike,
    Caps,
    Dstrike,
    TextEffect,
    Vanish,
    Color,
    Spacing,
    Scale,
    Kern,
    Position,
    Size,
    Highlight,
    Underline,
    Shading,
    VertAlign,
    Rtl,
    Em,
    RPrChange,
}

/// rPr children modeled by the run model, grouped by modeled field
const RUN_MANAGED_GROUPS: [(Group, &[&str]); 22] = [
    (Group::RStyle, &["w:rStyle"]),
    (Group::RFonts, &["w:rFonts"]),
    (Group::Bold, &["w:b", "w:bCs"]),
    (Group::Italic, &["w:i", "w:iCs"]),
    (Group::Strike, &["w:strike"]),
    (Group::Caps, &["w:caps", "w:smallCaps"]),
    (Group::Dstrike, &["w:dstrike"]),
    (
        Group::TextEffect,
        &["w:outline", "w:shadow", "w:emboss", "w:imprint"],
    ),
    (Group::Vanish, &["w:vanish"]),
    (Group::Color, &["w:color"]),
    (Group::Spacing, &["w:spacing"]),
    (Group::Scale, &["w:w"]),
    (Group::Kern, &["w:kern"]),
    (Group::Position, &["w:position"]),
    (Group::Size, &["w:sz", "w:szCs"]),
    (Group::Highlight, &["w:highlight"]),
    (Group::Underline, &["w:u"]),
    (Group::Shading, &["w:shd"]),
    (Group::VertAlign, &["w:vertAlign"]),
    (Group::Rtl, &["w:rtl"]),
    (Group::Em, &["w:em"]),
    (Group::RPrChange, &["w:rPrChange"]),
];

struct Child {
    name: &'static str,
    xml: String,
}

fn child(name: &'static str, xml: impl Into<String>) -> Child {
    Child {
        name,
        xml: xml.into(),
    }
}

pub(crate) fn truthy(text: Option<&str>) -> bool {
    text.is_some_and(|t| !t.is_empty())
}

fn num_truthy(n: Option<JsNum>) -> bool {
    n.is_some_and(|n| n.0 != 0.0 && !n.0.is_nan())
}

/// `===` between two numbers that may be undefined
fn num_eq(a: Option<f64>, b: Option<JsNum>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a == b.0,
        _ => false,
    }
}

fn num(n: JsNum) -> String {
    number_to_string(n.0)
}

/// `new RegExp(` ${attr}="([^"]*)"`).exec(xml)?.[1]` for an attribute name
/// without regex syntax: the first ` attr="` that a quote closes.
pub(crate) fn raw_attr<'x>(xml: Option<&'x str>, attr: &str) -> Option<&'x str> {
    let xml = xml.filter(|x| !x.is_empty())?;
    let needle = format!(" {attr}=\"");
    let at = xml.find(&needle)? + needle.len();
    let rest = &xml[at..];
    rest.find('"').map(|end| &rest[..end])
}

pub(crate) fn raw_bool(xml: Option<&str>) -> bool {
    raw_on_off(xml) == Some(true)
}

fn raw_on_off(xml: Option<&str>) -> Option<bool> {
    if !truthy(xml) {
        return None;
    }
    let Some(val) = raw_attr(xml, "w:val") else {
        return Some(true);
    };
    Some(!["0", "false", "none", "off"].contains(&val.to_lowercase().as_str()))
}

fn raw_int(xml: Option<&str>) -> Option<f64> {
    let v = raw_attr(xml, "w:val")?;
    let n = parse_int(v, Radix::Ten);
    if n.is_nan() { None } else { Some(n) }
}

fn raw_caps(caps: Option<&str>, small_caps: Option<&str>) -> Option<&'static str> {
    let c = raw_on_off(caps);
    let sc = raw_on_off(small_caps);
    if c == Some(true) {
        return Some("all");
    }
    if sc == Some(true) {
        return Some("small");
    }
    if c == Some(false) || sc == Some(false) {
        return Some("none");
    }
    None
}

fn on_off_xml(tag: &str, on: bool) -> String {
    if on {
        format!("<{tag}/>")
    } else {
        format!("<{tag} w:val=\"0\"/>")
    }
}

fn fresh_r_fonts_xml(
    font: Option<&str>,
    font_ascii: Option<&str>,
    font_cs: Option<&str>,
    east_asia_font: Option<&str>,
) -> String {
    let legacy = if truthy(font) && font_ascii.is_none() && east_asia_font.is_none() {
        font
    } else {
        None
    };
    let ascii = font_ascii.or(legacy);
    let ea = east_asia_font.or(if font_ascii.is_some() && font == font_ascii {
        None
    } else {
        font
    });
    let cs = font_cs.or(legacy);
    let mut out = String::from("<w:rFonts");
    if let Some(a) = ascii.filter(|a| !a.is_empty()) {
        out.push_str(&format!(" w:ascii=\"{}\"", escape_xml_attr(a)));
    }
    if let Some(e) = ea.filter(|e| !e.is_empty()) {
        out.push_str(&format!(" w:eastAsia=\"{}\"", escape_xml_attr(e)));
    }
    if let Some(a) = ascii.filter(|a| !a.is_empty()) {
        out.push_str(&format!(" w:hAnsi=\"{}\"", escape_xml_attr(a)));
    }
    if let Some(c) = cs.filter(|c| !c.is_empty()) {
        out.push_str(&format!(" w:cs=\"{}\"", escape_xml_attr(c)));
    }
    out.push_str("/>");
    out
}

fn theme_font(run: &Run) -> Option<&str> {
    run.theme_r_fonts.as_ref().and_then(|t| t.font.as_deref())
}

fn theme_font_ascii(run: &Run) -> Option<&str> {
    run.theme_r_fonts
        .as_ref()
        .and_then(|t| t.font_ascii.as_deref())
}

fn merge_r_fonts_xml(raw_xml: &str, run: &Run) -> String {
    // a Map: a key set again keeps its place, a deleted one leaves the order of the rest
    let mut attrs: Vec<(String, String)> = Vec::new();
    for m in js_regex!(r#" ([\w:]+)="([^"]*)""#, "g").find_iter(raw_xml) {
        let key = m.get(1).unwrap_or_default();
        let value = m.get(2).unwrap_or_default().to_owned();
        match attrs.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => attrs.push((key.to_owned(), value)),
        }
    }
    let get = |attrs: &[(String, String)], k: &str| -> Option<String> {
        attrs
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
    };
    let raw_primary = get(&attrs, "w:eastAsia")
        .or_else(|| get(&attrs, "w:ascii"))
        .or_else(|| get(&attrs, "w:hAnsi"));
    let had_east_asia =
        get(&attrs, "w:eastAsia").is_some() || get(&attrs, "w:eastAsiaTheme").is_some();
    let set = |attrs: &mut Vec<(String, String)>, slot: &str, theme: &str, value: &str| {
        let value = escape_xml_attr(value);
        match attrs.iter_mut().find(|(k, _)| k == slot) {
            Some(entry) => entry.1 = value,
            None => attrs.push((slot.to_owned(), value)),
        }
        if let Some(at) = attrs.iter().position(|(k, _)| k == theme) {
            attrs.remove(at);
        }
    };
    if let Some(ascii) = run.font_ascii.as_deref().filter(|a| !a.is_empty())
        && Some(ascii) != theme_font_ascii(run)
    {
        set(&mut attrs, "w:ascii", "w:asciiTheme", ascii);
        set(&mut attrs, "w:hAnsi", "w:hAnsiTheme", ascii);
    }
    if let Some(font) = run.font.as_deref().filter(|f| !f.is_empty())
        && Some(font) != theme_font(run)
        && (had_east_asia || Some(font) != raw_primary.as_deref() || run.east_asia_font.is_some())
    {
        set(&mut attrs, "w:eastAsia", "w:eastAsiaTheme", font);
    }
    if let Some(cs) = run.font_cs.as_deref().filter(|c| !c.is_empty()) {
        set(&mut attrs, "w:cs", "w:cstheme", cs);
    }
    let mut out = String::from("<w:rFonts");
    for (k, v) in &attrs {
        out.push_str(&format!(" {k}=\"{v}\""));
    }
    out.push_str("/>");
    out
}

fn revision_r_pr_change_xml(run: &Run) -> Option<String> {
    let change = run.r_pr_change.as_ref()?;
    let mut attrs = format!(
        " w:id=\"{}\" w:author=\"{}\"",
        escape_xml_attr(change.id.as_deref().unwrap_or("0")),
        escape_xml_attr(&change.author)
    );
    if let Some(date) = change.date.as_deref().filter(|d| !d.is_empty()) {
        attrs.push_str(&format!(" w:date=\"{}\"", escape_xml_attr(date)));
    }
    if let Some(utc) = change.date_utc.as_deref().filter(|d| !d.is_empty()) {
        attrs.push_str(&format!(" w16du:dateUtc=\"{}\"", escape_xml_attr(utc)));
    }
    if let Some(old_r_pr) = change.old_r_pr.as_deref() {
        let r_pr = if old_r_pr.is_empty() {
            "<w:rPr/>".to_owned()
        } else {
            format!("<w:rPr>{old_r_pr}</w:rPr>")
        };
        return Some(format!("<w:rPrChange{attrs}>{r_pr}</w:rPrChange>"));
    }
    let mut props = String::new();
    if let Some(old) = change.old.as_ref() {
        if let Some(s) = old.style_id.as_deref().filter(|s| !s.is_empty()) {
            props.push_str(&format!("<w:rStyle w:val=\"{}\"/>", escape_xml_attr(s)));
        }
        if truthy(old.font.as_deref()) || truthy(old.font_ascii.as_deref()) {
            props.push_str(&fresh_r_fonts_xml(
                old.font.as_deref(),
                old.font_ascii.as_deref(),
                None,
                None,
            ));
        }
        if old.bold == Some(true) {
            props.push_str("<w:b/>");
        }
        if old.italic == Some(true) {
            props.push_str("<w:i/>");
        }
        if old.strike == Some(true) {
            props.push_str("<w:strike/>");
        }
        if let Some(c) = old.color.as_deref().filter(|c| !c.is_empty()) {
            props.push_str(&format!("<w:color w:val=\"{}\"/>", escape_xml_attr(c)));
        }
        if num_truthy(old.char_spacing_twips) {
            props.push_str(&format!(
                "<w:spacing w:val=\"{}\"/>",
                num(old.char_spacing_twips.unwrap())
            ));
        }
        if num_truthy(old.char_scale_pct) {
            props.push_str(&format!(
                "<w:w w:val=\"{}\"/>",
                num(old.char_scale_pct.unwrap())
            ));
        }
        if num_truthy(old.size_half_points) {
            let size = num(old.size_half_points.unwrap());
            props.push_str(&format!("<w:sz w:val=\"{size}\"/>"));
            props.push_str(&format!("<w:szCs w:val=\"{size}\"/>"));
        }
        if let Some(h) = old.highlight.as_deref().filter(|h| !h.is_empty()) {
            props.push_str(&format!("<w:highlight w:val=\"{}\"/>", escape_xml_attr(h)));
        }
        if old.underline == Some(true) {
            props.push_str("<w:u w:val=\"single\"/>");
        }
        if let Some(v) = old.vert_align.as_ref() {
            props.push_str(&format!("<w:vertAlign w:val=\"{}\"/>", v.as_str()));
        }
    }
    Some(format!(
        "<w:rPrChange{attrs}><w:rPr>{props}</w:rPr></w:rPrChange>"
    ))
}

fn link_plain(run: &Run) -> bool {
    run.link.as_ref().is_some_and(|l| l.plain == Some(true))
}

/// Fresh rPr children for the modeled fields
fn model_r_pr_children(run: &Run, inside_link: bool) -> Vec<Child> {
    let mut out = Vec::new();
    let style_id = run
        .style_id
        .as_deref()
        .or(if inside_link && !link_plain(run) {
            Some("Hyperlink")
        } else {
            None
        });
    if let Some(s) = style_id.filter(|s| !s.is_empty()) {
        out.push(child(
            "w:rStyle",
            format!("<w:rStyle w:val=\"{}\"/>", escape_xml_attr(s)),
        ));
    }
    if truthy(run.font.as_deref())
        || truthy(run.font_ascii.as_deref())
        || truthy(run.font_cs.as_deref())
    {
        out.push(child(
            "w:rFonts",
            fresh_r_fonts_xml(
                run.font.as_deref(),
                run.font_ascii.as_deref(),
                run.font_cs.as_deref(),
                run.east_asia_font.as_deref(),
            ),
        ));
    }
    if *run.bold == Some(true) {
        out.push(child("w:b", "<w:b/>"));
        out.push(child("w:bCs", "<w:bCs/>"));
    }
    if *run.italic == Some(true) {
        out.push(child("w:i", "<w:i/>"));
        out.push(child("w:iCs", "<w:iCs/>"));
    }
    if *run.strike == Some(true) {
        out.push(child("w:strike", "<w:strike/>"));
    }
    match run.caps.as_ref().map(|c| c.as_str()) {
        Some("all") => out.push(child("w:caps", "<w:caps/>")),
        Some("small") => out.push(child("w:smallCaps", "<w:smallCaps/>")),
        Some("none") => {
            out.push(child("w:caps", on_off_xml("w:caps", false)));
            out.push(child("w:smallCaps", on_off_xml("w:smallCaps", false)));
        }
        _ => {}
    }
    if let Some(d) = *run.dstrike {
        out.push(child("w:dstrike", on_off_xml("w:dstrike", d)));
    }
    if let Some(effect) = run.text_effect.as_ref() {
        let tag = match effect.as_str() {
            "outline" => "w:outline",
            "emboss" => "w:emboss",
            "imprint" => "w:imprint",
            _ => "w:shadow",
        };
        out.push(child(tag, format!("<{tag}/>")));
    }
    if let Some(v) = *run.vanish_own {
        out.push(child("w:vanish", on_off_xml("w:vanish", v)));
    }
    if let Some(c) = run.color.as_deref().filter(|c| !c.is_empty()) {
        out.push(child(
            "w:color",
            format!("<w:color w:val=\"{}\"/>", escape_xml_attr(c)),
        ));
    }
    if let Some(s) = *run.char_spacing_twips {
        out.push(child(
            "w:spacing",
            format!("<w:spacing w:val=\"{}\"/>", num(s)),
        ));
    }
    if num_truthy(*run.char_scale_pct) {
        out.push(child(
            "w:w",
            format!("<w:w w:val=\"{}\"/>", num(run.char_scale_pct.unwrap())),
        ));
    }
    if let Some(k) = *run.kern_half_points {
        out.push(child("w:kern", format!("<w:kern w:val=\"{}\"/>", num(k))));
    }
    if num_truthy(*run.position_half_points) {
        out.push(child(
            "w:position",
            format!(
                "<w:position w:val=\"{}\"/>",
                num(run.position_half_points.unwrap())
            ),
        ));
    }
    if num_truthy(*run.size_half_points) {
        let size = num(run.size_half_points.unwrap());
        out.push(child("w:sz", format!("<w:sz w:val=\"{size}\"/>")));
        out.push(child("w:szCs", format!("<w:szCs w:val=\"{size}\"/>")));
    }
    if let Some(h) = run.highlight.as_deref().filter(|h| !h.is_empty()) {
        out.push(child(
            "w:highlight",
            format!("<w:highlight w:val=\"{}\"/>", escape_xml_attr(h)),
        ));
    }
    if *run.underline == Some(true) {
        out.push(child("w:u", "<w:u w:val=\"single\"/>"));
    }
    if let Some(s) = run.shading.as_deref().filter(|s| !s.is_empty()) {
        out.push(child(
            "w:shd",
            format!(
                "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>",
                escape_xml_attr(s)
            ),
        ));
    }
    if let Some(v) = run.vert_align.as_ref() {
        out.push(child(
            "w:vertAlign",
            format!("<w:vertAlign w:val=\"{}\"/>", v.as_str()),
        ));
    }
    if *run.rtl == Some(true) {
        out.push(child("w:rtl", "<w:rtl/>"));
    }
    if let Some(em) = run.em.as_ref() {
        out.push(child("w:em", format!("<w:em w:val=\"{}\"/>", em.as_str())));
    }
    if let Some(change) = revision_r_pr_change_xml(run) {
        out.push(child("w:rPrChange", change));
    }
    out
}

/// `s.slice(start, end)` of JavaScript, in UTF-16 code units.
pub(crate) fn js_slice(s: &str, start: i64, end: i64) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let len = units.len() as i64;
    let clamp = |i: i64| if i < 0 { (len + i).max(0) } else { i.min(len) };
    let (from, to) = (clamp(start), clamp(end));
    if from >= to {
        return String::new();
    }
    String::from_utf16_lossy(&units[from as usize..to as usize])
}

fn rank(name: &str) -> i64 {
    RPR_CHILD_ORDER
        .iter()
        .position(|n| *n == name)
        .map_or(-1, |i| i as i64)
}

/// Merge the raw rPr slice with the run model
pub fn merge_r_pr_model(
    raw_r_pr: &str,
    run: &Run,
    inside_link: bool,
) -> Result<String, RegexLimit> {
    let open = js_regex!(r"^<w:rPr(?: [^>]*)?>")
        .exec(raw_r_pr)
        .map(|m| m.as_str());
    let fresh = model_r_pr_children(run, inside_link);
    let Some(open) = open else {
        if fresh.is_empty() {
            return Ok(String::new());
        }
        let joined: String = fresh.iter().map(|c| c.xml.as_str()).collect();
        return Ok(format!("<w:rPr>{joined}</w:rPr>"));
    };
    let open_len = open.encode_utf16().count() as i64;
    let raw_len = raw_r_pr.encode_utf16().count() as i64;
    let inner = js_slice(raw_r_pr, open_len, raw_len - "</w:rPr>".len() as i64);
    let raw_children = split_xml_children(&inner)?;
    let raw_of = |tag: &str| -> Option<&str> {
        raw_children
            .iter()
            .find(|(name, _)| name == tag)
            .map(|(_, xml)| xml.as_str())
    };
    // the model's own w:rtl decides first
    let cs = (*run.rtl).unwrap_or_else(|| *run.cs == Some(true) || raw_bool(raw_of("w:rtl")));

    let mut fresh_by_group: Vec<Vec<Child>> =
        RUN_MANAGED_GROUPS.iter().map(|_| Vec::new()).collect();
    for f in fresh {
        let g = RUN_MANAGED_GROUPS
            .iter()
            .position(|(_, tags)| tags.contains(&f.name))
            .expect("every modeled child has a group");
        fresh_by_group[g].push(f);
    }
    let theme_font = theme_font(run);
    let theme_font_ascii = theme_font_ascii(run);
    let group_equal = |group: Group| -> bool {
        match group {
            Group::RStyle => {
                let raw = raw_attr(raw_of("w:rStyle"), "w:val");
                if let Some(s) = run.style_id.as_deref().filter(|s| !s.is_empty()) {
                    return raw == Some(s);
                }
                match raw {
                    None => {
                        !inside_link
                            || run.link.as_ref().is_some_and(|l| truthy(l.r_id.as_deref()))
                            || link_plain(run)
                    }
                    Some(raw) => raw == "Hyperlink",
                }
            }
            Group::RFonts => {
                let attrs = raw_of("w:rFonts");
                let ascii = raw_attr(attrs, "w:ascii").or(raw_attr(attrs, "w:hAnsi"));
                let font = run.font.as_deref();
                let font_ascii = run.font_ascii.as_deref();
                (raw_attr(attrs, "w:eastAsia").or(ascii) == font
                    || (font.is_some() && font == theme_font))
                    && (ascii == font_ascii
                        || (font_ascii.is_some() && font_ascii == theme_font_ascii))
                    && (run.east_asia_font.is_none()
                        || raw_attr(attrs, "w:eastAsia") == run.east_asia_font.as_deref()
                        || run.east_asia_font.as_deref() == theme_font)
                    && (run.font_cs.is_none() || raw_attr(attrs, "w:cs") == run.font_cs.as_deref())
            }
            Group::Bold => {
                raw_bool(raw_of(if cs { "w:bCs" } else { "w:b" })) == (*run.bold == Some(true))
            }
            Group::Italic => {
                raw_bool(raw_of(if cs { "w:iCs" } else { "w:i" })) == (*run.italic == Some(true))
            }
            Group::Strike => raw_bool(raw_of("w:strike")) == (*run.strike == Some(true)),
            Group::Caps => {
                raw_caps(raw_of("w:caps"), raw_of("w:smallCaps"))
                    == run.caps.as_ref().map(|c| c.as_str())
            }
            Group::Dstrike => raw_bool(raw_of("w:dstrike")) == (*run.dstrike == Some(true)),
            Group::TextEffect => {
                // absent from the model is untouched, as for vanish
                run.text_effect.as_ref().is_none_or(|effect| {
                    ["outline", "emboss", "imprint", "shadow"]
                        .into_iter()
                        .find(|e| raw_bool(raw_of(&format!("w:{e}"))))
                        == Some(effect.as_str())
                })
            }
            Group::Em => {
                let raw = raw_attr(raw_of("w:em"), "w:val").filter(|raw| *raw != "none");
                run.em.as_ref().is_none_or(|em| raw == Some(em.as_str()))
            }
            Group::Vanish => {
                run.vanish_own.is_none() || raw_on_off(raw_of("w:vanish")) == *run.vanish_own
            }
            Group::Spacing => num_eq(raw_int(raw_of("w:spacing")), *run.char_spacing_twips),
            Group::Scale => {
                let raw = raw_int(raw_of("w:w")).filter(|r| *r != 0.0 && *r != 100.0);
                num_eq(raw, *run.char_scale_pct)
            }
            Group::Kern => {
                let raw = raw_attr(raw_of("w:kern"), "w:val").map(|r| {
                    let n = parse_int(r, Radix::Ten);
                    if n.is_nan() || n == 0.0 { 0.0 } else { n }
                });
                num_eq(raw, *run.kern_half_points)
            }
            Group::Position => num_eq(
                raw_int(raw_of("w:position")).filter(|n| *n != 0.0),
                *run.position_half_points,
            ),
            Group::Color => {
                let raw = raw_attr(raw_of("w:color"), "w:val");
                raw == run.color.as_deref()
                    || (run.theme_color.is_some() && *run.color == *run.theme_color)
            }
            Group::Size => {
                let raw = raw_attr(raw_of(if cs { "w:szCs" } else { "w:sz" }), "w:val");
                let raw = raw.filter(|r| !r.is_empty()).and_then(|r| {
                    let n = parse_int(r, Radix::Ten);
                    if n.is_nan() || n == 0.0 {
                        None
                    } else {
                        Some(n)
                    }
                });
                num_eq(raw, *run.size_half_points)
            }
            Group::Highlight => {
                let raw = raw_attr(raw_of("w:highlight"), "w:val").filter(|r| *r != "none");
                raw == run.highlight.as_deref()
            }
            Group::Shading => {
                let raw =
                    raw_attr(raw_of("w:shd"), "w:fill").filter(|r| !r.is_empty() && *r != "auto");
                raw == run.shading.as_deref()
            }
            Group::Underline => {
                let val = raw_attr(raw_of("w:u"), "w:val");
                (val.is_some() && val != Some("none")) == (*run.underline == Some(true))
            }
            Group::VertAlign => {
                let raw = raw_attr(raw_of("w:vertAlign"), "w:val");
                let modeled = raw.filter(|r| *r == "superscript" || *r == "subscript");
                modeled == run.vert_align.as_ref().map(|v| v.as_str())
            }
            Group::Rtl => raw_bool(raw_of("w:rtl")) == (*run.rtl == Some(true)),
            Group::RPrChange => truthy(raw_of("w:rPrChange")) == run.r_pr_change.is_some(),
        }
    };
    let mut rebuilt_tags: Vec<&str> = Vec::new();
    let mut fresh_out: Vec<Child> = Vec::new();
    for (index, (group, tags)) in RUN_MANAGED_GROUPS.iter().enumerate() {
        if group_equal(*group) {
            continue;
        }
        rebuilt_tags.extend_from_slice(tags);
        let raw_r_fonts = if *group == Group::RFonts {
            raw_of("w:rFonts")
        } else {
            None
        };
        if let Some(raw_r_fonts) = raw_r_fonts.filter(|r| !r.is_empty())
            && (truthy(run.font.as_deref()) || truthy(run.font_ascii.as_deref()))
        {
            fresh_out.push(child("w:rFonts", merge_r_fonts_xml(raw_r_fonts, run)));
        } else {
            fresh_out.append(&mut fresh_by_group[index]);
        }
    }

    let mut parts = String::new();
    let mut any = false;
    let mut fi = 0;
    let mut prev_rank = -1;
    for (name, xml) in raw_children
        .iter()
        .filter(|(name, _)| !rebuilt_tags.contains(&name.as_str()))
    {
        let own = rank(name);
        let effective = if own == -1 {
            prev_rank
        } else {
            own.max(prev_rank)
        };
        while fi < fresh_out.len() && rank(fresh_out[fi].name) < effective {
            parts.push_str(&fresh_out[fi].xml);
            fi += 1;
        }
        parts.push_str(xml);
        any = true;
        prev_rank = effective;
    }
    while fi < fresh_out.len() {
        parts.push_str(&fresh_out[fi].xml);
        fi += 1;
        any = true;
    }
    if !any {
        return Ok(String::new());
    }
    Ok(format!("{open}{parts}</w:rPr>"))
}

pub(crate) fn run_r_pr_xml(run: &Run, inside_link: bool) -> Result<String, RegexLimit> {
    if let Some(raw) = run.raw_r_pr.as_deref() {
        return merge_r_pr_model(raw, run, inside_link);
    }
    let props: String = model_r_pr_children(run, inside_link)
        .iter()
        .map(|c| c.xml.as_str())
        .collect();
    Ok(if props.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{props}</w:rPr>")
    })
}
