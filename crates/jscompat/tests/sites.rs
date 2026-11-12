//! Every `js_regex!` and `JsRegex::new` call of the workspace, read from the
//! source: no pattern literal is one `JsRegex::new` refuses, and the calls
//! this test cannot read are known by name.

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
            if path.file_name().is_some_and(|name| name != "target") {
                rust_files(&path, found);
            }
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

/// Calls this test cannot read, by file: the pattern or the flags are not a
/// literal of the call. A new one fails this test, so that its pattern is
/// read by a person: the patterns of these are ASCII, without `i`, except
/// `compile` of settings.rs, which passes "" or "i" over an ASCII template
/// around the namespace prefixes of the document.
const NOT_LITERAL: &[(&str, usize)] = &[
    ("docx-engine/src/drawing_geometry/anchor.rs", 1),
    ("docx-engine/src/sdt.rs", 5),
    ("docx-engine/src/settings.rs", 1),
    ("docx-engine/src/vml/shape.rs", 2),
    // the macro itself
    ("jscompat/src/regex.rs", 1),
];

/// Calls of `find_from` whose regex reads the text ahead of each search, or
/// is not written at the call so that this test cannot tell. `find_from` is
/// how a loop restarts a search once per match; with such a regex every
/// restart reads the rest of the text again (measured: 2,000 restarts over
/// 2 MB took 0.5 s, and 31 s where the text holds a character outside the
/// BMP). A new call fails this test. List it here only when it restarts at
/// most a few times, or over a short text, or its regex reads nothing ahead;
/// otherwise search once with `find_iter`.
const RESTARTS_THAT_MAY_READ_AHEAD: &[(&str, usize)] = &[
    // one search per SDT, over a pattern held in a constant
    ("docx-engine/src/sdt.rs", 1),
    // one pass over the attributes of one tag
    ("ooxml-pkg/src/normalize.rs", 1),
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
    let mut unread: Vec<(String, usize)> = Vec::new();
    let mut restarts: Vec<(String, usize)> = Vec::new();
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
            source.matches(".find_from(").count()
        };
        for opener in ["js_regex!(", "JsRegex::new("] {
            for (start, _) in source.match_indices(opener) {
                let call_start = start + opener.len();
                let (literals, ends_in_a_literal, call_length) =
                    literals_of_call(&source[call_start..]);
                // `js_regex!(...).find_from(`: the regex of a restart, read here
                let restart = source[call_start + call_length..]
                    .trim_start()
                    .starts_with(".find_from(")
                    .then(|| {
                        call_start
                            + call_length
                            + source[call_start + call_length..]
                                .find(".find_from(")
                                .unwrap()
                    });
                let is_flags = |text: &str| text.chars().all(|flag| "dgimsuvy".contains(flag));
                let (flags, patterns) = match literals.split_last() {
                    // `JsRegex::new` always takes its flags last
                    Some(((flags, true), patterns))
                        if ends_in_a_literal
                            && is_flags(flags)
                            && (!patterns.is_empty() || opener == "JsRegex::new(") =>
                    {
                        (flags.as_str(), patterns)
                    }
                    _ if opener == "JsRegex::new(" => ("", &[][..]),
                    _ => ("", &literals[..]),
                };
                if patterns.is_empty() {
                    count_in(&mut unread, &name, 1);
                    continue;
                }
                let without_u = !flags.contains(['u', 'v']);
                sites.read += 1;
                sites.without_u += usize::from(without_u);
                sites.icase += usize::from(without_u && flags.contains('i'));
                let (mut counted, mut lookbehind, mut reads_ahead) = (false, false, false);
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
                        Ok(regex) => reads_ahead |= regex.reads_ahead(),
                        Err(error) if error.to_string().contains("as JavaScript matches it") => {
                            panic!("{name}: {error}")
                        }
                        Err(_) => sites.rejected += 1,
                    }
                }
                sites.counted += usize::from(without_u && counted);
                sites.lookbehind += usize::from(without_u && lookbehind);
                sites.reads_ahead += usize::from(reads_ahead);
                if restart.is_some() && !reads_ahead {
                    restarts_here -= 1;
                }
            }
        }
        count_in(&mut restarts, &name, restarts_here);
    }
    println!("{sites:?}");
    println!("{unread:?}");
    println!("{restarts:?}");
    let listed = |list: &[(&str, usize)]| -> Vec<(String, usize)> {
        list.iter()
            .map(|(name, count)| ((*name).to_owned(), *count))
            .collect()
    };
    assert_eq!(restarts, listed(RESTARTS_THAT_MAY_READ_AHEAD));
    assert_eq!(unread, listed(NOT_LITERAL));
    assert!(sites.read > 0);
}
