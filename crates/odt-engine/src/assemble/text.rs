//! `assemble/text.ts`: plain text of an ODT for AI attachments: paragraphs and
//! headings in document order, tables row by row (cells separated by tabs, the
//! cell's paragraphs and nested tables joined by spaces), tables Hancom puts
//! in text boxes after the paragraph holding them, and notes at the end under
//! their citation. Deleted tracked text and comments are left out.

use jscompat::{Radix, js_regex, parse_int, trim};

use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementVisitor, OpenVerdict, XmlTokenKind, decode_xml_entities,
    walk_elements,
};
use crate::core::{OdtError, OpenOdtOptions, open_odt};

/// `Para`: a paragraph being collected, with the tables framed inside it.
struct Para {
    /// identity of the object the TypeScript's `Note.host` points at
    id: usize,
    text: String,
    /// leading / collapsed white space state (ODF white-space rules)
    ws: bool,
    after: Vec<String>,
}

/// `Note`
struct Note {
    /// the paragraph holding the citation (its `Para.id`) and the citation's
    /// place in its text (a byte offset: the text only grows at its end)
    host: Option<usize>,
    at: usize,
    parts: Vec<String>,
}

/// `Ctx`
enum Ctx {
    Para(Para),
    Cell(Vec<String>),
    Table(Vec<Vec<String>>),
    Note(Note),
}

/// `SKIP`
const SKIP: [&str; 12] = [
    "text:tracked-changes",
    "office:annotation",
    "office:annotation-end",
    "text:note-citation",
    "text:sequence-decls",
    "office:forms",
    "text:soft-page-break",
    "svg:title",
    "svg:desc",
    "office:binary-data",
    "draw:object-ole",
    "office:event-listeners",
];

/// `skipped`: index templates (`text:table-of-content-source` ...) hold
/// template text, not content.
fn skipped(name: &str) -> bool {
    SKIP.contains(&name) || js_regex!(r"^text:[\w-]+-source$").test(name)
}

struct TextWalker<'a> {
    xml: &'a str,
    out: Vec<String>,
    notes: Vec<String>,
    stack: Vec<Ctx>,
    next_para: usize,
}

impl TextWalker<'_> {
    /// `emit`: where a finished block of text goes: the enclosing
    /// cell/note/paragraph, else the output.
    fn emit(&mut self, line: String) {
        for c in self.stack.iter_mut().rev() {
            match c {
                Ctx::Cell(parts) => {
                    parts.push(line);
                    return;
                }
                Ctx::Note(note) => {
                    note.parts.push(line);
                    return;
                }
                Ctx::Para(para) => {
                    para.after.push(line);
                    return;
                }
                Ctx::Table(_) => {}
            }
        }
        self.out.push(line);
    }

    /// `addText`
    fn add_text(&mut self, s: &str) {
        let Some(Ctx::Para(p)) = self.stack.last_mut() else {
            return;
        };
        for ch in s.chars() {
            if matches!(ch, ' ' | '\t' | '\n' | '\r') {
                if !p.ws {
                    p.text.push(' ');
                }
                p.ws = true;
            } else {
                p.text.push(ch);
                p.ws = false;
            }
        }
    }

    /// `literal`
    fn literal(&mut self, s: &str) {
        let Some(Ctx::Para(p)) = self.stack.last_mut() else {
            return;
        };
        p.text.push_str(s);
        p.ws = false;
    }

    /// `noteCitation`
    fn note_citation(&self, el: &ElementFrame<bool>) -> String {
        let range = el.range();
        let inner = &self.xml[range.open_end..range.close_start];
        match js_regex!(
            r"<(?:[\w-]+:)?note-citation\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?note-citation>"
        )
        .exec(inner)
        {
            Some(m) => {
                let stripped = js_regex!(r"<[^>]*>", "g")
                    .replace_all(m.get(1).unwrap_or(""), |_| String::new());
                trim(&decode_xml_entities(&stripped)).to_owned()
            }
            None => String::new(),
        }
    }
}

impl ElementVisitor for TextWalker<'_> {
    type Data = bool;

    fn open(
        &mut self,
        el: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> OpenVerdict {
        if skipped(&el.name) {
            return OpenVerdict::Skip;
        }
        match el.name.as_str() {
            "text:p" | "text:h" => {
                let id = self.next_para;
                self.next_para += 1;
                self.stack.push(Ctx::Para(Para {
                    id,
                    text: String::new(),
                    ws: true,
                    after: Vec::new(),
                }));
                el.data = Some(true);
                OpenVerdict::Continue
            }
            "text:s" => {
                let tag = &self.xml[el.start..el.open_end];
                let c = js_regex!(r#"text:c="(\d+)""#)
                    .exec(tag)
                    .and_then(|m| m.get(1));
                let count = match c {
                    Some(c) if !c.is_empty() => parse_int(c, Radix::Ten),
                    _ => 1.0,
                };
                // Math.min(1000, Math.max(1, count)): the digits always parse
                #[allow(clippy::manual_clamp)] // clamp would propagate NaN
                let count = count.max(1.0).min(1000.0) as usize;
                self.literal(&" ".repeat(count));
                OpenVerdict::Skip
            }
            "text:tab" => {
                self.literal("\t");
                OpenVerdict::Skip
            }
            "text:line-break" => {
                self.literal("\n");
                OpenVerdict::Skip
            }
            "table:table" => {
                self.stack.push(Ctx::Table(Vec::new()));
                el.data = Some(true);
                OpenVerdict::Continue
            }
            "table:table-row" => {
                // `nearest('table')?.rows.push([])`
                for c in self.stack.iter_mut().rev() {
                    if let Ctx::Table(rows) = c {
                        rows.push(Vec::new());
                        break;
                    }
                }
                OpenVerdict::Continue
            }
            "table:table-cell" | "table:covered-table-cell" => {
                self.stack.push(Ctx::Cell(Vec::new()));
                el.data = Some(true);
                OpenVerdict::Continue
            }
            "text:note" => {
                let host = match self.stack.last() {
                    Some(Ctx::Para(p)) => Some((p.id, p.text.len())),
                    _ => None,
                };
                self.stack.push(Ctx::Note(Note {
                    host: host.map(|h| h.0),
                    at: host.map_or(0, |h| h.1),
                    parts: Vec::new(),
                }));
                el.data = Some(true);
                OpenVerdict::Continue
            }
            _ => OpenVerdict::Continue,
        }
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> CloseVerdict {
        if el.data != Some(true) {
            return CloseVerdict::Continue;
        }
        let Some(c) = self.stack.pop() else {
            return CloseVerdict::Continue;
        };
        match c {
            Ctx::Para(c) => {
                let line = c.text.trim_end_matches(' ').to_owned();
                // a paragraph that only hosts framed tables or text boxes gives no line of its own
                if !line.is_empty() || c.after.is_empty() {
                    self.emit(line);
                }
                for a in c.after {
                    self.emit(a);
                }
            }
            Ctx::Cell(parts) => {
                let mut table_row = None;
                for c in self.stack.iter_mut().rev() {
                    if let Ctx::Table(rows) = c {
                        table_row = rows.last_mut();
                        break;
                    }
                }
                let kept: Vec<&str> = parts
                    .iter()
                    .map(String::as_str)
                    .filter(|p| !trim(p).is_empty())
                    .collect();
                let value = js_regex!(r"[\t\n]+", "g").replace_all(&kept.join(" "), |_| " ".into());
                if let Some(row) = table_row
                    && el.name == "table:table-cell"
                {
                    row.push(value);
                }
            }
            Ctx::Table(rows) => {
                let lines: Vec<String> = rows
                    .iter()
                    .map(|r| r.join("\t"))
                    .filter(|l| !trim(l).is_empty())
                    .collect();
                if !lines.is_empty() {
                    self.emit(lines.join("\n"));
                }
            }
            Ctx::Note(c) => {
                let citation = self.note_citation(el);
                if let (Some(host), false) = (c.host, citation.is_empty()) {
                    // the host paragraph is still open unless the document nests oddly;
                    // the TypeScript then changes an object nobody reads
                    for ctx in self.stack.iter_mut() {
                        if let Ctx::Para(p) = ctx
                            && p.id == host
                        {
                            p.text.insert_str(c.at, &citation);
                            p.ws = false;
                        }
                    }
                }
                let body = c
                    .parts
                    .iter()
                    .map(String::as_str)
                    .filter(|p| !trim(p).is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                self.notes.push(if citation.is_empty() {
                    body
                } else {
                    format!("{citation} {body}")
                });
            }
        }
        CloseVerdict::Continue
    }

    fn other(
        &mut self,
        kind: XmlTokenKind,
        start: usize,
        end: usize,
        _parent: Option<&ElementFrame<bool>>,
    ) {
        match kind {
            XmlTokenKind::Text => {
                let text = decode_xml_entities(&self.xml[start..end]);
                self.add_text(&text);
            }
            XmlTokenKind::Cdata => {
                let from = start + 9;
                let to = from.max(end.saturating_sub(3));
                let text = self.xml[from..to].to_owned();
                self.add_text(&text);
            }
            _ => {}
        }
    }
}

/// `odtToText`: the document's text. Fails only with an open error
/// (encrypted, not an ODT, corrupt).
pub fn odt_to_text(odt_bytes: &[u8]) -> Result<String, OdtError> {
    let doc = open_odt(odt_bytes, &OpenOdtOptions::default())?;
    let xml = doc.content_xml.text.as_str();
    let text = &doc.body.text;
    let mut walker = TextWalker {
        xml,
        out: Vec::new(),
        notes: Vec::new(),
        stack: Vec::new(),
        next_para: 0,
    };
    walk_elements(
        xml,
        &doc.body.prefixes,
        &mut walker,
        text.open_end,
        text.close_start,
    );
    let body = walker.out.join("\n");
    Ok(if walker.notes.is_empty() {
        body
    } else {
        format!("{body}\n\n{}", walker.notes.join("\n"))
    })
}
