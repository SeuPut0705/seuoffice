//! `pptxLayouts.*`: layout.ts, builtin-layouts.ts, slide-transfer.ts and
//! blank.ts of the slides engine, called as `<module>.<TypeScript name>`.
//!
//! A function on an archive reads `args.parts` (`[name, text]` pairs) and the
//! text under `args.textPart`; one that changes the archive answers
//! `{ value, entries }`, every entry after the call as `[name, text]`.

use std::collections::HashSet;

use jscompat::JsObject;
use pptx_engine::blank::{BLANK_SLIDE_XML, create_blank_pptx};
use pptx_engine::builtin_layouts::{
    BUILTIN_LAYOUTS, builtin_layout_infos, ensure_builtin_layout, should_offer_builtin_layouts,
};
use pptx_engine::deck::OpenedPptx;
use pptx_engine::layout::{
    LayoutPlaceholder, SlideLayoutInfo, list_slide_layouts, parse_layout_placeholders,
    placeholder_sp_xml, prepare_insert_slide_with_layout,
};
use pptx_engine::slide_transfer::{
    SlideBundle, choose_layout, collect_part, collect_slide_bundle, import_clipboard_parts,
    import_source_layout, list_layouts, materialize_slide_bundle,
};
use pptx_engine::types::SlideSize;
use pptx_engine::zip::PackageArchive;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::pptx_deck::deck_op;
use super::{Returned, arg, required, value};

/// The archive of `args.parts`, then `text` under `args.textPart`, its hash 'gate'.
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

/// Every entry as `[name, text]`, in archive order.
fn entries_of(archive: &PackageArchive) -> Vec<(String, String)> {
    archive
        .entries()
        .iter()
        .map(|(name, bytes)| (name.to_owned(), String::from_utf8_lossy(bytes).into_owned()))
        .collect()
}

/// What a function that changes an archive answers.
fn after_call(archive: &PackageArchive, result: impl Serialize) -> Returned {
    let mut answer = Map::new();
    answer.insert(
        "value".to_owned(),
        serde_json::to_value(result).map_err(|error| error.to_string())?,
    );
    answer.insert(
        "entries".to_owned(),
        serde_json::to_value(entries_of(archive)).map_err(|error| error.to_string())?,
    );
    Ok(Some(Value::Object(answer)))
}

/// `deck.slides[index]`: an index that is no array index finds no slide.
fn slide_index(index: f64) -> usize {
    if index >= 0.0 && index.fract() == 0.0 {
        index as usize
    } else {
        usize::MAX
    }
}

/// The clipboard of an element copy: `{ parts, contentTypes }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Clip {
    parts: JsObject<String>,
    content_types: JsObject<String>,
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let text_arg = |key: &str| required::<String>(args, key);
    match function {
        "layout.parseLayoutPlaceholders" => value(parse_layout_placeholders(text)),
        "layout.listSlideLayouts" => value(list_slide_layouts(&archive(text, args)?)),
        "layout.placeholderSpXml" => {
            let ph: LayoutPlaceholder = required(args, "ph")?;
            value(placeholder_sp_xml(&ph, required(args, "id")?))
        }
        "layout.prepareInsertSlideWithLayout" => {
            let source_index = slide_index(required(args, "sourceIndex")?);
            let layout_path = text_arg("layoutPath")?;
            deck_op(text, args, |opened| {
                let OpenedPptx { deck, archive, .. } = opened;
                let path =
                    prepare_insert_slide_with_layout(archive, deck, source_index, &layout_path)?;
                serde_json::to_value(path).map_err(|error| error.to_string())
            })
        }
        "constants" => match required::<String>(args, "name")?.as_str() {
            "BUILTIN_LAYOUTS" => value(BUILTIN_LAYOUTS),
            "BLANK_SLIDE_XML" => value(BLANK_SLIDE_XML),
            name => Err(format!("no constant {name}")),
        },
        "builtin-layouts.shouldOfferBuiltinLayouts" => {
            let layouts: Vec<SlideLayoutInfo> = required(args, "layouts")?;
            value(should_offer_builtin_layouts(&layouts))
        }
        "builtin-layouts.builtinLayoutInfos" => {
            let size: SlideSize = required(args, "size")?;
            let existing: HashSet<String> = required::<Vec<String>>(args, "existing")?
                .into_iter()
                .collect();
            value(builtin_layout_infos(&size, &existing))
        }
        "builtin-layouts.ensureBuiltinLayout" => {
            let mut archive = archive(text, args)?;
            let size: SlideSize = required(args, "size")?;
            let path = ensure_builtin_layout(&mut archive, &size, &text_arg("key")?)?;
            after_call(&archive, path)
        }
        "slide-transfer.collectPart" => {
            let mut parts = JsObject::new();
            let mut content_types = JsObject::new();
            collect_part(
                &archive(text, args)?,
                &text_arg("partPath")?,
                &mut parts,
                &mut content_types,
            )?;
            let mut answer = Map::new();
            answer.insert(
                "parts".to_owned(),
                serde_json::to_value(parts).map_err(|error| error.to_string())?,
            );
            answer.insert(
                "contentTypes".to_owned(),
                serde_json::to_value(content_types).map_err(|error| error.to_string())?,
            );
            Ok(Some(Value::Object(answer)))
        }
        "slide-transfer.collectSlideBundle" => value(collect_slide_bundle(
            &archive(text, args)?,
            &text_arg("slidePath")?,
            &text_arg("slideXml")?,
        )?),
        "slide-transfer.listLayouts" => value(list_layouts(&archive(text, args)?)),
        "slide-transfer.importClipboardParts" => {
            let mut archive = archive(text, args)?;
            let clip: Clip = required(args, "clip")?;
            let path_map = import_clipboard_parts(&mut archive, &clip.parts, &clip.content_types)?;
            after_call(&archive, path_map)
        }
        "slide-transfer.materializeSlideBundle" => {
            let mut archive = archive(text, args)?;
            let bundle: SlideBundle = required(args, "bundle")?;
            let rels = materialize_slide_bundle(
                &mut archive,
                &bundle,
                &text_arg("slidePath")?,
                &text_arg("layoutPath")?,
            )?;
            after_call(&archive, rels)
        }
        "slide-transfer.importSourceLayout" => {
            let mut archive = archive(text, args)?;
            let bundle: SlideBundle = required(args, "bundle")?;
            let path = import_source_layout(&mut archive, &bundle)?;
            after_call(&archive, path)
        }
        "slide-transfer.chooseLayout" => {
            let bundle: SlideBundle = required(args, "bundle")?;
            let neighbour: Option<String> = arg(args, "neighbour")?;
            value(choose_layout(
                &archive(text, args)?,
                &bundle,
                neighbour.as_deref(),
            )?)
        }
        "blank.createBlankPptx" => {
            // the clock only stamps the zip entries; the entries are what is compared
            let bytes = create_blank_pptx(1_700_000_000_000.0)?;
            let entries = entries_of(&PackageArchive::open(&bytes)?);
            let at = required::<f64>(args, "at")?;
            let entry = (at >= 0.0 && at.fract() == 0.0)
                .then(|| entries.get(at as usize))
                .flatten();
            value((entries.len(), entry))
        }
        _ => Err(format!("no function pptxLayouts.{function}")),
    }
}
