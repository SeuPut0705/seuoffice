//! The measurement's own reader: a plain tag walk over the XML text, sharing
//! no code with either way.

use std::ops::Range;

use ooxml_xml::{opaque_end, tag_at};

/// A `w:r` not inside another `w:r`, with the content ranges of its `w:t`
/// children.
#[derive(Debug, Clone)]
pub struct ProbeRun {
    pub range: Range<usize>,
    pub texts: Vec<Range<usize>>,
}

pub fn paragraph_runs(xml: &str, para: Range<usize>) -> Vec<ProbeRun> {
    let mut runs: Vec<ProbeRun> = Vec::new();
    let mut depth = 0usize;
    let mut run_depth: Option<usize> = None;
    let mut text_start: Option<usize> = None;
    let mut cursor = para.start;
    while let Some(found) = xml[cursor..para.end].find('<') {
        let start = cursor + found;
        if let Some(end) = opaque_end(xml, start) {
            cursor = end;
            continue;
        }
        let tag = tag_at(xml, start);
        cursor = tag.end;
        if tag.closing {
            depth = depth.saturating_sub(1);
            if run_depth.is_some_and(|d| depth == d + 1)
                && tag.name == "w:t"
                && let (Some(content), Some(run)) = (text_start.take(), runs.last_mut())
            {
                run.texts.push(content..tag.start);
            }
            if run_depth == Some(depth) {
                run_depth = None;
                if let Some(run) = runs.last_mut() {
                    run.range.end = tag.end;
                }
            }
        } else if tag.name == "w:r" && run_depth.is_none() {
            runs.push(ProbeRun {
                range: tag.start..tag.end,
                texts: Vec::new(),
            });
            if !tag.self_closing {
                run_depth = Some(depth);
                depth += 1;
            }
        } else if !tag.self_closing {
            if tag.name == "w:t" && run_depth.is_some_and(|d| depth == d + 1) {
                text_start = Some(tag.end);
            }
            depth += 1;
        }
    }
    runs
}

/// Paragraph text of the body as a reader sees it: `w:t` content decoded,
/// `w:tab`, `w:br` and `w:cr` of a run as characters, one mark per paragraph
/// end. `replace` substitutes the decoded content of one `w:t`, given by its
/// content range.
pub fn body_text(xml: &str, replace: Option<(Range<usize>, &str)>) -> Result<String, String> {
    let scan = docx_engine::scan::scan_body(xml).map_err(|e| e.to_string())?;
    let end = scan.body_content_end;
    let mut out = String::new();
    let mut stack: Vec<&str> = Vec::new();
    let mut text_start: Option<usize> = None;
    let mut cursor = scan.body_content_start;
    while let Some(found) = xml[cursor..end].find('<') {
        let start = cursor + found;
        if let Some(close) = opaque_end(xml, start) {
            cursor = close;
            continue;
        }
        let tag = tag_at(xml, start);
        cursor = tag.end;
        let in_run = stack.last() == Some(&"w:r");
        if tag.closing {
            stack.pop();
            if tag.name == "w:t" {
                if let Some(content) = text_start.take() {
                    match &replace {
                        Some((range, text)) if *range == (content..tag.start) => out.push_str(text),
                        _ => decode(&xml[content..tag.start], &mut out),
                    }
                }
            } else if tag.name == "w:p" {
                out.push('\u{b6}');
            }
            continue;
        }
        match tag.name {
            "w:tab" if in_run => out.push('\t'),
            "w:br" | "w:cr" if in_run => out.push('\n'),
            "w:p" if tag.self_closing => out.push('\u{b6}'),
            "w:t" if !tag.self_closing => text_start = Some(tag.end),
            _ => {}
        }
        if !tag.self_closing {
            stack.push(tag.name);
        }
    }
    Ok(out)
}

/// XML text content decoded: line ends normalized, predefined entities and
/// character references resolved; anything unknown kept as written.
pub fn decode(raw: &str, out: &mut String) {
    let raw = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut rest = raw.as_str();
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(semi) = rest.find(';') else { break };
        let name = &rest[1..semi];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => name
                .strip_prefix("#x")
                .map(|hex| u32::from_str_radix(hex, 16))
                .or_else(|| name.strip_prefix('#').map(str::parse::<u32>))
                .and_then(Result::ok)
                .and_then(char::from_u32),
        };
        match ch {
            Some(ch) => {
                out.push(ch);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
}
