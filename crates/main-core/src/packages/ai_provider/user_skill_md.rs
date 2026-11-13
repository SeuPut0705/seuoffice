//! `packages/ai-provider/src/user-skills/frontmatter.ts`, with the fixed
//! values of `constants.ts` and the path rules of `folder.ts` and
//! `sources.ts` that the readers of a SKILL.md share: SKILL.md front matter
//! read and written without a YAML library, the reserved names, the template
//! path rule and the Codex home guard.
//!
//! A JavaScript string is UTF-16 code units; a Rust `String` cannot hold a
//! lone surrogate. Where the TypeScript would hold one (`"\ud800"` in a
//! double-quoted scalar) the value is U+FFFD here. `fromCodePoint` of a code
//! point past U+10FFFF throws a `RangeError` there; here it is a
//! [`SkillMdError`]. A plain object keyed by a name read from a file ignores
//! an assignment to `__proto__`; so do the maps here.

use std::fs;

use jscompat::node_path::host;
use jscompat::{JsMap, JsObject, is_js_space, js_regex, json_quote, trim, trim_start};

// ---- constants.ts ----

/// The longest name the app gives a new skill
pub const NEW_USER_SKILL_NAME_MAX: usize = 64;

/// Folder size limits (same as the agent session's copy)
pub const MAX_USER_SKILL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_USER_SKILL_FILES: usize = 5_000;

/// `RESERVED_USER_SKILL_NAMES` of agent-core's `user-skill-names.ts`, compared
/// without case
pub const RESERVED_USER_SKILL_NAMES: [&str; 3] = ["genoffice", "ieumoffice", "seuoffice"];

/// A file with one of these extensions makes a skill "with scripts"
pub const SKILL_SCRIPT_EXTENSIONS: [&str; 10] = [
    ".py", ".sh", ".ps1", ".bat", ".cmd", ".js", ".mjs", ".cjs", ".ts", ".exe",
];

/// A folder with this name anywhere in a skill makes it "with scripts"
pub const SKILL_SCRIPTS_FOLDER: &str = "scripts";

/// Text files the app reads from a skill folder
pub const SKILL_TEXT_EXTENSIONS: [&str; 9] = [
    ".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".xml", ".html", ".css",
];

/// The GitHub source record kept in an installed skill's folder
pub const IEUM_SOURCE_FILE: &str = ".ieum-source.json";

/// The list of builtin skills next to their folders
pub const BUILTIN_SKILLS_MANIFEST: &str = "builtin-skills.json";

/// The only folder a template may sit under, relative to the skill folder
pub const SKILL_TEMPLATE_FOLDER: &str = "assets";

/// Front matter keys of this app, under `metadata`
pub const IEUM_TITLE_KEY: &str = "ieum-title";
pub const IEUM_TEMPLATE_KEY: &str = "ieum-template";
pub const IEUM_EDITORS_KEY: &str = "ieum-editors";

/// Which enabled skill wins when two share a name, first wins
pub const USER_SKILL_PRIORITY: [&str; 6] = ["project", "app", "builtin", "user", "codex", "plugin"];

/// `isReservedUserSkillName(name)`
pub fn is_reserved_user_skill_name(name: &str) -> bool {
    RESERVED_USER_SKILL_NAMES.contains(&trim(name).to_lowercase().as_str())
}

// ---- folder.ts, sources.ts: the path rules ----

/// `isInsideDir(child, parent)`: `child` is `parent` or inside it, comparing
/// without case on Windows
pub fn is_inside_dir(child: &str, parent: &str) -> bool {
    let fold = |path: String| {
        if cfg!(windows) {
            path.to_lowercase()
        } else {
            path
        }
    };
    let rel = host::relative(
        &fold(host::resolve(&[parent])),
        &fold(host::resolve(&[child])),
    );
    let up = format!("..{}", host::SEP);
    rel.is_empty() || (!rel.starts_with(&up) && rel != ".." && !host::is_absolute(&rel))
}

/// `realpath(path)`, `None` where it throws
pub fn real_path(path: &str) -> Option<String> {
    fs::canonicalize(path)
        .ok()
        .map(|real| real.to_string_lossy().into_owned())
}

/// `codexHomeDir(homeDir)`: `~/.codex`, Codex's own folder, which holds its sign-in
pub fn codex_home_dir(home_dir: &str) -> String {
    host::join(&[home_dir, ".codex"])
}

/// `isInsideCodexHome(path, homeDir)`: whether a folder is the Codex home or
/// inside it, by its path and by its real place
pub fn is_inside_codex_home(path: &str, home_dir: &str) -> bool {
    let codex_home = codex_home_dir(home_dir);
    if is_inside_dir(path, &codex_home) {
        return true;
    }
    let codex_real = real_path(&codex_home).unwrap_or_else(|| codex_home.clone());
    if is_inside_dir(path, &codex_real) {
        return true;
    }
    match real_path(path) {
        Some(real) => is_inside_dir(&real, &codex_home) || is_inside_dir(&real, &codex_real),
        None => false,
    }
}

/// `normalizeSkillTemplatePath(value)`: a template path the app accepts:
/// relative, under `assets/`, no `.` or `..` parts
pub fn normalize_skill_template_path(value: Option<&str>) -> Option<String> {
    let value = value.filter(|value| !value.is_empty())?;
    let path = trim(value);
    let drive = js_regex!(r"^[A-Za-z]:");
    if path.contains('\\') || host::is_absolute(path) || drive.test(path) {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts[0] != SKILL_TEMPLATE_FOLDER || parts.len() < 2 {
        return None;
    }
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return None;
    }
    Some(path.to_owned())
}

// ---- frontmatter.ts ----

/// What the TypeScript throws while reading a SKILL.md: the `RangeError` of
/// `String.fromCodePoint`
#[derive(Debug, Clone, PartialEq)]
pub struct SkillMdError(pub String);

/// `ParsedSkillMd`
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSkillMd {
    pub name: Option<String>,
    pub description: Option<String>,
    /// the one-level `metadata` map, scalar values only
    pub metadata: JsObject<String>,
    /// every top-level key with a scalar value
    pub fields: JsObject<String>,
    /// every top-level key whose value is a list of scalars, such as `allowed-tools`
    pub lists: JsObject<Vec<String>>,
    /// everything after the closing `---` line, as written
    pub body: String,
}

struct Line {
    text: String,
    indent: usize,
    blank: bool,
}

/// One top-level key with the lines that belong to it
struct Block {
    /// `None` for comments and other lines before the first key
    key: Option<String>,
    /// what follows `key:` on the key line
    inline: String,
    /// the lines after the key line, until the next top-level key
    children: Vec<Line>,
    /// the key line and its children, as written
    raw: Vec<String>,
}

struct MapEntry {
    key: String,
    inline: String,
    children: Vec<Line>,
    raw: Vec<String>,
}

struct BlockMap {
    indent: usize,
    entries: Vec<MapEntry>,
    lead: Vec<String>,
}

const KEY_LINE: &str = r#"^([ \t]*)((?!- )(?!-$)[^\s#'"][^:]*?)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$"#;

fn to_line(text: &str) -> Line {
    let indent = text.chars().count() - trim_start(text).chars().count();
    Line {
        text: text.to_owned(),
        indent,
        blank: trim(text).is_empty(),
    }
}

/// `text.trimEnd()`
fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// `text.slice(n)` for a text whose first `n` units are single-unit characters
fn skip_chars(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((at, _)) => &text[at..],
        None => "",
    }
}

/// Front matter lines and the body, or `None` when the file has no front matter
fn split_frontmatter(text: &str) -> Option<(Vec<String>, String)> {
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    let open = js_regex!(r"^---[ \t]*\r?\n").exec(source)?;
    let mut lines: Vec<String> = Vec::new();
    let mut at = open.end();
    let close = js_regex!(r"^---[ \t]*$");
    while at <= source.len() {
        let end = source[at..].find('\n').map(|found| found + at);
        let line_end = end.unwrap_or(source.len());
        let line = &source[at..line_end];
        let line = line.strip_suffix('\r').unwrap_or(line);
        if close.test(line) {
            let body = match end {
                None => String::new(),
                Some(end) => source[end + 1..].to_owned(),
            };
            return Some((lines, body));
        }
        let end = end?;
        lines.push(line.to_owned());
        at = end + 1;
    }
    None
}

fn blocks_of(lines: &[String]) -> Vec<Block> {
    let key_line = js_regex!(KEY_LINE);
    let mut blocks: Vec<Block> = Vec::new();
    for text in lines {
        let found = if text.starts_with(' ') || text.starts_with('\t') {
            None
        } else {
            key_line.exec(text)
        };
        if let Some(found) = found {
            blocks.push(Block {
                key: found.get(2).map(str::to_owned),
                inline: found.get(3).unwrap_or("").to_owned(),
                children: Vec::new(),
                raw: vec![text.clone()],
            });
            continue;
        }
        if blocks.is_empty() {
            blocks.push(Block {
                key: None,
                inline: String::new(),
                children: Vec::new(),
                raw: Vec::new(),
            });
        }
        let current = blocks.last_mut().expect("a block was just pushed");
        current.raw.push(text.clone());
        if current.key.is_some() {
            current.children.push(to_line(text));
        }
    }
    blocks
}

fn strip_comment(value: &str) -> String {
    if value.starts_with('#') {
        return String::new();
    }
    let cut = match js_regex!(r"[ \t]#").exec(value) {
        Some(found) => &value[..found.start()],
        None => value,
    };
    trim_end(cut).to_owned()
}

fn escape_of(ch: char) -> Option<char> {
    Some(match ch {
        '0' => '\0',
        'a' => '\x07',
        'b' => '\x08',
        't' | '\t' => '\t',
        'n' => '\n',
        'v' => '\x0b',
        'f' => '\x0c',
        'r' => '\r',
        'e' => '\x1b',
        ' ' => ' ',
        '"' => '"',
        '/' => '/',
        '\\' => '\\',
        'N' => '\u{85}',
        '_' => '\u{a0}',
        'L' => '\u{2028}',
        'P' => '\u{2029}',
        _ => return None,
    })
}

/// Characters YAML cannot hold unquoted: C0 controls, DEL, NEL and the Unicode line breaks
fn has_break_or_control(value: &str, allow_tab_and_newline: bool) -> bool {
    for ch in value.chars() {
        let code = ch as u32;
        if allow_tab_and_newline && (code == 0x09 || code == 0x0a) {
            continue;
        }
        if code < 0x20 || code == 0x7f || code == 0x85 || code == 0x2028 || code == 0x2029 {
            return true;
        }
    }
    false
}

fn read_double_quoted(text: &str) -> Result<Option<String>, SkillMdError> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 1;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '"' {
            return Ok(Some(out));
        }
        if ch != '\\' {
            out.push(ch);
            i += 1;
            continue;
        }
        let Some(&next) = chars.get(i + 1) else {
            return Ok(None);
        };
        let width = match next {
            'x' => 2,
            'u' => 4,
            'U' => 8,
            _ => 0,
        };
        if width > 0 {
            let hex: String = chars.iter().skip(i + 2).take(width).collect();
            if hex.chars().count() != width || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return Ok(None);
            }
            let code = u32::from_str_radix(&hex, 16).expect("hex digits of at most 8 places");
            if code > 0x10ffff {
                return Err(SkillMdError(format!("Invalid code point {code}")));
            }
            out.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
            i += 2 + width;
            continue;
        }
        out.push(escape_of(next).unwrap_or(next));
        i += 2;
    }
    Ok(None)
}

fn read_single_quoted(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 1;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\'' {
            if chars.get(i + 1) == Some(&'\'') {
                out.push('\'');
                i += 2;
                continue;
            }
            return Some(out);
        }
        out.push(ch);
        i += 1;
    }
    None
}

/// Join lines the way YAML folds flow scalars: a break is a space, an empty line a newline
fn fold_flow(parts: &[String]) -> String {
    let mut out = String::new();
    let mut empties = 0;
    let mut started = false;
    for part in parts {
        if part.is_empty() {
            empties += 1;
            continue;
        }
        if started {
            if empties > 0 {
                out.push_str(&"\n".repeat(empties));
            } else {
                out.push(' ');
            }
        }
        out.push_str(part);
        started = true;
        empties = 0;
    }
    out
}

fn read_block_scalar(header: &str, children: &[Line], parent_indent: usize) -> String {
    let header_match = js_regex!(r"^([|>])([+-]?)([1-9]?)([+-]?)").exec(header);
    let group = |n: usize| {
        header_match
            .as_ref()
            .and_then(|found| found.get(n))
            .unwrap_or("")
    };
    let folded = group(1) == ">";
    let chomp = if group(2).is_empty() {
        group(4)
    } else {
        group(2)
    };
    let explicit = if group(3).is_empty() {
        None
    } else {
        Some(parent_indent + group(3).parse::<usize>().expect("a digit"))
    };
    let first = children.iter().find(|line| !line.blank);
    let indent = explicit.unwrap_or_else(|| first.map_or(parent_indent + 1, |line| line.indent));
    let mut content: Vec<String> = Vec::new();
    for line in children {
        if line.blank {
            let units = line.text.chars().count();
            content.push(if units > indent {
                skip_chars(&line.text, indent).to_owned()
            } else {
                String::new()
            });
            continue;
        }
        if line.indent < indent {
            break;
        }
        content.push(skip_chars(&line.text, indent).to_owned());
    }
    let mut trailing = 0;
    while content.last().is_some_and(|last| trim(last).is_empty()) {
        content.pop();
        trailing += 1;
    }
    let body = if !folded {
        content.join("\n")
    } else {
        let mut body = String::new();
        let mut empties = 0;
        let mut started = false;
        let mut last_more = false;
        for line in &content {
            if line.is_empty() {
                empties += 1;
                continue;
            }
            let more = line.starts_with(' ') || line.starts_with('\t');
            if !started {
                body.push_str(&"\n".repeat(empties));
            } else if empties == 0 && !more && !last_more {
                body.push(' ');
            } else if !more && !last_more {
                body.push_str(&"\n".repeat(empties));
            } else {
                body.push_str(&"\n".repeat(empties + 1));
            }
            body.push_str(line);
            started = true;
            empties = 0;
            last_more = more;
        }
        body
    };
    if content.is_empty() {
        return if chomp == "+" {
            "\n".repeat(trailing)
        } else {
            String::new()
        };
    }
    if chomp == "-" {
        return body;
    }
    if chomp == "+" {
        return format!("{body}\n{}", "\n".repeat(trailing));
    }
    format!("{body}\n")
}

/// The scalar value of a key: what follows the colon and the lines under it.
/// `None` when the value is a map, a list, or not readable.
fn read_scalar(
    inline: &str,
    children: &[Line],
    parent_indent: usize,
) -> Result<Option<String>, SkillMdError> {
    let value = trim(inline);
    if value.starts_with('|') || value.starts_with('>') {
        return Ok(Some(read_block_scalar(value, children, parent_indent)));
    }
    let more: Vec<&Line> = children
        .iter()
        .filter(|line| line.indent > parent_indent || line.blank)
        .collect();
    if value.starts_with('"') || value.starts_with('\'') {
        let mut parts = vec![value.to_owned()];
        parts.extend(more.iter().map(|line| trim(&line.text).to_owned()));
        let joined = fold_flow(&parts);
        return if value.starts_with('"') {
            read_double_quoted(&joined)
        } else {
            Ok(read_single_quoted(&joined))
        };
    }
    if value.starts_with('[') || value.starts_with('{') {
        return Ok(None);
    }
    let head = strip_comment(value);
    let key_line = js_regex!(KEY_LINE);
    let mut rest: Vec<String> = Vec::new();
    for line in &more {
        let text = trim(&line.text);
        if text.starts_with('#') {
            break;
        }
        if !line.blank && (text.starts_with("- ") || text == "-" || key_line.test(text)) {
            return Ok(None);
        }
        rest.push(if line.blank {
            String::new()
        } else {
            strip_comment(text)
        });
    }
    while rest.last().is_some_and(|last| last.is_empty()) {
        rest.pop();
    }
    if head.is_empty() && rest.is_empty() {
        return Ok(Some(String::new()));
    }
    let mut parts = vec![head];
    parts.extend(rest);
    Ok(Some(trim(&fold_flow(&parts)).to_owned()))
}

/// One item of a list: a plain or quoted scalar; `None` for a map, a list or a block
fn read_list_item(raw: &str) -> Result<Option<String>, SkillMdError> {
    let text = trim(raw);
    if text.starts_with('"') {
        return read_double_quoted(text);
    }
    if text.starts_with('\'') {
        return Ok(read_single_quoted(text));
    }
    if js_regex!(r"^[[{|>]").test(text)
        || text == "-"
        || text.starts_with("- ")
        || js_regex!(KEY_LINE).test(text)
    {
        return Ok(None);
    }
    Ok(Some(trim(&strip_comment(text)).to_owned()))
}

/// The items of a flow list such as `[a, "b, c", 'd']`; `None` when it is not one
fn read_flow_list(text: &str) -> Result<Option<Vec<String>>, SkillMdError> {
    let value = trim(text);
    if !value.starts_with('[') || !value.ends_with(']') {
        return Ok(None);
    }
    let inner: Vec<char> = value.chars().collect();
    let inner = &inner[1..inner.len() - 1];
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < inner.len() {
        let ch = inner[i];
        if let Some(open) = quote {
            current.push(ch);
            if ch == '\\' && open == '"' && i + 1 < inner.len() {
                i += 1;
                current.push(inner[i]);
            } else if ch == open {
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
        }
        if ch == ',' {
            parts.push(std::mem::take(&mut current));
            i += 1;
            continue;
        }
        current.push(ch);
        i += 1;
    }
    if quote.is_some() {
        return Ok(None);
    }
    parts.push(current);
    let mut items: Vec<String> = Vec::new();
    for part in &parts {
        if trim(part).is_empty() {
            continue;
        }
        match read_list_item(part)? {
            Some(item) => items.push(item),
            None => return Ok(None),
        }
    }
    Ok(Some(items))
}

/// The items of a list value: `- item` lines (at the key's indent or deeper) or
/// a flow list. `None` when the value is not a list of scalars.
fn read_list(inline: &str, children: &[Line]) -> Result<Option<Vec<String>>, SkillMdError> {
    let value = strip_comment(trim(inline));
    if value.starts_with('[') {
        let mut parts = vec![value];
        parts.extend(
            children
                .iter()
                .filter(|line| !line.blank)
                .map(|line| trim(&line.text).to_owned()),
        );
        return read_flow_list(&parts.join(" "));
    }
    if !value.is_empty() {
        return Ok(None);
    }
    let mut raws: Vec<String> = Vec::new();
    let mut dash_indent: i64 = -1;
    for line in children {
        let text = trim(&line.text);
        if line.blank || text.starts_with('#') {
            continue;
        }
        if text == "-" || text.starts_with("- ") {
            if dash_indent == -1 {
                dash_indent = line.indent as i64;
            }
            if line.indent as i64 == dash_indent {
                raws.push(trim(&text[1..]).to_owned());
                continue;
            }
        }
        // a plain item going on over more lines
        if raws.is_empty() || line.indent as i64 <= dash_indent {
            return Ok(None);
        }
        let last = raws.last_mut().expect("a raw item is there");
        last.push(' ');
        last.push_str(text);
    }
    if raws.is_empty() {
        return Ok(None);
    }
    let mut items: Vec<String> = Vec::new();
    for raw in &raws {
        match read_list_item(raw)? {
            Some(item) => items.push(item),
            None => return Ok(None),
        }
    }
    Ok(Some(items))
}

/// The one-level map under a key, or `None` when the value is not a block map
fn read_map(block: &Block) -> Option<BlockMap> {
    if !strip_comment(trim(&block.inline)).is_empty() {
        return None;
    }
    let first = block
        .children
        .iter()
        .find(|line| !line.blank && !trim(&line.text).starts_with('#'));
    let Some(first) = first else {
        return Some(BlockMap {
            indent: 2,
            entries: Vec::new(),
            lead: Vec::new(),
        });
    };
    if first.indent == 0 {
        return Some(BlockMap {
            indent: 2,
            entries: Vec::new(),
            lead: Vec::new(),
        });
    }
    let key_line = js_regex!(KEY_LINE);
    let mut entries: Vec<MapEntry> = Vec::new();
    let mut lead: Vec<String> = Vec::new();
    for line in &block.children {
        let found = if line.indent == first.indent {
            key_line.exec(&line.text)
        } else {
            None
        };
        if let Some(found) = found {
            entries.push(MapEntry {
                key: found.get(2).unwrap_or("").to_owned(),
                inline: found.get(3).unwrap_or("").to_owned(),
                children: Vec::new(),
                raw: vec![line.text.clone()],
            });
            continue;
        }
        let Some(last) = entries.last_mut() else {
            if !line.blank && !trim(&line.text).starts_with('#') {
                return None;
            }
            lead.push(line.text.clone());
            continue;
        };
        last.raw.push(line.text.clone());
        last.children.push(Line {
            text: line.text.clone(),
            indent: line.indent,
            blank: line.blank,
        });
    }
    Some(BlockMap {
        indent: first.indent,
        entries,
        lead,
    })
}

fn set_plain<V>(object: &mut JsObject<V>, key: &str, value: V) {
    if key != "__proto__" {
        object.set(key, value);
    }
}

/// `parseSkillMd(text)`: read a SKILL.md. `None` when the file does not start
/// with a `---` line or the block is never closed.
pub fn parse_skill_md(text: &str) -> Result<Option<ParsedSkillMd>, SkillMdError> {
    let Some((lines, body)) = split_frontmatter(text) else {
        return Ok(None);
    };
    let mut fields: JsObject<String> = JsObject::new();
    let mut lists: JsObject<Vec<String>> = JsObject::new();
    let mut metadata: JsObject<String> = JsObject::new();
    for block in blocks_of(&lines) {
        let Some(key) = &block.key else {
            continue;
        };
        if key == "metadata" {
            let map = read_map(&block);
            if let Some(map) = &map {
                for entry in &map.entries {
                    if let Some(value) = read_scalar(&entry.inline, &entry.children, map.indent)? {
                        set_plain(&mut metadata, &entry.key, value);
                    }
                }
            }
            continue;
        }
        // a list first: lines `- item` at the key's indent read as an empty scalar
        if let Some(list) = read_list(&block.inline, &block.children)? {
            set_plain(&mut lists, key, list);
            continue;
        }
        if let Some(value) = read_scalar(&block.inline, &block.children, 0)? {
            set_plain(&mut fields, key, value);
        }
    }
    Ok(Some(ParsedSkillMd {
        name: fields.get("name").cloned(),
        description: fields.get("description").cloned(),
        metadata,
        fields,
        lists,
        body,
    }))
}

fn plain_safe(value: &str) -> bool {
    !value.is_empty()
        && value == trim(value)
        && !js_regex!(r#"^[\s\-?:,[\]{}#&*!|>'"%@`]"#).test(value)
        && !js_regex!(r"^(?:true|false|yes|no|on|off|y|n|null|~)$", "i").test(value)
        && !js_regex!(r"^[-+]?(?:\d|\.\d)").test(value)
        && !value.contains(": ")
        && !value.contains(" #")
        && !value.ends_with(':')
        && !has_break_or_control(value, false)
}

/// The text after `key:` for a value written at `indent` (lines of a literal block included)
fn write_scalar(value: &str, indent: usize) -> Vec<String> {
    if plain_safe(value) {
        return vec![format!(" {value}")];
    }
    let mut lines: Vec<&str> = value.split('\n').collect();
    let first_text = lines.iter().find(|line| !line.is_empty());
    let literal = value.contains('\n')
        && first_text.is_some_and(|text| !js_regex!(r"^[ \t]").test(text))
        && !value.contains('\r')
        && lines
            .iter()
            .all(|line| line.is_empty() || !trim(line).is_empty())
        && !has_break_or_control(value, true);
    if !literal {
        return vec![format!(" {}", json_quote(value))];
    }
    let mut trailing = 0;
    while lines.last().is_some_and(|last| last.is_empty()) {
        lines.pop();
        trailing += 1;
    }
    let chomp = match trailing {
        0 => "-",
        1 => "",
        _ => "+",
    };
    let pad = " ".repeat(indent + 2);
    let mut out = vec![format!(" |{chomp}")];
    out.extend(lines.iter().map(|line| {
        if line.is_empty() {
            String::new()
        } else {
            format!("{pad}{line}")
        }
    }));
    if trailing > 1 {
        for _ in 1..trailing {
            out.push(String::new());
        }
    }
    out
}

/// A value of a top-level key set by [`SkillMdInput::fields`]
#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    Text(String),
    Bool(bool),
}

fn key_value(key: &str, value: &FieldValue, indent: usize) -> Vec<String> {
    let written = match value {
        FieldValue::Bool(flag) => vec![format!(" {flag}")],
        FieldValue::Text(text) => write_scalar(text, indent),
    };
    let mut out = vec![format!("{}{key}:{}", " ".repeat(indent), written[0])];
    out.extend(written.into_iter().skip(1));
    out
}

/// `editors` of `SkillMdInput`: undefined keeps what the file has, `null`
/// takes the key out, a string sets it
#[derive(Debug, Clone, PartialEq)]
pub enum EditorsText {
    Keep,
    Remove,
    Set(String),
}

/// `SkillMdInput`
#[derive(Debug, Clone)]
pub struct SkillMdInput {
    pub name: String,
    pub description: String,
    /// `metadata.ieum-title`; left out when `None`
    pub title: Option<String>,
    /// `metadata.ieum-template`; left out when `None`
    pub template: Option<String>,
    pub editors: EditorsText,
    pub body: String,
    /// other top-level keys to set, such as `disable-model-invocation`
    pub fields: Vec<(String, FieldValue)>,
}

/// `value === scalar read` of the TypeScript: whether the written value reads back as `value`
fn reads_as(
    inline: &str,
    children: &[Line],
    indent: usize,
    value: &FieldValue,
) -> Result<bool, SkillMdError> {
    let read = read_scalar(inline, children, indent)?;
    Ok(match (read, value) {
        (Some(read), FieldValue::Text(text)) => read == *text,
        _ => false,
    })
}

/// `renderSkillMd(input, base)`: write a SKILL.md in the standard shape:
/// `name`, `description`, and this app's values under `metadata`. With `base`
/// (the file being rewritten), its other keys and other metadata entries stay
/// as they were written, in place, and so does a key whose value is not changed.
pub fn render_skill_md(input: &SkillMdInput, base: Option<&str>) -> Result<String, SkillMdError> {
    let mut ieum: Vec<(String, String)> = Vec::new();
    if let Some(title) = &input.title {
        ieum.push((IEUM_TITLE_KEY.to_owned(), title.clone()));
    }
    if let Some(template) = &input.template {
        ieum.push((IEUM_TEMPLATE_KEY.to_owned(), template.clone()));
    }
    if let EditorsText::Set(editors) = &input.editors {
        ieum.push((IEUM_EDITORS_KEY.to_owned(), editors.clone()));
    }
    let mut managed: Vec<&str> = vec![IEUM_TITLE_KEY, IEUM_TEMPLATE_KEY];
    if input.editors != EditorsText::Keep {
        managed.push(IEUM_EDITORS_KEY);
    }
    let mut fields: JsMap<FieldValue> = JsMap::new();
    fields.set("name", FieldValue::Text(input.name.clone()));
    fields.set("description", FieldValue::Text(input.description.clone()));
    for (key, value) in &input.fields {
        fields.set(key.as_str(), value.clone());
    }

    let metadata_lines = |block: Option<&Block>| -> Result<Vec<String>, SkillMdError> {
        let map = block.and_then(read_map);
        if let Some(block) = block
            && map.is_none()
        {
            // a metadata value this reader does not understand: keep it unless app values must go in
            if ieum.is_empty() {
                return Ok(block.raw.clone());
            }
        }
        let indent = map.as_ref().map_or(2, |map| map.indent);
        let mut pending: JsMap<String> = JsMap::new();
        for (key, value) in &ieum {
            pending.set(key.as_str(), value.clone());
        }
        let mut lines: Vec<String> = map.as_ref().map_or_else(Vec::new, |map| map.lead.clone());
        let mut kept = 0;
        if let Some(map) = &map {
            for entry in &map.entries {
                if managed.contains(&entry.key.as_str()) {
                    let value = pending.get(&entry.key).cloned();
                    pending.delete(&entry.key);
                    let Some(value) = value else {
                        continue;
                    };
                    let value = FieldValue::Text(value);
                    let same = reads_as(&entry.inline, &entry.children, indent, &value)?;
                    if same {
                        lines.extend(entry.raw.iter().cloned());
                    } else {
                        lines.extend(key_value(&entry.key, &value, indent));
                    }
                } else {
                    lines.extend(entry.raw.iter().cloned());
                }
                kept += 1;
            }
        }
        for (key, value) in pending.iter() {
            lines.extend(key_value(key, &FieldValue::Text(value.clone()), indent));
            kept += 1;
        }
        if kept == 0 {
            return Ok(Vec::new());
        }
        let mut out = vec!["metadata:".to_owned()];
        out.extend(lines);
        Ok(out)
    };

    let mut out: Vec<String> = Vec::new();
    let mut written: Vec<String> = Vec::new();
    let mut metadata_written = false;
    let blocks = match base.filter(|base| !base.is_empty()) {
        Some(base) => {
            let lines = split_frontmatter(base).map(|split| split.0);
            blocks_of(&lines.unwrap_or_default())
        }
        None => Vec::new(),
    };
    for block in &blocks {
        let Some(key) = &block.key else {
            out.extend(block.raw.iter().cloned());
            continue;
        };
        if key == "metadata" {
            if !metadata_written {
                out.extend(metadata_lines(Some(block))?);
            }
            metadata_written = true;
            continue;
        }
        let Some(value) = fields.get(key) else {
            out.extend(block.raw.iter().cloned());
            continue;
        };
        if !written.contains(key) {
            let same = reads_as(&block.inline, &block.children, 0, value)?;
            if same {
                out.extend(block.raw.iter().cloned());
            } else {
                out.extend(key_value(key, value, 0));
            }
        }
        written.push(key.clone());
    }
    let missing: Vec<(&str, &FieldValue)> = fields
        .iter()
        .filter(|(key, _)| !written.iter().any(|done| done.as_str() == *key))
        .collect();
    for (key, value) in missing
        .iter()
        .filter(|(key, _)| *key == "name" || *key == "description")
    {
        out.extend(key_value(key, value, 0));
    }
    if !metadata_written {
        out.extend(metadata_lines(None)?);
    }
    for (key, value) in missing
        .iter()
        .filter(|(key, _)| *key != "name" && *key != "description")
    {
        out.extend(key_value(key, value, 0));
    }
    Ok(format!("---\n{}\n---\n{}", out.join("\n"), input.body))
}

/// `withoutSkillEditors(text)`: a SKILL.md without this app's where-used
/// value, every other byte of the front matter as written. A file that names
/// none, or cannot be read, comes back unchanged.
pub fn without_skill_editors(text: &str) -> Result<String, SkillMdError> {
    let Some(parsed) = parse_skill_md(text)? else {
        return Ok(text.to_owned());
    };
    let name = parsed.name.clone().filter(|name| !name.is_empty());
    let (Some(name), Some(_)) = (name, parsed.metadata.get(IEUM_EDITORS_KEY)) else {
        return Ok(text.to_owned());
    };
    render_skill_md(
        &SkillMdInput {
            name,
            description: parsed.description.clone().unwrap_or_default(),
            title: parsed.metadata.get(IEUM_TITLE_KEY).cloned(),
            template: parsed.metadata.get(IEUM_TEMPLATE_KEY).cloned(),
            editors: EditorsText::Remove,
            body: parsed.body.clone(),
            fields: Vec::new(),
        },
        Some(text),
    )
}
