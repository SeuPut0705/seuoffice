//! `text/styles.ts`: style tables both ways.
//!
//! Forward: ODF common paragraph styles become docx paragraph styles (same
//! display names, `basedOn` following the parent chain), the default style
//! becomes `w:docDefaults`. Tab stops are not put into docx styles: ODF
//! replaces a parent's tab list while OOXML merges it, so paragraphs carry
//! their effective tab list directly. Synthetic `Heading1..6` and `Hyperlink`
//! styles are added when the ODT has none, so the editor's heading and link
//! commands have styles to reference.
//!
//! Reverse: a docx style whose XML differs from what the bridge wrote is
//! diffed property by property and only the changed attributes are patched into
//! the ODF common style, in place, keeping its (Hancom) name and every other
//! byte.

use std::rc::Rc;

use docx_engine::model::{
    GeneratedBlock, ParaAlign, ParaFormat, ParaFormatLineRule, Run, RunCaps, RunVertAlign,
};
use jscompat::{
    JsMap, JsNum, JsObject, Radix, is_js_space, js_regex, number_truthy, parse_int,
    replace_first_string,
};

use crate::core::convert::{BridgeMap, BridgeStyleEntry, OdfToOoxmlContext, OoxmlToOdfContext};
use crate::core::errors::OdtError;
use crate::core::styles::{OdtStyle, OdtStyleKind, OdtStylePart};
use crate::core::xml::{PrefixMap, decode_xml_entities, escape_xml_attr, slice};

use super::paragraph_model::paragraph_block;
use super::props::{
    AttrOverrides, TextFormat, changed_para_keys, changed_text_keys, para_format_from_odf,
    para_keys, para_overrides, text_format_from_odf, text_keys, text_overrides,
};
use super::style_xml::{StyleXmlEdit, edit_style_xml};
use super::units::twips;

// ---------------------------------------------------------------------------
// OOXML property fragments written by the docx engine's own generator

/// `ooxmlPPr`: the `<w:pPr>...</w:pPr>` the engine writes for a paragraph shape
/// (`""` when empty). The block's runs are ignored (`Omit<GeneratedBlock, 'runs'>`).
pub fn ooxml_p_pr(ctx: &mut OdfToOoxmlContext, block: &GeneratedBlock) -> Result<String, OdtError> {
    let mut with_no_runs = block.clone();
    with_no_runs.runs = Vec::new();
    let xml = ctx.generate_paragraph_xml(&with_no_runs)?;
    // `/^<w:p>(<w:pPr>[\s\S]*<\/w:pPr>)<\/w:p>$/`
    if xml.len() >= 26 && xml.starts_with("<w:p><w:pPr>") && xml.ends_with("</w:pPr></w:p>") {
        Ok(xml[5..xml.len() - 6].to_owned())
    } else {
        Ok(String::new())
    }
}

/// `ooxmlRPr`: the `<w:rPr>...</w:rPr>` the engine writes for run formatting
/// (`""` when empty).
pub fn ooxml_r_pr(ctx: &mut OdfToOoxmlContext, format: &TextFormat) -> Result<String, OdtError> {
    let mut run = Run::default();
    run.text.set("x".to_owned());
    run.assign(format);
    let xml = ctx.generate_paragraph_xml(&paragraph_block(vec![run]))?;
    // `/<w:rPr>[\s\S]*?<\/w:rPr>/`
    let mut from = 0usize;
    while let Some(found) = xml[from..].find("<w:rPr>") {
        let at = from + found;
        if let Some(close) = xml[at + 7..].find("</w:rPr>") {
            return Ok(xml[at..at + 7 + close + 8].to_owned());
        }
        from = at + 1;
    }
    Ok(String::new())
}

// ---------------------------------------------------------------------------
// Style id lookup

/// `styleEntryForOdf`: the docx style mirroring an ODF common paragraph style,
/// if any. The TypeScript caches a name table built once; the last entry of a
/// name wins in it, as it does here.
pub fn style_entry_for_odf<'a>(
    map: &'a BridgeMap,
    odf_name: Option<&str>,
) -> Option<&'a BridgeStyleEntry> {
    let odf_name = odf_name?;
    map.styles
        .paragraph
        .iter()
        .rev()
        .find(|e| e.odf_name.as_deref() == Some(odf_name))
}

/// `styleEntryById`
pub fn style_entry_by_id<'a>(
    map: &'a BridgeMap,
    style_id: Option<&str>,
) -> Option<&'a BridgeStyleEntry> {
    let style_id = style_id.filter(|s| !s.is_empty())?;
    map.styles.paragraph.iter().find(|e| e.style_id == style_id)
}

// ---------------------------------------------------------------------------
// Minimal OOXML property readers (style definitions and docDefaults)

/// `tagOf`: the first `<name ...>` start tag of `xml` (the pattern
/// `<name(?=[\s/>])[^>]*>`, written as a scan: the class stops at the first `>`).
fn tag_of<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("<{name}");
    let mut from = 0usize;
    while let Some(found) = xml[from..].find(&needle) {
        let at = from + found;
        let after = at + needle.len();
        let next = xml[after..].chars().next();
        if next.is_some_and(|c| is_js_space(c) || c == '/' || c == '>') {
            // `[^>]*>`: up to the first `>`; none means no later start matches either
            let gt = xml[after..].find('>')?;
            return Some(&xml[at..=after + gt]);
        }
        from = at + 1;
    }
    None
}

/// `attrOf`: the value of attribute `name` in a start tag, entity-decoded (the
/// pattern `\sname\s*=\s*(?:"([^"]*)"|'([^']*)')`).
fn attr_of(tag: Option<&str>, name: &str) -> Option<String> {
    let tag = tag?;
    let mut from = 0usize;
    while let Some((at, space)) = tag[from..]
        .char_indices()
        .find(|(_, c)| is_js_space(*c))
        .map(|(i, c)| (from + i, c))
    {
        from = at + space.len_utf8();
        let Some(rest) = tag[from..].strip_prefix(name) else {
            continue;
        };
        let rest = rest.trim_start_matches(is_js_space);
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start_matches(is_js_space);
        let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            continue;
        };
        let inner = &rest[1..];
        if let Some(end) = inner.find(quote) {
            return Some(decode_xml_entities(&inner[..end]));
        }
    }
    None
}

/// `onOff`
fn on_off(tag: Option<&str>) -> Option<bool> {
    let tag = tag?;
    let v = attr_of(Some(tag), "w:val");
    Some(match v {
        None => true,
        Some(v) => !["0", "false", "off", "none"].contains(&v.to_lowercase().as_str()),
    })
}

/// `int`
fn int(v: Option<&str>) -> Option<f64> {
    let n = v.map_or(f64::NAN, |v| parse_int(v, Radix::Ten));
    if n.is_finite() { Some(n) } else { None }
}

/// `readOoxmlPPr`: paragraph formatting of a `w:pPr` (the subset the bridge maps).
pub fn read_ooxml_p_pr(p_pr: &str) -> ParaFormat {
    let mut f = ParaFormat::default();
    let jc = attr_of(tag_of(p_pr, "w:jc"), "w:val");
    if let Some(jc) = jc.filter(|v| !v.is_empty()) {
        f.align.set(match jc.as_str() {
            "both" => ParaAlign::Justify,
            "distribute" => ParaAlign::Distribute,
            "center" => ParaAlign::Center,
            "right" | "end" => ParaAlign::Right,
            _ => ParaAlign::Left,
        });
    }
    let ind = tag_of(p_pr, "w:ind");
    let left = int(attr_of(ind, "w:left")
        .or_else(|| attr_of(ind, "w:start"))
        .as_deref());
    if let Some(left) = left {
        f.indent_left.set(JsNum(left));
    }
    let right = int(attr_of(ind, "w:right")
        .or_else(|| attr_of(ind, "w:end"))
        .as_deref());
    if let Some(right) = right {
        f.indent_right.set(JsNum(right));
    }
    let hanging = int(attr_of(ind, "w:hanging").as_deref());
    let first_line = int(attr_of(ind, "w:firstLine").as_deref());
    if let Some(hanging) = hanging {
        f.indent_first_line.set(JsNum(-hanging));
    } else if let Some(first_line) = first_line {
        f.indent_first_line.set(JsNum(first_line));
    }
    let sp = tag_of(p_pr, "w:spacing");
    if let Some(before) = int(attr_of(sp, "w:before").as_deref()) {
        f.space_before.set(JsNum(before));
    }
    if let Some(after) = int(attr_of(sp, "w:after").as_deref()) {
        f.space_after.set(JsNum(after));
    }
    let line = int(attr_of(sp, "w:line").as_deref());
    let rule = attr_of(sp, "w:lineRule");
    if let Some(line) = line {
        match rule.as_deref() {
            Some("exact") => {
                f.line_rule.set(ParaFormatLineRule::Exact);
                f.line_raw_twips.set(JsNum(line));
            }
            Some("atLeast") => {
                f.line_rule.set(ParaFormatLineRule::AtLeast);
                f.line_raw_twips.set(JsNum(line));
            }
            _ => {
                f.line_rule.set(ParaFormatLineRule::Auto);
                f.line_spacing.set(JsNum(line / 240.0));
            }
        }
    }
    if on_off(tag_of(p_pr, "w:keepNext")) == Some(true) {
        f.keep_next.set(true);
    }
    if on_off(tag_of(p_pr, "w:keepLines")) == Some(true) {
        f.keep_lines.set(true);
    }
    if on_off(tag_of(p_pr, "w:pageBreakBefore")) == Some(true) {
        f.page_break_before.set(true);
    }
    let fill = attr_of(tag_of(p_pr, "w:shd"), "w:fill");
    if let Some(fill) = fill.filter(|v| !v.is_empty() && v != "auto") {
        f.shading_fill.set(fill.to_uppercase());
    }
    f
}

/// `readOoxmlRPr`: run formatting of a `w:rPr` (the subset the bridge maps).
pub fn read_ooxml_r_pr(r_pr: &str) -> TextFormat {
    let mut f = TextFormat::default();
    let fonts = tag_of(r_pr, "w:rFonts");
    let ascii = attr_of(fonts, "w:ascii").or_else(|| attr_of(fonts, "w:hAnsi"));
    let ea = attr_of(fonts, "w:eastAsia");
    let cs = attr_of(fonts, "w:cs");
    if let Some(ascii) = ascii.as_ref().filter(|v| !v.is_empty()) {
        f.font_ascii.set(ascii.clone());
    }
    if let Some(ea) = ea.as_ref().filter(|v| !v.is_empty()) {
        f.east_asia_font.set(ea.clone());
    }
    if let Some(font) = ea.as_ref().or(ascii.as_ref()).filter(|v| !v.is_empty()) {
        f.font.set(font.clone());
    }
    if let Some(cs) = cs.filter(|v| !v.is_empty()) {
        f.font_cs.set(cs);
    }
    if let Some(b) = on_off(tag_of(r_pr, "w:b")) {
        f.bold.set(b);
    }
    if let Some(i) = on_off(tag_of(r_pr, "w:i")) {
        f.italic.set(i);
    }
    if let Some(u) = attr_of(tag_of(r_pr, "w:u"), "w:val") {
        f.underline.set(u != "none");
    }
    if let Some(s) = on_off(tag_of(r_pr, "w:strike")) {
        f.strike.set(s);
    }
    let color = attr_of(tag_of(r_pr, "w:color"), "w:val");
    if let Some(color) = color.filter(|v| !v.is_empty() && v != "auto") {
        f.color.set(color.to_uppercase());
    }
    let sz = int(attr_of(tag_of(r_pr, "w:sz"), "w:val").as_deref());
    if let Some(sz) = sz.filter(|v| number_truthy(*v)) {
        f.size_half_points.set(JsNum(sz));
    }
    let hl = attr_of(tag_of(r_pr, "w:highlight"), "w:val");
    if let Some(hl) = hl.filter(|v| !v.is_empty() && v != "none") {
        f.highlight.set(hl);
    }
    let shd = attr_of(tag_of(r_pr, "w:shd"), "w:fill");
    if let Some(shd) = shd.filter(|v| !v.is_empty() && v != "auto") {
        f.shading.set(shd.to_uppercase());
    }
    match attr_of(tag_of(r_pr, "w:vertAlign"), "w:val").as_deref() {
        Some("superscript") => f.vert_align.set(RunVertAlign::Superscript),
        Some("subscript") => f.vert_align.set(RunVertAlign::Subscript),
        _ => {}
    }
    if let Some(spc) = int(attr_of(tag_of(r_pr, "w:spacing"), "w:val").as_deref()) {
        f.char_spacing_twips.set(JsNum(spc));
    }
    let w = int(attr_of(tag_of(r_pr, "w:w"), "w:val").as_deref());
    if let Some(w) = w.filter(|v| number_truthy(*v) && *v != 100.0) {
        f.char_scale_pct.set(JsNum(w));
    }
    if on_off(tag_of(r_pr, "w:caps")) == Some(true) {
        f.caps.set(RunCaps::All);
    } else if on_off(tag_of(r_pr, "w:smallCaps")) == Some(true) {
        f.caps.set(RunCaps::Small);
    }
    f
}

/// `firstBlock`: the first `<name ...>...</name>` of `xml`, or `""` (the pattern
/// `<name(?:\s[^>]*)?>[\s\S]*?</name>`).
fn first_block<'a>(xml: &'a str, name: &str) -> &'a str {
    let needle = format!("<{name}");
    let closing = format!("</{name}>");
    let mut from = 0usize;
    while let Some(found) = xml[from..].find(&needle) {
        let at = from + found;
        let after = at + needle.len();
        let open_end = match xml[after..].chars().next() {
            Some('>') => Some(after + 1),
            Some(c) if is_js_space(c) => xml[after..].find('>').map(|gt| after + gt + 1),
            _ => None,
        };
        if let Some(open_end) = open_end {
            if let Some(close) = xml[open_end..].find(&closing) {
                return &xml[at..open_end + close + closing.len()];
            }
        }
        from = at + 1;
    }
    ""
}

/// `docxStylesById`: `w:style` elements of a styles.xml by style id (exact XML).
pub fn docx_styles_by_id(styles_xml: &str) -> JsMap<String> {
    // the pattern `<w:style(?=[\s>/])[^>]*?(?:\/>|>[\s\S]*?<\/w:style>)`, matched
    // from each `<w:style` in turn: the lazy class cannot pass the first `>`
    let mut out = JsMap::new();
    let mut from = 0usize;
    while let Some(found) = styles_xml[from..].find("<w:style") {
        let at = from + found;
        let after = at + "<w:style".len();
        let next = styles_xml[after..].chars().next();
        let mut matched_end: Option<usize> = None;
        if next.is_some_and(|c| is_js_space(c) || c == '>' || c == '/') {
            if let Some(gt) = styles_xml[after..].find('>').map(|g| after + g) {
                if gt > after && styles_xml.as_bytes()[gt - 1] == b'/' {
                    matched_end = Some(gt + 1);
                } else if let Some(close) = styles_xml[gt + 1..].find("</w:style>") {
                    matched_end = Some(gt + 1 + close + "</w:style>".len());
                }
            }
        }
        let Some(end) = matched_end else {
            from = at + 1;
            continue;
        };
        let whole = &styles_xml[at..end];
        // `/^<w:style[^>]*>/`: the start tag of the match
        let head = whole.find('>').map(|gt| &whole[..=gt]);
        if let Some(id) = attr_of(head, "w:styleId") {
            if !out.has(&id) {
                out.set(id, whole.to_owned());
            }
        }
        from = end;
    }
    out
}

// ---------------------------------------------------------------------------
// Forward

/// `HEADING_SIZES`
const HEADING_SIZES: [u32; 6] = [32, 28, 26, 24, 22, 22];

/// `take`: marks `id` used (case-insensitive) and returns it.
fn take(used: &mut std::collections::HashSet<String>, id: String) -> String {
    used.insert(id.to_lowercase());
    id
}

/// `convertOdtStyles`: writes the docx styles and docDefaults for the ODT's
/// common styles into `ctx.docx`.
pub fn convert_odt_styles(ctx: &mut OdfToOoxmlContext) -> Result<(), OdtError> {
    let doc = Rc::clone(&ctx.doc);
    let info = ctx.part(OdtStylePart::StylesXml);
    let commons: Vec<Rc<OdtStyle>> = doc
        .styles
        .all
        .iter()
        .filter(|s| {
            s.kind == OdtStyleKind::Style
                && s.family.as_deref() == Some("paragraph")
                && !s.automatic
        })
        .cloned()
        .collect();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let is_free =
        |used: &std::collections::HashSet<String>, id: &str| !used.contains(&id.to_lowercase());
    let mut ids: JsMap<String> = JsMap::new();
    let standard = commons.iter().find(|s| s.name == "Standard");
    if let Some(standard) = standard {
        let id = take(&mut used, "Normal".to_owned());
        ids.set(standard.name.clone(), id);
    } else {
        take(&mut used, "Normal".to_owned());
    }
    for s in &commons {
        let display = s.display_name.as_deref().unwrap_or("");
        let m = js_regex!(r"^Heading_20_([1-9])$")
            .exec(&s.name)
            .or_else(|| js_regex!(r"^Heading ([1-9])$").exec(display))
            .or_else(|| js_regex!(r"^Heading([1-9])$").exec(&s.name));
        if let Some(m) = m {
            let digit = m.get(1).unwrap_or("");
            let heading = format!("Heading{digit}");
            if !ids.has(&s.name) && is_free(&used, &heading) {
                let id = take(&mut used, heading);
                ids.set(s.name.clone(), id);
            }
        }
    }
    for level in 1..=6 {
        let heading = format!("Heading{level}");
        if is_free(&used, &heading) && !ids.values().any(|v| *v == heading) {
            // reserve for the synthetic heading styles below
            used.insert(format!("heading{level}"));
        }
    }
    take(&mut used, "Hyperlink".to_owned());
    let mut seq = 0usize;
    for s in &commons {
        if ids.has(&s.name) {
            continue;
        }
        let mut id: String = s.name.chars().filter(char::is_ascii_alphanumeric).collect();
        if !id.chars().any(|c| c.is_ascii_alphabetic()) || !is_free(&used, &id) {
            loop {
                seq += 1;
                id = format!("OdtStyle{seq}");
                if is_free(&used, &id) {
                    break;
                }
            }
        }
        let id = take(&mut used, id);
        ids.set(s.name.clone(), id);
    }

    let mut entries: Vec<BridgeStyleEntry> = Vec::new();
    for s in &commons {
        let id = ids.get(&s.name).cloned().unwrap_or_default();
        let parent = s.parent_name.as_ref().and_then(|p| ids.get(p).cloned());
        let next = s.next_style_name.as_ref().and_then(|n| ids.get(n).cloned());
        let level = js_regex!(r"^Heading([1-9])$")
            .exec(&id)
            .and_then(|m| m.get(1))
            .map(str::to_owned);
        let mut block = paragraph_block(Vec::new());
        block.format = Some(para_format_from_odf(
            &s.properties
                .get("style:paragraph-properties")
                .cloned()
                .unwrap_or_default(),
            None,
            0.0,
        ));
        let p_pr = ooxml_p_pr(ctx, &block)?;
        let outline = match &level {
            Some(l) => format!(
                "<w:outlineLvl w:val=\"{}\"/>",
                l.parse::<u32>().unwrap_or(1) - 1
            ),
            None => String::new(),
        };
        let p_pr_with_outline = if outline.is_empty() {
            p_pr
        } else if !p_pr.is_empty() {
            replace_first_string(&p_pr, "</w:pPr>", &format!("{outline}</w:pPr>"))
        } else {
            format!("<w:pPr>{outline}</w:pPr>")
        };
        let r_pr = ooxml_r_pr(
            ctx,
            &text_format_from_odf(
                &s.properties
                    .get("style:text-properties")
                    .cloned()
                    .unwrap_or_default(),
                &info.font_faces,
            ),
        )?;
        let name = if id == "Normal" {
            "Normal".to_owned()
        } else if let Some(l) = &level {
            format!("heading {l}")
        } else {
            s.display_name.clone().unwrap_or_else(|| s.name.clone())
        };
        let xml = format!(
            "<w:style w:type=\"paragraph\"{} w:styleId=\"{}\"><w:name w:val=\"{}\"/>{}{}<w:qFormat/>{p_pr_with_outline}{r_pr}</w:style>",
            if id == "Normal" {
                " w:default=\"1\""
            } else {
                ""
            },
            escape_xml_attr(&id),
            escape_xml_attr(&name),
            match &parent {
                Some(parent) if !parent.is_empty() && *parent != id =>
                    format!("<w:basedOn w:val=\"{}\"/>", escape_xml_attr(parent)),
                _ => String::new(),
            },
            match &next {
                Some(next) if !next.is_empty() =>
                    format!("<w:next w:val=\"{}\"/>", escape_xml_attr(next)),
                _ => String::new(),
            },
        );
        entries.push(BridgeStyleEntry {
            style_id: id,
            odf_name: Some(s.name.clone()),
            heading_level: None,
            xml,
        });
    }
    if standard.is_none() {
        entries.insert(
            0,
            BridgeStyleEntry {
                style_id: "Normal".to_owned(),
                odf_name: None,
                heading_level: None,
                xml: "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>".to_owned(),
            },
        );
    }
    for level in 1..=6u32 {
        let id = format!("Heading{level}");
        if entries.iter().any(|e| e.style_id == id) {
            continue;
        }
        let size = HEADING_SIZES[level as usize - 1];
        entries.push(BridgeStyleEntry {
            xml: format!(
                "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"heading {level}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"120\"/><w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/></w:rPr></w:style>",
                level - 1
            ),
            style_id: id,
            odf_name: None,
            heading_level: Some(level),
        });
    }
    for e in &entries {
        if let Some(m) = js_regex!(r"^Heading([1-9])$").exec(&e.style_id) {
            let n = m.get(1).unwrap_or("0").parse::<f64>().unwrap_or(0.0);
            if !ctx.heading_style_ids.0.iter().any(|(k, _)| k.0 == n) {
                ctx.heading_style_ids.0.push((JsNum(n), e.style_id.clone()));
            }
        }
    }
    ctx.docx
        .styles
        .extend(entries.iter().map(|e| e.xml.clone()));
    ctx.docx.styles.push(
        "<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>".to_owned(),
    );
    ctx.map.styles.paragraph = entries;

    let def = doc
        .styles
        .default_style("paragraph")
        .or_else(|| doc.styles.default_style("text"));
    let def_r_pr = match &def {
        Some(def) => ooxml_r_pr(
            ctx,
            &text_format_from_odf(
                &def.properties
                    .get("style:text-properties")
                    .cloned()
                    .unwrap_or_default(),
                &info.font_faces,
            ),
        )?,
        None => String::new(),
    };
    let def_p_pr = match &def {
        Some(def) => {
            let mut block = paragraph_block(Vec::new());
            block.format = Some(para_format_from_odf(
                &def.properties
                    .get("style:paragraph-properties")
                    .cloned()
                    .unwrap_or_default(),
                None,
                0.0,
            ));
            ooxml_p_pr(ctx, &block)?
        }
        None => String::new(),
    };
    ctx.map.styles.doc_defaults = format!(
        "<w:docDefaults><w:rPrDefault>{}</w:rPrDefault><w:pPrDefault>{}</w:pPrDefault></w:docDefaults>",
        if def_r_pr.is_empty() {
            "<w:rPr/>"
        } else {
            &def_r_pr
        },
        if def_p_pr.is_empty() {
            "<w:pPr/>"
        } else {
            &def_p_pr
        },
    );
    ctx.map.styles.default_family = def.as_ref().and_then(|d| d.family.clone());
    ctx.docx.doc_defaults = ctx.map.styles.doc_defaults.clone();
    ctx.map.styles.base_paragraph_style = match standard {
        Some(standard) => Some(standard.name.clone()),
        None => dominant_parent(ctx),
    };
    Ok(())
}

/// `dominantParent`: the parent most automatic paragraph styles of the body name
/// (Hancom: an undefined `Standard`).
fn dominant_parent(ctx: &OdfToOoxmlContext) -> Option<String> {
    let mut counts: JsMap<usize> = JsMap::new();
    for s in &ctx.doc.styles.all {
        if s.kind != OdtStyleKind::Style
            || s.family.as_deref() != Some("paragraph")
            || !s.automatic
            || s.part != OdtStylePart::ContentXml
        {
            continue;
        }
        if let Some(parent) = &s.parent_name {
            let n = counts.get(parent).copied().unwrap_or(0) + 1;
            counts.set(parent.clone(), n);
        }
    }
    let mut best: Option<String> = None;
    let mut best_count = 0usize;
    for (name, n) in counts.iter() {
        if *n > best_count {
            best = Some(name.to_owned());
            best_count = *n;
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Reverse

/// `styleDiff`
fn style_diff(
    rctx: &mut OoxmlToOdfContext,
    original_xml: &str,
    edited_xml: &str,
    odf_margin_left: f64,
) -> (AttrOverrides, AttrOverrides) {
    let o_p = read_ooxml_p_pr(first_block(original_xml, "w:pPr"));
    let e_p = read_ooxml_p_pr(first_block(edited_xml, "w:pPr"));
    let o_r = read_ooxml_r_pr(first_block(original_xml, "w:rPr"));
    let e_r = read_ooxml_r_pr(first_block(edited_xml, "w:rPr"));
    let o_keys = para_keys(Some(&o_p));
    let p_keys: Vec<_> = changed_para_keys(&o_keys, &para_keys(Some(&e_p)))
        .into_iter()
        .filter(|k| *k != super::props::ParaKey::Tabs)
        .collect();
    let para = para_overrides(
        &p_keys,
        &e_p,
        e_p.indent_left.map_or(odf_margin_left, |n| n.0),
        &o_keys,
    )
    .attrs;
    let e_tk = text_keys(Some(&e_r));
    let changed = changed_text_keys(&text_keys(Some(&o_r)), &e_tk);
    let mut face = |family: &str| rctx.font_face(OdtStylePart::StylesXml, family);
    let text = text_overrides(&changed, &e_tk, &mut face);
    (para, text)
}

/// `updateOdtStyles`: writes changed docx styles and docDefaults of the edited
/// docx back into the ODT's styles.xml as narrow patches. Needs
/// `rctx.options.editedStylesXml`.
pub fn update_odt_styles(rctx: &mut OoxmlToOdfContext) -> Result<(), OdtError> {
    let Some(edited_xml) = rctx
        .options
        .edited_styles_xml
        .clone()
        .filter(|x| !x.is_empty())
    else {
        return Ok(());
    };
    let info = rctx.part(OdtStylePart::StylesXml);
    let styles_xml: &str = &info.xml.text;
    if styles_xml.is_empty() {
        return Ok(());
    }
    let prefixes = Rc::clone(&info.prefixes);
    let edited = docx_styles_by_id(&edited_xml);
    let entries = rctx.map.styles.paragraph.clone();
    for entry in &entries {
        let Some(odf_name) = &entry.odf_name else {
            continue;
        };
        let Some(now) = edited.get(&entry.style_id) else {
            continue;
        };
        if *now == entry.xml {
            continue;
        }
        let Some(style) = rctx.doc.styles.common(odf_name, "paragraph") else {
            continue;
        };
        let margin = twips(
            style
                .properties
                .get("style:paragraph-properties")
                .and_then(|pp| pp.get("fo:margin-left"))
                .map(String::as_str),
        )
        .unwrap_or(0.0);
        let (para, text) = style_diff(rctx, &entry.xml, now, margin);
        if para.is_empty() && text.is_empty() {
            continue;
        }
        patch_style(rctx, &style, styles_xml, &prefixes, para, text)?;
    }
    let edited_defaults = first_block(&edited_xml, "w:docDefaults");
    if !edited_defaults.is_empty() && edited_defaults != rctx.map.styles.doc_defaults {
        let original_defaults = rctx.map.styles.doc_defaults.clone();
        let (para, text) = style_diff(rctx, &original_defaults, edited_defaults, 0.0);
        if para.is_empty() && text.is_empty() {
            return Ok(());
        }
        let family = rctx.map.styles.default_family.clone();
        let def = family
            .as_deref()
            .filter(|f| !f.is_empty())
            .and_then(|f| rctx.doc.styles.default_style(f));
        if let Some(def) = def.filter(|d| d.part == OdtStylePart::StylesXml) {
            patch_style(rctx, &def, styles_xml, &prefixes, para, text)?;
            return Ok(());
        }
        let Some(container) = rctx
            .doc
            .styles
            .containers
            .get(OdtStylePart::StylesXml)
            .styles
        else {
            return Ok(());
        };
        let attrs = |o: &AttrOverrides| -> String {
            o.entries()
                .into_iter()
                .filter_map(|(k, v)| {
                    v.as_ref()
                        .map(|v| format!(" {k}=\"{}\"", escape_xml_attr(v)))
                })
                .collect()
        };
        let mut xml = String::from("<style:default-style style:family=\"paragraph\">");
        if !para.is_empty() {
            xml.push_str(&format!("<style:paragraph-properties{}/>", attrs(&para)));
        }
        if !text.is_empty() {
            xml.push_str(&format!("<style:text-properties{}/>", attrs(&text)));
        }
        xml.push_str("</style:default-style>");
        if container.self_closing {
            rctx.patch(
                OdtStylePart::StylesXml,
                container.start,
                container.end,
                &format!("<office:styles>{xml}</office:styles>"),
            );
        } else {
            rctx.patch(
                OdtStylePart::StylesXml,
                container.open_end,
                container.open_end,
                &xml,
            );
        }
    }
    Ok(())
}

/// `patchStyle`
fn patch_style(
    rctx: &mut OoxmlToOdfContext,
    style: &OdtStyle,
    styles_xml: &str,
    prefixes: &PrefixMap,
    para: AttrOverrides,
    text: AttrOverrides,
) -> Result<(), OdtError> {
    let mut props: JsObject<AttrOverrides> = JsObject::new();
    if !para.is_empty() {
        props.set("style:paragraph-properties", para);
    }
    if !text.is_empty() {
        props.set("style:text-properties", text);
    }
    let xml = edit_style_xml(
        slice(styles_xml, style.start, style.end),
        prefixes,
        &StyleXmlEdit {
            props: Some(props),
            ..Default::default()
        },
    )?;
    rctx.patch(OdtStylePart::StylesXml, style.start, style.end, &xml);
    Ok(())
}
