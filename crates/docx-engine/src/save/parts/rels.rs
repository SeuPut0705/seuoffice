//! The relationship and attribute readers resource-cleanup.ts and
//! remove-parts.ts share: both read `.rels`, `[Content_Types].xml` and small
//! tags with regular expressions, and keep their bytes where they do not edit.

use jscompat::{
    Radix, RegexLimit, TryJsRegex, decode_uri_component, js_regex, parse_int, regex_escape,
    try_js_regex,
};

/// `RELATIONSHIP_TAG_RE`: a `Relationship` element, self-closing or paired.
pub fn relationship_tags() -> &'static TryJsRegex {
    try_js_regex!(
        r"<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*(?:\/\s*>|>\s*<\/(?:[A-Za-z_][\w.-]*:)?Relationship\s*>)",
        "g"
    )
}

/// `OVERRIDE_TAG_RE`
pub fn override_tags() -> &'static TryJsRegex {
    try_js_regex!(
        r"<(?:[A-Za-z_][\w.-]*:)?Override\b[^>]*(?:\/\s*>|>\s*<\/(?:[A-Za-z_][\w.-]*:)?Override\s*>)",
        "g"
    )
}

/// `decodeXmlEntities`: character references, then the five named entities.
/// A reference to half of a surrogate pair is left in place by the two regex
/// passes and settled by `pair_surrogate_references`: a high half directly
/// followed by a low half is the one astral character `String.fromCodePoint`
/// makes by concatenation; a lone half reads as U+FFFD (a Rust string has no
/// lone surrogate; remove-parts.ts replaces one the same way).
pub fn decode_xml_entities(value: &str) -> String {
    fn code_point(whole: &str, raw: &str, radix: Radix) -> String {
        let value = parse_int(raw, radix);
        if value.fract() == 0.0 && (0.0..=1_114_111.0).contains(&value) {
            return char::from_u32(value as u32).map_or_else(|| whole.to_owned(), String::from);
        }
        whole.to_owned()
    }
    let hex = js_regex!(r"&#x([0-9a-f]+);", "gi").replace_all(value, |found| {
        code_point(
            found.as_str(),
            found.get(1).unwrap_or_default(),
            Radix::Sixteen,
        )
    });
    let decimal = js_regex!(r"&#(\d+);", "g").replace_all(&hex, |found| {
        code_point(found.as_str(), found.get(1).unwrap_or_default(), Radix::Ten)
    });
    pair_surrogate_references(&decimal)
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The value of a numeric character reference at the start of `text` and its
/// length, when it is a (hex or decimal) reference to a UTF-16 surrogate.
fn surrogate_reference(text: &str) -> Option<(u32, usize)> {
    let bytes = text.as_bytes();
    if !text.starts_with("&#") {
        return None;
    }
    let (radix, mut at) = match bytes.get(2) {
        Some(b'x' | b'X') => (16u64, 3),
        _ => (10u64, 2),
    };
    let digits_from = at;
    let mut value = 0u64;
    while let Some(digit) = bytes
        .get(at)
        .and_then(|byte| char::from(*byte).to_digit(radix as u32))
    {
        value = (value * radix + u64::from(digit)).min(0x1F_FFFF);
        at += 1;
    }
    if at == digits_from || bytes.get(at) != Some(&b';') {
        return None;
    }
    (0xD800..=0xDFFF)
        .contains(&value)
        .then_some((value as u32, at + 1))
}

/// The surrogate references the regex passes left: a high half and a low half
/// side by side become their character, any other half becomes U+FFFD.
fn pair_surrogate_references(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("&#") {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some((first, length)) = surrogate_reference(rest) else {
            out.push_str("&#");
            rest = &rest[2..];
            continue;
        };
        rest = &rest[length..];
        if (0xD800..0xDC00).contains(&first)
            && let Some((second, length)) = surrogate_reference(rest)
            && (0xDC00..=0xDFFF).contains(&second)
        {
            let code = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
            rest = &rest[length..];
        } else {
            out.push('\u{FFFD}');
        }
    }
    out.push_str(rest);
    out
}

/// `xmlAttr`: an attribute of a tag by its name, both quote styles.
pub fn xml_attr(tag: &str, name: &str) -> Result<Option<String>, String> {
    let pattern = TryJsRegex::new(
        &format!(
            r#"(?:^|\s){}\s*=\s*(?:"([^"]*)"|'([^']*)')"#,
            regex_escape(name)
        ),
        "",
    )
    .map_err(|error| error.to_string())?;
    attribute_value(&pattern, tag)
}

/// `attributeOf` of remove-parts.ts: an attribute by local name, tolerating
/// any namespace prefix (`ds:itemID`, `w:val`, ...) and both quote styles.
pub fn attribute_of(tag: &str, local_name: &str) -> Result<Option<String>, String> {
    let pattern = TryJsRegex::new(
        &format!(
            r#"(?:^|\s)(?:[A-Za-z_][\w.-]*:)?{}\s*=\s*(?:"([^"]*)"|'([^']*)')"#,
            regex_escape(local_name)
        ),
        "",
    )
    .map_err(|error| error.to_string())?;
    attribute_value(&pattern, tag)
}

fn attribute_value(pattern: &TryJsRegex, tag: &str) -> Result<Option<String>, String> {
    let found = pattern
        .try_exec(tag)
        .map_err(|limit: RegexLimit| limit.to_string())?;
    Ok(found.and_then(|found| {
        found
            .get(1)
            .or_else(|| found.get(2))
            .map(decode_xml_entities)
    }))
}

/// `relationshipSourcePath`: the source part a relationships part belongs to
/// (`_rels/.rels` is the package root, `""`).
pub fn relationship_source_path(rels_path: &str) -> Option<String> {
    if rels_path == "_rels/.rels" {
        return Some(String::new());
    }
    js_regex!(r"^(.*\/)?_rels\/([^/]+)\.rels$")
        .exec(rels_path)
        .map(|found| {
            format!(
                "{}{}",
                found.get(1).unwrap_or_default(),
                found.get(2).unwrap_or_default()
            )
        })
}

/// `relationshipPartPath`: the relationships part that belongs to a part
/// (`customXml/item1.xml` to `customXml/_rels/item1.xml.rels`).
pub fn relationship_part_path(part_path: &str) -> String {
    let (dir, filename) = match part_path.rfind('/') {
        Some(slash) => (&part_path[..=slash], &part_path[slash + 1..]),
        None => ("", part_path),
    };
    format!("{dir}_rels/{filename}.rels")
}

/// `decodePartUri`
pub fn decode_part_uri(uri: &str) -> String {
    decode_uri_component(uri).unwrap_or_else(|_| uri.to_owned())
}

#[cfg(test)]
mod surrogate_tests {
    use super::decode_xml_entities;

    #[test]
    fn adjacent_surrogate_references_make_one_character() {
        assert_eq!(decode_xml_entities("&#xD83D;&#xDE00;"), "\u{1F600}");
        assert_eq!(decode_xml_entities("&#55357;&#56832;"), "\u{1F600}");
        assert_eq!(decode_xml_entities("&#xD83D;&#56832;"), "\u{1F600}");
        assert_eq!(decode_xml_entities("a&#xd83d;&#xde00;b"), "a\u{1F600}b");
    }

    #[test]
    fn lone_surrogate_references_read_as_replacement_characters() {
        assert_eq!(decode_xml_entities("&#xD83D;"), "\u{FFFD}");
        assert_eq!(decode_xml_entities("&#xDE00;&#xD83D;"), "\u{FFFD}\u{FFFD}");
        // a lone high half, then a whole pair
        assert_eq!(
            decode_xml_entities("&#xD83D;&#xD83D;&#xDE00;"),
            "\u{FFFD}\u{1F600}"
        );
        // a named entity never turns into a reference
        assert_eq!(decode_xml_entities("&amp;#xD83D;"), "&#xD83D;");
    }
}
