//! xlsx-gateway `gateway/xlsx-xml-scan.ts`, the read side: the elements of a
//! small XML part (the workbook, a pivot definition) read the way an XML
//! parser reads them, though the text is searched and not parsed. Comments,
//! CDATA sections and processing instructions are skipped as units, and an
//! attribute run is consumed as quoted strings, so a `>` inside a value does
//! not end a tag.
//!
//! The TypeScript finds tokens with one regular expression. The scanners here
//! match what that expression matches, backtracking included, with offsets in
//! bytes (everything the scans look for is ASCII).

use jscompat::{is_js_space, js_regex, to_number};

/// What a token matches from a `<` at `at`: where it ends and what it holds.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Markup<'t> {
    /// a comment, a CDATA section (its text), a processing instruction or a doctype
    Skipped { cdata: Option<&'t str> },
    /// a start, end or self-closed tag
    Tag {
        closing: bool,
        name: &'t str,
        attributes: &'t str,
    },
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Token<'t> {
    pub start: usize,
    pub end: usize,
    pub markup: Markup<'t>,
}

/// `<!--[\s\S]*?-->`, `<!\[CDATA\[([\s\S]*?)\]\]>` and `<\?[\s\S]*?\?>` at `at`.
pub(crate) fn skipped_at(xml: &str, at: usize) -> Option<Token<'_>> {
    let rest = &xml[at..];
    let (opener, closer) = if rest.starts_with("<!--") {
        ("<!--", "-->")
    } else if rest.starts_with("<![CDATA[") {
        ("<![CDATA[", "]]>")
    } else if rest.starts_with("<?") {
        ("<?", "?>")
    } else {
        return None;
    };
    let body = &rest[opener.len()..];
    let close = body.find(closer)?;
    Some(Token {
        start: at,
        end: at + opener.len() + close + closer.len(),
        markup: Markup::Skipped {
            cdata: (opener == "<![CDATA[").then(|| &body[..close]),
        },
    })
}

/// `(?:"[^"]*"|'[^']*'|[^>"'])*>` from `from`: where the `>` is, when the run
/// of quoted strings and other characters reaches one.
pub(crate) fn attribute_run_end(xml: &str, from: usize) -> Option<usize> {
    let bytes = xml.as_bytes();
    let mut at = from;
    while at < bytes.len() {
        match bytes[at] {
            b'>' => return Some(at),
            quote @ (b'"' | b'\'') => {
                let close = xml[at + 1..].find(char::from(quote))?;
                at += close + 2;
            }
            _ => at += 1,
        }
    }
    None
}

/// The `TOKEN` of the scanner: a comment, a CDATA section, a processing
/// instruction, a doctype or a tag, from a `<` at `at`.
fn token_at(xml: &str, at: usize) -> Option<Token<'_>> {
    if let Some(skipped) = skipped_at(xml, at) {
        return Some(skipped);
    }
    let rest = &xml[at..];
    if let Some(body) = rest.strip_prefix("<!DOCTYPE") {
        let close = body.find('>')?;
        return Some(Token {
            start: at,
            end: at + "<!DOCTYPE".len() + close + 1,
            markup: Markup::Skipped { cdata: None },
        });
    }
    // `<(\/?)([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>`
    let closing = rest[1..].starts_with('/');
    let name_start = at + 1 + usize::from(closing);
    let name_len = xml[name_start..]
        .find(|c: char| is_js_space(c) || matches!(c, '/' | '>' | '!' | '?'))
        .unwrap_or(xml.len() - name_start);
    if name_len == 0 {
        return None;
    }
    let name_end = name_start + name_len;
    // The name may hold quotes, so when the attributes after all of it do not
    // end in a `>`, the match backtracks to a name that ends before a quote
    // and reads from it.
    let splits = std::iter::once(name_end).chain(
        xml[name_start..name_end]
            .bytes()
            .enumerate()
            .rev()
            .filter(|(index, byte)| *index > 0 && matches!(*byte, b'"' | b'\''))
            .map(|(index, _)| name_start + index),
    );
    for split in splits {
        if let Some(close) = attribute_run_end(xml, split) {
            return Some(Token {
                start: at,
                end: close + 1,
                markup: Markup::Tag {
                    closing,
                    name: &xml[name_start..split],
                    attributes: &xml[split..close],
                },
            });
        }
    }
    None
}

/// Every token of the scanner, in order: a `<` that starts none is passed over.
fn tokens(xml: &str) -> impl Iterator<Item = Token<'_>> {
    let mut at = 0;
    std::iter::from_fn(move || {
        while let Some(found) = xml[at..].find('<') {
            let start = at + found;
            if let Some(token) = token_at(xml, start) {
                at = token.end;
                return Some(token);
            }
            at = start + 1;
        }
        None
    })
}

/// `NAMED_ENTITIES` and the numeric references of `decodeXmlEntities`. A
/// reference to half of a surrogate pair reads as U+FFFD: a Rust string cannot
/// hold the lone half.
pub(crate) fn decode_xml_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_owned();
    }
    js_regex!(r"&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(quot|apos|lt|gt|amp));").replace_all(
        input,
        |found| {
            if let Some(named) = found.get(3) {
                return match named {
                    "quot" => "\"",
                    "apos" => "'",
                    "lt" => "<",
                    "gt" => ">",
                    _ => "&",
                }
                .to_owned();
            }
            let code = match found.get(1) {
                Some(hex) => hex.bytes().fold(0.0, |code, digit| {
                    code * 16.0 + f64::from(char::from(digit).to_digit(16).unwrap_or(0))
                }),
                None => to_number(found.get(2).unwrap_or_default()),
            };
            if code <= f64::from(0x10_FFFF_u32) {
                char::from_u32(code as u32)
                    .unwrap_or('\u{FFFD}')
                    .to_string()
            } else {
                found.as_str().to_owned()
            }
        },
    )
}

#[derive(Debug)]
pub(crate) struct XmlElement {
    /// the element's name as written, prefix included
    pub name: String,
    /// the offset of the `<` that opens the element
    pub start: usize,
    /// the offset after the `>` of the opening tag
    pub open_end: usize,
    /// the offset of the `<` of the end tag, the end of the opening tag for an element written self-closed
    pub close_start: usize,
    /// the attributes by name as written (`r:id`), their values decoded
    attributes: Vec<(String, String)>,
}

impl XmlElement {
    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

fn local_name_of(name: &str) -> &str {
    name.split_once(':').map_or(name, |(_, local)| local)
}

fn prefix_of(name: &str) -> &str {
    name.split_once(':').map_or("", |(prefix, _)| prefix)
}

/// `attributesOf`: `([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')` over the
/// attribute text; a later attribute of the same name replaces the earlier.
fn attributes_of(text: &str) -> Vec<(String, String)> {
    let mut attributes: Vec<(String, String)> = Vec::new();
    let is_name = |c: char| !(is_js_space(c) || matches!(c, '=' | '<' | '>' | '/' | '"' | '\''));
    let mut at = 0;
    while at < text.len() {
        let Some(first) = text[at..].find(is_name) else {
            break;
        };
        let name_start = at + first;
        let name_end = text[name_start..]
            .find(|c: char| !is_name(c))
            .map_or(text.len(), |length| name_start + length);
        // a name that is not followed by `=` and a quoted value does not start
        // one in its own tail either
        at = name_end;
        let after_name = text[name_end..].trim_start_matches(is_js_space);
        let Some(after_equals) = after_name.strip_prefix('=') else {
            continue;
        };
        let value = after_equals.trim_start_matches(is_js_space);
        let Some(quote) = value.chars().next().filter(|c| matches!(*c, '"' | '\'')) else {
            continue;
        };
        let Some(close) = value[1..].find(quote) else {
            continue;
        };
        let name = &text[name_start..name_end];
        let decoded = decode_xml_entities(&value[1..1 + close]);
        match attributes.iter_mut().find(|(key, _)| key == name) {
            Some((_, existing)) => *existing = decoded,
            None => attributes.push((name.to_owned(), decoded)),
        }
        at = text.len() - value.len() + 1 + close + 1;
    }
    attributes
}

struct Open<'t> {
    name: &'t str,
    start: usize,
    open_end: usize,
    attributes: &'t str,
}

/// The elements of `xml` whose name (prefix aside) is `local`, in document
/// order. An element with no end tag, or one an end tag of another name
/// closes first, ends where the part does.
pub(crate) fn xml_elements(xml: &str, local: &str) -> Vec<XmlElement> {
    let mut found: Vec<XmlElement> = Vec::new();
    let finish = |found: &mut Vec<XmlElement>, entry: &Open<'_>, close_start: usize| {
        if local_name_of(entry.name) != local {
            return;
        }
        found.push(XmlElement {
            name: entry.name.to_owned(),
            start: entry.start,
            open_end: entry.open_end,
            close_start,
            attributes: attributes_of(entry.attributes),
        });
    };
    let mut open: Vec<Open<'_>> = Vec::new();
    for token in tokens(xml) {
        let Markup::Tag {
            closing,
            name,
            attributes,
        } = token.markup
        else {
            continue;
        };
        if closing {
            let Some(at) = open.iter().rposition(|entry| entry.name == name) else {
                continue;
            };
            let mut closed = open.split_off(at).into_iter();
            let entry = closed.next().expect("the entry at `at`");
            for unclosed in closed {
                finish(&mut found, &unclosed, token.start);
            }
            finish(&mut found, &entry, token.start);
        } else if attributes.ends_with('/') {
            let entry = Open {
                name,
                start: token.start,
                open_end: token.end,
                attributes,
            };
            finish(&mut found, &entry, token.end);
        } else {
            open.push(Open {
                name,
                start: token.start,
                open_end: token.end,
                attributes,
            });
        }
    }
    for entry in &open {
        finish(&mut found, entry, xml.len());
    }
    found.sort_by_key(|element| element.start);
    found
}

/// The first start tag of the part's root element: `<(?![?!])([^\s/>]+)`.
fn root_name(xml: &str) -> Option<&str> {
    let mut at = 0;
    while let Some(found) = xml[at..].find('<') {
        let start = at + found + 1;
        at = start;
        if xml[start..].starts_with(['?', '!']) {
            continue;
        }
        let length = xml[start..]
            .find(|c: char| is_js_space(c) || matches!(c, '/' | '>'))
            .unwrap_or(xml.len() - start);
        if length > 0 {
            return Some(&xml[start..start + length]);
        }
    }
    None
}

/// The elements `xml_elements` finds that are written with the prefix of the
/// part's root element (none, for a part that binds its namespace as the
/// default): an element of another namespace that happens to share the local
/// name is not the one meant.
pub(crate) fn root_namespace_elements(xml: &str, local: &str) -> Vec<XmlElement> {
    let prefix = root_name(xml).map_or("", prefix_of);
    xml_elements(xml, local)
        .into_iter()
        .filter(|element| prefix_of(&element.name) == prefix)
        .collect()
}

/// What the element holds as text: entities decoded, CDATA sections as they
/// are, comments dropped (`TEXT_RUN`: `<!--…-->`, `<![CDATA[…]]>` or a run of
/// characters that are not `<`; a `<` of any other kind is passed over).
pub(crate) fn element_text(xml: &str, element: &XmlElement) -> String {
    let inner = xml.get(element.open_end..element.close_start).unwrap_or("");
    let mut text = String::new();
    let mut at = 0;
    while at < inner.len() {
        if inner[at..].starts_with('<') {
            let rest = &inner[at..];
            let held = (rest.starts_with("<!--") || rest.starts_with("<![CDATA["))
                .then(|| skipped_at(inner, at))
                .flatten();
            match held {
                Some(Token {
                    end,
                    markup: Markup::Skipped { cdata },
                    ..
                }) => {
                    text.push_str(cdata.unwrap_or_default());
                    at = end;
                }
                _ => at += 1,
            }
        } else {
            let run = inner[at..].find('<').unwrap_or(inner.len() - at);
            text.push_str(&decode_xml_entities(&inner[at..at + run]));
            at += run;
        }
    }
    text
}
