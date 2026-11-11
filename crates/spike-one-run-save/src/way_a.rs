//! Way A: a mirror of the parsed model (candidate A, SKETCH.rs `docx_engine`).
//!
//! The paragraph is read the way parse.ts reads it: the ordered parser gives
//! a tree, runs keep `rawRPr` (`serializeXNode` of their `w:rPr`, parse.ts:5010)
//! and the text with tabs and breaks as control characters, the paragraph keeps
//! `rawPPr` as an exact slice (`rawPPrOf`). The save is a list of `SaveBlock`s:
//! every block the original slice, the edited one `Generated` from the model,
//! written the way generate.ts writes a paragraph with `rawPPr`.
//!
//! `step` adds what the minimal mirror does not hold, one class at a time; the
//! `// step NAME` ... `// end step NAME` regions are each step's code, counted
//! by `src/bin/loc.rs`. Step 0 is the mirror alone.

use std::ops::Range;
use std::sync::Arc;

use docx_engine::scan::scan_body;
use docx_engine::xml_text::decode_numeric_char_refs;
use ooxml_xml::{XElement, XNode, parse_ordered, serialize};

use crate::container::Docx;
use crate::{RunEdit, escape_text, needs_preserve};

pub const STEP_T_ATTRS: u8 = 1;
pub const STEP_RUN_RAW: u8 = 2;
pub const STEP_WRAPPERS: u8 = 3;
pub const STEP_CONTROLS: u8 = 4;
pub const STEP_ATTRS: u8 = 5;
pub const STEP_PROOF_ERR: u8 = 6;
pub const STEP_MARKS: u8 = 7;
pub const STEP_WHITESPACE: u8 = 8;
pub const LAST_STEP: u8 = 8;

pub const STEP_NAMES: [&str; LAST_STEP as usize + 1] = [
    "minimal mirror",
    "each w:t with its attributes",
    "unknown run children as XML",
    "inline wrappers (hyperlink, ins, sdt, smartTag)",
    "tabs and breaks as written",
    "attributes of w:p and w:r (rsid)",
    "w:proofErr",
    "other paragraph marks (bookmarks, comment ranges)",
    "white space between elements",
];

// == model

#[derive(Clone)]
pub struct XmlSlice {
    pub text: Arc<str>,
    pub range: Range<usize>,
}

impl XmlSlice {
    pub fn as_str(&self) -> &str {
        &self.text[self.range.clone()]
    }
}

pub type Attrs = Vec<(String, String)>;

pub struct GeneratedBlock {
    pub raw_p_pr: Option<XmlSlice>,
    pub content: Vec<Inline>,
    // step ATTRS
    pub attrs: Attrs,
    // end step ATTRS
}

pub enum Inline {
    Run(Run),
    // step PROOF_ERR
    Raw(String),
    // end step PROOF_ERR
    // step WRAPPERS
    Wrapper {
        name: String,
        attrs: Attrs,
        content: Vec<Inline>,
    },
    // end step WRAPPERS
}

pub struct Run {
    pub raw_r_pr: Option<String>,
    pub content: Vec<RunItem>,
    // step ATTRS
    pub attrs: Attrs,
    // end step ATTRS
}

pub enum RunItem {
    /// Run text with tabs and breaks as control characters (`Run.text`).
    Text {
        text: String,
        // step T_ATTRS
        t_attrs: Option<Attrs>,
        // end step T_ATTRS
    },
    // step RUN_RAW
    Raw(String),
    // end step RUN_RAW
}

pub enum SaveBlock {
    Original {
        docx_index: usize,
    },
    Generated {
        block: GeneratedBlock,
        docx_index: Option<usize>,
    },
}

pub struct Document {
    xml: Arc<str>,
    elements: Vec<Range<usize>>,
    inner: Range<usize>,
}

// == reader

const CONTROLS: [(char, &str); 7] = [
    ('\t', "<w:tab/>"),
    ('\n', "<w:br/>"),
    ('\u{c}', "<w:br w:type=\"page\"/>"),
    ('\u{b}', "<w:br w:type=\"column\"/>"),
    ('\u{1e}', "<w:br w:type=\"textWrapping\" w:clear=\"all\"/>"),
    ('\u{2011}', "<w:noBreakHyphen/>"),
    ('\u{ad}', "<w:softHyphen/>"),
];

fn attr<'e>(e: &'e XElement, name: &str) -> Option<&'e str> {
    e.attrs
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn control_of(e: &XElement) -> Option<char> {
    Some(match e.name.as_str() {
        "w:tab" => '\t',
        "w:cr" => '\n',
        "w:noBreakHyphen" => '\u{2011}',
        "w:softHyphen" => '\u{ad}',
        "w:br" => match (attr(e, "w:type"), attr(e, "w:clear")) {
            (Some("page"), _) => '\u{c}',
            (Some("column"), _) => '\u{b}',
            (Some("textWrapping"), Some("all")) => '\u{1e}',
            _ => '\n',
        },
        _ => return None,
    })
}

/// `decodeNumericCharRefs(textOf(child))` of parse.ts:4902: the ordered
/// parser resolves only the named entities.
fn text_of(e: &XElement) -> String {
    let text: String = e
        .children
        .iter()
        .filter_map(|c| match c {
            XNode::Text(t) => Some(t.as_str()),
            XNode::Element(_) => None,
        })
        .collect();
    decode_numeric_char_refs(&text).into_owned()
}

fn holds_run(e: &XElement) -> bool {
    e.children.iter().any(|c| match c {
        XNode::Element(child) => child.name == "w:r" || holds_run(child),
        XNode::Text(_) => false,
    })
}

/// `rawPPrOf` of parse-props.ts: the exact `w:pPr` slice when it is the
/// first child, depth-aware because `w:pPrChange` nests another `w:pPr`.
fn raw_p_pr_of(xml: &str) -> Option<Range<usize>> {
    let open_end = xml.find('>')? + 1;
    let start = open_end + (xml[open_end..].len() - xml[open_end..].trim_start().len());
    if !xml[start..].starts_with("<w:pPr") {
        return None;
    }
    let mut depth = 0usize;
    let mut at = start;
    while let Some(found) = xml[at..]
        .find("<w:pPr")
        .into_iter()
        .chain(xml[at..].find("</w:pPr>"))
        .min()
    {
        let pos = at + found;
        if xml[pos..].starts_with("</w:pPr>") {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(start..pos + "</w:pPr>".len());
            }
            at = pos + "</w:pPr>".len();
            continue;
        }
        let next = xml.as_bytes().get(pos + 6).copied();
        at = pos + 6;
        if !matches!(next, Some(b' ' | b'\t' | b'\n' | b'\r' | b'/' | b'>')) {
            continue;
        }
        let gt = pos + xml[pos..].find('>')?;
        if xml.as_bytes()[gt - 1] == b'/' {
            if depth == 0 {
                return Some(start..gt + 1);
            }
            continue;
        }
        depth += 1;
    }
    None
}

fn read_run(e: &XElement, step: u8) -> Run {
    let mut content: Vec<RunItem> = Vec::new();
    let mut raw_r_pr = None;
    for child in &e.children {
        let XNode::Element(c) = child else { continue };
        if c.name == "w:rPr" {
            raw_r_pr = Some(serialize(child));
        } else if c.name == "w:t" {
            push_text(&mut content, text_of(c), Some(c), step);
        // step CONTROLS
        } else if step >= STEP_CONTROLS && control_of(c).is_some() {
            content.push(RunItem::Raw(serialize(child)));
        // end step CONTROLS
        } else if let Some(ch) = control_of(c) {
            push_text(&mut content, ch.to_string(), None, step);
        // step RUN_RAW
        } else if step >= STEP_RUN_RAW {
            content.push(RunItem::Raw(serialize(child)));
            // end step RUN_RAW
        }
    }
    Run {
        raw_r_pr,
        content,
        // step ATTRS
        attrs: if step >= STEP_ATTRS {
            e.attrs.clone()
        } else {
            Vec::new()
        },
        // end step ATTRS
    }
}

fn push_text(content: &mut Vec<RunItem>, text: String, t: Option<&XElement>, step: u8) {
    // step T_ATTRS
    if step >= STEP_T_ATTRS {
        let t_attrs = t.map(|t| t.attrs.clone());
        content.push(RunItem::Text { text, t_attrs });
        return;
    }
    // end step T_ATTRS
    if let Some(RunItem::Text { text: run_text, .. }) = content.first_mut() {
        run_text.push_str(&text);
    } else {
        content.insert(
            0,
            RunItem::Text {
                text,
                t_attrs: None,
            },
        );
    }
}

fn read_inlines(children: &[XNode], step: u8, out: &mut Vec<Inline>) {
    for node in children {
        let e = match node {
            XNode::Element(e) => e,
            // step WHITESPACE
            XNode::Text(t) if step >= STEP_WHITESPACE => {
                let mut raw = String::new();
                escape_text(t, &mut raw);
                out.push(Inline::Raw(raw));
                continue;
            }
            // end step WHITESPACE
            XNode::Text(_) => continue,
        };
        if e.name == "w:pPr" {
            // held as the rawPPr slice
        } else if e.name == "w:r" {
            out.push(Inline::Run(read_run(e, step)));
        } else if holds_run(e) {
            // step WRAPPERS
            if step >= STEP_WRAPPERS {
                let mut content = Vec::new();
                read_inlines(&e.children, step, &mut content);
                out.push(Inline::Wrapper {
                    name: e.name.clone(),
                    attrs: e.attrs.clone(),
                    content,
                });
                continue;
            }
            // end step WRAPPERS
            read_inlines(&e.children, step, out);
        // step PROOF_ERR
        } else if step >= STEP_PROOF_ERR && e.name == "w:proofErr" {
            out.push(Inline::Raw(serialize(node)));
        // end step PROOF_ERR
        // step MARKS
        } else if step >= STEP_MARKS {
            out.push(Inline::Raw(serialize(node)));
            // end step MARKS
        }
    }
}

impl Document {
    pub fn open(xml: &str) -> Result<Self, String> {
        let scan = scan_body(xml).map_err(|e| e.to_string())?;
        let elements = scan.elements.iter().map(|e| e.start..e.end).collect();
        let inner = scan.inner_start..scan.inner_end;
        Ok(Self {
            xml: xml.into(),
            elements,
            inner,
        })
    }

    pub fn paragraph(&self, docx_index: usize, step: u8) -> Result<GeneratedBlock, String> {
        let range = self
            .elements
            .get(docx_index)
            .ok_or("no such block")?
            .clone();
        let source = &self.xml[range.clone()];
        let nodes = parse_ordered(source, 100).map_err(|e| e.to_string())?;
        let Some(XNode::Element(p)) = nodes.iter().find(|n| matches!(n, XNode::Element(_))) else {
            return Err("no element".to_owned());
        };
        if p.name != "w:p" {
            return Err(format!("{} is not a paragraph", p.name));
        }
        let mut content = Vec::new();
        read_inlines(&p.children, step, &mut content);
        Ok(GeneratedBlock {
            raw_p_pr: raw_p_pr_of(source).map(|r| XmlSlice {
                text: self.xml.clone(),
                range: range.start + r.start..range.start + r.end,
            }),
            content,
            // step ATTRS
            attrs: if step >= STEP_ATTRS {
                p.attrs.clone()
            } else {
                Vec::new()
            },
            // end step ATTRS
        })
    }
}

// == writer

fn push_attrs(attrs: &[(String, String)], out: &mut String) {
    for (name, value) in attrs {
        out.push(' ');
        out.push_str(name);
        out.push_str("=\"");
        for ch in value.chars() {
            match ch {
                '"' => out.push_str("&quot;"),
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                _ => out.push(ch),
            }
        }
        out.push('"');
    }
}

fn write_text(text: &str, t_attrs: Option<&Attrs>, out: &mut String) {
    let mut buffer = String::new();
    let flush = |buffer: &mut String, out: &mut String| {
        if buffer.is_empty() {
            return;
        }
        out.push_str("<w:t");
        // step T_ATTRS
        if let Some(attrs) = t_attrs {
            push_attrs(attrs, out);
            if needs_preserve(buffer) && !attrs.iter().any(|(k, _)| k == "xml:space") {
                out.push_str(" xml:space=\"preserve\"");
            }
            out.push('>');
            escape_text(buffer, out);
            out.push_str("</w:t>");
            buffer.clear();
            return;
        }
        // end step T_ATTRS
        out.push_str(" xml:space=\"preserve\">");
        escape_text(buffer, out);
        out.push_str("</w:t>");
        buffer.clear();
    };
    for ch in text.chars() {
        match CONTROLS.iter().find(|(c, _)| *c == ch) {
            Some((_, xml)) => {
                flush(&mut buffer, out);
                out.push_str(xml);
            }
            None => buffer.push(ch),
        }
    }
    flush(&mut buffer, out);
}

fn write_run(run: &Run, out: &mut String) {
    out.push_str("<w:r");
    // step ATTRS
    push_attrs(&run.attrs, out);
    // end step ATTRS
    out.push('>');
    if let Some(r_pr) = &run.raw_r_pr {
        out.push_str(r_pr);
    }
    for item in &run.content {
        match item {
            RunItem::Text { text, t_attrs } => write_text(text, t_attrs.as_ref(), out),
            // step RUN_RAW
            RunItem::Raw(xml) => out.push_str(xml),
            // end step RUN_RAW
        }
    }
    out.push_str("</w:r>");
}

fn write_inlines(content: &[Inline], out: &mut String) {
    for inline in content {
        match inline {
            Inline::Run(run) => write_run(run, out),
            // step PROOF_ERR
            Inline::Raw(xml) => out.push_str(xml),
            // end step PROOF_ERR
            // step WRAPPERS
            Inline::Wrapper {
                name,
                attrs,
                content,
            } => {
                out.push('<');
                out.push_str(name);
                push_attrs(attrs, out);
                out.push('>');
                write_inlines(content, out);
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            } // end step WRAPPERS
        }
    }
}

/// generateParagraphXml with `rawPPr` set (generate.ts:2278).
pub fn generate_paragraph_xml(block: &GeneratedBlock, out: &mut String) {
    out.push_str("<w:p");
    // step ATTRS
    push_attrs(&block.attrs, out);
    // end step ATTRS
    out.push('>');
    if let Some(p_pr) = &block.raw_p_pr {
        out.push_str(p_pr.as_str());
    }
    write_inlines(&block.content, out);
    out.push_str("</w:p>");
}

impl Document {
    /// The main part from save blocks: original slices copied, generated
    /// blocks written from the model, the bytes between blocks kept.
    pub fn save_xml(&self, blocks: &[SaveBlock]) -> String {
        let xml = &*self.xml;
        let mut out = String::with_capacity(xml.len() + 256);
        out.push_str(&xml[..self.inner.start]);
        let mut previous_end: Option<usize> = None;
        for block in blocks {
            let index = match block {
                SaveBlock::Original { docx_index } => Some(*docx_index),
                SaveBlock::Generated { docx_index, .. } => *docx_index,
            };
            if let (Some(end), Some(range)) =
                (previous_end, index.and_then(|i| self.elements.get(i)))
                && end <= range.start
            {
                out.push_str(&xml[end..range.start]);
            }
            previous_end = index.and_then(|i| self.elements.get(i)).map(|r| r.end);
            match block {
                SaveBlock::Original { docx_index } => {
                    out.push_str(&xml[self.elements[*docx_index].clone()])
                }
                SaveBlock::Generated { block, .. } => generate_paragraph_xml(block, &mut out),
            }
        }
        out.push_str(&xml[self.inner.end..]);
        out
    }
}

// == edit

fn run_at<'b>(content: &'b mut [Inline], index: &mut usize) -> Option<&'b mut Run> {
    for inline in content {
        match inline {
            Inline::Run(run) => {
                if *index == 0 {
                    return Some(run);
                }
                *index -= 1;
            }
            // step WRAPPERS
            Inline::Wrapper { content, .. } => {
                if let Some(run) = run_at(content, index) {
                    return Some(run);
                }
            }
            // end step WRAPPERS
            // step PROOF_ERR
            Inline::Raw(_) => {} // end step PROOF_ERR
        }
    }
    None
}

/// The run's text without its tabs and breaks becomes `text`.
pub fn set_run_text(block: &mut GeneratedBlock, run: usize, text: &str) -> Result<(), String> {
    let mut index = run;
    let run = run_at(&mut block.content, &mut index).ok_or("no such run")?;
    let is_text = |c: char| !CONTROLS.iter().any(|(k, _)| *k == c);
    for item in &mut run.content {
        let RunItem::Text { text: run_text, .. } = item else {
            continue;
        };
        let Some(first) = run_text.find(is_text) else {
            continue;
        };
        let last = run_text.rfind(is_text).unwrap_or(first);
        let end = last + run_text[last..].chars().next().map_or(0, char::len_utf8);
        run_text.replace_range(first..end, text);
        return Ok(());
    }
    Err("run has no text".to_owned())
}

pub fn edit_xml(xml: &str, edit: &RunEdit<'_>, step: u8) -> Result<String, String> {
    let doc = Document::open(xml)?;
    let mut block = doc.paragraph(edit.paragraph, step)?;
    set_run_text(&mut block, edit.run, edit.text)?;
    let mut generated = Some(block);
    let blocks: Vec<SaveBlock> = (0..doc.elements.len())
        .map(|i| match generated.take_if(|_| i == edit.paragraph) {
            Some(block) => SaveBlock::Generated {
                block,
                docx_index: Some(i),
            },
            None => SaveBlock::Original { docx_index: i },
        })
        .collect();
    Ok(doc.save_xml(&blocks))
}

pub fn save_with_edit(docx: &Docx<'_>, edit: &RunEdit<'_>, step: u8) -> Result<Vec<u8>, String> {
    docx.save(&edit_xml(&docx.xml, edit, step)?)
}
