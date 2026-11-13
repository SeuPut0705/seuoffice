//! Every regex the workspace builds, read from the source: no pattern is one
//! `JsRegex::new` refuses where JavaScript builds it; no `JsRegex` holds a
//! pattern whose search can pass `BACKTRACK_LIMIT`, or one this test cannot
//! read, so its searches cannot fail; and no search is restarted once per
//! match with a regex that reads the text ahead, but for those listed.

use std::fs;
use std::path::Path;

use jscompat::{JsRegex, js_regex};

/// One call of `js_regex!` or `JsRegex::new`: its string literals as written,
/// each with whether it is an argument of the call itself; whether the last
/// of them is the last argument; and the length of the call in the source.
fn literals_of_call(source: &str) -> (Vec<(String, bool)>, bool, usize) {
    let bytes = source.as_bytes();
    let (mut at, mut depth) = (0, 1);
    let mut literals = Vec::new();
    let mut last_literal_end = 0;
    while at < bytes.len() && depth > 0 {
        let rest = &source[at..];
        let after_name =
            at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        if rest.starts_with("//") {
            at += rest.find('\n').unwrap_or(rest.len());
        } else if after_name
            && rest.starts_with('r')
            && rest[1..].trim_start_matches('#').starts_with('"')
        {
            let hashes = rest[1..].len() - rest[1..].trim_start_matches('#').len();
            let close = format!("\"{}", "#".repeat(hashes));
            let body = &rest[2 + hashes..];
            let end = body.find(&close).expect("a raw string that ends");
            literals.push((body[..end].to_owned(), depth == 1));
            at += 2 + hashes + end + close.len();
            last_literal_end = at;
        } else if let Some(body) = rest.strip_prefix('"') {
            let mut text = String::new();
            let mut chars = body.char_indices();
            let end = loop {
                match chars.next().expect("a string that ends") {
                    (index, '"') => break index,
                    (_, '\\') => match chars.next().expect("an escape").1 {
                        'n' => text.push('\n'),
                        'r' => text.push('\r'),
                        't' => text.push('\t'),
                        '0' => text.push('\0'),
                        'u' => {
                            let hex: String = chars
                                .by_ref()
                                .skip(1)
                                .map(|(_, c)| c)
                                .take_while(|c| *c != '}')
                                .collect();
                            text.push(
                                char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap(),
                            );
                        }
                        'x' => {
                            let hex: String = chars.by_ref().take(2).map(|(_, c)| c).collect();
                            text.push(char::from(u8::from_str_radix(&hex, 16).unwrap()));
                        }
                        '\n' => {
                            let skipped =
                                chars.clone().take_while(|(_, c)| c.is_whitespace()).count();
                            chars.by_ref().take(skipped).for_each(drop);
                        }
                        other => text.push(other),
                    },
                    (_, c) => text.push(c),
                }
            };
            literals.push((text, depth == 1));
            at += 1 + end + 1;
            last_literal_end = at;
        } else if rest.starts_with('\'') && rest[1..].starts_with('\\') {
            at += 2 + rest[2..].find('\'').expect("a char that ends") + 1;
        } else if rest.starts_with('\'') && rest.chars().nth(2) == Some('\'') {
            at += rest.chars().take(3).map(char::len_utf8).sum::<usize>();
        } else {
            match bytes[at] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                _ => {}
            }
            at += rest.chars().next().map_or(1, char::len_utf8);
        }
    }
    let after_last =
        source[last_literal_end..at].trim_matches(|c: char| c.is_whitespace() || c == ',');
    (literals, after_last == ")", at)
}

fn rust_files(dir: &Path, found: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            // build output, and third-party source that is not ported code
            if path
                .file_name()
                .is_some_and(|name| name != "target" && name != "vendor")
            {
                rust_files(&path, found);
            }
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

/// Calls of `find_from` and `try_find_from` whose regex reads the text ahead
/// of each search, or is not written at the call so that this test cannot
/// tell. `find_from` is
/// how a loop restarts a search once per match; with such a regex every
/// restart reads the rest of the text again (measured: 2,000 restarts over
/// 2 MB took 0.5 s, and 31 s where the text holds a character outside the
/// BMP). A new call fails this test. List it here only when it restarts at
/// most a few times, or over a short text, or its regex reads nothing ahead;
/// otherwise search once with `find_iter`.
const RESTARTS_THAT_MAY_READ_AHEAD: &[(&str, usize)] = &[
    // innerTextRanges and the c:pt edits of one series: one pass from the
    // start of its range, stopped at its end
    ("docx-engine/src/save/features/chart_write.rs", 2),
    // occupiedRelIds: one pass over the attributes of one tag
    ("docx-engine/src/save/save/helpers.rs", 1),
    // one search per SDT, over a pattern held in a constant
    ("docx-engine/src/sdt.rs", 1),
    // commentEntries: a search restarts only where a match began inside the
    // comment just read and ended past it
    ("docx-engine/src/withheld.rs", 1),
    // one pass over the attributes of one tag
    ("ooxml-pkg/src/normalize.rs", 1),
    // scanSlide: one pass over the shape tree, once per part it scans
    ("pptx-engine/src/scan.rs", 1),
];

#[derive(Default, Debug, PartialEq)]
struct Sites {
    /// Calls whose flags and patterns were read.
    read: usize,
    /// Those without `u`: a text outside the BMP is searched as units.
    without_u: usize,
    /// Of those, with a counted quantifier: `{n}`, `{n,}`, `{n,m}`.
    counted: usize,
    /// Of those, with a lookbehind.
    lookbehind: usize,
    /// Under `i` without `u`: the text is searched through a shadow.
    icase: usize,
    /// Patterns that are `format!` templates, filled here with `x`.
    templates: usize,
    /// Patterns that hold a character outside ASCII.
    outside_ascii: usize,
    /// Patterns JavaScript rejects as well: a test of that.
    rejected: usize,
    /// Regexes that read the text ahead of each search (`JsRegex::reads_ahead`).
    reads_ahead: usize,
    /// Regexes with a loop that keeps entries on the backtrack stack for each
    /// turn until the match ends: `regress` compiles the loop as `EnterLoop`
    /// (its body is more than one character matcher), and the loops of the
    /// pattern may turn more than 4,096 times together. Each is a `TryJsRegex`.
    grows_per_turn: usize,
    /// Regexes with a lazy loop over a character matcher nothing in a part
    /// stops (`[\s\S]*?`, `.*?`). Information only: the vendored regress takes
    /// one character per backtrack there, where 0.12.0 walked to the end.
    lazy_walks: usize,
    /// Regexes built as a `TryJsRegex`.
    fallible: usize,
    /// Patterns a macro writes with `concat!`, read at each use with the
    /// literal it is given (also counted in `read`).
    from_macros: usize,
}

/// The loops of a regex. Whether one keeps stack entries per turn without a
/// small bound, read from the `Debug` text of the compiled program. And
/// whether one is a lazy loop without a bound over a single character matcher
/// that accepts `<`, `>` and a letter, so that nothing in a part stops the
/// walk `regress` makes ahead of it: read from the pattern, as the atom before
/// `*?` or `+?`.
fn loops_of(regex: &JsRegex, pattern: &str) -> (bool, bool) {
    let program = format!("{regex:?}");
    // the turns of all its loops multiplied, as if each were inside the others
    let turns = program
        .split("EnterLoop(")
        .skip(1)
        .fold(1u64, |turns, fields| {
            let digits = fields.split("max_iters: ").nth(1).unwrap_or("0");
            let digits = &digits[..digits
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(digits.len())];
            turns.saturating_mul(digits.parse::<u64>().unwrap().max(1))
        });
    let grows = turns > 4096;
    let bytes = pattern.as_bytes();
    let escaped = |at: usize| {
        bytes[..at]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count()
            % 2
            == 1
    };
    let lazy = (2..bytes.len()).any(|at| {
        if bytes[at] != b'?' || !matches!(bytes[at - 1], b'*' | b'+') || escaped(at - 1) {
            return false;
        }
        let end = at - 1;
        let atom = match bytes[end - 1] {
            b'.' if !escaped(end - 1) => ".",
            b']' if !escaped(end - 1) => match (0..end - 1)
                .rev()
                .find(|open| bytes[*open] == b'[' && !escaped(*open))
            {
                Some(open) => &pattern[open..end],
                None => return false,
            },
            _ if end >= 2 && escaped(end - 1) => &pattern[end - 2..end],
            _ => return false,
        };
        JsRegex::new(&format!("^{atom}{{3}}$"), "").is_ok_and(|class| class.test("<a>"))
    });
    (grows, lazy)
}

/// The arguments of a call whose source starts after its `(`, as written.
fn arguments_of(call: &str) -> Vec<&str> {
    let bytes = call.as_bytes();
    let (mut depth, mut at, mut start) = (0usize, 0, 0);
    let mut arguments = Vec::new();
    while at < bytes.len() {
        let ident_before =
            at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        match bytes[at] {
            b'"' => {
                at += 1;
                while at < bytes.len() && bytes[at] != b'"' {
                    at += if bytes[at] == b'\\' { 2 } else { 1 };
                }
            }
            b'r' if !ident_before && matches!(bytes.get(at + 1), Some(b'"' | b'#')) => {
                let hashes = bytes[at + 1..]
                    .iter()
                    .take_while(|byte| **byte == b'#')
                    .count();
                let close = format!("\"{}", "#".repeat(hashes));
                let open = at + 2 + hashes;
                at = open + call[open..].find(&close).unwrap() + close.len() - 1;
            }
            // a character literal, not a lifetime
            b'\'' if bytes.get(at + 2) == Some(&b'\'') => at += 2,
            b'\'' if bytes.get(at + 1) == Some(&b'\\') => {
                at += call[at + 2..].find('\'').unwrap() + 2;
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth == 0 => break,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                arguments.push(call[start..at].trim());
                start = at + 1;
            }
            _ => {}
        }
        at += 1;
    }
    arguments.push(call[start..at.min(call.len())].trim());
    arguments.retain(|argument| !argument.is_empty());
    arguments
}

/// The text of an argument that is one string literal.
fn literal_of(argument: &str) -> Option<String> {
    if !(argument.starts_with('"') || argument.starts_with("r\"") || argument.starts_with("r#")) {
        return None;
    }
    let (literals, ends_in_a_literal, _) = literals_of_call(&format!("{argument})"));
    match &literals[..] {
        [(literal, true)] if ends_in_a_literal => Some(literal.clone()),
        _ => None,
    }
}

/// A pattern written in a `macro_rules!` as `concat!` of literals and one
/// literal parameter of the macro: read at each use of the macro.
struct MacroPattern {
    name: String,
    /// The pieces of the `concat!`, `None` where the parameter goes.
    pieces: Vec<Option<String>>,
    flags: String,
    fallible: bool,
}

/// The pieces of `concat!(...)`, whose source starts after its `(`; `None`
/// unless each is a literal or the one parameter of the macro.
fn concat_pieces(call: &str) -> Option<Vec<Option<String>>> {
    let mut parameter: Option<&str> = None;
    let mut pieces = Vec::new();
    for argument in arguments_of(call) {
        if let Some(name) = argument.strip_prefix('$') {
            if parameter.is_some_and(|known| known != name) {
                return None;
            }
            parameter = Some(name);
            pieces.push(None);
        } else {
            pieces.push(Some(literal_of(argument)?));
        }
    }
    Some(pieces)
}

/// The name of the `macro_rules!` that `at` is inside.
fn macro_around(source: &str, at: usize) -> Option<String> {
    let defined = source[..at].rfind("macro_rules!")?;
    let name = source[defined + "macro_rules!".len()..].trim_start();
    let end = name.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))?;
    Some(name[..end].to_owned())
}

/// The literal a `const NAME: &str = ...;` of `source` holds, for a call whose
/// pattern is the name of a constant of the same file.
fn constant(source: &str, call: &str) -> Option<String> {
    let name = call[..call.find([',', ')'])?].trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    {
        return None;
    }
    let declared = source.find(&format!("const {name}: &str ="))?;
    let value = &source[declared + name.len() + 13..];
    let (literals, _, _) = literals_of_call(&format!("{});", &value[..value.find(";\n")?]));
    literals.into_iter().next().map(|(literal, _)| literal)
}

/// No pattern literal of the workspace is one `JsRegex::new` refuses where
/// JavaScript builds it, so no site meets that refusal on first use; and no
/// search is restarted with a regex that reads ahead, but for those listed.
#[test]
fn every_site_of_the_workspace_builds() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    rust_files(workspace, &mut files);
    files.sort();
    let mut sites = Sites::default();
    // calls whose searches cannot fail, with a pattern that can pass the bound or that is not read here
    let mut infallible_growing: Vec<String> = Vec::new();
    let mut infallible_unread: Vec<String> = Vec::new();
    let mut rejected: Vec<(String, usize)> = Vec::new();
    let mut macros: Vec<MacroPattern> = Vec::new();
    let mut sources: Vec<(String, String)> = Vec::new();
    let mut restarts: Vec<(String, usize)> = Vec::new();
    // G: a loop that grows the stack per turn; L: a lazy loop that walks ahead
    let mut loops: Vec<String> = Vec::new();
    let count_in = |list: &mut Vec<(String, usize)>, name: &str, by: usize| {
        if by > 0 {
            match list.iter_mut().find(|(listed, _)| listed == name) {
                Some((_, count)) => *count += by,
                None => list.push((name.to_owned(), by)),
            }
        }
    };
    for file in files {
        let name = file
            .strip_prefix(workspace)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        // the tests of the refusals name patterns that are refused
        if name.starts_with("jscompat/tests/") {
            continue;
        }
        let source = fs::read_to_string(&file).unwrap();
        // every `.find_from(` of the file, less those whose regex is read below and reads nothing ahead
        let mut restarts_here = if name.starts_with("jscompat/") {
            0
        } else {
            source.matches(".find_from(").count() + source.matches(".try_find_from(").count()
        };
        for opener in [
            "js_regex!(",
            "JsRegex::new(",
            "try_js_regex!(",
            "TryJsRegex::new(",
        ] {
            let fallible = opener.starts_with('t') || opener.starts_with('T');
            for (start, _) in source.match_indices(opener) {
                // `js_regex!(` is also the end of `try_js_regex!(`
                if source[..start].ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
                    continue;
                }
                let call_start = start + opener.len();
                let (mut literals, ends_in_a_literal, call_length) =
                    literals_of_call(&source[call_start..]);
                // a pattern held in a constant of the file
                let held = constant(&source, &source[call_start..]);
                let first = source[call_start..].trim_start();
                // `js_regex!(concat!(.., $key, ..))` in a macro: read at each use
                if let Some(concat) = first.strip_prefix("concat!(")
                    && let (Some(pieces), Some(macro_name)) =
                        (concat_pieces(concat), macro_around(&source, start))
                    && pieces.iter().any(Option::is_none)
                {
                    let flags = arguments_of(&source[call_start..])
                        .get(1)
                        .and_then(|flags| literal_of(flags))
                        .unwrap_or_default();
                    macros.push(MacroPattern {
                        name: macro_name,
                        pieces,
                        flags,
                        fallible,
                    });
                    continue;
                }
                // a macro whose first argument is neither a literal nor such a
                // constant would read its flags as its pattern
                let unreadable_macro = opener.ends_with("!(")
                    && held.is_none()
                    && !(first.starts_with('"')
                        || first.starts_with("r\"")
                        || first.starts_with("r#"));
                if let Some(literal) = held {
                    literals.insert(0, (literal, true));
                }
                // `js_regex!(...).find_from(`: the regex of a restart, read here
                let after = source[call_start + call_length..].trim_start();
                let restart =
                    after.starts_with(".find_from(") || after.starts_with(".try_find_from(");
                let line = source[..start].matches('\n').count() + 1;
                let is_flags = |text: &str| text.chars().all(|flag| "dgimsuvy".contains(flag));
                let (flags, patterns) = match literals.split_last() {
                    // `JsRegex::new` always takes its flags last
                    Some(((flags, true), patterns))
                        if ends_in_a_literal
                            && is_flags(flags)
                            && (!patterns.is_empty() || opener.ends_with("::new(")) =>
                    {
                        (flags.as_str(), patterns)
                    }
                    _ if opener.ends_with("::new(") => ("", &[][..]),
                    _ => ("", &literals[..]),
                };
                sites.fallible += usize::from(fallible);
                // a `format!` template: what goes into it is not read here, and a
                // value from the document can be a loop that passes the bound
                let templated = patterns.iter().any(|(_, own)| !own);
                let unread = patterns.is_empty() || unreadable_macro;
                // the regex module passes on the patterns of its callers
                if (unread || templated) && !fallible && name != "jscompat/src/regex.rs" {
                    infallible_unread.push(format!("{name}:{line}"));
                }
                if unread || (templated && !fallible) {
                    continue;
                }
                let without_u = !flags.contains(['u', 'v']);
                sites.read += 1;
                sites.without_u += usize::from(without_u);
                sites.icase += usize::from(without_u && flags.contains('i'));
                let (mut counted, mut lookbehind, mut reads_ahead) = (false, false, false);
                let (mut grows, mut lazy) = (false, false);
                for (pattern, own) in patterns {
                    // a format! template: what the caller puts in is not known here
                    let pattern = if *own {
                        pattern.clone()
                    } else {
                        sites.templates += 1;
                        js_regex!(r"\{[A-Za-z_]*\}")
                            .replace_all(&pattern.replace("{{", "{").replace("}}", "}"), |_| {
                                "x".to_owned()
                            })
                    };
                    sites.outside_ascii += usize::from(!pattern.is_ascii());
                    counted |= js_regex!(r"\{\d+(?:,\d*)?\}").test(&pattern);
                    lookbehind |= pattern.contains("(?<=") || pattern.contains("(?<!");
                    // a pattern JavaScript rejects too is a test of that
                    match JsRegex::new(&pattern, flags) {
                        Ok(regex) => {
                            reads_ahead |= regex.reads_ahead();
                            let (grows_here, lazy_here) = loops_of(&regex, &pattern);
                            if grows_here || lazy_here {
                                loops.push(format!(
                                    "{}{} {name}: /{pattern}/{flags}",
                                    if grows_here { "G" } else { "-" },
                                    if lazy_here { "L" } else { "-" }
                                ));
                            }
                            grows |= grows_here;
                            lazy |= lazy_here;
                        }
                        Err(error) if error.to_string().contains("as JavaScript matches it") => {
                            panic!("{name}: {error}")
                        }
                        Err(_) => {
                            sites.rejected += 1;
                            count_in(&mut rejected, &name, 1);
                        }
                    }
                }
                sites.counted += usize::from(without_u && counted);
                sites.lookbehind += usize::from(without_u && lookbehind);
                sites.reads_ahead += usize::from(reads_ahead);
                sites.grows_per_turn += usize::from(grows);
                sites.lazy_walks += usize::from(lazy);
                if grows && !fallible {
                    infallible_growing.push(format!("{name}:{line}"));
                }
                if restart && !reads_ahead {
                    restarts_here -= 1;
                }
            }
        }
        count_in(&mut restarts, &name, restarts_here);
        sources.push((name, source));
    }
    // each use of a macro that writes its pattern with `concat!`, with the
    // literal it is given
    for pattern in &macros {
        let call = format!("{}!(", pattern.name);
        let read_before = sites.from_macros;
        for (name, source) in &sources {
            for (start, _) in source.match_indices(&call) {
                if source[..start].ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
                    continue;
                }
                let line = source[..start].matches('\n').count() + 1;
                let values: Vec<String> = arguments_of(&source[start + call.len()..])
                    .into_iter()
                    .filter_map(literal_of)
                    .collect();
                if values.is_empty() && !pattern.fallible {
                    infallible_unread.push(format!("{name}:{line}"));
                }
                for value in values {
                    let text: String = pattern
                        .pieces
                        .iter()
                        .map(|piece| piece.as_deref().unwrap_or(&value))
                        .collect();
                    sites.read += 1;
                    sites.from_macros += 1;
                    match JsRegex::new(&text, &pattern.flags) {
                        Ok(regex) => {
                            let (grows, lazy) = loops_of(&regex, &text);
                            sites.grows_per_turn += usize::from(grows);
                            sites.lazy_walks += usize::from(lazy);
                            if grows && !pattern.fallible {
                                infallible_growing.push(format!("{name}:{line}"));
                            }
                        }
                        Err(error) if error.to_string().contains("as JavaScript matches it") => {
                            panic!("{name}:{line}: {error}")
                        }
                        Err(_) => {
                            sites.rejected += 1;
                            count_in(&mut rejected, name, 1);
                        }
                    }
                }
            }
        }
        // a macro read under a wrong name would pass with no use read
        assert!(
            sites.from_macros > read_before,
            "no use of {}! was read",
            pattern.name
        );
    }
    println!("{sites:?}");
    println!("{restarts:?}");
    for site in &loops {
        println!("{site}");
    }
    let listed = |list: &[(&str, usize)]| -> Vec<(String, usize)> {
        list.iter()
            .map(|(name, count)| ((*name).to_owned(), *count))
            .collect()
    };
    assert_eq!(restarts, listed(RESTARTS_THAT_MAY_READ_AHEAD));
    // a call read wrong builds a piece of a pattern, which is refused too
    assert_eq!(rejected, listed(&[("jscompat/src/regex.rs", 2)]));
    assert!(
        infallible_growing.is_empty(),
        "a JsRegex whose search can pass the bound; build it as a TryJsRegex: {infallible_growing:?}"
    );
    assert!(
        infallible_unread.is_empty(),
        "a JsRegex whose pattern this test cannot read; write it at the call or in a const of the file, or build a TryJsRegex: {infallible_unread:?}"
    );
    assert!(sites.read > 0);
}

/// The growth rule reads the `Debug` text of `regress`; a release that names
/// its instructions otherwise would read every loop as small.
#[test]
fn the_growth_rule_reads_the_program() {
    let loops = |pattern: &str| loops_of(&JsRegex::new(pattern, "").unwrap(), pattern);
    assert_eq!(loops("(?:a|b)*"), (true, false));
    assert_eq!(loops("(?:a|b){2}(?:c|d){2}"), (false, false));
    assert_eq!(loops("(?:(?:a|b){100}){100}"), (true, false));
    assert_eq!(loops("[^>]*"), (false, false));
    assert_eq!(loops("[\\s\\S]*?x"), (false, true));
}
