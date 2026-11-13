//! `apps/shell/src/main/projects/ignore.ts`: `.seuoffice/ignore`, the files
//! and folders the AI does not see (spec 3).
//!
//! One pattern per line. Blank lines and lines starting with `#` are skipped.
//! `*` matches within one path segment, `?` one character, `**` any number of
//! folders. A trailing `/` matches folders only; a leading `/` anchors the
//! pattern to the project folder, otherwise it matches at any depth. There is
//! no `!` (re-include); such lines are skipped. Case is folded on Windows and
//! macOS. A matched folder hides everything inside it.
//!
//! The patterns are built at run time from the file's text, so each is a
//! `TryJsRegex` and a search that reaches the backtrack bound is a
//! `RegexLimit` the caller refuses with, never "no match".

use jscompat::{RegexLimit, RegexSyntaxError, TryJsRegex, js_regex, trim};

use crate::packages::project_store::nfc;

/// `IgnoreMatcher`: the patterns in effect and the test of a path
#[derive(Debug)]
pub struct IgnoreMatcher {
    /// The patterns in effect, as written (comments and blank lines removed)
    pub patterns: Vec<String>,
    compiled: Vec<CompiledPattern>,
}

/// `IgnoreOptions`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IgnoreOptions {
    pub case_insensitive: bool,
}

/// `ignoreFoldsCase(platform)`: case is folded where the file system ignores it
pub fn ignore_folds_case(platform: &str) -> bool {
    platform == "win32" || platform == "darwin"
}

/// `CompiledPattern`
#[derive(Debug)]
struct CompiledPattern {
    regex: TryJsRegex,
    dir_only: bool,
}

/// `REGEX_SYNTAX`: `/[\\^$.*+?()[\]{}|/]/`
fn is_regex_syntax(c: char) -> bool {
    matches!(
        c,
        '\\' | '^' | '$' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '/'
    )
}

/// `segmentSource(segment)`
fn segment_source(segment: &str) -> String {
    let mut out = String::new();
    for c in segment.chars() {
        if c == '*' {
            out.push_str("[^/]*");
        } else if c == '?' {
            out.push_str("[^/]");
        } else {
            if is_regex_syntax(c) {
                out.push('\\');
            }
            out.push(c);
        }
    }
    // `**` inside a segment (not a whole segment) behaves like `*`:
    // `.replace(/(?:\[\^\/\]\*)+/g, '[^/]*')`
    const STAR: &str = "[^/]*";
    let mut collapsed = String::new();
    let mut rest = out.as_str();
    while let Some(at) = rest.find(STAR) {
        collapsed.push_str(&rest[..at]);
        collapsed.push_str(STAR);
        rest = &rest[at + STAR.len()..];
        while let Some(more) = rest.strip_prefix(STAR) {
            rest = more;
        }
    }
    collapsed.push_str(rest);
    collapsed
}

/// `compileLine(line, options)`: `Ok(None)` is `null`; `Err` is the
/// `SyntaxError` of `new RegExp`.
fn compile_line(
    line: &str,
    options: IgnoreOptions,
) -> Result<Option<CompiledPattern>, RegexSyntaxError> {
    let pattern = nfc(trim(line)).replace('\\', "/");
    if pattern.is_empty() || pattern.starts_with('#') || pattern.starts_with('!') {
        return Ok(None);
    }
    let dir_only = pattern.ends_with('/');
    let pattern = pattern.trim_end_matches('/');
    let anchored = pattern.starts_with('/');
    let pattern = pattern.trim_start_matches('/');
    let segments: Vec<&str> = pattern
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty() {
        return Ok(None);
    }

    let mut body = String::new();
    for (index, segment) in segments.iter().enumerate() {
        let last = index == segments.len() - 1;
        if *segment == "**" {
            body.push_str(if last { ".*" } else { "(?:[^/]+/)*" });
            continue;
        }
        body.push_str(&segment_source(segment));
        if !last {
            body.push('/');
        }
    }
    let source = format!("^{}{body}$", if anchored { "" } else { "(?:.*/)?" });
    let flags = if options.case_insensitive { "iu" } else { "u" };
    Ok(Some(CompiledPattern {
        regex: TryJsRegex::new(&source, flags)?,
        dir_only,
    }))
}

/// `compileIgnore(text, options)`: `Err` is the `SyntaxError` a pattern's
/// `new RegExp` throws.
pub fn compile_ignore(
    text: &str,
    options: IgnoreOptions,
) -> Result<IgnoreMatcher, RegexSyntaxError> {
    let mut patterns = Vec::new();
    let mut compiled = Vec::new();
    for line in js_regex!(r"\r?\n").split(text) {
        let Some(pattern) = compile_line(line, options)? else {
            continue;
        };
        patterns.push(trim(line).to_owned());
        compiled.push(pattern);
    }
    Ok(IgnoreMatcher { patterns, compiled })
}

impl IgnoreMatcher {
    /// `matchesOne(path, isDir)`
    fn matches_one(&self, path: &str, is_dir: bool) -> Result<bool, RegexLimit> {
        for pattern in &self.compiled {
            if (!pattern.dir_only || is_dir) && pattern.regex.try_test(path)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `ignores(relPath, isDir)`: whether a folder-relative path (either
    /// separator) is ignored, itself or through a folder above it. `isDir`
    /// is `false` where the TypeScript leaves it out.
    pub fn ignores(&self, rel_path: &str, is_dir: bool) -> Result<bool, RegexLimit> {
        if self.compiled.is_empty() {
            return Ok(false);
        }
        let normalized = nfc(rel_path).replace('\\', "/");
        let segments: Vec<&str> = normalized
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        for end in 1..=segments.len() {
            let is_last = end == segments.len();
            if self.matches_one(
                &segments[..end].join("/"),
                if is_last { is_dir } else { true },
            )? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// `ignoreLineFor(relPath)`: the line "hide this path from AI" adds: anchored,
/// with wildcard characters made harmless
pub fn ignore_line_for(rel_path: &str) -> String {
    let normalized = nfc(rel_path).replace('\\', "/");
    let clean = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    // A name holding `*` cannot be written literally; `?` matches that one character.
    format!("/{}", clean.replace('*', "?"))
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

/// `sameLineFor(line, relPath)`
fn same_line_for(line: &str, rel_path: &str) -> bool {
    let wanted = ignore_line_for(rel_path);
    let trimmed = nfc(trim(line)).replace('\\', "/");
    trimmed == wanted || format!("/{trimmed}") == wanted
}

/// `addIgnoreLine(text, relPath)`: `text` with the line for `relPath` added
/// at the end (unchanged when already there)
pub fn add_ignore_line(text: &str, rel_path: &str) -> String {
    let mut lines = lines_of(text);
    if lines.iter().any(|line| same_line_for(line, rel_path)) {
        return text.to_owned();
    }
    lines.push(ignore_line_for(rel_path));
    format!("{}\n", lines.join("\n"))
}

/// `removeIgnoreLine(text, relPath)`: `text` without the lines naming exactly
/// `relPath` (with or without the leading slash)
pub fn remove_ignore_line(text: &str, rel_path: &str) -> String {
    let lines = lines_of(text);
    let kept: Vec<&String> = lines
        .iter()
        .filter(|line| !same_line_for(line, rel_path))
        .collect();
    if kept.len() == lines.len() {
        return text.to_owned();
    }
    if kept.is_empty() {
        String::new()
    } else {
        format!(
            "{}\n",
            kept.iter()
                .map(|line| line.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        )
    }
}
