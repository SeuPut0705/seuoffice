//! `apps/shell/src/main/projects/memory.ts`: `memory.md` text (spec 3, 5.6): a
//! comment line explaining the file, then one entry per line,
//! `- text (YYYY-MM-DD)`. People may edit it freely, so every operation keeps
//! the lines it does not touch exactly as they were.
//!
//! `localDate` and `memoryBackupName` read a `Date` in local time; a `Date`
//! here is the [`LocalDateParts`] the host's time zone makes of it.

use jscompat::{js_regex, pad_start, replace_first_with, trim, trim_start};

use crate::packages::i18n::product_name;
use crate::packages::project_store::{ProjectMemoryOp, ProjectMemoryRefusal};

/// `MEMORY_SOFT_LIMIT_CHARS`: memory above this many characters is still sent
/// whole; the panel offers "[consolidate]"
pub const MEMORY_SOFT_LIMIT_CHARS: u64 = 8_000;

/// `memoryHeader(language)`: the explanation line a new `memory.md` starts
/// with, in the screen language
pub fn memory_header(language: &str) -> String {
    let lowered = trim(language).to_lowercase();
    let base = lowered.split(['-', '_']).next().unwrap_or("");
    if base == "ko" {
        return format!(
            "<!-- {}가 쌓는 기억. 고치거나 지워도 됩니다. -->",
            product_name(Some("ko"))
        );
    }
    format!(
        "<!-- Memory kept by {}. You may edit or delete it. -->",
        product_name(Some("en"))
    )
}

/// `DATED`: `/\s\(\d{4}-\d{2}-\d{2}\)$/`
fn dated() -> &'static jscompat::JsRegex {
    js_regex!(r"\s\(\d{4}-\d{2}-\d{2}\)$")
}

/// `ENTRY_LINE`: `/^\s*-\s+(.*\S)\s*$/`
fn entry_line() -> &'static jscompat::JsRegex {
    js_regex!(r"^\s*-\s+(.*\S)\s*$")
}

/// `entryOf(line)`: the text of an entry line without its `- ` marker, or
/// `None` (`null`) for another kind of line
fn entry_of(line: &str) -> Option<String> {
    entry_line()
        .exec(line)
        .map(|found| found.get(1).unwrap_or("").to_owned())
}

/// `memoryHasContent(text)`: whether the memory text says anything: a file
/// holding only blank lines and whole-line HTML comments (the header) is
/// empty, and is neither sent nor shown in the trust prompt.
pub fn memory_has_content(text: Option<&str>) -> bool {
    let Some(text) = text else {
        return false;
    };
    js_regex!(r"\r?\n")
        .split(text)
        .into_iter()
        .any(|line| !trim(line).is_empty() && !js_regex!(r"^\s*<!--.*-->\s*$").test(line))
}

/// `memoryEntries(text)`: entry texts in file order (header, blank and other
/// lines left out)
pub fn memory_entries(text: &str) -> Vec<String> {
    js_regex!(r"\r?\n")
        .split(text)
        .into_iter()
        .filter_map(entry_of)
        .collect()
}

/// `cleanEntry(text)`: one entry as given by the AI or a person: one line,
/// `- ` marker dropped; `None` (`null`) when unusable
fn clean_entry(text: &str) -> Option<String> {
    if trim(text).contains(['\r', '\n']) {
        return None;
    }
    let trimmed = trim(text);
    // `.replace(/^-\s*/, '')`
    let without_marker = match trimmed.strip_prefix('-') {
        Some(rest) => trim_start(rest),
        None => trimmed,
    };
    let clean = trim(without_marker);
    if clean.is_empty() {
        None
    } else {
        Some(clean.to_owned())
    }
}

/// `withDate(text, today)`
fn with_date(text: &str, today: &str) -> String {
    if dated().test(text) {
        text.to_owned()
    } else {
        format!("{text} ({today})")
    }
}

/// `entryKey(text)`: comparable form of an entry: without its date, spaces
/// collapsed
fn entry_key(text: &str) -> String {
    let undated = replace_first_with(dated(), text, |_| String::new());
    let collapsed = js_regex!(r"\s+").replace_all(&undated, |_| " ".to_owned());
    trim(&collapsed).to_owned()
}

/// `linesOf(text)`
fn lines_of(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = js_regex!(r"\r?\n")
        .split(text)
        .into_iter()
        .map(str::to_owned)
        .collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

/// `joinLines(lines)`
fn join_lines(lines: &[String]) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

/// `MemoryOpContext`
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryOpContext {
    /// Local date `YYYY-MM-DD` stamped on added and replaced entries
    pub today: String,
    /// Header for a file that does not exist yet
    pub header: String,
}

/// `Extract<ProjectMemoryRefusal, 'not-found' | 'invalid'>`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryOpRefusal {
    NotFound,
    Invalid,
}

impl From<MemoryOpRefusal> for ProjectMemoryRefusal {
    fn from(reason: MemoryOpRefusal) -> Self {
        match reason {
            MemoryOpRefusal::NotFound => ProjectMemoryRefusal::NotFound,
            MemoryOpRefusal::Invalid => ProjectMemoryRefusal::Invalid,
        }
    }
}

/// `MemoryOpResult`
#[derive(Debug, Clone, PartialEq)]
pub enum MemoryOpResult {
    /// `{ ok: true, text, change }`
    Ok {
        text: String,
        change: ProjectMemoryOp,
    },
    /// `{ ok: false, reason }`
    Refused { reason: MemoryOpRefusal },
}

/// `applyMemoryOp(current, op, ctx)`: apply one change to the current text
/// (`None` when the file is absent). The result's `change` carries the entry
/// texts as written, for the memory lines.
pub fn apply_memory_op(
    current: Option<&str>,
    op: &ProjectMemoryOp,
    ctx: &MemoryOpContext,
) -> MemoryOpResult {
    let mut lines = match current {
        None => vec![ctx.header.clone()],
        Some(text) => lines_of(text),
    };
    let find_index = |lines: &[String], text: &str| -> Option<usize> {
        let key = entry_key(text);
        lines
            .iter()
            .position(|line| entry_of(line).is_some_and(|entry| entry_key(&entry) == key))
    };

    match op {
        ProjectMemoryOp::Add { text } => {
            let Some(clean) = clean_entry(text) else {
                return MemoryOpResult::Refused {
                    reason: MemoryOpRefusal::Invalid,
                };
            };
            if let Some(existing) = find_index(&lines, &clean) {
                let entry = entry_of(&lines[existing]).unwrap_or_default();
                return MemoryOpResult::Ok {
                    text: current.map_or_else(|| join_lines(&lines), str::to_owned),
                    change: ProjectMemoryOp::Add { text: entry },
                };
            }
            let entry = with_date(&clean, &ctx.today);
            lines.push(format!("- {entry}"));
            MemoryOpResult::Ok {
                text: join_lines(&lines),
                change: ProjectMemoryOp::Add { text: entry },
            }
        }
        ProjectMemoryOp::Replace { old, new } => {
            let (Some(old), Some(next)) = (clean_entry(old), clean_entry(new)) else {
                return MemoryOpResult::Refused {
                    reason: MemoryOpRefusal::Invalid,
                };
            };
            let Some(index) = find_index(&lines, &old) else {
                return MemoryOpResult::Refused {
                    reason: MemoryOpRefusal::NotFound,
                };
            };
            let before = entry_of(&lines[index]).unwrap_or_default();
            let entry = with_date(&next, &ctx.today);
            lines[index] = format!("- {entry}");
            MemoryOpResult::Ok {
                text: join_lines(&lines),
                change: ProjectMemoryOp::Replace {
                    old: before,
                    new: entry,
                },
            }
        }
        ProjectMemoryOp::Remove { text } => {
            let Some(target) = clean_entry(text) else {
                return MemoryOpResult::Refused {
                    reason: MemoryOpRefusal::Invalid,
                };
            };
            let Some(index) = find_index(&lines, &target) else {
                return MemoryOpResult::Refused {
                    reason: MemoryOpRefusal::NotFound,
                };
            };
            let removed = entry_of(&lines[index]).unwrap_or_default();
            lines.remove(index);
            MemoryOpResult::Ok {
                text: join_lines(&lines),
                change: ProjectMemoryOp::Remove { text: removed },
            }
        }
    }
}

/// `buildMemoryText(entries, header, today)`: the whole file for a
/// consolidated list: header, then one dated entry per line
pub fn build_memory_text(entries: &[String], header: &str, today: &str) -> String {
    let mut lines = vec![header.to_owned()];
    for raw in entries {
        // An entry that arrives with line breaks becomes one entry per line, never lost.
        for line in js_regex!(r"\r?\n").split(raw) {
            if let Some(clean) = clean_entry(line) {
                lines.push(format!("- {}", with_date(&clean, today)));
            }
        }
    }
    join_lines(&lines)
}

/// What `getFullYear()`, `getMonth()`, `getDate()`, `getHours()`,
/// `getMinutes()` and `getSeconds()` of a `Date` answer in the host's time zone
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalDateParts {
    pub full_year: i64,
    /// `getMonth()`: 0 for January
    pub month: i64,
    pub date: i64,
    pub hours: i64,
    pub minutes: i64,
    pub seconds: i64,
}

/// `pad(value, width)`: `String(value).padStart(width, '0')`
fn pad(value: i64, width: usize) -> String {
    pad_start(&value.to_string(), width, '0')
}

/// `localDate(date)`: local date `YYYY-MM-DD`
pub fn local_date(date: &LocalDateParts) -> String {
    format!(
        "{}-{}-{}",
        pad(date.full_year, 4),
        pad(date.month + 1, 2),
        pad(date.date, 2)
    )
}

/// `memoryBackupName(date)`: `memory.<YYYYMMDD-HHmmss>.bak.md` in local time
pub fn memory_backup_name(date: &LocalDateParts) -> String {
    let day = format!(
        "{}{}{}",
        pad(date.full_year, 4),
        pad(date.month + 1, 2),
        pad(date.date, 2)
    );
    let time = format!(
        "{}{}{}",
        pad(date.hours, 2),
        pad(date.minutes, 2),
        pad(date.seconds, 2)
    );
    format!("memory.{day}-{time}.bak.md")
}
