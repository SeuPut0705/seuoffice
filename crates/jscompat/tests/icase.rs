//! `i` without `u` against the three characters `regress` folds to ASCII
//! letters, and the `i` sites of the workspace.

use std::fs;
use std::path::Path;

use jscompat::{JsRegex, js_regex};

/// `new RegExp(pattern, flags).test(text)` as Node 22.23.5 answered it.
const NODE_ANSWERS: &[(&str, &str, &str, bool)] = &[
    ("i", "i", "\u{131}", false),
    ("I", "i", "\u{131}", false),
    ("s", "i", "\u{131}", false),
    ("S", "i", "\u{131}", false),
    ("k", "i", "\u{131}", false),
    ("K", "i", "\u{131}", false),
    ("[a-z]", "i", "\u{131}", false),
    ("[A-Z]", "i", "\u{131}", false),
    ("[iskISK]", "i", "\u{131}", false),
    ("^[^a-z]$", "i", "\u{131}", true),
    ("^[^A-Z]$", "i", "\u{131}", true),
    ("^[^iskISK]$", "i", "\u{131}", true),
    ("\\w", "i", "\u{131}", false),
    ("^\\W$", "i", "\u{131}", true),
    ("\\s", "i", "\u{131}", false),
    ("^\\S$", "i", "\u{131}", true),
    ("\\d", "i", "\u{131}", false),
    ("^\\D$", "i", "\u{131}", true),
    ("^.$", "i", "\u{131}", true),
    ("^\\b", "i", "\u{131}", false),
    ("\\b", "i", "\u{131}", false),
    ("a\\b", "i", "a\u{131}", true),
    ("\\ba", "i", "\u{131}a", true),
    ("a\\Bb", "i", "a\u{131}b", false),
    ("^a.b$", "i", "a\u{131}b", true),
    ("^(.)\\1$", "i", "\u{131}\u{131}", true),
    ("^(.)\\1$", "i", "\u{131}\u{17f}", false),
    ("^(.)\\1$", "i", "\u{131}\u{212a}", false),
    ("^(.)\\1$", "i", "\u{131}i", false),
    ("^(.)\\1$", "i", "i\u{131}", false),
    ("^(.)\\1$", "i", "\u{131}I", false),
    ("^(.)\\1$", "i", "I\u{131}", false),
    ("^(.)\\1$", "i", "\u{131}s", false),
    ("^(.)\\1$", "i", "s\u{131}", false),
    ("^(.)\\1$", "i", "\u{131}S", false),
    ("^(.)\\1$", "i", "S\u{131}", false),
    ("^(.)\\1$", "i", "\u{131}k", false),
    ("^(.)\\1$", "i", "k\u{131}", false),
    ("^(.)\\1$", "i", "\u{131}K", false),
    ("^(.)\\1$", "i", "K\u{131}", false),
    ("i", "iu", "\u{131}", false),
    ("s", "iu", "\u{131}", false),
    ("k", "iu", "\u{131}", false),
    ("[a-z]", "iu", "\u{131}", false),
    ("\\w", "iu", "\u{131}", false),
    ("i", "", "\u{131}", false),
    ("s", "", "\u{131}", false),
    ("k", "", "\u{131}", false),
    ("[a-z]", "", "\u{131}", false),
    ("\\w", "", "\u{131}", false),
    ("^.$", "", "\u{131}", true),
    ("i", "i", "\u{17f}", false),
    ("I", "i", "\u{17f}", false),
    ("s", "i", "\u{17f}", false),
    ("S", "i", "\u{17f}", false),
    ("k", "i", "\u{17f}", false),
    ("K", "i", "\u{17f}", false),
    ("[a-z]", "i", "\u{17f}", false),
    ("[A-Z]", "i", "\u{17f}", false),
    ("[iskISK]", "i", "\u{17f}", false),
    ("^[^a-z]$", "i", "\u{17f}", true),
    ("^[^A-Z]$", "i", "\u{17f}", true),
    ("^[^iskISK]$", "i", "\u{17f}", true),
    ("\\w", "i", "\u{17f}", false),
    ("^\\W$", "i", "\u{17f}", true),
    ("\\s", "i", "\u{17f}", false),
    ("^\\S$", "i", "\u{17f}", true),
    ("\\d", "i", "\u{17f}", false),
    ("^\\D$", "i", "\u{17f}", true),
    ("^.$", "i", "\u{17f}", true),
    ("^\\b", "i", "\u{17f}", false),
    ("\\b", "i", "\u{17f}", false),
    ("a\\b", "i", "a\u{17f}", true),
    ("\\ba", "i", "\u{17f}a", true),
    ("a\\Bb", "i", "a\u{17f}b", false),
    ("^a.b$", "i", "a\u{17f}b", true),
    ("^(.)\\1$", "i", "\u{17f}\u{17f}", true),
    ("^(.)\\1$", "i", "\u{17f}\u{131}", false),
    ("^(.)\\1$", "i", "\u{17f}\u{212a}", false),
    ("^(.)\\1$", "i", "\u{17f}i", false),
    ("^(.)\\1$", "i", "i\u{17f}", false),
    ("^(.)\\1$", "i", "\u{17f}I", false),
    ("^(.)\\1$", "i", "I\u{17f}", false),
    ("^(.)\\1$", "i", "\u{17f}s", false),
    ("^(.)\\1$", "i", "s\u{17f}", false),
    ("^(.)\\1$", "i", "\u{17f}S", false),
    ("^(.)\\1$", "i", "S\u{17f}", false),
    ("^(.)\\1$", "i", "\u{17f}k", false),
    ("^(.)\\1$", "i", "k\u{17f}", false),
    ("^(.)\\1$", "i", "\u{17f}K", false),
    ("^(.)\\1$", "i", "K\u{17f}", false),
    ("i", "iu", "\u{17f}", false),
    ("s", "iu", "\u{17f}", true),
    ("k", "iu", "\u{17f}", false),
    ("[a-z]", "iu", "\u{17f}", true),
    ("\\w", "iu", "\u{17f}", true),
    ("i", "", "\u{17f}", false),
    ("s", "", "\u{17f}", false),
    ("k", "", "\u{17f}", false),
    ("[a-z]", "", "\u{17f}", false),
    ("\\w", "", "\u{17f}", false),
    ("^.$", "", "\u{17f}", true),
    ("i", "i", "\u{212a}", false),
    ("I", "i", "\u{212a}", false),
    ("s", "i", "\u{212a}", false),
    ("S", "i", "\u{212a}", false),
    ("k", "i", "\u{212a}", false),
    ("K", "i", "\u{212a}", false),
    ("[a-z]", "i", "\u{212a}", false),
    ("[A-Z]", "i", "\u{212a}", false),
    ("[iskISK]", "i", "\u{212a}", false),
    ("^[^a-z]$", "i", "\u{212a}", true),
    ("^[^A-Z]$", "i", "\u{212a}", true),
    ("^[^iskISK]$", "i", "\u{212a}", true),
    ("\\w", "i", "\u{212a}", false),
    ("^\\W$", "i", "\u{212a}", true),
    ("\\s", "i", "\u{212a}", false),
    ("^\\S$", "i", "\u{212a}", true),
    ("\\d", "i", "\u{212a}", false),
    ("^\\D$", "i", "\u{212a}", true),
    ("^.$", "i", "\u{212a}", true),
    ("^\\b", "i", "\u{212a}", false),
    ("\\b", "i", "\u{212a}", false),
    ("a\\b", "i", "a\u{212a}", true),
    ("\\ba", "i", "\u{212a}a", true),
    ("a\\Bb", "i", "a\u{212a}b", false),
    ("^a.b$", "i", "a\u{212a}b", true),
    ("^(.)\\1$", "i", "\u{212a}\u{212a}", true),
    ("^(.)\\1$", "i", "\u{212a}\u{131}", false),
    ("^(.)\\1$", "i", "\u{212a}\u{17f}", false),
    ("^(.)\\1$", "i", "\u{212a}i", false),
    ("^(.)\\1$", "i", "i\u{212a}", false),
    ("^(.)\\1$", "i", "\u{212a}I", false),
    ("^(.)\\1$", "i", "I\u{212a}", false),
    ("^(.)\\1$", "i", "\u{212a}s", false),
    ("^(.)\\1$", "i", "s\u{212a}", false),
    ("^(.)\\1$", "i", "\u{212a}S", false),
    ("^(.)\\1$", "i", "S\u{212a}", false),
    ("^(.)\\1$", "i", "\u{212a}k", false),
    ("^(.)\\1$", "i", "k\u{212a}", false),
    ("^(.)\\1$", "i", "\u{212a}K", false),
    ("^(.)\\1$", "i", "K\u{212a}", false),
    ("i", "iu", "\u{212a}", false),
    ("s", "iu", "\u{212a}", false),
    ("k", "iu", "\u{212a}", true),
    ("[a-z]", "iu", "\u{212a}", true),
    ("\\w", "iu", "\u{212a}", true),
    ("i", "", "\u{212a}", false),
    ("s", "", "\u{212a}", false),
    ("k", "", "\u{212a}", false),
    ("[a-z]", "", "\u{212a}", false),
    ("\\w", "", "\u{212a}", false),
    ("^.$", "", "\u{212a}", true),
    ("^vertical", "i", "vert\u{131}cal", false),
    ("^VERT.CAL", "i", "vert\u{131}cal", true),
    ("data-redaction", "i", "DATA-REDACT\u{131}ON", false),
    ("title", "i", "T\u{131}TLE", false),
    ("^heading\\s*([1-9])$", "i", "Head\u{131}ng 1", false),
    ("^[0-9a-f]{6}$", "i", "AB\u{212a}DEF", false),
    ("kashida$", "i", "KA\u{17f}HIDA", false),
    ("/slide$", "i", "/\u{17f}LIDE", false),
];

#[test]
fn test_answers_as_node_does() {
    for (pattern, flags, text, expected) in NODE_ANSWERS {
        let regex = JsRegex::new(pattern, flags).unwrap();
        assert_eq!(
            regex.test(text),
            *expected,
            "/{pattern}/{flags} on {text:?}"
        );
    }
}

/// What `regress` alone answers. When this fails, `regress` follows
/// Canonicalize: take the shadow and the refusal out of `JsRegex`.
#[test]
fn regress_alone_still_folds_past_ascii() {
    let alone = |pattern: &str, text: &str| {
        regress::Regex::with_flags(pattern, "i")
            .unwrap()
            .find(text)
            .is_some()
    };
    assert!(alone("i", "\u{131}"));
    assert!(alone("s", "\u{17f}"));
    assert!(alone("[a-z]", "\u{212a}"));
    assert!(alone(r"\w", "\u{212a}"));
    assert!(alone("\u{131}", "I"));
}

#[test]
fn captures_and_offsets_are_those_of_the_text_given() {
    // Node: /^vert(.)cal-(\w+)/i.exec('VERT\u0131CAL-rl') is ['VERT\u0131CAL-rl', '\u0131', 'rl'] at 0
    let found = js_regex!(r"^vert(.)cal-(\w+)", "i")
        .exec("VERT\u{131}CAL-rl")
        .unwrap();
    assert_eq!(found.as_str(), "VERT\u{131}CAL-rl");
    assert_eq!(
        (found.get(1), found.get(2), found.start()),
        (Some("\u{131}"), Some("rl"), 0)
    );
    // Node: [...'i\u0131I\u017fs'.matchAll(/[is]/gi)] is 'i' at 0, 'I' at 2, 's' at 4, in UTF-16 units
    let all: Vec<_> = js_regex!("[is]", "gi")
        .find_iter("i\u{131}I\u{17f}s")
        .map(|m| (m.as_str(), m.start()))
        .collect();
    assert_eq!(all, [("i", 0), ("I", 3), ("s", 6)]);
    // Node: r = /i/gi; r.lastIndex = 1; r.exec('i\u0131\u0131I') is 'I' at 3
    let later: Vec<_> = js_regex!("i", "gi")
        .find_from("i\u{131}\u{131}I", 1)
        .map(|m| (m.as_str(), m.start()))
        .collect();
    assert_eq!(later, [("I", 5)]);
}

#[test]
fn replace_and_split_keep_the_three_characters() {
    // Node: 'a\u0131bIc\u017fSd'.replace(/[is]/gi, m => `<${m}>`)
    assert_eq!(
        js_regex!("[is]", "gi")
            .replace_all("a\u{131}bIc\u{17f}Sd", |m| format!("<{}>", m.as_str())),
        "a\u{131}b<I>c\u{17f}<S>d"
    );
    // Node: '\u0131i\u212aK'.replace(/i|k/gi, 'x')
    assert_eq!(
        js_regex!("i|k", "gi").replace_all("\u{131}i\u{212a}K", |_| "x".to_owned()),
        "\u{131}x\u{212a}x"
    );
    // Node: 'x\u0131yIz\u017fw'.split(/i|s/i)
    assert_eq!(
        js_regex!("i|s", "i").split("x\u{131}yIz\u{17f}w"),
        ["x\u{131}y", "z\u{17f}w"]
    );
}

#[test]
fn a_pattern_naming_a_cased_character_outside_ascii_is_refused() {
    // Node answers false for /\u0131/i on 'I', /\u017f/i on 's', /\u212a/i on 'k'; regress answers true
    for pattern in [
        "\u{131}",
        "\u{17f}",
        "\u{212a}",
        "\u{e9}",
        r"\u0131",
        r"\xe9",
        r"\351",
        r"\p{L}",
        "[\u{d55c}]",
        "\u{2c7}",
    ] {
        assert!(JsRegex::new(pattern, "i").is_err(), "{pattern}");
        assert!(
            JsRegex::new(pattern, "").is_ok() || pattern == r"\p{L}",
            "{pattern}"
        );
    }
    // a character without case is matched as itself: Node answers true for /\ud55c/i on '\ud55c'
    assert!(
        JsRegex::new("<\u{d55c}(?=[\\s/>])", "i")
            .unwrap()
            .test("<\u{d55c}>")
    );
    assert!(JsRegex::new(r"\x41\101", "i").unwrap().test("aa"));
    assert!(JsRegex::new("\u{131}", "iu").is_ok());
}

/// One call of `js_regex!` or `JsRegex::new`: its string literals as written,
/// each with whether it is an argument of the call itself, and whether the
/// last of them is the last argument.
fn literals_of_call(source: &str) -> (Vec<(String, bool)>, bool) {
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
    (literals, after_last == ")")
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

/// Calls whose flags are not a literal, so this test cannot read them: the
/// macro itself, and `compile` in settings.rs, whose callers pass "" and "i"
/// over a template that names only ASCII around the prefixes of the document.
const FLAGS_NOT_LITERAL: [(&str, usize); 2] = [
    ("docx-engine/src/settings.rs", 1),
    ("jscompat/src/regex.rs", 1),
];

/// Every pattern literal of the workspace under `i` without `u` builds, so no
/// site panics on first use, and every call this test cannot read is known.
#[test]
fn every_i_site_of_the_workspace_builds() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    rust_files(workspace, &mut files);
    files.sort();
    let (mut sites, mut templates, mut outside_ascii) = (0, 0, 0);
    let mut unread: Vec<(String, usize)> = Vec::new();
    for file in files {
        let name = file
            .strip_prefix(workspace)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if name == "jscompat/tests/icase.rs" {
            continue;
        }
        let source = fs::read_to_string(&file).unwrap();
        for opener in ["js_regex!(", "JsRegex::new("] {
            for (start, _) in source.match_indices(opener) {
                let call = &source[start + opener.len()..];
                let (literals, ends_in_a_literal) = literals_of_call(call);
                let is_flags = |text: &str| text.chars().all(|flag| "dgimsuvy".contains(flag));
                let mut note_unread = || match unread
                    .iter_mut()
                    .find(|(unread_name, _)| *unread_name == name)
                {
                    Some((_, count)) => *count += 1,
                    None => unread.push((name.clone(), 1)),
                };
                let flags = match literals.last() {
                    // `JsRegex::new` always takes its flags last
                    Some((flags, true))
                        if ends_in_a_literal
                            && is_flags(flags)
                            && (literals.len() > 1 || opener == "JsRegex::new(") =>
                    {
                        flags.as_str()
                    }
                    _ if opener == "JsRegex::new(" => {
                        note_unread();
                        continue;
                    }
                    _ => "",
                };
                if !flags.contains('i') || flags.contains(['u', 'v']) {
                    continue;
                }
                sites += 1;
                // the flags are read and the pattern is not a literal
                if literals.len() == 1 {
                    note_unread();
                    continue;
                }
                for (pattern, own) in &literals[..literals.len() - 1] {
                    // a format! template: what the caller puts in is not known here
                    let pattern = if *own {
                        pattern.clone()
                    } else {
                        templates += 1;
                        js_regex!(r"\{[A-Za-z_]*\}")
                            .replace_all(&pattern.replace("{{", "{").replace("}}", "}"), |_| {
                                "x".to_owned()
                            })
                    };
                    outside_ascii += usize::from(!pattern.is_ascii());
                    assert!(
                        JsRegex::new(&pattern, flags).is_ok(),
                        "{name}: /{pattern}/{flags} is refused"
                    );
                }
            }
        }
    }
    println!(
        "{sites} sites under i without u: {templates} format! templates, {outside_ascii} patterns with a character outside ASCII"
    );
    let known: Vec<(String, usize)> = FLAGS_NOT_LITERAL
        .iter()
        .map(|(name, count)| ((*name).to_owned(), *count))
        .collect();
    assert_eq!(unread, known);
    assert!(sites > 0);
}
