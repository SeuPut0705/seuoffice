//! Theme reading (packages/pptx-engine/src/theme.ts): the colour, font and
//! format schemes of a theme part, the theme font and scheme colour lookups,
//! and the colour mapping of a master, layout or slide.

use crate::xml_utils::xml_parse_object as parse_object;
use jscompat::{
    JsObject, JsRegex, RegexLimit, TryJsRegex, js_object, js_regex, truthy, try_js_regex,
    value_to_string, value_truthy,
};
use ooxml_xml::ObjectOptions;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::xml_utils::{as_xml_node, xml_array};

js_object! {
    deserialize;
    /// `Theme`. A struct of keys set in order: `parseTheme` writes them in
    /// one order, while `themeWithOverride` and the callers that assign
    /// `clrMap` put a key it lacked after the others.
    #[derive(Debug, Clone, PartialEq)]
    pub struct Theme {
        pub colors: JsObject<String>,
        pub clr_map: JsObject<String>,
        pub major_font: String,
        pub minor_font: String,
        pub major_ea_font: String,
        pub minor_ea_font: String,
        pub major_script_fonts: JsObject<String>,
        pub minor_script_fonts: JsObject<String>,
        pub major_cs_font: String,
        pub minor_cs_font: String,
        pub fill_styles: Vec<Value>,
        pub ln_styles: Vec<Value>,
        pub effect_styles: Vec<Value>,
        pub bg_fill_styles: Vec<Value>,
    }
}

/// `new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })`
fn parse(xml: &str) -> Result<Value, String> {
    parse_object(xml, &ObjectOptions::default()).map_err(|error| error.to_string())
}

/// `topLevelFragments`: each depth-1 child of the fragment, whole, in order;
/// `RegexLimit` where the tag search passed the bound.
fn top_level_fragments(xml: &str) -> Result<Vec<&str>, RegexLimit> {
    let mut out = Vec::new();
    let mut depth: i64 = 0;
    let mut cur_start: Option<usize> = None;
    for m in try_js_regex!(r#"<(\/?)([a-zA-Z][\w:]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>"#)
        .try_find_iter(xml)
    {
        let m = m?;
        let closing = m.get(1) == Some("/");
        let self_close = m.get(4) == Some("/");
        if !closing && !self_close {
            if depth == 0 {
                cur_start = Some(m.start());
            }
            depth += 1;
        } else if closing {
            depth -= 1;
            if depth == 0
                && let Some(fragment) = cur_start.and_then(|start| xml.get(start..m.end()))
            {
                out.push(fragment);
            }
        } else if self_close && depth == 0 {
            out.push(m.as_str());
        }
    }
    Ok(out)
}

/// `parseStyleList`: the children of `<a:{tag}>`, each parsed on its own.
fn parse_style_list(theme_xml: &str, tag: &str) -> Result<Option<Vec<Value>>, String> {
    let list = TryJsRegex::new(&format!(r"<a:{tag}\b[^>]*>([\s\S]*?)</a:{tag}>"), "")
        .map_err(|error| error.to_string())?;
    let Some(m) = list
        .try_exec(theme_xml)
        .map_err(|limit| limit.to_string())?
    else {
        return Ok(None);
    };
    let items = top_level_fragments(m.get(1).unwrap_or_default())
        .map_err(|limit| limit.to_string())?
        .into_iter()
        .map(|fragment| parse(fragment).map(|node| as_xml_node(Some(&node)).clone()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((!items.is_empty()).then_some(items))
}

fn read_color_node(node: Option<&Value>) -> Option<String> {
    if !value_truthy(node) {
        return None;
    }
    let n = as_xml_node(node);
    let srgb = as_xml_node(n.get("a:srgbClr"));
    if value_truthy(n.get("a:srgbClr")) {
        return Some(format!(
            "#{}",
            value_to_string(srgb.get("@_val")).to_uppercase()
        ));
    }
    let sys = as_xml_node(n.get("a:sysClr"));
    if value_truthy(n.get("a:sysClr")) {
        return Some(sys_color_hex(sys.get("@_val"), sys.get("@_lastClr")));
    }
    None
}

/// `sysColorHex`: `window` and `windowText` are the live system colours;
/// any other keeps its cached `lastClr`.
pub fn sys_color_hex(val: Option<&Value>, last_clr: Option<&Value>) -> String {
    match val {
        Some(Value::String(val)) if val == "window" => return "#FFFFFF".to_owned(),
        Some(Value::String(val)) if val == "windowText" => return "#000000".to_owned(),
        _ => {}
    }
    let last_clr = match last_clr {
        None | Some(Value::Null) => "000000".to_owned(),
        Some(last_clr) => value_to_string(Some(last_clr)),
    };
    format!("#{}", last_clr.to_uppercase())
}

fn typeface(scheme: &Value, font: &str, script: &str) -> Option<String> {
    match as_xml_node(as_xml_node(scheme.get(font)).get(script)).get("@_typeface") {
        Some(Value::String(v)) if !v.is_empty() => Some(v.clone()),
        _ => None,
    }
}

fn script_fonts(scheme: &Value, font: &str) -> Option<JsObject<String>> {
    let mut out = JsObject::new();
    for f in xml_array(as_xml_node(scheme.get(font)).get("a:font")) {
        if let (Some(Value::String(script)), Some(Value::String(face))) =
            (f.get("@_script"), f.get("@_typeface"))
            && !face.is_empty()
        {
            // `setOwn`: a script named `__proto__` is an entry like any other
            out.set(script.clone(), face.clone());
        }
    }
    (!out.is_empty()).then_some(out)
}

const SCHEME_SLOTS: [(&str, &str); 12] = [
    ("dk1", "a:dk1"),
    ("lt1", "a:lt1"),
    ("dk2", "a:dk2"),
    ("lt2", "a:lt2"),
    ("accent1", "a:accent1"),
    ("accent2", "a:accent2"),
    ("accent3", "a:accent3"),
    ("accent4", "a:accent4"),
    ("accent5", "a:accent5"),
    ("accent6", "a:accent6"),
    ("hlink", "a:hlink"),
    ("folHlink", "a:folHlink"),
];

/// `parseTheme`. Throws where the parser refuses the part or a format
/// scheme entry.
pub fn parse_theme(theme_xml: &str) -> Result<Theme, String> {
    let doc = parse(theme_xml)?;
    let doc = as_xml_node(Some(&doc));
    let theme_el = as_xml_node(
        doc.get("a:theme")
            .filter(|theme| !theme.is_null())
            .or_else(|| doc.get("theme")),
    );
    let elements = as_xml_node(theme_el.get("a:themeElements"));
    let clr_scheme = as_xml_node(elements.get("a:clrScheme"));
    let mut colors = JsObject::new();
    for (key, tag) in SCHEME_SLOTS {
        if let Some(c) = read_color_node(clr_scheme.get(tag)) {
            colors.set(key, c);
        }
    }
    let font_scheme = as_xml_node(elements.get("a:fontScheme"));
    let major_font = typeface(font_scheme, "a:majorFont", "a:latin");
    let minor_font = typeface(font_scheme, "a:minorFont", "a:latin");
    let major_ea_font = typeface(font_scheme, "a:majorFont", "a:ea");
    let minor_ea_font = typeface(font_scheme, "a:minorFont", "a:ea");
    let major_cs_font = typeface(font_scheme, "a:majorFont", "a:cs");
    let minor_cs_font = typeface(font_scheme, "a:minorFont", "a:cs");
    let major_script_fonts = script_fonts(font_scheme, "a:majorFont");
    let minor_script_fonts = script_fonts(font_scheme, "a:minorFont");
    // fmtScheme lists mix element types, so their order comes from the raw text
    let fmt = js_regex!(r"<a:fmtScheme\b[^>]*>[\s\S]*?<\/a:fmtScheme>")
        .exec(theme_xml)
        .map_or("", |m| m.as_str());
    let fill_styles = parse_style_list(fmt, "fillStyleLst")?;
    let ln_styles = parse_style_list(fmt, "lnStyleLst")?;
    let effect_styles = parse_style_list(fmt, "effectStyleLst")?;
    let bg_fill_styles = parse_style_list(fmt, "bgFillStyleLst")?;
    let mut theme = Theme::default();
    theme.colors.set(colors);
    theme.major_font.assign(major_font);
    theme.minor_font.assign(minor_font);
    theme.major_ea_font.assign(major_ea_font);
    theme.minor_ea_font.assign(minor_ea_font);
    theme.major_cs_font.assign(major_cs_font);
    theme.minor_cs_font.assign(minor_cs_font);
    theme.major_script_fonts.set_some(major_script_fonts);
    theme.minor_script_fonts.set_some(minor_script_fonts);
    theme.fill_styles.set_some(fill_styles);
    theme.ln_styles.set_some(ln_styles);
    theme.effect_styles.set_some(effect_styles);
    theme.bg_fill_styles.set_some(bg_fill_styles);
    Ok(theme)
}

/// `themeWithOverride`: the chart part's `<a:themeOverride>` over the deck
/// theme, field by field; `clrMap` stays the base's.
pub fn theme_with_override(base: Option<&Theme>, override_xml: &str) -> Result<Theme, String> {
    let inner = js_regex!(r"<a:themeOverride\b[^>]*>([\s\S]*)<\/a:themeOverride>")
        .exec(override_xml)
        .and_then(|m| m.get(1));
    let Some(inner) = truthy(inner) else {
        return Ok(base.cloned().unwrap_or_else(|| {
            let mut theme = Theme::default();
            theme.colors.set(JsObject::new());
            theme
        }));
    };
    let parsed = parse_theme(&format!(
        "<a:theme><a:themeElements>{inner}</a:themeElements></a:theme>"
    ))?;
    let mut colors = base
        .and_then(|base| (*base.colors).clone())
        .unwrap_or_default();
    if let Some(parsed_colors) = &*parsed.colors {
        colors.assign(parsed_colors);
    }
    let mut merged = base.cloned().unwrap_or_default();
    merged.colors.set(colors);
    // the keys of `parsed` in the order parse_theme sets them, undefined ones skipped
    merged.major_font.set_some(parsed.major_font.into_option());
    merged.minor_font.set_some(parsed.minor_font.into_option());
    merged
        .major_ea_font
        .set_some(parsed.major_ea_font.into_option());
    merged
        .minor_ea_font
        .set_some(parsed.minor_ea_font.into_option());
    merged
        .major_cs_font
        .set_some(parsed.major_cs_font.into_option());
    merged
        .minor_cs_font
        .set_some(parsed.minor_cs_font.into_option());
    merged
        .major_script_fonts
        .set_some(parsed.major_script_fonts.into_option());
    merged
        .minor_script_fonts
        .set_some(parsed.minor_script_fonts.into_option());
    merged
        .fill_styles
        .set_some(parsed.fill_styles.into_option());
    merged.ln_styles.set_some(parsed.ln_styles.into_option());
    merged
        .effect_styles
        .set_some(parsed.effect_styles.into_option());
    merged
        .bg_fill_styles
        .set_some(parsed.bg_fill_styles.into_option());
    Ok(merged)
}

/// `EaScript`. `han`: ideographs without a language, resolved only where the
/// theme names a single Han script.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EaScript {
    Ja,
    Ko,
    Sc,
    Tc,
    Han,
}

/// `EA_SCRIPT_TAG[script]`; `None` for `han`.
fn ea_script_tag(script: EaScript) -> Option<&'static str> {
    match script {
        EaScript::Ja => Some("Jpan"),
        EaScript::Ko => Some("Hang"),
        EaScript::Sc => Some("Hans"),
        EaScript::Tc => Some("Hant"),
        EaScript::Han => None,
    }
}

const HAN_SCRIPT_TAGS: [&str; 3] = ["Jpan", "Hans", "Hant"];

/// `eaScriptOfLang`: the East Asian script of a BCP-47 `lang`/`altLang`
/// value, which may be any parsed value or `None` for `undefined`.
pub fn ea_script_of_lang(tag: Option<&Value>) -> Option<EaScript> {
    let t = match tag {
        None | Some(Value::Null) => String::new(),
        Some(tag) => value_to_string(Some(tag)),
    }
    .to_lowercase();
    if t.starts_with("ja") {
        return Some(EaScript::Ja);
    }
    if t.starts_with("ko") {
        return Some(EaScript::Ko);
    }
    if js_regex!(r"^zh(-(tw|hk|mo|hant))").test(&t) {
        return Some(EaScript::Tc);
    }
    if t.starts_with("zh") {
        return Some(EaScript::Sc);
    }
    None
}

/// `resolveFontRef`: a theme font reference (`+mj-lt`, `+mn-ea`, ...) as
/// the font it names; a name without `+` as it is.
pub fn resolve_font_ref<'a>(
    typeface: Option<&'a str>,
    theme: Option<&'a Theme>,
    ea_script: Option<EaScript>,
) -> Option<&'a str> {
    let typeface = truthy(typeface)?;
    if !typeface.starts_with('+') {
        return Some(typeface);
    }
    let script_font = |fonts: Option<&'a JsObject<String>>| -> Option<&'a str> {
        let (ea_script, fonts) = (ea_script?, fonts?);
        if let Some(tag) = ea_script_tag(ea_script) {
            return fonts.get(tag).map(String::as_str);
        }
        let mut han = HAN_SCRIPT_TAGS
            .into_iter()
            .filter(|tag| truthy(fonts.get(tag).map(String::as_str)).is_some());
        match (han.next(), han.next()) {
            (Some(only), None) => fonts.get(only).map(String::as_str),
            _ => None,
        }
    };
    let font = |pick: fn(&'a Theme) -> Option<&'a str>| theme.and_then(pick);
    let scripts =
        |pick: fn(&'a Theme) -> Option<&'a JsObject<String>>| script_font(theme.and_then(pick));
    let major = || font(|t| t.major_font.as_deref());
    let minor = || font(|t| t.minor_font.as_deref());
    match typeface {
        "+mj-lt" => major(),
        "+mn-lt" => minor(),
        "+mj-ea" => font(|t| t.major_ea_font.as_deref())
            .or_else(|| scripts(|t| t.major_script_fonts.as_ref()))
            .or_else(major),
        "+mn-ea" => font(|t| t.minor_ea_font.as_deref())
            .or_else(|| scripts(|t| t.minor_script_fonts.as_ref()))
            .or_else(minor),
        "+mj-cs" => font(|t| t.major_cs_font.as_deref()).or_else(major),
        "+mn-cs" => font(|t| t.minor_cs_font.as_deref()).or_else(minor),
        _ => minor(),
    }
}

/// `resolveSchemeColor`: a `schemeClr` name (`tx1`, `bg1`, `accent1`,
/// `phClr`, ...) as the theme's colour, through the theme's `clrMap` or the
/// standard mapping.
pub fn resolve_scheme_color<'a>(
    name: &'a str,
    theme: Option<&'a Theme>,
    ph_clr: Option<&'a str>,
) -> Option<&'a str> {
    if name == "phClr" {
        return ph_clr;
    }
    let standard = match name {
        "tx1" => Some("dk1"),
        "bg1" => Some("lt1"),
        "tx2" => Some("dk2"),
        "bg2" => Some("lt2"),
        _ => None,
    };
    let key = theme
        .and_then(|theme| theme.clr_map.as_ref())
        .and_then(|clr_map| clr_map.get(name))
        .map(String::as_str)
        .or(standard)
        .unwrap_or(name);
    // `ownValue`: the table answers its own keys only
    theme
        .and_then(|theme| theme.colors.as_ref())
        .and_then(|colors| colors.get(key))
        .map(String::as_str)
}

/// One attribute pattern per name of the colour map, either quote.
fn clr_map_attributes() -> [(&'static str, &'static JsRegex); 12] {
    macro_rules! attribute {
        ($name:literal) => {
            (
                $name,
                js_regex!(concat!(r"\b", $name, r#"\s*=\s*(["'])(.*?)\1"#)),
            )
        };
    }
    [
        attribute!("bg1"),
        attribute!("tx1"),
        attribute!("bg2"),
        attribute!("tx2"),
        attribute!("accent1"),
        attribute!("accent2"),
        attribute!("accent3"),
        attribute!("accent4"),
        attribute!("accent5"),
        attribute!("accent6"),
        attribute!("hlink"),
        attribute!("folHlink"),
    ]
}

fn clr_map_from_tag(tag: &str) -> Option<JsObject<String>> {
    let mut out = JsObject::new();
    for (name, attribute) in clr_map_attributes() {
        if let Some(v) = truthy(attribute.exec(tag).and_then(|m| m.get(2))) {
            out.set(name, v.to_owned());
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `parseClrMap`: the slide's or layout's `<a:overrideClrMapping>` over the
/// master's `<p:clrMap>`; `None` is the standard mapping.
pub fn parse_clr_map(
    master_xml: Option<&str>,
    layout_xml: Option<&str>,
    slide_xml: Option<&str>,
) -> Option<JsObject<String>> {
    for xml in [slide_xml, layout_xml] {
        let tag = truthy(xml).and_then(|xml| {
            js_regex!(r"<a:overrideClrMapping\b[^>]*\/?>")
                .exec(xml)
                .map(|m| m.as_str())
        });
        if let Some(map) = tag.and_then(clr_map_from_tag) {
            return Some(map);
        }
    }
    let tag = truthy(master_xml).and_then(|xml| {
        js_regex!(r"<p:clrMap\b[^>]*\/?>")
            .exec(xml)
            .map(|m| m.as_str())
    });
    tag.and_then(clr_map_from_tag)
}
