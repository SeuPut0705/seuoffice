//! `apps/shell/src/main/mcp/mcp-logger.ts`: the local log for the MCP server,
//! a bounded in-memory ring plus an append-only file under userData, so both
//! the settings UI (recent lines) and a saved file the user can open/share are
//! covered. Appending is synchronous on purpose: log volume is tiny
//! (lifecycle, sessions, tool calls) and a lost line on crash is acceptable,
//! while ordering guarantees are not.
//!
//! The device-local timestamp needs the clock and the local time zone, which
//! only the host has: they are a [`LogClock`], asked once per line.

use std::fs;
use std::io::{Read, Seek, SeekFrom};

use jscompat::{number_to_string, pad_start, utc_date_parts};

/// `MAX_BUFFER_LINES`
const MAX_BUFFER_LINES: usize = 500;

/// `MCP_LOG_TAIL`: how many lines the settings pane fetches at once
pub const MCP_LOG_TAIL: f64 = 200.0;

/// `readTail`'s window: the bounded suffix it reads of a big file
const TAIL_MAX_BYTES: u64 = 256 * 1024;

/// The clock behind `new Date()` and the zone behind its local getters.
pub trait LogClock {
    /// `Date.now()`: milliseconds since the epoch
    fn now_ms(&self) -> f64;
    /// the zone's offset from UTC at `at_ms`, in milliseconds east of UTC
    /// (`-date.getTimezoneOffset() * 60000`): the local fields of a date are
    /// those of `at_ms + offset` read as UTC
    fn utc_offset_ms(&self, at_ms: f64) -> f64;
}

/// `localTimestamp(date)`: the device-local timestamp for log lines
/// (`YYYY-MM-DD HH:mm:ss.SSS`). The log is read by the user in the settings
/// pane or a shared file, so it shows wall-clock time, not UTC
/// (`toISOString`'s `Z` suffix read as an 8h-off time in zh locales).
///
/// `date_ms` is the time value of the date and `utc_offset_ms` the zone's
/// offset at it. An invalid date (NaN, an infinity, past 8.64e15) has `NaN`
/// for every field. The year is not padded: a year that does not fit four
/// digits, or is negative, prints as `String(year)` does.
pub fn local_timestamp(date_ms: f64, utc_offset_ms: f64) -> String {
    let pad = |value: f64, width: usize| pad_start(&number_to_string(value), width, '0');
    let shifted = date_ms + utc_offset_ms;
    let Some((year, month, day)) = utc_date_parts(shifted) else {
        return format!(
            "NaN-{}-{} {}:{}:{}.{}",
            pad(f64::NAN, 2),
            pad(f64::NAN, 2),
            pad(f64::NAN, 2),
            pad(f64::NAN, 2),
            pad(f64::NAN, 2),
            pad(f64::NAN, 3)
        );
    };
    let in_day = (shifted.trunc() as i64).rem_euclid(86_400_000);
    format!(
        "{}-{}-{} {}:{}:{}.{}",
        number_to_string(year),
        pad(month + 1.0, 2),
        pad(day, 2),
        pad((in_day / 3_600_000) as f64, 2),
        pad((in_day / 60_000 % 60) as f64, 2),
        pad((in_day / 1000 % 60) as f64, 2),
        pad((in_day % 1000) as f64, 3)
    )
}

/// `McpLogger`
pub struct McpLogger {
    buffer: Vec<String>,
    pub file_path: String,
    clock: Box<dyn LogClock>,
}

/// `array.slice(-limit)`: where it starts in an array of `len` items. `-0` and
/// NaN are 0 (the whole array), a negative `limit` counts from the front.
fn slice_start(len: usize, limit: f64) -> usize {
    let start = -limit;
    let start = if start.is_nan() { 0.0 } else { start.trunc() };
    if start < 0.0 {
        (len as f64 + start).max(0.0) as usize
    } else {
        start.min(len as f64) as usize
    }
}

/// `lines.filter((l) => l.length > 0).slice(-limit)`
fn last_lines<'a>(lines: impl Iterator<Item = &'a str>, limit: f64) -> Vec<String> {
    let kept: Vec<&str> = lines.filter(|line| !line.is_empty()).collect();
    kept[slice_start(kept.len(), limit)..]
        .iter()
        .map(|line| (*line).to_owned())
        .collect()
}

/// `readTail(filePath, limit)`: the last `limit` non-empty lines of a text
/// file, `None` where the file cannot be read.
///
/// The settings pane polls this every couple of seconds while logging is on,
/// so it reads a bounded suffix instead of the whole append-only file:
/// growing the work with total history would put an unbounded synchronous
/// read on the main process. A generous per-line allowance covers the long
/// lines a stack trace can produce; falling back to the whole file when the
/// suffix is too small to hold `limit` lines keeps the result exact.
pub fn read_tail(file_path: &str, limit: f64) -> Option<Vec<String>> {
    let size = fs::metadata(file_path).ok()?.len();
    if size <= TAIL_MAX_BYTES {
        let raw = fs::read(file_path).ok()?;
        return Some(last_lines(String::from_utf8_lossy(&raw).split('\n'), limit));
    }
    let start = size - TAIL_MAX_BYTES;
    let mut file = fs::File::open(file_path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut window = Vec::with_capacity(TAIL_MAX_BYTES as usize);
    file.take(TAIL_MAX_BYTES).read_to_end(&mut window).ok()?;
    let text = String::from_utf8_lossy(&window);
    // the window starts mid-line, so its first entry is a partial line
    Some(last_lines(text.split('\n').skip(1), limit))
}

impl McpLogger {
    /// `new McpLogger(filePath)`: the log covers the current app launch only,
    /// so the file is reset at startup and never grows across runs (the
    /// settings pane reads it live anyway)
    pub fn new(file_path: &str, clock: Box<dyn LogClock>) -> Self {
        // best-effort; append() recreates what it can
        let _ = fs::write(file_path, "");
        McpLogger {
            buffer: Vec::new(),
            file_path: file_path.to_owned(),
            clock,
        }
    }

    /// `append(message)`
    pub fn append(&mut self, message: &str) {
        let now = self.clock.now_ms();
        let line = format!(
            "[{}] {message}",
            local_timestamp(now, self.clock.utc_offset_ms(now))
        );
        self.buffer.push(line.clone());
        if self.buffer.len() > MAX_BUFFER_LINES {
            self.buffer.remove(0);
        }
        // a broken log target must never take the MCP server down
        let _ = append_line(&self.file_path, &line);
    }

    /// `recent(limit)`: most recent lines, file-backed (falls back to the ring
    /// when unreadable). `None` for `limit` is the default [`MCP_LOG_TAIL`].
    pub fn recent(&self, limit: Option<f64>) -> Vec<String> {
        let limit = limit.unwrap_or(MCP_LOG_TAIL);
        if fs::metadata(&self.file_path).is_ok()
            && let Some(raw) = read_tail(&self.file_path, limit)
            && !raw.is_empty()
        {
            return raw;
        }
        self.buffer[slice_start(self.buffer.len(), limit)..].to_vec()
    }

    /// `clear()`
    pub fn clear(&mut self) {
        self.buffer.clear();
        // best-effort
        if fs::metadata(&self.file_path).is_ok() {
            let _ = fs::OpenOptions::new()
                .write(true)
                .open(&self.file_path)
                .and_then(|file| file.set_len(0));
        }
    }

    /// `ensureFile()`: create the file when missing so "reveal in file
    /// manager" has a target
    pub fn ensure_file(&self) {
        // best-effort
        if fs::metadata(&self.file_path).is_err() {
            let _ = fs::write(&self.file_path, "");
        }
    }
}

/// `appendFileSync(path, line + '\n', 'utf8')`
fn append_line(path: &str, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?;
    file.write_all(format!("{line}\n").as_bytes())
}
