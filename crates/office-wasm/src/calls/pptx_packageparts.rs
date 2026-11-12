//! `pptxPackageparts.*`: notes.ts, sections.ts, comments.ts and
//! resource-cleanup.ts of the slides engine, run on an opened deck through
//! [`deck_op`], the Rust side of tools/pptx-diff/calls-packageparts.ts.
//!
//! The TypeScript draws section ids at random and stamps comments from the
//! clock. Here both are fixed values, and every GUID and every ISO timestamp
//! of an answer is replaced by a placeholder (`scrubbed`), as the TypeScript
//! side does to its own answer, so the two compare.

use jscompat::js_regex;
use pptx_engine::comments::{
    SlideCommentOptions, SlideCommentRef, add_slide_comment, delete_slide_comment,
    get_slide_comments,
};
use pptx_engine::notes::{
    add_content_type_override, append_relationship, get_slide_notes, notes_path_for_slide,
    set_slide_notes, unescape_xml,
};
use pptx_engine::resource_cleanup::{
    cleanup_deleted_element_resources, cleanup_superseded_slide_resources,
    remove_part_with_owned_resources, remove_relationship_and_collect_owned_target,
};
use pptx_engine::sections::{
    SectionDirection, SectionInfo, add_section, get_sections, move_section, move_slide,
    normalize_sections, remove_section, rename_section, set_sections,
};
use serde::Serialize;
use serde_json::Value;

use super::pptx_deck::deck_op;
use super::{Returned, required, value};

/// The text `crypto.randomUUID()` would answer, fixed.
fn uuid() -> String {
    "00000000-0000-4000-8000-000000000000".to_owned()
}

/// `new Date().toISOString()`, fixed.
const NOW: &str = "2000-01-01T00:00:00.000Z";

/// The answer with every GUID and every ISO timestamp made a placeholder.
fn scrubbed(returned: Returned) -> Returned {
    let Some(answer) = returned? else {
        return Ok(None);
    };
    let text = serde_json::to_string(&answer).map_err(|error| error.to_string())?;
    let text = js_regex!(
        r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
        "gi"
    )
    .replace_all(&text, |_| "GUID".to_owned());
    let text = js_regex!(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", "g")
        .replace_all(&text, |_| "DT".to_owned());
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn json(result: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// `args.slide` as an index; a value that is not one (negative, fractional)
/// is one past every deck, as `deck.slides[-1]` is `undefined`.
fn slide_index(args: &Value) -> Result<usize, String> {
    let n: f64 = required(args, "slide")?;
    Ok(if n >= 0.0 && n.fract() == 0.0 && n < 9.0e15 {
        n as usize
    } else {
        usize::MAX
    })
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let string = |key: &str| required::<String>(args, key);
    let number = |key: &str| required::<f64>(args, key);
    match function {
        // notes.ts
        "notes.unescapeXml" => value(unescape_xml(text)),
        "notes.notesPathForSlide" => scrubbed(deck_op(text, args, |opened| {
            json(notes_path_for_slide(&opened.archive, &string("path")?)?)
        })),
        "notes.getSlideNotes" => scrubbed(deck_op(text, args, |opened| {
            json(get_slide_notes(&opened.archive, &string("path")?)?)
        })),
        "notes.setSlideNotes" => scrubbed(deck_op(text, args, |opened| {
            json(set_slide_notes(
                opened,
                slide_index(args)?,
                &string("notes")?,
            )?)
        })),
        "notes.addContentTypeOverride" => scrubbed(deck_op(text, args, |opened| {
            add_content_type_override(&mut opened.archive, &string("part")?, &string("type")?);
            Ok(Value::Null)
        })),
        "notes.appendRelationship" => scrubbed(deck_op(text, args, |opened| {
            json(append_relationship(
                &mut opened.archive,
                &string("part")?,
                &string("type")?,
                &string("target")?,
            ))
        })),

        // sections.ts
        "sections.getSections" => scrubbed(deck_op(text, args, |opened| {
            json(get_sections(opened, &mut uuid)?)
        })),
        "sections.setSections" => scrubbed(deck_op(text, args, |opened| {
            let sections: Vec<SectionInfo> = required(args, "sections")?;
            set_sections(opened, &sections, &mut uuid)?;
            Ok(Value::Null)
        })),
        "sections.normalizeSections" => {
            let sections: Vec<SectionInfo> = required(args, "sections")?;
            value(normalize_sections(&sections, required(args, "total")?))
        }
        "sections.addSection" => scrubbed(deck_op(text, args, |opened| {
            json(add_section(
                opened,
                number("at")?,
                &string("name")?,
                &mut uuid,
            )?)
        })),
        "sections.renameSection" => scrubbed(deck_op(text, args, |opened| {
            json(rename_section(
                opened,
                &string("id")?,
                &string("name")?,
                &mut uuid,
            )?)
        })),
        "sections.removeSection" => scrubbed(deck_op(text, args, |opened| {
            json(remove_section(opened, &string("id")?, None, &mut uuid)?)
        })),
        "sections.moveSlide" => scrubbed(deck_op(text, args, |opened| {
            json(move_slide(
                opened,
                number("from")?,
                number("to")?,
                &mut uuid,
            )?)
        })),
        "sections.moveSection" => scrubbed(deck_op(text, args, |opened| {
            let dir: SectionDirection = required(args, "dir")?;
            json(move_section(opened, &string("id")?, dir, &mut uuid)?)
        })),

        // comments.ts
        "comments.getSlideComments" => scrubbed(deck_op(text, args, |opened| {
            json(get_slide_comments(&opened.archive, &string("path")?)?)
        })),
        "comments.addSlideComment" => scrubbed(deck_op(text, args, |opened| {
            let opts: SlideCommentOptions = required(args, "opts")?;
            json(add_slide_comment(opened, slide_index(args)?, &opts, NOW)?)
        })),
        "comments.deleteSlideComment" => scrubbed(deck_op(text, args, |opened| {
            let reference: SlideCommentRef = required(args, "ref")?;
            json(delete_slide_comment(
                opened,
                slide_index(args)?,
                &reference,
            )?)
        })),

        // resource-cleanup.ts
        "resource-cleanup.cleanupSupersededSlideResources" => {
            scrubbed(deck_op(text, args, |opened| {
                json(cleanup_superseded_slide_resources(
                    opened,
                    slide_index(args)?,
                    text,
                    &string("current")?,
                )?)
            }))
        }
        "resource-cleanup.cleanupDeletedElementResources" => {
            scrubbed(deck_op(text, args, |opened| {
                json(cleanup_deleted_element_resources(
                    opened,
                    slide_index(args)?,
                    text,
                )?)
            }))
        }
        "resource-cleanup.removeRelationshipAndCollectOwnedTarget" => {
            scrubbed(deck_op(text, args, |opened| {
                json(remove_relationship_and_collect_owned_target(
                    &mut opened.archive,
                    &string("source")?,
                    &string("id")?,
                )?)
            }))
        }
        "resource-cleanup.removePartWithOwnedResources" => {
            scrubbed(deck_op(text, args, |opened| {
                json(remove_part_with_owned_resources(
                    &mut opened.archive,
                    &string("part")?,
                )?)
            }))
        }
        _ => Err(format!("no function pptxPackageparts.{function}")),
    }
}
