//! xml-tag.ts: start tags read with their attribute values in mind. XML allows
//! `>` inside a quoted attribute value, so a start tag read with `<name[^>]*>`
//! stops inside the value; these read through the quotes to the tag's own `>`.

use jscompat::{JsRegex, is_js_space};

/// `StartTag`, with byte offsets into the text searched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartTag<'t> {
    pub start: usize,
    /// just past the tag's own closing `>`
    pub end: usize,
    pub text: &'t str,
    pub self_closing: bool,
}

/// The `name` argument of `findStartTag`.
#[derive(Clone, Copy)]
pub enum TagName<'a> {
    /// no name: any element
    Any,
    /// the qualified name, compared whole
    Exact(&'a str),
    /// a RegExp tested against the whole name
    Matching(&'a JsRegex),
}

/// `NAME_CHAR`: `[\w.:-]` without the `u` flag
fn is_name_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
}

/// `findStartTag`: the first start tag at or after byte `from` whose
/// qualified name is `name`, read through its quoted attribute values to its
/// own `>`. A tag left open at the end of the text ends the search.
pub fn find_start_tag<'t>(xml: &'t str, name: TagName<'_>, from: usize) -> Option<StartTag<'t>> {
    let bytes = xml.as_bytes();
    let mut lt = xml.get(from..)?.find('<')? + from;
    loop {
        let mut i = lt + 1;
        while i < bytes.len() && is_name_char(bytes[i]) {
            i += 1;
        }
        let tag_name = &xml[lt + 1..i];
        let named = tag_name
            .bytes()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
            && match name {
                TagName::Any => true,
                TagName::Exact(name) => tag_name == name,
                TagName::Matching(regex) => regex.test(tag_name),
            }
            // a name must end at white space, `/` or `>`; `<w:hdrX` is another element
            && xml[i..]
                .chars()
                .next()
                .is_none_or(|c| c == '/' || c == '>' || is_js_space(c));
        if named {
            let mut quote = None;
            while i < bytes.len() {
                let c = bytes[i];
                match quote {
                    Some(open) if c == open => quote = None,
                    Some(_) => {}
                    None if c == b'"' || c == b'\'' => quote = Some(c),
                    None if c == b'>' => {
                        let end = i + 1;
                        return Some(StartTag {
                            start: lt,
                            end,
                            text: &xml[lt..end],
                            self_closing: i > 0 && bytes[i - 1] == b'/',
                        });
                    }
                    None => {}
                }
                i += 1;
            }
            return None;
        }
        lt = xml[lt + 1..].find('<')? + lt + 1;
    }
}

/// `removeElements`: `xml` without the elements named `name`, a self-closing
/// one as one element, a paired one to its own close tag (the element does
/// not nest itself). `limit` stops after that many.
pub fn remove_elements(xml: &str, name: &str, limit: Option<usize>) -> String {
    let mut out = xml.to_owned();
    let mut from = 0;
    let mut removed = 0;
    while limit.is_none_or(|limit| removed < limit) {
        let Some(tag) = find_start_tag(&out, TagName::Exact(name), from) else {
            break;
        };
        let (start, mut end) = (tag.start, tag.end);
        if !tag.self_closing {
            let Some(close_end) = close_tag_end(&out, name, end) else {
                break;
            };
            end = close_end;
        }
        out.replace_range(start..end, "");
        from = start;
        removed += 1;
    }
    out
}

/// The end of the first `</name\s*>` at or after byte `from`: a close tag may
/// hold white space before its `>`, as XML allows.
fn close_tag_end(xml: &str, name: &str, from: usize) -> Option<usize> {
    let open = format!("</{name}");
    let mut at = from;
    while let Some(found) = xml[at..].find(&open) {
        let after = at + found + open.len();
        let rest = &xml[after..];
        let spaces = rest.len() - rest.trim_start_matches(is_js_space).len();
        if rest[spaces..].starts_with('>') {
            return Some(after + spaces + 1);
        }
        at = after;
    }
    None
}
