//! The image-source scanner of `apps/markdown/src/main/asset-lifecycle.ts`:
//! where a Markdown text names an image, as a Markdown destination or an HTML
//! `src`, and which of those places a text of code hides.
//!
//! The TypeScript walks UTF-16 code units (`markdown[index]`, `indexOf`,
//! `slice`), so every position here is an index into the text's units.

use jscompat::{Radix, inherited_string, is_js_space, js_regex, parse_int, try_js_regex};

use super::fs_util::plain_error;
use crate::node_fs::NodeError;
use jscompat::JsMap;

/// where a `src` or destination sits and how the replacement is written back
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HtmlQuote {
    /// a Markdown destination (`htmlQuote` is `undefined`)
    Markdown,
    /// an unquoted HTML attribute (`null`)
    Unquoted,
    Double,
    Single,
}

/// `DestinationRange`
#[derive(Debug, Clone, PartialEq)]
pub struct DestinationRange {
    pub start: usize,
    pub end: usize,
    pub source: String,
    pub html_quote: HtmlQuote,
}

/// `ImageSourceScan`
#[derive(Debug, Clone, PartialEq)]
pub struct ImageSourceScan {
    pub ranges: Vec<DestinationRange>,
    pub ambiguous_html: bool,
}

#[derive(Debug, Clone, Copy)]
struct TextRange {
    start: usize,
    end: usize,
}

const fn u(c: char) -> u16 {
    c as u16
}

fn at(text: &[u16], index: usize) -> Option<u16> {
    text.get(index).copied()
}

fn is_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_space)
}

fn string_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn index_of_unit(text: &[u16], unit: u16, from: usize) -> Option<usize> {
    if from >= text.len() {
        return None;
    }
    text[from..]
        .iter()
        .position(|c| *c == unit)
        .map(|i| i + from)
}

fn index_of_units(text: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from > text.len() || text.len() - from < needle.len() {
        return None;
    }
    (from..=text.len() - needle.len()).find(|&i| text[i..i + needle.len()] == *needle)
}

fn starts_with_at(text: &[u16], needle: &str, at: usize) -> bool {
    let needle: Vec<u16> = needle.encode_utf16().collect();
    text.len() >= at + needle.len() && text[at..at + needle.len()] == needle[..]
}

/// `escapedAt(text, index)`: an odd run of backslashes lies before the index
fn escaped_at(text: &[u16], index: usize) -> bool {
    let mut slashes = 0;
    let mut i = index;
    while i > 0 && text[i - 1] == u('\\') {
        slashes += 1;
        i -= 1;
    }
    slashes % 2 == 1
}

fn limit_error() -> NodeError {
    plain_error("Maximum call stack size exceeded")
}

/// `imageDestinationRanges(markdown)`
fn image_destination_ranges(markdown: &[u16]) -> Result<Vec<DestinationRange>, NodeError> {
    let title_re =
        try_js_regex!(r#"\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*$"#);
    let unescape_re = js_regex!(r"\\([\\()[\]<> ])", "g");
    let mut ranges: Vec<DestinationRange> = Vec::new();
    let mut closing_brackets: std::collections::HashMap<usize, usize> =
        std::collections::HashMap::new();
    let mut bracket_stack: Vec<usize> = Vec::new();
    for index in 0..markdown.len() {
        if escaped_at(markdown, index) {
            continue;
        }
        if markdown[index] == u('[') {
            bracket_stack.push(index);
        } else if markdown[index] == u(']')
            && let Some(open) = bracket_stack.pop()
        {
            closing_brackets.insert(open, index);
        }
    }
    let len = markdown.len();
    let mut i = 0usize;
    while (i as i64) < (len as i64) - 2 {
        if markdown[i] != u('!') || markdown[i + 1] != u('[') || escaped_at(markdown, i) {
            i += 1;
            continue;
        }
        let Some(&alt_end) = closing_brackets.get(&(i + 1)) else {
            i += 1;
            continue;
        };
        let mut open = alt_end + 1;
        while matches!(at(markdown, open), Some(c) if c == u(' ') || c == u('\t')) {
            open += 1;
        }
        if at(markdown, open) != Some(u('(')) {
            i = alt_end + 1;
            continue;
        }

        let mut close = open + 1;
        let mut paren_depth = 1i64;
        let mut quote: u16 = 0;
        let mut angle = false;
        while close < len {
            let ch = markdown[close];
            if escaped_at(markdown, close) {
                close += 1;
                continue;
            }
            if quote != 0 {
                if ch == quote {
                    quote = 0;
                }
                close += 1;
                continue;
            }
            if angle {
                if ch == u('>') {
                    angle = false;
                }
                close += 1;
                continue;
            }
            if ch == u('"') || ch == u('\'') {
                quote = ch;
            } else if ch == u('<') {
                angle = true;
            } else if ch == u('(') {
                paren_depth += 1;
            } else if ch == u(')') {
                paren_depth -= 1;
                if paren_depth == 0 {
                    break;
                }
            }
            close += 1;
        }
        if paren_depth != 0 {
            i += 1;
            continue;
        }

        let mut start = open + 1;
        let mut end = close;
        while start < end && is_space(markdown[start]) {
            start += 1;
        }
        while end > start && is_space(markdown[end - 1]) {
            end -= 1;
        }
        if at(markdown, start) == Some(u('<')) {
            if let Some(angle_end) = index_of_unit(markdown, u('>'), start + 1)
                && angle_end > start
                && angle_end <= end
            {
                start += 1;
                end = angle_end;
            }
        } else {
            let raw = string_of(&markdown[start..end]);
            let title = title_re.try_exec(&raw).map_err(|_| limit_error())?;
            if let Some(title) = title {
                // `title.index` counts UTF-16 units
                end = start + raw[..title.start()].encode_utf16().count();
            }
            while end > start && is_space(markdown[end - 1]) {
                end -= 1;
            }
        }
        if end > start {
            let raw_source = string_of(&markdown[start..end]);
            let source =
                unescape_re.replace_all(&raw_source, |m| m.get(1).unwrap_or("").to_owned());
            ranges.push(DestinationRange {
                start,
                end,
                source,
                html_quote: HtmlQuote::Markdown,
            });
        }
        i = close + 1;
    }
    Ok(ranges)
}

/// `decodeHtmlImageSource(value)`
fn decode_html_image_source(value: &str) -> (String, bool) {
    let mut ambiguous = false;
    let source = js_regex!(r"&([^&;\s]+);", "g").replace_all(value, |m| {
        let entity = m.as_str();
        let body = m.get(1).unwrap_or("");
        if body.starts_with('#') {
            let hexadecimal = body.chars().nth(1).is_some_and(|c| c == 'x' || c == 'X');
            let digits = &body[if hexadecimal { 2 } else { 1 }..];
            let valid = !digits.is_empty()
                && if hexadecimal {
                    digits.chars().all(|c| c.is_ascii_hexdigit())
                } else {
                    digits.chars().all(|c| c.is_ascii_digit())
                };
            if !valid {
                ambiguous = true;
                return entity.to_owned();
            }
            let code_point = parse_int(
                digits,
                if hexadecimal {
                    Radix::Sixteen
                } else {
                    Radix::Ten
                },
            );
            if code_point <= 0.0
                || code_point > f64::from(0x10ffff_u32)
                || (code_point >= f64::from(0xd800_u32) && code_point <= f64::from(0xdfff_u32))
            {
                ambiguous = true;
                return entity.to_owned();
            }
            return char::from_u32(code_point as u32)
                .map_or_else(|| entity.to_owned(), |c| c.to_string());
        }
        // `BASIC_HTML_ENTITIES[body.toLowerCase()]` is a plain object: its
        // prototype answers for these two names
        match body.to_lowercase().as_str() {
            "amp" => "&".to_owned(),
            "apos" => "'".to_owned(),
            "gt" => ">".to_owned(),
            "lt" => "<".to_owned(),
            "nbsp" => "\u{a0}".to_owned(),
            "quot" => "\"".to_owned(),
            key => match inherited_string(key) {
                Some(inherited) => inherited.to_owned(),
                None => {
                    // the complete HTML named-entity table is intentionally not duplicated
                    ambiguous = true;
                    entity.to_owned()
                }
            },
        }
    });
    if source.contains("&#") {
        ambiguous = true;
    }
    (source, ambiguous)
}

struct ParsedTag {
    next_index: usize,
    range: Option<DestinationRange>,
    ambiguous: bool,
}

/// `parseHtmlImageTag(text, tagStart)`
fn parse_html_image_tag(text: &[u16], tag_start: usize) -> ParsedTag {
    let len = text.len();
    let mut cursor = tag_start + 4;
    let mut source_range: Option<DestinationRange> = None;
    let mut ambiguous = false;

    while cursor < len {
        while cursor < len && is_space(text[cursor]) {
            cursor += 1;
        }
        if cursor >= len {
            return ParsedTag {
                next_index: len,
                range: None,
                ambiguous: true,
            };
        }
        if text[cursor] == u('>') {
            return ParsedTag {
                next_index: cursor + 1,
                range: if ambiguous { None } else { source_range },
                ambiguous,
            };
        }
        if text[cursor] == u('/') && at(text, cursor + 1) == Some(u('>')) {
            return ParsedTag {
                next_index: cursor + 2,
                range: if ambiguous { None } else { source_range },
                ambiguous,
            };
        }
        if text[cursor] == u('/') {
            ambiguous = true;
            cursor += 1;
            continue;
        }

        let name_start = cursor;
        while cursor < len
            && !is_space(text[cursor])
            && text[cursor] != u('=')
            && text[cursor] != u('/')
            && text[cursor] != u('>')
        {
            cursor += 1;
        }
        if cursor == name_start {
            ambiguous = true;
            cursor += 1;
            continue;
        }
        let attribute_name = string_of(&text[name_start..cursor]).to_lowercase();
        while cursor < len && is_space(text[cursor]) {
            cursor += 1;
        }
        if at(text, cursor) != Some(u('=')) {
            if attribute_name == "src" {
                ambiguous = true;
            }
            continue;
        }

        cursor += 1;
        while cursor < len && is_space(text[cursor]) {
            cursor += 1;
        }
        if cursor >= len
            || text[cursor] == u('>')
            || (text[cursor] == u('/') && at(text, cursor + 1) == Some(u('>')))
        {
            if attribute_name == "src" {
                ambiguous = true;
            }
            continue;
        }

        let quote = if text[cursor] == u('"') {
            HtmlQuote::Double
        } else if text[cursor] == u('\'') {
            HtmlQuote::Single
        } else {
            HtmlQuote::Unquoted
        };
        let value_start;
        let value_end;
        if quote != HtmlQuote::Unquoted {
            let quote_unit = if quote == HtmlQuote::Double {
                u('"')
            } else {
                u('\'')
            };
            value_start = cursor + 1;
            match index_of_unit(text, quote_unit, value_start) {
                Some(found) => value_end = found,
                None => {
                    return ParsedTag {
                        next_index: len,
                        range: None,
                        ambiguous: true,
                    };
                }
            }
            cursor = value_end + 1;
        } else {
            value_start = cursor;
            while cursor < len
                && !is_space(text[cursor])
                && text[cursor] != u('>')
                && !(text[cursor] == u('/') && at(text, cursor + 1) == Some(u('>')))
            {
                let c = text[cursor];
                if c == u('"') || c == u('\'') || c == u('`') || c == u('<') || c == u('=') {
                    ambiguous = true;
                }
                cursor += 1;
            }
            value_end = cursor;
            if value_end == value_start && attribute_name == "src" {
                ambiguous = true;
            }
        }

        if attribute_name != "src" {
            continue;
        }
        if source_range.is_some() {
            ambiguous = true;
            continue;
        }
        let (source, decoded_ambiguous) =
            decode_html_image_source(&string_of(&text[value_start..value_end]));
        if decoded_ambiguous {
            ambiguous = true;
        }
        source_range = Some(DestinationRange {
            start: value_start,
            end: value_end,
            source,
            html_quote: quote,
        });
    }
    ParsedTag {
        next_index: len,
        range: None,
        ambiguous: true,
    }
}

/// `positionInRanges(ranges, position)`: a binary search
fn position_in_ranges(ranges: &[TextRange], position: usize) -> Option<TextRange> {
    let mut low: i64 = 0;
    let mut high: i64 = ranges.len() as i64 - 1;
    while low <= high {
        let middle = (low + high) / 2;
        let range = ranges[middle as usize];
        if position < range.start {
            high = middle - 1;
        } else if position >= range.end {
            low = middle + 1;
        } else {
            return Some(range);
        }
    }
    None
}

/// whether `line` is a closing fence of `length` or more `marker` characters:
/// `^ {0,3}\<marker>{length,}[ \t]*$`
fn closes_fence(line: &str, marker: char, length: usize) -> bool {
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return false;
    }
    let run = rest.chars().take_while(|c| *c == marker).count();
    run >= length
        && rest[run * marker.len_utf8()..]
            .chars()
            .all(|c| c == ' ' || c == '\t')
}

/// `markdownCodeRanges(markdown)`: fenced, indented and inline code ranges
/// where image-looking text is not rendered content.
fn markdown_code_ranges(markdown: &[u16]) -> Vec<TextRange> {
    let text = string_of(markdown);
    let open_re = js_regex!(r"^ {0,3}(`{3,}|~{3,})(.*)$");
    let mut block_ranges: Vec<TextRange> = Vec::new();
    // marker, length, start
    let mut fence: Option<(char, usize, usize)> = None;
    let mut offset = 0usize;
    for found in js_regex!(r".*(?:\n|$)", "g").find_iter(&text) {
        let line_with_break = found.as_str();
        if line_with_break.is_empty() {
            continue;
        }
        let line = line_with_break
            .strip_suffix('\n')
            .unwrap_or(line_with_break);
        let line_end = offset + line_with_break.encode_utf16().count();
        if let Some((marker, length, start)) = fence {
            if closes_fence(line, marker, length) {
                block_ranges.push(TextRange {
                    start,
                    end: line_end,
                });
                fence = None;
            }
        } else {
            let open = open_re.exec(line);
            let opened = open.as_ref().and_then(|open| {
                let run = open.get(1)?;
                let first = run.chars().next()?;
                (first == '~' || !open.get(2).unwrap_or("").contains('`'))
                    .then(|| (first, run.encode_utf16().count()))
            });
            if let Some((marker, length)) = opened {
                fence = Some((marker, length, offset));
            } else if line.starts_with("    ") || line.starts_with('\t') {
                block_ranges.push(TextRange {
                    start: offset,
                    end: line_end,
                });
            }
        }
        offset = line_end;
    }
    if let Some((_, _, start)) = fence {
        block_ranges.push(TextRange {
            start,
            end: markdown.len(),
        });
    }
    block_ranges.sort_by_key(|range| range.start);

    let mut ranges = block_ranges.clone();
    let backtick = u('`');
    let len = markdown.len();
    let mut index = 0usize;
    while index < len {
        if let Some(block) = position_in_ranges(&block_ranges, index) {
            index = block.end;
            continue;
        }
        if markdown[index] != backtick || escaped_at(markdown, index) {
            index += 1;
            continue;
        }
        let mut run_end = index + 1;
        while at(markdown, run_end) == Some(backtick) {
            run_end += 1;
        }
        let run_length = run_end - index;
        let mut search = run_end;
        let mut close_end: Option<usize> = None;
        while search < len {
            if let Some(blocked) = position_in_ranges(&block_ranges, search) {
                search = blocked.end;
                continue;
            }
            let Some(next) = index_of_unit(markdown, backtick, search) else {
                break;
            };
            let mut next_end = next + 1;
            while at(markdown, next_end) == Some(backtick) {
                next_end += 1;
            }
            if next_end - next == run_length {
                close_end = Some(next_end);
                break;
            }
            search = next_end;
        }
        match close_end {
            Some(close_end) => {
                ranges.push(TextRange {
                    start: index,
                    end: close_end,
                });
                index = close_end;
            }
            // an unmatched run is literal Markdown, so later HTML may still render
            None => index = run_end,
        }
    }
    ranges.sort_by_key(|range| range.start);
    ranges
}

/// `htmlImageSourceRanges(markdown, codeRanges)`
fn html_image_source_ranges(
    markdown: &[u16],
    code_ranges: &[TextRange],
) -> (Vec<DestinationRange>, bool) {
    let mut ranges: Vec<DestinationRange> = Vec::new();
    let mut ambiguous_html = false;
    let len = markdown.len();
    let mut index = 0usize;
    while index < len {
        if let Some(code) = position_in_ranges(code_ranges, index) {
            index = code.end;
            continue;
        }
        if markdown[index] != u('<') {
            index += 1;
            continue;
        }
        if starts_with_at(markdown, "<!--", index) {
            let dashes: Vec<u16> = "-->".encode_utf16().collect();
            match index_of_units(markdown, &dashes, index + 4) {
                None => {
                    let rest = if index + 4 <= len {
                        string_of(&markdown[index + 4..])
                    } else {
                        String::new()
                    };
                    if js_regex!(r"<img(?:\s|\/|>)", "i").test(&rest) {
                        ambiguous_html = true;
                    }
                    break;
                }
                Some(comment_end) => {
                    index = comment_end + 3;
                    continue;
                }
            }
        }
        let tag_name = string_of(&markdown[(index + 1).min(len)..(index + 4).min(len)]);
        if tag_name.to_lowercase() != "img"
            || (index + 4 < len
                && !(is_space(markdown[index + 4])
                    || markdown[index + 4] == u('/')
                    || markdown[index + 4] == u('>')))
        {
            index += 1;
            continue;
        }
        let parsed = parse_html_image_tag(markdown, index);
        if parsed.ambiguous {
            ambiguous_html = true;
        }
        if let Some(range) = parsed.range {
            ranges.push(range);
        }
        index = index.max(parsed.next_index.saturating_sub(1)) + 1;
    }
    (ranges, ambiguous_html)
}

/// `scanImageSources(markdown)`
pub fn scan_image_sources(markdown: &str) -> Result<ImageSourceScan, NodeError> {
    let units: Vec<u16> = markdown.encode_utf16().collect();
    let code_ranges = markdown_code_ranges(&units);
    let (html_ranges, mut ambiguous_html) = html_image_source_ranges(&units, &code_ranges);
    let markdown_ranges: Vec<DestinationRange> = image_destination_ranges(&units)?
        .into_iter()
        .filter(|range| position_in_ranges(&code_ranges, range.start).is_none())
        .collect();
    let mut ordered: Vec<DestinationRange> = markdown_ranges;
    ordered.extend(html_ranges);
    ordered.sort_by(|left, right| left.start.cmp(&right.start).then(left.end.cmp(&right.end)));
    let mut ranges: Vec<DestinationRange> = Vec::new();
    for range in ordered {
        if let Some(previous) = ranges.last()
            && range.start < previous.end
        {
            ambiguous_html = true;
            continue;
        }
        ranges.push(range);
    }
    Ok(ImageSourceScan {
        ranges,
        ambiguous_html,
    })
}

/// `extractMarkdownImageSources(markdown)`
pub fn extract_markdown_image_sources(markdown: &str) -> Result<Vec<String>, NodeError> {
    Ok(scan_image_sources(markdown)?
        .ranges
        .into_iter()
        .map(|range| range.source)
        .collect())
}

/// `encodeHtmlAttributeReplacement(value, quote)`
fn encode_html_attribute_replacement(value: &str, quote: HtmlQuote) -> String {
    let mut encoded = String::new();
    for character in value.chars() {
        if character == '&' {
            encoded.push_str("&amp;");
        } else if character == '<' {
            encoded.push_str("&lt;");
        } else if quote == HtmlQuote::Double && character == '"' {
            encoded.push_str("&quot;");
        } else if quote == HtmlQuote::Single && character == '\'' {
            encoded.push_str("&#39;");
        } else if quote == HtmlQuote::Unquoted
            && (is_js_space(character) || matches!(character, '"' | '\'' | '`' | '=' | '>'))
        {
            encoded.push_str(&format!("&#{};", character as u32));
        } else {
            encoded.push(character);
        }
    }
    encoded
}

/// `rewriteMarkdownImageSources(markdown, rewrites)`
pub fn rewrite_markdown_image_sources(
    markdown: &str,
    rewrites: &JsMap<String>,
) -> Result<String, NodeError> {
    if rewrites.is_empty() {
        return Ok(markdown.to_owned());
    }
    let units: Vec<u16> = markdown.encode_utf16().collect();
    let ranges = scan_image_sources(markdown)?.ranges;
    let mut cursor = 0usize;
    let mut output: Vec<u16> = Vec::new();
    for range in ranges {
        let Some(replacement) = rewrites.get(&range.source) else {
            continue;
        };
        output.extend_from_slice(&units[cursor..range.start]);
        let written = if range.html_quote == HtmlQuote::Markdown {
            replacement.clone()
        } else {
            encode_html_attribute_replacement(replacement, range.html_quote)
        };
        output.extend(written.encode_utf16());
        cursor = range.end;
    }
    if cursor == 0 {
        return Ok(markdown.to_owned());
    }
    output.extend_from_slice(&units[cursor..]);
    Ok(string_of(&output))
}
