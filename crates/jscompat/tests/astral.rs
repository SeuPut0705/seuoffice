//! A regex without `u` over a text outside the BMP: JavaScript walks UTF-16
//! units, so such a character is two of everything a pattern counts.

use jscompat::{JsRegex, js_regex};

/// `new RegExp(pattern, flags).test(text)` as Node 22.23.5 answered it.
const NODE_ANSWERS: &[(&str, &str, &str, bool)] = &[
    (
        "^\\S{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\S{14,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{14,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{16}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\S{16}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{8}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{8}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^.{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^.{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^[^a]{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^[^a]{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\W{16,}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\W{16,}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\D{8,}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\D{8,}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\S{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\S{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\S{14,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\S{14,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{16}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{16}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{8}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{8}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^.{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^.{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^[^a]{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^[^a]{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\W{16,}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\W{16,}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\D{8,}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        true,
    ),
    (
        "^\\D{8,}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        false,
    ),
    (
        "^\\S{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        true,
    ),
    (
        "^\\S{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        true,
    ),
    (
        "^\\S{14,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        true,
    ),
    (
        "^\\S{14,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        false,
    ),
    (
        "^\\S{16}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        false,
    ),
    (
        "^\\S{16}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        false,
    ),
    (
        "^\\S{8}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        false,
    ),
    (
        "^\\S{8}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        true,
    ),
    (
        "^.{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        true,
    ),
    (
        "^.{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        true,
    ),
    (
        "^[^a]{1,15}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        false,
    ),
    (
        "^[^a]{1,15}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        false,
    ),
    (
        "^\\W{16,}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        false,
    ),
    (
        "^\\W{16,}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        false,
    ),
    (
        "^\\D{8,}$",
        "",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        true,
    ),
    (
        "^\\D{8,}$",
        "u",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}a",
        true,
    ),
    ("^.$", "", "\u{1f600}", false),
    ("^.$", "u", "\u{1f600}", true),
    ("^..$", "", "\u{1f600}", true),
    ("^..$", "u", "\u{1f600}", false),
    ("^.{1}$", "", "\u{1f600}", false),
    ("^.{1}$", "u", "\u{1f600}", true),
    ("^.{2}$", "", "\u{1f600}", true),
    ("^.{2}$", "u", "\u{1f600}", false),
    ("^.{1,}$", "", "\u{1f600}", true),
    ("^.{1,}$", "u", "\u{1f600}", true),
    ("^.{2,}$", "", "\u{1f600}", true),
    ("^.{2,}$", "u", "\u{1f600}", false),
    ("^.{3,}$", "", "\u{1f600}", false),
    ("^.{3,}$", "u", "\u{1f600}", false),
    ("^[^a]$", "", "\u{1f600}", false),
    ("^[^a]$", "u", "\u{1f600}", true),
    ("^[^a]{2}$", "", "\u{1f600}", true),
    ("^[^a]{2}$", "u", "\u{1f600}", false),
    ("^\\S$", "", "\u{1f600}", false),
    ("^\\S$", "u", "\u{1f600}", true),
    ("^\\S\\S$", "", "\u{1f600}", true),
    ("^\\S\\S$", "u", "\u{1f600}", false),
    ("^\\W{2}$", "", "\u{1f600}", true),
    ("^\\W{2}$", "u", "\u{1f600}", false),
    ("^\\D{2}$", "", "\u{1f600}", true),
    ("^\\D{2}$", "u", "\u{1f600}", false),
    ("^[\\s\\S]$", "", "\u{1f600}", false),
    ("^[\\s\\S]$", "u", "\u{1f600}", true),
    ("^[\\s\\S]{2}$", "", "\u{1f600}", true),
    ("^[\\s\\S]{2}$", "u", "\u{1f600}", false),
    ("^.?$", "", "\u{1f600}", false),
    ("^.?$", "u", "\u{1f600}", true),
    ("^.+$", "", "\u{1f600}", true),
    ("^.+$", "u", "\u{1f600}", true),
    ("^(?:.{2})+$", "", "\u{1f600}", true),
    ("^(?:.{2})+$", "u", "\u{1f600}", false),
    ("^(.)(.)$", "", "\u{1f600}", true),
    ("^(.)(.)$", "u", "\u{1f600}", false),
    ("^(.)\\1$", "", "\u{1f600}", false),
    ("^(.)\\1$", "u", "\u{1f600}", false),
    ("^.$", "", "\u{10000}", false),
    ("^.$", "u", "\u{10000}", true),
    ("^..$", "", "\u{10000}", true),
    ("^..$", "u", "\u{10000}", false),
    ("^.{1}$", "", "\u{10000}", false),
    ("^.{1}$", "u", "\u{10000}", true),
    ("^.{2}$", "", "\u{10000}", true),
    ("^.{2}$", "u", "\u{10000}", false),
    ("^.{1,}$", "", "\u{10000}", true),
    ("^.{1,}$", "u", "\u{10000}", true),
    ("^.{2,}$", "", "\u{10000}", true),
    ("^.{2,}$", "u", "\u{10000}", false),
    ("^.{3,}$", "", "\u{10000}", false),
    ("^.{3,}$", "u", "\u{10000}", false),
    ("^[^a]$", "", "\u{10000}", false),
    ("^[^a]$", "u", "\u{10000}", true),
    ("^[^a]{2}$", "", "\u{10000}", true),
    ("^[^a]{2}$", "u", "\u{10000}", false),
    ("^\\S$", "", "\u{10000}", false),
    ("^\\S$", "u", "\u{10000}", true),
    ("^\\S\\S$", "", "\u{10000}", true),
    ("^\\S\\S$", "u", "\u{10000}", false),
    ("^\\W{2}$", "", "\u{10000}", true),
    ("^\\W{2}$", "u", "\u{10000}", false),
    ("^\\D{2}$", "", "\u{10000}", true),
    ("^\\D{2}$", "u", "\u{10000}", false),
    ("^[\\s\\S]$", "", "\u{10000}", false),
    ("^[\\s\\S]$", "u", "\u{10000}", true),
    ("^[\\s\\S]{2}$", "", "\u{10000}", true),
    ("^[\\s\\S]{2}$", "u", "\u{10000}", false),
    ("^.?$", "", "\u{10000}", false),
    ("^.?$", "u", "\u{10000}", true),
    ("^.+$", "", "\u{10000}", true),
    ("^.+$", "u", "\u{10000}", true),
    ("^(?:.{2})+$", "", "\u{10000}", true),
    ("^(?:.{2})+$", "u", "\u{10000}", false),
    ("^(.)(.)$", "", "\u{10000}", true),
    ("^(.)(.)$", "u", "\u{10000}", false),
    ("^(.)\\1$", "", "\u{10000}", false),
    ("^(.)\\1$", "u", "\u{10000}", false),
    ("^.$", "", "\u{d55c}", true),
    ("^.$", "u", "\u{d55c}", true),
    ("^..$", "", "\u{d55c}", false),
    ("^..$", "u", "\u{d55c}", false),
    ("^.{1}$", "", "\u{d55c}", true),
    ("^.{1}$", "u", "\u{d55c}", true),
    ("^.{2}$", "", "\u{d55c}", false),
    ("^.{2}$", "u", "\u{d55c}", false),
    ("^.{1,}$", "", "\u{d55c}", true),
    ("^.{1,}$", "u", "\u{d55c}", true),
    ("^.{2,}$", "", "\u{d55c}", false),
    ("^.{2,}$", "u", "\u{d55c}", false),
    ("^.{3,}$", "", "\u{d55c}", false),
    ("^.{3,}$", "u", "\u{d55c}", false),
    ("^[^a]$", "", "\u{d55c}", true),
    ("^[^a]$", "u", "\u{d55c}", true),
    ("^[^a]{2}$", "", "\u{d55c}", false),
    ("^[^a]{2}$", "u", "\u{d55c}", false),
    ("^\\S$", "", "\u{d55c}", true),
    ("^\\S$", "u", "\u{d55c}", true),
    ("^\\S\\S$", "", "\u{d55c}", false),
    ("^\\S\\S$", "u", "\u{d55c}", false),
    ("^\\W{2}$", "", "\u{d55c}", false),
    ("^\\W{2}$", "u", "\u{d55c}", false),
    ("^\\D{2}$", "", "\u{d55c}", false),
    ("^\\D{2}$", "u", "\u{d55c}", false),
    ("^[\\s\\S]$", "", "\u{d55c}", true),
    ("^[\\s\\S]$", "u", "\u{d55c}", true),
    ("^[\\s\\S]{2}$", "", "\u{d55c}", false),
    ("^[\\s\\S]{2}$", "u", "\u{d55c}", false),
    ("^.?$", "", "\u{d55c}", true),
    ("^.?$", "u", "\u{d55c}", true),
    ("^.+$", "", "\u{d55c}", true),
    ("^.+$", "u", "\u{d55c}", true),
    ("^(?:.{2})+$", "", "\u{d55c}", false),
    ("^(?:.{2})+$", "u", "\u{d55c}", false),
    ("^(.)(.)$", "", "\u{d55c}", false),
    ("^(.)(.)$", "u", "\u{d55c}", false),
    ("^(.)\\1$", "", "\u{d55c}", false),
    ("^(.)\\1$", "u", "\u{d55c}", false),
    ("^.{2}$", "", "\u{1f600}\u{1f600}", false),
    ("^.{2}$", "u", "\u{1f600}\u{1f600}", true),
    ("^.{3}$", "", "\u{1f600}\u{1f600}", false),
    ("^.{3}$", "u", "\u{1f600}\u{1f600}", false),
    ("^.{4}$", "", "\u{1f600}\u{1f600}", true),
    ("^.{4}$", "u", "\u{1f600}\u{1f600}", false),
    ("^.{2,3}$", "", "\u{1f600}\u{1f600}", false),
    ("^.{2,3}$", "u", "\u{1f600}\u{1f600}", true),
    ("^(?:.{2}){2}$", "", "\u{1f600}\u{1f600}", true),
    ("^(?:.{2}){2}$", "u", "\u{1f600}\u{1f600}", false),
    ("^(..)\\1$", "", "\u{1f600}\u{1f600}", true),
    ("^(..)\\1$", "u", "\u{1f600}\u{1f600}", false),
    ("^(.{2})\\1$", "", "\u{1f600}\u{1f600}", true),
    ("^(.{2})\\1$", "u", "\u{1f600}\u{1f600}", false),
    ("^(.)(.)\\1\\2$", "", "\u{1f600}\u{1f600}", true),
    ("^(.)(.)\\1\\2$", "u", "\u{1f600}\u{1f600}", false),
    ("^.{2}$", "", "\u{1f600}\u{10000}", false),
    ("^.{2}$", "u", "\u{1f600}\u{10000}", true),
    ("^.{3}$", "", "\u{1f600}\u{10000}", false),
    ("^.{3}$", "u", "\u{1f600}\u{10000}", false),
    ("^.{4}$", "", "\u{1f600}\u{10000}", true),
    ("^.{4}$", "u", "\u{1f600}\u{10000}", false),
    ("^.{2,3}$", "", "\u{1f600}\u{10000}", false),
    ("^.{2,3}$", "u", "\u{1f600}\u{10000}", true),
    ("^(?:.{2}){2}$", "", "\u{1f600}\u{10000}", true),
    ("^(?:.{2}){2}$", "u", "\u{1f600}\u{10000}", false),
    ("^(..)\\1$", "", "\u{1f600}\u{10000}", false),
    ("^(..)\\1$", "u", "\u{1f600}\u{10000}", false),
    ("^(.{2})\\1$", "", "\u{1f600}\u{10000}", false),
    ("^(.{2})\\1$", "u", "\u{1f600}\u{10000}", false),
    ("^(.)(.)\\1\\2$", "", "\u{1f600}\u{10000}", false),
    ("^(.)(.)\\1\\2$", "u", "\u{1f600}\u{10000}", false),
    ("^.{2}$", "", "\u{d55c}\u{d55c}", true),
    ("^.{2}$", "u", "\u{d55c}\u{d55c}", true),
    ("^.{3}$", "", "\u{d55c}\u{d55c}", false),
    ("^.{3}$", "u", "\u{d55c}\u{d55c}", false),
    ("^.{4}$", "", "\u{d55c}\u{d55c}", false),
    ("^.{4}$", "u", "\u{d55c}\u{d55c}", false),
    ("^.{2,3}$", "", "\u{d55c}\u{d55c}", true),
    ("^.{2,3}$", "u", "\u{d55c}\u{d55c}", true),
    ("^(?:.{2}){2}$", "", "\u{d55c}\u{d55c}", false),
    ("^(?:.{2}){2}$", "u", "\u{d55c}\u{d55c}", false),
    ("^(..)\\1$", "", "\u{d55c}\u{d55c}", false),
    ("^(..)\\1$", "u", "\u{d55c}\u{d55c}", false),
    ("^(.{2})\\1$", "", "\u{d55c}\u{d55c}", false),
    ("^(.{2})\\1$", "u", "\u{d55c}\u{d55c}", false),
    ("^(.)(.)\\1\\2$", "", "\u{d55c}\u{d55c}", false),
    ("^(.)(.)\\1\\2$", "u", "\u{d55c}\u{d55c}", false),
    ("^.{3}$", "", "a\u{1f600}b", false),
    ("^.{3}$", "u", "a\u{1f600}b", true),
    ("^a.b$", "", "a\u{1f600}b", false),
    ("^a.b$", "u", "a\u{1f600}b", true),
    ("^a..b$", "", "a\u{1f600}b", true),
    ("^a..b$", "u", "a\u{1f600}b", false),
    ("^a.{2}b$", "", "a\u{1f600}b", true),
    ("^a.{2}b$", "u", "a\u{1f600}b", false),
    ("a\\b", "", "a\u{1f600}b", true),
    ("a\\b", "u", "a\u{1f600}b", true),
    ("a\\B", "", "a\u{1f600}b", false),
    ("a\\B", "u", "a\u{1f600}b", false),
    ("\\bb", "", "a\u{1f600}b", true),
    ("\\bb", "u", "a\u{1f600}b", true),
    ("\\Bb", "", "a\u{1f600}b", false),
    ("\\Bb", "u", "a\u{1f600}b", false),
    ("(?<=^.{2})b", "", "a\u{1f600}b", false),
    ("(?<=^.{2})b", "u", "a\u{1f600}b", true),
    ("(?<=^.{3})b", "", "a\u{1f600}b", true),
    ("(?<=^.{3})b", "u", "a\u{1f600}b", false),
    ("(?<=^a.)b", "", "a\u{1f600}b", false),
    ("(?<=^a.)b", "u", "a\u{1f600}b", true),
    ("(?<=^a..)b", "", "a\u{1f600}b", true),
    ("(?<=^a..)b", "u", "a\u{1f600}b", false),
    ("(?<=.)b", "", "a\u{1f600}b", true),
    ("(?<=.)b", "u", "a\u{1f600}b", true),
    ("(?<!^a.)b", "", "a\u{1f600}b", true),
    ("(?<!^a.)b", "u", "a\u{1f600}b", false),
    ("(?<!^a..)b", "", "a\u{1f600}b", false),
    ("(?<!^a..)b", "u", "a\u{1f600}b", true),
    ("^a(?=.{3}$)", "", "a\u{1f600}b", true),
    ("^a(?=.{3}$)", "u", "a\u{1f600}b", false),
    ("^a(?=.{2}$)", "", "a\u{1f600}b", false),
    ("^a(?=.{2}$)", "u", "a\u{1f600}b", true),
    ("^a(?!.{3}$)", "", "a\u{1f600}b", false),
    ("^a(?!.{3}$)", "u", "a\u{1f600}b", true),
    ("(?<=^.{2})b", "", "\u{1f600}b", true),
    ("(?<=^.{2})b", "u", "\u{1f600}b", false),
    ("(?<=^.)b", "", "\u{1f600}b", false),
    ("(?<=^.)b", "u", "\u{1f600}b", true),
    ("(?<=^.{1})b", "", "\u{1f600}b", false),
    ("(?<=^.{1})b", "u", "\u{1f600}b", true),
    ("^.{3}$", "", "\u{1f600}b", true),
    ("^.{3}$", "u", "\u{1f600}b", false),
    ("^.{2}b$", "", "\u{1f600}b", true),
    ("^.{2}b$", "u", "\u{1f600}b", false),
    ("^.b$", "", "\u{1f600}b", false),
    ("^.b$", "u", "\u{1f600}b", true),
    ("^\\S{2}b", "", "\u{1f600}b", true),
    ("^\\S{2}b", "u", "\u{1f600}b", false),
    ("^\\Sb", "", "\u{1f600}b", false),
    ("^\\Sb", "u", "\u{1f600}b", true),
    ("\\uD83D", "", "\u{1f600}", true),
    ("\\uDE00", "", "\u{1f600}", true),
    ("[\\uD800-\\uDBFF]", "", "\u{1f600}", true),
    ("^[\\uD800-\\uDFFF]{2}$", "", "\u{1f600}", true),
    ("^[\\uD800-\\uDFFF]$", "", "\u{1f600}", false),
    ("[^\\uD800-\\uDFFF]", "", "\u{1f600}", false),
    ("\\uD83D(?!\\uDE00)", "", "\u{1f600}", false),
    ("\u{1f600}", "u", "\u{1f600}", true),
    ("^\u{1f600}$", "u", "\u{1f600}", true),
    ("^\u{1f600}+$", "u", "\u{1f600}\u{1f600}", true),
    ("^(?:\u{1f600})+$", "u", "\u{1f600}\u{1f600}", true),
    ("[\u{1f600}]", "u", "\u{1f600}", true),
    ("^[\u{1f600}]$", "u", "\u{1f600}", true),
    ("^[\u{1f600}]{2}$", "u", "\u{1f600}", false),
    ("^[\u{1f600}]{2}$", "u", "\u{10000}", false),
    ("[\u{1f600}]", "u", "\u{10000}", false),
    ("^[^\u{1f600}]{2}$", "u", "\u{10000}", false),
    ("\u{1f600}?$", "u", "a\u{1f600}", true),
    ("\u{10000}", "u", "\u{1f600}", false),
    ("^\u{1f600}{2}$", "u", "\u{1f600}\u{1f600}", true),
    ("i", "i", "\u{1f600}\u{131}", false),
    ("^.{3}$", "i", "\u{1f600}\u{131}", true),
    ("^\\S{2}[a-z]$", "i", "\u{1f600}\u{131}", false),
    ("^\\S{3}$", "i", "\u{1f600}\u{131}", true),
    ("^\\W{3}$", "i", "\u{1f600}\u{131}", true),
    ("^.{3}$", "iu", "\u{1f600}\u{131}", false),
    ("^.{2}$", "iu", "\u{1f600}\u{131}", true),
    ("^.{2}$", "i", "\u{1f600}", true),
    ("^.$", "i", "\u{1f600}", false),
    ("^.{2}$", "s", "\u{1f600}", true),
    ("^.{2}$", "m", "\u{1f600}", true),
    ("^.{2}$", "g", "\u{1f600}", true),
    ("^.{2}$", "y", "\u{1f600}", true),
    // patterns that walk whole characters, beside a character outside the BMP
    ("a", "", "a\u{1f600}", true),
    ("a", "", "\u{1f600}a", true),
    ("a", "", "a\u{1f600}a", true),
    ("a", "", "aa\u{1f600}", true),
    ("a", "", "\u{1f600}", false),
    ("a", "", "b\u{1f600}a", true),
    ("a", "", "\u{1f600}aa\u{1f600}", true),
    ("a", "", "1\u{1f600}2", false),
    ("a", "", "ab\u{10000}", true),
    ("a\\b", "", "a\u{1f600}", true),
    ("a\\b", "", "\u{1f600}a", true),
    ("a\\b", "", "a\u{1f600}a", true),
    ("a\\b", "", "aa\u{1f600}", true),
    ("a\\b", "", "\u{1f600}", false),
    ("a\\b", "", "b\u{1f600}a", true),
    ("a\\b", "", "\u{1f600}aa\u{1f600}", true),
    ("a\\b", "", "1\u{1f600}2", false),
    ("a\\b", "", "ab\u{10000}", false),
    ("\\ba", "", "a\u{1f600}", true),
    ("\\ba", "", "\u{1f600}a", true),
    ("\\ba", "", "a\u{1f600}a", true),
    ("\\ba", "", "aa\u{1f600}", true),
    ("\\ba", "", "\u{1f600}", false),
    ("\\ba", "", "b\u{1f600}a", true),
    ("\\ba", "", "\u{1f600}aa\u{1f600}", true),
    ("\\ba", "", "1\u{1f600}2", false),
    ("\\ba", "", "ab\u{10000}", true),
    ("a$", "", "a\u{1f600}", false),
    ("a$", "", "\u{1f600}a", true),
    ("a$", "", "a\u{1f600}a", true),
    ("a$", "", "aa\u{1f600}", false),
    ("a$", "", "\u{1f600}", false),
    ("a$", "", "b\u{1f600}a", true),
    ("a$", "", "\u{1f600}aa\u{1f600}", false),
    ("a$", "", "1\u{1f600}2", false),
    ("a$", "", "ab\u{10000}", false),
    ("^a", "", "a\u{1f600}", true),
    ("^a", "", "\u{1f600}a", false),
    ("^a", "", "a\u{1f600}a", true),
    ("^a", "", "aa\u{1f600}", true),
    ("^a", "", "\u{1f600}", false),
    ("^a", "", "b\u{1f600}a", false),
    ("^a", "", "\u{1f600}aa\u{1f600}", false),
    ("^a", "", "1\u{1f600}2", false),
    ("^a", "", "ab\u{10000}", true),
    ("a(?!b)", "", "a\u{1f600}", true),
    ("a(?!b)", "", "\u{1f600}a", true),
    ("a(?!b)", "", "a\u{1f600}a", true),
    ("a(?!b)", "", "aa\u{1f600}", true),
    ("a(?!b)", "", "\u{1f600}", false),
    ("a(?!b)", "", "b\u{1f600}a", true),
    ("a(?!b)", "", "\u{1f600}aa\u{1f600}", true),
    ("a(?!b)", "", "1\u{1f600}2", false),
    ("a(?!b)", "", "ab\u{10000}", false),
    ("a(?=b)", "", "a\u{1f600}", false),
    ("a(?=b)", "", "\u{1f600}a", false),
    ("a(?=b)", "", "a\u{1f600}a", false),
    ("a(?=b)", "", "aa\u{1f600}", false),
    ("a(?=b)", "", "\u{1f600}", false),
    ("a(?=b)", "", "b\u{1f600}a", false),
    ("a(?=b)", "", "\u{1f600}aa\u{1f600}", false),
    ("a(?=b)", "", "1\u{1f600}2", false),
    ("a(?=b)", "", "ab\u{10000}", true),
    ("a(?!$)", "", "a\u{1f600}", true),
    ("a(?!$)", "", "\u{1f600}a", false),
    ("a(?!$)", "", "a\u{1f600}a", true),
    ("a(?!$)", "", "aa\u{1f600}", true),
    ("a(?!$)", "", "\u{1f600}", false),
    ("a(?!$)", "", "b\u{1f600}a", false),
    ("a(?!$)", "", "\u{1f600}aa\u{1f600}", true),
    ("a(?!$)", "", "1\u{1f600}2", false),
    ("a(?!$)", "", "ab\u{10000}", true),
    ("[a-z]{2}", "", "a\u{1f600}", false),
    ("[a-z]{2}", "", "\u{1f600}a", false),
    ("[a-z]{2}", "", "a\u{1f600}a", false),
    ("[a-z]{2}", "", "aa\u{1f600}", true),
    ("[a-z]{2}", "", "\u{1f600}", false),
    ("[a-z]{2}", "", "b\u{1f600}a", false),
    ("[a-z]{2}", "", "\u{1f600}aa\u{1f600}", true),
    ("[a-z]{2}", "", "1\u{1f600}2", false),
    ("[a-z]{2}", "", "ab\u{10000}", true),
    ("a+$", "", "a\u{1f600}", false),
    ("a+$", "", "\u{1f600}a", true),
    ("a+$", "", "a\u{1f600}a", true),
    ("a+$", "", "aa\u{1f600}", false),
    ("a+$", "", "\u{1f600}", false),
    ("a+$", "", "b\u{1f600}a", true),
    ("a+$", "", "\u{1f600}aa\u{1f600}", false),
    ("a+$", "", "1\u{1f600}2", false),
    ("a+$", "", "ab\u{10000}", false),
    ("x|a", "", "a\u{1f600}", true),
    ("x|a", "", "\u{1f600}a", true),
    ("x|a", "", "a\u{1f600}a", true),
    ("x|a", "", "aa\u{1f600}", true),
    ("x|a", "", "\u{1f600}", false),
    ("x|a", "", "b\u{1f600}a", true),
    ("x|a", "", "\u{1f600}aa\u{1f600}", true),
    ("x|a", "", "1\u{1f600}2", false),
    ("x|a", "", "ab\u{10000}", true),
    ("a\\b|b", "", "a\u{1f600}", true),
    ("a\\b|b", "", "\u{1f600}a", true),
    ("a\\b|b", "", "a\u{1f600}a", true),
    ("a\\b|b", "", "aa\u{1f600}", true),
    ("a\\b|b", "", "\u{1f600}", false),
    ("a\\b|b", "", "b\u{1f600}a", true),
    ("a\\b|b", "", "\u{1f600}aa\u{1f600}", true),
    ("a\\b|b", "", "1\u{1f600}2", false),
    ("a\\b|b", "", "ab\u{10000}", true),
    ("\\d+$", "", "a\u{1f600}", false),
    ("\\d+$", "", "\u{1f600}a", false),
    ("\\d+$", "", "a\u{1f600}a", false),
    ("\\d+$", "", "aa\u{1f600}", false),
    ("\\d+$", "", "\u{1f600}", false),
    ("\\d+$", "", "b\u{1f600}a", false),
    ("\\d+$", "", "\u{1f600}aa\u{1f600}", false),
    ("\\d+$", "", "1\u{1f600}2", true),
    ("\\d+$", "", "ab\u{10000}", false),
    ("a{2}", "", "a\u{1f600}", false),
    ("a{2}", "", "\u{1f600}a", false),
    ("a{2}", "", "a\u{1f600}a", false),
    ("a{2}", "", "aa\u{1f600}", true),
    ("a{2}", "", "\u{1f600}", false),
    ("a{2}", "", "b\u{1f600}a", false),
    ("a{2}", "", "\u{1f600}aa\u{1f600}", true),
    ("a{2}", "", "1\u{1f600}2", false),
    ("a{2}", "", "ab\u{10000}", false),
    ("^\\d", "", "a\u{1f600}", false),
    ("^\\d", "", "\u{1f600}a", false),
    ("^\\d", "", "a\u{1f600}a", false),
    ("^\\d", "", "aa\u{1f600}", false),
    ("^\\d", "", "\u{1f600}", false),
    ("^\\d", "", "b\u{1f600}a", false),
    ("^\\d", "", "\u{1f600}aa\u{1f600}", false),
    ("^\\d", "", "1\u{1f600}2", true),
    ("^\\d", "", "ab\u{10000}", false),
    ("a\\s*$", "", "a\u{1f600}", false),
    ("a\\s*$", "", "\u{1f600}a", true),
    ("a\\s*$", "", "a\u{1f600}a", true),
    ("a\\s*$", "", "aa\u{1f600}", false),
    ("a\\s*$", "", "\u{1f600}", false),
    ("a\\s*$", "", "b\u{1f600}a", true),
    ("a\\s*$", "", "\u{1f600}aa\u{1f600}", false),
    ("a\\s*$", "", "1\u{1f600}2", false),
    ("a\\s*$", "", "ab\u{10000}", false),
];

/// Patterns without `u` that name a character outside the BMP, with the text
/// and the answer Node 22.23.5 gave: `JsRegex::new` refuses to build them.
const REFUSED: &[(&str, &str, bool)] = &[
    ("^\\uD83D\\uDE00$", "\u{1f600}", true),
    ("\u{1f600}", "\u{1f600}", true),
    ("^\u{1f600}$", "\u{1f600}", true),
    ("^\u{1f600}+$", "\u{1f600}\u{1f600}", false),
    ("^(?:\u{1f600})+$", "\u{1f600}\u{1f600}", true),
    ("[\u{1f600}]", "\u{1f600}", true),
    ("^[\u{1f600}]$", "\u{1f600}", false),
    ("^[\u{1f600}]{2}$", "\u{1f600}", true),
    ("^[\u{1f600}]{2}$", "\u{10000}", false),
    ("[\u{1f600}]", "\u{10000}", false),
    ("^[^\u{1f600}]{2}$", "\u{10000}", true),
    ("\u{1f600}?$", "a\u{1f600}", true),
    ("\u{10000}", "\u{1f600}", false),
    ("^\u{1f600}{2}$", "\u{1f600}\u{1f600}", false),
];

/// `regex.lastIndex = start; regex.exec(text)` of the regex with `g`, as Node
/// 22.23.5 answered it: the match and where it begins. `start` and the
/// answer are in bytes here, in UTF-16 units there.
#[allow(clippy::type_complexity)]
const NODE_ANSWERS_FROM: &[(&str, &str, &str, usize, Option<(&str, usize)>)] = &[
    ("\\bb", "", "a\u{1f600}b", 5, Some(("b", 5))),
    ("\\Bb", "", "a\u{1f600}b", 5, None),
    ("\\bb", "", "\u{1f600}b", 4, Some(("b", 4))),
    ("\\B\\.", "", "\u{1f600}.", 4, Some((".", 4))),
    ("^b", "m", "\u{1f600}\u{a}b", 5, Some(("b", 5))),
    ("^b", "", "\u{1f600}b", 4, None),
    ("^b", "m", "\u{1f600}b", 4, None),
    ("(?<=^.{2})b", "", "\u{1f600}bb", 4, Some(("b", 4))),
    ("(?<=.{3})b", "", "\u{1f600}bb", 4, Some(("b", 5))),
    ("(?<=^.)b", "", "\u{1f600}bb", 4, None),
    ("(?<!^.{2})b", "", "\u{1f600}bb", 4, Some(("b", 5))),
    (".{2}", "", "a\u{1f600}bc", 5, Some(("bc", 5))),
    (
        "[^x]{2}",
        "",
        "\u{1f600}x\u{1f600}y",
        4,
        Some(("\u{1f600}", 5)),
    ),
    (".{2}", "", "\u{1f600}bc\u{10000}", 4, Some(("bc", 4))),
    (".{3}", "", "x\u{1f600}bc", 5, None),
    ("\\bi", "i", "\u{212a}i", 3, Some(("i", 3))),
    ("\\Bi", "i", "\u{212a}i", 3, None),
    ("\\bi", "i", "\u{17f}i", 2, Some(("i", 2))),
    ("i", "i", "\u{1f600}\u{131}I", 4, Some(("I", 6))),
    (
        ".{2}i",
        "i",
        "\u{1f600}\u{131}\u{1f600}i",
        6,
        Some(("\u{1f600}i", 6)),
    ),
    ("a", "", "\u{1f600}a\u{1f600}a", 5, Some(("a", 9))),
    ("a\\b", "", "a\u{1f600}a", 1, Some(("a", 5))),
    ("b", "", "\u{1f600}b", 5, None),
];

#[test]
fn a_search_from_a_start_answers_as_node_does() {
    for (pattern, flags, text, start, expected) in NODE_ANSWERS_FROM {
        let regex = JsRegex::new(pattern, flags).unwrap();
        let found = regex
            .find_from(text, *start)
            .next()
            .map(|found| (found.as_str(), found.start()));
        assert_eq!(
            found, *expected,
            "/{pattern}/{flags} on {text:?} from {start}"
        );
    }
}

#[test]
fn test_answers_as_node_does() {
    let mut wrong = Vec::new();
    for (pattern, flags, text, expected) in NODE_ANSWERS {
        match JsRegex::new(pattern, flags) {
            Ok(regex) if regex.test(text) == *expected => {}
            Ok(_) => wrong.push(format!("/{pattern}/{flags} on {text:?}: Node {expected}")),
            Err(error) => wrong.push(format!("/{pattern}/{flags}: {error}")),
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {}:\n{}",
        wrong.len(),
        NODE_ANSWERS.len(),
        wrong.join("\n")
    );
}

/// What `regress` alone answers on a `&str`. When this fails, `regress`
/// walks units there: take the unit search out of `JsRegex`.
#[test]
fn regress_alone_still_counts_a_pair_once() {
    let alone =
        |pattern: &str, text: &str| regress::Regex::new(pattern).unwrap().find(text).is_some();
    assert!(alone(r"^\S{1,15}$", &"\u{1f600}".repeat(8)));
    assert!(alone("^.$", "\u{1f600}"));
    assert!(!alone("^.{2}$", "\u{1f600}"));
}

#[test]
fn a_pattern_naming_a_character_outside_the_bmp_is_refused_without_u() {
    for (pattern, _, _) in REFUSED {
        assert!(JsRegex::new(pattern, "").is_err(), "{pattern}");
        assert!(JsRegex::new(pattern, "u").is_ok(), "{pattern}");
    }
    // one half alone is a unit like any other
    assert!(JsRegex::new(r"\uD83D", "").is_ok());
    assert!(JsRegex::new(r"[\uD800-\uDBFF][\uDC00-\uDFFF]", "").is_ok());
    // an escaped backslash before `u` starts no escape
    assert!(JsRegex::new(r"\\uD83D\\uDE00", "").is_ok());
}

#[test]
fn captures_and_offsets_are_those_of_the_text_given() {
    // Node: /b/.exec('\u{1F600}b').index is 2
    let found = js_regex!("b").exec("\u{1f600}b").unwrap();
    assert_eq!((found.as_str(), found.start(), found.end()), ("b", 4, 5));
    // Node: /(.{2})(b)/.exec('\u{1F600}b') is ['\u{1F600}b', '\u{1F600}', 'b'] at 0
    let found = js_regex!("(.{2})(b)").exec("\u{1f600}b").unwrap();
    assert_eq!(
        (found.as_str(), found.get(1), found.get(2), found.start()),
        ("\u{1f600}b", Some("\u{1f600}"), Some("b"), 0)
    );
    // Node: /(?<=^.{2})b(.{2})/.exec('\u{1F600}b\u{10000}') is ['b\u{10000}', '\u{10000}'] at 2
    let found = js_regex!("(?<=^.{2})b(.{2})")
        .exec("\u{1f600}b\u{10000}")
        .unwrap();
    assert_eq!(
        (found.as_str(), found.get(1), found.start()),
        ("b\u{10000}", Some("\u{10000}"), 4)
    );
    // Node: [...'\u{1F600}\u{10000}ab'.matchAll(/.{2}/g)] is three matches, at 0, 2 and 4
    let all: Vec<_> = js_regex!(".{2}", "g")
        .find_iter("\u{1f600}\u{10000}ab")
        .map(|m| (m.as_str(), m.start()))
        .collect();
    assert_eq!(all, [("\u{1f600}", 0), ("\u{10000}", 4), ("ab", 8)]);
    // Node: [...'a\u{1F600}b\u{10000}'.matchAll(/[^a-z]{2}/g)] is two matches, at 1 and 4
    let all: Vec<_> = js_regex!("[^a-z]{2}", "g")
        .find_iter("a\u{1f600}b\u{10000}")
        .map(|m| (m.as_str(), m.start()))
        .collect();
    assert_eq!(all, [("\u{1f600}", 1), ("\u{10000}", 6)]);
    // Node: r = /.{2}/g; r.lastIndex = 2; r.exec('\u{1F600}\u{10000}') is '\u{10000}' at 2
    let later: Vec<_> = js_regex!(".{2}", "g")
        .find_from("\u{1f600}\u{10000}", 4)
        .map(|m| (m.as_str(), m.start()))
        .collect();
    assert_eq!(later, [("\u{10000}", 4)]);
    // Node: [...'\u{1F600}b'.matchAll(/a*/g)] is four empty matches, at 0, 1, 2 and 3
    assert_eq!(js_regex!("a*", "g").find_iter("\u{1f600}b").count(), 4);
}

#[test]
fn replace_and_split_count_units() {
    // Node: '\u{1F600}\u{1F600}'.replace(/.{2}/g, m => `<${m}>`)
    assert_eq!(
        js_regex!(".{2}", "g").replace_all("\u{1f600}\u{1f600}", |m| format!("<{}>", m.as_str())),
        "<\u{1f600}><\u{1f600}>"
    );
    // Node: 'a\u{1F600}b'.replace(/[^a-z]{2}/g, 'X') and .replace(/[^a-z]/g, 'X')
    assert_eq!(
        js_regex!("[^a-z]{2}", "g").replace_all("a\u{1f600}b", |_| "X".to_owned()),
        "aXb"
    );
    assert_eq!(
        js_regex!("[^a-z]", "g").replace_all("a\u{1f600}b", |_| "X".to_owned()),
        "aXXb"
    );
    // Node: '\u{1F600}'.replace(/./g, 'x')
    assert_eq!(
        js_regex!(".", "g").replace_all("\u{1f600}", |_| "x".to_owned()),
        "xx"
    );
    // Node: 'I\u{1F600}\u0131'.replace(/i/gi, 'x'), and /^.{3}$/i.test('\u{1F600}\u0131') is true
    assert_eq!(
        js_regex!("i", "gi").replace_all("I\u{1f600}\u{131}", |_| "x".to_owned()),
        "x\u{1f600}\u{131}"
    );
    assert!(js_regex!("^.{3}$", "i").test("\u{1f600}\u{131}"));
    // Node: 'a\u{1F600}b\u{10000}c'.split(/[^a-z]{2}/) and 'a\u{1F600}b'.split(/[^a-z]/)
    assert_eq!(
        js_regex!("[^a-z]{2}").split("a\u{1f600}b\u{10000}c"),
        ["a", "b", "c"]
    );
    assert_eq!(js_regex!("[^a-z]").split("a\u{1f600}b"), ["a", "", "b"]);
}

/// JavaScript answers with half a pair here. In `replace_all` the half is
/// U+FFFD, the bytes JavaScript writes for it as UTF-8.
#[test]
fn half_a_pair_left_in_a_replacement_is_the_replacement_character() {
    // Node: '\u{1F600}'.replace(/(?:)/g, '-') is '-\ud83d-\ude00-'; as UTF-8, 2d efbfbd 2d efbfbd 2d
    assert_eq!(
        js_regex!("(?:)", "g").replace_all("\u{1f600}", |_| "-".to_owned()),
        "-\u{fffd}-\u{fffd}-"
    );
    // Node: '\u{1F600}\u{1F600}'.replace(/^.{3}/g, 'x') is 'x\ude00'; as UTF-8, 78 efbfbd
    assert_eq!(
        js_regex!("^.{3}", "g").replace_all("\u{1f600}\u{1f600}", |_| "x".to_owned()),
        "x\u{fffd}"
    );
}

/// JavaScript answers with half a pair here, which a `&str` cannot be: the
/// character goes to the match, capture or piece that holds its first half.
#[test]
fn a_match_that_cuts_a_pair_ends_after_the_character() {
    // Node: /^.{3}/.exec('\u{1F600}\u{1F600}')[0] is '\u{1F600}\ud83d'
    let found = js_regex!("^.{3}").exec("\u{1f600}\u{1f600}").unwrap();
    assert_eq!((found.as_str(), found.end()), ("\u{1f600}\u{1f600}", 8));
    // Node: [...'\u{1F600}'.matchAll(/./g)] is '\ud83d' at 0 and '\ude00' at 1
    let all: Vec<_> = js_regex!(".", "g")
        .find_iter("\u{1f600}")
        .map(|m| (m.as_str(), m.start()))
        .collect();
    assert_eq!(all, [("\u{1f600}", 0), ("", 4)]);
    // Node: /^(.)(.)$/.exec('\u{1F600}') is ['\u{1F600}', '\ud83d', '\ude00']
    let found = js_regex!("^(.)(.)$").exec("\u{1f600}").unwrap();
    assert_eq!((found.get(1), found.get(2)), (Some("\u{1f600}"), Some("")));
    // Node: /(?<=^.).*/.exec('\u{1F600}b') is '\ude00b' at 1
    let found = js_regex!("(?<=^.).*").exec("\u{1f600}b").unwrap();
    assert_eq!((found.as_str(), found.start()), ("b", 4));
    // Node: '\u{1F600}b'.split(/(?<=^.)/) is ['\ud83d', '\ude00b']
    assert_eq!(js_regex!("(?<=^.)").split("\u{1f600}b"), ["\u{1f600}", "b"]);
    // Node: 'a\u{1F600}'.replace(/[^a]/g, m => `[${m}]`) is 'a[\ud83d][\ude00]'
    assert_eq!(
        js_regex!("[^a]", "g").replace_all("a\u{1f600}", |m| format!("[{}]", m.as_str())),
        "a[\u{1f600}][]"
    );
}
