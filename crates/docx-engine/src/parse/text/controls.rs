//! Run-level content controls and Zotero fields across paragraphs.

use std::collections::{HashMap, HashSet};
use std::ops::Deref;

use jscompat::{RegexLimit, js_regex, trim};
use ooxml_xml::XNode;
use serde::Serialize;

use crate::model::{InlineContentControl, RunZoteroFieldPart};
use crate::props::zotero_inline_field;
use crate::scan::BodyElement;
use crate::withheld::{parse_entry, runs_text, withheld_text};
use crate::xml_text::{decode_entities, decode_numeric_char_refs};

/// `inlineContentControlsOf`: the run-level content controls of a
/// paragraph, read only, as the parser finds them (outermost first; markup
/// inside CDATA is text, not a control); a w:sdt holding a paragraph or a table
/// is a block container and not one of them.
pub fn inline_content_controls_of(xml: &str) -> Vec<InlineContentControl> {
    let Some(paragraph) = parse_entry(xml) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    visit_controls(&paragraph, &mut out);
    out
}

fn visit_controls(node: &XNode, out: &mut Vec<InlineContentControl>) {
    let val_of = |sdt_pr: Option<&XNode>, name: &str| -> String {
        sdt_pr
            .and_then(|sdt_pr| sdt_pr.find_child(name))
            .and_then(|child| child.attr("w:val"))
            .unwrap_or("")
            .to_owned()
    };
    for child in node.children() {
        if child.name() == Some("w:sdt")
            && let Some(content) = child.find_child("w:sdtContent")
            // a w:sdt holding a paragraph or a table is a block container, not a
            // run-level control; the body/split paths already report those
            && !holds_block(content)
        {
            let sdt_pr = child.find_child("w:sdtPr");
            out.push(InlineContentControl {
                tag: val_of(sdt_pr, "w:tag"),
                title: val_of(sdt_pr, "w:alias"),
                lock: val_of(sdt_pr, "w:lock"),
                id: val_of(sdt_pr, "w:id"),
                text: control_text(content),
                model_text: withheld_text(content, &control_text),
            });
        }
        visit_controls(child, out);
    }
}

/// `controlText`: an inline control's text, character references decoded as the body's are.
fn control_text(content: &XNode) -> String {
    decode_numeric_char_refs(&runs_text(content)).into_owned()
}

/// `holdsBlock`: whether a subtree holds a paragraph or a table.
fn holds_block(node: &XNode) -> bool {
    node.children()
        .iter()
        .any(|child| matches!(child.name(), Some("w:p" | "w:tbl")) || holds_block(child))
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

/// The `Map<number, ZoteroFieldParagraph>` of `crossParagraphZoteroFields`:
/// the entries in the order a `Map` keeps them (as a slice), and a lookup by
/// the start of a paragraph.
#[derive(Debug, Default)]
pub struct ZoteroFields {
    entries: Vec<(usize, ZoteroFieldParagraph)>,
    /// the place in `entries` of each start
    at: HashMap<usize, usize>,
}

impl ZoteroFields {
    /// `map.get(start)`
    pub fn get(&self, start: usize) -> Option<&ZoteroFieldParagraph> {
        self.at.get(&start).map(|&index| &self.entries[index].1)
    }

    /// `map.set(start, field)`: a key set again keeps its place.
    fn set(&mut self, start: usize, field: ZoteroFieldParagraph) {
        match self.at.get(&start) {
            Some(&index) => self.entries[index].1 = field,
            None => {
                self.at.insert(start, self.entries.len());
                self.entries.push((start, field));
            }
        }
    }
}

impl Deref for ZoteroFields {
    type Target = [(usize, ZoteroFieldParagraph)];

    fn deref(&self) -> &Self::Target {
        &self.entries
    }
}

/// `crossParagraphZoteroFields`: the complex Zotero fields whose cached
/// result crosses top-level paragraphs, by the start of each paragraph.
pub fn cross_paragraph_zotero_fields(
    body_elements: &[BodyElement<'_>],
    document_xml: &str,
) -> ZoteroFields {
    let mut result = ZoteroFields::default();
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
                        let mut seen: HashSet<usize> = HashSet::new();
                        let paragraphs: Vec<usize> = open
                            .paragraph_starts
                            .iter()
                            .copied()
                            .filter(|start| seen.insert(*start))
                            .collect();
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
                                result.set(start, field);
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
pub fn attach_inline_content_controls(block: &mut crate::model::Block, xml: &str) {
    if block.inline_content_controls.is_some() || !js_regex!(r"^<w:p[\s/>]").test(xml) {
        return;
    }
    let inline = inline_content_controls_of(xml);
    if !inline.is_empty() {
        block.inline_content_controls.set(inline);
    }
}
