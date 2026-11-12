//! `packages/electron-utils/src/remote-table.ts`.
//!
//! `parse5`'s `parseFragment` is `crate::html_parse::parse_fragment` (html5ever).
//! The fetch takes the resolver, the fetcher and the timeout signal from the
//! caller (`AbortSignal.timeout(REMOTE_TABLE_TIMEOUT_MS)`).

use jscompat::{js_regex, slice_utf16, text_decoder_decode, trim};
use serde::Serialize;

use super::remote_image::read_body_capped;
use super::safe_remote_url::{
    AbortSignal, FetchWithSsrfGuardOptions, Fetcher, Resolver, fetch_with_ssrf_guard,
};
use crate::html_parse::{Node, parse_fragment};

/// A table this large is already past what a spreadsheet shows; the cap keeps
/// a hostile page from turning into an allocation spike.
pub const MAX_REMOTE_TABLE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_REMOTE_TABLE_ROWS: usize = 50_000;
pub const MAX_REMOTE_TABLE_COLUMNS: usize = 1_000;
/// Cells longer than this are clipped: a page can put a whole document into
/// one cell, and the value would be unreadable in the grid anyway.
pub const MAX_REMOTE_TABLE_CELL_CHARS: usize = 32_767;
/// A server that trickles its answer must not pin the refresh forever: the
/// fetch owns a deadline (the caller builds the signal from it).
pub const REMOTE_TABLE_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTableSource {
    Html,
    Csv,
}

/// `RemoteTable`; the fields in the order the TypeScript writes them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteTable {
    /// The first row of the source, treated as the header.
    pub headers: Vec<String>,
    /// Data rows, header excluded.
    pub rows: Vec<Vec<String>>,
    pub source: RemoteTableSource,
    /// The address the table came from.
    pub url: String,
}

/// Visible text of a node: text descendants. A comment has no children.
fn text_of(node: &Node) -> String {
    match node {
        Node::Text(value) => value.clone(),
        Node::Comment(_) => String::new(),
        Node::Element(element) => element.children.iter().map(text_of).collect(),
    }
}

fn find_elements<'a>(node: &'a Node, tag_name: &str, out: &mut Vec<&'a Node>) {
    if let Node::Element(element) = node {
        if element.name == tag_name {
            out.push(node);
        }
        for child in &element.children {
            find_elements(child, tag_name, out);
        }
    }
}

fn cells_of(row: &Node) -> Vec<String> {
    let mut cells = Vec::new();
    let Node::Element(row) = row else {
        return cells;
    };
    for cell in &row.children {
        let Node::Element(element) = cell else {
            continue;
        };
        if element.name != "td" && element.name != "th" {
            continue;
        }
        let collapsed = js_regex!(r"\s+", "g").replace_all(&text_of(cell), |_| " ".to_owned());
        cells.push(trim(&collapsed).to_owned());
    }
    cells
}

fn rows_of(table: &Node) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut trs = Vec::new();
    find_elements(table, "tr", &mut trs);
    for tr in trs {
        let cells = cells_of(tr);
        if !cells.is_empty() {
            rows.push(cells);
        }
        if rows.len() >= MAX_REMOTE_TABLE_ROWS {
            break;
        }
    }
    rows
}

/// The widest row, capped, and every row cut to it.
fn normalize(rows: Vec<Vec<String>>) -> Vec<Vec<String>> {
    let widest = rows.iter().map(Vec::len).max().unwrap_or(0);
    let width = widest.min(MAX_REMOTE_TABLE_COLUMNS);
    rows.into_iter()
        .map(|mut row| {
            row.truncate(width);
            row
        })
        .collect()
}

/// The table a page offers. Excel's web query takes the first table on the page
/// unless the query says otherwise, so that is what this does too, but a page
/// whose first table is a one-cell layout wrapper would be useless, so the
/// widest table wins when the first one is empty.
pub fn parse_html_table(html: &str) -> Option<RemoteTable> {
    let fragment = parse_fragment(html);
    let mut tables = Vec::new();
    for node in &fragment {
        find_elements(node, "table", &mut tables);
    }
    if tables.is_empty() {
        return None;
    }
    // the stable sort by descending length, first of the longest
    let mut candidate: Option<Vec<Vec<String>>> = None;
    for table in tables {
        let rows = rows_of(table);
        if rows.is_empty() {
            continue;
        }
        if candidate
            .as_ref()
            .is_none_or(|best| rows.len() > best.len())
        {
            candidate = Some(rows);
        }
    }
    let candidate = candidate?;
    let mut normalized = normalize(candidate).into_iter();
    let headers = normalized.next().unwrap_or_default();
    Some(RemoteTable {
        headers,
        rows: normalized.collect(),
        source: RemoteTableSource::Html,
        url: String::new(),
    })
}

/// The first 64 KiB of UTF-16 units of `text`; a pair cut in half holds no
/// character the delimiter count reads.
fn sample_of(text: &str) -> &str {
    let mut units = 0usize;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > 64 * 1024 {
            return &text[..at];
        }
    }
    text
}

/// Picks the delimiter a delimited file uses, by counting candidates per line.
pub fn detect_delimiter(text: &str) -> char {
    let sample = sample_of(text);
    let mut best = ',';
    let mut best_count = 0usize;
    for candidate in [',', '\t', ';'] {
        let mut count = 0usize;
        let mut in_quotes = false;
        for ch in sample.chars() {
            if ch == '"' {
                in_quotes = !in_quotes;
            } else if ch == candidate && !in_quotes {
                count += 1;
            }
        }
        if count > best_count {
            best = candidate;
            best_count = count;
        }
    }
    best
}

/// One delimited row, with the quoting rules Excel writes. JavaScript reads
/// the line by UTF-16 unit, so a delimiter longer than one unit never matches.
pub fn parse_delimited_row(line: &str, delimiter: &str) -> Vec<String> {
    let mut delimiter_chars = delimiter.chars();
    let delimiter_char = match (delimiter_chars.next(), delimiter_chars.next()) {
        (Some(c), None) if c.len_utf16() == 1 => Some(c),
        _ => None,
    };
    let chars: Vec<char> = line.chars().collect();
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    current.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
                i += 1;
                continue;
            }
            current.push(ch);
            i += 1;
            continue;
        }
        if ch == '"' && current.is_empty() {
            in_quotes = true;
            i += 1;
            continue;
        }
        if Some(ch) == delimiter_char {
            cells.push(std::mem::take(&mut current));
            i += 1;
            continue;
        }
        current.push(ch);
        i += 1;
    }
    cells.push(current);
    cells
}

/// A delimited file as a table. Excel's web query treats the first row as the
/// header, and so does this. `delimiter` is `None` where it is left out.
pub fn parse_delimited_table(text: &str, delimiter: Option<&str>) -> Option<RemoteTable> {
    let body = js_regex!(r"^\uFEFF").replace_all(text, |_| String::new());
    let lines: Vec<&str> = js_regex!(r"\r\n|\n|\r")
        .split(&body)
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    let detected;
    let sep = match delimiter {
        Some(sep) => sep,
        None => {
            detected = detect_delimiter(&body).to_string();
            &detected
        }
    };
    let parsed: Vec<Vec<String>> = lines
        .into_iter()
        .take(MAX_REMOTE_TABLE_ROWS)
        .map(|line| parse_delimited_row(line, sep))
        .collect();
    let mut normalized = normalize(parsed).into_iter();
    let headers = normalized.next().unwrap_or_default();
    Some(RemoteTable {
        headers,
        rows: normalized.collect(),
        source: RemoteTableSource::Csv,
        url: String::new(),
    })
}

fn clip_cell(text: &str) -> String {
    if text.encode_utf16().count() > MAX_REMOTE_TABLE_CELL_CHARS {
        format!(
            "{}\u{2026}",
            slice_utf16(text, 0.0, Some((MAX_REMOTE_TABLE_CELL_CHARS - 1) as f64))
        )
    } else {
        text.to_owned()
    }
}

/// Clips every cell and drops a trailing empty row, as a page often ends with one.
fn finish(table: RemoteTable) -> RemoteTable {
    let clip = |row: &[String]| -> Vec<String> { row.iter().map(|cell| clip_cell(cell)).collect() };
    let mut rows: Vec<Vec<String>> = table.rows.iter().map(|row| clip(row)).collect();
    while rows
        .last()
        .is_some_and(|row| row.iter().all(|cell| cell.is_empty()))
    {
        rows.pop();
    }
    RemoteTable {
        headers: clip(&table.headers),
        rows,
        ..table
    }
}

/// Fetches a table over HTTP. Returns none when the address is refused by the
/// SSRF gate, the answer is not a table, or the body cannot be read: the
/// caller shows the same "could not refresh" message for all of them. `signal`
/// is the deadline (`AbortSignal.timeout(REMOTE_TABLE_TIMEOUT_MS)`).
pub fn fetch_remote_table(
    resolver: &mut dyn Resolver,
    fetcher: &mut dyn Fetcher,
    signal: &dyn AbortSignal,
    raw_url: &str,
) -> Option<RemoteTable> {
    let mut options = FetchWithSsrfGuardOptions {
        headers: Some(vec![
            ("User-Agent".to_owned(), "Mozilla/5.0".to_owned()),
            (
                "Accept".to_owned(),
                "text/html,application/xhtml+xml,text/csv,text/plain;q=0.9,*/*;q=0.5".to_owned(),
            ),
        ]),
        signal: Some(signal),
        ..FetchWithSsrfGuardOptions::default()
    };
    let mut response = fetch_with_ssrf_guard(resolver, fetcher, raw_url, &mut options)
        .ok()
        .flatten()?;
    if !response.ok() {
        return None;
    }
    let bytes = read_body_capped(response.as_mut(), MAX_REMOTE_TABLE_BYTES as f64).ok()?;
    let content_type = response.header("content-type").unwrap_or_default();
    let text = text_decoder_decode(&bytes);
    let looks_delimited =
        js_regex!(r"text\/csv|text\/plain|application\/csv", "i").test(&content_type);
    // A CSV answer sometimes arrives as text/html. Falling back to the delimited
    // reader is only safe while the body does not look like markup: otherwise
    // every page on the web would come back as a one-row table.
    let looks_like_markup = js_regex!(r"<[a-z!/][\s\S]*>", "i").test(&text);
    let table = if looks_delimited {
        parse_delimited_table(&text, None)
    } else {
        parse_html_table(&text).or_else(|| {
            if looks_like_markup {
                None
            } else {
                parse_delimited_table(&text, None)
            }
        })
    }?;
    Some(RemoteTable {
        url: raw_url.to_owned(),
        ..finish(table)
    })
}
