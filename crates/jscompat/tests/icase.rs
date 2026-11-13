//! `i` without `u` against the three characters `regress` folds to ASCII
//! letters.

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
