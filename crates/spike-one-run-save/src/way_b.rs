//! Way B: nodes that carry their source span and a provenance state
//! (candidate B, SKETCH.rs `docx::Node`, `State`, `write::emit`).
//!
//! A clean node is written by copying its source bytes, a touched node writes
//! its own tags from the source and recurses, a dirty node is written from its
//! value. The minimal model types only what the edit reaches: body items,
//! paragraphs, runs, run text. Every other element is a node with a span and
//! no value (`Opaque`), or a `Container` of inline nodes when it may hold runs.

use std::ops::Range;

use docx_engine::scan::scan_body;
use docx_engine::xml_text::decode_entities;
use ooxml_xml::{Tag, opaque_end, tag_at};

use crate::container::Docx;
use crate::{RunEdit, escape_text, needs_preserve};

// == model

/// Whole element, end of its start tag, start of its end tag.
#[derive(Clone, Debug)]
pub struct Src {
    pub outer: Range<usize>,
    pub open_end: usize,
    pub close_start: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Clean,
    Touched,
    Dirty,
}

pub struct Node<T> {
    src: Src,
    state: State,
    val: T,
}

pub enum BodyItem {
    Paragraph(Vec<Node<Inline>>),
    Opaque,
}

pub enum Inline {
    Run(Vec<Node<RunContent>>),
    Container(Vec<Node<Inline>>),
    Opaque,
}

pub enum RunContent {
    Text(String),
    Opaque,
}

pub struct Document<'x> {
    xml: &'x str,
    body: Node<Vec<Node<BodyItem>>>,
}

// == reader

struct Reader<'x> {
    xml: &'x str,
    at: usize,
}

impl<'x> Reader<'x> {
    /// The next tag, skipping text, comments, CDATA and processing instructions.
    fn next_tag(&mut self) -> Option<Tag<'x>> {
        loop {
            let start = self.at + self.xml[self.at..].find('<')?;
            if let Some(end) = opaque_end(self.xml, start) {
                self.at = end;
                continue;
            }
            let tag = tag_at(self.xml, start);
            self.at = tag.end;
            return Some(tag);
        }
    }

    /// Children of `open` read by `child` until the closing tag; the span of `open`.
    fn element<T>(
        &mut self,
        open: Tag<'x>,
        mut child: impl FnMut(&mut Self, Tag<'x>) -> Result<Node<T>, String>,
    ) -> Result<(Vec<Node<T>>, Src), String> {
        let mut children = Vec::new();
        if open.self_closing {
            let src = Src {
                outer: open.start..open.end,
                open_end: open.end,
                close_start: open.start,
            };
            return Ok((children, src));
        }
        loop {
            let tag = self
                .next_tag()
                .ok_or_else(|| format!("<{}> is not closed", open.name))?;
            if tag.closing {
                let src = Src {
                    outer: open.start..tag.end,
                    open_end: open.end,
                    close_start: tag.start,
                };
                return Ok((children, src));
            }
            children.push(child(self, tag)?);
        }
    }

    /// An element skipped without recursion: table XML nests thousands deep.
    fn opaque<T>(&mut self, open: Tag<'x>, val: T) -> Result<Node<T>, String> {
        let mut depth = usize::from(!open.self_closing);
        let mut close = open;
        while depth > 0 {
            close = self
                .next_tag()
                .ok_or_else(|| format!("<{}> is not closed", open.name))?;
            if close.closing {
                depth -= 1;
            } else if !close.self_closing {
                depth += 1;
            }
        }
        let src = Src {
            outer: open.start..close.end,
            open_end: open.end,
            close_start: close.start.max(open.end),
        };
        Ok(Node {
            src,
            state: State::Clean,
            val,
        })
    }

    fn inline(&mut self, open: Tag<'x>) -> Result<Node<Inline>, String> {
        if open.name == "w:r" {
            let (content, src) = self.element(open, Self::run_content)?;
            return Ok(Node {
                src,
                state: State::Clean,
                val: Inline::Run(content),
            });
        }
        if open.self_closing {
            return self.opaque(open, Inline::Opaque);
        }
        let (content, src) = self.element(open, Self::inline)?;
        Ok(Node {
            src,
            state: State::Clean,
            val: Inline::Container(content),
        })
    }

    fn run_content(&mut self, open: Tag<'x>) -> Result<Node<RunContent>, String> {
        let mut node = self.opaque(open, RunContent::Opaque)?;
        if open.name == "w:t" {
            let raw = &self.xml[node.src.open_end..node.src.close_start.max(node.src.open_end)];
            node.val = RunContent::Text(decode_entities(raw));
        }
        Ok(node)
    }
}

impl<'x> Document<'x> {
    pub fn open(xml: &'x str) -> Result<Self, String> {
        let scan = scan_body(xml).map_err(|e| e.to_string())?;
        let mut items = Vec::with_capacity(scan.elements.len());
        for element in &scan.elements {
            let mut reader = Reader {
                xml,
                at: element.start,
            };
            let open = reader.next_tag().ok_or("no tag")?;
            items.push(if open.name == "w:p" {
                let (content, src) = reader.element(open, Reader::inline)?;
                Node {
                    src,
                    state: State::Clean,
                    val: BodyItem::Paragraph(content),
                }
            } else {
                reader.opaque(open, BodyItem::Opaque)?
            });
        }
        let src = Src {
            outer: 0..xml.len(),
            open_end: scan.body_content_start,
            close_start: scan.body_content_end,
        };
        Ok(Self {
            xml,
            body: Node {
                src,
                state: State::Clean,
                val: items,
            },
        })
    }
}

// == writer

trait Emit {
    /// A node that is not clean.
    fn emit_changed(&self, src: &Src, xml: &str, out: &mut String);
}

fn emit<T: Emit>(node: &Node<T>, xml: &str, out: &mut String) {
    match node.state {
        State::Clean => out.push_str(&xml[node.src.outer.clone()]),
        State::Touched | State::Dirty => node.val.emit_changed(&node.src, xml, out),
    }
}

/// A touched node: its own tags and the bytes between its children copied
/// from the source, each child emitted by its own state.
fn emit_frame<T: Emit>(src: &Src, children: &[Node<T>], xml: &str, out: &mut String) {
    out.push_str(&xml[src.outer.start..src.open_end]);
    let mut cursor = src.open_end;
    for child in children {
        out.push_str(&xml[cursor..child.src.outer.start]);
        emit(child, xml, out);
        cursor = child.src.outer.end;
    }
    out.push_str(&xml[cursor..src.outer.end]);
}

impl Emit for Vec<Node<BodyItem>> {
    fn emit_changed(&self, src: &Src, xml: &str, out: &mut String) {
        emit_frame(src, self, xml, out);
    }
}

impl Emit for BodyItem {
    fn emit_changed(&self, src: &Src, xml: &str, out: &mut String) {
        match self {
            Self::Paragraph(content) => emit_frame(src, content, xml, out),
            Self::Opaque => out.push_str(&xml[src.outer.clone()]),
        }
    }
}

impl Emit for Inline {
    fn emit_changed(&self, src: &Src, xml: &str, out: &mut String) {
        match self {
            Self::Run(content) => emit_frame(src, content, xml, out),
            Self::Container(content) => emit_frame(src, content, xml, out),
            Self::Opaque => out.push_str(&xml[src.outer.clone()]),
        }
    }
}

impl Emit for RunContent {
    fn emit_changed(&self, src: &Src, xml: &str, out: &mut String) {
        let Self::Text(text) = self else {
            out.push_str(&xml[src.outer.clone()]);
            return;
        };
        let open = &xml[src.outer.start..src.open_end];
        let open = open
            .strip_suffix("/>")
            .or_else(|| open.strip_suffix('>'))
            .unwrap_or(open);
        out.push_str(open);
        if needs_preserve(text) && !open.contains("xml:space") {
            out.push_str(" xml:space=\"preserve\"");
        }
        out.push('>');
        escape_text(text, out);
        out.push_str("</w:t>");
    }
}

impl Document<'_> {
    pub fn save_xml(&self) -> String {
        let mut out = String::with_capacity(self.xml.len() + 256);
        emit(&self.body, self.xml, &mut out);
        out
    }
}

// == edit

/// The content of the run at `index`, with the run and every container on
/// the way marked touched.
fn touch_run<'b>(
    content: &'b mut [Node<Inline>],
    index: &mut usize,
) -> Option<&'b mut Vec<Node<RunContent>>> {
    for node in content {
        let found = match &mut node.val {
            Inline::Run(run) if *index == 0 => Some(run),
            Inline::Run(_) => {
                *index -= 1;
                None
            }
            Inline::Container(children) => touch_run(children, index),
            Inline::Opaque => None,
        };
        if found.is_some() {
            node.state = State::Touched;
            return found;
        }
    }
    None
}

impl Document<'_> {
    /// Marks the run's text dirty and every ancestor touched.
    pub fn set_run_text(&mut self, paragraph: usize, run: usize, text: &str) -> Result<(), String> {
        let item = self.body.val.get_mut(paragraph).ok_or("no such block")?;
        let BodyItem::Paragraph(content) = &mut item.val else {
            return Err("not a paragraph".to_owned());
        };
        let mut index = run;
        let run_content = touch_run(content, &mut index).ok_or("no such run")?;
        let t = run_content
            .iter_mut()
            .find(|c| matches!(c.val, RunContent::Text(_)))
            .ok_or("run has no text")?;
        t.val = RunContent::Text(text.to_owned());
        t.state = State::Dirty;
        item.state = State::Touched;
        self.body.state = State::Touched;
        Ok(())
    }
}

pub fn edit_xml(xml: &str, edit: &RunEdit<'_>) -> Result<String, String> {
    let mut doc = Document::open(xml)?;
    doc.set_run_text(edit.paragraph, edit.run, edit.text)?;
    Ok(doc.save_xml())
}

pub fn save_with_edit(docx: &Docx<'_>, edit: &RunEdit<'_>) -> Result<Vec<u8>, String> {
    docx.save(&edit_xml(&docx.xml, edit)?)
}
