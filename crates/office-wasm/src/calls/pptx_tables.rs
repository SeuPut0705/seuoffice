//! table-edit.ts and theme-apply.ts of the slides engine, called as
//! `<module>.<TypeScript name>`.

use std::borrow::Cow;

use jscompat::{JsMap, JsNum};
use pptx_engine::table_edit::{
    Slide, TableStyleEdit, ensure_table_style_xml, find_table_element_in_slide,
    patch_table_style_xml, table_style_preset,
};
use pptx_engine::theme_apply::{
    self, Deck, ThemeSpec, apply_theme_to_archive, build_color_map, collect_explicit_colors,
    patch_theme_xml, recolor_xml, remap_deck_colors,
};
use pptx_engine::zip::PackageArchive;
use serde::Serialize;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

/// The archive of `args.parts`, `[name, text]` pairs, with the text under
/// `args.textPart` set last: what the TypeScript builds through the private
/// constructor.
fn archive(text: &str, args: &Value) -> Result<PackageArchive, String> {
    let mut parts: Vec<(String, Vec<u8>)> = arg::<Vec<(String, String)>>(args, "parts")?
        .unwrap_or_default()
        .into_iter()
        .map(|(name, text)| (name, text.into_bytes()))
        .collect();
    if let Some(name) = arg::<String>(args, "textPart")? {
        parts.push((name, text.as_bytes().to_vec()));
    }
    Ok(PackageArchive::from_parts(parts, "gate".to_owned()))
}

/// What a function that replaces entries gives: its return value, then every
/// entry after the call as `[name, text]`.
#[derive(Serialize)]
struct AfterCall<'a> {
    returned: usize,
    entries: Vec<(&'a str, Cow<'a, str>)>,
}

fn after_call(returned: usize, archive: &PackageArchive) -> Returned {
    value(AfterCall {
        returned,
        entries: archive
            .entries()
            .keys()
            .map(|name| (name, archive.read_text(name).unwrap_or_default()))
            .collect(),
    })
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let spec = || required::<ThemeSpec>(args, "spec");
    match function {
        "table-edit.TABLE_STYLE_PRESETS" => optional(table_style_preset(text)),
        "table-edit.ensureTableStyleXml" => {
            let nullish: Option<String> = arg(args, "nullish")?;
            value(ensure_table_style_xml(
                nullish.is_none().then_some(text),
                &required::<String>(args, "styleId")?,
                &required::<String>(args, "styleDefXml")?,
            ))
        }
        "table-edit.patchTableStyleXml" => value(patch_table_style_xml(
            text,
            &required::<TableStyleEdit>(args, "edit")?,
        )),
        "table-edit.findTableElementInSlide" => {
            let slide: Slide = required(args, "slide")?;
            let found = find_table_element_in_slide(&slide, text)
                .and_then(|found| slide.elements.iter().position(|el| std::ptr::eq(el, found)));
            // the element itself, every key in the order it came in
            value(found.and_then(|at| args.get("slide")?.get("elements")?.get(at)))
        }
        "theme-apply.patchThemeXml" => value(patch_theme_xml(text, &spec()?)),
        "theme-apply.applyThemeToArchive" => {
            let mut archive = archive(text, args)?;
            let patched = apply_theme_to_archive(&mut archive, &spec()?);
            after_call(patched, &archive)
        }
        "theme-apply.collectExplicitColors" => {
            let xmls: Vec<String> = if arg::<bool>(args, "empty")? == Some(true) {
                Vec::new()
            } else {
                let mut xmls: Vec<String> = arg(args, "xmls")?.unwrap_or_default();
                xmls.push(text.to_owned());
                xmls
            };
            value(collect_explicit_colors(&xmls))
        }
        "theme-apply.buildColorMap" => {
            let counts: JsMap<JsNum> = required::<Vec<(String, JsNum)>>(args, "counts")?
                .into_iter()
                .collect();
            value(build_color_map(&counts, &spec()?))
        }
        "theme-apply.recolorXml" => {
            let map: JsMap<String> = required::<Vec<(String, String)>>(args, "map")?
                .into_iter()
                .collect();
            value(recolor_xml(text, &map))
        }
        "theme-apply.remapDeckColors" => {
            let deck = Deck {
                slides: required::<Vec<String>>(args, "slides")?
                    .into_iter()
                    .map(|path| theme_apply::Slide { path })
                    .collect(),
            };
            let mut archive = archive(text, args)?;
            let mapped = remap_deck_colors(&mut archive, &deck, &spec()?);
            after_call(mapped, &archive)
        }
        _ => Err(format!("unknown function {function}")),
    }
}
