//! Why a saved main part is not byte-identical where it should be: the first
//! difference outside the edited `w:t` content (from the front, else from the
//! back), named by the original construct it falls in.

use std::ops::Range;

use ooxml_xml::{opaque_end, tag_at};

pub struct Divergence {
    pub class: String,
    pub original: String,
    pub saved: String,
}

fn floor_boundary(s: &str, mut at: usize) -> usize {
    at = at.min(s.len());
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    at
}

fn snippet(s: &str, at: usize) -> String {
    let start = floor_boundary(s, at.saturating_sub(40));
    let end = floor_boundary(s, at + 60);
    s[start..end].replace('\n', "\\n")
}

enum Token<'x> {
    Tag {
        start: usize,
        end: usize,
        name: &'x str,
    },
    Text {
        start: usize,
        end: usize,
    },
    Opaque {
        start: usize,
    },
}

/// The token of `xml` (inside `within`) holding byte `at`, and the names of
/// the elements open around it.
fn token_at<'x>(xml: &'x str, within: Range<usize>, at: usize) -> (Token<'x>, Vec<&'x str>) {
    let mut stack: Vec<&str> = Vec::new();
    let mut cursor = within.start;
    while cursor < within.end {
        let Some(found) = xml[cursor..within.end].find('<') else {
            return (
                Token::Text {
                    start: cursor,
                    end: within.end,
                },
                stack,
            );
        };
        let start = cursor + found;
        if at < start {
            return (
                Token::Text {
                    start: cursor,
                    end: start,
                },
                stack,
            );
        }
        if let Some(end) = opaque_end(xml, start) {
            if at < end {
                return (Token::Opaque { start }, stack);
            }
            cursor = end;
            continue;
        }
        let tag = tag_at(xml, start);
        if at < tag.end {
            return (
                Token::Tag {
                    start,
                    end: tag.end,
                    name: tag.name,
                },
                stack,
            );
        }
        cursor = tag.end;
        if tag.closing {
            stack.pop();
        } else if !tag.self_closing {
            stack.push(tag.name);
        }
    }
    (
        Token::Text {
            start: within.end,
            end: within.end,
        },
        stack,
    )
}

fn attrs_of(tag: &str) -> Vec<(&str, &str, u8)> {
    let mut out = Vec::new();
    let body = tag.trim_start_matches(['<', '/']);
    let mut rest = body.find(char::is_whitespace).map_or("", |i| &body[i..]);
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim();
        let after = rest[eq + 1..].trim_start();
        let Some(quote) = after.bytes().next().filter(|q| *q == b'"' || *q == b'\'') else {
            break;
        };
        let Some(close) = after[1..].find(quote as char) else {
            break;
        };
        out.push((name, &after[1..1 + close], quote));
        rest = &after[close + 2..];
    }
    out
}

fn tag_form_difference(original: &str, saved: &str) -> &'static str {
    if original.ends_with("/>") != saved.ends_with("/>") {
        return "self-closing form";
    }
    let (a, b) = (attrs_of(original), attrs_of(saved));
    if a.iter().any(|(_, _, q)| *q == b'\'') {
        return "attribute quoting";
    }
    let decoded = |v: &str| {
        let mut out = String::new();
        crate::probe::decode(v, &mut out);
        out
    };
    let same_decoded = a.len() == b.len()
        && a.iter()
            .zip(&b)
            .all(|(x, y)| x.0 == y.0 && decoded(x.1) == decoded(y.1));
    if same_decoded && a.iter().zip(&b).any(|(x, y)| x.1 != y.1) {
        return "entity form in attribute";
    }
    let mut sorted_a: Vec<_> = a.iter().map(|(n, v, _)| (*n, *v)).collect();
    let mut sorted_b: Vec<_> = b.iter().map(|(n, v, _)| (*n, *v)).collect();
    sorted_a.sort_unstable();
    sorted_b.sort_unstable();
    if sorted_a == sorted_b && a.len() == b.len() {
        return "attribute order";
    }
    if original.len() - original.trim_end_matches(['>', '/']).trim_end().len()
        != saved.len() - saved.trim_end_matches(['>', '/']).trim_end().len()
    {
        return "white space inside a tag";
    }
    "attributes differ"
}

fn element_class(name: &str, stack: &[&str]) -> String {
    let parent = stack.last().copied().unwrap_or("");
    match name {
        "w:proofErr" => "w:proofErr".into(),
        "w:bookmarkStart" | "w:bookmarkEnd" => "bookmarks".into(),
        "w:commentRangeStart" | "w:commentRangeEnd" | "w:commentReference" => {
            "comment range marks".into()
        }
        "w:hyperlink" => "w:hyperlink wrapper".into(),
        "w:ins" | "w:del" | "w:moveFrom" | "w:moveTo" => "revision wrapper (w:ins, w:del)".into(),
        "w:smartTag"
        | "w:sdt"
        | "w:sdtContent"
        | "w:sdtPr"
        | "w:sdtEndPr"
        | "w:customXml"
        | "w:fldSimple"
        | "mc:AlternateContent" => format!("other inline wrapper ({name})"),
        "w:fldChar" | "w:instrText" | "w:delInstrText" => "field characters".into(),
        "w:tab" | "w:br" | "w:cr" | "w:noBreakHyphen" | "w:softHyphen" => {
            "tabs and breaks inside runs".into()
        }
        _ if stack.contains(&"w:rPr") || name == "w:rPr" => "w:rPr re-serialized: element".into(),
        _ if parent == "w:r" => format!("run child the model does not know ({name})"),
        _ => format!("paragraph child the model does not know ({name})"),
    }
}

/// `saved` against `original` outside `edited` (a content range of the
/// original), both inside the paragraph `para`; `None` when identical there.
pub fn classify(
    original: &str,
    saved: &str,
    para: Range<usize>,
    edited: Range<usize>,
) -> Option<Divergence> {
    let (o, s) = (original.as_bytes(), saved.as_bytes());
    let prefix = o.iter().zip(s).take_while(|(a, b)| a == b).count();
    let suffix = o
        .iter()
        .rev()
        .zip(s.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let shift = s.len() as isize - o.len() as isize;
    let (at, front) = if prefix < edited.start {
        (prefix, true)
    } else if o.len() - suffix > edited.end {
        (o.len() - suffix - 1, false)
    } else {
        return None;
    };
    let saved_at = if front {
        at
    } else {
        (at as isize + shift).max(0) as usize
    };
    let within = if para.contains(&at) {
        para
    } else {
        0..original.len()
    };
    let (token, mut stack) = token_at(original, within, at);
    let class = match token {
        Token::Tag { start, end, name } => {
            let saved_tag = if front {
                (saved.as_bytes().get(start) == Some(&b'<')).then(|| tag_at(saved, start))
            } else {
                let saved_end = (end as isize + shift).max(0) as usize;
                saved[..floor_boundary(saved, saved_end)]
                    .rfind('<')
                    .map(|i| tag_at(saved, i))
            };
            let original_tag = &original[start..end];
            match saved_tag {
                Some(t) if t.name == name && t.closing == original_tag.starts_with("</") => {
                    let form = tag_form_difference(original_tag, &saved[t.start..t.end]);
                    if stack.contains(&"w:rPr") || name == "w:rPr" {
                        format!("w:rPr re-serialized: {form}")
                    } else {
                        match name {
                            "w:p" | "w:r" if form == "attributes differ" => {
                                format!("attributes on {name} (w:rsid*, w14:paraId)")
                            }
                            "w:t" => format!("w:t attributes ({form})"),
                            _ => format!("{form} on {name}"),
                        }
                    }
                }
                _ => {
                    if original_tag.starts_with("</") {
                        stack.pop();
                    }
                    element_class(name, &stack)
                }
            }
        }
        Token::Text { start, end } => {
            let text = &original[start..end];
            if stack.last() == Some(&"w:t") {
                if text.contains('&') {
                    "entity or character reference in text".into()
                } else {
                    "text re-encoded".into()
                }
            } else if text.trim().is_empty() {
                "white space between elements".into()
            } else {
                "text outside w:t".into()
            }
        }
        Token::Opaque { start } => {
            if original[start..].starts_with("<!--") {
                "comment".into()
            } else if original[start..].starts_with("<![CDATA[") {
                "CDATA".into()
            } else {
                "processing instruction".into()
            }
        }
    };
    Some(Divergence {
        class,
        original: snippet(original, at),
        saved: snippet(saved, saved_at),
    })
}
