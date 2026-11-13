//! `apps/shell/src/main/mcp-client/toml.ts`: a small TOML reader for pasted
//! Codex settings (`[mcp_servers.<name>]`, user MCP spec 12.3). Tables and
//! arrays of tables, dotted and quoted keys, the four string forms, booleans,
//! numbers, arrays and inline tables. Dates are kept as their text. It is
//! lenient about redefined tables and fails with a [`TomlError`] naming the
//! line (from 1) on text it cannot read.
//!
//! The values are [`JsonValue`]s: a table is an object (`JsObject`, so its
//! keys come in JavaScript's order and a key named `__proto__` is an ordinary
//! member), a date is a string, an integer or float is a number (`f64`: `inf`
//! and `nan` are kept as `Infinity` and `NaN`, which JSON cannot print but the
//! value can hold). Nothing the TypeScript keeps is lost by that choice.
//!
//! The TypeScript walks the text by UTF-16 unit; this reader walks it by byte
//! offset over whole characters. A position is never shown, only its line, and
//! the line is the count of `\n` before the position, which agrees.
//!
//! The TypeScript's `current` table is an object reference; here it is the
//! path of keys that leads to it, followed by the same rule `descend` uses (an
//! array of tables leads to its last table), so a later pair lands where the
//! reference would.

use std::fmt;

use jscompat::{JsObject, JsonValue, js_regex, to_number};

/// How deep arrays and inline tables nest before the reader gives up with the
/// `RangeError` V8 throws when its stack is full ([`TomlError::stack_overflow`])
const MAX_NESTING: usize = 2000;

/// `TomlError`: `message` already ends in ` (line N)`. `stack_overflow` is
/// the `RangeError` ("Maximum call stack size exceeded") the TypeScript
/// throws instead on text nested that deep: not a `TomlError` there, so the
/// paste names no line for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TomlError {
    pub message: String,
    pub line: usize,
    pub stack_overflow: bool,
}

impl TomlError {
    fn new(message: &str, line: usize) -> Self {
        TomlError {
            message: format!("{message} (line {line})"),
            line,
            stack_overflow: false,
        }
    }

    fn stack_overflow(line: usize) -> Self {
        TomlError {
            message: "Maximum call stack size exceeded".to_owned(),
            line,
            stack_overflow: true,
        }
    }
}

impl fmt::Display for TomlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TomlError: {}", self.message)
    }
}

type Table = JsObject<JsonValue>;

const NUMBER: &str = r"^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|inf|nan|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)";
const DATE: &str = r"^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?";

fn is_bare_key(c: Option<char>) -> bool {
    matches!(c, Some('A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '-'))
}

/// `descend(table, part)` without the failure text: the sub-table under
/// `part`, made when missing; the last element of an array of tables. `None`
/// where the TypeScript fails with `"part" is already a value`.
fn descend<'a>(table: &'a mut Table, part: &str) -> Option<&'a mut Table> {
    if table.get(part).is_none() {
        table.set(part, JsonValue::Object(Table::new()));
    }
    match table.get_mut(part)? {
        JsonValue::Object(next) => Some(next),
        JsonValue::Array(list) => match list.last_mut() {
            Some(JsonValue::Object(next)) => Some(next),
            _ => None,
        },
        _ => None,
    }
}

struct Reader {
    text: String,
    pos: usize,
    /// arrays and inline tables open around the position
    depth: usize,
}

impl Reader {
    /// `get line()`
    fn line(&self) -> usize {
        self.text[..self.pos].matches('\n').count() + 1
    }

    fn fail(&self, message: &str) -> TomlError {
        TomlError::new(message, self.line())
    }

    fn already_a_value(&self, part: &str) -> TomlError {
        self.fail(&format!("\"{part}\" is already a value"))
    }

    fn peek(&self) -> Option<char> {
        self.text[self.pos..].chars().next()
    }

    /// `peek(offset)` for an offset that lands on ASCII (quotes)
    fn byte_at(&self, offset: usize) -> Option<u8> {
        self.text.as_bytes().get(self.pos + offset).copied()
    }

    fn starts_with(&self, s: &str) -> bool {
        self.text[self.pos..].starts_with(s)
    }

    fn eof(&self) -> bool {
        self.pos >= self.text.len()
    }

    /// `this.pos++`
    fn advance(&mut self) {
        if let Some(c) = self.peek() {
            self.pos += c.len_utf8();
        }
    }

    /// spaces and tabs
    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.pos += 1;
        }
    }

    fn skip_comment(&mut self) {
        if self.peek() != Some('#') {
            return;
        }
        while !self.eof() && self.peek() != Some('\n') {
            self.advance();
        }
    }

    /// spaces, comments and line breaks (between array members)
    fn skip_blank(&mut self) {
        loop {
            self.skip_space();
            self.skip_comment();
            if matches!(self.peek(), Some('\n' | '\r')) {
                self.pos += 1;
            } else {
                return;
            }
        }
    }

    /// the rest of a line after a key/value pair or a table header
    fn end_line(&mut self) -> Result<(), TomlError> {
        self.skip_space();
        self.skip_comment();
        if self.eof() {
            return Ok(());
        }
        if self.starts_with("\r\n") {
            self.pos += 2;
        } else if self.peek() == Some('\n') {
            self.pos += 1;
        } else {
            return Err(self.fail("expected the end of the line"));
        }
        Ok(())
    }

    fn parse(&mut self) -> Result<Table, TomlError> {
        let mut root = Table::new();
        let mut current: Vec<String> = Vec::new();
        loop {
            self.skip_blank();
            if self.eof() {
                return Ok(root);
            }
            if self.peek() == Some('[') {
                current = self.header(&mut root)?;
            } else {
                let mut table = &mut root;
                for part in &current {
                    table = descend(table, part).ok_or_else(|| self.already_a_value(part))?;
                }
                self.pair(table)?;
            }
            self.end_line()?;
        }
    }

    /// `header(root)`: makes the tables of the header and answers the path of
    /// keys that leads to the one it names
    fn header(&mut self, root: &mut Table) -> Result<Vec<String>, TomlError> {
        let array = self.starts_with("[[");
        self.pos += if array { 2 } else { 1 };
        self.skip_space();
        let path = self.key()?;
        self.skip_space();
        if !self.starts_with(if array { "]]" } else { "]" }) {
            return Err(self.fail("unclosed table header"));
        }
        self.pos += if array { 2 } else { 1 };
        let mut table = root;
        for (i, part) in path.iter().enumerate() {
            let last = i == path.len() - 1;
            if last && array {
                if !matches!(table.get(part), Some(JsonValue::Array(_))) {
                    table.set(part.as_str(), JsonValue::Array(Vec::new()));
                }
                if let Some(JsonValue::Array(list)) = table.get_mut(part) {
                    list.push(JsonValue::Object(Table::new()));
                }
                break;
            }
            table = descend(table, part).ok_or_else(|| self.already_a_value(part))?;
        }
        Ok(path)
    }

    fn pair(&mut self, table: &mut Table) -> Result<(), TomlError> {
        let path = self.key()?;
        self.skip_space();
        if self.peek() != Some('=') {
            return Err(self.fail("expected \"=\""));
        }
        self.pos += 1;
        self.skip_space();
        let value = self.value()?;
        let mut target = table;
        for part in &path[..path.len() - 1] {
            target = descend(target, part).ok_or_else(|| self.already_a_value(part))?;
        }
        target.set(path[path.len() - 1].as_str(), value);
        Ok(())
    }

    /// a dotted key: bare or quoted parts
    fn key(&mut self) -> Result<Vec<String>, TomlError> {
        let mut parts = Vec::new();
        loop {
            self.skip_space();
            match self.peek() {
                Some('"') => parts.push(self.basic_string()?),
                Some('\'') => parts.push(self.literal_string()?),
                _ => {
                    let start = self.pos;
                    while is_bare_key(self.peek()) {
                        self.pos += 1;
                    }
                    if self.pos == start {
                        return Err(self.fail("expected a key"));
                    }
                    parts.push(self.text[start..self.pos].to_owned());
                }
            }
            self.skip_space();
            if self.peek() != Some('.') {
                return Ok(parts);
            }
            self.pos += 1;
        }
    }

    fn value(&mut self) -> Result<JsonValue, TomlError> {
        let c = self.peek();
        if self.starts_with("\"\"\"") {
            return self.multi_basic_string().map(JsonValue::String);
        }
        if self.starts_with("'''") {
            return self.multi_literal_string().map(JsonValue::String);
        }
        if c == Some('"') {
            return self.basic_string().map(JsonValue::String);
        }
        if c == Some('\'') {
            return self.literal_string().map(JsonValue::String);
        }
        if c == Some('[') || c == Some('{') {
            // V8's stack gives out far deeper than this; a paste never nests so
            self.depth += 1;
            if self.depth > MAX_NESTING {
                return Err(TomlError::stack_overflow(self.line()));
            }
            let nested = if c == Some('[') {
                self.array()
            } else {
                self.inline_table()
            };
            self.depth -= 1;
            return nested;
        }
        if self.starts_with("true") {
            self.pos += 4;
            return Ok(JsonValue::Bool(true));
        }
        if self.starts_with("false") {
            self.pos += 5;
            return Ok(JsonValue::Bool(false));
        }
        let rest = &self.text[self.pos..];
        if let Some(date) = js_regex!(DATE).exec(rest) {
            let found = date.as_str().to_owned();
            self.pos += found.len();
            return Ok(JsonValue::String(found));
        }
        if let Some(num) = js_regex!(NUMBER).exec(rest) {
            let found = num.as_str().to_owned();
            self.pos += found.len();
            return Ok(JsonValue::Number(number_of(&found)));
        }
        Err(self.fail("expected a value"))
    }

    fn array(&mut self) -> Result<JsonValue, TomlError> {
        self.pos += 1;
        let mut items = Vec::new();
        loop {
            self.skip_blank();
            if self.peek() == Some(']') {
                self.pos += 1;
                return Ok(JsonValue::Array(items));
            }
            if self.eof() {
                return Err(self.fail("unclosed array"));
            }
            items.push(self.value()?);
            self.skip_blank();
            if self.peek() == Some(',') {
                self.pos += 1;
            } else if self.peek() != Some(']') {
                return Err(self.fail("expected \",\" or \"]\""));
            }
        }
    }

    fn inline_table(&mut self) -> Result<JsonValue, TomlError> {
        self.pos += 1;
        let mut table = Table::new();
        loop {
            self.skip_blank();
            if self.peek() == Some('}') {
                self.pos += 1;
                return Ok(JsonValue::Object(table));
            }
            if self.eof() {
                return Err(self.fail("unclosed inline table"));
            }
            self.pair(&mut table)?;
            self.skip_blank();
            if self.peek() == Some(',') {
                self.pos += 1;
            } else if self.peek() != Some('}') {
                return Err(self.fail("expected \",\" or \"}\""));
            }
        }
    }

    fn basic_string(&mut self) -> Result<String, TomlError> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let c = self.peek();
            if c.is_none() || c == Some('\n') {
                return Err(self.fail("unterminated string"));
            }
            let c = c.unwrap_or_default();
            self.pos += c.len_utf8();
            if c == '"' {
                return Ok(out);
            }
            if c == '\\' {
                out.push(self.escape()?);
            } else {
                out.push(c);
            }
        }
    }

    fn multi_basic_string(&mut self) -> Result<String, TomlError> {
        self.pos += 3;
        if self.starts_with("\r\n") {
            self.pos += 2;
        } else if self.peek() == Some('\n') {
            self.pos += 1;
        }
        let mut out = String::new();
        loop {
            if self.eof() {
                return Err(self.fail("unterminated string"));
            }
            if self.starts_with("\"\"\"") {
                // up to two quotes may sit right before the closing three
                let mut extra = 0;
                while extra < 2 && self.byte_at(3 + extra) == Some(b'"') {
                    extra += 1;
                }
                out.push_str(&"\"".repeat(extra));
                self.pos += 3 + extra;
                return Ok(out);
            }
            let c = self.peek().unwrap_or_default();
            self.pos += c.len_utf8();
            if c != '\\' {
                out.push(c);
                continue;
            }
            // a backslash at the end of a line trims the break and the leading space after it
            let rest = &self.text[self.pos..];
            let after = rest.trim_start_matches([' ', '\t']);
            let line_end = if after.starts_with("\r\n") {
                Some(2)
            } else if after.starts_with('\n') {
                Some(1)
            } else {
                None
            };
            if let Some(line_end) = line_end {
                self.pos += rest.len() - after.len() + line_end;
                while matches!(self.peek(), Some(' ' | '\t' | '\r' | '\n')) {
                    self.pos += 1;
                }
                continue;
            }
            out.push(self.escape()?);
        }
    }

    fn literal_string(&mut self) -> Result<String, TomlError> {
        self.pos += 1;
        let rest = &self.text[self.pos..];
        let end = rest.find('\'');
        let newline = rest.find('\n');
        let end = match (end, newline) {
            (None, _) => return Err(self.fail("unterminated string")),
            (Some(end), Some(newline)) if newline < end => {
                return Err(self.fail("unterminated string"));
            }
            (Some(end), _) => end,
        };
        let out = rest[..end].to_owned();
        self.pos += end + 1;
        Ok(out)
    }

    fn multi_literal_string(&mut self) -> Result<String, TomlError> {
        self.pos += 3;
        if self.starts_with("\r\n") {
            self.pos += 2;
        } else if self.peek() == Some('\n') {
            self.pos += 1;
        }
        let Some(end) = self.text[self.pos..].find("'''") else {
            return Err(self.fail("unterminated string"));
        };
        let end = self.pos + end;
        let mut extra = 0;
        while extra < 2 && self.text.as_bytes().get(end + 3 + extra) == Some(&b'\'') {
            extra += 1;
        }
        let out = self.text[self.pos..end + extra].to_owned();
        self.pos = end + 3 + extra;
        Ok(out)
    }

    /// the character after a backslash
    fn escape(&mut self) -> Result<char, TomlError> {
        let c = self.peek();
        self.advance();
        match c {
            Some('b') => Ok('\u{8}'),
            Some('t') => Ok('\t'),
            Some('n') => Ok('\n'),
            Some('f') => Ok('\u{c}'),
            Some('r') => Ok('\r'),
            Some('e') => Ok('\u{1b}'),
            Some('"') => Ok('"'),
            Some('\\') => Ok('\\'),
            Some(u @ ('u' | 'U')) => {
                let size = if u == 'u' { 4 } else { 8 };
                // `text.slice(pos, pos + size)` in code units: a window that
                // holds a character outside the ASCII range is not hex
                let hex: String = self.text[self.pos..].chars().take(size).collect();
                if hex.chars().count() != size || !hex.chars().all(|d| d.is_ascii_hexdigit()) {
                    return Err(self.fail("bad unicode escape"));
                }
                let code = u32::from_str_radix(&hex, 16).unwrap_or(u32::MAX);
                if code > 0x10ffff || (0xd800..=0xdfff).contains(&code) {
                    return Err(self.fail("bad unicode escape"));
                }
                self.pos += size;
                char::from_u32(code).ok_or_else(|| self.fail("bad unicode escape"))
            }
            _ => Err(self.fail("bad escape")),
        }
    }
}

fn number_of(token: &str) -> f64 {
    let t = token.replace('_', "");
    let sign = if t.starts_with('-') { -1.0 } else { 1.0 };
    let body = t.strip_prefix(['+', '-']).unwrap_or(&t);
    if body == "inf" {
        return sign * f64::INFINITY;
    }
    if body == "nan" {
        return f64::NAN;
    }
    if body.starts_with("0x") || body.starts_with("0o") || body.starts_with("0b") {
        return sign * to_number(body);
    }
    to_number(&t)
}

/// `parseToml(text)`: the tables of a TOML text
pub fn parse_toml(text: &str) -> Result<JsObject<JsonValue>, TomlError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Reader {
        text: text.to_owned(),
        pos: 0,
        depth: 0,
    }
    .parse()
}
