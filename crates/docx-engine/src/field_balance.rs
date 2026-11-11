//! `balanceFieldChars` of packages/docx-engine/src/field-balance.ts.
//!
//! Complex fields are begin/separate/end run triples, and Word treats an
//! unbalanced sequence as a damaged file. Editing a field whose result spans
//! paragraphs can drop the paragraph carrying the begin or the end run, so the
//! assembled body is balanced once more before it is written: stray separate
//! and end runs go, and a begin left open is closed at the end of its own
//! paragraph.

use jscompat::js_regex;
use ooxml_xml::{opaque_end, tag_at};

const END_RUN: &str = r#"<w:r><w:fldChar w:fldCharType="end"/></w:r>"#;

struct Edit {
    start: usize,
    end: usize,
    text: &'static str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FieldType {
    Begin,
    Separate,
    End,
}

enum TokenKind {
    POpen { self_closing: bool },
    PClose,
    Field(FieldType),
}

struct Token {
    start: usize,
    kind: TokenKind,
}

/// A tag of the text; `text` is empty for a comment, CDATA section,
/// processing instruction or declaration.
struct NextTag<'a> {
    start: usize,
    end: usize,
    text: &'a str,
}

fn next_tag(xml: &str, cursor: usize) -> Option<NextTag<'_>> {
    let start = cursor + xml.get(cursor..)?.find('<')?;
    if let Some(end) = opaque_end(xml, start) {
        return Some(NextTag {
            start,
            end,
            text: "",
        });
    }
    let end = tag_at(xml, start).end;
    Some(NextTag {
        start,
        end,
        text: &xml[start..end],
    })
}

fn field_tokens(xml: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut cursor = 0;
    while cursor < xml.len() {
        let Some(tag) = next_tag(xml, cursor) else {
            break;
        };
        cursor = tag.end;
        if tag.text.is_empty() {
            continue;
        }
        if js_regex!(r"^<w:p(?:\s|>)").test(tag.text) {
            tokens.push(Token {
                start: tag.start,
                kind: TokenKind::POpen {
                    self_closing: tag.text.ends_with("/>"),
                },
            });
        } else if js_regex!(r"^<\/w:p\s*>").test(tag.text) {
            tokens.push(Token {
                start: tag.start,
                kind: TokenKind::PClose,
            });
        } else if js_regex!(r"^<w:fldChar\b").test(tag.text) {
            let found = js_regex!(
                r#"\bw:fldCharType\s*=\s*(?:"(begin|separate|end)"|'(begin|separate|end)')"#
            )
            .exec(tag.text);
            let field_type = match found.and_then(|found| found.get(1).or_else(|| found.get(2))) {
                Some("begin") => FieldType::Begin,
                Some("separate") => FieldType::Separate,
                Some("end") => FieldType::End,
                _ => continue,
            };
            tokens.push(Token {
                start: tag.start,
                kind: TokenKind::Field(field_type),
            });
        }
    }
    tokens
}

/// Bounds of the run holding an orphan field char. `scan_from` resumes the
/// forward scan where the previous orphan left it.
fn run_bounds(xml: &str, at: usize, scan_from: usize) -> Option<(usize, usize)> {
    let mut open = None;
    let mut cursor = scan_from;
    while cursor < at {
        let Some(tag) = next_tag(xml, cursor) else {
            break;
        };
        cursor = tag.end;
        if tag.text.is_empty() || tag.start >= at {
            continue;
        }
        if js_regex!(r"^<w:r(?:\s|>)").test(tag.text) && !tag.text.ends_with("/>") {
            open = Some(tag.start);
        } else if js_regex!(r"^<\/w:r\s*>").test(tag.text) {
            open = None;
        }
    }
    let open = open?;
    let mut close_cursor = at;
    while close_cursor < xml.len() {
        let Some(tag) = next_tag(xml, close_cursor) else {
            break;
        };
        close_cursor = tag.end;
        if !tag.text.is_empty() && js_regex!(r"^<\/w:r\s*>").test(tag.text) {
            return Some((open, tag.end));
        }
    }
    None
}

/// `text.slice(start, end)`: empty where the range is reversed.
fn slice(text: &str, start: usize, end: usize) -> &str {
    if start >= end { "" } else { &text[start..end] }
}

pub fn balance_field_chars(body_xml: &str) -> String {
    struct OpenField {
        depth: usize,
        para_end: Option<usize>,
    }

    if !body_xml.contains("w:fldCharType") {
        return body_xml.to_owned();
    }
    let mut edits = Vec::new();
    let mut open: Vec<OpenField> = Vec::new();
    let mut depth = 0usize;
    let mut scan_cursor = 0;
    for token in field_tokens(body_xml) {
        match token.kind {
            TokenKind::PClose => {
                for field in &mut open {
                    if field.depth == depth && field.para_end.is_none() {
                        field.para_end = Some(token.start);
                    }
                }
                depth = depth.saturating_sub(1);
            }
            TokenKind::POpen { self_closing } => {
                if !self_closing {
                    depth += 1;
                }
            }
            TokenKind::Field(FieldType::Begin) => open.push(OpenField {
                depth,
                para_end: None,
            }),
            TokenKind::Field(FieldType::End) if !open.is_empty() => {
                open.pop();
            }
            TokenKind::Field(field_type) => {
                if field_type == FieldType::Separate && !open.is_empty() {
                    continue;
                }
                if let Some((start, end)) = run_bounds(body_xml, token.start, scan_cursor) {
                    edits.push(Edit {
                        start,
                        end,
                        text: "",
                    });
                }
                scan_cursor = token.start;
            }
        }
    }
    for field in &open {
        let at = field.para_end.unwrap_or(body_xml.len());
        edits.push(Edit {
            start: at,
            end: at,
            text: END_RUN,
        });
    }
    if edits.is_empty() {
        return body_xml.to_owned();
    }
    edits.sort_by(|a, b| b.start.cmp(&a.start).then(b.end.cmp(&a.end)));
    // collected back to front: each edit's text, then what follows it
    let mut pieces = Vec::with_capacity(edits.len() * 2);
    let mut pos = body_xml.len();
    for edit in &edits {
        pieces.push(slice(body_xml, edit.end, pos));
        pieces.push(edit.text);
        pos = edit.start;
    }
    let mut out = String::with_capacity(body_xml.len() + open.len() * END_RUN.len());
    out.push_str(&body_xml[..pos]);
    for piece in pieces.iter().rev() {
        out.push_str(piece);
    }
    out
}
