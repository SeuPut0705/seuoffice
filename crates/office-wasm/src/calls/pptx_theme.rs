//! theme.ts and color.ts of the slides engine, called as `<module>.<TypeScript
//! name>`. A theme arrives as `args.theme`: the JSON of what the real
//! `parseTheme` returned. A node is taken by `args.name` from `text` parsed
//! as packages/pptx-engine/src/parse.ts parses it, as
//! tools/pptx-diff/calls-theme.ts does.

use ooxml_xml::ObjectOptions;
use pptx_engine::color::{apply_color_mods, hex_to_rgb, resolve_color_node, scale_luminance};
use pptx_engine::theme::{
    EaScript, Theme, ea_script_of_lang, parse_clr_map, parse_theme, resolve_font_ref,
    resolve_scheme_color, sys_color_hex, theme_with_override,
};
use pptx_engine::xml_utils::xml_parse_object as parse_object;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

/// `isArray` of the parser of packages/pptx-engine/src/parse.ts, which
/// parses the nodes `resolveColorNode` and `applyColorMods` are given.
const PARSE_ARRAY_NAMES: [&str; 12] = [
    "a:p",
    "a:r",
    "a:br",
    "a:fld",
    "p:sp",
    "p:pic",
    "p:graphicFrame",
    "p:grpSp",
    "p:cxnSp",
    "a:tr",
    "a:tc",
    "a:gridCol",
];

fn parse_ts_tree(text: &str) -> Result<Value, String> {
    parse_object(
        text,
        &ObjectOptions {
            trim_values: false,
            parse_tag_value: false,
            array_names: &PARSE_ARRAY_NAMES,
        },
    )
    .map_err(|error| error.to_string())
}

/// `args[key]` where the key is there, null included; else the text.
fn value_or_text(args: &Value, key: &str, text: &str) -> Value {
    args.get(key)
        .cloned()
        .unwrap_or_else(|| Value::String(text.to_owned()))
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "theme.sysColorHex" => value(sys_color_hex(
            args.get("val"),
            Some(&value_or_text(args, "lastClr", text)),
        )),
        "theme.parseTheme" => value(parse_theme(text)?),
        "theme.themeWithOverride" => {
            let base: Option<Theme> = arg(args, "theme")?;
            value(theme_with_override(base.as_ref(), text)?)
        }
        "theme.eaScriptOfLang" => {
            optional(ea_script_of_lang(Some(&value_or_text(args, "tag", text))))
        }
        "theme.resolveFontRef" => {
            let no_typeface: Option<bool> = arg(args, "noTypeface")?;
            let theme: Option<Theme> = arg(args, "theme")?;
            let ea_script: Option<EaScript> = arg(args, "eaScript")?;
            optional(resolve_font_ref(
                (no_typeface != Some(true)).then_some(text),
                theme.as_ref(),
                ea_script,
            ))
        }
        "theme.resolveSchemeColor" => {
            let theme: Option<Theme> = arg(args, "theme")?;
            let ph_clr: Option<String> = arg(args, "phClr")?;
            optional(resolve_scheme_color(
                text,
                theme.as_ref(),
                ph_clr.as_deref(),
            ))
        }
        "theme.parseClrMap" => {
            let text_is: Option<String> = arg(args, "textIs")?;
            let text_is = text_is.as_deref().unwrap_or("master");
            let master: Option<String> = arg(args, "masterXml")?;
            let layout: Option<String> = arg(args, "layoutXml")?;
            let slide: Option<String> = arg(args, "slideXml")?;
            let from_text = |name: &str| text_is == name;
            optional(parse_clr_map(
                if from_text("master") {
                    Some(text)
                } else {
                    master.as_deref()
                },
                if from_text("layout") {
                    Some(text)
                } else {
                    layout.as_deref()
                },
                if from_text("slide") {
                    Some(text)
                } else {
                    slide.as_deref()
                },
            ))
        }
        "color.resolveColorNode" => {
            let tree = parse_ts_tree(text)?;
            let name: String = required(args, "name")?;
            let theme: Option<Theme> = arg(args, "theme")?;
            let ph_clr: Option<String> = arg(args, "phClr")?;
            optional(resolve_color_node(
                tree.get(name.as_str()),
                theme.as_ref(),
                ph_clr.as_deref(),
            ))
        }
        "color.applyColorMods" => {
            let tree = parse_ts_tree(text)?;
            let hex: String = required(args, "hex")?;
            let name: Option<String> = arg(args, "name")?;
            let mods = name.as_deref().and_then(|name| tree.get(name));
            value(apply_color_mods(&hex, mods))
        }
        "color.hexToRgb" => value(hex_to_rgb(text)),
        "color.scaleLuminance" => value(scale_luminance(text, required(args, "factor")?)),
        _ => Err(format!("unknown function {function}")),
    }
}
