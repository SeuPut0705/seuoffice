//! packages/file-parse/src/docx.ts.
//!
//! Text is held as UTF-16 code units until the end: `w:sym` and character
//! references can each give one half of a surrogate pair, and JavaScript joins
//! two adjacent halves into one character. A half still alone in the result
//! cannot be a Rust string, so that answer is refused rather than guessed.

use std::collections::{HashMap, HashSet};

use jscompat::{Radix, is_js_space, js_regex, number_to_string, parse_int, to_number, truthy};
use ooxml_pkg::{Package, ReadError};

use crate::opc::resolve_target;
use crate::redaction::{REDACT_NAMESPACES, placeholder_source, redaction_error};

type Units = Vec<u16>;

fn read_error(error: ReadError) -> String {
    error.reason
}

fn units(text: &str) -> Units {
    text.encode_utf16().collect()
}

/// `docxToText(bytes, { maxChars })`
pub fn docx_to_text(bytes: &[u8], max_chars: Option<f64>) -> Result<String, String> {
    let package = ooxml_pkg::load_zip_package(bytes)?;
    let doc_path = main_document_path(&package)?;
    let document_xml = match &doc_path {
        Some(path) => package.text(path).map_err(read_error)?,
        None => None,
    };
    let (Some(doc_path), Some(document_xml)) = (doc_path, truthy(document_xml)) else {
        return Err("docx: main document part not found".to_owned());
    };
    let dir = &doc_path[..doc_path.rfind('/').map_or(0, |slash| slash + 1)];
    let style_facts = paragraph_style_facts(
        package
            .text(&format!("{dir}styles.xml"))
            .map_err(read_error)?,
    );
    let mut out = TextSink::new(max_chars.unwrap_or(f64::INFINITY));
    scan_body(document_xml, &style_facts, &mut out, false)?;
    if !out.lines.iter().any(|line| !is_blank(line)) && out.pictures > 0.0 {
        let n = out.pictures;
        out.lines.clear();
        out.push(units(&format!(
            "[image-only document: {} image{}, no extractable text]",
            number_to_string(n),
            if n == 1.0 { "" } else { "s" },
        )));
    }
    for (part, title) in [("footnotes.xml", "Footnotes"), ("endnotes.xml", "Endnotes")] {
        if out.full {
            break;
        }
        let xml = package.text(&format!("{dir}{part}")).map_err(read_error)?;
        let Some(xml) = truthy(xml) else { continue };
        append_story(&mut out, title, xml, &style_facts, true)?;
    }
    for (title, xml) in related_stories(&package, &doc_path)? {
        if out.full {
            break;
        }
        append_story(&mut out, title, xml, &style_facts, false)?;
    }
    let mut joined: Units = Vec::new();
    for (index, line) in out.lines.iter().enumerate() {
        if index > 0 {
            joined.push(u16::from(b'\n'));
        }
        joined.extend_from_slice(line);
    }
    String::from_utf16(&joined).map_err(|_| {
        "docx: the TypeScript answer holds a lone surrogate, which a Rust string cannot".to_owned()
    })
}

fn append_story(
    out: &mut TextSink,
    title: &str,
    xml: &str,
    style_facts: &HashMap<String, StyleFacts>,
    notes: bool,
) -> Result<(), String> {
    let mut sink = TextSink::new(f64::INFINITY);
    scan_body(xml, style_facts, &mut sink, notes)?;
    if sink.lines.is_empty() {
        return Ok(());
    }
    out.push(units(&format!("## {title}")));
    for line in sink.lines {
        out.push(line);
    }
    Ok(())
}

/// Headers, footers and comments named by the main document's relationships.
fn related_stories<'p>(
    package: &'p Package,
    doc_path: &str,
) -> Result<Vec<(&'static str, &'p str)>, String> {
    let slash = doc_path.rfind('/');
    let rels_path = match slash {
        Some(slash) => format!(
            "{}_rels/{}.rels",
            &doc_path[..slash + 1],
            &doc_path[slash + 1..]
        ),
        None => format!("_rels/{doc_path}.rels"),
    };
    let Some(rels) = truthy(package.text(&rels_path).map_err(read_error)?) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for m in js_regex!(r"<Relationship\b[^>]*>").find_iter(rels) {
        let tag = m.as_str();
        if js_regex!(r#"TargetMode="External""#).test(tag) {
            continue;
        }
        let kind = js_regex!(r#"Type="([^"]+)""#)
            .exec(tag)
            .and_then(|m| m.get(1))
            .unwrap_or("");
        let Some(target) = js_regex!(r#"Target="([^"]+)""#)
            .exec(tag)
            .and_then(|m| m.get(1))
        else {
            continue;
        };
        let title = if kind.ends_with("/header") {
            "Header"
        } else if kind.ends_with("/footer") {
            "Footer"
        } else if kind.ends_with("/comments") {
            "Comments"
        } else {
            continue;
        };
        let path = resolve_target(doc_path, target);
        if path.is_empty() || seen.contains(&path) {
            continue;
        }
        let xml = package.text(&path).map_err(read_error)?;
        seen.insert(path);
        if let Some(xml) = truthy(xml) {
            out.push((title, xml));
        }
    }
    Ok(out)
}

fn main_document_path(package: &Package) -> Result<Option<String>, String> {
    if package.has("word/document.xml") {
        return Ok(Some("word/document.xml".to_owned()));
    }
    let Some(rels) = truthy(package.text("_rels/.rels").map_err(read_error)?) else {
        return Ok(None);
    };
    for m in js_regex!(r"<Relationship\b[^>]*>").find_iter(rels) {
        let tag = m.as_str();
        if !js_regex!(r#"Type="[^"]*\/officeDocument""#).test(tag)
            || js_regex!(r#"TargetMode="External""#).test(tag)
        {
            continue;
        }
        let Some(target) = js_regex!(r#"Target="([^"]+)""#)
            .exec(tag)
            .and_then(|m| m.get(1))
        else {
            continue;
        };
        // OPC targets are percent-encoded; the zip entry name is the decoded path.
        let resolved = resolve_target("", target);
        if !resolved.is_empty() && package.has(&resolved) {
            return Ok(Some(resolved));
        }
        // resolveTarget rejects malformed escapes (a literal `%`); keep the raw lookup for those.
        let path = target.strip_prefix('/').unwrap_or(target);
        if package.has(path) {
            return Ok(Some(path.to_owned()));
        }
    }
    Ok(None)
}

struct StyleFacts {
    heading: f64,
    list: bool,
}

struct RawStyle<'x> {
    heading: Option<f64>,
    list: Option<bool>,
    based_on: Option<&'x str>,
}

/// Paragraph style id -> heading level and list membership, both inherited
/// along basedOn.
fn paragraph_style_facts(styles_xml: Option<&str>) -> HashMap<String, StyleFacts> {
    let mut facts = HashMap::new();
    let Some(styles_xml) = truthy(styles_xml) else {
        return facts;
    };
    let mut raw: HashMap<&str, RawStyle<'_>> = HashMap::new();
    for m in js_regex!(r"<w:style\b([^>]*)>([\s\S]*?)<\/w:style>").find_iter(styles_xml) {
        let attrs = m.get(1).unwrap_or("");
        if !js_regex!(r#"w:type="paragraph""#).test(attrs) {
            continue;
        }
        let Some(id) = js_regex!(r#"w:styleId="([^"]+)""#)
            .exec(attrs)
            .and_then(|m| m.get(1))
        else {
            continue;
        };
        let body = m.get(2).unwrap_or("");
        let name = js_regex!(r#"<w:name\b[^>]*w:val="([^"]*)""#)
            .exec(body)
            .and_then(|m| m.get(1))
            .unwrap_or("");
        let by_name = js_regex!(r"^heading\s*(\d)$", "i").exec(name);
        let outline = js_regex!(r#"<w:outlineLvl\b[^>]*w:val="(\d)""#).exec(body);
        let heading = if let Some(by_name) = by_name {
            Some(to_number(by_name.get(1).unwrap_or("")))
        } else if js_regex!(r"^title$", "i").test(name) {
            Some(1.0)
        } else if let Some(outline) = outline {
            let level = to_number(outline.get(1).unwrap_or(""));
            Some(if level == 9.0 { 0.0 } else { level + 1.0 })
        } else {
            None
        };
        let num_id = js_regex!(r#"<w:numId\b[^>]*w:val="([^"]+)""#)
            .exec(body)
            .and_then(|m| m.get(1));
        raw.insert(
            id,
            RawStyle {
                heading,
                // numId 0 is Word's "no numbering" override, not a list
                list: num_id.map(|num_id| num_id != "0"),
                based_on: js_regex!(r#"<w:basedOn\b[^>]*w:val="([^"]*)""#)
                    .exec(body)
                    .and_then(|m| m.get(1)),
            },
        );
    }
    for &id in raw.keys() {
        let mut heading = None;
        let mut list = None;
        let mut seen = HashSet::new();
        let mut cur = Some(id);
        while let Some(at) = truthy(cur) {
            if !seen.insert(at) {
                break;
            }
            let Some(r) = raw.get(at) else { break };
            heading = heading.or(r.heading);
            list = list.or(r.list);
            cur = r.based_on;
        }
        facts.insert(
            id.to_owned(),
            StyleFacts {
                heading: heading.unwrap_or(0.0),
                list: list.unwrap_or(false),
            },
        );
    }
    facts
}

struct TextSink {
    lines: Vec<Units>,
    chars: f64,
    full: bool,
    pictures: f64,
    max_chars: f64,
}

impl TextSink {
    fn new(max_chars: f64) -> Self {
        Self {
            lines: Vec::new(),
            chars: 0.0,
            full: false,
            pictures: 0.0,
            max_chars,
        }
    }

    fn push(&mut self, line: Units) {
        if self.full {
            return;
        }
        self.chars += line.len() as f64 + 1.0;
        self.lines.push(line);
        if self.chars >= self.max_chars {
            self.full = true;
        }
    }
}

struct Para {
    text: Units,
    /// the placeholder the paragraph text currently ends with, when a withheld run put it there
    marker: Option<String>,
    heading: f64,
    list: bool,
}

struct Table {
    rows: Vec<Vec<Units>>,
    cell: Option<Vec<Units>>,
    /// The row `table.row` points at, as an index into `rows`.
    row: Option<usize>,
}

/// subtrees whose text is not part of the readable document
const SKIP_SUBTREES: [&str; 15] = [
    "mc:Fallback",
    "w:del",
    "w:moveFrom",
    "w:instrText",
    "w:delInstrText",
    "w:delText",
    // ruby guide text (furigana, pinyin); the base text is read, as parseDocx does
    "w:rt",
    "w:rPrChange",
    "w:pPrChange",
    "w:tabs",
    "w:tblPr",
    "w:tblGrid",
    "w:trPr",
    "w:tcPr",
    "w:sectPr",
];

/// `line.trim()` is empty.
fn is_blank(line: &[u16]) -> bool {
    line.iter().all(|&unit| is_space_unit(unit))
}

fn is_space_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_space)
}

fn join_units(pieces: &[Units], separator: &str) -> Units {
    let separator = units(separator);
    let mut out = Vec::new();
    for (index, piece) in pieces.iter().enumerate() {
        if index > 0 {
            out.extend_from_slice(&separator);
        }
        out.extend_from_slice(piece);
    }
    out
}

/// `text.replace(/\s*\n\s*/g, ' ')`: every maximal run of white space that
/// holds a line feed becomes one space.
fn collapse_line_breaks(text: &[u16]) -> Units {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if !is_space_unit(text[at]) {
            out.push(text[at]);
            at += 1;
            continue;
        }
        let start = at;
        while at < text.len() && is_space_unit(text[at]) {
            at += 1;
        }
        let run = &text[start..at];
        if run.contains(&u16::from(b'\n')) {
            out.push(u16::from(b' '));
        } else {
            out.extend_from_slice(run);
        }
    }
    out
}

fn append_text(paras: &mut [Para], run_labels: &[Option<Units>], text: &[u16]) {
    // a withheld run holds no word the reader may pass on: nothing inside it
    // (text, tabs, a picture's alt text, a nested text box) is collected
    if run_labels.iter().any(Option::is_some) {
        return;
    }
    if let Some(p) = paras.last_mut() {
        p.text.extend_from_slice(text);
        p.marker = None;
    }
}

const MARK_UNREADABLE: &str = "a mark is written in a form that cannot be read";

/// The element names a part's mark goes by, and how many such elements it holds.
struct RedactElements {
    names: HashSet<String>,
    count: usize,
    namespaced: bool,
}

fn redact_element_names(xml: &str) -> RedactElements {
    let namespaced = REDACT_NAMESPACES.iter().any(|ns| xml.contains(ns));
    let mut found = RedactElements {
        names: HashSet::new(),
        count: 0,
        namespaced,
    };
    if !namespaced && !js_regex!(r"<[\w.-]+:redact\b").test(xml) {
        return found;
    }
    let mut at = 0;
    while let Some(found_at) = xml[at..].find("xmlns:") {
        let start = at + found_at;
        let bytes = xml.as_bytes();
        let mut end = start + "xmlns:".len();
        let prefix_start = end;
        while end < bytes.len() && is_name_byte(bytes[end]) && bytes[end] != b':' {
            end += 1;
        }
        let prefix = &xml[prefix_start..end];
        match (prefix.is_empty(), quoted_value_after_eq(xml, end)) {
            (false, Some((value, value_end))) => {
                if REDACT_NAMESPACES.contains(&value) {
                    found.names.insert(format!("{prefix}:redact"));
                }
                at = value_end;
            }
            _ => at = start + 1,
        }
    }
    found.count = count_marks(xml, namespaced);
    found
}

/// Elements in `xml` that may be a mark: any prefix, or none in a part that names a mark namespace.
fn count_marks(xml: &str, namespaced: bool) -> usize {
    js_regex!(r"<[\w.-]+:redact\b").find_iter(xml).count()
        + if namespaced {
            js_regex!(r"<redact\b").find_iter(xml).count()
        } else {
            0
        }
}

/// A mark: a bound prefix, or an unprefixed element that declares the mark's namespace itself.
fn is_redact_element(found: &RedactElements, name: &str, attrs: &str) -> bool {
    if found.names.contains(name) {
        return true;
    }
    if name != "redact" {
        return false;
    }
    attr_value(attrs, "xmlns").is_some_and(|ns| REDACT_NAMESPACES.contains(&ns))
}

/// `[\w.-]`
fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b':')
}

/// `\s*=\s*("([^"]*)"|'([^']*)')` at `at`: the value and where the match ends.
fn quoted_value_after_eq(text: &str, at: usize) -> Option<(&str, usize)> {
    let skip_space = |from: usize| {
        let rest = &text[from..];
        from + rest.len() - rest.trim_start_matches(is_js_space).len()
    };
    let at = skip_space(at);
    if text.as_bytes().get(at) != Some(&b'=') {
        return None;
    }
    let at = skip_space(at + 1);
    let quote = *text.as_bytes().get(at)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let len = text[at + 1..].find(char::from(quote))?;
    Some((&text[at + 1..at + 1 + len], at + len + 2))
}

/// An attribute's value in a tag's attribute text: any quotes, white space around `=`.
/// `(?:^|\s)NAME\s*=\s*(?:"([^"]*)"|'([^']*)')`, leftmost match.
fn attr_value<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let try_at = |at: usize| {
        let rest = attrs[at..].strip_prefix(name)?;
        quoted_value_after_eq(attrs, attrs.len() - rest.len()).map(|(value, _)| value)
    };
    if let Some(value) = try_at(0) {
        return Some(value);
    }
    for (i, c) in attrs.char_indices() {
        if is_js_space(c)
            && let Some(value) = try_at(i + c.len_utf8())
        {
            return Some(value);
        }
    }
    None
}

enum Token<'a> {
    /// a comment, a processing instruction or a declaration
    Skipped,
    Cdata(&'a str),
    Tag {
        close: bool,
        name: &'a str,
        attrs: &'a str,
        self_close: bool,
    },
    Text(&'a str),
}

/// The tokens of a part, read as an XML parser reads them (the port of the TS `TOKEN` regex):
/// a comment, a processing instruction or a declaration, a CDATA section, a tag whose attribute
/// values may hold `>` or `/>` inside their quotes, or text. A `<` that starts none of these is
/// skipped, and reading goes on after it.
struct Tokens<'a> {
    xml: &'a str,
    at: usize,
    // a search for `-->`, `?>`, `]]>` that failed once fails from every later start
    no_comment_end: bool,
    no_pi_end: bool,
    no_cdata_end: bool,
}

impl<'a> Tokens<'a> {
    fn new(xml: &'a str) -> Self {
        Self {
            xml,
            at: 0,
            no_comment_end: false,
            no_pi_end: false,
            no_cdata_end: false,
        }
    }

    fn tag(&self, start: usize) -> Option<(Token<'a>, usize)> {
        let bytes = self.xml.as_bytes();
        let mut i = start + 1;
        let close = bytes.get(i) == Some(&b'/');
        if close {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len() && is_name_byte(bytes[i]) {
            i += 1;
        }
        if i == name_start {
            return None;
        }
        let name = &self.xml[name_start..i];
        let attrs_start = i;
        loop {
            match *bytes.get(i)? {
                b'>' => {
                    let attrs = &self.xml[attrs_start..i];
                    return Some((
                        Token::Tag {
                            close,
                            name,
                            attrs,
                            self_close: false,
                        },
                        i + 1,
                    ));
                }
                b'/' if bytes.get(i + 1) == Some(&b'>') => {
                    let attrs = &self.xml[attrs_start..i];
                    return Some((
                        Token::Tag {
                            close,
                            name,
                            attrs,
                            self_close: true,
                        },
                        i + 2,
                    ));
                }
                quote @ (b'"' | b'\'') => {
                    i += 1 + self.xml[i + 1..].find(char::from(quote))? + 1;
                }
                _ => i += 1,
            }
        }
    }

    fn markup(&mut self, start: usize) -> Option<(Token<'a>, usize)> {
        let rest = &self.xml[start..];
        if rest.starts_with("<!--") && !self.no_comment_end {
            match rest[4..].find("-->") {
                Some(n) => return Some((Token::Skipped, start + 4 + n + 3)),
                None => self.no_comment_end = true,
            }
        }
        if rest.starts_with("<?") && !self.no_pi_end {
            match rest[2..].find("?>") {
                Some(n) => return Some((Token::Skipped, start + 2 + n + 2)),
                None => self.no_pi_end = true,
            }
        }
        if rest.starts_with("<![CDATA[") && !self.no_cdata_end {
            match rest[9..].find("]]>") {
                Some(n) => {
                    return Some((Token::Cdata(&rest[9..9 + n]), start + 9 + n + 3));
                }
                None => self.no_cdata_end = true,
            }
        }
        if rest.starts_with("<!")
            && let Some(n) = rest[2..].find('>')
        {
            return Some((Token::Skipped, start + 2 + n + 1));
        }
        self.tag(start)
    }

    fn next_token(&mut self) -> Option<(usize, Token<'a>)> {
        while self.at < self.xml.len() {
            let start = self.at;
            if self.xml.as_bytes()[start] == b'<' {
                if let Some((token, end)) = self.markup(start) {
                    self.at = end;
                    return Some((start, token));
                }
                // no token starts here: the next start is the following character
                self.at += 1;
                continue;
            }
            let end = self.xml[start..]
                .find('<')
                .map_or(self.xml.len(), |n| start + n);
            self.at = end;
            return Some((start, Token::Text(&self.xml[start..end])));
        }
        None
    }
}

fn emit_para(
    p: Para,
    tables: &mut [Table],
    notes: bool,
    note_lines: &mut Vec<Units>,
    out: &mut TextSink,
) {
    if let Some(cell) = tables.last_mut().and_then(|table| table.cell.as_mut()) {
        cell.push(p.text);
        return;
    }
    if notes {
        note_lines.push(p.text);
        return;
    }
    let line = if p.heading != 0.0 && !p.heading.is_nan() {
        let mut line = units(&"#".repeat(p.heading.min(6.0) as usize));
        line.push(u16::from(b' '));
        line.extend_from_slice(&p.text);
        line
    } else if p.list {
        let mut line = units("- ");
        line.extend_from_slice(&p.text);
        line
    } else {
        p.text
    };
    out.push(line);
}

fn emit_rows(
    table: Table,
    tables: &mut [Table],
    notes: bool,
    note_lines: &mut Vec<Units>,
    out: &mut TextSink,
) {
    let lines: Vec<Units> = table
        .rows
        .iter()
        .map(|row| join_units(row, " | "))
        .collect();
    let mut parent_cell = tables.last_mut().and_then(|table| table.cell.as_mut());
    for line in lines {
        if let Some(cell) = parent_cell.as_mut() {
            cell.push(line);
        } else if notes {
            note_lines.push(line);
        } else {
            out.push(line);
        }
    }
}

/// One pass over a WordprocessingML body. `mc:Fallback` is skipped so a text
/// box wrapped in AlternateContent is read once.
fn scan_body(
    xml: &str,
    style_facts: &HashMap<String, StyleFacts>,
    out: &mut TextSink,
    notes: bool,
) -> Result<(), String> {
    let mut paras: Vec<Para> = Vec::new();
    let mut tables: Vec<Table> = Vec::new();
    // the depth of the skipped subtree's root
    let mut skip: Option<i64> = None;
    let mut depth: i64 = 0;
    let mut in_text = false;
    let mut run_hidden = false;
    // one entry per open run: the label of its "hidden from AI" mark, or None
    let mut run_labels: Vec<Option<Units>> = Vec::new();
    let redact_elements = redact_element_names(xml);
    let mut redact_seen: usize = 0;
    let mut note_separator = false;
    let mut note_lines: Vec<Units> = Vec::new();

    let mut tokens = Tokens::new(xml);
    while let Some((start, token)) = tokens.next_token() {
        if out.full {
            // the text collected so far may already hold a run whose mark was not read
            if redact_seen != count_marks(&xml[..start], redact_elements.namespaced) {
                return Err(redaction_error(MARK_UNREADABLE));
            }
            return Ok(());
        }
        let (close, name, attrs, self_close) = match token {
            Token::Cdata(cdata) => {
                if in_text && skip.is_none() && !run_hidden {
                    append_text(&mut paras, &run_labels, &units(cdata));
                }
                continue;
            }
            Token::Text(text) => {
                if in_text && skip.is_none() && !run_hidden {
                    let decoded = decode_entities(text)?;
                    append_text(&mut paras, &run_labels, &decoded);
                }
                continue;
            }
            // a comment, a processing instruction or a declaration holds no text
            Token::Skipped => continue,
            Token::Tag {
                close,
                name,
                attrs,
                self_close,
            } => (close, name, attrs, self_close),
        };
        let opening = !close;
        if opening && is_redact_element(&redact_elements, name, attrs) {
            let label = attr_value(attrs, "w:label").filter(|label| !label.is_empty());
            let Some(label) = label else {
                return Err(redaction_error("a mark carries no label"));
            };
            // outside a run (a paragraph mark's properties) there are no words to withhold
            if let Some(top) = run_labels.last_mut()
                && top.is_none()
            {
                *top = Some(decode_entities(label)?);
            }
            redact_seen += 1;
        }
        let closing = close && !self_close;
        // a self-closing element opens and ends in one token
        let ending = closing || self_close;
        if opening && !self_close {
            depth += 1;
        }
        if let Some(skip_depth) = skip {
            if closing {
                depth -= 1;
                if depth < skip_depth {
                    skip = None;
                }
            }
            continue;
        }
        if opening && SKIP_SUBTREES.contains(&name) {
            if !self_close {
                skip = Some(depth);
            }
            continue;
        }
        match name {
            "w:p" => {
                if opening {
                    paras.push(Para {
                        text: Vec::new(),
                        marker: None,
                        heading: 0.0,
                        list: false,
                    });
                }
                if ending
                    && let Some(p) = paras.pop()
                    && !note_separator
                {
                    emit_para(p, &mut tables, notes, &mut note_lines, out);
                }
            }
            "w:pStyle" => {
                if opening {
                    let val = js_regex!(r#"w:val="([^"]*)""#)
                        .exec(attrs)
                        .and_then(|m| m.get(1));
                    if let Some(p) = paras.last_mut()
                        && let Some(val) = truthy(val)
                    {
                        let facts = style_facts.get(val);
                        let level = match facts {
                            Some(facts) => facts.heading,
                            None => to_number(
                                js_regex!(r"^Heading(\d)$")
                                    .exec(val)
                                    .and_then(|m| m.get(1))
                                    .unwrap_or("0"),
                            ),
                        };
                        if level != 0.0 && !level.is_nan() {
                            p.heading = level;
                        }
                        if facts.is_some_and(|facts| facts.list) {
                            p.list = true;
                        }
                    }
                }
            }
            "w:numPr" => {
                if opening && let Some(p) = paras.last_mut() {
                    p.list = true;
                }
            }
            "w:numId" => {
                // inside the paragraph's own numPr: numId 0 switches inherited numbering off
                if opening && let Some(p) = paras.last_mut() {
                    p.list = !js_regex!(r#"w:val="0""#).test(attrs);
                }
            }
            "w:outlineLvl" => {
                if opening {
                    let val = js_regex!(r#"w:val="(\d)""#)
                        .exec(attrs)
                        .and_then(|m| m.get(1));
                    if let Some(p) = paras.last_mut()
                        && let Some(val) = truthy(val)
                    {
                        let level = to_number(val);
                        p.heading = if level == 9.0 { 0.0 } else { level + 1.0 };
                    }
                }
            }
            "w:r" => {
                if opening {
                    run_hidden = false;
                    if !self_close {
                        run_labels.push(None);
                    }
                } else if closing && let Some(label) = run_labels.pop() {
                    // the run's own placeholder, once; adjacent runs of one label read as one
                    if let Some(label) = label
                        && run_labels.iter().all(Option::is_none)
                    {
                        let label = String::from_utf16(&label).map_err(|_| {
                            "docx: the TypeScript answer holds a lone surrogate, which a Rust string cannot".to_owned()
                        })?;
                        let marker = placeholder_source(&label);
                        if let Some(p) = paras.last_mut()
                            && p.marker.as_deref() != Some(marker.as_str())
                        {
                            p.text.extend(marker.encode_utf16());
                            p.marker = Some(marker);
                        }
                    }
                }
            }
            "w:vanish" => {
                if opening && !js_regex!(r#"w:val="(0|false)""#).test(attrs) {
                    run_hidden = true;
                }
            }
            "w:t" => in_text = opening && !self_close,
            "w:tab" | "w:ptab" => {
                if opening && !run_hidden {
                    append_text(&mut paras, &run_labels, &[u16::from(b'\t')]);
                }
            }
            "w:br" | "w:cr" => {
                // page and column breaks are layout, not text
                if opening && !run_hidden && !js_regex!(r#"w:type="(page|column)""#).test(attrs) {
                    append_text(&mut paras, &run_labels, &[u16::from(b'\n')]);
                }
            }
            "w:noBreakHyphen" => {
                if opening && !run_hidden {
                    append_text(&mut paras, &run_labels, &[u16::from(b'-')]);
                }
            }
            "w:sym" => {
                if opening && !run_hidden {
                    let code = js_regex!(r#"w:char="([0-9A-Fa-f]{4})""#)
                        .exec(attrs)
                        .and_then(|m| m.get(1));
                    if let Some(code) = truthy(code) {
                        // `String.fromCharCode`: four hex digits are one code unit
                        append_text(
                            &mut paras,
                            &run_labels,
                            &[parse_int(code, Radix::Sixteen) as u16],
                        );
                    }
                }
            }
            "wp:docPr" => {
                // hidden="1"/"true" is the drawing's own flag, same intent as a run's w:vanish
                if opening
                    && !run_hidden
                    && !js_regex!(r#"(?:^|\s)hidden="(?:1|true)""#).test(attrs)
                {
                    let descr = js_regex!(r#"(?:^|\s)descr="([^"]*)""#)
                        .exec(attrs)
                        .and_then(|m| m.get(1));
                    let title = js_regex!(r#"(?:^|\s)title="([^"]*)""#)
                        .exec(attrs)
                        .and_then(|m| m.get(1));
                    let alt = decode_entities(truthy(descr).or(truthy(title)).unwrap_or(""))?;
                    if !alt.is_empty() {
                        let mut text = units("[image: ");
                        text.extend_from_slice(&alt);
                        text.push(u16::from(b']'));
                        append_text(&mut paras, &run_labels, &text);
                    }
                }
            }
            "w:drawing" | "w:pict" => {
                if opening {
                    out.pictures += 1.0;
                }
            }
            "w:tbl" => {
                if opening {
                    tables.push(Table {
                        rows: Vec::new(),
                        cell: None,
                        row: None,
                    });
                }
                if ending && let Some(table) = tables.pop() {
                    emit_rows(table, &mut tables, notes, &mut note_lines, out);
                }
            }
            "w:tr" => {
                if let Some(table) = tables.last_mut() {
                    if opening {
                        table.rows.push(Vec::new());
                        table.row = Some(table.rows.len() - 1);
                    }
                    if ending {
                        table.row = None;
                    }
                }
            }
            "w:tc" => {
                if let Some(table) = tables.last_mut() {
                    if opening {
                        table.cell = Some(Vec::new());
                    }
                    if ending && let Some(cell) = table.cell.take() {
                        // a row is one line: soft breaks inside a cell must not split it
                        if let Some(row) = table.row {
                            table.rows[row].push(collapse_line_breaks(&join_units(&cell, " ")));
                        }
                    }
                }
            }
            "w:footnote" | "w:endnote" => {
                if opening {
                    note_separator = js_regex!(
                        r#"w:type="(separator|continuationSeparator|continuationNotice)""#
                    )
                    .test(attrs);
                    note_lines = Vec::new();
                } else {
                    if !note_separator && !note_lines.is_empty() {
                        out.push(join_units(&note_lines, " "));
                    }
                    note_separator = false;
                }
            }
            _ => {}
        }
        if closing {
            depth -= 1;
        }
    }
    if redact_seen != redact_elements.count {
        return Err(redaction_error(MARK_UNREADABLE));
    }
    Ok(())
}

fn decode_entities(text: &str) -> Result<Units, String> {
    if !text.contains('&') {
        return Ok(units(text));
    }
    let mut out = Vec::with_capacity(text.len());
    let mut copied = 0;
    for m in js_regex!(r"&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);").find_iter(text) {
        out.extend(text[copied..m.start()].encode_utf16());
        copied = m.end();
        let e = m.get(1).unwrap_or("");
        if let Some(number) = e.strip_prefix('#') {
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => parse_int(hex, Radix::Sixteen),
                None => parse_int(number, Radix::Ten),
            };
            if code.is_finite() {
                from_code_point(code, &mut out)?;
            }
            continue;
        }
        out.push(u16::from(match e {
            "amp" => b'&',
            "lt" => b'<',
            "gt" => b'>',
            "quot" => b'"',
            _ => b'\'',
        }));
    }
    out.extend(text[copied..].encode_utf16());
    Ok(out)
}

/// `String.fromCodePoint(code)`, which throws a RangeError past U+10FFFF.
fn from_code_point(code: f64, out: &mut Units) -> Result<(), String> {
    if !(0.0..=1_114_111.0).contains(&code) || code.fract() != 0.0 {
        return Err(format!("Invalid code point {}", number_to_string(code)));
    }
    let code = code as u32;
    match char::from_u32(code) {
        Some(c) => out.extend(c.encode_utf16(&mut [0; 2]).iter()),
        // a surrogate code point is one lone code unit in JavaScript
        None => out.push(code as u16),
    }
    Ok(())
}
