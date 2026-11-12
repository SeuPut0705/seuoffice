//! The write half of notes.ts: `buildNotesXml` and the constants the save
//! reads for the footnotes and endnotes parts.

use std::collections::HashSet;

use jscompat::{number_to_string, try_js_regex};

use super::js::limit;
use crate::generate::{escape_xml_attr as attr, escape_xml_text as text};
use crate::model::{NoteInfo, NoteRun};
use crate::notes::{NoteKind, note_entries_of, note_entry_plain_text, root_attributes};
use crate::save::parts::text_patch::patch_paragraph_texts;

/// `NOTE_PART_PATH`
pub fn note_part_path(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Footnote => "word/footnotes.xml",
        NoteKind::Endnote => "word/endnotes.xml",
    }
}

/// `NOTE_REL_TYPE`
pub fn note_rel_type(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Footnote => {
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes"
        }
        NoteKind::Endnote => {
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes"
        }
    }
}

/// `NOTE_CONTENT_TYPE`
pub fn note_content_type(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Footnote => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"
        }
        NoteKind::Endnote => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"
        }
    }
}

const NOTE_NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";

fn root_of(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Footnote => "w:footnotes",
        NoteKind::Endnote => "w:endnotes",
    }
}

fn entry_of(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Footnote => "w:footnote",
        NoteKind::Endnote => "w:endnote",
    }
}

/// `separatorEntries`: the separator entries Word requires when the part is created fresh.
fn separator_entries(kind: NoteKind) -> String {
    let entry = entry_of(kind);
    format!(
        "<{entry} w:type=\"separator\" w:id=\"-1\"><w:p><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:r><w:separator/></w:r></w:p></{entry}><{entry} w:type=\"continuationSeparator\" w:id=\"0\"><w:p><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></{entry}>"
    )
}

/// The size of a run as `if (run.sizeHalfPoints)` reads it.
fn truthy_number(value: Option<jscompat::JsNum>) -> Option<String> {
    value
        .filter(|n| n.0 != 0.0 && !n.0.is_nan())
        .map(|n| number_to_string(n.0))
}

/// `noteRunXml`: one rich display run as run XML.
fn note_run_xml(run: &NoteRun) -> String {
    let mut props: Vec<String> = Vec::new();
    let mut fonts: Vec<String> = Vec::new();
    if let Some(ascii) = run.font_ascii.as_deref().filter(|f| !f.is_empty()) {
        fonts.push(format!("w:ascii=\"{0}\" w:hAnsi=\"{0}\"", attr(ascii)));
    }
    if let Some(font) = run.font.as_deref().filter(|f| !f.is_empty()) {
        fonts.push(format!("w:eastAsia=\"{}\"", attr(font)));
    }
    if !fonts.is_empty() {
        props.push(format!("<w:rFonts {}/>", fonts.join(" ")));
    }
    if run.bold == Some(true) {
        props.push("<w:b/>".to_owned());
    }
    if run.italic == Some(true) {
        props.push("<w:i/>".to_owned());
    }
    if run.underline == Some(true) {
        props.push("<w:u w:val=\"single\"/>".to_owned());
    }
    if run.strike == Some(true) {
        props.push("<w:strike/>".to_owned());
    }
    if let Some(color) = run.color.as_deref().filter(|c| !c.is_empty()) {
        props.push(format!("<w:color w:val=\"{}\"/>", attr(color)));
    }
    if let Some(size) = truthy_number(run.size_half_points) {
        props.push(format!(
            "<w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/>"
        ));
    }
    let r_pr = if props.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{}</w:rPr>", props.join(""))
    };
    let text_tag = if run.del.is_some() {
        "w:delText"
    } else {
        "w:t"
    };
    format!(
        "<w:r>{r_pr}<{text_tag} xml:space=\"preserve\">{}</{text_tag}></w:r>",
        text(&run.text)
    )
}

/// `noteRevAllocator`: w:ins / w:del attributes with ids unique across one notes part.
struct NoteRevAttrs {
    seq: f64,
    emitted: HashSet<String>,
}

impl NoteRevAttrs {
    fn new(original_xml: Option<&str>) -> Result<Self, String> {
        let mut emitted = HashSet::new();
        for found in try_js_regex!(r#"<w:(?:ins|del)\s[^>]*?\bw:id="([^"]*)""#, "g")
            .try_find_iter(original_xml.unwrap_or(""))
        {
            let found = found.map_err(limit)?;
            emitted.insert(found.get(1).unwrap_or_default().to_owned());
        }
        Ok(Self {
            seq: 7001.0,
            emitted,
        })
    }

    fn attrs(&mut self, info: &crate::model::RevisionInfo) -> String {
        let next = |seq: &mut f64| {
            let id = number_to_string(*seq);
            *seq += 1.0;
            id
        };
        let mut id = match info.id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) if !self.emitted.contains(id) => id.to_owned(),
            _ => next(&mut self.seq),
        };
        while self.emitted.contains(&id) {
            id = next(&mut self.seq);
        }
        self.emitted.insert(id.clone());
        format!(
            " w:id=\"{}\" w:author=\"{}\"{}",
            attr(&id),
            attr(&info.author),
            info.date
                .as_deref()
                .filter(|date| !date.is_empty())
                .map_or(String::new(), |date| format!(" w:date=\"{}\"", attr(date)))
        )
    }
}

/// `noteRunsXml`: rich runs as run XML; consecutive runs of one tracked change share a wrapper.
fn note_runs_xml(runs: &[NoteRun], attrs: &mut NoteRevAttrs) -> String {
    let mut out = String::new();
    let mut g = 0;
    while g < runs.len() {
        let same = |run: &NoteRun| run.ins == runs[g].ins && run.del == runs[g].del;
        let mut end = g;
        while end < runs.len() && same(&runs[end]) {
            end += 1;
        }
        let inner: String = runs[g..end].iter().map(note_run_xml).collect();
        let wrapped = match &runs[g].del {
            Some(del) => format!("<w:del{}>{inner}</w:del>", attrs.attrs(del)),
            None => inner,
        };
        out.push_str(&match &runs[g].ins {
            Some(ins) => format!("<w:ins{}>{wrapped}</w:ins>", attrs.attrs(ins)),
            None => wrapped,
        });
        g = end;
    }
    out
}

/// `noteEntryXml`
fn note_entry_xml(kind: NoteKind, note: &NoteInfo, attrs: &mut NoteRevAttrs) -> String {
    let entry = entry_of(kind);
    let ref_tag = match kind {
        NoteKind::Footnote => "w:footnoteRef",
        NoteKind::Endnote => "w:endnoteRef",
    };
    if let Some(rich) = note.rich_paras.as_ref().filter(|paras| !paras.is_empty()) {
        let paras: Vec<String> = rich
            .iter()
            .enumerate()
            .map(|(i, runs)| {
                let sz = truthy_number(runs.first().and_then(|run| run.size_half_points));
                let sz_xml = sz.as_ref().map_or(String::new(), |sz| {
                    format!("<w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/>")
                });
                let ref_run = if i == 0 {
                    format!(
                        "<w:r><w:rPr><w:vertAlign w:val=\"superscript\"/>{sz_xml}</w:rPr><{ref_tag}/></w:r><w:r>{}<w:t xml:space=\"preserve\"> </w:t></w:r>",
                        if sz.is_some() { format!("<w:rPr>{sz_xml}</w:rPr>") } else { String::new() }
                    )
                } else {
                    String::new()
                };
                let p_pr = "<w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>";
                format!("<w:p>{p_pr}{ref_run}{}</w:p>", note_runs_xml(runs, attrs))
            })
            .collect();
        return format!(
            "<{entry} w:id=\"{}\">{}</{entry}>",
            attr(&note.id),
            paras.join("")
        );
    }
    let paras: Vec<String> = note
        .text
        .split('\n')
        .enumerate()
        .map(|(i, line)| {
            let ref_run = if i == 0 {
                format!(
                    "<w:r><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr><{ref_tag}/></w:r><w:r><w:t xml:space=\"preserve\"> </w:t></w:r>"
                )
            } else {
                String::new()
            };
            let text_run = if line.is_empty() {
                String::new()
            } else {
                format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", text(line))
            };
            format!("<w:p>{ref_run}{text_run}</w:p>")
        })
        .collect();
    format!(
        "<{entry} w:id=\"{}\">{}</{entry}>",
        attr(&note.id),
        paras.join("")
    )
}

/// `buildNotesXml`: the notes part regenerated from the full desired list.
/// Structural entries of the original are kept byte-identical; a note whose
/// text is unchanged keeps its original bytes; a changed one is patched at the
/// w:t level and only rebuilt from plain text when that fails.
pub fn build_notes_xml(
    kind: NoteKind,
    notes: &[NoteInfo],
    original_xml: Option<&str>,
) -> Result<String, String> {
    let mut structural = String::new();
    let mut originals: Vec<(String, String, String)> = Vec::new();
    if let Some(original) = original_xml.filter(|xml| !xml.is_empty()) {
        let re = match kind {
            NoteKind::Footnote => try_js_regex!(
                r#"<w:footnote\s[^>]*w:type=(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?</w:footnote>"#,
                "g"
            ),
            NoteKind::Endnote => try_js_regex!(
                r#"<w:endnote\s[^>]*w:type=(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?</w:endnote>"#,
                "g"
            ),
        };
        for found in re.try_find_iter(original) {
            structural.push_str(found.map_err(limit)?.as_str());
        }
        for e in note_entries_of(original, kind) {
            // a Map keeps the first position and the last value of an id
            let item = (e.id.to_owned(), e.text.clone(), e.xml.to_owned());
            match originals.iter_mut().find(|have| have.0 == item.0) {
                Some(have) => *have = item,
                None => originals.push(item),
            }
        }
    }
    if structural.is_empty() {
        structural = separator_entries(kind);
    }
    let mut rev_attrs = NoteRevAttrs::new(original_xml)?;
    let mut body = String::new();
    for n in notes {
        let found = originals.iter().find(|have| have.0 == n.id);
        let Some(found) = found else {
            body.push_str(&note_entry_xml(kind, n, &mut rev_attrs));
            continue;
        };
        let (mut orig_text, mut orig_xml) = (found.1.clone(), found.2.clone());
        if n.revisions_resolved
            .as_ref()
            .is_some_and(|resolved| !resolved.is_empty())
        {
            let resolutions =
                serde_json::to_value(&n.revisions_resolved).map_err(|e| e.to_string())?;
            let xml =
                crate::revision_xml::apply_revision_resolutions(&orig_xml, Some(&resolutions))?
                    .into_owned();
            let inner_re = match kind {
                NoteKind::Footnote => try_js_regex!(r"^<w:footnote[^>]*>([\s\S]*)</w:footnote>$"),
                NoteKind::Endnote => try_js_regex!(r"^<w:endnote[^>]*>([\s\S]*)</w:endnote>$"),
            };
            let inner = inner_re
                .try_exec(&xml)
                .map_err(limit)?
                .and_then(|found| found.get(1).map(str::to_owned))
                .unwrap_or_default();
            orig_text = note_entry_plain_text(&inner);
            orig_xml = xml;
        }
        if orig_text == n.text {
            body.push_str(&orig_xml);
            continue;
        }
        match patch_paragraph_texts(&orig_xml, &n.text, true) {
            Some(patched) => body.push_str(&patched),
            None => body.push_str(&note_entry_xml(kind, n, &mut rev_attrs)),
        }
    }
    let root = root_of(kind);
    let attrs = root_attributes(original_xml, root, NOTE_NS, &[]).map_err(|e| e.to_string())?;
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<{root} {attrs}>{structural}{body}</{root}>"
    ))
}
