//! `assemble/export/styles.ts`: the styles of a new ODT made from a docx: the
//! document defaults (`w:docDefaults` to `style:default-style`), one common
//! paragraph style per docx paragraph style (its resolved look; the default
//! style is `Standard`), and one page layout and master page per distinct page
//! setup.
//!
//! Page geometry follows the page layer's mapping in reverse: ODF (and Hancom)
//! put the header inside the top margin, so
//!   fo:margin-top = w:header, header height = w:top - w:header
//! (the bottom likewise), and a page without a header keeps w:top as margin.

use docx_engine::model::{
    DocDefaults, DocDefaultsLineRule, ParaAlign, ParaFormat, ParaFormatLineRule, ParsedDoc, Run,
    RunCaps, StyleDisplay, StyleDisplayAlign, StyleDisplayCaps, StyleDisplayLineRule,
    StyleInfoType, TabStop,
};
use docx_engine::section::SectionSettings;
use jscompat::{
    JsMap, JsNum, JsObject, js_regex, math_max, math_min, math_round, number_to_string,
    parse_float, replace_first,
};
use serde::Serialize;

use super::theme::style_of;
use crate::core::OdtError;
use crate::core::styles::OdtMasterPageRegionName;
use crate::core::xml::{PrefixMap, escape_xml_attr};
use crate::page::geometry::twips_to_length;
use crate::text::lists::num_fmt_to_odf;
use crate::text::props::{
    AttrOverrides, ParaKey, ParaKeys, TextFormat, TextKey, TextKeys, para_keys, para_overrides,
    text_keys, text_overrides,
};
use crate::text::style_xml::{StyleXmlEdit, edit_style_xml, new_style_xml};
use crate::text::units::to_fixed;

/// `FontSet`: font families used by the styles (declared as font faces).
#[derive(Default)]
pub struct FontSet {
    pub families: JsMap<()>,
}

impl FontSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// `FontSet.face`
    pub fn face(&mut self, family: &str) -> String {
        self.families.set(family, ());
        family.to_owned()
    }

    /// `FontSet.decls`
    pub fn decls(&self) -> String {
        self.families
            .keys()
            .map(|f| {
                let family = if js_regex!(r"\s").test(f) {
                    format!("'{f}'")
                } else {
                    f.to_owned()
                };
                format!(
                    "<style:font-face style:name=\"{}\" svg:font-family=\"{}\"/>",
                    escape_xml_attr(f),
                    escape_xml_attr(&family)
                )
            })
            .collect()
    }
}

/// The result of `paragraphProps`: `{ attrs, tabs? }`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ParagraphProps {
    pub attrs: AttrOverrides,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tabs: Option<String>,
}

/// The keys of `keys` whose value is neither `null` nor `false`, in the order
/// of the keys (`Object.keys(keys).filter(...)` of `paragraphProps`).
fn set_para_keys(keys: &ParaKeys) -> Vec<ParaKey> {
    let mut set = Vec::new();
    let mut push = |on: bool, key: ParaKey| {
        if on {
            set.push(key);
        }
    };
    push(keys.align.is_some(), ParaKey::Align);
    push(keys.indent_left.is_some(), ParaKey::IndentLeft);
    push(keys.indent_right.is_some(), ParaKey::IndentRight);
    push(keys.indent_first_line.is_some(), ParaKey::IndentFirstLine);
    push(keys.space_before.is_some(), ParaKey::SpaceBefore);
    push(keys.space_after.is_some(), ParaKey::SpaceAfter);
    push(keys.line.is_some(), ParaKey::Line);
    push(keys.keep_next, ParaKey::KeepNext);
    push(keys.keep_lines, ParaKey::KeepLines);
    push(keys.page_break_before, ParaKey::PageBreakBefore);
    push(keys.shading.is_some(), ParaKey::Shading);
    push(keys.tabs.is_some(), ParaKey::Tabs);
    set
}

/// The same for the text keys.
fn set_text_keys(keys: &TextKeys) -> Vec<TextKey> {
    let mut set = Vec::new();
    let mut push = |on: bool, key: TextKey| {
        if on {
            set.push(key);
        }
    };
    push(keys.bold, TextKey::Bold);
    push(keys.italic, TextKey::Italic);
    push(keys.underline, TextKey::Underline);
    push(keys.strike, TextKey::Strike);
    push(keys.vert_align.is_some(), TextKey::VertAlign);
    push(keys.caps.is_some(), TextKey::Caps);
    push(keys.color.is_some(), TextKey::Color);
    push(keys.size.is_some(), TextKey::Size);
    push(keys.font.is_some(), TextKey::Font);
    push(keys.font_ascii.is_some(), TextKey::FontAscii);
    push(keys.font_cs.is_some(), TextKey::FontCs);
    push(keys.spacing.is_some(), TextKey::Spacing);
    push(keys.scale.is_some(), TextKey::Scale);
    push(keys.background.is_some(), TextKey::Background);
    set
}

/// An `AttrOverrides` without its `null` values.
fn without_null(attrs: &AttrOverrides) -> AttrOverrides {
    let mut out = AttrOverrides::new();
    for (k, v) in attrs.entries() {
        if v.is_some() {
            out.set(k, v.clone());
        }
    }
    out
}

/// `paragraphProps`: paragraph properties of a format, every value it states
/// written out.
pub fn paragraph_props(format: &ParaFormat) -> ParagraphProps {
    let keys = para_keys(Some(format));
    let mut set = set_para_keys(&keys);
    if *format.space_before == Some(JsNum(0.0)) && !set.contains(&ParaKey::SpaceBefore) {
        set.push(ParaKey::SpaceBefore);
    }
    let empty = para_keys(Some(&ParaFormat::default()));
    let overrides = para_overrides(
        &set,
        format,
        format.indent_left.map_or(0.0, |n| n.0),
        &empty,
    );
    ParagraphProps {
        attrs: without_null(&overrides.attrs),
        tabs: overrides.tab_stops.filter(|tabs| !tabs.is_empty()),
    }
}

/// `trio`
fn trio(out: &mut AttrOverrides, base: &str, value: &str) {
    out.set(format!("fo:{base}"), Some(value.to_owned()));
    out.set(format!("style:{base}-asian"), Some(value.to_owned()));
    out.set(format!("style:{base}-complex"), Some(value.to_owned()));
}

/// `textProps`: text properties of a format, every value it states written
/// out.
pub fn text_props(format: &TextFormat, fonts: &mut FontSet) -> AttrOverrides {
    let keys = text_keys(Some(format));
    let set = set_text_keys(&keys);
    let mut face = |family: &str| fonts.face(family);
    let attrs = text_overrides(&set, &keys, &mut face);
    let mut out = without_null(&attrs);
    // an explicit "not bold" / "not italic" of a style overrides its parent's
    if *format.bold == Some(false) {
        trio(&mut out, "font-weight", "normal");
    }
    if *format.italic == Some(false) {
        trio(&mut out, "font-style", "normal");
    }
    out
}

/// `Slot<JsNum>` read as `number | undefined`.
fn num(slot: &jscompat::Slot<JsNum>) -> Option<f64> {
    slot.map(|n| n.0)
}

/// A JavaScript truthy number.
fn truthy_num(n: Option<f64>) -> Option<f64> {
    n.filter(|n| *n != 0.0 && !n.is_nan())
}

/// A JavaScript truthy string.
fn truthy_str(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

/// `paraFormatOf`
fn para_format_of(d: &StyleDisplay) -> ParaFormat {
    let mut f = ParaFormat::default();
    if let Some(align) = *d.align {
        f.align.set(match align {
            StyleDisplayAlign::Left => ParaAlign::Left,
            StyleDisplayAlign::Center => ParaAlign::Center,
            StyleDisplayAlign::Right => ParaAlign::Right,
            StyleDisplayAlign::Justify => ParaAlign::Justify,
            StyleDisplayAlign::Distribute => ParaAlign::Distribute,
        });
    }
    if let Some(n) = *d.indent_left_twips {
        f.indent_left.set(n);
    }
    if let Some(n) = *d.indent_right_twips {
        f.indent_right.set(n);
    }
    if let Some(n) = *d.indent_first_line_twips {
        f.indent_first_line.set(n);
    }
    if let Some(n) = *d.space_before_twips {
        f.space_before.set(n);
    }
    if let Some(n) = *d.space_after_twips {
        f.space_after.set(n);
    }
    match *d.line_rule {
        Some(rule @ (StyleDisplayLineRule::Exact | StyleDisplayLineRule::AtLeast)) => {
            if let Some(raw) = truthy_num(num(&d.line_raw_twips)) {
                f.line_rule.set(if rule == StyleDisplayLineRule::Exact {
                    ParaFormatLineRule::Exact
                } else {
                    ParaFormatLineRule::AtLeast
                });
                f.line_raw_twips.set(JsNum(raw));
            }
        }
        _ => {
            if let Some(spacing) = truthy_num(num(&d.line_spacing)) {
                f.line_rule.set(ParaFormatLineRule::Auto);
                f.line_spacing.set(JsNum(spacing));
            }
        }
    }
    if *d.keep_next == Some(true) {
        f.keep_next.set(true);
    }
    if *d.keep_lines == Some(true) {
        f.keep_lines.set(true);
    }
    if *d.page_break_before == Some(true) {
        f.page_break_before.set(true);
    }
    if let Some(fill) = truthy_str(d.shading_fill.as_deref()).filter(|fill| *fill != "auto") {
        f.shading_fill.set(fill.to_owned());
    }
    if let Some(stops) = d.tab_stops.as_deref().filter(|stops| !stops.is_empty()) {
        let kept: Vec<TabStop> = stops.iter().filter(|t| t.rel.is_none()).cloned().collect();
        f.tab_stops.set(kept);
    }
    f
}

/// The literal `textFormatOf` takes: the text fields of a style display or of
/// the document defaults.
#[derive(Default)]
struct TextSource<'a> {
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    strike: Option<bool>,
    color: Option<&'a str>,
    size_half_points: Option<f64>,
    font: Option<&'a str>,
    font_ascii: Option<&'a str>,
    east_asia_font: Option<&'a str>,
    cs_font: Option<&'a str>,
    char_spacing_twips: Option<f64>,
    caps: Option<RunCaps>,
    shading: Option<&'a str>,
}

impl<'a> TextSource<'a> {
    fn of_display(d: &'a StyleDisplay) -> Self {
        Self {
            bold: *d.bold,
            italic: *d.italic,
            underline: *d.underline,
            strike: *d.strike,
            color: d.color.as_deref(),
            size_half_points: num(&d.size_half_points),
            font: d.font.as_deref(),
            font_ascii: d.font_ascii.as_deref(),
            east_asia_font: d.east_asia_font.as_deref(),
            cs_font: d.cs_font.as_deref(),
            char_spacing_twips: num(&d.char_spacing_twips),
            caps: d.caps.map(|caps| match caps {
                StyleDisplayCaps::All => RunCaps::All,
                StyleDisplayCaps::Small => RunCaps::Small,
                StyleDisplayCaps::None => RunCaps::None,
            }),
            shading: d.shading.as_deref(),
        }
    }
}

/// `textFormatOf`
fn text_format_of(d: &TextSource<'_>) -> TextFormat {
    let mut f = Run::default();
    if let Some(bold) = d.bold {
        f.bold.set(bold);
    }
    if let Some(italic) = d.italic {
        f.italic.set(italic);
    }
    if d.underline == Some(true) {
        f.underline.set(true);
    }
    if d.strike == Some(true) {
        f.strike.set(true);
    }
    if let Some(color) = truthy_str(d.color).filter(|color| *color != "auto") {
        f.color.set(color.to_owned());
    }
    if let Some(size) = truthy_num(d.size_half_points) {
        f.size_half_points.set(JsNum(size));
    }
    if let Some(latin) = truthy_str(d.font_ascii.or(d.font)) {
        f.font_ascii.set(latin.to_owned());
    }
    if let Some(ea) = truthy_str(d.east_asia_font) {
        f.east_asia_font.set(ea.to_owned());
    }
    if let Some(font) = truthy_str(d.east_asia_font.or(d.font)) {
        f.font.set(font.to_owned());
    }
    if let Some(cs) = truthy_str(d.cs_font) {
        f.font_cs.set(cs.to_owned());
    }
    if let Some(spacing) = truthy_num(d.char_spacing_twips) {
        f.char_spacing_twips.set(JsNum(spacing));
    }
    if let Some(caps) = d.caps.filter(|caps| *caps != RunCaps::None) {
        f.caps.set(caps);
    }
    if let Some(shading) = truthy_str(d.shading) {
        f.shading.set(shading.to_owned());
    }
    f
}

/// `styleXml`
fn style_xml(
    name: &str,
    family: &str,
    extra: AttrOverrides,
    para: Option<&ParagraphProps>,
    text: Option<&AttrOverrides>,
    element: &str,
) -> Result<String, OdtError> {
    let mut props: JsObject<AttrOverrides> = JsObject::new();
    if let Some(para) = para
        && (!para.attrs.is_empty() || para.tabs.is_some())
    {
        props.set("style:paragraph-properties", para.attrs.clone());
    }
    if let Some(text) = text
        && !text.is_empty()
    {
        props.set("style:text-properties", text.clone());
    }
    let mut base = new_style_xml(name, family, None);
    if element != "style:style" {
        base = format!("<{element} style:family=\"{family}\"></{element}>");
    }
    edit_style_xml(
        &base,
        &PrefixMap::new(),
        &StyleXmlEdit {
            attrs: Some(extra),
            props: Some(props),
            tab_stops: para.and_then(|p| p.tabs.clone()),
            ..StyleXmlEdit::default()
        },
    )
}

/// `LANG`
fn lang(tag: Option<&str>, suffix: &str) -> AttrOverrides {
    let mut out = AttrOverrides::new();
    let Some(tag) = truthy_str(tag) else {
        return out;
    };
    let mut parts = tag.split('-');
    let language = parts.next();
    let country = parts.next();
    let lk = if suffix.is_empty() {
        "fo:language".to_owned()
    } else {
        format!("style:language{suffix}")
    };
    let ck = if suffix.is_empty() {
        "fo:country".to_owned()
    } else {
        format!("style:country{suffix}")
    };
    if let Some(language) = truthy_str(language) {
        out.set(lk, Some(language.to_lowercase()));
    }
    if let Some(country) = truthy_str(country) {
        out.set(ck, Some(country.to_uppercase()));
    }
    out
}

/// The result of `documentDefaults`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DocumentDefaults {
    pub para: ParaFormat,
    pub text: TextFormat,
}

/// `documentDefaults`: the docx document defaults as paragraph and run formats
/// (Word's built-ins filled in).
pub fn document_defaults(defaults: Option<&DocDefaults>) -> DocumentDefaults {
    let empty = DocDefaults::default();
    let d = defaults.unwrap_or(&empty);
    let mut format = ParaFormat::default();
    format.align.set(ParaAlign::Left);
    let line_rule = *d.line_rule;
    if matches!(
        line_rule,
        Some(DocDefaultsLineRule::Exact | DocDefaultsLineRule::AtLeast)
    ) {
        if let Some(raw) = truthy_num(num(&d.line_raw_twips)) {
            format
                .line_rule
                .set(if line_rule == Some(DocDefaultsLineRule::Exact) {
                    ParaFormatLineRule::Exact
                } else {
                    ParaFormatLineRule::AtLeast
                });
            format.line_raw_twips.set(JsNum(raw));
        }
    } else if let Some(spacing) = truthy_num(num(&d.line_spacing)) {
        format.line_rule.set(ParaFormatLineRule::Auto);
        format.line_spacing.set(JsNum(spacing));
    } else {
        format.line_rule.set(ParaFormatLineRule::Auto);
        format.line_spacing.set(JsNum(1.0));
    }
    format
        .space_before
        .set(JsNum(num(&d.space_before_twips).unwrap_or(0.0)));
    format
        .space_after
        .set(JsNum(num(&d.space_after_twips).unwrap_or(0.0)));
    let text = text_format_of(&TextSource {
        bold: *d.bold,
        italic: *d.italic,
        color: d.color.as_deref(),
        // Word's built-in default when no size is stated
        size_half_points: Some(num(&d.size_half_points).unwrap_or(20.0)),
        // Word's built-in Latin face when the document names none
        font_ascii: Some(d.ascii_font.as_deref().unwrap_or("Times New Roman")),
        east_asia_font: d.east_asia_font.as_deref(),
        cs_font: d.cs_font.as_deref(),
        ..TextSource::default()
    });
    DocumentDefaults { para: format, text }
}

/// `defaultStyleXml`: `style:default-style` for paragraphs from the docx
/// document defaults.
pub fn default_style_xml(
    defaults: Option<&DocDefaults>,
    fonts: &mut FontSet,
) -> Result<String, OdtError> {
    let base = document_defaults(defaults);
    let mut text = text_props(&base.text, fonts);
    let language = lang(defaults.and_then(|d| d.lang.as_deref()), "");
    for (k, v) in language.entries() {
        text.set(k, v.clone());
    }
    let asian = lang(defaults.and_then(|d| d.east_asia_lang.as_deref()), "-asian");
    for (k, v) in asian.entries() {
        text.set(k, v.clone());
    }
    style_xml(
        "",
        "paragraph",
        AttrOverrides::new(),
        Some(&paragraph_props(&base.para)),
        Some(&text),
        "style:default-style",
    )
}

/// `outlineStyleXml`: the outline numbering of headings: none, stated so that
/// no reader supplies its own (a docx heading carries its numbering, if any, in
/// its own list). Hancom ignores it and numbers every `text:h`; see `headings`.
pub fn outline_style_xml() -> String {
    let mut levels = String::new();
    for level in 1..=10 {
        levels.push_str(&format!(
            "<text:outline-level-style text:level=\"{level}\" style:num-format=\"\"/>"
        ));
    }
    format!("<text:outline-style style:name=\"Outline\">{levels}</text:outline-style>")
}

/// `ParagraphStyles`: common paragraph styles: docx style id to ODF style name.
#[derive(Debug)]
pub struct ParagraphStyles {
    pub xml: String,
    pub names: JsMap<String>,
    /// the ODF name of the docx default paragraph style
    pub base: String,
}

/// `ncName`: the replacement of `/[^A-Za-z0-9_.-]/g` works per UTF-16 code
/// unit, so a character outside the BMP becomes two underscores.
fn nc_name(id: &str, taken: &mut JsMap<()>) -> String {
    let mut base = String::with_capacity(id.len());
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
            base.push(ch);
        } else {
            for _ in 0..ch.len_utf16() {
                base.push('_');
            }
        }
    }
    if !js_regex!(r"^[A-Za-z_]").test(&base) {
        base = format!("S_{base}");
    }
    let mut name = base.clone();
    let mut n = 2;
    while taken.has(&name.to_lowercase()) {
        name = format!("{base}_{n}");
        n += 1;
    }
    taken.set(name.to_lowercase(), ());
    name
}

/// The `write` closure of `paragraphStylesXml`.
#[allow(clippy::too_many_arguments)]
fn write_style(
    parsed: &ParsedDoc,
    base: &DocumentDefaults,
    fonts: &mut FontSet,
    out: &mut String,
    names: &mut JsMap<String>,
    style_id: &str,
    name: &str,
    display: Option<&str>,
) -> Result<(), OdtError> {
    let info = style_of(parsed, style_id);
    let none = StyleDisplay::default();
    let d = info.and_then(|i| i.display.as_ref()).unwrap_or(&none);
    let mut extra = AttrOverrides::new();
    extra.set("style:class", Some("text".to_owned()));
    if let Some(display) = truthy_str(display).filter(|display| *display != name) {
        extra.set("style:display-name", Some(display.to_owned()));
    }
    if let Some(level) = info
        .and_then(|i| i.heading_level)
        .map(|n| n.0)
        .filter(|n| *n != 0.0 && !n.is_nan())
    {
        extra.set("style:default-outline-level", Some(number_to_string(level)));
    }
    let mut para = base.para.clone();
    para.assign(&para_format_of(d));
    let mut text = base.text.clone();
    text.assign(&text_format_of(&TextSource::of_display(d)));
    let text = text_props(&text, fonts);
    out.push_str(&style_xml(
        name,
        "paragraph",
        extra,
        Some(&paragraph_props(&para)),
        Some(&text),
        "style:style",
    )?);
    names.set(style_id, name.to_owned());
    Ok(())
}

/// `paragraphStylesXml`: every common paragraph style states its whole look:
/// the document defaults under the style's own resolved values. Hancom does not
/// apply every value of `style:default-style` (line spacing, alignment), so
/// nothing is left to it.
pub fn paragraph_styles_xml(
    parsed: &ParsedDoc,
    fonts: &mut FontSet,
) -> Result<ParagraphStyles, OdtError> {
    let base = document_defaults(parsed.doc_defaults.as_ref());
    let mut names: JsMap<String> = JsMap::new();
    let mut taken: JsMap<()> = JsMap::new();
    taken.set("standard", ());
    let mut out = String::new();
    let styles: Vec<&docx_engine::model::StyleInfo> = parsed
        .styles
        .0
        .iter()
        .map(|(_, s)| s)
        .filter(|s| s.r#type == StyleInfoType::Paragraph)
        .collect();
    let def = styles
        .iter()
        .position(|s| s.is_default == Some(true))
        .or_else(|| styles.iter().position(|s| s.style_id == "Normal"));
    if let Some(def) = def {
        let s = styles[def];
        let display = if !s.name.is_empty() && s.name != "Normal" {
            Some(s.name.as_str())
        } else {
            None
        };
        write_style(
            parsed,
            &base,
            fonts,
            &mut out,
            &mut names,
            &s.style_id,
            "Standard",
            display,
        )?;
    } else {
        let text = text_props(&base.text, fonts);
        out.push_str(&style_xml(
            "Standard",
            "paragraph",
            {
                let mut extra = AttrOverrides::new();
                extra.set("style:class", Some("text".to_owned()));
                extra
            },
            Some(&paragraph_props(&base.para)),
            Some(&text),
            "style:style",
        )?);
    }
    for (i, s) in styles.iter().enumerate() {
        if Some(i) == def {
            continue;
        }
        let display = if s.name.is_empty() {
            s.style_id.clone()
        } else {
            replace_first(js_regex!(r"^heading (\d)$"), 1, &s.name, "Heading $1")
        };
        let name = nc_name(&s.style_id, &mut taken);
        write_style(
            parsed,
            &base,
            fonts,
            &mut out,
            &mut names,
            &s.style_id,
            &name,
            Some(&display),
        )?;
    }
    Ok(ParagraphStyles {
        xml: out,
        names,
        base: "Standard".to_owned(),
    })
}

// ---------------------------------------------------------------------------
// Pages

/// The text columns of a page: `{ count, gap }`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PageColumns {
    pub count: f64,
    pub gap: f64,
}

/// `MasterSpec`: what one master page needs.
#[derive(Clone, Debug)]
pub struct MasterSpec {
    pub name: String,
    pub layout_name: String,
    pub settings: SectionSettings,
    pub header: bool,
    pub footer: bool,
    /// region name; the inner XML is filled later
    pub regions: Vec<OdtMasterPageRegionName>,
    pub num_format: Option<String>,
    pub mirrored: bool,
    /// text columns of the page (1 when the run has continuous sections of its own)
    pub columns: PageColumns,
}

/// `pageLayoutXml`
pub fn page_layout_xml(spec: &MasterSpec) -> String {
    let s = &spec.settings;
    let len = |twips: f64| twips_to_length(math_max(0.0, twips));
    let gutter = s.gutter.map_or(0.0, |n| n.0);
    let at_top = s.gutter_at_top == Some(true);
    let left = s.margin_left.0 + if at_top { 0.0 } else { gutter };
    let top = s.margin_top.0 + if at_top { gutter } else { 0.0 };
    let header_dist = math_min(s.header_dist.map_or(top, |n| n.0), top);
    let footer_dist = math_min(
        s.footer_dist.map_or(s.margin_bottom.0, |n| n.0),
        s.margin_bottom.0,
    );
    let margin_top = len(if spec.header { header_dist } else { top });
    let margin_bottom = len(if spec.footer {
        footer_dist
    } else {
        s.margin_bottom.0
    });
    let mut page: Vec<(&str, String)> = vec![
        ("fo:page-width", len(s.page_width.0)),
        ("fo:page-height", len(s.page_height.0)),
        ("style:print-orientation", s.orientation.to_owned()),
        ("fo:margin-top", margin_top.clone()),
        ("fo:margin-bottom", margin_bottom.clone()),
        ("fo:margin-left", len(left)),
        ("fo:margin-right", len(s.margin_right.0)),
    ];
    if let Some(format) = spec.num_format.as_deref().filter(|f| !f.is_empty()) {
        page.push(("style:num-format", num_fmt_to_odf(format).to_string()));
    }
    let attrs: String = page
        .iter()
        .map(|(k, v)| format!(" {k}=\"{}\"", escape_xml_attr(v)))
        .collect();
    // the band height is what remains of the docx edge after the written margin, so
    // margin + height reads back as the exact docx value
    let band = |present: bool, edge: f64, margin: &str, spacing: &str| -> String {
        if !present {
            return String::new();
        }
        let height = math_max(0.0, (edge * 2.54) / 1440.0 - parse_float(margin));
        format!(
            "<style:header-footer-properties svg:height=\"{}cm\" {spacing}=\"0cm\"/>",
            to_fixed(height, 4)
        )
    };
    let columns = columns_xml(&spec.columns);
    format!(
        "<style:page-layout style:name=\"{}\"{}>{}<style:header-style>{}</style:header-style><style:footer-style>{}</style:footer-style></style:page-layout>",
        escape_xml_attr(&spec.layout_name),
        if spec.mirrored {
            " style:page-usage=\"mirrored\""
        } else {
            ""
        },
        if columns.is_empty() {
            format!("<style:page-layout-properties{attrs}/>")
        } else {
            format!("<style:page-layout-properties{attrs}>{columns}</style:page-layout-properties>")
        },
        band(spec.header, top, &margin_top, "fo:margin-bottom"),
        band(
            spec.footer,
            s.margin_bottom.0,
            &margin_bottom,
            "fo:margin-top"
        ),
    )
}

/// `columnsXml`: `style:columns` for a column count and gap (twips), `''` for
/// one column. The columns are listed one by one: Hancom stops responding on a
/// `style:columns` without its `style:column` children.
pub fn columns_xml(columns: &PageColumns) -> String {
    let count = math_max(1.0, math_round(columns.count));
    if count < 2.0 {
        return String::new();
    }
    let gap = math_max(0.0, columns.gap);
    let half = twips_to_length(gap / 2.0);
    let mut inner = String::new();
    let mut k = 0.0;
    while k < count {
        inner.push_str(&format!(
            "<style:column style:rel-width=\"1000*\" fo:start-indent=\"{}\" fo:end-indent=\"{}\"/>",
            if k == 0.0 { "0cm" } else { half.as_str() },
            if k == count - 1.0 {
                "0cm"
            } else {
                half.as_str()
            },
        ));
        k += 1.0;
    }
    format!(
        "<style:columns fo:column-count=\"{}\" fo:column-gap=\"{}\">{inner}</style:columns>",
        number_to_string(count),
        twips_to_length(gap)
    )
}

/// `masterPageXml`
pub fn master_page_xml(spec: &MasterSpec) -> String {
    let regions: String = spec
        .regions
        .iter()
        .map(|r| format!("<style:{}/>", r.as_str()))
        .collect();
    format!(
        "<style:master-page style:name=\"{}\" style:page-layout-name=\"{}\">{regions}</style:master-page>",
        escape_xml_attr(&spec.name),
        escape_xml_attr(&spec.layout_name),
    )
}
