//! symbol-fonts.ts and list-markers.ts, called by name.

use docx_engine::list_markers::{
    ListItemRef, SEGOE_UI_SYMBOL_RE, compute_list_marker_infos, compute_list_markers,
    compute_list_values, custom_enum_items, format_number, marker_fallback_face,
    marker_tab_advance, substitute_bullet,
};
use docx_engine::numbering::{NumberingDef, parse_numbering};
use docx_engine::symbol_fonts::{
    decode_symbol_char, decode_symbol_text, is_symbol_font, symbol_glyph, symbol_pua_char,
    to_symbol_pua,
};
use jscompat::{JsMap, JsNum, to_number};
use ooxml_pkg::Package;
use serde_json::Value;

use super::{Returned, arg, required, value};

/// The numbering of a package made of `text` as word/numbering.xml, with the
/// picture bullet sources of `args.pics` (`[picBulletId, src]` pairs) set the
/// way `resolvePicBullets` of parse.ts sets them.
fn defs_of(text: &str, args: &Value) -> Result<JsMap<NumberingDef>, String> {
    let package = Package::from_parts([("word/numbering.xml", text)]);
    let mut defs = parse_numbering(&package)?.defs;
    let pics: Vec<(f64, String)> = arg(args, "pics")?.unwrap_or_default();
    let ids: Vec<String> = defs.keys().map(str::to_owned).collect();
    for id in ids {
        let Some(def) = defs.get_mut(&id) else {
            continue;
        };
        for level in def.levels.values_mut() {
            let Some(pic_id) = *level.pic_bullet_id else {
                continue;
            };
            if level
                .pic_bullet_src
                .as_deref()
                .is_some_and(|src| !src.is_empty())
            {
                continue;
            }
            // a Map set from the pairs: the last non-empty source of an id wins
            if let Some((_, src)) = pics
                .iter()
                .rev()
                .find(|(id, src)| *id == pic_id.0 && !src.is_empty())
            {
                level.pic_bullet_src.set(src.clone());
            }
        }
    }
    Ok(defs)
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "isSymbolFont" => value(is_symbol_font(Some(text))),
        // NaN crosses JSON as null
        "decodeSymbolChar" => value(decode_symbol_char(
            text,
            arg(args, "code")?.unwrap_or(f64::NAN),
        )),
        "symbolPuaChar" => value(symbol_pua_char(text)),
        "symbolGlyph" => value(symbol_glyph(&required::<String>(args, "font")?, text)),
        "toSymbolPua" => value(to_symbol_pua(text)),
        "decodeSymbolText" => value(decode_symbol_text(
            &required::<String>(args, "font")?,
            text,
            arg(args, "textGlyphsOnly")?.unwrap_or(false),
        )),
        "customEnumItems" => value(custom_enum_items(text)),
        "formatNumber" => value(format_number(
            to_number(&required::<String>(args, "value")?),
            text,
            arg::<String>(args, "customFormat")?.as_deref(),
        )),
        "substituteBullet" => value(substitute_bullet(text)),
        "SEGOE_UI_SYMBOL_RE" => value(SEGOE_UI_SYMBOL_RE.test(text)),
        "markerFallbackFace" => value(marker_fallback_face(
            &required::<String>(args, "glyph")?,
            text,
        )),
        "computeListMarkerInfos" | "computeListValues" | "computeListMarkers" => {
            let defs = defs_of(text, args)?;
            let items: Vec<ListItemRef> = required(args, "items")?;
            match function {
                "computeListMarkerInfos" => value(compute_list_marker_infos(&items, &defs)),
                "computeListValues" => value(compute_list_values(&items, &defs)),
                _ => value(compute_list_markers(&items, &defs)),
            }
        }
        "markerTabAdvance" => value(
            marker_tab_advance(
                required(args, "markerStart")?,
                required(args, "markerWidth")?,
                required(args, "textIndent")?,
                arg(args, "defaultTab")?.unwrap_or(720.0),
                &arg::<Vec<f64>>(args, "customStops")?.unwrap_or_default(),
            )
            .map(JsNum),
        ),
        _ => Err(format!("unknown function {function}")),
    }
}
