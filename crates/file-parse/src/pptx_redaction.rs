//! packages/file-parse/src/pptx-redaction.ts: withheld runs of a deck, read on
//! a slide or notes part's XML before the text walker parses it. The module
//! comment of the TypeScript says which carriers are understood.
//!
//! Offsets are bytes; every place a scan stops is an ASCII character or the
//! end, so offsets compare as the UTF-16 offsets of the original do.

use jscompat::{Radix, is_js_space, js_regex, parse_int, to_number, trim};

use crate::redaction::{REDACT_EL, REDACT_NAMESPACES, placeholder_source, redaction_error};

/// the engine's REDACT_EXT_URI: the `uri` of the `<a:ext>` that carries the mark
pub const PPTX_REDACT_EXT_URI: &str = "{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}";

/// One element, in a list in document order: `parent` and `children` index
/// that list. The original's `selfClosing` field is never read and is left out.
struct XmlElement<'a> {
    name: &'a str,
    /// a `Map` in the original; only `get` is asked of it
    attrs: Vec<(&'a str, String)>,
    parent: Option<usize>,
    children: Vec<usize>,
    /// offset of `<`
    start: usize,
    /// offset just past the start tag's `>`
    open_end: usize,
    /// offset of the end tag's `<`; equals `open_end` for a self-closing element
    close_start: usize,
}

impl XmlElement<'_> {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }
}

fn malformed() -> String {
    redaction_error("the XML around a mark is not well-formed")
}

fn decode_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_owned();
    }
    js_regex!(r"&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));").replace_all(value, |m| {
        if let Some(named) = m.get(3) {
            return match named {
                "lt" => "<",
                "gt" => ">",
                "amp" => "&",
                "quot" => "\"",
                "apos" => "'",
                _ => m.as_str(),
            }
            .to_owned();
        }
        let code = match m.get(1) {
            None => to_number(m.get(2).unwrap_or_default()),
            Some(hex) => parse_int(hex, Radix::Sixteen),
        };
        // char::from_u32 refuses what the original refuses: surrogates
        match (code <= 1_114_111.0)
            .then(|| char::from_u32(code as u32))
            .flatten()
        {
            Some(c) => c.to_string(),
            None => m.as_str().to_owned(),
        }
    })
}

/// `/[\s/>=]/` of one code unit; half of a pair outside the BMP is none of them.
fn name_end(c: char) -> bool {
    is_js_space(c) || c == '/' || c == '>' || c == '='
}

/// The first offset from `from` whose character does not `keep`, or the end.
fn skip_while(xml: &str, from: usize, keep: impl Fn(char) -> bool) -> usize {
    xml[from..]
        .find(|c| !keep(c))
        .map_or(xml.len(), |at| from + at)
}

struct StartTag<'a> {
    name: &'a str,
    attrs: Vec<(&'a str, String)>,
    end: usize,
    self_closing: bool,
}

/// one start tag: its name, its attributes and where it ends
fn read_start_tag(xml: &str, at: usize) -> Result<StartTag<'_>, String> {
    let bytes = xml.as_bytes();
    let mut i = skip_while(xml, at + 1, |c| !name_end(c));
    let name = &xml[at + 1..i];
    if name.is_empty() {
        return Err(malformed());
    }
    let mut attrs: Vec<(&str, String)> = Vec::new();
    loop {
        i = skip_while(xml, i, is_js_space);
        if i >= xml.len() {
            return Err(malformed());
        }
        if bytes[i] == b'>' {
            return Ok(StartTag {
                name,
                attrs,
                end: i + 1,
                self_closing: false,
            });
        }
        if bytes[i] == b'/' {
            if bytes.get(i + 1) != Some(&b'>') {
                return Err(malformed());
            }
            return Ok(StartTag {
                name,
                attrs,
                end: i + 2,
                self_closing: true,
            });
        }
        let name_start = i;
        i = skip_while(xml, i, |c| !name_end(c));
        let attr = &xml[name_start..i];
        i = skip_while(xml, i, is_js_space);
        if attr.is_empty() || bytes.get(i) != Some(&b'=') {
            return Err(malformed());
        }
        i += 1;
        i = skip_while(xml, i, is_js_space);
        let quote = match bytes.get(i) {
            Some(&quote) if quote == b'"' || quote == b'\'' => char::from(quote),
            _ => return Err(malformed()),
        };
        let Some(close) = xml[i + 1..].find(quote).map(|at| i + 1 + at) else {
            return Err(malformed());
        };
        // a repeated attribute is not well-formed; the first one stands
        if !attrs.iter().any(|(key, _)| *key == attr) {
            attrs.push((attr, decode_entities(&xml[i + 1..close])));
        }
        i = close + 1;
    }
}

fn skip_past(xml: &str, from: usize, terminator: &str) -> Result<usize, String> {
    match xml[from..].find(terminator) {
        Some(end) => Ok(from + end + terminator.len()),
        None => Err(malformed()),
    }
}

/// every element of the part with its source offsets; Err on markup that does not balance
fn scan_elements(xml: &str) -> Result<Vec<XmlElement<'_>>, String> {
    let mut all: Vec<XmlElement> = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    let mut next = xml.find('<');
    while let Some(i) = next {
        let rest = &xml[i..];
        let after = if rest.starts_with("<!--") {
            skip_past(xml, i + 4, "-->")?
        } else if rest.starts_with("<![CDATA[") {
            skip_past(xml, i + 9, "]]>")?
        } else if rest.starts_with("<?") {
            skip_past(xml, i + 2, "?>")?
        } else if rest.starts_with("<!") {
            skip_past(xml, i + 2, ">")?
        } else if rest.as_bytes().get(1) == Some(&b'/') {
            let end = rest.find('>').map(|at| i + at);
            let el = open.pop();
            let (Some(end), Some(el)) = (end, el) else {
                return Err(malformed());
            };
            if trim(&xml[i + 2..end]) != all[el].name {
                return Err(malformed());
            }
            all[el].close_start = i;
            end + 1
        } else {
            let tag = read_start_tag(xml, i)?;
            let parent = open.last().copied();
            let index = all.len();
            all.push(XmlElement {
                name: tag.name,
                attrs: tag.attrs,
                parent,
                children: Vec::new(),
                start: i,
                open_end: tag.end,
                close_start: tag.end,
            });
            if let Some(parent) = parent {
                all[parent].children.push(index);
            }
            if !tag.self_closing {
                open.push(index);
            }
            tag.end
        };
        next = xml[after..].find('<').map(|at| after + at);
    }
    if !open.is_empty() {
        return Err(malformed());
    }
    Ok(all)
}

/// `haystack.split(needle).length - 1`
fn count_of(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

/// The label a mark carries, read the way the engine reads it: the one label
/// element directly inside our extension, with a label that is not empty.
fn label_of<'a>(all: &'a [XmlElement<'a>], ext: usize) -> Result<&'a str, String> {
    let ext = &all[ext];
    let mut marks = ext
        .children
        .iter()
        .map(|&child| &all[child])
        .filter(|c| is_mark(c));
    let label = match (marks.next(), marks.next()) {
        (Some(mark), None) => mark.attr("label"),
        _ => None,
    };
    match label {
        Some(label) if ext.children.len() == 1 && !label.is_empty() => Ok(label),
        _ => Err(redaction_error("a mark carries no label")),
    }
}

/// `isMark`: the engine's prefix, or no prefix with the mark's namespace
/// declared on the element itself. One whose namespace comes from an element
/// around it is not read, and the trace count fails the deck.
fn is_mark(el: &XmlElement) -> bool {
    el.name == REDACT_EL
        || (el.name == "redact" && el.attr("xmlns").is_some_and(|ns| REDACT_NAMESPACES.contains(&ns)))
}

/// `(xml.match(/<redact\b/g) ?? []).length`
fn unprefixed_marks(xml: &str) -> usize {
    xml.match_indices("<redact")
        .filter(|&(at, _)| {
            !xml.as_bytes()
                .get(at + "<redact".len())
                .is_some_and(|&next| next.is_ascii_alphanumeric() || next == b'_')
        })
        .count()
}

/// the element whose properties hold this extension list entry, or None
fn props_of(all: &[XmlElement], ext: usize) -> Option<usize> {
    let parent = all[ext].parent?;
    if all[parent].name == "a:extLst" {
        all[parent].parent
    } else {
        None
    }
}

fn escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// One slide or notes part with every withheld run rewritten to its `{{label}}`
/// marker. A part with no trace of the mark is returned as it came, unparsed.
pub fn redact_pptx_part_xml(xml: &str) -> Result<String, String> {
    if !xml.contains(PPTX_REDACT_EXT_URI)
        && !xml.contains(REDACT_EL)
        && !REDACT_NAMESPACES.iter().any(|ns| xml.contains(ns))
    {
        return Ok(xml.to_owned());
    }
    let all = scan_elements(xml)?;
    // the label of each marked run, at the run's place in `all`
    let mut runs: Vec<Option<&str>> = vec![None; all.len()];
    let mut understood = 0;
    for (index, el) in all.iter().enumerate() {
        if el.name != "a:ext" || el.attr("uri") != Some(PPTX_REDACT_EXT_URI) {
            continue;
        }
        let label = label_of(&all, index)?;
        let props = props_of(&all, index);
        let owner = props.and_then(|props| all[props].parent);
        match (props.map(|props| all[props].name), owner) {
            (Some("a:rPr"), Some(owner)) if matches!(all[owner].name, "a:r" | "a:fld") => {
                // the first mark on a run names it, as it does for the engine
                if runs[owner].is_none() {
                    runs[owner] = Some(label);
                }
            }
            // a picture has no words, and neither has the paragraph mark the engine
            // reads as an empty run: both are understood, with nothing to rewrite
            (Some("p:spPr"), Some(owner)) if all[owner].name == "p:pic" => {}
            (Some("a:endParaRPr"), Some(owner)) if all[owner].name == "a:p" => {}
            _ => {
                return Err(redaction_error(
                    "a mark sits where no run or picture carries one",
                ));
            }
        }
        understood += 1;
    }
    // one extension, one label element, one namespace at most per mark: a trace
    // left over is a mark that was not read above (a label under someone else's
    // extension, the namespace under another prefix, a mark inside a comment)
    if count_of(xml, PPTX_REDACT_EXT_URI) != understood
        || count_of(xml, &format!("<{REDACT_EL}")) + unprefixed_marks(xml) != understood
        || REDACT_NAMESPACES
            .iter()
            .map(|ns| count_of(xml, ns))
            .sum::<usize>()
            > understood
    {
        return Err(redaction_error(
            "a mark is written in a form that cannot be read",
        ));
    }
    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0;
    // `all` is in document order, so this is the original's sort by `start`
    for (run, label) in all
        .iter()
        .zip(&runs)
        .filter_map(|(run, label)| Some((run, (*label)?)))
    {
        // a marked run inside another marked run (not valid DrawingML): rewriting
        // both would move backwards and leave the inner words in the part
        if run.start < cursor {
            return Err(redaction_error("a marked run sits inside another"));
        }
        // the whole inside of the run goes: its properties are of no use to a text
        // reader, and anything else it holds is not this reader's to pass on
        out.push_str(&xml[cursor..run.open_end]);
        out.push_str("<a:t>");
        out.push_str(&escape_text(&placeholder_source(label)));
        out.push_str("</a:t>");
        cursor = run.close_start;
    }
    out.push_str(&xml[cursor..]);
    Ok(out)
}
