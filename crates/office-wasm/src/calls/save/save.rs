//! The functions of patch.ts, run-picture.ts and the write halves of
//! section.ts, notes.ts and xml-number.ts that `docx_engine::save::save`
//! ports, under their TypeScript names.

use docx_engine::blank::CustomNumberingLevel;
use docx_engine::model::{
    HfPictureEdit, MapEntries, NewImage, NoteInfo, NumberRecord, SectionSettings,
    SectionSettingsPageBorderProps, StyleInfo,
};
use docx_engine::notes::NoteKind;
use docx_engine::save::save::SaveBlock;
use docx_engine::save::save::helpers;
use docx_engine::save::save::notes_write::build_notes_xml;
use docx_engine::save::save::run_picture::{
    RunPictureGeometry, patch_hf_pictures_xml, patch_run_picture_xml,
};
use docx_engine::save::save::section_write;
use docx_engine::save::save::xml_number_usable;
use jscompat::JsNum;
use serde_json::{Value, json};

use super::super::{Returned, arg, optional, package, required, value};

/// `JSON.stringify` writes NaN as null: a number argument that is absent or
/// null reads as NaN.
fn number(args: &Value, key: &str) -> Result<f64, String> {
    Ok(arg::<f64>(args, key)?.unwrap_or(f64::NAN))
}

/// `result` with the keys of each object in the order `input` has them
/// (keys the input lacks follow), as a JavaScript spread of `input` leaves them.
fn in_input_order(input: &Value, result: Value) -> Value {
    match (input, result) {
        (Value::Object(input), Value::Object(mut result)) => {
            let mut ordered = serde_json::Map::new();
            for (key, from) in input {
                if let Some(to) = result.remove(key) {
                    ordered.insert(key.clone(), in_input_order(from, to));
                }
            }
            ordered.extend(result);
            Value::Object(ordered)
        }
        (_, result) => result,
    }
}

/// None: not a function of this module.
pub fn dispatch(function: &str, text: &str, args: &Value) -> Option<Returned> {
    Some(match function {
        "applyPageNumType" => section_write::apply_page_num_type(
            text,
            arg::<String>(args, "fmt").ok().flatten().as_deref(),
            arg::<f64>(args, "start").ok().flatten(),
        )
        .and_then(value),
        "injectIntoSectPr" => required::<String>(args, "tag")
            .and_then(|tag| value(section_write::inject_into_sect_pr(text, &tag))),
        "pageBordersXml" => arg::<SectionSettingsPageBorderProps>(args, "props")
            .and_then(|props| value(section_write::page_borders_xml(props.as_ref()))),
        "applySectionSettings" => required::<SectionSettings>(args, "settings")
            .and_then(|settings| section_write::apply_section_settings(text, &settings))
            .and_then(value),
        "applySectionStartType" => required::<String>(args, "type")
            .and_then(|kind| section_write::apply_section_start_type(text, &kind))
            .and_then(value),
        "applyTitlePg" => required::<bool>(args, "on")
            .and_then(|on| section_write::apply_title_pg(text, on))
            .and_then(value),
        "buildNotesXml" => build_notes(text, args),
        "patchHfPicturesXml" => required::<NumberRecord<HfPictureEdit>>(args, "edits")
            .and_then(|edits| patch_hf_pictures_xml(text, &edits))
            .and_then(value),
        "patchRunPictureXml" => required::<RunPictureGeometry>(args, "next")
            .and_then(|next| patch_run_picture_xml(text, &next))
            .and_then(value),
        "usableNumber" => number(args, "value").and_then(|n| {
            let unit = arg::<f64>(args, "emuPerUnit")?.unwrap_or(1.0);
            optional(xml_number_usable::usable_number(n, unit).map(JsNum))
        }),
        "usablePictureSize" => number(args, "widthPx").and_then(|w| {
            let (width, height) =
                xml_number_usable::usable_picture_size(w, number(args, "heightPx")?);
            value(json!({ "widthPx": JsNum(width), "heightPx": JsNum(height) }))
        }),
        "usablePositionOffset" => number(args, "value").and_then(|n| {
            let unit = arg::<f64>(args, "emuPerUnit")?.unwrap_or(1.0);
            optional(xml_number_usable::usable_position_offset(n, unit).map(JsNum))
        }),
        "nextFreeRelId" => helpers::next_free_rel_id(text).and_then(value),
        "occupiedRelIds" => helpers::occupied_rel_ids(text).and_then(|ids| {
            let mut ids: Vec<String> = ids.into_iter().collect();
            ids.sort();
            value(ids)
        }),
        "missingHeadingLevels" => missing_heading_levels(args),
        "usableNewImage" => required::<NewImage>(args, "image").and_then(|image| {
            let mut result = serde_json::to_value(helpers::usable_new_image(&image))
                .map_err(|error| error.to_string())?;
            // `{ ...image }` keeps the order the keys came in; the model writes its own
            if let Some(input) = args.get("image") {
                result = in_input_order(input, result);
            }
            Ok(Some(result))
        }),
        "saveBlockDocxIndex" => {
            required::<SaveBlock>(args, "block").and_then(|block| optional(block.docx_index()))
        }
        "replaceAbstractNumLevel" => replace_abstract_num_level(text, args),
        "patchCoreProps" => arg::<String>(args, "savedAt").and_then(|saved_at| {
            helpers::patch_core_props(text, saved_at.as_deref(), 0.0).and_then(value)
        }),
        "defaultParagraphStyleId" => {
            required::<Vec<(String, StyleInfo)>>(args, "styles").and_then(|pairs| {
                // `new Map(pairs)`: a key met again keeps its place and takes the last value
                let mut styles: Vec<(String, StyleInfo)> = Vec::new();
                for (key, info) in pairs {
                    match styles.iter_mut().find(|(have, _)| *have == key) {
                        Some(entry) => entry.1 = info,
                        None => styles.push((key, info)),
                    }
                }
                optional(helpers::default_paragraph_style_id(&MapEntries(styles)))
            })
        }
        "insertBeforeClosingTag" => required::<String>(args, "content")
            .and_then(|content| value(helpers::insert_before_closing_tag(text, &content))),
        "markParagraphRevision" => required::<String>(args, "kind").and_then(|kind| {
            let attrs: String = required(args, "attrs")?;
            helpers::mark_paragraph_revision(text, &kind, &attrs).and_then(value)
        }),
        "fillRevisionIds" => number(args, "start").and_then(|start| {
            let mut next = start;
            helpers::fill_revision_ids(text, &mut || {
                let id = jscompat::number_to_string(next);
                next += 1.0;
                id
            })
            .and_then(value)
        }),
        "maxBookmarkId" => helpers::max_bookmark_id(text).and_then(|n| value(JsNum(n))),
        "maxRelId" => {
            let absent: Option<bool> = arg(args, "absent").ok().flatten();
            helpers::max_rel_id((absent != Some(true)).then_some(text))
                .and_then(|n| value(JsNum(n)))
        }
        "maxDocPrId" => helpers::max_doc_pr_id(text).and_then(|n| value(JsNum(n))),
        "nextImageSeq" => package(args).and_then(|zip| value(JsNum(helpers::next_image_seq(&zip)))),
        "nextDocPrSeq" => package(args)
            .and_then(|zip| helpers::next_doc_pr_seq(&zip, text))
            .and_then(|n| value(JsNum(n))),
        "retargetImageBlip" => required::<String>(args, "rId")
            .and_then(|r_id| helpers::retarget_image_blip(text, &r_id))
            .and_then(value),
        "carriesMoveRanges" => required::<String>(args, "name").and_then(|name| {
            let document: String = required(args, "documentPath")?;
            value(helpers::carries_move_ranges(&name, &document))
        }),
        "hasOrphanMoveRanges" => package(args).and_then(|zip| {
            let document: String = required(args, "documentPath")?;
            helpers::has_orphan_move_ranges(&zip, &document).and_then(value)
        }),
        "cleanStoryMoveRanges" => package(args).and_then(|mut zip| {
            let document: String = required(args, "documentPath")?;
            helpers::clean_story_move_ranges(&mut zip, &document)?;
            let mut out: Vec<(String, String)> = Vec::new();
            for part in zip.parts() {
                if !part.is_dir {
                    out.push((
                        part.name.to_string(),
                        part.text().map_err(|e| e.to_string())?.to_owned(),
                    ));
                }
            }
            value(out)
        }),
        "nextRevisionIdAllocator" => required::<Vec<String>>(args, "partsXml").and_then(|parts| {
            let floor = arg::<f64>(args, "floor")?.unwrap_or(0.0);
            let mut ids = helpers::RevisionIds::new(&parts, floor)?;
            value(vec![ids.allocate(), ids.allocate(), ids.allocate()])
        }),
        "nextBookmarkIdAllocator" => helpers::BookmarkIds::new(text).and_then(|mut ids| {
            value(
                vec![ids.allocate(), ids.allocate(), ids.allocate()]
                    .into_iter()
                    .map(JsNum)
                    .collect::<Vec<_>>(),
            )
        }),
        "storyPartsXml" => package(args)
            .and_then(|zip| helpers::story_parts_xml(&zip))
            .and_then(value),
        _ => return None,
    })
}

fn build_notes(text: &str, args: &Value) -> Returned {
    let kind: NoteKind = required(args, "kind")?;
    let notes: Vec<NoteInfo> = required(args, "notes")?;
    let has_original: Option<bool> = arg(args, "hasOriginal")?;
    let original = (has_original == Some(true)).then_some(text);
    value(build_notes_xml(kind, &notes, original)?)
}

fn missing_heading_levels(args: &Value) -> Returned {
    let blocks: Vec<SaveBlock> = required(args, "blocks")?;
    let ids: Vec<(JsNum, String)> = required(args, "headingStyleIds")?;
    value(
        helpers::missing_heading_levels(&blocks, &MapEntries(ids))
            .into_iter()
            .map(JsNum)
            .collect::<Vec<_>>(),
    )
}

fn replace_abstract_num_level(text: &str, args: &Value) -> Returned {
    let abstract_num_id: String = required(args, "abstractNumId")?;
    let level: CustomNumberingLevel = required(args, "level")?;
    let ilvl = number(args, "ilvl")?;
    value(helpers::replace_abstract_num_level(
        text,
        &abstract_num_id,
        ilvl,
        &level,
    )?)
}
