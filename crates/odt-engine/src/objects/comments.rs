//! `objects/comments.ts`: existing comments (`office:annotation` ...
//! `office:annotation-end`).
//!
//! Forward: each annotation becomes a real docx comment (word/comments.xml,
//! plain text) anchored by `w:commentRangeStart`/`w:commentRangeEnd` over the
//! commented text, which stays ordinary editable text. An annotation without
//! an end is anchored by its reference alone.
//!
//! Save: the comment's own bytes are kept; its start and end are re-placed on
//! the edited text, over the runs the editor still marks with the comment when
//! the range lives in one paragraph, else at the mapped offsets of the
//! original positions. When all commented text was deleted (or the editor
//! dropped the comment) the comment is deleted. New comments and comment edits
//! are not saved into an ODT (the editor disables them); a new comment that
//! arrives anyway is dropped with a warning.
//!
//! Offsets into an edited paragraph are UTF-8 byte offsets, as in the text
//! layer; the offsets the records hold are `U16`.

use jscompat::{JsMap, js_regex, trim};
use std::collections::HashSet;

use crate::core::body::pair_annotations;
use crate::core::convert::{
    Attach, EditedParagraph, Injection, InlineConverter, InlineElement, InlineEnv, InlineOoxml,
    MapBias, OdfToOoxmlContext, OoxmlToOdfContext, ParagraphInjector, ParagraphWriteEnv,
};
use crate::core::errors::OdtError;
use crate::core::styles::OdtStylePart;
use crate::core::xml::{ElementRange, attribute_map, escape_xml_attr, escape_xml_text};
use crate::offset::{U16, u16_len};
use crate::text::paragraph_model::{ReadParagraphOptions, ReadParagraphSource, read_paragraph};

use super::analyze::{plain_text_of, sub_elements};
use super::model::{OBJECTS_OWNER, ObjectComment};
use super::state::{append_to_lazy_part, forward_state, lazy_part, save_state, source_of};

/// `COMMENTS_TYPE`
const COMMENTS_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
/// `COMMENTS_REL`
const COMMENTS_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";

/// `annotationInlineConverter`
pub struct AnnotationInlineConverter;

impl InlineConverter for AnnotationInlineConverter {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn names(&self) -> &[&'static str] {
        &["office:annotation"]
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        el: &InlineElement,
        env: &InlineEnv,
    ) -> Result<Option<InlineOoxml>, OdtError> {
        if el.part != OdtStylePart::ContentXml {
            return Ok(None);
        }
        let st = forward_state(ctx);
        if st.borrow().nested > 0 {
            return Ok(None);
        }
        if st.borrow().annotation_ends.is_none() {
            let mut ends = std::collections::HashMap::new();
            for pair in pair_annotations(&ctx.doc.body) {
                if let Some(end) = &pair.end {
                    ends.insert(pair.annotation.start, (end.start, end.end));
                }
            }
            st.borrow_mut().annotation_ends = Some(ends);
        }
        let info = ctx.part(el.part);
        let xml = &info.xml.text;
        let attrs = attribute_map(xml, el.name_end, el.open_end, &info.prefixes);
        let subs = if el.close_start > el.open_end {
            sub_elements(xml, &info.prefixes, el.open_end, el.close_start)
        } else {
            Vec::new()
        };
        let top: Vec<_> = subs.iter().filter(|s| s.depth == 0).collect();
        let text_of = |name: &str| -> String {
            match top.iter().find(|x| x.name == name) {
                Some(s) => trim(&plain_text_of(
                    xml,
                    &info.prefixes,
                    s.open_end,
                    s.close_start,
                ))
                .to_string(),
                None => String::new(),
            }
        };
        let author = text_of("dc:creator");
        let date = text_of("dc:date");
        let doc = ctx.doc.clone();
        let source = ReadParagraphSource {
            info: &info,
            styles: &doc.styles,
        };
        let mut paragraphs: Vec<String> = Vec::new();
        for s in top
            .iter()
            .filter(|s| s.name == "text:p" || s.name == "text:h")
        {
            let model = read_paragraph(
                &source,
                ElementRange {
                    start: s.start,
                    open_end: s.open_end,
                    close_start: s.close_start,
                    end: s.end,
                    self_closing: s.self_closing,
                },
                ReadParagraphOptions::default(),
            )?;
            paragraphs.push(model.text);
        }
        let id = {
            let mut st = st.borrow_mut();
            let id = st.comment_seq.to_string();
            st.comment_seq += 1;
            id
        };
        let end = st
            .borrow()
            .annotation_ends
            .as_ref()
            .and_then(|ends| ends.get(&el.start).copied());
        let record = ObjectComment {
            id: id.clone(),
            name: attrs.get("office:name").cloned(),
            start: info.xml.to_u16(el.start),
            end: info.xml.to_u16(el.end),
            end_start: end.map(|e| info.xml.to_u16(e.0)),
            end_end: end.map(|e| info.xml.to_u16(e.1)),
            paragraph: env.paragraph_id,
            offset: env.offset,
            end_paragraph: None,
            end_offset: None,
            ranged: false,
            text: paragraphs.join("\n"),
        };
        {
            let mut st = st.borrow_mut();
            st.ext.comments.push(record);
            let at = st.ext.comments.len() - 1;
            if let Some(end) = end {
                st.comment_by_end.insert(end.0, at);
            }
        }
        let date_attr = js_regex!(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d")
            .exec(&date)
            .map(|m| m.as_str().to_string());
        let shown: Vec<&str> = if paragraphs.is_empty() {
            vec![""]
        } else {
            paragraphs.iter().map(String::as_str).collect()
        };
        let paras: Vec<String> = shown
            .iter()
            .map(|t| {
                if t.is_empty() {
                    "<w:p/>".to_string()
                } else {
                    format!(
                        "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                        escape_xml_text(t)
                    )
                }
            })
            .collect();
        let comment = format!(
            "<w:comment w:id=\"{id}\" w:author=\"{}\"{}{}>{}</w:comment>",
            escape_xml_attr(&author),
            match &date_attr {
                Some(date) => format!(" w:date=\"{date}\""),
                None => String::new(),
            },
            // `[...author][0]`: the first code point
            match author.chars().next() {
                Some(first) => format!(" w:initials=\"{}\"", escape_xml_attr(&first.to_string())),
                None => String::new(),
            },
            paras.join("")
        );
        lazy_part(
            ctx,
            "word/comments.xml",
            COMMENTS_TYPE,
            COMMENTS_REL,
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<w:comments xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"></w:comments>".to_string(),
        );
        append_to_lazy_part(ctx, "word/comments.xml", "</w:comments>", &comment);
        Ok(Some(InlineOoxml::Xml {
            xml: if end.is_some() {
                format!("<w:commentRangeStart w:id=\"{id}\"/>")
            } else {
                format!("<w:r><w:commentReference w:id=\"{id}\"/></w:r>")
            },
            text: String::new(),
        }))
    }
}

/// `annotationEndInlineConverter`
pub struct AnnotationEndInlineConverter;

impl InlineConverter for AnnotationEndInlineConverter {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn names(&self) -> &[&'static str] {
        &["office:annotation-end"]
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        el: &InlineElement,
        env: &InlineEnv,
    ) -> Result<Option<InlineOoxml>, OdtError> {
        if el.part != OdtStylePart::ContentXml {
            return Ok(None);
        }
        let st = forward_state(ctx);
        if st.borrow().nested > 0 {
            return Ok(None);
        }
        let mut st = st.borrow_mut();
        let Some(&at) = st.comment_by_end.get(&el.start) else {
            return Ok(None);
        };
        let record = &mut st.ext.comments[at];
        record.end_paragraph = Some(env.paragraph_id);
        record.end_offset = Some(env.offset);
        record.ranged = !(record.paragraph == env.paragraph_id && record.offset == env.offset);
        Ok(Some(InlineOoxml::Xml {
            xml: format!(
                "<w:commentRangeEnd w:id=\"{id}\"/><w:r><w:commentReference w:id=\"{id}\"/></w:r>",
                id = record.id
            ),
            text: String::new(),
        }))
    }
}

// ---------------------------------------------------------------------------
// Save

/// `survivingComments`: comment ids the edited body still marks anywhere
/// (ranges or references).
fn surviving_comments(rctx: &OoxmlToOdfContext) -> Result<HashSet<String>, OdtError> {
    let st = save_state(rctx)?;
    if let Some(found) = st.borrow().surviving.clone() {
        return Ok(found);
    }
    let mut ids: HashSet<String> = HashSet::new();
    let re = js_regex!(
        r#"<w:comment(?:RangeStart|RangeEnd|Reference)\b[^>]*\bw:id\s*=\s*"([^"]+)""#,
        "g"
    );
    for b in rctx.edited.blocks.iter() {
        let original = b
            .original_xml
            .as_ref()
            .and_then(|x| x.as_deref())
            .unwrap_or("");
        for m in re.find_iter(original) {
            ids.insert(m.get(1).unwrap_or("").to_string());
        }
        for r in b.runs.as_deref().unwrap_or_default() {
            for id in r.comment_ids.as_deref().unwrap_or_default() {
                ids.insert(id.clone());
            }
        }
    }
    st.borrow_mut().surviving = Some(ids.clone());
    Ok(ids)
}

/// `isDeleted`: the comment was deleted: the editor dropped it, or all text of
/// a range within one paragraph is gone. A range across paragraphs lives on
/// while its paragraphs do (the editor keeps no position for its ends).
fn is_deleted(rctx: &OoxmlToOdfContext, c: &ObjectComment) -> Result<bool, OdtError> {
    if !rctx.edited.comments.iter().any(|x| x.id == c.id) {
        return Ok(true);
    }
    Ok(c.ranged
        && c.end_paragraph == Some(c.paragraph)
        && !surviving_comments(rctx)?.contains(&c.id))
}

/// `startKept`: the start of the paragraph holding a comment's annotation
/// survived (as it was, or rewritten).
fn start_kept(rctx: &OoxmlToOdfContext, c: &ObjectComment) -> Result<bool, OdtError> {
    let st = save_state(rctx)?;
    if st.borrow().comment_started.contains(&c.id) {
        return Ok(true);
    }
    let element = rctx
        .map
        .elements
        .iter()
        .find(|e| e.paragraph == Some(c.paragraph));
    Ok(match element {
        Some(element) => rctx.matched.contains(&element.id),
        None => true,
    })
}

/// `commentInjector`
pub struct CommentInjector;

impl ParagraphInjector for CommentInjector {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn inject(
        &self,
        rctx: &mut OoxmlToOdfContext,
        para: &EditedParagraph,
        env: &ParagraphWriteEnv<'_>,
    ) -> Result<Vec<Injection>, OdtError> {
        let st = save_state(rctx)?;
        let mut out: Vec<Injection> = Vec::new();
        // where the editor still marks each comment in this paragraph
        let mut marked: JsMap<(U16, U16)> = JsMap::new();
        let mut offset = 0u32;
        for run in &para.runs {
            let length = run.text.as_deref().map_or(0, |t| u16_len(t).0);
            for id in run.comment_ids.as_deref().unwrap_or_default() {
                match marked.get_mut(id) {
                    Some(r) => r.1 = U16(offset + length),
                    None => marked.set(id.clone(), (U16(offset), U16(offset + length))),
                }
            }
            offset += length;
        }
        for id in marked.keys() {
            if !st.borrow().comments.has(id) {
                rctx.warn("dropped a new comment: ODT documents keep only their own comments");
            }
        }
        if st.borrow().comments.is_empty() {
            return Ok(out);
        }
        let origin = env.origin.as_ref();
        let all: Vec<ObjectComment> = {
            let st = st.borrow();
            st.comments
                .values()
                .map(|&at| st.ext.comments[at].clone())
                .collect()
        };
        for c in &all {
            let start = |rctx: &OoxmlToOdfContext, out: &mut Vec<Injection>, at: U16| {
                out.push(Injection {
                    offset: at,
                    xml: source_of(rctx, OdtStylePart::ContentXml, c.start, c.end),
                    attach: Some(Attach::Next),
                });
                st.borrow_mut().comment_started.insert(c.id.clone());
            };
            let end = |rctx: &OoxmlToOdfContext, out: &mut Vec<Injection>, at: U16| {
                let (Some(end_start), Some(end_end)) = (c.end_start, c.end_end) else {
                    return;
                };
                out.push(Injection {
                    offset: at,
                    xml: source_of(rctx, OdtStylePart::ContentXml, end_start, end_end),
                    attach: Some(Attach::Prev),
                });
                st.borrow_mut().comment_done.insert(c.id.clone());
            };
            let own_start = origin.is_some_and(|o| c.paragraph == o.id);
            let own_end = origin.is_some_and(|o| c.end_paragraph == Some(o.id));
            let here = marked.get(&c.id).copied();
            if !own_start && !own_end && here.is_none() {
                continue;
            }
            if is_deleted(rctx, c)? {
                continue;
            }
            let one_paragraph = c.end_paragraph == Some(c.paragraph);
            if c.ranged && one_paragraph {
                // the comment goes where the editor still marks it (the first such paragraph)
                if let Some(here) = here
                    && !st.borrow().comment_started.contains(&c.id)
                {
                    start(rctx, &mut out, here.0);
                    end(rctx, &mut out, here.1);
                }
                continue;
            }
            if own_start && !st.borrow().comment_started.contains(&c.id) {
                start(rctx, &mut out, env.map_offset(c.offset, MapBias::Start));
            }
            if own_end
                && !one_paragraph
                && !st.borrow().comment_done.contains(&c.id)
                && let Some(end_offset) = c.end_offset
            {
                if start_kept(rctx, c)? {
                    end(rctx, &mut out, env.map_offset(end_offset, MapBias::End));
                } else {
                    rctx.warn("a comment whose start was deleted lost its end too");
                }
            }
        }
        Ok(out)
    }
}
