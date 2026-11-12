//! XML escaping and parse-tree helpers (packages/pptx-engine/src/xml-utils.ts).

use std::borrow::Cow;
use std::sync::LazyLock;

use jscompat::{
    Radix, RegexError, TryJsRegex, js_regex, parse_float, parse_int, to_number, trim,
    value_to_string, value_truthy,
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

/// Numeric character references decoded where they name a Unicode scalar
/// value; any other is kept as written.
pub fn decode_numeric_char_refs(text: &str) -> String {
    js_regex!(r"&#(?:x([0-9a-fA-F]+)|(\d+));").replace_all(text, |reference| {
        let code = match reference.get(1) {
            None => to_number(reference.get(2).unwrap_or_default()),
            Some(hex) => parse_int(hex, Radix::Sixteen),
        };
        if code <= 1_114_111.0
            && !(55_296.0..=57_343.0).contains(&code)
            && let Some(ch) = char::from_u32(code as u32)
        {
            return ch.to_string();
        }
        reference.as_str().to_owned()
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
/// either quote. A number: a run of digits past 2^53 rounds, and past 1e308
/// is Infinity.
pub fn max_relationship_id_number(rels_xml: &str) -> f64 {
    let mut max = 0.0;
    for found in js_regex!(r#"\bId\s*=\s*(["'])rId(\d+)\1"#).find_iter(rels_xml) {
        let n = to_number(found.get(2).unwrap_or_default());
        if n > max {
            max = n;
        }
    }
    max
}

/// Whether [Content_Types].xml already declares an Override for the part,
/// the PartName attribute read with either quote.
pub fn has_content_type_override(content_types: &str, part_path: &str) -> bool {
    let wanted = format!("/{part_path}");
    js_regex!(r#"\bPartName\s*=\s*(["'])(.*?)\1"#)
        .find_iter(content_types)
        .any(|found| found.get(2) == Some(wanted.as_str()))
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

/// Any `<Default>` already declaring this extension, whatever its attribute
/// order or quoting. `ext` is pasted into the pattern unescaped, so it can be
/// a pattern that does not compile: that throws, as `new RegExp` does.
pub fn has_default_for(ct: &str, ext: &str) -> Result<bool, RegexError> {
    let re = TryJsRegex::new(&format!(r#"\bExtension\s*=\s*(["']){ext}\1"#), "")?;
    for tag in js_regex!(r"<Default\b[^>]*\/?>").find_iter(ct) {
        if re.try_test(tag.as_str())? {
            return Ok(true);
        }
    }
    Ok(false)
}
