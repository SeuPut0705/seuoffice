//! The text parsers of `extract.ts`: what `parseFileToText` wrote, read back
//! into the cards the preview draws. The regular expressions of the
//! TypeScript are read by hand here: each is anchored and has one short loop,
//! and `.` and `\s` keep their JavaScript meaning (a line terminator ends
//! `.`, `is_js_space` is `\s`).

use jscompat::{is_js_space, trim};

use super::{BlockKind, DocBlock, MindmapNode, MindmapSheet, Sheet, Slide};

const MAX_SHEETS: usize = 8;
const MAX_SHEET_ROWS: usize = 50;
const MAX_SHEET_COLS: usize = 15;
const MAX_SLIDES: usize = 30;
const MAX_MINDMAP_SHEETS: usize = 6;
const MAX_MINDMAP_NODES: usize = 120;
const MAX_DOC_BLOCKS: usize = 120;

/// `text.split(/\r?\n/)`: a `\r` stays where no `\n` follows it
fn lines_of(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        if let Some(stripped) = line.strip_suffix('\r') {
            *line = stripped;
        }
    }
    lines
}

/// `/\s+(.*)$/` at the start of `rest`: the text after the first run of
/// white space, when that text holds no line terminator (`.` stops at one)
fn after_space(rest: &str) -> Option<&str> {
    let tail = rest.trim_start_matches(is_js_space);
    if tail.len() == rest.len() || tail.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(tail)
}

/// A word character of `\b`
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `^<hashes>\s+<word>` (the word without case) and `\b`: the text after the word
fn heading_word<'a>(line: &'a str, hashes: &str, word: &str) -> Option<&'a str> {
    heading_word_open(line, hashes, word).filter(|tail| !tail.starts_with(is_word))
}

fn split_delimited_line(line: &str, delimiter: char) -> Vec<String> {
    if delimiter == '\t' {
        return line.split('\t').map(str::to_owned).collect();
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' && chars.peek() == Some(&'"') {
                cur.push('"');
                chars.next();
            } else if ch == '"' {
                in_quotes = false;
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == delimiter {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(ch);
        }
    }
    out.push(cur);
    out
}

/// `parseDelimitedSheet(name, text, delimiter)`
fn parse_delimited_sheet(name: &str, text: &str, delimiter: char) -> Sheet {
    let mut lines = lines_of(text);
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let truncated_rows = lines.len() > MAX_SHEET_ROWS;
    let mut truncated_cols = false;
    let rows = lines
        .iter()
        .take(MAX_SHEET_ROWS)
        .map(|line| {
            let mut cells = split_delimited_line(line, delimiter);
            if cells.len() > MAX_SHEET_COLS {
                truncated_cols = true;
                cells.truncate(MAX_SHEET_COLS);
            }
            cells
        })
        .collect();
    Sheet {
        name: name.to_owned(),
        rows,
        truncated_rows,
        truncated_cols,
    }
}

/// `parseSheetsFromText(text, ext, fallbackName)`
pub fn parse_sheets_from_text(text: &str, ext: &str, fallback_name: &str) -> (Vec<Sheet>, bool) {
    if ext == "csv" || ext == "tsv" {
        let sheet =
            parse_delimited_sheet(fallback_name, text, if ext == "tsv" { '\t' } else { ',' });
        let truncated = sheet.truncated_rows || sheet.truncated_cols;
        return (vec![sheet], truncated);
    }

    let mut raw: Vec<(String, Vec<&str>)> = Vec::new();
    for line in lines_of(text) {
        if let Some(title) = line.strip_prefix("# ") {
            let title = trim(title);
            let name = if title.is_empty() {
                format!("Sheet {}", raw.len() + 1)
            } else {
                title.to_owned()
            };
            raw.push((name, Vec::new()));
            continue;
        }
        if raw.is_empty() {
            if trim(line).is_empty() {
                continue;
            }
            raw.push((fallback_name.to_owned(), Vec::new()));
        }
        if !trim(line).is_empty() {
            raw.last_mut()
                .expect("a sheet was just pushed")
                .1
                .push(line);
        }
    }

    let mut truncated = raw.len() > MAX_SHEETS;
    let sheets = raw
        .into_iter()
        .take(MAX_SHEETS)
        .map(|(name, lines)| {
            let truncated_rows = lines.len() > MAX_SHEET_ROWS;
            let mut truncated_cols = false;
            let rows = lines
                .iter()
                .take(MAX_SHEET_ROWS)
                .map(|row_line| {
                    let mut cells: Vec<String> = row_line.split(" | ").map(str::to_owned).collect();
                    if cells.len() > MAX_SHEET_COLS {
                        truncated_cols = true;
                        cells.truncate(MAX_SHEET_COLS);
                    }
                    cells
                })
                .collect();
            if truncated_rows || truncated_cols {
                truncated = true;
            }
            Sheet {
                name,
                rows,
                truncated_rows,
                truncated_cols,
            }
        })
        .collect();
    (sheets, truncated)
}

/// `^<hashes>\s+<word>` without the closing `\b`: the text after the word
fn heading_word_open<'a>(line: &'a str, hashes: &str, word: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(hashes)?;
    let spaced = rest.trim_start_matches(is_js_space);
    if spaced.len() == rest.len() {
        return None;
    }
    let head = spaced.get(..word.len())?;
    head.eq_ignore_ascii_case(word)
        .then(|| &spaced[word.len()..])
}

/// `/^##\s+Slide\s+(\d+)\b/i`: the slide's number
fn slide_number(line: &str) -> Option<f64> {
    let after = heading_word_open(line, "##", "slide")?;
    let rest = after.trim_start_matches(is_js_space);
    if rest.len() == after.len() {
        return None;
    }
    let digits_end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if digits_end == 0 || rest[digits_end..].starts_with(is_word) {
        return None;
    }
    rest[..digits_end].parse().ok()
}

/// `parseSlidesFromText(text)`
pub fn parse_slides_from_text(text: &str) -> (Vec<Slide>, bool) {
    #[derive(PartialEq)]
    enum Section {
        Body,
        Notes,
        Other,
    }
    let mut slides: Vec<Slide> = Vec::new();
    let mut section = Section::Body;

    for line in lines_of(text) {
        if let Some(number) = slide_number(line) {
            slides.push(Slide {
                number,
                title: String::new(),
                bullets: Vec::new(),
                notes: Vec::new(),
            });
            section = Section::Body;
            continue;
        }
        let Some(current) = slides.last_mut() else {
            continue;
        };
        if heading_word(line, "###", "notes").is_some() {
            section = Section::Notes;
            continue;
        }
        if heading_word(line, "###", "comments").is_some() {
            section = Section::Other;
            continue;
        }
        let trimmed = trim(line);
        if trimmed.is_empty() {
            continue;
        }
        match section {
            Section::Notes => current.notes.push(trimmed.to_owned()),
            Section::Body => {
                if current.title.is_empty() {
                    current.title = trimmed.to_owned();
                } else {
                    current.bullets.push(trimmed.to_owned());
                }
            }
            Section::Other => {}
        }
    }

    if slides.is_empty() && !trim(text).is_empty() {
        let paragraphs: Vec<&str> = lines_of(text)
            .into_iter()
            .map(trim)
            .filter(|line| !line.is_empty())
            .collect();
        slides.push(Slide {
            number: 1.0,
            title: paragraphs.first().copied().unwrap_or("").to_owned(),
            bullets: paragraphs
                .iter()
                .skip(1)
                .take(19)
                .map(|line| (*line).to_owned())
                .collect(),
            notes: Vec::new(),
        });
    }

    let truncated = slides.len() > MAX_SLIDES;
    slides.truncate(MAX_SLIDES);
    (slides, truncated)
}

/// `/^(\s*)-\s+(.*)$/`: the indent in UTF-16 units and the topic
fn mindmap_bullet(line: &str) -> Option<(usize, &str)> {
    let rest = line.trim_start_matches(is_js_space);
    let indent = line[..line.len() - rest.len()].encode_utf16().count();
    let topic = after_space(rest.strip_prefix('-')?)?;
    Some((indent, topic))
}

/// `parseMindmapFromText(text)`
pub fn parse_mindmap_from_text(text: &str) -> (Vec<MindmapSheet>, bool) {
    let mut sheets: Vec<MindmapSheet> = Vec::new();
    let mut truncated = false;

    for line in lines_of(text) {
        if let Some(title) = line.strip_prefix("# ") {
            if sheets.len() >= MAX_MINDMAP_SHEETS {
                truncated = true;
                break;
            }
            let title = trim(title);
            let title = if title.is_empty() {
                format!("Map {}", sheets.len() + 1)
            } else {
                title.to_owned()
            };
            sheets.push(MindmapSheet {
                title,
                nodes: Vec::new(),
            });
            continue;
        }
        if let Some((indent, topic)) = mindmap_bullet(line) {
            if sheets.is_empty() {
                sheets.push(MindmapSheet {
                    title: "Map 1".to_owned(),
                    nodes: Vec::new(),
                });
            }
            let current = sheets.last_mut().expect("a sheet exists");
            if current.nodes.len() >= MAX_MINDMAP_NODES {
                truncated = true;
                continue;
            }
            current.nodes.push(MindmapNode {
                depth: (indent / 2).min(6) as u32,
                text: trim(topic).to_owned(),
            });
        }
    }
    (sheets, truncated)
}

/// `/^(#{1,6})\s+(.*)$/` of a trimmed line: the level and the heading text
fn heading_of(trimmed: &str) -> Option<(u32, &str)> {
    let rest = trimmed.trim_start_matches('#');
    let level = trimmed.len() - rest.len();
    if !(1..=6).contains(&level) {
        return None;
    }
    Some((level as u32, after_space(rest)?))
}

/// `/^[-*•]\s+(.*)$/` of a trimmed line: the item text
fn bullet_of(trimmed: &str) -> Option<&str> {
    let rest = trimmed.strip_prefix(['-', '*', '•'])?;
    after_space(rest)
}

/// `parseDocBlocksFromText(text)`
pub fn parse_doc_blocks_from_text(text: &str) -> (Vec<DocBlock>, bool) {
    let mut blocks: Vec<DocBlock> = Vec::new();
    let mut table_rows: Option<Vec<Vec<String>>> = None;
    let mut code_lines: Option<Vec<&str>> = None;
    let mut truncated = false;

    fn flush_table(blocks: &mut Vec<DocBlock>, table_rows: &mut Option<Vec<Vec<String>>>) {
        if table_rows.as_ref().is_some_and(|rows| !rows.is_empty()) {
            blocks.push(DocBlock {
                kind: BlockKind::Table,
                level: None,
                text: None,
                rows: table_rows.take(),
            });
        }
    }
    fn flush_code(blocks: &mut Vec<DocBlock>, code_lines: &mut Option<Vec<&str>>) {
        if let Some(lines) = code_lines.take() {
            blocks.push(DocBlock {
                kind: BlockKind::Code,
                level: None,
                text: Some(lines.join("\n")),
                rows: None,
            });
        }
    }
    let text_block = |kind, level, text: &str| DocBlock {
        kind,
        level,
        text: Some(text.to_owned()),
        rows: None,
    };

    for line in lines_of(text) {
        if blocks.len() >= MAX_DOC_BLOCKS {
            truncated = true;
            break;
        }

        if trim(line).starts_with("```") {
            flush_table(&mut blocks, &mut table_rows);
            if code_lines.is_some() {
                flush_code(&mut blocks, &mut code_lines);
            } else {
                code_lines = Some(Vec::new());
            }
            continue;
        }

        if let Some(lines) = code_lines.as_mut() {
            if lines.len() < 40 {
                lines.push(line);
            }
            continue;
        }

        let has_pipe_cells = line.contains(" | ");
        let has_tab_cells = !has_pipe_cells && line.contains('\t');
        if has_pipe_cells || has_tab_cells {
            let raw_cells: Vec<String> = if has_pipe_cells {
                let trimmed = trim(line);
                let trimmed = trimmed.strip_prefix('|').unwrap_or(trimmed);
                let trimmed = trimmed.strip_suffix('|').unwrap_or(trimmed);
                trimmed.split('|').map(|c| trim(c).to_owned()).collect()
            } else {
                line.split('\t').map(|c| trim(c).to_owned()).collect()
            };
            // markdown separator rows like |---|---|
            if raw_cells
                .iter()
                .all(|c| !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':'))
            {
                continue;
            }
            let rows = table_rows.get_or_insert_with(Vec::new);
            if rows.len() < 30 {
                rows.push(raw_cells.into_iter().take(12).collect());
            } else {
                truncated = true;
            }
            continue;
        }

        flush_table(&mut blocks, &mut table_rows);

        let trimmed = trim(line);
        if trimmed.is_empty() {
            continue;
        }
        if let Some((level, heading)) = heading_of(trimmed) {
            blocks.push(text_block(BlockKind::Heading, Some(level), trim(heading)));
            continue;
        }
        if let Some(item) = bullet_of(trimmed) {
            blocks.push(text_block(BlockKind::Bullet, None, trim(item)));
            continue;
        }
        blocks.push(text_block(BlockKind::Paragraph, None, trimmed));
    }

    flush_table(&mut blocks, &mut table_rows);
    flush_code(&mut blocks, &mut code_lines);
    (blocks, truncated)
}
