//! Byte-exact scanner for slideN.xml (packages/pptx-engine/src/scan.ts).
//!
//! The slide is never parsed and re-serialized: that would change untouched
//! bytes (attribute order, self-closing forms, entity forms). The scanner
//! locates the range of every top-level shape inside `<p:spTree>`, so that a
//! save splices new fragments and copies untouched shapes as original slices.
//! The leading `<p:nvGrpSpPr>` / `<p:grpSpPr>` are not shapes; they go into
//! `body_prefix`.

use std::fmt;

use jscompat::{js_regex, try_js_regex};
use serde::Serialize;

/// A top-level shape. Ranges count UTF-8 bytes, converted to UTF-16 only at
/// the JavaScript boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpElement<'a> {
    pub name: &'a str,
    pub start: u64,
    pub end: u64,
    /// The text between this shape and the next one, replayed verbatim on
    /// rebuild; absent where the two are adjacent or this shape is the last.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap_after: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideScan<'a> {
    pub elements: Vec<SpElement<'a>>,
    /// From the start of the slide up to the first shape.
    pub body_prefix: &'a str,
    /// From the end of the last shape to the end of the slide.
    pub body_suffix: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanError<'a> {
    NoSpTree,
    UnexpectedClosingTag {
        name: &'a str,
    },
    UnterminatedSpTree,
    /// The tag search passed the regex bound: a tag of millions of
    /// characters outside quotes.
    RegexLimit,
}

impl fmt::Display for ScanError<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoSpTree => f.write_str("slide xml has no <p:spTree> element"),
            Self::UnexpectedClosingTag { name } => {
                write!(f, "unexpected closing tag </{name}> at spTree level")
            }
            Self::UnterminatedSpTree => f.write_str("slide xml: unterminated <p:spTree>"),
            Self::RegexLimit => write!(f, "slide xml: {}", jscompat::RegexLimit),
        }
    }
}

impl std::error::Error for ScanError<'_> {}

/// mc:AlternateContent is scanned as an element so its Choice can render; a
/// save replays the whole block's original bytes.
const SHAPE_TAGS: [&str; 6] = [
    "p:sp",
    "p:pic",
    "p:graphicFrame",
    "p:grpSp",
    "p:cxnSp",
    "mc:AlternateContent",
];

/// A shape found by the loop, its range in bytes until the end converts it.
struct Found<'a> {
    name: &'a str,
    start: usize,
    end: usize,
}

pub fn scan_slide(slide_xml: &str) -> Result<SlideScan<'_>, ScanError<'_>> {
    // The comment alternative of the tag pattern stays first: the tag class
    // cannot cross a '<', so a comment carrying markup would otherwise be
    // scanned as real tags.
    let tag_re = try_js_regex!(r#"<!--[\s\S]*?-->|<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>"#);
    let name_re = js_regex!(r"^<\/?\s*([A-Za-z_][\w:.-]*)");

    let sp_tree_open = try_js_regex!(r#"<p:spTree(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?>"#)
        .try_exec(slide_xml)
        .map_err(|_| ScanError::RegexLimit)?
        .ok_or(ScanError::NoSpTree)?;
    let scan_from = sp_tree_open.end();

    let mut elements: Vec<Found<'_>> = Vec::new();
    let mut depth = 0u32;
    let mut current_start = 0;
    let mut current_name = "";
    let mut sp_tree_close_at = None;

    for found in tag_re.try_find_from(slide_xml, scan_from) {
        let found = found.map_err(|_| ScanError::RegexLimit)?;
        let tag = found.as_str();
        if tag.starts_with("<!--") || tag.starts_with("<![") || tag.starts_with("<?") {
            continue;
        }
        let is_closing = tag.starts_with("</");
        let is_self_closing = !is_closing && tag.ends_with("/>");
        let name = name_re.exec(tag).and_then(|m| m.get(1)).unwrap_or_default();

        if is_closing {
            if depth == 0 {
                if name == "p:spTree" {
                    sp_tree_close_at = Some(found.start());
                    break;
                }
                return Err(ScanError::UnexpectedClosingTag { name });
            }
            depth -= 1;
            if depth == 0 && SHAPE_TAGS.contains(&current_name) {
                elements.push(Found {
                    name: current_name,
                    start: current_start,
                    end: found.end(),
                });
            }
        } else if is_self_closing {
            // a self-closing top-level nvGrpSpPr / grpSpPr is not a shape
            if depth == 0 && SHAPE_TAGS.contains(&name) {
                elements.push(Found {
                    name,
                    start: found.start(),
                    end: found.end(),
                });
            }
        } else {
            if depth == 0 {
                current_start = found.start();
                current_name = name;
            }
            depth += 1;
        }
    }

    let sp_tree_close_at = sp_tree_close_at.ok_or(ScanError::UnterminatedSpTree)?;

    let first_shape_start = elements.first().map_or(sp_tree_close_at, |e| e.start);
    let last_shape_end = elements.last().map_or(sp_tree_close_at, |e| e.end);

    let next_starts = elements.iter().skip(1).map(|e| Some(e.start)).chain([None]);
    let elements = elements
        .iter()
        .zip(next_starts)
        .map(|(element, next_start)| SpElement {
            name: element.name,
            start: element.start as u64,
            end: element.end as u64,
            gap_after: next_start
                .map(|next| &slide_xml[element.end..next])
                .filter(|gap| !gap.is_empty()),
        })
        .collect();

    Ok(SlideScan {
        elements,
        body_prefix: &slide_xml[..first_shape_start],
        body_suffix: &slide_xml[last_shape_end..],
    })
}
