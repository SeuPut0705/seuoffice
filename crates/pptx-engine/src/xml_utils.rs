//! XML escaping and parse-tree helpers (packages/pptx-engine/src/xml-utils.ts).

use std::borrow::Cow;
use std::sync::LazyLock;

use jscompat::{
    JsMap, Radix, js_regex, parse_float, parse_int, to_number, trim, try_js_regex, value_to_string,
    value_truthy,
};
use serde_json::{Map, Value};

static EMPTY_NODE: LazyLock<Value> = LazyLock::new(|| Value::Object(Map::new()));

/// `asXmlNode`: a parse-tree value as an element node; what is not an object
/// reads as an empty node. An array is an object to JavaScript and passes as
/// it is. `None` is `undefined`.
pub fn as_xml_node(v: Option<&Value>) -> &Value {
    match v {
        Some(node @ (Value::Object(_) | Value::Array(_))) => node,
        _ => &EMPTY_NODE,
    }
}

/// `xmlArray`: fast-xml-parser's single-child collapse undone, always a list
/// of element nodes.
pub fn xml_array(v: Option<&Value>) -> impl Iterator<Item = &Value> {
    let (items, single) = match v {
        Some(Value::Array(items)) => (items.as_slice(), None),
        Some(v) if value_truthy(Some(v)) => (&[][..], Some(as_xml_node(Some(v)))),
        _ => (&[][..], None),
    };
    items
        .iter()
        .map(|item| as_xml_node(Some(item)))
        .chain(single)
}

/// Where the first element of `element_range` lies: byte offsets into the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementRange {
    pub start: usize,
    pub end: usize,
    pub content_start: usize,
    pub content_end: usize,
}

/// `decodeXml`: the five predefined entities and the numeric references, in one
/// pass. A reference to NUL or a C0 control XML 1.0 forbids is dropped; one that
/// names no Unicode scalar value stays as written.
pub fn decode_xml(raw: &str) -> String {
    decoded(raw).into_owned()
}

/// The decoder `xmlParser` installs (`ENTITY_DECODER.decode`); the second
/// argument (the declared XML version) plays no part.
pub fn decode_xml_cow(raw: &str, _xml_1_1: bool) -> Cow<'_, str> {
    decoded(raw)
}

fn decoded(raw: &str) -> Cow<'_, str> {
    if !raw.contains('&') {
        return Cow::Borrowed(raw);
    }
    Cow::Owned(
        js_regex!(r"&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));").replace_all(
            raw,
            |reference| {
                if let Some(named) = reference.get(3) {
                    return match named {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        _ => "'",
                    }
                    .to_owned();
                }
                let code = match reference.get(1) {
                    Some(hex) => parse_int(hex, Radix::Sixteen),
                    None => to_number(reference.get(2).unwrap_or_default()),
                };
                if code > 1_114_111.0 || (55_296.0..=57_343.0).contains(&code) {
                    return reference.as_str().to_owned();
                }
                if code < 32.0 && code != 9.0 && code != 10.0 && code != 13.0 {
                    return String::new();
                }
                char::from_u32(code as u32)
                    .map(String::from)
                    .unwrap_or_else(|| reference.as_str().to_owned())
            },
        ),
    )
}

/// `parseObject` with the engine's entity decoder: every `new XMLParser(...)`
/// of the engine is `xmlParser(...)`.
pub fn xml_parse_object(
    xml: &str,
    options: &ooxml_xml::ObjectOptions<'_>,
) -> Result<Value, ooxml_xml::ParseError> {
    ooxml_xml::parse_object_with(xml, options, decode_xml_cow)
}

/// `attributeOf`: the decoded value of attribute `name` in the open tag of
/// `element`, whatever its quotes and spacing.
pub fn attribute_of(element: &str, name: &str) -> Option<String> {
    let open_tag = match element.find('>') {
        Some(at) => element.get(..=at).unwrap_or_default(),
        None => "",
    };
    for attr in js_regex!(r#"\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).find_iter(open_tag) {
        if attr.get(1) == Some(name) {
            return Some(decode_xml(
                attr.get(2).or_else(|| attr.get(3)).unwrap_or_default(),
            ));
        }
    }
    None
}

/// `rootPrefixOf`: the prefix, with its colon, under which the root element
/// binds namespace `ns` (`""` for a default binding); `None` when it binds none.
pub fn root_prefix_of(xml: &str, ns: &str) -> Result<Option<String>, String> {
    let Some(root) = try_js_regex!(r#"<(?![?!])(?:[^>"']|"[^"]*"|'[^']*')*>"#)
        .try_exec(xml)
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let root = root.as_str();
    let own = js_regex!(r"^<([^\s/>:]+:)?")
        .exec(root)
        .and_then(|m| m.get(1))
        .unwrap_or_default();
    let mut found: Option<String> = None;
    for attr in js_regex!(r#"\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).find_iter(root) {
        let name = attr.get(1).unwrap_or_default();
        if name != "xmlns" && !name.starts_with("xmlns:") {
            continue;
        }
        if decode_xml(attr.get(2).or_else(|| attr.get(3)).unwrap_or_default()) != ns {
            continue;
        }
        let prefix = if name == "xmlns" {
            String::new()
        } else {
            format!("{}:", name.get("xmlns:".len()..).unwrap_or_default())
        };
        if prefix == own {
            return Ok(Some(prefix));
        }
        if found.is_none() {
            found = Some(prefix);
        }
    }
    Ok(found)
}

/// `elementRange`: where the first element named `name` at or after `from`
/// lies: its open tag through its close tag, or its empty tag. `None` when
/// there is none, or it is not closed.
pub fn element_range(xml: &str, name: &str, from: usize) -> Result<Option<ElementRange>, String> {
    let tags = try_js_regex!(r#"<(\/?)([^\s/>!?]+)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>"#);
    let mut start: Option<usize> = None;
    let mut content_start = 0;
    let mut depth: i64 = 0;
    // the pattern starts at `<` and reads nothing behind it, so a search of the
    // tail is `lastIndex = from`; offsets are shifted back by `from`
    let Some(tail) = xml.get(from..) else {
        return Ok(None);
    };
    for tag in tags.try_find_iter(tail) {
        let tag = tag.map_err(|e| e.to_string())?;
        if tag.get(2) != Some(name) {
            continue;
        }
        let end = from + tag.end();
        if tag.get(1).is_some_and(|slash| !slash.is_empty()) {
            if let Some(start) = start {
                depth -= 1;
                if depth == 0 {
                    return Ok(Some(ElementRange {
                        start,
                        end,
                        content_start,
                        content_end: from + tag.start(),
                    }));
                }
            }
        } else if tag.get(3).is_some_and(|slash| !slash.is_empty()) {
            if start.is_none() {
                return Ok(Some(ElementRange {
                    start: from + tag.start(),
                    end,
                    content_start: end,
                    content_end: end,
                }));
            }
        } else {
            if start.is_none() {
                start = Some(from + tag.start());
                content_start = end;
            }
            depth += 1;
        }
    }
    Ok(None)
}

/// `cSldNameOf`: the name a slide, layout or master part gives itself.
pub fn c_sld_name_of(part_xml: &str) -> Option<String> {
    let c_sld = js_regex!(r"<p:cSld\b[^>]*>").exec(part_xml)?;
    attribute_of(c_sld.as_str(), "name")
}

/// `canonicalXml`: a part's XML in the one spelling the engine's patchers look
/// for: no comments, no CDATA sections (their text escaped instead) and no white
/// space before the `>` of an end tag.
///
/// Reading and saving search the XML text for `</a:r>`, `</a:p>`, `</p:txBody>`
/// and the like. A comment or a CDATA section can hold those very words, and
/// `</a:p >` is the end tag `</a:p>` as XML reads it, so a search that looked
/// for one spelling cut a run or a paragraph in the wrong place. Applied once
/// where a slide is read. What XML reads is unchanged.
pub fn canonical_xml(xml: &str) -> Result<Cow<'_, str>, String> {
    if !js_regex!(r"<!--|<!\[CDATA\[|<\/[^>]*\s>").test(xml) {
        return Ok(Cow::Borrowed(xml));
    }
    // a comment, a CDATA section, or any tag (quote-aware, so a `>` inside a
    // value ends nothing)
    try_js_regex!(r#"<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>"#)
        .try_replace_all(xml, |markup| {
            let text = markup.as_str();
            if text.starts_with("<!--") {
                return String::new();
            }
            if let Some(cdata) = markup.get(1) {
                return escape_xml_text(cdata);
            }
            if !text.starts_with("</") {
                return text.to_owned();
            }
            match js_regex!(r"\s+>$").exec(text) {
                Some(space) => format!("{}>", &text[..space.start()]),
                None => text.to_owned(),
            }
        })
        .map(Cow::Owned)
        .map_err(|error| error.to_string())
}

/// `withRelationshipIds`: each `r:<name>` reference (for `names`) whose id is a
/// key of `ids` re-pointed at the id it maps to, in one pass.
pub fn with_relationship_ids(xml: &str, names: &[&str], ids: &JsMap<String>) -> String {
    if ids.is_empty() {
        return xml.to_owned();
    }
    js_regex!(r#"\br:(\w+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')"#).replace_all(xml, |m| {
        let name = m.get(1).unwrap_or_default();
        let double = m.get(3);
        let single = m.get(4);
        let to = if names.contains(&name) {
            ids.get(&decode_xml(double.or(single).unwrap_or_default()))
        } else {
            None
        };
        let Some(to) = to else {
            return m.as_str().to_owned();
        };
        let value = escape_xml_attr(to);
        let equals = m.get(2).unwrap_or_default();
        if double.is_none() {
            format!("r:{name}{equals}'{}'", value.replace('\'', "&apos;"))
        } else {
            format!("r:{name}{equals}\"{value}\"")
        }
    })
}

/// `percentFraction`: an ST_Percentage as a fraction of one. The schema form is
/// an integer in 1/1000 % ("50000"); Google Slides writes the suffixed form
/// ("50%"). `None` for a missing or non-numeric value.
pub fn percent_fraction(raw: Option<&Value>) -> Option<f64> {
    let raw = raw.filter(|v| !v.is_null())?;
    let text = value_to_string(Some(raw));
    let text = trim(&text);
    let n = parse_float(text);
    if !n.is_finite() {
        return None;
    }
    Some(if text.ends_with('%') {
        n / 100.0
    } else {
        n / 100_000.0
    })
}

/// XML 1.0 forbids C0 controls (minus tab, LF, CR), U+FFFE, U+FFFF and lone
/// surrogates even when escaped. VT and FF degrade to a space; the rest drop.
fn sanitize_xml_chars(text: &str) -> Cow<'_, str> {
    let invalid = js_regex!(
        r"[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}",
        "u"
    );
    if !invalid.test(text) {
        return Cow::Borrowed(text);
    }
    Cow::Owned(invalid.replace_all(text, |ch| {
        if matches!(ch.as_str(), "\u{000B}" | "\u{000C}") {
            " ".to_owned()
        } else {
            String::new()
        }
    }))
}

pub fn escape_xml_text(text: &str) -> String {
    sanitize_xml_chars(text)
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn escape_xml_attr(text: &str) -> String {
    escape_xml_text(text).replace('"', "&quot;")
}

/// Highest rIdN already present in a .rels part, the Id attribute read with
/// either quote and decoded. A number: a run of digits past 2^53 rounds, and
/// past 1e308 is Infinity.
pub fn max_relationship_id_number(rels_xml: &str) -> f64 {
    let mut max = 0.0;
    for found in js_regex!(r#"\bId\s*=\s*(?:"([^"]*)"|'([^']*)')"#).find_iter(rels_xml) {
        let id = decode_xml(found.get(1).or_else(|| found.get(2)).unwrap_or_default());
        let n = js_regex!(r"^rId(\d+)$")
            .exec(&id)
            .and_then(|m| m.get(1))
            .map_or(0.0, to_number);
        if n > max {
            max = n;
        }
    }
    max
}

/// Whether [Content_Types].xml already declares an Override for the part, the
/// PartName attribute read with either quote and decoded.
pub fn has_content_type_override(content_types: &str, part_path: &str) -> bool {
    let wanted = format!("/{part_path}");
    js_regex!(r"<Override\b[^>]*>")
        .find_iter(content_types)
        .any(|tag| attribute_of(tag.as_str(), "PartName").as_deref() == Some(wanted.as_str()))
}

/// `creationIdExtXml`: the a16:creationId extension of a newborn
/// `<p:cNvPr>`. `uuid` is what `crypto.randomUUID()` returned; the host
/// supplies it, the engine draws no randomness.
pub fn creation_id_ext_xml(uuid: &str) -> String {
    format!(
        "<a:ext uri=\"{{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}}\">\
         <a16:creationId xmlns:a16=\"http://schemas.microsoft.com/office/drawing/2014/main\" id=\"{{{}}}\"/>\
         </a:ext>",
        uuid.to_uppercase()
    )
}

pub fn creation_id_xml(uuid: &str) -> String {
    format!("<a:extLst>{}</a:extLst>", creation_id_ext_xml(uuid))
}

/// The content type [Content_Types].xml declares by default for this
/// extension (compared without regard to case); `None` when it declares none.
pub fn default_content_type_for(ct: &str, ext: &str) -> Option<String> {
    let wanted = ext.to_lowercase();
    for tag in js_regex!(r"<Default\b[^>]*\/?>").find_iter(ct) {
        if attribute_of(tag.as_str(), "Extension").map(|e| e.to_lowercase()) == Some(wanted.clone())
        {
            return Some(attribute_of(tag.as_str(), "ContentType").unwrap_or_default());
        }
    }
    None
}

/// Any `<Default>` already declaring this extension.
pub fn has_default_for(ct: &str, ext: &str) -> bool {
    default_content_type_for(ct, ext).is_some()
}
