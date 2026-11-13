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
/// The references are decoded over UTF-16 units, as the TypeScript's strings
/// hold them: a reference to half of a surrogate pair is that unit, a high
/// half right before a low half is the character the pair spells, and a half
/// left alone reads as U+FFFD (`/[\uD800-\uDFFF]/gu`; a Rust string has no
/// lone surrogate either).
pub fn decode_xml_entities(value: &str) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    let hex = character_references(&units, Radix::Sixteen);
    let decimal = character_references(&hex, Radix::Ten);
    String::from_utf16_lossy(&decimal)
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// `.replace(/&#x([0-9a-f]+);/gi, ...)` (hexadecimal) or `.replace(/&#(\d+);/g,
/// ...)` over UTF-16 units: a reference to a code point up to U+10FFFF is its
/// units (a surrogate is the one unit), any other stays as written.
fn character_references(units: &[u16], radix: Radix) -> Vec<u16> {
    let ascii = |at: usize| units.get(at).and_then(|&unit| u8::try_from(unit).ok());
    let is_digit = |byte: u8| match radix {
        Radix::Sixteen => byte.is_ascii_hexdigit(),
        _ => byte.is_ascii_digit(),
    };
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0;
    while at < units.len() {
        let mut digits_at = at + 2;
        let opens = ascii(at) == Some(b'&')
            && ascii(at + 1) == Some(b'#')
            && match radix {
                Radix::Sixteen => {
                    digits_at += 1;
                    matches!(ascii(at + 2), Some(b'x' | b'X'))
                }
                _ => true,
            };
        let mut end = digits_at;
        while opens && ascii(end).is_some_and(is_digit) {
            end += 1;
        }
        if !opens || end == digits_at || ascii(end) != Some(b';') {
            out.push(units[at]);
            at += 1;
            continue;
        }
        let digits: String = units[digits_at..end]
            .iter()
            .map(|&unit| unit as u8 as char)
            .collect();
        let code = parse_int(&digits, radix);
        if code.fract() == 0.0 && (0.0..=1_114_111.0).contains(&code) {
            let code = code as u32;
            match char::from_u32(code) {
                Some(c) => out.extend(c.encode_utf16(&mut [0; 2]).iter()),
                // a surrogate code point: the one unit
                None => out.push(code as u16),
            }
        } else {
            out.extend_from_slice(&units[at..=end]);
        }
        at = end + 1;
    }
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
mod tests {
    use super::decode_xml_entities;

    #[test]
    fn surrogate_references_pair_or_read_as_replacement() {
        assert_eq!(
            decode_xml_entities("Client&#xD83D;&#xDE00;"),
            "Client\u{1F600}"
        );
        assert_eq!(decode_xml_entities("&#55357;&#56832;"), "\u{1F600}");
        assert_eq!(
            decode_xml_entities("a&#xD800;b&#57343;"),
            "a\u{FFFD}b\u{FFFD}"
        );
        // a low half before a high half is no pair
        assert_eq!(decode_xml_entities("&#xDE00;&#xD83D;"), "\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn text_that_spells_a_marker_stays_as_written() {
        let text = "\u{FDD0}D83D\u{FDD0}DE00";
        assert_eq!(decode_xml_entities(text), text);
        assert_eq!(decode_xml_entities("&amp;#xFDD0;D83D"), "&#xFDD0;D83D");
    }

    #[test]
    fn mixed_and_repeated_halves() {
        assert_eq!(decode_xml_entities("&#xD83D;&#56832;"), "\u{1F600}");
        assert_eq!(decode_xml_entities("a&#xd83d;&#xde00;b"), "a\u{1F600}b");
        // a lone high half, then a whole pair
        assert_eq!(
            decode_xml_entities("&#xD83D;&#xD83D;&#xDE00;"),
            "\u{FFFD}\u{1F600}"
        );
    }

    #[test]
    fn the_hexadecimal_pass_runs_before_the_decimal_one() {
        // &#x26; is "&": the decimal pass then reads the reference it made
        assert_eq!(decode_xml_entities("&#x26;#65;"), "A");
        assert_eq!(decode_xml_entities("&#X41;&#x110000;"), "A&#x110000;");
    }
}
