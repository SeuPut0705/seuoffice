//! Structured document tags (w:sdt): block-level classification and the split
//! of a control's paragraph and table content (packages/docx-engine/src/parse-sdt.ts).
//!
//! Offsets are UTF-8 byte offsets of the text given; the TypeScript counts
//! UTF-16 code units, so a caller that hands them to JavaScript converts.

use jscompat::{JsRegex, RegexLimit, js_regex, try_js_regex};
use ooxml_xml::mask_opaque;
use serde::Serialize;

/// A `<w:sdt>…</w:sdt>` element's ranges inside the scanned xml.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SdtRange {
    /// the opening `<w:sdt>` tag
    pub open_start: usize,
    /// end of the `<w:sdtContent>` opening tag (the content starts here)
    pub open_end: usize,
    /// start of the matching `</w:sdtContent>` (the content ends here)
    pub close_start: usize,
    /// end of the closing `</w:sdt>` tag
    pub close_end: usize,
}

/// `Pick<SdtShell, 'alias' | 'tag' | 'controlType' | 'lock' | 'id'>`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdtMeta {
    pub alias: String,
    pub tag: String,
    pub control_type: &'static str,
    pub lock: String,
    pub id: String,
}

/// `SdtShell` as the reader builds it: the metadata and the control's own
/// open and close bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdtShell {
    #[serde(flatten)]
    pub meta: SdtMeta,
    pub open_xml: String,
    pub close_xml: String,
}

/// One level of a nested block-level control chain, outermost first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdtChainLevel {
    pub range: SdtRange,
    pub shell: SdtShell,
}

/// What `parseSdtBlock` returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdtBlock {
    pub shell: SdtShell,
    pub p_xml: String,
    pub chain: Vec<SdtChainLevel>,
}

/// One top-level w:p / w:tbl child of a control's content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdtPart {
    pub name: String,
    /// slice of the whole `<w:sdt>` xml owned by this part (parts partition it exactly)
    pub start: usize,
    pub end: usize,
    /// the w:p / w:tbl child inside `start..end`
    pub child_start: usize,
    pub child_end: usize,
    /// every control enclosing this child, outermost first
    pub chain: Vec<SdtChainLevel>,
}

const TAG: &str = r#"<(\/?)([A-Za-z0-9:._-]+)((?:"[^"]*"|'[^']*'|[^"'>])*)>"#;

const CONTENT_OPEN: &str = r"<w:sdtContent(?:\s[^>]*)?>";

/// `text.slice(start, end)`: empty where the range is reversed.
fn slice(text: &str, start: usize, end: usize) -> &str {
    if start >= end { "" } else { &text[start..end] }
}

/// Bytes of the one UTF-16 unit after a lookahead `[\s/>]` matched there:
/// those characters all sit in the BMP.
fn unit_after(text: &str, at: usize) -> usize {
    text[at..].chars().next().map_or(0, char::len_utf8)
}

/// Every `<w:sdt>` element inside xml with its own open/close ranges,
/// outermost first. A tag with more than about a million characters of
/// attributes passes the bound of one search.
pub fn sdt_ranges(xml: &str) -> Result<Vec<SdtRange>, RegexLimit> {
    struct Open {
        open_start: usize,
        open_end: Option<usize>,
        close_start: Option<usize>,
    }

    let mut ranges = Vec::new();
    let mut stack: Vec<Open> = Vec::new();
    // tags are found where comments and CDATA cannot fake one
    let masked = mask_opaque(xml);
    for found in try_js_regex!(TAG).try_find_iter(&masked) {
        let found = found?;
        let closing = found.get(1) == Some("/");
        let self_closing = found.get(3).unwrap_or("").ends_with('/');
        let name = found.get(2).unwrap_or("");
        if !closing && name == "w:sdt" {
            if !self_closing {
                stack.push(Open {
                    open_start: found.start(),
                    open_end: None,
                    close_start: None,
                });
            }
            continue;
        }
        if !closing && name == "w:sdtContent" {
            if let Some(top) = stack.last_mut() {
                top.open_end = Some(found.end());
                if self_closing {
                    top.close_start = top.open_end;
                }
            }
            continue;
        }
        if closing && name == "w:sdtContent" {
            if let Some(top) = stack.last_mut() {
                top.close_start = Some(found.start());
            }
            continue;
        }
        if closing
            && name == "w:sdt"
            && let Some(Open {
                open_start,
                open_end: Some(open_end),
                close_start: Some(close_start),
            }) = stack.pop()
        {
            ranges.push(SdtRange {
                open_start,
                open_end,
                close_start,
                close_end: found.end(),
            });
        }
    }
    ranges.sort_by_key(|range| range.open_start);
    Ok(ranges)
}

fn shell_from_range(xml: &str, range: &SdtRange) -> SdtShell {
    SdtShell {
        meta: sdt_meta(slice(xml, range.open_start, range.close_end)),
        open_xml: slice(xml, range.open_start, range.open_end).to_owned(),
        close_xml: slice(xml, range.close_start, range.close_end).to_owned(),
    }
}

/// The controls that enclose `child_start..child_end`, outermost first.
fn chain_of(
    xml: &str,
    ranges: &[SdtRange],
    child_start: usize,
    child_end: usize,
) -> Vec<SdtChainLevel> {
    ranges
        .iter()
        .filter(|range| range.open_start < child_start && range.close_end > child_end)
        .map(|range| SdtChainLevel {
            range: *range,
            shell: shell_from_range(xml, range),
        })
        .collect()
}

/// The outermost shell of a raw `<w:sdt>…</w:sdt>`, the enclosing-control
/// chain, and the first `<w:p>` of its content; `None` without a usable paragraph.
pub fn parse_sdt_block(sdt_xml: &str) -> Result<Option<SdtBlock>, RegexLimit> {
    sdt_block(sdt_xml).transpose()
}

fn sdt_block(sdt_xml: &str) -> Option<Result<SdtBlock, RegexLimit>> {
    let content_open = js_regex!(CONTENT_OPEN).exec(sdt_xml)?;
    let content_tag_end = content_open.end();
    // the last </w:sdtContent>, so nested controls don't truncate the region
    let content_close = sdt_xml.rfind("</w:sdtContent>")?;
    if content_close < content_tag_end {
        return None;
    }

    let inner_content = &sdt_xml[content_tag_end..content_close];
    let p_start = js_regex!(r"<w:p[\s/>]").exec(inner_content)?.start();

    let mut depth = 0i64;
    let mut p_end = None;
    for found in js_regex!(r"<\/?w:p(?=[\s/>])").find_iter(inner_content) {
        if found.as_str().starts_with("</") {
            if depth == 1 {
                // the original adds one unit for the '>' it assumes
                p_end = Some(found.end() + unit_after(inner_content, found.end()));
                break;
            }
            depth -= 1;
        } else {
            depth += 1;
        }
    }
    let p_end = p_end.unwrap_or_else(|| {
        js_regex!(r"<w:p\/>")
            .exec(inner_content)
            .map_or(inner_content.len(), |found| found.end())
    });
    let p_xml = slice(inner_content, p_start, p_end).to_owned();

    let open_xml = &sdt_xml[..content_tag_end];
    let close_xml = &sdt_xml[content_close..];

    let ranges = match sdt_ranges(sdt_xml) {
        Ok(ranges) => ranges,
        Err(limit) => return Some(Err(limit)),
    };
    let mut chain = chain_of(
        sdt_xml,
        &ranges,
        content_tag_end + p_start,
        content_tag_end + p_end,
    );
    if chain.is_empty() {
        chain = vec![SdtChainLevel {
            range: SdtRange {
                open_start: 0,
                open_end: content_tag_end,
                close_start: content_close,
                close_end: sdt_xml.len(),
            },
            shell: SdtShell {
                meta: sdt_meta(sdt_xml),
                open_xml: open_xml.to_owned(),
                close_xml: close_xml.to_owned(),
            },
        }];
    }
    let shell = chain.first()?.shell.clone();
    Some(Ok(SdtBlock {
        shell,
        p_xml,
        chain,
    }))
}

pub fn sdt_meta(sdt_xml: &str) -> SdtMeta {
    let sdt_pr_xml = js_regex!(r"<w:sdtPr>([\s\S]*?)<\/w:sdtPr>")
        .exec(sdt_xml)
        .and_then(|found| found.get(1))
        .unwrap_or("");
    // the caller slices out the single open tag first so the value can't
    // belong to a later sibling element
    let attr_val = |tag: &JsRegex| -> String {
        let tag = tag.exec(sdt_pr_xml).map_or("", |found| found.as_str());
        js_regex!(r#"\bw:val=(?:"([^"]*)"|'([^']*)')"#)
            .exec(tag)
            .and_then(|found| found.get(1).or_else(|| found.get(2)))
            .unwrap_or("")
            .to_owned()
    };
    let alias = attr_val(js_regex!(r"<w:alias[^>]*>"));
    let tag = attr_val(js_regex!(r"<w:tag[^>]*>"));
    let lock = attr_val(js_regex!(r"<w:lock[^>]*>"));
    let id = attr_val(js_regex!(r"<w:id[^>]*>"));
    let control_type = if js_regex!(r"<w:date[\s/>]").test(sdt_pr_xml) {
        "date"
    } else if js_regex!(r"<w:dropDownList[\s/>]|<w:comboBox[\s/>]").test(sdt_pr_xml) {
        "dropdown"
    } else if js_regex!(r"<w:checkbox[\s/>]").test(sdt_pr_xml) {
        "checkbox"
    } else {
        "text"
    };
    SdtMeta {
        alias,
        tag,
        control_type,
        lock,
        id,
    }
}

/// When `<w:sdtContent>` holds several top-level w:p / w:tbl children, each
/// becomes its own block. `None` for 0-1 children.
pub fn split_sdt_parts(sdt_xml: &str) -> Result<Option<Vec<SdtPart>>, RegexLimit> {
    sdt_parts(sdt_xml).transpose()
}

fn sdt_parts(sdt_xml: &str) -> Option<Result<Vec<SdtPart>, RegexLimit>> {
    struct Child<'a> {
        name: &'a str,
        start: usize,
        end: usize,
    }

    let content_open = js_regex!(CONTENT_OPEN).exec(sdt_xml)?;
    let inner_start = content_open.end();
    let inner_end = sdt_xml.rfind("</w:sdtContent>")?;
    if inner_end <= inner_start {
        return None;
    }

    let mut children = Vec::new();
    let mut depth = 0i64;
    let mut start = 0;
    let mut name = "";
    for found in try_js_regex!(TAG).try_find_from(sdt_xml, inner_start) {
        let found = match found {
            Ok(found) => found,
            Err(limit) => return Some(Err(limit)),
        };
        if found.start() >= inner_end {
            break;
        }
        let tag_name = found.get(2).unwrap_or("");
        // nested content controls are transparent containers: descend
        if tag_name == "w:sdt" || tag_name == "w:sdtContent" {
            continue;
        }
        if found.get(1) == Some("/") {
            depth -= 1;
            if depth == 0 {
                children.push(Child {
                    name,
                    start,
                    end: found.end(),
                });
            }
        } else if found.get(3).unwrap_or("").ends_with('/') {
            if depth == 0 {
                children.push(Child {
                    name: tag_name,
                    start: found.start(),
                    end: found.end(),
                });
            }
        } else {
            if depth == 0 {
                start = found.start();
                name = tag_name;
            }
            depth += 1;
        }
    }

    let parts: Vec<Child<'_>> = children
        .into_iter()
        .filter(|child| child.name == "w:p" || child.name == "w:tbl")
        .collect();
    if parts.len() < 2 {
        return None;
    }
    let ranges = match sdt_ranges(sdt_xml) {
        Ok(ranges) => ranges,
        Err(limit) => return Some(Err(limit)),
    };
    Some(Ok(parts
        .iter()
        .enumerate()
        .map(|(k, child)| SdtPart {
            name: child.name.to_owned(),
            start: if k == 0 { 0 } else { child.start },
            end: parts.get(k + 1).map_or(sdt_xml.len(), |next| next.start),
            child_start: child.start,
            child_end: child.end,
            chain: chain_of(sdt_xml, &ranges, child.start, child.end),
        })
        .collect()))
}

/// When a control's content begins with a table (no paragraph before it),
/// the balanced `<w:tbl>…</w:tbl>` slice.
pub fn sdt_table_xml(sdt_xml: &str) -> Option<String> {
    let content_open = js_regex!(CONTENT_OPEN).exec(sdt_xml)?;
    let content_tag_end = content_open.end();
    let content_close = sdt_xml.rfind("</w:sdtContent>")?;
    if content_close <= content_tag_end {
        return None;
    }
    let inner = &sdt_xml[content_tag_end..content_close];
    let tbl_start = js_regex!(r"<w:tbl[\s>]").exec(inner)?.start();
    if let Some(p_start) = js_regex!(r"<w:p[\s/>]").exec(inner)
        && p_start.start() < tbl_start
    {
        return None;
    }
    // balanced </w:tbl> for the opening tag (tables can nest)
    let mut depth = 0i64;
    for found in js_regex!(r"<\/?w:tbl(?=[\s/>])").find_from(inner, tbl_start) {
        if found.as_str().starts_with("</") {
            depth -= 1;
            if depth == 0 {
                // '</w:tbl>'.length: the tag name and the one unit after it
                let end = found.end() + unit_after(inner, found.end());
                return Some(slice(inner, tbl_start, end).to_owned());
            }
        } else {
            depth += 1;
        }
    }
    None
}
