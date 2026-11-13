//! The functions of group `b4-fonts` (tools/main-diff/groups/b4-fonts.ts):
//! `packages/font-metrics` (family-info, metrics, sfnt) and the rebuild-font
//! finder of `apps/pdf/src/main/text-edit.ts`.
//!
//! The scenarios (`family-info.familyInfoFor`, `metrics.familyVerticalMetrics`,
//! `sfnt.familyAliases`) run a list of steps over the font folders of a case.
//! The TypeScript loads fresh copies of the modules for each case, as the
//! Rust side makes fresh state for each. `process.platform` is win32 and the
//! home folder the case's, so the only font folder read is
//! `<home>/AppData/Local/Microsoft/Windows/Fonts`.

use std::fs;
use std::time::{Duration, UNIX_EPOCH};

use jscompat::{JsonValue, json_value_from_serde};
use serde_json::{Map, Value, json};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::font_metrics::family_info::{
    FaceFamily, FamilyInfo, FamilyInfoScan, FamilyNameRecord, declares_hangul, face_families,
    family_info_for, parse_family_names, resolve_family_info,
};
use crate::packages::font_metrics::metrics::MetricsCache;
use crate::packages::font_metrics::sfnt::FontScan;
use crate::pdf::edit_fonts::{EditFontCache, EditFontStyle, list_edit_fonts, load_edit_font};
use crate::pdf::font_locate::{FontEnv, Platform};

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| text.get(2 * i..2 * i + 2))
        .filter_map(|pair| u8::from_str_radix(pair, 16).ok())
        .collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn info_value(info: &FamilyInfo) -> Value {
    let mut o = Map::new();
    if let Some(ko) = &info.ko {
        o.insert("ko".into(), Value::from(ko.as_str()));
    }
    o.insert("hangul".into(), Value::Bool(info.hangul));
    Value::Object(o)
}

fn infos_value(list: Vec<(String, FamilyInfo)>) -> Value {
    Value::Array(
        list.into_iter()
            .map(|(name, info)| json!([name, info_value(&info)]))
            .collect(),
    )
}

fn face_family_value(f: &FaceFamily) -> Value {
    let mut o = Map::new();
    o.insert("name".into(), Value::from(f.name.as_str()));
    if let Some(ko) = &f.ko {
        o.insert("ko".into(), Value::from(ko.as_str()));
    }
    o.insert("hangul".into(), Value::Bool(f.hangul));
    Value::Object(o)
}

fn face_family_of(v: &Value) -> FaceFamily {
    FaceFamily {
        name: v
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        ko: v.get("ko").and_then(Value::as_str).map(str::to_owned),
        hangul: matches!(v.get("hangul"), Some(Value::Bool(true))),
    }
}

fn limit(_: jscompat::RegexLimit) -> CallError {
    CallError::plain("regex search limit")
}

fn text<'a>(spec: &'a Value, key: &str) -> &'a str {
    spec.get(key).and_then(Value::as_str).unwrap_or("")
}

fn strings(spec: Option<&Value>) -> Vec<String> {
    spec.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `{ path, hex | text, mtimeMs? }`: the file a step writes (its folder made),
/// its modification time a whole number of seconds
fn write_step(step: &Value) {
    let path = text(step, "path");
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let bytes = match step.get("hex").and_then(Value::as_str) {
        Some(hex) => hex_decode(hex),
        None => text(step, "text").as_bytes().to_vec(),
    };
    let _ = fs::write(path, bytes);
    if let Some(ms) = step.get("mtimeMs").and_then(Value::as_f64)
        && let Ok(file) = fs::OpenOptions::new().write(true).open(path)
    {
        let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs((ms / 1000.0) as u64));
    }
}

/// `[{ home, steps }]`, each step answering one entry of the result
fn scenario_call(args: &[Value]) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("a spec"))?;
    let env = || FontEnv {
        platform: Platform::Win32,
        home: text(spec, "home").to_owned(),
    };
    let mut fonts = FontScan::new(env());
    let mut info_scan = FamilyInfoScan::new();
    let mut cache = MetricsCache::new(&fonts);
    let mut results = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let result = if step.get("restart").is_some() {
            // a new process: every module variable starts over
            fonts = FontScan::new(env());
            info_scan = FamilyInfoScan::new();
            cache = MetricsCache::new(&fonts);
            Value::Null
        } else if let Some(dirs) = step.get("extra") {
            fonts.configure_extra_font_dirs(&strings(Some(dirs)));
            Value::Null
        } else if let Some(dir) = step.get("cache").and_then(Value::as_str) {
            cache.configure_metrics_cache(dir);
            Value::Null
        } else if let Some(families) = step.get("info") {
            let families: JsonValue = json_value_from_serde(families);
            infos_value(family_info_for(&fonts, &mut info_scan, &families).map_err(limit)?)
        } else if let Some(family) = step.get("metrics").and_then(Value::as_str) {
            match cache.family_vertical_metrics(&mut fonts, family) {
                Some(m) => serde_json::to_value(&m).expect("metrics print"),
                None => Value::Null,
            }
        } else if let Some(name) = step.get("aliases").and_then(Value::as_str) {
            json!(fonts.family_aliases(name))
        } else if let Some(write) = step.get("write") {
            write_step(write);
            Value::Null
        } else if let Some(path) = step.get("rm").and_then(Value::as_str) {
            let _ = fs::remove_file(path);
            Value::Null
        } else if let Some(path) = step.get("read").and_then(Value::as_str) {
            fs::read(path).map_or(Value::Null, |bytes| {
                Value::from(String::from_utf8_lossy(&bytes).into_owned())
            })
        } else {
            Value::Null
        };
        results.push(result);
    }
    Ok(Some(Value::Array(results)))
}

fn style_of(name: Option<&str>) -> EditFontStyle {
    match name {
        Some("bold") => EditFontStyle::Bold,
        Some("italic") => EditFontStyle::Italic,
        Some("bolditalic") => EditFontStyle::BoldItalic,
        _ => EditFontStyle::Regular,
    }
}

/// `[{ root, steps }]`: a step is `{ load: [id, style | null] }`, `{ list }`,
/// `{ write: { path, hex } }` or `{ rm: path }`. Every font path is read from
/// `<root>/<path with / \ : and spaces written _>`.
fn edit_fonts_call(args: &[Value]) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("a spec"))?;
    let root = text(spec, "root").to_owned();
    let map_path = |p: &str| {
        let name: String = p
            .chars()
            .map(|c| {
                if matches!(c, '/' | '\\' | ':' | ' ') {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        format!("{root}/{name}")
    };
    let mut cache = EditFontCache::new();
    let mut results = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let result = if let Some(load) = step.get("load").and_then(Value::as_array) {
            let id = load.first().and_then(Value::as_str).unwrap_or("");
            let style = style_of(load.get(1).and_then(Value::as_str));
            load_edit_font(&mut cache, id, style, &map_path)
                .map_or(Value::Null, |bytes| Value::from(hex_encode(bytes)))
        } else if step.get("list").is_some() {
            json!(list_edit_fonts(&mut cache, &map_path))
        } else if let Some(write) = step.get("write") {
            write_step(write);
            Value::Null
        } else if let Some(path) = step.get("rm").and_then(Value::as_str) {
            let _ = fs::remove_file(path);
            Value::Null
        } else {
            Value::Null
        };
        results.push(result);
    }
    Ok(Some(Value::Array(results)))
}

fn records_of(spec: Option<&Value>) -> Vec<FamilyNameRecord> {
    spec.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|r| FamilyNameRecord {
            id: r.get("id").and_then(Value::as_u64).unwrap_or(0) as u16,
            name: text(r, "name").to_owned(),
            korean: matches!(r.get("korean"), Some(Value::Bool(true))),
        })
        .collect()
}

pub(super) fn call(name: &str, args: &[Value], _cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "family-info.parseFamilyNames" => str_arg(args, 0).map(|hex| {
            Some(Value::Array(
                parse_family_names(&hex_decode(hex))
                    .into_iter()
                    .map(|r| json!({ "id": r.id, "name": r.name, "korean": r.korean }))
                    .collect(),
            ))
        }),
        "family-info.declaresHangul" => {
            let table = arg(args, 0).and_then(Value::as_str).map(hex_decode);
            Ok(Some(Value::Bool(declares_hangul(table.as_deref()))))
        }
        "family-info.faceFamilies" => {
            let flag = matches!(arg(args, 1), Some(Value::Bool(true)));
            Ok(Some(Value::Array(
                face_families(&records_of(arg(args, 0)), flag)
                    .iter()
                    .map(face_family_value)
                    .collect(),
            )))
        }
        "family-info.resolveFamilyInfo" => {
            let families = strings(arg(args, 0));
            let faces: Vec<FaceFamily> = arg(args, 1)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(face_family_of)
                .collect();
            resolve_family_info(&families, &faces)
                .map(|list| Some(infos_value(list)))
                .map_err(limit)
        }
        "family-info.familyInfoFor" | "metrics.familyVerticalMetrics" | "sfnt.familyAliases" => {
            scenario_call(args)
        }
        "text-edit.loadEditFont" | "text-edit.listEditFonts" => edit_fonts_call(args),
        _ => return None,
    })
}
