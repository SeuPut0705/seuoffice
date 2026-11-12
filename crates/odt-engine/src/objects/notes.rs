//! `objects/notes.ts`: footnotes and endnotes (`text:note`).
//!
//! Forward: the citation becomes a `w:footnoteReference`/`w:endnoteReference`
//! run; the body paragraphs are converted by the text layer
//! (`paragraph_to_ooxml`, owner `objects`) into word/footnotes.xml or
//! word/endnotes.xml. Objects inside a note body are kept, not converted.
//!
//! Save: the reference run writes the original `text:note` when the note's
//! text is unchanged; otherwise the body is rewritten paragraph by paragraph
//! with the text layer (`paragraph_to_odf`, origin = the original note
//! paragraph). The docx note is plain text in the editor, so every edited
//! character takes the formatting of the original character it continues. A
//! reference the bridge never had becomes a new `text:note` shaped like the
//! document's other notes; a removed reference removes the note.
//!
//! The texts of the save side are aligned by UTF-16 code unit as the
//! TypeScript indexes them (`text[i]`, `T.slice(..)`); a run cut between the
//! halves of a pair reads back as U+FFFD where JavaScript holds the lone half.

use docx_engine::model::{Run, RunLink, RunNoteRef, RunNoteRefKind};
use jscompat::{JsNum, JsObject, is_js_space, js_regex, number_to_string, replace_first};

use crate::core::convert::{
    BridgeParagraph, BridgeParagraphElement, EditedParagraph, EditedParagraphType, InlineConverter,
    InlineElement, InlineEnv, InlineOoxml, OdfToOoxmlContext, OoxmlToOdfContext, ParagraphWriteEnv,
};
use crate::core::errors::OdtError;
use crate::core::styles::OdtStylePart;
use crate::core::xml::{ElementRange, attribute_map, escape_xml_text};
use crate::offset::{U16, to_byte};
use crate::text::align::align_texts;
use crate::text::paragraph_odf::{ParagraphWriteOptions, original_model, paragraph_to_odf};
use crate::text::paragraph_ooxml::{
    ParagraphOoxmlOptions, paragraph_style_info, paragraph_to_ooxml,
};
use crate::text::props::{para_format_from_odf, text_format_from_odf};

use super::analyze::{plain_text_of, sub_elements};
use super::model::{NoteKind, OBJECTS_OWNER, ObjectNote};
use super::state::{
    append_to_lazy_part, edited_note, forward_state, lazy_part, note_key, save_state, slice_u16,
    source_of,
};

/// `W_NS`
const W_NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";

/// `PART[kind]`
struct NotePart {
    path: &'static str,
    root: &'static str,
    entry: &'static str,
    r#type: &'static str,
    rel: &'static str,
}

/// `PART`
fn part_of(kind: NoteKind) -> NotePart {
    match kind {
        NoteKind::Footnote => NotePart {
            path: "word/footnotes.xml",
            root: "w:footnotes",
            entry: "w:footnote",
            r#type: "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
            rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
        },
        NoteKind::Endnote => NotePart {
            path: "word/endnotes.xml",
            root: "w:endnotes",
            entry: "w:endnote",
            r#type: "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
            rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes",
        },
    }
}

/// `separators`
fn separators(kind: NoteKind) -> String {
    let e = part_of(kind).entry;
    format!(
        "<{e} w:type=\"separator\" w:id=\"-1\"><w:p><w:r><w:separator/></w:r></w:p></{e}>\
<{e} w:type=\"continuationSeparator\" w:id=\"0\"><w:p><w:r><w:continuationSeparator/></w:r></w:p></{e}>"
    )
}

/// `noteEntryXml`: one note entry: the paragraphs, the first one opening with
/// the note's own reference mark.
fn note_entry_xml(kind: NoteKind, id: &str, paragraphs: &[String]) -> String {
    let r#ref = format!(
        "<w:r><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr><w:{}Ref/></w:r>",
        kind.as_str()
    );
    let mut paras: Vec<String> = if paragraphs.is_empty() {
        vec!["<w:p></w:p>".to_string()]
    } else {
        paragraphs.to_vec()
    };
    let head = js_regex!(
        r"^<w:p>(?:<w:pPr>[\s\S]*?</w:pPr>)?(?:<w:bookmarkStart [^>]*/><w:bookmarkEnd [^>]*/>)?"
    )
    .exec(&paras[0])
    .map_or("<w:p>".to_string(), |m| m.as_str().to_string());
    // `paras[0].slice(head.length)`: a head that does not match is `<w:p>` all the same
    let at = to_byte(&paras[0], crate::offset::u16_len(&head));
    paras[0] = format!("{head}{ref}{}", &paras[0][at..]);
    let e = part_of(kind).entry;
    format!("<{e} w:id=\"{id}\">{}</{e}>", paras.join(""))
}

/// `noteInlineConverter`
pub struct NoteInlineConverter;

impl InlineConverter for NoteInlineConverter {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn names(&self) -> &[&'static str] {
        &["text:note"]
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        el: &InlineElement,
        env: &InlineEnv,
    ) -> Result<Option<InlineOoxml>, OdtError> {
        if el.part != OdtStylePart::ContentXml || el.close_start <= el.open_end {
            return Ok(None);
        }
        let st = forward_state(ctx);
        if st.borrow().nested > 0 {
            return Ok(None);
        }
        let info = ctx.part(el.part);
        let xml = &info.xml.text;
        let subs = sub_elements(xml, &info.prefixes, el.open_end, el.close_start);
        let top: Vec<_> = subs.iter().filter(|s| s.depth == 0).collect();
        let body = top.iter().find(|s| s.name == "text:note-body");
        let citation = top.iter().find(|s| s.name == "text:note-citation");
        let Some(body) = body else {
            return Ok(None);
        };
        let note_class = attribute_map(xml, el.name_end, el.open_end, &info.prefixes)
            .get("text:note-class")
            .cloned();
        let kind = if note_class.as_deref() == Some("endnote") {
            NoteKind::Endnote
        } else {
            NoteKind::Footnote
        };
        let id = {
            let mut st = st.borrow_mut();
            let seq = st.note_seq.get_mut(kind);
            *seq += 1;
            seq.to_string()
        };

        let mut paragraphs: Vec<usize> = Vec::new();
        let mut para_xml: Vec<String> = Vec::new();
        let mut editable = true;
        st.borrow_mut().nested += 1;
        let converted = (|| -> Result<(), OdtError> {
            for child in subs
                .iter()
                .filter(|s| s.depth == 1 && s.start >= body.open_end && s.end <= body.close_start)
            {
                if child.name == "text:p" || child.name == "text:h" {
                    let out = paragraph_to_ooxml(
                        ctx,
                        &ElementRange {
                            start: child.start,
                            open_end: child.open_end,
                            close_start: child.close_start,
                            end: child.end,
                            self_closing: child.self_closing,
                        },
                        &ParagraphOoxmlOptions {
                            part: el.part,
                            owner: Some(OBJECTS_OWNER.to_string()),
                            block: None,
                            list: None,
                        },
                    )?;
                    paragraphs.push(out.paragraph.id);
                    para_xml.push(out.xml);
                } else {
                    editable = false;
                }
            }
            Ok(())
        })();
        st.borrow_mut().nested -= 1;
        converted?;
        let entry = note_entry_xml(kind, &id, &para_xml);
        let root = part_of(kind).root;
        let text = docx_engine::notes::parse_notes_xml(
            &format!("<{root}>{entry}</{root}>"),
            docx_kind(kind),
        )
        .into_iter()
        .next()
        .map(|n| n.text)
        .unwrap_or_default();
        let part = part_of(kind);
        let suffix = format!("</{root}>");
        lazy_part(
            ctx,
            part.path,
            part.r#type,
            part.rel,
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<{root} {W_NS}>{}{suffix}",
                separators(kind)
            ),
        );
        append_to_lazy_part(ctx, part.path, &suffix, &entry);
        let record = ObjectNote {
            id: id.clone(),
            kind,
            start: info.xml.to_u16(el.start),
            end: info.xml.to_u16(el.end),
            body_start: info.xml.to_u16(body.open_end),
            body_end: info.xml.to_u16(body.close_start),
            citation: match citation {
                Some(citation) => {
                    plain_text_of(xml, &info.prefixes, citation.open_end, citation.close_start)
                }
                None => String::new(),
            },
            body_first: citation.is_none_or(|c| body.start < c.start),
            paragraph: env.paragraph_id,
            paragraphs,
            text,
            editable,
        };
        st.borrow_mut().ext.notes.push(record);
        // the docx engine numbers references in body order; notes convert in that order
        Ok(Some(InlineOoxml::Xml {
            xml: format!(
                "<w:r><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr><w:{}Reference w:id=\"{id}\"/></w:r>",
                kind.as_str()
            ),
            text: id,
        }))
    }
}

/// The docx engine's `NoteKind` of an objects `NoteKind`.
fn docx_kind(kind: NoteKind) -> docx_engine::notes::NoteKind {
    match kind {
        NoteKind::Footnote => docx_engine::notes::NoteKind::Footnote,
        NoteKind::Endnote => docx_engine::notes::NoteKind::Endnote,
    }
}

// ---------------------------------------------------------------------------
// Save

/// The UTF-16 code units of a text.
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// The units as a string (a half of a pair reads as U+FFFD).
fn string_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `engineMap`'s result: the engine-visible text and, per character of it, the
/// index in the paragraph text.
struct EngineMap {
    text: Vec<u16>,
    at: Vec<usize>,
}

/// `engineMap`: the engine-visible text of a paragraph record: no
/// tabs/breaks, a first paragraph without leading space.
fn engine_map(text: &[u16], first: bool) -> EngineMap {
    let mut at: Vec<usize> = Vec::new();
    for (i, &u) in text.iter().enumerate() {
        if !matches!(u, 0x09 | 0x0a | 0x0c) {
            at.push(i);
        }
    }
    let mut engine: Vec<u16> = at.iter().map(|&i| text[i]).collect();
    if first {
        let lead = engine
            .iter()
            .take_while(|&&u| char::from_u32(u32::from(u)).is_some_and(is_js_space))
            .count();
        at.drain(..lead);
        engine.drain(..lead);
    }
    EngineMap { text: engine, at }
}

/// `runsLike`: runs for `text` carrying, per character, the formatting of the
/// original character it continues.
fn runs_like(
    rctx: &mut OoxmlToOdfContext,
    record: &BridgeParagraph,
    text: &str,
) -> Result<Vec<Run>, OdtError> {
    let Some(model) = original_model(rctx, record)? else {
        let mut run = Run::default();
        run.text.set(text.to_string());
        return Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![run]
        });
    };
    let style = paragraph_style_info(
        &rctx.doc,
        &rctx.map,
        record.part,
        record.style_name.as_deref(),
    );
    let part_info = rctx.part(record.part);
    let fonts = &part_info.font_faces;
    let align = align_texts(&record.text, text);
    let record_len = i64::from(crate::offset::u16_len(&record.text).0);
    let set_at = |i: usize| -> i64 {
        if record_len == 0 {
            return model.empty_set as i64;
        }
        let idx = align.original_of(U16(i as u32)).clamp(0, record_len - 1) as usize;
        for k in (0..=idx).rev() {
            if model.char_sets[k] >= 0 {
                return model.char_sets[k];
            }
        }
        for k in idx..model.char_sets.len() {
            if model.char_sets[k] >= 0 {
                return model.char_sets[k];
            }
        }
        model.empty_set as i64
    };
    let format_of = |set: i64| -> Run {
        let s = &model.sets[set as usize];
        let mut attrs: JsObject<String> = style.own_text.clone();
        attrs.assign(&s.attrs);
        let mut run = Run::default();
        run.text.set(String::new());
        run.assign(&text_format_from_odf(&attrs, fonts));
        if let Some(href) = &s.href {
            run.link.set(RunLink {
                href: href.clone(),
                r_id: None,
                tooltip: None,
                plain: Some(true),
            });
        }
        run
    };
    let all = units(text);
    let mut runs: Vec<(Run, Vec<u16>)> = Vec::new();
    let mut last: i64 = -2;
    for (i, &u) in all.iter().enumerate() {
        let set = set_at(i);
        if set == last {
            if let Some(current) = runs.last_mut() {
                current.1.push(u);
            }
        } else {
            runs.push((format_of(set), vec![u]));
            last = set;
        }
    }
    Ok(runs
        .into_iter()
        .map(|(mut run, run_units)| {
            run.text.set(string_of(&run_units));
            run
        })
        .collect())
}

/// `editedParagraphFor`
fn edited_paragraph_for(
    rctx: &mut OoxmlToOdfContext,
    record: &BridgeParagraph,
    runs: Vec<Run>,
) -> Result<EditedParagraph, OdtError> {
    let style = paragraph_style_info(
        &rctx.doc,
        &rctx.map,
        record.part,
        record.style_name.as_deref(),
    );
    let model = original_model(rctx, record)?;
    Ok(EditedParagraph {
        r#type: if record.element == BridgeParagraphElement::TextH {
            EditedParagraphType::Heading
        } else {
            EditedParagraphType::Paragraph
        },
        level: model
            .as_ref()
            .and_then(|m| m.outline_level)
            .map(|n| JsNum(n as f64)),
        runs,
        raw_p_pr: Some(record.p_pr.clone()),
        style_id: style.style_id.clone(),
        format: Some(para_format_from_odf(
            &style.own_paragraph,
            style.tab_stops.as_deref(),
            style.margin_left,
        )),
        outline_only: None,
        list: None,
        hidden_bookmarks: None,
    })
}

/// `rewriteParagraph`: one original note paragraph with its engine text
/// changed from `before` to `after`.
fn rewrite_paragraph(
    rctx: &mut OoxmlToOdfContext,
    record: &BridgeParagraph,
    before: &str,
    after: &str,
    first: bool,
) -> Result<String, OdtError> {
    let t = units(&record.text);
    let map = engine_map(&t, first);
    let full: String = if map.text != units(before) {
        after.to_string()
    } else {
        let o = &map.text;
        let after_units = units(after);
        let mut p = 0;
        while p < o.len() && p < after_units.len() && o[p] == after_units[p] {
            p += 1;
        }
        let mut s = 0;
        while s < o.len() - p
            && s < after_units.len() - p
            && o[o.len() - 1 - s] == after_units[after_units.len() - 1 - s]
        {
            s += 1;
        }
        let start = if p > 0 {
            map.at[p - 1] + 1
        } else if !map.at.is_empty() {
            map.at[0]
        } else {
            t.len()
        };
        let mut end = if s > 0 {
            map.at[o.len() - s]
        } else if p < o.len() {
            map.at[o.len() - 1] + 1
        } else {
            start
        };
        if end < start {
            end = start;
        }
        let mut full: Vec<u16> = t[..start.min(t.len())].to_vec();
        full.extend_from_slice(&after_units[p..after_units.len() - s]);
        full.extend_from_slice(&t[end.min(t.len())..]);
        string_of(&full)
    };
    let runs = runs_like(rctx, record, &full)?;
    let para = edited_paragraph_for(rctx, record, runs)?;
    paragraph_to_odf(
        rctx,
        &para,
        Some(record),
        &ParagraphWriteOptions {
            part: record.part,
            ..Default::default()
        },
    )
}

/// `newParagraph`: a new note paragraph shaped like `template` (the paragraph
/// before it, or another note's).
fn new_paragraph(
    rctx: &mut OoxmlToOdfContext,
    text: &str,
    template: Option<&BridgeParagraph>,
) -> Result<String, OdtError> {
    let mut runs: Vec<Run> = Vec::new();
    if !text.is_empty() {
        match template {
            Some(template) => {
                let like = runs_like(rctx, template, &format!("{}{text}", template.text))?
                    .into_iter()
                    .next_back();
                if let Some(mut like) = like {
                    like.text.set(text.to_string());
                    runs.push(like);
                }
            }
            None => {
                let mut run = Run::default();
                run.text.set(text.to_string());
                runs.push(run);
            }
        }
    }
    let para = match template {
        Some(template) => EditedParagraph {
            r#type: EditedParagraphType::Paragraph,
            raw_p_pr: None,
            ..edited_paragraph_for(rctx, template, runs)?
        },
        None => EditedParagraph {
            r#type: EditedParagraphType::Paragraph,
            runs,
            format: None,
            style_id: None,
            level: None,
            outline_only: None,
            list: None,
            raw_p_pr: None,
            hidden_bookmarks: None,
        },
    };
    paragraph_to_odf(
        rctx,
        &para,
        None,
        &ParagraphWriteOptions {
            part: OdtStylePart::ContentXml,
            neighbour: template,
            follows: template,
            ..Default::default()
        },
    )
}

/// `rewriteBody`: the note body for the edited text, reusing unchanged
/// original paragraphs byte for byte.
fn rewrite_body(
    rctx: &mut OoxmlToOdfContext,
    note: &ObjectNote,
    text: &str,
) -> Result<String, OdtError> {
    let records: Vec<BridgeParagraph> = note
        .paragraphs
        .iter()
        .filter_map(|&id| rctx.map.paragraphs.get(id).cloned())
        .collect();
    let info = rctx.part(OdtStylePart::ContentXml);
    let xml = &info.xml;
    let before: Vec<&str> = note.text.split('\n').collect();
    let after: Vec<&str> = text.split('\n').collect();
    let n = records.len();
    let m = after.len();
    let mut p = 0;
    while p < n && p < m && after.get(p) == before.get(p) {
        p += 1;
    }
    let mut s = 0;
    while s < n - p && s < m - p && after.get(m - 1 - s) == before.get(n - 1 - s) {
        s += 1;
    }
    let mut out: Vec<String> = Vec::new();
    for record in &records[..p] {
        out.push(slice_u16(xml, record.start, record.end).to_string());
    }
    let mut template: Option<BridgeParagraph> = if p > 0 {
        Some(records[p - 1].clone())
    } else {
        None
    };
    for k in 0..(m - p - s) {
        let i = p + k;
        if i < n - s {
            out.push(rewrite_paragraph(
                rctx,
                &records[i],
                before.get(i).copied().unwrap_or(""),
                after[i],
                i == 0,
            )?);
            template = Some(records[i].clone());
        } else {
            let like = template.as_ref().or_else(|| records.first());
            out.push(new_paragraph(rctx, after[i], like)?);
        }
    }
    if m - p - s < n - p - s {
        rctx.warn("paragraphs deleted from a note were removed");
    }
    for record in &records[n - s..n] {
        out.push(slice_u16(xml, record.start, record.end).to_string());
    }
    Ok(out.join(""))
}

/// `citationFor`: the citation of a new note: the number, written like the
/// document's other citations.
fn citation_for(
    rctx: &OoxmlToOdfContext,
    kind: NoteKind,
    id: &str,
    template: Option<&ObjectNote>,
) -> String {
    let n = rctx
        .edited
        .note_numbers
        .as_ref()
        .and_then(|numbers| numbers.get(&format!("{}:{id}", kind.as_str())));
    let number = match n {
        None => id.to_string(),
        Some(n) => number_to_string(n.0),
    };
    if let Some(template) = template {
        if js_regex!(r"\d+").test(&template.citation) {
            return replace_first(js_regex!(r"\d+"), 0, &template.citation, &number);
        }
    }
    number
}

/// The objects `NoteKind` of a note reference run.
fn note_kind_of(kind: RunNoteRefKind) -> NoteKind {
    match kind {
        RunNoteRefKind::Footnote => NoteKind::Footnote,
        RunNoteRefKind::Endnote => NoteKind::Endnote,
    }
}

/// `notesRunWriter`: writes the `text:note` for a note reference run of an
/// edited paragraph.
pub fn notes_run_writer(
    rctx: &mut OoxmlToOdfContext,
    r#ref: &RunNoteRef,
    _env: &ParagraphWriteEnv<'_>,
) -> Result<String, OdtError> {
    let st = save_state(rctx)?;
    let kind = note_kind_of(r#ref.kind);
    let key = note_key(kind, &r#ref.id);
    let note = st.borrow().note(&key).cloned();
    let edited = edited_note(rctx, kind, &r#ref.id);
    if let Some(note) = note {
        if st.borrow().emitted_notes.contains(&key) {
            rctx.warn("a repeated note reference was dropped");
            return Ok(String::new());
        }
        st.borrow_mut().emitted_notes.insert(key);
        let original = source_of(rctx, OdtStylePart::ContentXml, note.start, note.end);
        let Some(edited) = edited else {
            return Ok(original);
        };
        if edited.text == note.text {
            return Ok(original);
        }
        if !note.editable {
            rctx.warn("a note holding more than paragraphs keeps its original text");
            return Ok(original);
        }
        let info = rctx.part(OdtStylePart::ContentXml);
        let body = rewrite_body(rctx, &note, &edited.text)?;
        return Ok(format!(
            "{}{}{}",
            slice_u16(&info.xml, note.start, note.body_start),
            body,
            slice_u16(&info.xml, note.body_end, note.end)
        ));
    }
    let Some(edited) = edited else {
        rctx.warn("dropped a note reference without a note");
        return Ok(String::new());
    };
    st.borrow_mut().emitted_notes.insert(key);
    let template: Option<ObjectNote> = {
        let st = st.borrow();
        st.ext
            .notes
            .iter()
            .find(|x| x.kind == kind && !x.paragraphs.is_empty())
            .or_else(|| st.ext.notes.iter().find(|x| !x.paragraphs.is_empty()))
            .cloned()
    };
    let template_para: Option<BridgeParagraph> = template
        .as_ref()
        .and_then(|t| rctx.map.paragraphs.get(t.paragraphs[0]).cloned());
    let mut body = String::new();
    for t in edited.text.split('\n') {
        body.push_str(&new_paragraph(rctx, t, template_para.as_ref())?);
    }
    let citation = format!(
        "<text:note-citation>{}</text:note-citation>",
        escape_xml_text(&citation_for(rctx, kind, &r#ref.id, template.as_ref()))
    );
    let note_body = format!("<text:note-body>{body}</text:note-body>");
    let inner = if template.as_ref().is_some_and(|t| t.body_first) {
        format!("{note_body}{citation}")
    } else {
        format!("{citation}{note_body}")
    };
    Ok(format!(
        "<text:note text:note-class=\"{}\">{inner}</text:note>",
        kind.as_str()
    ))
}
