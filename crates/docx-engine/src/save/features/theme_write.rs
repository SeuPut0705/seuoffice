//! The write half of theme.ts: theme fonts rewrite the major/minor font pair,
//! theme colors rewrite the a:clrScheme entries, and a theme part for a
//! document that has none. The readers are in `crate::theme`.

use jscompat::{
    JsRegex, RegexLimit, TryJsRegex, get_substitution, js_regex, replace_first,
    replace_first_string,
};

use crate::generate::escape_xml_attr;
use crate::model::{ThemeColors, ThemeFonts};
use crate::theme::ThemeColors as OfficeColors;

pub const THEME_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";

pub const THEME_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.theme+xml";

/// `COLOR_TAGS`
const COLOR_TAGS: [&str; 8] = [
    "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
];

/// `sectionOf`: the first `<tag ...>...</tag>` of the part, for the sections
/// written here; `None` for any other tag.
fn section_of<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let pattern = match tag {
        "a:clrScheme" => js_regex!(r"<a:clrScheme(?:\s[^>]*)?>[\s\S]*?</a:clrScheme>"),
        "a:majorFont" => js_regex!(r"<a:majorFont(?:\s[^>]*)?>[\s\S]*?</a:majorFont>"),
        "a:minorFont" => js_regex!(r"<a:minorFont(?:\s[^>]*)?>[\s\S]*?</a:minorFont>"),
        _ => return None,
    };
    pattern.exec(xml).map(|found| found.as_str())
}

/// `text.replace(regex, replacement)` for a regex that may stop at the bound
/// of one search: the first match only, `$` patterns expanded.
fn replace_first_try(
    regex: &TryJsRegex,
    groups: usize,
    text: &str,
    replacement: &str,
) -> Result<String, RegexLimit> {
    let Some(found) = regex.try_exec(text)? else {
        return Ok(text.to_owned());
    };
    let captures: Vec<Option<&str>> = (1..=groups).map(|index| found.get(index)).collect();
    Ok(format!(
        "{}{}{}",
        &text[..found.start()],
        get_substitution(found.as_str(), text, found.start(), &captures, replacement),
        &text[found.end()..]
    ))
}

/// `applyFontGroup`: rewrite the latin (and optional east-asian) typefaces of
/// one font group
fn apply_font_group(xml: &str, tag: &str, typeface: &str, east_asia: Option<&str>) -> String {
    let Some(section) = section_of(xml, tag) else {
        return xml.to_owned();
    };
    let latin: &JsRegex = js_regex!(r#"(<a:latin typeface=")[^"]*(")"#);
    let mut next = replace_first(
        latin,
        2,
        section,
        &format!("$1{}$2", escape_xml_attr(typeface)),
    );
    if let Some(east_asia) = east_asia {
        let ea: &JsRegex = js_regex!(r#"(<a:ea typeface=")[^"]*(")"#);
        next = replace_first(ea, 2, &next, &format!("$1{}$2", escape_xml_attr(east_asia)));
    }
    replace_first_string(xml, section, &next)
}

/// `applyThemeFonts`
pub fn apply_theme_fonts(theme_xml: &str, fonts: &ThemeFonts) -> Result<String, String> {
    let mut xml = apply_font_group(
        theme_xml,
        "a:majorFont",
        &fonts.major,
        fonts.east_asia.as_deref(),
    );
    xml = apply_font_group(
        &xml,
        "a:minorFont",
        &fonts.minor,
        fonts.east_asia.as_deref(),
    );
    Ok(xml)
}

/// `colors[tag]`
fn color_of<'a>(colors: &'a ThemeColors, tag: &str) -> Option<&'a str> {
    match tag {
        "dk2" => colors.dk2.as_deref(),
        "lt2" => colors.lt2.as_deref(),
        "accent1" => colors.accent1.as_deref(),
        "accent2" => colors.accent2.as_deref(),
        "accent3" => colors.accent3.as_deref(),
        "accent4" => colors.accent4.as_deref(),
        "accent5" => colors.accent5.as_deref(),
        _ => colors.accent6.as_deref(),
    }
}

/// `applyThemeColors`
pub fn apply_theme_colors(theme_xml: &str, colors: &ThemeColors) -> Result<String, String> {
    let Some(original) = section_of(theme_xml, "a:clrScheme") else {
        return Ok(theme_xml.to_owned());
    };
    let mut scheme = original.to_owned();
    for tag in COLOR_TAGS {
        let Some(value) = color_of(colors, tag).filter(|value| !value.is_empty()) else {
            continue;
        };
        let re = TryJsRegex::new(
            &format!(r#"(<a:{tag}>\s*<a:srgbClr val=")[0-9A-Fa-f]{{6}}(")"#),
            "",
        )
        .expect("a pattern built from a slot name compiles");
        // sysClr entries (windowText etc.) are left alone; dk2/lt2 are usually srgbClr
        scheme = replace_first_try(&re, 2, &scheme, &format!("$1{value}$2"))
            .map_err(|limit| limit.to_string())?;
    }
    let mut xml = replace_first_string(theme_xml, original, &scheme);
    if let Some(name) = colors.name.as_deref().filter(|name| !name.is_empty()) {
        let re: &JsRegex = js_regex!(r#"(<a:clrScheme name=")[^"]*(")"#);
        xml = replace_first(re, 2, &xml, &format!("$1{}$2", escape_xml_attr(name)));
    }
    Ok(xml)
}

/// `buildThemeXml`: minimal but complete theme part for documents that have
/// none (e.g. the blank template). Word requires fmtScheme; this ships the
/// standard Office format scheme skeleton.
pub fn build_theme_xml(fonts: &ThemeFonts, colors: &ThemeColors) -> Result<String, String> {
    let office = OfficeColors::office();
    let default_of = |tag: &str| -> String {
        match tag {
            "dk2" => office.dk2.clone(),
            "lt2" => office.lt2.clone(),
            "accent1" => office.accent1.clone(),
            "accent2" => office.accent2.clone(),
            "accent3" => office.accent3.clone(),
            "accent4" => office.accent4.clone(),
            "accent5" => office.accent5.clone(),
            _ => office.accent6.clone(),
        }
        .unwrap_or_default()
    };
    let c = |tag: &str| {
        let value = color_of(colors, tag)
            .map(str::to_owned)
            .unwrap_or_else(|| default_of(tag));
        format!("<a:{tag}><a:srgbClr val=\"{value}\"/></a:{tag}>")
    };
    let font = |tag: &str, typeface: &str| {
        format!(
            "<{tag}><a:latin typeface=\"{}\"/><a:ea typeface=\"{}\"/><a:cs typeface=\"\"/></{tag}>",
            escape_xml_attr(typeface),
            escape_xml_attr(fonts.east_asia.as_deref().unwrap_or(""))
        )
    };
    let clr_name = colors.name.as_deref().unwrap_or("Office");
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Office\">\
         <a:themeElements>\
         <a:clrScheme name=\"{}\">\
         <a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1>\
         <a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1>\
         {}{}{}{}{}{}{}{}\
         <a:hlink><a:srgbClr val=\"{}\"/></a:hlink>\
         <a:folHlink><a:srgbClr val=\"{}\"/></a:folHlink>\
         </a:clrScheme>\
         <a:fontScheme name=\"Office\">{}{}</a:fontScheme>\
         <a:fmtScheme name=\"Office\">\
         <a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
         <a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
         <a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst>\
         <a:lnStyleLst>\
         <a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>\
         <a:ln w=\"12700\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>\
         <a:ln w=\"19050\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>\
         </a:lnStyleLst>\
         <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>\
         <a:effectStyle><a:effectLst/></a:effectStyle>\
         <a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>\
         <a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
         <a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
         <a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst>\
         </a:fmtScheme>\
         </a:themeElements></a:theme>",
        escape_xml_attr(clr_name),
        c("dk2"),
        c("lt2"),
        c("accent1"),
        c("accent2"),
        c("accent3"),
        c("accent4"),
        c("accent5"),
        c("accent6"),
        office.hlink.as_deref().unwrap_or_default(),
        office.fol_hlink.as_deref().unwrap_or_default(),
        font("a:majorFont", &fonts.major),
        font("a:minorFont", &fonts.minor),
    ))
}
