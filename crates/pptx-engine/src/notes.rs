//! Port of packages/pptx-engine/src/notes.ts: speaker notes (notesSlide) read
//! and write by archive surgery, and the package helpers (`appendRelationship`,
//! `addContentTypeOverride`, `unescapeXml`) the comments and the media modules
//! share.

use jscompat::{
    js_regex, number_to_string, replace_first_string, replace_first_with, slice_utf16, to_number,
};

use crate::deck::OpenedPptx;
use crate::xml_utils::{
    decode_numeric_char_refs, escape_xml_text, has_content_type_override,
    max_relationship_id_number,
};
use crate::zip::{PackageArchive, rels_path_for, resolve_target};

const XMLDECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";

const NOTES_SLIDE_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const NOTES_MASTER_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster";
const SLIDE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const THEME_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";

const NOTES_SLIDE_CT: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const NOTES_MASTER_CT: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml";

/// `setEntry`
pub(crate) fn set_entry(archive: &mut PackageArchive, path: &str, xml: String) {
    archive.entries_mut().set(path, xml.into_bytes());
}

/// `text.replace(needle, () => replacement)` with a string `needle`: the
/// first occurrence only, the replacement taken as written.
pub(crate) fn replace_literal(text: &str, needle: &str, replacement: &str) -> String {
    match text.find(needle) {
        Some(at) => {
            let end = at + needle.len();
            format!(
                "{}{replacement}{}",
                text.get(..at).unwrap_or_default(),
                text.get(end..).unwrap_or_default()
            )
        }
        None => text.to_owned(),
    }
}

/// `unescapeXml`: unescape XML text (for reading `<a:t>`).
///
/// ledger notes-unescape-numeric-entity: the TypeScript decodes the numeric
/// references first and the five named entities after, so `&#38;lt;` (the
/// text `&lt;`) comes out as `<`: a reference it produced is read again. This
/// reads the text once, left to right, so a decoded character is never
/// decoded a second time. Every other input gives what the TypeScript gives.
pub fn unescape_xml(s: &str) -> String {
    js_regex!(
        r"&#(?:x([0-9a-fA-F]+)|(\d+));|&(?:lt|gt|quot|apos|amp);",
        "g"
    )
    .replace_all(s, |m| match m.as_str() {
        "&lt;" => "<".to_owned(),
        "&gt;" => ">".to_owned(),
        "&quot;" => "\"".to_owned(),
        "&apos;" => "'".to_owned(),
        "&amp;" => "&".to_owned(),
        numeric => decode_numeric_char_refs(numeric),
    })
}

/// `notesPathForSlide`: path of the slide's notesSlide part (`None` if there
/// is no notes slide).
pub fn notes_path_for_slide(
    archive: &PackageArchive,
    slide_path: &str,
) -> Result<Option<String>, String> {
    for rel in archive.read_rels(slide_path)?.values() {
        if rel.r#type == NOTES_SLIDE_REL {
            return Ok(Some(resolve_target(slide_path, &rel.target)));
        }
    }
    Ok(None)
}

/// The body placeholder `<p:sp>` block of a notesSlide xml.
struct BodySp<'a> {
    xml: &'a str,
    start: usize,
    end: usize,
}

/// `findBodySp`
fn find_body_sp(xml: &str) -> Option<BodySp<'_>> {
    let body = js_regex!(r#"<p:ph\b[^>]*\btype=["']body["']"#);
    for m in js_regex!(r"<p:sp>[\s\S]*?<\/p:sp>", "g").find_iter(xml) {
        // quote-agnostic: a deck written with type='body' is still a body placeholder
        if body.test(m.as_str()) {
            return Some(BodySp {
                xml: m.as_str(),
                start: m.start(),
                end: m.end(),
            });
        }
    }
    None
}

/// `getSlideNotes`: notes as plain text (body placeholder paragraphs joined
/// by `\n`); '' if none.
pub fn get_slide_notes(archive: &PackageArchive, slide_path: &str) -> Result<String, String> {
    let Some(notes_path) = notes_path_for_slide(archive, slide_path)? else {
        return Ok(String::new());
    };
    if notes_path.is_empty() {
        return Ok(String::new());
    }
    let Some(xml) = archive.read_text(&notes_path).filter(|xml| !xml.is_empty()) else {
        return Ok(String::new());
    };
    let Some(body) = find_body_sp(&xml) else {
        return Ok(String::new());
    };
    let Some(tx) = js_regex!(r"<p:txBody>([\s\S]*?)<\/p:txBody>")
        .exec(body.xml)
        .and_then(|m| m.get(1))
        .filter(|tx| !tx.is_empty())
    else {
        return Ok(String::new());
    };
    let text_run = js_regex!(r"<a:t(?:\s[^>]*[^/>])?>([\s\S]*?)<\/a:t>", "g");
    let mut paras: Vec<String> = js_regex!(r"<a:p>([\s\S]*?)<\/a:p>", "g")
        .find_iter(tx)
        .map(|p| {
            text_run
                .find_iter(p.get(1).unwrap_or_default())
                .map(|t| unescape_xml(t.get(1).unwrap_or_default()))
                .collect::<String>()
        })
        .collect();
    // Drop trailing empty paragraphs (PowerPoint templates often carry an empty placeholder paragraph)
    while paras.last().is_some_and(String::is_empty) {
        paras.pop();
    }
    Ok(paras.join("\n"))
}

/// `buildNotesTxBody`: text (`\n`-separated) to a notes txBody.
fn build_notes_tx_body(text: &str) -> String {
    const EMPTY_PARA: &str = "<a:p><a:endParaRPr lang=\"zh-CN\"/></a:p>";
    let lines = js_regex!(r"\r\n|\r|\n").split(text);
    let paras = if lines.iter().all(|line| line.is_empty()) {
        EMPTY_PARA.to_owned()
    } else {
        lines
            .iter()
            .map(|line| {
                if line.is_empty() {
                    EMPTY_PARA.to_owned()
                } else {
                    format!(
                        "<a:p><a:r><a:rPr lang=\"zh-CN\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>",
                        escape_xml_text(line)
                    )
                }
            })
            .collect::<String>()
    };
    format!("<p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody>")
}

const NOTES_BODY_SP_OPEN: &str = concat!(
    "<p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Notes Placeholder\"/>",
    "<p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr>",
    "<p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/>"
);

/// `setSlideNotes`: write notes (overwrite): patch the existing notesSlide's
/// body txBody; if there is no notesSlide, create the part (with a
/// notesMaster if needed).
pub fn set_slide_notes(
    opened: &mut OpenedPptx,
    slide_index: usize,
    text: &str,
) -> Result<bool, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Ok(false);
    };
    let slide_path = slide.path.as_deref().unwrap_or("").to_owned();
    let archive = &mut opened.archive;
    let notes_path = match notes_path_for_slide(archive, &slide_path)? {
        Some(path) => path,
        None => match create_notes_slide(archive, &slide_path) {
            Some(path) => path,
            None => return Ok(false),
        },
    };
    if notes_path.is_empty() {
        return Ok(false);
    }
    let Some(xml) = archive
        .read_text(&notes_path)
        .filter(|xml| !xml.is_empty())
        .map(|xml| xml.into_owned())
    else {
        return Ok(false);
    };

    let tx_body = build_notes_tx_body(text);
    let next = match find_body_sp(&xml) {
        Some(body) => {
            let patched = replace_first_with(
                js_regex!(r"<p:txBody>[\s\S]*?<\/p:txBody>"),
                body.xml,
                |_| tx_body.clone(),
            );
            format!(
                "{}{patched}{}",
                xml.get(..body.start).unwrap_or_default(),
                xml.get(body.end..).unwrap_or_default()
            )
        }
        None => replace_literal(
            &xml,
            "</p:spTree>",
            &format!("{NOTES_BODY_SP_OPEN}{tx_body}</p:sp></p:spTree>"),
        ),
    };
    set_entry(archive, &notes_path, next);
    Ok(true)
}

/// `addContentTypeOverride`: add an Override to `[Content_Types].xml`
/// (skipped if already present).
pub fn add_content_type_override(
    archive: &mut PackageArchive,
    part_path: &str,
    content_type: &str,
) {
    let ct_path = "[Content_Types].xml";
    let Some(ct) = archive
        .read_text(ct_path)
        .filter(|ct| !ct.is_empty())
        .map(|ct| ct.into_owned())
    else {
        return;
    };
    if has_content_type_override(&ct, part_path) {
        return;
    }
    let next = replace_literal(
        &ct,
        "</Types>",
        &format!("<Override PartName=\"/{part_path}\" ContentType=\"{content_type}\"/></Types>"),
    );
    set_entry(archive, ct_path, next);
}

/// `appendRelationship`: append a relationship to a part's rels, creating the
/// rels file if missing. Returns the new rId.
pub fn append_relationship(
    archive: &mut PackageArchive,
    part_path: &str,
    r#type: &str,
    target: &str,
) -> String {
    let rels_path = rels_path_for(part_path);
    let xml = match archive.read_text(&rels_path) {
        Some(xml) => xml.into_owned(),
        None => format!(
            "{XMLDECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>"
        ),
    };
    let max_rid = max_relationship_id_number(&xml);
    let rid = format!("rId{}", number_to_string(max_rid + 1.0));
    // a string replacement: the `$` patterns of the type and target apply
    let xml = replace_first_string(
        &xml,
        "</Relationships>",
        &format!(
            "<Relationship Id=\"{rid}\" Type=\"{type}\" Target=\"{target}\"/></Relationships>"
        ),
    );
    set_entry(archive, &rels_path, xml);
    rid
}

/// The first entry name that is a notesMaster part.
fn first_notes_master(archive: &PackageArchive) -> Option<String> {
    let pattern = js_regex!(r"^ppt\/notesMasters\/notesMaster\d+\.xml$");
    archive
        .entries()
        .keys()
        .find(|path| pattern.test(path))
        .map(str::to_owned)
}

/// `ensureNotesMaster`: ensure a notesMaster exists and return its part
/// path. Created and registered in the presentation if missing.
fn ensure_notes_master(archive: &mut PackageArchive) -> String {
    if let Some(path) = first_notes_master(archive) {
        return path;
    }
    let path = "ppt/notesMasters/notesMaster1.xml";
    let empty_tree = concat!(
        "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>",
        "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>",
        "<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree>"
    );
    let xml = format!(
        "{XMLDECL}<p:notesMaster xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\">\
         <p:cSld>{empty_tree}</p:cSld>\
         <p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" \
         accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\
         </p:notesMaster>"
    );
    set_entry(archive, path, xml);
    add_content_type_override(archive, path, NOTES_MASTER_CT);
    // rels: reuse an existing theme part (valid: multiple parts may point to the same theme)
    let theme_pattern = js_regex!(r"^ppt\/theme\/theme\d+\.xml$");
    let theme = archive
        .entries()
        .keys()
        .find(|p| theme_pattern.test(p))
        .map(str::to_owned);
    if let Some(theme) = theme {
        let target = format!("../{}", slice_utf16(&theme, 4.0, None));
        append_relationship(archive, path, THEME_REL, &target);
    }
    // Register notesMasterIdLst in presentation.xml
    let pres_path = "ppt/presentation.xml";
    let pres = archive
        .read_text(pres_path)
        .filter(|pres| !pres.is_empty())
        .map(|pres| pres.into_owned());
    if let Some(pres) = pres {
        let existing_list =
            js_regex!(r"<p:notesMasterIdLst\b[^>]*(?:\/>|>[\s\S]*?<\/p:notesMasterIdLst>)")
                .exec(&pres)
                .map(|m| m.as_str().to_owned());
        if existing_list
            .as_deref()
            .is_none_or(|list| list.ends_with("/>"))
        {
            let rid = append_relationship(
                archive,
                pres_path,
                NOTES_MASTER_REL,
                "notesMasters/notesMaster1.xml",
            );
            let list = format!(
                "<p:notesMasterIdLst><p:notesMasterId r:id=\"{rid}\"/></p:notesMasterIdLst>"
            );
            let next = match &existing_list {
                Some(existing) => replace_literal(&pres, existing, &list),
                None if pres.contains("</p:sldMasterIdLst>") => replace_literal(
                    &pres,
                    "</p:sldMasterIdLst>",
                    &format!("</p:sldMasterIdLst>{list}"),
                ),
                None => replace_literal(&pres, "<p:sldIdLst>", &format!("{list}<p:sldIdLst>")),
            };
            set_entry(archive, pres_path, next);
        }
    }
    path.to_owned()
}

/// `createNotesSlide`: create an empty notesSlide for a slide (part + rels +
/// CT + slide rels); returns the part path. `ensureNotesMaster` never answers
/// null, so neither does this; the `Option` keeps the TypeScript's type.
fn create_notes_slide(archive: &mut PackageArchive, slide_path: &str) -> Option<String> {
    ensure_notes_master(archive);

    let number_pattern = js_regex!(r"^ppt\/notesSlides\/notesSlide(\d+)\.xml$");
    let mut max_num = 0.0_f64;
    for path in archive.entries().keys() {
        if let Some(m) = number_pattern.exec(path) {
            max_num = max_num.max(to_number(m.get(1).unwrap_or_default()));
        }
    }
    let notes_path = format!(
        "ppt/notesSlides/notesSlide{}.xml",
        number_to_string(max_num + 1.0)
    );

    let xml = format!(
        "{XMLDECL}<p:notes xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\">\
         <p:cSld><p:spTree>\
         <p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
         <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>\
         <a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>\
         <p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image Placeholder\"/>\
         <p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr>\
         <p:nvPr><p:ph type=\"sldImg\"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>\
         {NOTES_BODY_SP_OPEN}\
         <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"zh-CN\"/></a:p></p:txBody></p:sp>\
         </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
    );
    set_entry(archive, &notes_path, xml);
    add_content_type_override(archive, &notes_path, NOTES_SLIDE_CT);

    // notesSlide rels: notesMaster + owning slide
    let master = first_notes_master(archive).unwrap_or_default();
    append_relationship(
        archive,
        &notes_path,
        NOTES_MASTER_REL,
        &format!("../{}", slice_utf16(&master, 4.0, None)),
    );
    append_relationship(
        archive,
        &notes_path,
        SLIDE_REL,
        &format!("../{}", slice_utf16(slide_path, 4.0, None)),
    );

    // slide rels: point to the new notesSlide
    append_relationship(
        archive,
        slide_path,
        NOTES_SLIDE_REL,
        &format!("../{}", slice_utf16(&notes_path, 4.0, None)),
    );
    Some(notes_path)
}
