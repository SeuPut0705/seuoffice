//! Run-level content controls and Zotero fields across paragraphs.

use jscompat::{RegexLimit, js_regex, trim};
use serde::Serialize;

use crate::model::{InlineContentControl, RunZoteroFieldPart};
use crate::props::zotero_inline_field;
use crate::scan::BodyElement;
use crate::sdt::{sdt_meta, sdt_ranges};
use crate::xml_text::{decode_entities, plain_text};

/// `inlineContentControlsOf`: the run-level content controls of a
/// paragraph, read only; a w:sdt holding a paragraph or a table is a block
/// container and not one of them.
pub fn inline_content_controls_of(xml: &str) -> Result<Vec<InlineContentControl>, RegexLimit> {
    let mut out = Vec::new();
    for range in sdt_ranges(xml)? {
        // `xml.slice`: empty where the range is reversed
        let content = xml.get(range.open_end..range.close_start).unwrap_or("");
        if js_regex!(r"<w:p[\s/>]|<w:tbl[\s>]").test(content) {
            continue;
        }
        let meta = sdt_meta(xml.get(range.open_start..range.close_end).unwrap_or(""));
        out.push(InlineContentControl {
            tag: meta.tag,
            title: meta.alias,
            lock: meta.lock,
            id: meta.id,
            text: plain_text(content),
            model_text: None,
        });
    }
    Ok(out)
}

/// `ZoteroFieldParagraph`: a paragraph's place in a Zotero field that spans
/// paragraphs.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ZoteroFieldParagraph {
    pub id: u32,
    pub instruction: String,
    pub part: RunZoteroFieldPart,
}

/// The field open at the current paragraph.
struct OpenField {
    depth: i64,
    instruction: String,
    paragraph_starts: Vec<usize>,
}

/// `crossParagraphZoteroFields`: the complex Zotero fields whose cached
/// result crosses top-level paragraphs, by the start of each paragraph, in
/// the order a `Map` keeps them.
pub fn cross_paragraph_zotero_fields(
    body_elements: &[BodyElement<'_>],
    document_xml: &str,
) -> Vec<(usize, ZoteroFieldParagraph)> {
    let mut result: Vec<(usize, ZoteroFieldParagraph)> = Vec::new();
    let mut next_id = 1;
    let mut active: Option<OpenField> = None;
    let token_re = js_regex!(
        r"<w:fldChar\b[^>]*>|<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>",
        "g"
    );

    for el in body_elements {
        if el.name != "w:p" {
            active = None;
            continue;
        }
        let xml = document_xml.get(el.start..el.end).unwrap_or("");
        if let Some(active) = active.as_mut() {
            active.paragraph_starts.push(el.start);
        }

        for found in token_re.find_iter(xml) {
            let token = found.as_str();
            if token.starts_with("<w:instrText") {
                if let Some(active) = active.as_mut().filter(|active| active.depth == 1) {
                    let text = js_regex!(r"<[^>]+>", "g").replace_all(token, |_| String::new());
                    active.instruction += &decode_entities(&text);
                }
                continue;
            }
            let field_type = js_regex!(r#"\bw:fldCharType\s*=\s*["'](begin|separate|end)["']"#)
                .exec(token)
                .and_then(|found| found.get(1));
            match (field_type, active.as_mut()) {
                (Some("begin"), Some(open)) => open.depth += 1,
                (Some("begin"), None) => {
                    active = Some(OpenField {
                        depth: 1,
                        instruction: String::new(),
                        paragraph_starts: vec![el.start],
                    });
                }
                (Some("end"), Some(open)) => {
                    open.depth -= 1;
                    if open.depth == 0 {
                        // `[...new Set(starts)]`
                        let mut paragraphs: Vec<usize> = Vec::new();
                        for start in &open.paragraph_starts {
                            if !paragraphs.contains(start) {
                                paragraphs.push(*start);
                            }
                        }
                        let instruction = trim(&open.instruction).to_owned();
                        if paragraphs.len() > 1 && zotero_inline_field().test(&instruction) {
                            let id = next_id;
                            next_id += 1;
                            let last = paragraphs.len() - 1;
                            for (index, start) in paragraphs.into_iter().enumerate() {
                                let part = if index == 0 {
                                    RunZoteroFieldPart::Begin
                                } else if index == last {
                                    RunZoteroFieldPart::End
                                } else {
                                    RunZoteroFieldPart::Inside
                                };
                                let field = ZoteroFieldParagraph {
                                    id,
                                    instruction: instruction.clone(),
                                    part,
                                };
                                // `result.set(start, ...)`: a key set again keeps its place
                                match result.iter_mut().find(|(key, _)| *key == start) {
                                    Some((_, value)) => *value = field,
                                    None => result.push((start, field)),
                                }
                            }
                        }
                        active = None;
                    }
                }
                _ => {}
            }
        }
    }
    result
}

/// `attachInlineContentControls`: attach the inline controls of a paragraph block, when it has any.
pub fn attach_inline_content_controls(
    block: &mut crate::model::Block,
    xml: &str,
) -> Result<(), RegexLimit> {
    if block.inline_content_controls.is_some() || !js_regex!(r"^<w:p[\s/>]").test(xml) {
        return Ok(());
    }
    let inline = inline_content_controls_of(xml)?;
    if !inline.is_empty() {
        block.inline_content_controls.set(inline);
    }
    Ok(())
}
