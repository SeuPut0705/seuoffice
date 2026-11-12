//! `blank.*`: blank.ts, and the zip writer `buildBlankDocx` stands on.

use docx_engine::blank::{
    self, BlankDocxOptions, CustomNumberingLevel, custom_level_from_numbering_level,
};
use docx_engine::numbering::parse_numbering;
use jscompat::{base64, js_regex};
use ooxml_pkg::write::generate;
use ooxml_pkg::{Package, Part, decode_text, read_entries};
use serde_json::{Map, Value, json};

use super::{Returned, arg, optional, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "customLevelXml" => {
            let level: CustomNumberingLevel = required(args, "level")?;
            value(blank::custom_level_xml(&level, required(args, "ilvl")?))
        }
        "mergeLevelXml" => {
            let level: CustomNumberingLevel = required(args, "level")?;
            value(blank::merge_level_xml(
                text,
                &level,
                required(args, "ilvl")?,
            ))
        }
        "abstractNumXml" => {
            let id: String = required(args, "abstractNumId")?;
            let kind: String = required(args, "kind")?;
            let levels: Option<Vec<CustomNumberingLevel>> = arg(args, "levels")?;
            value(blank::abstract_num_xml(&id, &kind, levels.as_deref()))
        }
        "numPicBulletXml" => {
            let r_id: String = required(args, "rId")?;
            value(blank::num_pic_bullet_xml(required(args, "id")?, &r_id))
        }
        "customLevelFromNumberingLevel" => {
            // every level of the numbering part `text`, as parseNumbering reads it
            let package = Package::from_parts([("word/numbering.xml", text.as_bytes())]);
            let numbering = parse_numbering(&package)?;
            let mut levels = Map::new();
            for (num_id, def) in numbering.defs.iter() {
                for (ilvl, level) in def.levels.entries() {
                    let custom = custom_level_from_numbering_level(level);
                    levels.insert(
                        format!("{num_id} {ilvl}"),
                        serde_json::to_value(custom).map_err(|error| error.to_string())?,
                    );
                }
            }
            value(levels)
        }
        "numberingLevelFromCustom" => {
            let level: CustomNumberingLevel = required(args, "level")?;
            let src: Option<String> = arg(args, "picBulletSrc")?;
            value(blank::numbering_level_from_custom(&level, src.as_deref()))
        }
        "paperSizeForRegion" => value(blank::paper_size_for_region(given(text, args)?)),
        "paperSizeForLocale" => value(blank::paper_size_for_locale(given(text, args)?)),
        "buildBlankDocx" => {
            let bytes = build(text, args)?;
            let mut entries = Vec::new();
            for entry in read_entries(&bytes).map_err(|error| error.to_string())? {
                let content = entry.content?;
                entries.push((
                    decode_text(&entry.raw_name).into_owned(),
                    entry.is_dir,
                    decode_text(&content).into_owned(),
                ));
            }
            value(json!({ "entries": entries }))
        }
        "pageSizeTag" => {
            let bytes = build(text, args)?;
            let entries = read_entries(&bytes).map_err(|error| error.to_string())?;
            let Some(document) = entries
                .into_iter()
                .find(|entry| entry.raw_name == b"word/document.xml")
            else {
                return Ok(None);
            };
            let document = document.content?;
            let document = decode_text(&document);
            optional(
                js_regex!(r"<w:pgSz[^>]*\/>")
                    .exec(&document)
                    .map(|found| found.as_str().to_owned()),
            )
        }
        // not functions of blank.ts: the bytes themselves, for compare-blank.ts
        "buildBlankDocxBytes" => value(base64(&build(text, args)?)),
        "zipBytes" => {
            let parts: Vec<(String, Option<String>)> = required(args, "parts")?;
            let mut package = Package::default();
            for (name, text) in parts {
                match text {
                    Some(text) => package.set_file(name, text.into_bytes()),
                    None => add_folder(&mut package, &name),
                }
            }
            let bytes = generate(&package, time_clip(required(args, "now")?))
                .map_err(|error| error.to_string())?;
            value(base64(&bytes))
        }
        _ => Err(format!("unknown function {function}")),
    }
}

/// `zip.folder(name)`: the folder, after the folders above it that are
/// missing. A name already taken, by a folder or a file, is left as it is.
fn add_folder(package: &mut Package, name: &str) {
    let folder = if name.ends_with('/') {
        name.to_owned()
    } else {
        format!("{name}/")
    };
    if package.parts().iter().any(|part| part.name.as_str() == folder) {
        return;
    }
    let path = &folder[..folder.len() - 1];
    // JSZip's parentFolder: a slash at index 0 is no parent
    if let Some(at) = path.rfind('/').filter(|at| *at > 0) {
        add_folder(package, &path[..at]);
    }
    package.set(Part::new(folder, true, Ok(Vec::new())));
}

/// The text argument, or null or undefined where `args.missing` says so.
fn given<'a>(text: &'a str, args: &Value) -> Result<Option<&'a str>, String> {
    let missing: Option<String> = arg(args, "missing")?;
    Ok(missing.is_none().then_some(text))
}

/// `new Date(time)`: TimeClip.
fn time_clip(time: f64) -> f64 {
    if !time.is_finite() || time.abs() > 8.64e15 {
        f64::NAN
    } else {
        // + 0.0 turns -0 into 0
        time.trunc() + 0.0
    }
}

/// `buildBlankDocx(args.options)` with the clock at `args.now`; the option
/// `args.textOption` names, if any, is the text, and the paper size is
/// `paperSizeForLocale(args.locale)` where a locale is given.
fn build(text: &str, args: &Value) -> Result<Vec<u8>, String> {
    let mut options: BlankDocxOptions = arg(args, "options")?.unwrap_or_default();
    options.created_at = options.created_at.map(time_clip);
    let text_option: Option<String> = arg(args, "textOption")?;
    let slot = match text_option.as_deref() {
        None => None,
        Some("eastAsiaFont") => Some(&mut options.east_asia_font),
        Some("application") => Some(&mut options.application),
        Some("appVersion") => Some(&mut options.app_version),
        Some("template") => Some(&mut options.template),
        Some(other) => return Err(format!("no option {other}")),
    };
    if let Some(slot) = slot {
        *slot = Some(text.to_owned());
    }
    if let Some(locale) = arg::<String>(args, "locale")? {
        options.paper_size = Some(blank::paper_size_for_locale(Some(&locale)));
    }
    blank::build_blank_docx(&options, time_clip(required(args, "now")?))
}
