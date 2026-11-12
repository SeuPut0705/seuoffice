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
/// A reference to half of a surrogate pair reads as U+FFFD (a Rust string has
/// no lone surrogate; remove-parts.ts replaces one the same way), except that
/// a high half right before a low half is the character the pair spells, as
/// the TypeScript's `/[\uD800-\uDFFF]/gu` leaves it.
pub fn decode_xml_entities(value: &str) -> String {
    // a surrogate half is held as SURROGATE and its four hex digits until the
    // halves are paired
    const SURROGATE: char = '\u{FDD0}';
    fn code_point(whole: &str, raw: &str, radix: Radix) -> String {
        let value = parse_int(raw, radix);
        if value.fract() == 0.0 && (0.0..=1_114_111.0).contains(&value) {
            let unit = value as u32;
            return match char::from_u32(unit) {
                Some(c) => String::from(c),
                None => format!("{SURROGATE}{unit:04X}"),
            };
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
    let paired = if decimal.contains(SURROGATE) {
        pair_surrogates(&decimal, SURROGATE)
    } else {
        decimal
    };
    paired
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The halves `decode_xml_entities` held as `mark` and four hex digits: a
/// high half before a low half is their character, any other is U+FFFD. A
/// `mark` the document wrote itself, not followed by a half, stays.
fn pair_surrogates(text: &str, mark: char) -> String {
    let half = |rest: &str| -> Option<u32> {
        let digits = rest.strip_prefix(mark)?.get(..4)?;
        u32::from_str_radix(digits, 16).ok().filter(|unit| (0xD800..=0xDFFF).contains(unit))
    };
    let width = mark.len_utf8() + 4;
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(mark) {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(high) = half(rest) else {
            out.push(mark);
            rest = &rest[mark.len_utf8()..];
            continue;
        };
        rest = &rest[width..];
        if (0xD800..0xDC00).contains(&high)
            && let Some(low) = half(rest).filter(|low| *low >= 0xDC00)
        {
            rest = &rest[width..];
            let unit = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
            out.push(char::from_u32(unit).unwrap_or('\u{FFFD}'));
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
