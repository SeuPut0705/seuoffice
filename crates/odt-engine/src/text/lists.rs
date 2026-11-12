//! `text/lists.ts`: lists both ways.
//!
//! Forward: each ODF list style (`text:list-style`) becomes one docx
//! `w:abstractNum`; each top-level `text:list` becomes one `w:num`, except that
//! a list continuing another (`text:continue-list`, `text:continue-numbering`)
//! shares the instance it continues. Paragraphs become numbered docx
//! paragraphs at `w:ilvl` = nesting depth - 1.
//!
//! Reverse: consecutive list paragraphs of the edited docx are grouped by
//! `w:numId` and written as nested `text:list` / `text:list-item` markup. The
//! first group continuing an original list reuses that list's start tag
//! (style, `xml:id`); later groups of the same list continue its numbering.
//! A list the editor created gets a new automatic list style from the edited
//! docx's numbering definition.

use docx_engine::blank::{CustomNumberingLevel, custom_level_xml};
use docx_engine::model::{GeneratedBlockListKind, NumberingDef, NumberingLevelSuff};
use jscompat::{JsMap, JsNum, Radix, js_regex, math_max, math_min, number_to_string, parse_int};

use crate::core::convert::{BridgeList, OdfToOoxmlContext, OoxmlToOdfContext};
use crate::core::styles::{OdtListLevel, OdtListLevelKind, OdtStylePart, OdtStyleScope};
use crate::core::xml::escape_xml_attr;

use super::props::text_format_from_odf;
use super::units::{twips, twips_to_cm};

// ---------------------------------------------------------------------------
// Number formats

/// `NUM_FORMATS`: ODF `style:num-format` and the docx `w:numFmt` it maps to.
const NUM_FORMATS: [(&str, &str); 11] = [
    ("1", "decimal"),
    ("a", "lowerLetter"),
    ("A", "upperLetter"),
    ("i", "lowerRoman"),
    ("I", "upperRoman"),
    ("\u{ac00}, \u{b098}, \u{b2e4}, ...", "ganada"),
    ("\u{3131}, \u{3134}, \u{3137}, ...", "chosung"),
    ("\u{2460}, \u{2461}, \u{2462}, ...", "decimalEnclosedCircle"),
    ("\u{c77c}, \u{c774}, \u{c0bc}, ...", "koreanDigital"),
    ("\u{4e00}, \u{4e8c}, \u{4e09}, ...", "ideographTraditional"),
    ("", "none"),
];

/// `numFmtFromOdf`
pub fn num_fmt_from_odf(format: Option<&str>) -> String {
    let Some(format) = format else {
        return "decimal".to_owned();
    };
    NUM_FORMATS
        .iter()
        .find(|(odf, _)| *odf == format)
        .map_or("decimal", |(_, ooxml)| ooxml)
        .to_owned()
}

/// `numFmtToOdf`
pub fn num_fmt_to_odf(num_fmt: &str) -> String {
    NUM_FORMATS
        .iter()
        .find(|(_, ooxml)| *ooxml == num_fmt)
        .map_or("1", |(odf, _)| odf)
        .to_owned()
}

// ---------------------------------------------------------------------------
// Forward

/// `ListStyleNumbering`
#[derive(Debug, Clone)]
struct ListStyleNumbering {
    abstract_num_id: String,
    /// docx list kind per 0-based level
    kinds: Vec<GeneratedBlockListKind>,
}

/// `ListState`: the per-context state of the forward direction (the TypeScript's
/// `WeakMap` keyed by the context).
struct ListState {
    by_style: JsMap<ListStyleNumbering>,
    /// xml:id of a converted top-level list to numId
    by_xml_id: JsMap<String>,
    /// list style name to numId of the last list using it
    last_by_style: JsMap<String>,
    next_abstract: usize,
    next_num: usize,
}

impl Default for ListState {
    fn default() -> Self {
        Self {
            by_style: JsMap::new(),
            by_xml_id: JsMap::new(),
            last_by_style: JsMap::new(),
            next_abstract: 0,
            next_num: 1,
        }
    }
}

/// `levelToCustom`
fn level_to_custom(
    level: Option<&OdtListLevel>,
    depth: usize,
    font_faces: &JsMap<String>,
) -> CustomNumberingLevel {
    let fallback_left = 400.0 * (depth as f64 + 1.0);
    let Some(level) = level else {
        return CustomNumberingLevel {
            num_fmt: "decimal".to_owned(),
            lvl_text: format!("%{}.", depth + 1),
            indent_left: JsNum(fallback_left),
            hanging: Some(JsNum(360.0)),
            ..Default::default()
        };
    };
    let a = &level.attrs;
    let llp = level.properties.get("style:list-level-properties");
    let llp_attr = |name: &str| llp.and_then(|p| p.get(name)).map(String::as_str);
    let align = level
        .properties
        .get("style:list-level-properties/style:list-level-label-alignment");
    let indent_left: f64;
    let hanging: f64;
    let mut suff = "tab";
    let mut tab_stop: Option<f64> = None;
    if llp_attr("text:list-level-position-and-space-mode") == Some("label-alignment")
        && align.is_some()
    {
        let align = align.expect("checked above");
        let align_attr = |name: &str| align.get(name).map(String::as_str);
        indent_left = twips(align_attr("fo:margin-left")).unwrap_or(fallback_left);
        let ti = twips(align_attr("fo:text-indent")).unwrap_or(0.0);
        hanging = if ti < 0.0 { -ti } else { 0.0 };
        let follow = align_attr("text:label-followed-by");
        suff = match follow {
            Some("space") => "space",
            Some("nothing") => "nothing",
            _ => "tab",
        };
        tab_stop = twips(align_attr("text:list-tab-stop-position"));
    } else {
        let before = twips(llp_attr("text:space-before")).unwrap_or(0.0);
        let width = twips(llp_attr("text:min-label-width")).unwrap_or(360.0);
        indent_left = before + width;
        hanging = width;
    }
    let text = text_format_from_odf(
        &level
            .properties
            .get("style:text-properties")
            .cloned()
            .unwrap_or_default(),
        font_faces,
    );
    let mut out = CustomNumberingLevel {
        num_fmt: "decimal".to_owned(),
        lvl_text: String::new(),
        indent_left: JsNum(indent_left),
        hanging: Some(JsNum(hanging)),
        suff: Some(suff.to_owned()),
        ..Default::default()
    };
    if tab_stop.is_some_and(|t| t != indent_left) {
        out.tab_stop = tab_stop.map(JsNum);
    }
    if let Some(font) = text.font.as_deref().filter(|f| !f.is_empty()) {
        out.font = Some(font.to_owned());
    }
    let attr = |name: &str| a.get(name).map(String::as_str);
    if level.kind == OdtListLevelKind::Bullet || level.kind == OdtListLevelKind::Image {
        out.num_fmt = "bullet".to_owned();
        out.lvl_text = attr("text:bullet-char").unwrap_or("\u{2022}").to_owned();
        return out;
    }
    out.num_fmt = num_fmt_from_odf(attr("style:num-format"));
    let display_levels = parse_int(attr("text:display-levels").unwrap_or("1"), Radix::Ten);
    // `parseInt(...) || 1`
    let display_levels = if display_levels.is_nan() || display_levels == 0.0 {
        1.0
    } else {
        display_levels
    };
    let display = math_max(1.0, math_min(depth as f64 + 1.0, display_levels)) as usize;
    let parts: Vec<String> = ((depth + 2 - display)..=(depth + 1))
        .map(|k| format!("%{k}"))
        .collect();
    out.lvl_text = format!(
        "{}{}{}",
        attr("style:num-prefix").unwrap_or(""),
        parts.join("."),
        attr("style:num-suffix").unwrap_or("")
    );
    let start = parse_int(attr("text:start-value").unwrap_or("1"), Radix::Ten);
    if start.is_finite() && start != 1.0 {
        out.start = Some(JsNum(start));
    }
    out
}

/// `abstractFor`
fn abstract_for(ctx: &mut OdfToOoxmlContext, style_name: Option<&str>) -> ListStyleNumbering {
    let key = style_name.unwrap_or("").to_owned();
    if let Some(found) = ctx.state::<ListState>().by_style.get(&key).cloned() {
        return found;
    }
    let doc = std::rc::Rc::clone(&ctx.doc);
    let style = style_name.and_then(|n| doc.styles.list_style(n, OdtStyleScope::Content));
    let faces = ctx
        .part(style.as_ref().map_or(OdtStylePart::ContentXml, |s| s.part))
        .font_faces
        .clone();
    let mut levels: Vec<CustomNumberingLevel> = Vec::new();
    for depth in 0..9usize {
        levels.push(level_to_custom(
            style
                .as_ref()
                .and_then(|s| s.levels.iter().find(|l| l.level == depth as i64 + 1)),
            depth,
            &faces,
        ));
    }
    let abstract_num_id = {
        let mut state = ctx.state::<ListState>();
        let id = state.next_abstract;
        state.next_abstract += 1;
        id.to_string()
    };
    ctx.docx.abstract_nums.push(format!(
        "<w:abstractNum w:abstractNumId=\"{abstract_num_id}\"><w:multiLevelType w:val=\"hybridMultilevel\"/>{}</w:abstractNum>",
        levels
            .iter()
            .enumerate()
            .map(|(i, l)| custom_level_xml(l, i as f64))
            .collect::<String>()
    ));
    let found = ListStyleNumbering {
        abstract_num_id,
        kinds: levels
            .iter()
            .map(|l| {
                if l.num_fmt == "bullet" {
                    GeneratedBlockListKind::Bullet
                } else {
                    GeneratedBlockListKind::Ordered
                }
            })
            .collect(),
    };
    ctx.state::<ListState>().by_style.set(key, found.clone());
    found
}

/// The attributes `listInstance` takes of a top-level `text:list`.
#[derive(Debug, Clone, Default)]
pub struct ListInstanceAttrs {
    pub style_name: Option<String>,
    pub xml_id: Option<String>,
    pub continue_list: Option<String>,
    pub continue_numbering: bool,
}

/// `ListInstance`
#[derive(Debug, Clone)]
pub struct ListInstance {
    pub num_id: String,
    pub kinds: Vec<GeneratedBlockListKind>,
    pub list: BridgeList,
}

/// `listInstance`: the `w:num` for a top-level list block (creating it, or
/// reusing the one it continues).
pub fn list_instance(
    ctx: &mut OdfToOoxmlContext,
    block_id: usize,
    attrs: &ListInstanceAttrs,
) -> ListInstance {
    let abs = abstract_for(ctx, attrs.style_name.as_deref());
    let found: Option<String> = {
        let state = ctx.state::<ListState>();
        attrs
            .continue_list
            .as_ref()
            .and_then(|c| state.by_xml_id.get(c).cloned())
            .or_else(|| {
                if attrs.continue_numbering {
                    state
                        .last_by_style
                        .get(attrs.style_name.as_deref().unwrap_or(""))
                        .cloned()
                } else {
                    None
                }
            })
    };
    let mut num_id = found.filter(|n| !n.is_empty());
    let mut list_at = num_id
        .as_ref()
        .and_then(|n| ctx.map.lists.iter().position(|l| l.num_id == *n));
    if num_id.is_none() || list_at.is_none() {
        let n = {
            let mut state = ctx.state::<ListState>();
            let n = state.next_num;
            state.next_num += 1;
            n.to_string()
        };
        ctx.docx.nums.push(format!(
            "<w:num w:numId=\"{n}\"><w:abstractNumId w:val=\"{}\"/></w:num>",
            abs.abstract_num_id
        ));
        ctx.map.lists.push(BridgeList {
            num_id: n.clone(),
            abstract_num_id: abs.abstract_num_id.clone(),
            style_name: attrs.style_name.clone(),
            blocks: Vec::new(),
        });
        list_at = Some(ctx.map.lists.len() - 1);
        num_id = Some(n);
    }
    let num_id = num_id.unwrap_or_default();
    let list_at = list_at.unwrap_or(0);
    ctx.map.lists[list_at].blocks.push(block_id);
    {
        let mut state = ctx.state::<ListState>();
        if let Some(xml_id) = &attrs.xml_id {
            state.by_xml_id.set(xml_id.clone(), num_id.clone());
        }
        state
            .last_by_style
            .set(attrs.style_name.clone().unwrap_or_default(), num_id.clone());
    }
    ListInstance {
        num_id,
        kinds: abs.kinds,
        list: ctx.map.lists[list_at].clone(),
    }
}

// ---------------------------------------------------------------------------
// Reverse

/// `listStyleFromNumbering`: a new automatic list style from an edited docx
/// numbering definition; returns its name.
pub fn list_style_from_numbering(
    rctx: &mut OoxmlToOdfContext,
    def: Option<&NumberingDef>,
) -> String {
    let key = format!(
        "list:{}",
        def.map_or("none", |d| d.abstract_num_id.as_str())
    );
    rctx.derived_style(OdtStylePart::ContentXml, &key, "L", |name| {
        let mut levels = String::new();
        for i in 0..9usize {
            let l = def.and_then(|d| d.levels.get(&i.to_string()));
            let level = i + 1;
            let left = l
                .and_then(|l| l.indent_left)
                .map_or(720.0 * level as f64, |n| n.0);
            let hanging = l.and_then(|l| l.hanging).map_or(360.0, |n| n.0);
            let followed_by = match l.and_then(|l| l.suff) {
                Some(NumberingLevelSuff::Space) => "space",
                Some(NumberingLevelSuff::Nothing) => "nothing",
                _ => "listtab",
            };
            let props = format!(
                "<style:list-level-properties text:list-level-position-and-space-mode=\"label-alignment\"><style:list-level-label-alignment text:label-followed-by=\"{followed_by}\" text:list-tab-stop-position=\"{}\" fo:text-indent=\"{}\" fo:margin-left=\"{}\"/></style:list-level-properties>",
                twips_to_cm(left),
                twips_to_cm(-hanging),
                twips_to_cm(left)
            );
            let Some(l) = l.filter(|l| l.num_fmt != "bullet") else {
                let text = l.map(|l| l.lvl_text.as_str()).filter(|t| !t.is_empty()).unwrap_or("\u{2022}");
                levels.push_str(&format!(
                    "<text:list-level-style-bullet text:level=\"{level}\" text:bullet-char=\"{}\">{props}</text:list-level-style-bullet>",
                    escape_xml_attr(text)
                ));
                continue;
            };
            let m = js_regex!(r"^([\s\S]*?)((?:%\d)(?:\.%\d)*)([\s\S]*)$").exec(&l.lvl_text);
            let prefix = m.as_ref().map_or("", |m| m.get(1).unwrap_or(""));
            let suffix = m.as_ref().map_or(l.lvl_text.as_str(), |m| m.get(3).unwrap_or(""));
            let display = m
                .as_ref()
                .map_or(1, |m| m.get(2).unwrap_or("").split('.').count());
            levels.push_str(&format!("<text:list-level-style-number text:level=\"{level}\""));
            if !prefix.is_empty() {
                levels.push_str(&format!(" style:num-prefix=\"{}\"", escape_xml_attr(prefix)));
            }
            if !suffix.is_empty() {
                levels.push_str(&format!(" style:num-suffix=\"{}\"", escape_xml_attr(suffix)));
            }
            levels.push_str(&format!(" style:num-format=\"{}\"", escape_xml_attr(&num_fmt_to_odf(&l.num_fmt))));
            if display > 1 {
                levels.push_str(&format!(" text:display-levels=\"{display}\""));
            }
            // ODF start values are positive integers (a docx list may start at 0)
            if l.start.0 > 1.0 {
                levels.push_str(&format!(" text:start-value=\"{}\"", number_to_string(l.start.0)));
            }
            levels.push_str(&format!(">{props}</text:list-level-style-number>"));
        }
        format!(
            "<text:list-style style:name=\"{}\">{levels}</text:list-style>",
            escape_xml_attr(name)
        )
    })
}
