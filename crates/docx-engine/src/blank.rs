//! The blank document template (`blank.ts`): the parts of a new document, the
//! numbering levels the list dialogs edit, and the paper size of a locale.

mod locale;

use std::sync::LazyLock;

use jscompat::{JsNum, Slot, js_regex, math_round, number_to_string, truthy};
use ooxml_pkg::Package;
use ooxml_pkg::write::{UtcDate, generate};
use serde::{Deserialize, Serialize};

use crate::numbering::NumberingLevel;

const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";

const DOC_NS: &str = concat!(
    "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" ",
    "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" ",
    "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" ",
    "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" ",
    "xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\" ",
    "xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\"",
);

/// numId of the template's bullet list definition
pub const BLANK_BULLET_NUM_ID: &str = "1";
/// numId of the template's ordered (decimal) list definition
pub const BLANK_ORDERED_NUM_ID: &str = "2";

// doc-properties.ts, the few lines a new document needs
const CORE_PROPERTIES_PATH: &str = "docProps/core.xml";
const APP_PROPERTIES_PATH: &str = "docProps/app.xml";
const CORE_PROPERTIES_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-package.core-properties+xml";
const CORE_PROPERTIES_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const APP_PROPERTIES_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.extended-properties+xml";
const APP_PROPERTIES_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";
const NEW_DOCUMENT_APPLICATION: &str = "SeuOffice";
const NEW_DOCUMENT_TEMPLATE: &str = "Normal.dotm";
const NEW_DOCUMENT_APP_VERSION: &str = "0.1.0";

/// TOC entry styles referenced by generateTocFieldXml (indent grows per level)
fn toc_style(level: u32) -> String {
    let ind = if level > 1 {
        format!("<w:ind w:left=\"{}\"/>", 220 * (level - 1))
    } else {
        String::new()
    };
    format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"TOC{level}\"><w:name w:val=\"toc {level}\"/>\
         <w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/>\
         <w:pPr><w:spacing w:after=\"100\"/>{ind}</w:pPr></w:style>"
    )
}

fn heading_style(level: u32, size_half_points: u32) -> String {
    // Word lists Heading 3+ in the gallery only once the document uses them
    let hidden = if level >= 3 {
        "<w:semiHidden/><w:unhideWhenUsed/>"
    } else {
        ""
    };
    let before = if level <= 2 { 240 } else { 160 };
    let outline = level - 1;
    format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"Heading{level}\"><w:name w:val=\"heading {level}\"/>\
         <w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/>{hidden}<w:qFormat/>\
         <w:pPr><w:keepNext/><w:spacing w:before=\"{before}\" w:after=\"120\"/><w:outlineLvl w:val=\"{outline}\"/></w:pPr>\
         <w:rPr><w:b/><w:sz w:val=\"{size_half_points}\"/><w:szCs w:val=\"{size_half_points}\"/></w:rPr></w:style>"
    )
}

/// accent1 (4472C4) shade BF / text1 tints of the Office theme, as Word caches them in w:val
const ACCENT_DARK: &str = "w:val=\"2F5496\" w:themeColor=\"accent1\" w:themeShade=\"BF\"";
const TEXT_BF: &str = "w:val=\"404040\" w:themeColor=\"text1\" w:themeTint=\"BF\"";
const TEXT_A6: &str = "w:val=\"595959\" w:themeColor=\"text1\" w:themeTint=\"A6\"";
const TEXT_A5: &str = "w:val=\"5A5A5A\" w:themeColor=\"text1\" w:themeTint=\"A5\"";

fn para_style(id: &str, name: &str, priority: u32, p_pr: &str, r_pr: &str) -> String {
    let r_pr = if r_pr.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{r_pr}</w:rPr>")
    };
    format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/>\
         <w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"{priority}\"/><w:qFormat/>\
         <w:pPr>{p_pr}</w:pPr>{r_pr}</w:style>"
    )
}

fn char_style(id: &str, name: &str, priority: u32, r_pr: &str) -> String {
    format!(
        "<w:style w:type=\"character\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/>\
         <w:uiPriority w:val=\"{priority}\"/><w:qFormat/><w:rPr>{r_pr}</w:rPr></w:style>"
    )
}

/// Word's Quick Style set (Normal and the headings are defined separately), in gallery order
static QUICK_STYLES_XML: LazyLock<String> = LazyLock::new(|| {
    [
        "<w:style w:type=\"paragraph\" w:styleId=\"NoSpacing\"><w:name w:val=\"No Spacing\"/><w:uiPriority w:val=\"1\"/><w:qFormat/>\
         <w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr></w:style>"
            .to_owned(),
        para_style(
            "Title",
            "Title",
            10,
            "<w:spacing w:after=\"80\" w:line=\"240\" w:lineRule=\"auto\"/><w:contextualSpacing/>",
            "<w:spacing w:val=\"-10\"/><w:kern w:val=\"28\"/><w:sz w:val=\"56\"/><w:szCs w:val=\"56\"/>",
        ),
        para_style(
            "Subtitle",
            "Subtitle",
            11,
            "<w:spacing w:after=\"160\"/>",
            &format!(
                "<w:color {TEXT_A6}/><w:spacing w:val=\"15\"/><w:sz w:val=\"28\"/><w:szCs w:val=\"28\"/>"
            ),
        ),
        char_style(
            "SubtleEmphasis",
            "Subtle Emphasis",
            19,
            &format!("<w:i/><w:iCs/><w:color {TEXT_BF}/>"),
        ),
        char_style("Emphasis", "Emphasis", 20, "<w:i/><w:iCs/>"),
        char_style(
            "IntenseEmphasis",
            "Intense Emphasis",
            21,
            &format!("<w:i/><w:iCs/><w:color {ACCENT_DARK}/>"),
        ),
        char_style("Strong", "Strong", 22, "<w:b/><w:bCs/>"),
        para_style(
            "Quote",
            "Quote",
            29,
            "<w:spacing w:before=\"200\" w:after=\"480\"/><w:jc w:val=\"center\"/>",
            &format!("<w:i/><w:iCs/><w:color {TEXT_BF}/>"),
        ),
        para_style(
            "IntenseQuote",
            "Intense Quote",
            30,
            "<w:pBdr><w:top w:val=\"single\" w:sz=\"4\" w:space=\"10\" w:color=\"2F5496\" w:themeColor=\"accent1\" w:themeShade=\"BF\"/>\
             <w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"10\" w:color=\"2F5496\" w:themeColor=\"accent1\" w:themeShade=\"BF\"/></w:pBdr>\
             <w:spacing w:before=\"360\" w:after=\"440\"/><w:ind w:left=\"864\" w:right=\"864\"/><w:jc w:val=\"center\"/>",
            &format!("<w:i/><w:iCs/><w:color {ACCENT_DARK}/>"),
        ),
        char_style(
            "SubtleReference",
            "Subtle Reference",
            31,
            &format!("<w:smallCaps/><w:color {TEXT_A5}/>"),
        ),
        char_style(
            "IntenseReference",
            "Intense Reference",
            32,
            &format!("<w:b/><w:bCs/><w:smallCaps/><w:color {ACCENT_DARK}/><w:spacing w:val=\"5\"/>"),
        ),
        char_style(
            "BookTitle",
            "Book Title",
            33,
            "<w:b/><w:bCs/><w:i/><w:iCs/><w:spacing w:val=\"5\"/>",
        ),
        "<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/>\
         <w:uiPriority w:val=\"34\"/><w:qFormat/><w:pPr><w:ind w:left=\"720\"/><w:contextualSpacing/></w:pPr></w:style>"
            .to_owned(),
    ]
    .concat()
});

fn styles_xml(east_asia_font: Option<&str>) -> String {
    let east_asia = truthy(east_asia_font)
        .map(|font| format!(" w:eastAsia=\"{font}\""))
        .unwrap_or_default();
    let mut xml = String::from(XML_DECL);
    xml.push_str(
        "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
         <w:docDefaults><w:rPrDefault><w:rPr>",
    );
    xml.push_str(&format!(
        "<w:rFonts w:ascii=\"Calibri\"{east_asia} w:hAnsi=\"Calibri\"/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/>"
    ));
    xml.push_str(
        "</w:rPr></w:rPrDefault>\
         <w:pPrDefault><w:pPr><w:spacing w:after=\"120\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>\
         <w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>",
    );
    for (level, size) in [(1, 32), (2, 28), (3, 26), (4, 24), (5, 22), (6, 22)] {
        xml.push_str(&heading_style(level, size));
    }
    xml.push_str(&QUICK_STYLES_XML);
    xml.push_str(
        "<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/>\
         <w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>",
    );
    for level in 1..=9 {
        xml.push_str(&toc_style(level));
    }
    xml.push_str("</w:styles>");
    xml
}

fn bullet_levels() -> String {
    let mut xml = String::new();
    for ilvl in 0..5 {
        let left = 720 * (ilvl + 1);
        xml.push_str(&format!(
            "<w:lvl w:ilvl=\"{ilvl}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"&#61623;\"/>\
             <w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{left}\" w:hanging=\"360\"/></w:pPr>\
             <w:rPr><w:rFonts w:ascii=\"Symbol\" w:hAnsi=\"Symbol\" w:hint=\"default\"/></w:rPr></w:lvl>"
        ));
    }
    xml
}

fn decimal_levels() -> String {
    let mut xml = String::new();
    for ilvl in 0..5 {
        let number = ilvl + 1;
        let left = 720 * (ilvl + 1);
        xml.push_str(&format!(
            "<w:lvl w:ilvl=\"{ilvl}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"decimal\"/><w:lvlText w:val=\"%{number}.\"/>\
             <w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{left}\" w:hanging=\"360\"/></w:pPr></w:lvl>"
        ));
    }
    xml
}

/// `w:lvlJc` as the dialogs write it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LvlJc {
    Left,
    Center,
    Right,
}

impl LvlJc {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Center => "center",
            Self::Right => "right",
        }
    }
}

/// Custom numbering level (one level of a multilevel list / bullet library /
/// numbering library definition). The fields are in the order
/// `customLevelFromNumberingLevel` sets them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomNumberingLevel {
    /// w:numFmt: decimal/bullet/lowerLetter/upperRoman/chineseCountingThousand…
    pub num_fmt: String,
    /// w:lvlText: a pattern like "%1." or a literal bullet symbol
    pub lvl_text: String,
    /// w:ind w:left (twips)
    pub indent_left: JsNum,
    /// w:ind w:hanging (twips, default 360)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hanging: Option<JsNum>,
    /// w:start (default 1)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<JsNum>,
    /// w14 enumeration behind numFmt "custom", written as mc:AlternateContent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_format: Option<String>,
    /// w:suff (default tab): 'tab' | 'space' | 'nothing'
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suff: Option<String>,
    /// w:lvlJc (default left)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lvl_jc: Option<LvlJc>,
    /// w:rPr of the marker: font family, size (half-points), color (hex), weight
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sz_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// w:isLgl: legal-style numbering (every placeholder shows as decimal)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_lgl: Option<bool>,
    /// w:lvlPicBulletId: draw a w:numPicBullet image instead of lvlText
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pic_bullet_id: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    /// w:pPr/w:tabs: an explicit tab stop after the marker (twips)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_stop: Option<JsNum>,
    /// w:pStyle: paragraphs in this style take the level's numbering
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p_style: Option<String>,
    /// w:lvlRestart: restart this level after the given (higher) level; 0 = never
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lvl_restart: Option<JsNum>,
}

/// `if (x)` on a number: neither 0 nor NaN.
fn number_truthy(x: Option<JsNum>) -> Option<JsNum> {
    x.filter(|x| x.0 != 0.0 && !x.0.is_nan())
}

fn owned(text: Option<&str>) -> Option<String> {
    text.map(str::to_owned)
}

/// A parsed level in the shape the define/adjust dialogs edit
pub fn custom_level_from_numbering_level(level: &NumberingLevel) -> CustomNumberingLevel {
    CustomNumberingLevel {
        num_fmt: level.num_fmt().to_owned(),
        lvl_text: level.lvl_text().to_owned(),
        indent_left: level.indent_left.unwrap_or(JsNum(0.0)),
        hanging: Some(
            level
                .hanging
                .unwrap_or(JsNum(if level.indent_left.is_none() {
                    360.0
                } else {
                    0.0
                })),
        ),
        start: *level.start,
        custom_format: owned(truthy(level.custom_format.as_deref())),
        suff: owned(truthy(level.suff.as_deref())),
        lvl_jc: level.lvl_jc.and_then(|jc| match jc {
            "left" => Some(LvlJc::Left),
            "center" => Some(LvlJc::Center),
            "right" => Some(LvlJc::Right),
            _ => None,
        }),
        font: owned(truthy(level.font.as_deref())),
        sz_half_points: number_truthy(*level.sz_half_points),
        color: owned(truthy(level.color.as_deref())),
        is_lgl: level.is_lgl.filter(|on| *on),
        pic_bullet_id: *level.pic_bullet_id,
        bold: level.bold.filter(|on| *on),
        italic: level.italic.filter(|on| *on),
        tab_stop: *level.tab_stop,
        p_style: owned(truthy(level.p_style.as_deref())),
        lvl_restart: *level.lvl_restart,
    }
}

/// The renderer's overlay shape for a level the dialogs produced (display before save)
pub fn numbering_level_from_custom(
    l: &CustomNumberingLevel,
    pic_bullet_src: Option<&str>,
) -> NumberingLevel {
    // the keys in the order numberingLevelFromCustom sets them
    NumberingLevel {
        num_fmt: Slot::of(l.num_fmt.clone()),
        lvl_text: Slot::of(l.lvl_text.clone()),
        start: Slot::of(l.start.unwrap_or(JsNum(1.0))),
        indent_left: Slot::of(l.indent_left),
        hanging: Slot::of(l.hanging.unwrap_or(JsNum(360.0))),
        custom_format: Slot::maybe(owned(truthy(l.custom_format.as_deref()))),
        suff: Slot::maybe(owned(truthy(l.suff.as_deref()))),
        lvl_jc: Slot::maybe(l.lvl_jc.map(LvlJc::as_str)),
        font: Slot::maybe(owned(truthy(l.font.as_deref()))),
        sz_half_points: Slot::maybe(number_truthy(l.sz_half_points)),
        color: Slot::maybe(owned(truthy(l.color.as_deref()))),
        is_lgl: Slot::maybe(l.is_lgl.filter(|on| *on)),
        pic_bullet_id: Slot::maybe(l.pic_bullet_id),
        pic_bullet_src: Slot::maybe(owned(truthy(pic_bullet_src))),
        bold: Slot::maybe(l.bold.filter(|on| *on)),
        italic: Slot::maybe(l.italic.filter(|on| *on)),
        tab_stop: Slot::maybe(l.tab_stop),
        p_style: Slot::maybe(owned(truthy(l.p_style.as_deref()))),
        lvl_restart: Slot::maybe(l.lvl_restart),
        ..NumberingLevel::default()
    }
}

const LVL_CHILD_ORDER: [&str; 12] = [
    "w:start",
    "w:numFmt",
    "w:lvlRestart",
    "w:pStyle",
    "w:isLgl",
    "w:suff",
    "w:lvlText",
    "w:lvlPicBulletId",
    "w:legacy",
    "w:lvlJc",
    "w:pPr",
    "w:rPr",
];

/// `PPR_CHILD_ORDER` of generate.ts (CT_PPrGeneral sequence). It belongs to
/// the generator once generate.ts is ported.
const PPR_CHILD_ORDER: [&str; 36] = [
    "w:pStyle",
    "w:keepNext",
    "w:keepLines",
    "w:pageBreakBefore",
    "w:framePr",
    "w:widowControl",
    "w:numPr",
    "w:suppressLineNumbers",
    "w:pBdr",
    "w:shd",
    "w:tabs",
    "w:suppressAutoHyphens",
    "w:kinsoku",
    "w:wordWrap",
    "w:overflowPunct",
    "w:topLinePunct",
    "w:autoSpaceDE",
    "w:autoSpaceDN",
    "w:bidi",
    "w:adjustRightInd",
    "w:snapToGrid",
    "w:spacing",
    "w:ind",
    "w:contextualSpacing",
    "w:mirrorIndents",
    "w:suppressOverlap",
    "w:jc",
    "w:textDirection",
    "w:textAlignment",
    "w:textboxTightWrap",
    "w:outlineLvl",
    "w:divId",
    "w:cnfStyle",
    "w:rPr",
    "w:sectPr",
    "w:pPrChange",
];

/// A JavaScript `Map` of element name to XML, with the `delete` that
/// `jscompat::JsMap` lacks.
#[derive(Default)]
struct Children(Vec<(String, String)>);

impl Children {
    /// `new Map(splitChildren(inner))`: a name seen again keeps its first
    /// place and takes the later XML.
    fn split(inner: &str) -> Self {
        let mut children = Self::default();
        for (name, xml) in split_children(inner) {
            children.set(name, xml.to_owned());
        }
        children
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, xml)| xml.as_str())
    }

    fn set(&mut self, name: &str, xml: String) {
        match self.0.iter_mut().find(|(key, _)| key == name) {
            Some(entry) => entry.1 = xml,
            None => self.0.push((name.to_owned(), xml)),
        }
    }

    fn delete(&mut self, name: &str) {
        self.0.retain(|(key, _)| key != name);
    }

    /// `set(name, xml)` where `xml === null` deletes.
    fn put(&mut self, name: &str, xml: Option<String>) {
        match xml {
            Some(xml) => self.set(name, xml),
            None => self.delete(name),
        }
    }

    /// `[...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))` (a stable
    /// sort) with the XML joined.
    fn joined_by(mut self, rank: impl Fn(&str) -> usize) -> String {
        self.0.sort_by_key(|(name, _)| rank(name));
        self.0.into_iter().map(|(_, xml)| xml).collect()
    }
}

/// Top-level children of a small element as [name, xml] pairs (no same-name
/// nesting inside a w:lvl). Any element name is matched, not just the w: ones:
/// matching w: alone dropped the w14 extension children of a level's rPr, and
/// an rPr holding nothing but those was deleted with them.
fn split_children(inner: &str) -> Vec<(&str, &str)> {
    js_regex!(r"<([\w:]+)\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/\1>)")
        .find_iter(inner)
        .map(|m| (m.get(1).unwrap_or_default(), m.as_str()))
        .collect()
}

fn inner_of(xml: &str) -> &str {
    // indexOf returns -1 where there is none: the slice then starts at 0
    let open = xml.find('>').map_or(0, |at| at + 1);
    match xml.rfind("</") {
        Some(close) if !xml.ends_with("/>") => xml.get(open..close).unwrap_or_default(),
        _ => "",
    }
}

/// `indexOf` in a table, with an unlisted name ranked `missing`.
fn rank_in(table: &[&str], name: &str, missing: usize) -> usize {
    table
        .iter()
        .position(|listed| *listed == name)
        .unwrap_or(missing)
}

/// Merge a dialog-produced level into an existing w:lvl: the fields the level
/// carries replace their elements, everything else in the original (legacy,
/// w14 extensions, rPr children the dialogs do not know) keeps its bytes.
pub fn merge_level_xml(existing: &str, l: &CustomNumberingLevel, ilvl: f64) -> String {
    let mut children = Children::split(inner_of(existing));
    children.set(
        "w:start",
        format!(
            "<w:start w:val=\"{}\"/>",
            number_to_string(l.start.map_or(1.0, |start| start.0))
        ),
    );
    // a w14 custom format lives in mc:AlternateContent in the numFmt slot; the
    // dialog's numFmt replaces whichever form the file had
    children.0.retain(|(name, xml)| {
        !(name.ends_with(":AlternateContent") && js_regex!(r"<w:numFmt\b").test(xml))
    });
    children.set("w:numFmt", num_fmt_xml(l));
    if let Some(restart) = l.lvl_restart {
        children.set(
            "w:lvlRestart",
            format!("<w:lvlRestart w:val=\"{}\"/>", number_to_string(restart.0)),
        );
    }
    if let Some(p_style) = &l.p_style {
        children.put(
            "w:pStyle",
            truthy(Some(p_style.as_str()))
                .map(|p_style| format!("<w:pStyle w:val=\"{}\"/>", esc_attr(p_style))),
        );
    }
    if let Some(is_lgl) = l.is_lgl {
        children.put("w:isLgl", is_lgl.then(|| "<w:isLgl/>".to_owned()));
    }
    if let Some(suff) = &l.suff {
        children.put(
            "w:suff",
            (suff != "tab").then(|| format!("<w:suff w:val=\"{suff}\"/>")),
        );
    }
    children.set(
        "w:lvlText",
        format!("<w:lvlText w:val=\"{}\"/>", esc_attr(&l.lvl_text)),
    );
    if let Some(id) = l.pic_bullet_id {
        children.set(
            "w:lvlPicBulletId",
            format!("<w:lvlPicBulletId w:val=\"{}\"/>", number_to_string(id.0)),
        );
    }
    children.set(
        "w:lvlJc",
        format!(
            "<w:lvlJc w:val=\"{}\"/>",
            l.lvl_jc.map_or("left", LvlJc::as_str)
        ),
    );

    let mut p_pr = Children::split(inner_of(children.get("w:pPr").unwrap_or_default()));
    let hanging = math_round(l.hanging.map_or(360.0, |hanging| hanging.0));
    p_pr.set(
        "w:ind",
        format!(
            "<w:ind w:left=\"{}\" w:hanging=\"{}\"/>",
            number_to_string(math_round(l.indent_left.0)),
            number_to_string(hanging)
        ),
    );
    if let Some(tab_stop) = l.tab_stop {
        p_pr.set(
            "w:tabs",
            format!(
                "<w:tabs><w:tab w:val=\"num\" w:pos=\"{}\"/></w:tabs>",
                number_to_string(math_round(tab_stop.0))
            ),
        );
    }
    // CT_PPrGeneral sequence; anything unlisted sorts last, not first: Word
    // validates the child order strictly
    let p_pr_xml = p_pr.joined_by(|name| rank_in(&PPR_CHILD_ORDER, name, PPR_CHILD_ORDER.len()));
    children.set("w:pPr", format!("<w:pPr>{p_pr_xml}</w:pPr>"));

    let mut r_pr = Children::split(inner_of(children.get("w:rPr").unwrap_or_default()));
    if let Some(font) = &l.font {
        let f = esc_attr(font);
        if font.is_empty() {
            r_pr.delete("w:rFonts");
        } else {
            r_pr.set(
                "w:rFonts",
                format!(
                    "<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:eastAsia=\"{f}\" w:cs=\"{f}\" w:hint=\"default\"/>"
                ),
            );
        }
    }
    let mut toggle = |name: &str, on: Option<bool>, xml: &str| match on {
        None => {}
        Some(true) => r_pr.set(name, xml.to_owned()),
        Some(false) => r_pr.delete(name),
    };
    toggle("w:b", l.bold, "<w:b/>");
    toggle("w:i", l.italic, "<w:i/>");
    if let Some(color) = &l.color {
        if color.is_empty() {
            r_pr.delete("w:color");
        } else {
            r_pr.set(
                "w:color",
                format!("<w:color w:val=\"{}\"/>", esc_attr(color)),
            );
        }
    }
    if let Some(size) = l.sz_half_points {
        if number_truthy(Some(size)).is_some() {
            let size = number_to_string(size.0);
            r_pr.set("w:sz", format!("<w:sz w:val=\"{size}\"/>"));
            r_pr.set("w:szCs", format!("<w:szCs w:val=\"{size}\"/>"));
        } else {
            r_pr.delete("w:sz");
            r_pr.delete("w:szCs");
        }
    }
    let r_pr_order = [
        "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:color", "w:sz", "w:szCs",
    ];
    let r_pr_xml = r_pr.joined_by(|name| rank_in(&r_pr_order, name, 99));
    children.put(
        "w:rPr",
        (!r_pr_xml.is_empty()).then(|| format!("<w:rPr>{r_pr_xml}</w:rPr>")),
    );

    let body = children.joined_by(|name| rank_in(&LVL_CHILD_ORDER, name, 99));
    let open_tag = js_regex!(r"<w:lvl\b[^>]*>").exec(existing).map_or_else(
        || format!("<w:lvl w:ilvl=\"{}\">", number_to_string(ilvl)),
        |m| m.as_str().to_owned(),
    );
    let open_tag = match open_tag.strip_suffix("/>") {
        Some(head) => format!("{head}>"),
        None => open_tag,
    };
    format!("{open_tag}{body}</w:lvl>")
}

fn esc_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// `escapeXmlText` of xml-utils.ts: the control characters XML 1.0 forbids
/// are dropped, then `&`, `<` and `>` are escaped.
fn escape_xml_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' => {}
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// Word's shape for a w14 enumeration: the format in mc:Choice, decimal for
/// older readers. Namespaces are declared on the element so the part's root
/// needs no edit.
fn num_fmt_xml(l: &CustomNumberingLevel) -> String {
    match truthy(l.custom_format.as_deref()) {
        Some(custom_format) if l.num_fmt == "custom" => format!(
            "<mc:AlternateContent xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" \
             xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\">\
             <mc:Choice Requires=\"w14\"><w:numFmt w:val=\"custom\" w:format=\"{}\"/></mc:Choice>\
             <mc:Fallback><w:numFmt w:val=\"decimal\"/></mc:Fallback></mc:AlternateContent>",
            esc_attr(custom_format)
        ),
        _ => format!("<w:numFmt w:val=\"{}\"/>", esc_attr(&l.num_fmt)),
    }
}

/// One w:lvl in CT_Lvl child order
pub fn custom_level_xml(l: &CustomNumberingLevel, ilvl: f64) -> String {
    let mut parts = vec![
        format!(
            "<w:start w:val=\"{}\"/>",
            number_to_string(l.start.map_or(1.0, |start| start.0))
        ),
        num_fmt_xml(l),
    ];
    if let Some(restart) = l.lvl_restart {
        parts.push(format!(
            "<w:lvlRestart w:val=\"{}\"/>",
            number_to_string(restart.0)
        ));
    }
    if let Some(p_style) = truthy(l.p_style.as_deref()) {
        parts.push(format!("<w:pStyle w:val=\"{}\"/>", esc_attr(p_style)));
    }
    if l.is_lgl == Some(true) {
        parts.push("<w:isLgl/>".to_owned());
    }
    if let Some(suff) = truthy(l.suff.as_deref()).filter(|suff| *suff != "tab") {
        parts.push(format!("<w:suff w:val=\"{suff}\"/>"));
    }
    parts.push(format!("<w:lvlText w:val=\"{}\"/>", esc_attr(&l.lvl_text)));
    if let Some(id) = l.pic_bullet_id {
        parts.push(format!(
            "<w:lvlPicBulletId w:val=\"{}\"/>",
            number_to_string(id.0)
        ));
    }
    parts.push(format!(
        "<w:lvlJc w:val=\"{}\"/>",
        l.lvl_jc.map_or("left", LvlJc::as_str)
    ));
    let tabs = l
        .tab_stop
        .map(|tab_stop| {
            format!(
                "<w:tabs><w:tab w:val=\"num\" w:pos=\"{}\"/></w:tabs>",
                number_to_string(math_round(tab_stop.0))
            )
        })
        .unwrap_or_default();
    let hanging = math_round(l.hanging.map_or(360.0, |hanging| hanging.0));
    parts.push(format!(
        "<w:pPr>{tabs}<w:ind w:left=\"{}\" w:hanging=\"{}\"/></w:pPr>",
        number_to_string(math_round(l.indent_left.0)),
        number_to_string(hanging)
    ));
    let mut r_pr = String::new();
    if let Some(font) = truthy(l.font.as_deref()) {
        let f = esc_attr(font);
        r_pr.push_str(&format!(
            "<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:eastAsia=\"{f}\" w:cs=\"{f}\" w:hint=\"default\"/>"
        ));
    }
    if l.bold == Some(true) {
        r_pr.push_str("<w:b/>");
    }
    if l.italic == Some(true) {
        r_pr.push_str("<w:i/>");
    }
    if let Some(color) = truthy(l.color.as_deref()) {
        r_pr.push_str(&format!("<w:color w:val=\"{}\"/>", esc_attr(color)));
    }
    if let Some(size) = number_truthy(l.sz_half_points) {
        let size = number_to_string(size.0);
        r_pr.push_str(&format!(
            "<w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/>"
        ));
    }
    if !r_pr.is_empty() {
        parts.push(format!("<w:rPr>{r_pr}</w:rPr>"));
    }
    format!(
        "<w:lvl w:ilvl=\"{}\">{}</w:lvl>",
        number_to_string(ilvl),
        parts.concat()
    )
}

fn custom_levels(levels: &[CustomNumberingLevel]) -> String {
    levels
        .iter()
        .enumerate()
        .map(|(ilvl, l)| custom_level_xml(l, ilvl as f64))
        .collect()
}

/// w:numPicBullet with a DrawingML picture; the image relationship lives in numbering.xml.rels
pub fn num_pic_bullet_xml(id: f64, r_id: &str) -> String {
    let id = number_to_string(id);
    format!(
        "<w:numPicBullet w:numPicBulletId=\"{id}\"><w:drawing>\
         <wp:inline xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
         <wp:extent cx=\"152400\" cy=\"152400\"/><wp:docPr id=\"{id}\" name=\"Picture bullet {id}\"/>\
         <a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">\
         <a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
         <pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
         <pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"Picture bullet {id}\"/><pic:cNvPicPr/></pic:nvPicPr>\
         <pic:blipFill><a:blip r:embed=\"{r_id}\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
         <pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"152400\" cy=\"152400\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>\
         </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:numPicBullet>"
    )
}

/// One abstractNum definition; uses custom levels when provided, otherwise
/// the blank-template style (5 levels). `kind` is "bullet" or "ordered".
pub fn abstract_num_xml(
    abstract_num_id: &str,
    kind: &str,
    levels: Option<&[CustomNumberingLevel]>,
) -> String {
    let body = match levels {
        Some(levels) if !levels.is_empty() => custom_levels(levels),
        _ if kind == "bullet" => bullet_levels(),
        _ => decimal_levels(),
    };
    format!("<w:abstractNum w:abstractNumId=\"{abstract_num_id}\">{body}</w:abstractNum>")
}

/// The blank template's numbering.xml (bullet numId 1 / decimal numId 2);
/// base content used when the document has no such part
pub static BLANK_NUMBERING_XML: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{XML_DECL}<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
         <w:abstractNum w:abstractNumId=\"0\">{}</w:abstractNum>\
         <w:abstractNum w:abstractNumId=\"1\">{}</w:abstractNum>\
         <w:num w:numId=\"{BLANK_BULLET_NUM_ID}\"><w:abstractNumId w:val=\"0\"/></w:num>\
         <w:num w:numId=\"{BLANK_ORDERED_NUM_ID}\"><w:abstractNumId w:val=\"1\"/></w:num>\
         </w:numbering>",
        bullet_levels(),
        decimal_levels()
    )
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlankPaperSize {
    A4,
    Letter,
}

/// Word starts new documents on Letter in these OS regions and on A4 everywhere else.
const LETTER_REGIONS: [&str; 14] = [
    "US", "CA", "MX", "PH", "LR", "MM", "PR", "CL", "CO", "VE", "GT", "CR", "PA", "DO",
];

pub fn paper_size_for_region(region: Option<&str>) -> BlankPaperSize {
    match truthy(region) {
        Some(region) if LETTER_REGIONS.contains(&region.to_uppercase().as_str()) => {
            BlankPaperSize::Letter
        }
        _ => BlankPaperSize::A4,
    }
}

/// Paper size for a BCP 47 system locale such as `en-US` or `zh-Hans-CN`.
///
/// `new Intl.Locale(locale).maximize().region` is answered from a snapshot of
/// the host's CLDR data that keeps only the Letter regions (`blank/locale.rs`).
pub fn paper_size_for_locale(locale: Option<&str>) -> BlankPaperSize {
    let Some(locale) = truthy(locale) else {
        return BlankPaperSize::A4;
    };
    // a tag Intl.Locale refuses throws, and the catch leaves no region
    let region = locale::letter_region(&locale.replace('_', "-"));
    paper_size_for_region(region)
}

impl BlankPaperSize {
    /// `PAPER_TWIPS`: width and height of the page.
    fn twips(self) -> (u32, u32) {
        match self {
            Self::A4 => (11906, 16838),
            Self::Letter => (12240, 15840),
        }
    }
}

/// `ownValue(PAPER_TWIPS, options.paperSize)`: a size the table does not hold
/// (an unchecked caller value) takes the default, like a missing one.
fn own_paper_size<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BlankPaperSize>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Unchecked {
        Text(String),
        Other(serde::de::IgnoredAny),
    }
    Ok(match Unchecked::deserialize(deserializer)? {
        Unchecked::Text(name) if name == "A4" => Some(BlankPaperSize::A4),
        Unchecked::Text(name) if name == "Letter" => Some(BlankPaperSize::Letter),
        Unchecked::Text(_) | Unchecked::Other(_) => None,
    })
}

/// `if (options.omitGeneratorFields)` on a value from outside the type
/// system: false, null, 0 and "" are falsy, everything else is true.
fn js_truthy<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Unchecked {
        Flag(bool),
        Number(f64),
        Text(String),
        Other(serde::de::IgnoredAny),
    }
    Ok(match Option::<Unchecked>::deserialize(deserializer)? {
        None | Some(Unchecked::Flag(false)) => false,
        Some(Unchecked::Number(number)) => number != 0.0 && !number.is_nan(),
        Some(Unchecked::Text(text)) => !text.is_empty(),
        Some(Unchecked::Flag(true) | Unchecked::Other(_)) => true,
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlankDocxOptions {
    /// docDefaults East Asian font (w:eastAsia). When omitted no w:eastAsia
    /// is written.
    pub east_asia_font: Option<String>,
    /// Page size of the single section; defaults to A4, also for a value
    /// that names no size.
    #[serde(default, deserialize_with = "own_paper_size")]
    pub paper_size: Option<BlankPaperSize>,
    /// Creation stamp of docProps/core.xml as a time value (milliseconds
    /// since 1970 UTC); defaults to the `now` of [`build_blank_docx`].
    pub created_at: Option<f64>,
    /// docProps/app.xml Application; defaults to "SeuOffice".
    pub application: Option<String>,
    /// docProps/app.xml AppVersion; defaults to the docx-engine package version.
    pub app_version: Option<String>,
    /// docProps/app.xml Template; defaults to Word's "Normal.dotm".
    pub template: Option<String>,
    /// Drop the Application and AppVersion fields of docProps/app.xml (the
    /// Template stays); defaults to false.
    #[serde(default, deserialize_with = "js_truthy")]
    pub omit_generator_fields: bool,
}

/// `date.toISOString()`; an invalid date throws a RangeError.
fn iso_string(time: f64) -> Result<String, String> {
    let date = UtcDate::from_time_value(time).ok_or("RangeError: Invalid time value")?;
    let year = if (0..=9999).contains(&date.year) {
        format!("{:04}", date.year)
    } else {
        let sign = if date.year < 0 { '-' } else { '+' };
        format!("{sign}{:06}", date.year.abs())
    };
    Ok(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.month, date.day, date.hours, date.minutes, date.seconds, date.milliseconds
    ))
}

/// The W3CDTF stamp Word writes into core properties (seconds, Z)
pub fn w3cdtf_stamp(time: f64) -> Result<String, String> {
    let iso = iso_string(time)?;
    Ok(js_regex!(r"\.\d{3}Z$").replace_all(&iso, |_| "Z".to_owned()))
}

/// Word-like core part of a freshly created document: no creator or other
/// people data, just the creation/modification stamp and revision 0: the
/// template has not been saved anywhere yet.
pub fn new_document_core_properties_xml(created: f64) -> Result<String, String> {
    let stamp = w3cdtf_stamp(created)?;
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" \
         xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" \
         xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\
         <dcterms:created xsi:type=\"dcterms:W3CDTF\">{stamp}</dcterms:created>\
         <dcterms:modified xsi:type=\"dcterms:W3CDTF\">{stamp}</dcterms:modified>\
         <cp:revision>0</cp:revision>\
         </cp:coreProperties>"
    ))
}

/// Word-like extended part of a freshly created document (no company/manager)
pub fn new_document_app_properties_xml(options: &BlankDocxOptions) -> String {
    let template = options.template.as_deref().unwrap_or(NEW_DOCUMENT_TEMPLATE);
    let fields = if options.omit_generator_fields {
        String::new()
    } else {
        let application = options
            .application
            .as_deref()
            .unwrap_or(NEW_DOCUMENT_APPLICATION);
        let app_version = options
            .app_version
            .as_deref()
            .unwrap_or(NEW_DOCUMENT_APP_VERSION);
        format!(
            "<Application>{}</Application><AppVersion>{}</AppVersion>",
            escape_xml_text(application),
            escape_xml_text(app_version)
        )
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" \
         xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\">\
         <Template>{}</Template>{fields}\
         </Properties>",
        escape_xml_text(template)
    )
}

/// The package of a minimal valid .docx: one empty paragraph, portrait page,
/// standard styles, in the order `buildBlankDocx` adds its files (with the
/// folders JSZip adds above them).
///
/// `now` (a time value) stands for the clock: it is the creation stamp when
/// `options` has none.
pub fn blank_docx_package(options: &BlankDocxOptions, now: f64) -> Result<Package, String> {
    let mut zip = Package::default();
    let mut file = |name: &str, text: String| zip.set_file(name.to_owned(), text.into_bytes());

    file(
        "[Content_Types].xml",
        format!(
            "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
             <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
             <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
             <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
             <Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
             <Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
             <Override PartName=\"/{CORE_PROPERTIES_PATH}\" ContentType=\"{CORE_PROPERTIES_CONTENT_TYPE}\"/>\
             <Override PartName=\"/{APP_PROPERTIES_PATH}\" ContentType=\"{APP_PROPERTIES_CONTENT_TYPE}\"/>\
             </Types>"
        ),
    );

    file(
        "_rels/.rels",
        format!(
            "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
             <Relationship Id=\"rId2\" Type=\"{CORE_PROPERTIES_REL_TYPE}\" Target=\"{CORE_PROPERTIES_PATH}\"/>\
             <Relationship Id=\"rId3\" Type=\"{APP_PROPERTIES_REL_TYPE}\" Target=\"{APP_PROPERTIES_PATH}\"/>\
             </Relationships>"
        ),
    );

    file(
        "word/_rels/document.xml.rels",
        format!(
            "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
             <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>\
             </Relationships>"
        ),
    );

    file(
        "word/styles.xml",
        styles_xml(options.east_asia_font.as_deref()),
    );
    file("word/numbering.xml", BLANK_NUMBERING_XML.clone());

    // Word always writes both parts; a document created here carries minimal
    // Word-like ones so later property sets have a home
    file(
        CORE_PROPERTIES_PATH,
        new_document_core_properties_xml(options.created_at.unwrap_or(now))?,
    );
    file(
        APP_PROPERTIES_PATH,
        new_document_app_properties_xml(options),
    );

    let (width, height) = options.paper_size.unwrap_or(BlankPaperSize::A4).twips();
    let sect_pr = format!(
        "<w:sectPr><w:pgSz w:w=\"{width}\" w:h=\"{height}\"/>\
         <w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/>\
         </w:sectPr>"
    );
    file(
        "word/document.xml",
        format!("{XML_DECL}<w:document {DOC_NS}><w:body><w:p/>{sect_pr}</w:body></w:document>"),
    );
    Ok(zip)
}

/// Build a minimal valid .docx: the bytes of [`blank_docx_package`], every
/// entry stamped with `now`.
pub fn build_blank_docx(options: &BlankDocxOptions, now: f64) -> Result<Vec<u8>, String> {
    let zip = blank_docx_package(options, now)?;
    generate(&zip, now).map_err(|error| error.to_string())
}
