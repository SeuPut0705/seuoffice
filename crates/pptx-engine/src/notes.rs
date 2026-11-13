//! Port of packages/pptx-engine/src/notes.ts: speaker notes (notesSlide) read
//! and write by archive surgery, and the package helpers (`appendRelationship`,
//! `addContentTypeOverride`, `unescapeXml`) the comments and the media modules
//! share.

use jscompat::{js_regex, number_to_string, slice_utf16, to_number};

use crate::deck::OpenedPptx;
use crate::xml_utils::{
    attribute_of, element_range, escape_xml_attr, escape_xml_text, has_content_type_override,
    max_relationship_id_number, root_prefix_of,
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

/// `unescapeXml`: text or an attribute value read off raw XML, as XML reads it (`decodeXml`):
/// one pass, so `&amp;lt;` is the four characters `&lt;`. Never applied to a value the parser
/// returned.
pub use crate::xml_utils::decode_xml as unescape_xml;

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

/// `notesPrefixes`: the prefixes a notes slide part binds PresentationML and DrawingML to
/// (`p:` and `a:` as this engine writes them, '' for a default namespace, or any other); `None`
/// when it binds either to none at its root, and the part is then neither read nor written.
fn notes_prefixes(xml: &str) -> Result<Option<(String, String)>, String> {
    let p = root_prefix_of(xml, NS_P)?;
    let a = root_prefix_of(xml, NS_A)?;
    Ok(match (p, a) {
        (Some(p), Some(a)) => Some((p, a)),
        _ => None,
    })
}

/// The body placeholder `<p:sp>` block of a notesSlide xml.
struct BodySp<'a> {
    xml: &'a str,
    start: usize,
    end: usize,
}

/// `findBodySp`
fn find_body_sp<'a>(xml: &'a str, p: &str) -> Result<Option<BodySp<'a>>, String> {
    let sp_name = format!("{p}sp");
    let ph_name = format!("{p}ph");
    let mut from = 0;
    while let Some(sp) = element_range(xml, &sp_name, from)? {
        let sp_xml = xml.get(sp.start..sp.end).unwrap_or_default();
        if let Some(ph) = element_range(sp_xml, &ph_name, 0)?
            && attribute_of(sp_xml.get(ph.start..ph.end).unwrap_or_default(), "type").as_deref()
                == Some("body")
        {
            return Ok(Some(BodySp {
                xml: sp_xml,
                start: sp.start,
                end: sp.end,
            }));
        }
        from = sp.end;
    }
    Ok(None)
}

/// `contentsOf`: the content of each element named `name` in `xml`, in document order.
fn contents_of(xml: &str, name: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = element_range(xml, name, from)? {
        out.push(
            xml.get(at.content_start..at.content_end)
                .unwrap_or_default()
                .to_owned(),
        );
        from = at.end;
    }
    Ok(out)
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
    let Some((p, a)) = notes_prefixes(&xml)? else {
        return Ok(String::new());
    };
    let Some(body) = find_body_sp(&xml, &p)? else {
        return Ok(String::new());
    };
    let Some(tx) = contents_of(body.xml, &format!("{p}txBody"))?
        .into_iter()
        .next()
        .filter(|tx| !tx.is_empty())
    else {
        return Ok(String::new());
    };
    let text_name = format!("{a}t");
    let mut paras: Vec<String> = Vec::new();
    for para in contents_of(&tx, &format!("{a}p"))? {
        let mut text = String::new();
        for t in contents_of(&para, &text_name)? {
            text.push_str(&unescape_xml(&t));
        }
        paras.push(text);
    }
    // Drop trailing empty paragraphs (PowerPoint templates often carry an empty placeholder paragraph)
    while paras.last().is_some_and(String::is_empty) {
        paras.pop();
    }
    Ok(paras.join("\n"))
}

/// `buildNotesTxBody`: text (`\n`-separated) to a notes txBody, under the part's prefixes.
fn build_notes_tx_body(text: &str, p: &str, a: &str) -> String {
    let empty = format!("<{a}p><{a}endParaRPr lang=\"zh-CN\"/></{a}p>");
    let lines = js_regex!(r"\r\n|\r|\n").split(text);
    let paras = if lines.iter().all(|line| line.is_empty()) {
        empty
    } else {
        lines
            .iter()
            .map(|line| {
                if line.is_empty() {
                    empty.clone()
                } else {
                    format!(
                        "<{a}p><{a}r><{a}rPr lang=\"zh-CN\" dirty=\"0\"/><{a}t>{}</{a}t></{a}r></{a}p>",
                        escape_xml_text(line)
                    )
                }
            })
            .collect::<String>()
    };
    format!("<{p}txBody><{a}bodyPr/><{a}lstStyle/>{paras}</{p}txBody>")
}

/// `notesBodySp`: the body placeholder of a notes slide, holding `txBody`, under the part's
/// prefixes.
fn notes_body_sp(p: &str, a: &str, tx_body: &str) -> String {
    format!(
        "<{p}sp><{p}nvSpPr><{p}cNvPr id=\"3\" name=\"Notes Placeholder\"/>\
         <{p}cNvSpPr><{a}spLocks noGrp=\"1\"/></{p}cNvSpPr>\
         <{p}nvPr><{p}ph type=\"body\" idx=\"1\"/></{p}nvPr></{p}nvSpPr><{p}spPr/>\
         {tx_body}</{p}sp>"
    )
}

/// `setSlideNotes`: write notes (overwrite): patch the existing notesSlide's
/// body txBody; if there is no notesSlide, create the part (with a
/// notesMaster if needed). A notes slide part is written under the prefixes it binds its
/// namespaces to; `false`, and nothing written to it, when it binds them to none or has no
/// shape tree to hold the body.
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
        None => match create_notes_slide(archive, &slide_path)? {
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
    let Some((p, a)) = notes_prefixes(&xml)? else {
        return Ok(false);
    };

    let tx_body = build_notes_tx_body(text, &p, &a);
    let next = match find_body_sp(&xml, &p)? {
        Some(body) => {
            let (start, end) = match element_range(body.xml, &format!("{p}txBody"), 0)? {
                Some(old) => (old.start, old.end),
                None => {
                    // a body placeholder holds its own end tag, so this is always found
                    let at = body
                        .xml
                        .rfind("</")
                        .ok_or_else(|| "notes body placeholder has no end tag".to_owned())?;
                    (at, at)
                }
            };
            let patched = format!(
                "{}{tx_body}{}",
                body.xml.get(..start).unwrap_or_default(),
                body.xml.get(end..).unwrap_or_default()
            );
            format!(
                "{}{patched}{}",
                xml.get(..body.start).unwrap_or_default(),
                xml.get(body.end..).unwrap_or_default()
            )
        }
        None => {
            let Some(tree) = element_range(&xml, &format!("{p}spTree"), 0)? else {
                return Ok(false);
            };
            if tree.content_start == tree.end {
                return Ok(false);
            }
            format!(
                "{}{}{}",
                xml.get(..tree.content_end).unwrap_or_default(),
                notes_body_sp(&p, &a, &tx_body),
                xml.get(tree.content_end..).unwrap_or_default()
            )
        }
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
    // A function replacement, escaped: the target can be a part name the deck chose, and may
    // hold `$&`, `$$` or `&`.
    let xml = replace_literal(
        &xml,
        "</Relationships>",
        &format!(
            "<Relationship Id=\"{rid}\" Type=\"{type}\" Target=\"{}\"/></Relationships>",
            escape_xml_attr(target)
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

/// The place `notesMasterLister` found: presentation.xml with `[start, end)` replaced by the
/// list of one notes master.
struct NotesMasterLister {
    pres: String,
    p: String,
    id_name: String,
    start: usize,
    end: usize,
}

impl NotesMasterLister {
    fn apply(&self, rid: &str) -> String {
        let p = &self.p;
        format!(
            "{}<{p}notesMasterIdLst><{p}notesMasterId {}=\"{}\"/></{p}notesMasterIdLst>{}",
            self.pres.get(..self.start).unwrap_or_default(),
            self.id_name,
            escape_xml_attr(rid),
            self.pres.get(self.end..).unwrap_or_default()
        )
    }
}

/// `notesMasterLister`: lists a notes master in presentation.xml, under the prefixes the part
/// binds PresentationML and the relationships namespace to: the list goes where the schema puts
/// it, right after `sldMasterIdLst` (before `handoutMasterIdLst`, `sldIdLst`, `sldSz`,
/// `notesSz`), and replaces a list already there (it holds one entry at most). `None` when
/// there is nowhere to put it, and the caller then writes nothing.
fn notes_master_lister(pres: &str) -> Result<Option<NotesMasterLister>, String> {
    let Some(p) = root_prefix_of(pres, NS_P)? else {
        return Ok(None);
    };
    // an unprefixed attribute is in no namespace, so `r:` is declared where it is not bound
    let id_name = match root_prefix_of(pres, NS_R)?.filter(|r| !r.is_empty()) {
        Some(r) => format!("{r}id"),
        None => format!("xmlns:r=\"{NS_R}\" r:id"),
    };
    let (start, end) =
        if let Some(existing) = element_range(pres, &format!("{p}notesMasterIdLst"), 0)? {
            (existing.start, existing.end)
        } else {
            let mut at = element_range(pres, &format!("{p}sldMasterIdLst"), 0)?.map(|r| r.end);
            for next in ["handoutMasterIdLst", "sldIdLst", "sldSz", "notesSz"] {
                if at.is_none() {
                    at = element_range(pres, &format!("{p}{next}"), 0)?.map(|r| r.start);
                }
            }
            let Some(at) = at else {
                return Ok(None);
            };
            (at, at)
        };
    Ok(Some(NotesMasterLister {
        pres: pres.to_owned(),
        p,
        id_name,
        start,
        end,
    }))
}

/// `ensureNotesMaster`: ensure a notesMaster exists and return its part
/// path. Created and registered in the presentation if missing; `None` when the presentation
/// has nowhere to list it (nothing is written then).
fn ensure_notes_master(archive: &mut PackageArchive) -> Result<Option<String>, String> {
    let pres_path = "ppt/presentation.xml";
    for rel in archive.read_rels(pres_path)?.values() {
        if rel.r#type != NOTES_MASTER_REL {
            continue;
        }
        let listed = resolve_target(pres_path, &rel.target);
        if archive.has(&listed) {
            return Ok(Some(listed));
        }
    }
    if let Some(path) = first_notes_master(archive) {
        return Ok(Some(path));
    }
    // decided before anything is written: a deck that cannot list the master is left as it was
    let pres = archive.read_text(pres_path).map(|pres| pres.into_owned());
    let listed = match pres {
        Some(pres) => notes_master_lister(&pres)?,
        None => None,
    };
    let Some(listed) = listed else {
        return Ok(None);
    };

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
    let rid = append_relationship(
        archive,
        pres_path,
        NOTES_MASTER_REL,
        "notesMasters/notesMaster1.xml",
    );
    set_entry(archive, pres_path, listed.apply(&rid));
    Ok(Some(path.to_owned()))
}

/// `createNotesSlide`: create an empty notesSlide for a slide (part + rels +
/// CT + slide rels); returns the part path (`None` when the presentation cannot list a notes
/// master).
fn create_notes_slide(
    archive: &mut PackageArchive,
    slide_path: &str,
) -> Result<Option<String>, String> {
    let Some(master) = ensure_notes_master(archive)? else {
        return Ok(None);
    };

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

    let body_sp = notes_body_sp(
        "p:",
        "a:",
        "<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"zh-CN\"/></a:p></p:txBody>",
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
         {body_sp}\
         </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
    );
    set_entry(archive, &notes_path, xml);
    add_content_type_override(archive, &notes_path, NOTES_SLIDE_CT);

    // notesSlide rels: notesMaster + owning slide
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
    Ok(Some(notes_path))
}
