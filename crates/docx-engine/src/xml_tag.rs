//! xml-tag.ts: start tags read with their attribute values in mind. XML allows
//! `>` inside a quoted attribute value, so a start tag read with `<name[^>]*>`
//! stops inside the value; these read through the quotes to the tag's own `>`.

use std::borrow::Cow;

use jscompat::{JsRegex, is_js_space};
use ooxml_xml::mask_opaque;

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

/// The byte of the `>` that ends the start tag whose name ends at `from`,
/// read through quoted attribute values; `None` when it never ends.
fn start_tag_end(xml: &str, from: usize) -> Option<usize> {
    let mut quote = 0u8;
    for (at, &c) in xml.as_bytes().iter().enumerate().skip(from) {
        if quote != 0 {
            if c == quote {
                quote = 0;
            }
        } else if c == b'"' || c == b'\'' {
            quote = c;
        } else if c == b'>' {
            return Some(at);
        }
    }
    None
}

/// What `xmlSegments` looks for: the first `<tag` (followed by white space, `/`
/// or `>`, so `w:tr` is not `w:trPr`) or `</tag\s*>` at or after byte `from`,
/// as its start, its length and whether it is an end tag.
fn next_tag(xml: &str, tag: &str, from: usize) -> Option<(usize, usize, bool)> {
    let mut at = from;
    loop {
        let lt = at + xml.get(at..)?.find('<')?;
        let rest = &xml[lt + 1..];
        if let Some(after_slash) = rest.strip_prefix('/') {
            if let Some(after_name) = after_slash.strip_prefix(tag) {
                let spaces = after_name.len() - after_name.trim_start_matches(is_js_space).len();
                if after_name[spaces..].starts_with('>') {
                    return Some((lt, 2 + tag.len() + spaces + 1, true));
                }
            }
        } else if let Some(after_name) = rest.strip_prefix(tag)
            && after_name
                .chars()
                .next()
                .is_some_and(|c| c == '/' || c == '>' || is_js_space(c))
        {
            return Some((lt, 1 + tag.len(), false));
        }
        at = lt + 1;
    }
}

/// One top-level segment, in UTF-8 byte offsets of the text scanned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XmlSegment {
    pub start: usize,
    pub end: usize,
}

/// `xmlSegments`: the top-level segments of `tag` between byte `from` and
/// `to`, depth-aware for nesting. Tags are read the way an XML parser reads
/// them: markup inside a comment, a CDATA section or a processing instruction
/// is no tag, a `>` inside a quoted attribute value does not end the tag, and
/// an end tag may hold white space before its `>`.
pub fn xml_segments(xml: &str, tag: &str, from: usize, to: usize) -> Vec<XmlSegment> {
    let masked = mask_opaque(xml);
    let mut segs = Vec::new();
    let mut depth = 0usize;
    let mut seg_start = 0;
    let mut at = from;
    while let Some((index, len, closing)) = next_tag(&masked, tag, at) {
        if index >= to {
            break;
        }
        if closing {
            if depth == 0 {
                break;
            }
            depth -= 1;
            if depth == 0 {
                segs.push(XmlSegment {
                    start: seg_start,
                    end: index + len,
                });
            }
            at = index + len;
            continue;
        }
        let Some(gt) = start_tag_end(&masked, index + len) else {
            break;
        };
        at = gt + 1;
        // a trailing self-closing element (Word's empty <w:p/>) has no close tag after it
        if masked.as_bytes()[gt - 1] == b'/' {
            if depth == 0 {
                segs.push(XmlSegment {
                    start: index,
                    end: gt + 1,
                });
            }
            continue;
        }
        if depth == 0 {
            seg_start = index;
        }
        depth += 1;
    }
    segs
}

/// `elementInner`: what an element holds, its XML between its start tag and
/// its end tag (the last one in `xml`, which is the element's own); empty for
/// a self-closing element.
pub fn element_inner(xml: &str) -> &str {
    let masked = mask_opaque(xml);
    let Some(open) = find_start_tag(&masked, TagName::Any, 0) else {
        return "";
    };
    if open.self_closing {
        return "";
    }
    match masked.rfind("</") {
        Some(close) if close >= open.end => &xml[open.end..close],
        _ => "",
    }
}

/// `replaceSegments`: `xml` with each top-level `tag` element (to its own end
/// tag, nested ones inside it) replaced by `replace(element)`; `replace`
/// returns an empty string to drop it. The elements are found as
/// [`xml_segments`] finds them.
pub fn replace_segments<'x>(
    xml: &'x str,
    tag: &str,
    mut replace: impl FnMut(&str) -> String,
) -> Cow<'x, str> {
    let mut out = String::new();
    let mut cursor = 0;
    for seg in xml_segments(xml, tag, 0, xml.len()) {
        out.push_str(&xml[cursor..seg.start]);
        out.push_str(&replace(&xml[seg.start..seg.end]));
        cursor = seg.end;
    }
    if cursor == 0 {
        return Cow::Borrowed(xml);
    }
    out.push_str(&xml[cursor..]);
    Cow::Owned(out)
}

/// `removeSegments`: `xml` without its top-level `tag` elements.
pub fn remove_segments<'x>(xml: &'x str, tag: &str) -> Cow<'x, str> {
    replace_segments(xml, tag, |_| String::new())
}
