//! `text.ts`: the plain text of a chapter in reading order, for attachments and
//! the MCP `read` tool. Headings are prefixed with `#` by level, blocks are
//! separated by a blank line, `br` is a line break and table cells are
//! tab-separated. A chapter that is not well-formed XML is read with an HTML
//! parser instead: the host's parse5, whose `roots` (what `extractChapterText`
//! builds from `parse(source).childNodes`) the step `epub.chapterTextRoots`
//! answers.

use jscompat::trim;
use serde_json::{Value, json};

use crate::utf16::{lossy, units};
use crate::xml::host_thrown;
use crate::xml_positions::parse_xml;
use crate::xml_positions_types::{
    ElementId, MAX_DEPTH, Thrown, XmlDocument, XmlNode as PositionNode, XmlParseResult, deeper,
};

enum TextNode {
    Element {
        name: String,
        children: Vec<TextNode>,
    },
    Text(String),
}

/// `SKIP`
fn is_skipped(name: &str) -> bool {
    matches!(
        name,
        "head" | "script" | "style" | "template" | "rt" | "rp" | "svg" | "math" | "noscript"
    )
}

/// `BLOCKS`
fn is_block(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "caption"
            | "dd"
            | "details"
            | "dialog"
            | "div"
            | "dl"
            | "dt"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "footer"
            | "form"
            | "header"
            | "hgroup"
            | "hr"
            | "legend"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "summary"
            | "table"
            | "tbody"
            | "tfoot"
            | "thead"
            | "tr"
            | "ul"
    )
}

/// `HEADING.exec(name)`: the level of `h1` to `h6`.
fn heading_level(name: &str) -> Option<usize> {
    match name.as_bytes() {
        [b'h', digit @ b'1'..=b'6'] => Some(usize::from(digit - b'0')),
        _ => None,
    }
}

/// `fromXml` over the nodes of a parse with positions.
fn from_xml(doc: &XmlDocument, id: ElementId, depth: usize) -> Result<TextNode, Thrown> {
    let depth = deeper(depth)?;
    let element = doc.element(id);
    let mut children = Vec::new();
    for node in &element.children {
        match node {
            PositionNode::Text(text) => children.push(TextNode::Text(lossy(&text.value))),
            PositionNode::Element(child) => children.push(from_xml(doc, *child, depth)?),
            PositionNode::Other(_) => {}
        }
    }
    Ok(TextNode::Element {
        name: element.local.clone(),
        children,
    })
}

/// The `roots` the host's `epub.chapterTextRoots` answers, written flat so
/// that no nesting reaches JSON: `{ elements: [{ name, children }], roots }`,
/// the elements in document order and a child either a string or
/// `{ element: id }`.
fn roots_from_flat(value: &Value) -> Result<Vec<TextNode>, String> {
    let listed = value
        .get("elements")
        .and_then(Value::as_array)
        .ok_or("the roots have no elements")?;
    let mut built: Vec<Option<(TextNode, usize)>> = (0..listed.len()).map(|_| None).collect();
    // a node of the tree is made of the nodes listed below it
    let take = |built: &mut Vec<Option<(TextNode, usize)>>,
                list: &Value,
                after: usize|
     -> Result<(Vec<TextNode>, usize), String> {
        let mut children = Vec::new();
        let mut height = 0;
        for child in list.as_array().ok_or("children is not a list")? {
            if let Some(text) = child.as_str() {
                children.push(TextNode::Text(text.to_owned()));
                continue;
            }
            let at = child
                .get("element")
                .and_then(Value::as_u64)
                .and_then(|at| usize::try_from(at).ok())
                .filter(|&at| at >= after && at < built.len())
                .ok_or("a child is neither text nor a later element")?;
            let (element, below) = built[at].take().ok_or("an element has two parents")?;
            height = height.max(below);
            children.push(element);
        }
        Ok((children, height))
    };
    for (id, item) in listed.iter().enumerate().rev() {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .ok_or("name is not a string")?
            .to_owned();
        let (children, height) = take(
            &mut built,
            item.get("children").ok_or("an element has no children")?,
            id + 1,
        )?;
        if height >= MAX_DEPTH {
            return Err(format!("the roots are nested more than {MAX_DEPTH} deep"));
        }
        built[id] = Some((TextNode::Element { name, children }, height + 1));
    }
    let (roots, _) = take(
        &mut built,
        value.get("roots").ok_or("the answer has no roots")?,
        0,
    )?;
    Ok(roots)
}

/// `findBody`: the children of the first `body` in document order.
fn find_body(nodes: &[TextNode]) -> Option<&[TextNode]> {
    for node in nodes {
        let TextNode::Element { name, children } = node else {
            continue;
        };
        if name == "body" {
            return Some(children);
        }
        if let Some(inner) = find_body(children) {
            return Some(inner);
        }
    }
    None
}

#[derive(Default)]
struct TextCollector {
    blocks: Vec<String>,
    current: String,
    pre: u32,
}

impl TextCollector {
    fn flush(&mut self, prefix: &str) {
        let current = std::mem::take(&mut self.current);
        let text = if self.pre > 0 {
            current
        } else {
            current
                .split('\n')
                .map(|line| line.trim_matches(' '))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let text = text.trim_matches('\n');
        if !trim(text).is_empty() {
            self.blocks.push(format!("{prefix}{text}"));
        }
    }

    fn walk(&mut self, nodes: &[TextNode]) {
        for node in nodes {
            let (name, children) = match node {
                TextNode::Text(value) => {
                    if self.pre > 0 {
                        self.current.push_str(value);
                    } else {
                        let mut in_run = false;
                        for c in value.chars() {
                            if matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}') {
                                if !in_run {
                                    self.current.push(' ');
                                }
                                in_run = true;
                            } else {
                                self.current.push(c);
                                in_run = false;
                            }
                        }
                    }
                    continue;
                }
                TextNode::Element { name, children } => (name.as_str(), children),
            };
            if is_skipped(name) {
                continue;
            }
            if name == "br" {
                self.current.push('\n');
                continue;
            }
            if name == "td" || name == "th" {
                if !trim(&self.current).is_empty() {
                    self.current.push('\t');
                }
                self.walk(children);
                continue;
            }
            if let Some(level) = heading_level(name) {
                self.flush("");
                self.walk(children);
                self.flush(&format!("{} ", "#".repeat(level)));
                continue;
            }
            if !is_block(name) {
                self.walk(children);
                continue;
            }
            self.flush("");
            if name == "pre" {
                self.pre += 1;
            }
            self.walk(children);
            self.flush("");
            if name == "pre" {
                self.pre -= 1;
            }
        }
    }
}

/// `extractChapterText`: the chapter's text in reading order, headings as `#`
/// lines. `Err` is what the TypeScript throws: the host's, or the stack
/// overflow of a nesting deeper than `MAX_DEPTH`.
pub fn extract_chapter_text(source: &str) -> Result<String, Thrown> {
    let roots = match parse_xml(&units(source)) {
        XmlParseResult::Ok(doc) => vec![from_xml(&doc, doc.root, 0)?],
        XmlParseResult::Err { .. } => {
            let answer = seu_host::call("epub.chapterTextRoots", &json!({ "text": source }))
                .map_err(host_thrown)?;
            roots_from_flat(&answer).map_err(|message| {
                if message.starts_with("the roots are nested") {
                    Thrown::stack_overflow()
                } else {
                    Thrown::new("HostProtocolError", message)
                }
            })?
        }
    };
    let mut collector = TextCollector::default();
    collector.walk(find_body(&roots).unwrap_or(roots.as_slice()));
    collector.flush("");
    Ok(collector.blocks.join("\n\n"))
}
