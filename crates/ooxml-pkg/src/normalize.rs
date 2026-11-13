//! Port of packages/docx-engine/src/ooxml-normalize.ts.
//!
//! ISO Strict OOXML (purl.oclc.org URIs) and non-canonical namespace prefixes
//! are rewritten to the transitional URIs and the canonical prefixes the rest
//! of the engine matches literally. It runs once per XML part at load, so the
//! parser's offsets and the saved output see the same text.

use std::borrow::Cow;

use jscompat::{
    JsRegex, RegexLimit, is_js_space, js_regex, math_round, number_to_string, parse_float,
    try_js_regex,
};

const S: &str = "http://purl.oclc.org/ooxml/";

/// ISO 29500 Strict namespace and its transitional equivalent.
const STRICT_TO_TRANSITIONAL: [(&str, &str); 19] = [
    (
        "http://purl.oclc.org/ooxml/wordprocessingml/main",
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    ),
    (
        "http://purl.oclc.org/ooxml/officeDocument/relationships",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    ),
    (
        "http://purl.oclc.org/ooxml/officeDocument/math",
        "http://schemas.openxmlformats.org/officeDocument/2006/math",
    ),
    (
        "http://purl.oclc.org/ooxml/officeDocument/extendedProperties",
        "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
    ),
    (
        "http://purl.oclc.org/ooxml/officeDocument/customProperties",
        "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
    ),
    (
        "http://purl.oclc.org/ooxml/officeDocument/docPropsVTypes",
        "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
    ),
    (
        "http://purl.oclc.org/ooxml/officeDocument/bibliography",
        "http://schemas.openxmlformats.org/officeDocument/2006/bibliography",
    ),
    (
        "http://purl.oclc.org/ooxml/officeDocument/characteristics",
        "http://schemas.openxmlformats.org/officeDocument/2006/characteristics",
    ),
    (
        "http://purl.oclc.org/ooxml/officeDocument/customXml",
        "http://schemas.openxmlformats.org/officeDocument/2006/customXml",
    ),
    (
        "http://purl.oclc.org/ooxml/schemaLibrary/main",
        "http://schemas.openxmlformats.org/schemaLibrary/2006/main",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/main",
        "http://schemas.openxmlformats.org/drawingml/2006/main",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing",
        "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing",
        "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/picture",
        "http://schemas.openxmlformats.org/drawingml/2006/picture",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/chart",
        "http://schemas.openxmlformats.org/drawingml/2006/chart",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/chartDrawing",
        "http://schemas.openxmlformats.org/drawingml/2006/chartDrawing",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/diagram",
        "http://schemas.openxmlformats.org/drawingml/2006/diagram",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/lockedCanvas",
        "http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas",
    ),
    (
        "http://purl.oclc.org/ooxml/drawingml/compatibility",
        "http://schemas.openxmlformats.org/drawingml/2006/compatibility",
    ),
];

const STRICT_REL_BASE: &str = "http://purl.oclc.org/ooxml/officeDocument/relationships/";
const TRANSITIONAL_REL_BASE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

const W_URI: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A_URI: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP_URI: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const WPS_URI: &str = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
const MC_URI: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/// The prefix the engine matches literally for a transitional namespace URI.
/// A binding of one of these URIs to another prefix is renamed: by URI, never
/// by local name alone.
fn canonical_prefix(uri: &str) -> Option<&'static str> {
    Some(match uri {
        W_URI => "w",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships" => "r",
        "http://schemas.openxmlformats.org/officeDocument/2006/math" => "m",
        A_URI => "a",
        WP_URI => "wp",
        "http://schemas.openxmlformats.org/drawingml/2006/picture" => "pic",
        "http://schemas.openxmlformats.org/drawingml/2006/chart" => "c",
        "http://schemas.openxmlformats.org/drawingml/2006/diagram" => "dgm",
        "http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas" => "lc",
        MC_URI => "mc",
        WPS_URI => "wps",
        "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" => "wpg",
        "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" => "wpc",
        "http://schemas.microsoft.com/office/word/2010/wordml" => "w14",
        "http://schemas.microsoft.com/office/word/2012/wordml" => "w15",
        "urn:schemas-microsoft-com:vml" => "v",
        "urn:schemas-microsoft-com:office:office" => "o",
        "urn:schemas-microsoft-com:office:word" => "w10",
        _ => return None,
    })
}

// Strict "universal measures" ("612pt", "2.54cm") become the plain number of
// the unit each attribute is typed with: target units per point.
const TWIPS: f64 = 20.0;
const HALF_POINTS: f64 = 2.0;
const EIGHTH_POINTS: f64 = 8.0;
const POINTS: f64 = 1.0;

fn points_per_unit(unit: &str) -> f64 {
    match unit {
        "pt" => 1.0,
        "in" => 72.0,
        "pc" | "pi" => 12.0,
        "cm" => 72.0 / 2.54,
        _ => 72.0 / 25.4,
    }
}

type AttrFactors = &'static [(&'static str, f64)];

const MARGIN_OR_BORDER: AttrFactors = &[("w", TWIPS), ("sz", EIGHTH_POINTS), ("space", POINTS)];
const VAL_HALF_POINTS: AttrFactors = &[("val", HALF_POINTS)];
const W_TWIPS: AttrFactors = &[("w", TWIPS)];

/// Element local name (w: namespace only) to its measured attributes.
fn measure_attrs(local: &str) -> Option<AttrFactors> {
    Some(match local {
        "pgSz" => &[("w", TWIPS), ("h", TWIPS)],
        "pgMar" => &[
            ("top", TWIPS),
            ("right", TWIPS),
            ("bottom", TWIPS),
            ("left", TWIPS),
            ("header", TWIPS),
            ("footer", TWIPS),
            ("gutter", TWIPS),
        ],
        "ind" => &[
            ("left", TWIPS),
            ("right", TWIPS),
            ("start", TWIPS),
            ("end", TWIPS),
            ("firstLine", TWIPS),
            ("hanging", TWIPS),
        ],
        "spacing" => &[
            ("before", TWIPS),
            ("after", TWIPS),
            ("line", TWIPS),
            ("val", TWIPS),
        ],
        "tab" => &[("pos", TWIPS)],
        "defaultTabStop" | "trHeight" => &[("val", TWIPS)],
        "cols" => &[("space", TWIPS)],
        "col" => &[("w", TWIPS), ("space", TWIPS)],
        "tblInd" | "tblW" | "tcW" | "tblCellSpacing" => W_TWIPS,
        "object" => &[("dxaOrig", TWIPS), ("dyaOrig", TWIPS)],
        "framePr" => &[
            ("w", TWIPS),
            ("h", TWIPS),
            ("x", TWIPS),
            ("y", TWIPS),
            ("hSpace", TWIPS),
            ("vSpace", TWIPS),
        ],
        "tblpPr" => &[
            ("leftFromText", TWIPS),
            ("rightFromText", TWIPS),
            ("topFromText", TWIPS),
            ("bottomFromText", TWIPS),
            ("tblpX", TWIPS),
            ("tblpY", TWIPS),
        ],
        "sz" | "szCs" | "kern" | "position" | "hps" | "hpsRaise" | "hpsBaseText" => VAL_HALF_POINTS,
        // cell margins (w) and borders (sz, space) share these element names
        "top" | "bottom" | "left" | "right" | "start" | "end" | "between" | "bar" | "insideH"
        | "insideV" | "tl2br" | "tr2bl" => MARGIN_OR_BORDER,
        _ => return None,
    })
}

fn convert_measure(value: &str, factor: f64) -> Option<String> {
    let found = js_regex!(r"^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$").exec(value)?;
    // a hostile "9".repeat(400) + "in" overflows to Infinity: keep the original
    let converted = parse_float(found.get(1).unwrap_or(""))
        * points_per_unit(found.get(2).unwrap_or(""))
        * factor;
    converted
        .is_finite()
        .then(|| number_to_string(math_round(converted)))
}

fn map_uri_value(value: &str) -> Option<String> {
    if let Some((_, transitional)) = STRICT_TO_TRANSITIONAL
        .iter()
        .find(|(strict, _)| *strict == value)
    {
        return Some((*transitional).to_owned());
    }
    let tail = value.strip_prefix(STRICT_REL_BASE)?;
    // the two relationship tails that differ between the families
    let tail = match tail {
        "extendedProperties" => "extended-properties",
        "customProperties" => "custom-properties",
        other => other,
    };
    Some(format!("{TRANSITIONAL_REL_BASE}{tail}"))
}

fn xmlns_decl() -> &'static JsRegex {
    js_regex!(r#"xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(["'])([^"']*)\2"#)
}

/// `hasUniversalMeasures`: a `w:` attribute holding a measure with a unit.
pub fn has_universal_measures(xml: &str) -> bool {
    js_regex!(r#"\sw:[A-Za-z]+="-?\d+(?:\.\d+)?(?:mm|cm|in|pt|pc|pi)""#).test(xml)
}

/// Cheap pre-check: `normalize_ooxml_xml` is only worth calling when this is true.
pub fn needs_ooxml_normalization(xml: &str) -> bool {
    if xml.contains(S) {
        return true;
    }
    if has_universal_measures(xml) {
        return true;
    }
    xmlns_decl().find_iter(xml).any(|found| {
        canonical_prefix(found.get(3).unwrap_or(""))
            .is_some_and(|canonical| canonical != found.get(1).unwrap_or(""))
    })
}

/// `canonicalXmlSyntax`: for a reader that only reads, the text with the
/// spellings a pattern cannot follow written the usual way. Comments and
/// processing instructions (but the XML declaration) go, a CDATA section
/// becomes the same text escaped, an end tag has no white space before its
/// `>`, and a start tag's attributes are `name="value"`: double quotes, no
/// white space around `=`, a `>` in a value written `&gt;`. Text written the
/// usual way comes back as it was.
///
/// The TypeScript finds the tokens with one regular expression
/// (`SYNTAX_TOKEN_RE`); this reads them in the order it tries them, with the
/// same answers, and has no bound that a long tag could pass.
pub fn canonical_xml_syntax(xml: &str) -> Cow<'_, str> {
    let mut out: Option<String> = None;
    let (mut copied, mut at) = (0, 0);
    while let Some(found) = xml[at..].find('<') {
        let start = at + found;
        let Some((end, replacement)) = syntax_token(xml, start) else {
            at = start + 1;
            continue;
        };
        if let Some(replacement) = replacement {
            let out = out.get_or_insert_with(|| String::with_capacity(xml.len()));
            out.push_str(&xml[copied..start]);
            out.push_str(&replacement);
            copied = end;
        }
        at = end;
    }
    match out {
        Some(mut out) => {
            out.push_str(&xml[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(xml),
    }
}

/// The token of `SYNTAX_TOKEN_RE` that starts at the `<` at byte `start`: its
/// end and what replaces it (`None`: it is kept as it is).
fn syntax_token(xml: &str, start: usize) -> Option<(usize, Option<String>)> {
    let rest = &xml[start..];
    if let Some(body) = rest.strip_prefix("<!--") {
        let close = body.find("-->")?;
        return Some((start + 4 + close + 3, Some(String::new())));
    }
    if let Some(body) = rest.strip_prefix("<![CDATA[") {
        let close = body.find("]]>")?;
        let text = body[..close]
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        return Some((start + 9 + close + 3, Some(text)));
    }
    if let Some(body) = rest.strip_prefix("<?") {
        let close = body.find("?>")?;
        let declaration = body[..close]
            .strip_prefix("xml")
            .and_then(|after| after.chars().next())
            .is_some_and(is_js_space);
        return Some((start + 2 + close + 2, (!declaration).then(String::new)));
    }
    if let Some(body) = rest.strip_prefix("</") {
        let name_len = body
            .find(|c: char| is_js_space(c) || c == '>')
            .filter(|&len| len > 0)?;
        let after_name = &body[name_len..];
        let spaces = after_name.len() - after_name.trim_start_matches(is_js_space).len();
        if spaces == 0 || !after_name[spaces..].starts_with('>') {
            return None;
        }
        let end = start + 2 + name_len + spaces + 1;
        return Some((end, Some(format!("</{}>", &body[..name_len]))));
    }
    if !rest[1..].starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        return None;
    }
    start_tag_token(xml, start)
}

/// The byte of the `>` that ends the attribute text starting at `from`: a
/// quoted value is read whole, `None` when a quote is never closed or no `>`
/// follows.
fn attributes_end(xml: &str, from: usize) -> Option<usize> {
    let bytes = xml.as_bytes();
    let mut at = from;
    while at < bytes.len() {
        match bytes[at] {
            b'>' => return Some(at),
            quote @ (b'"' | b'\'') => {
                at += 1 + xml[at + 1..].bytes().position(|byte| byte == quote)? + 1;
            }
            _ => at += 1,
        }
    }
    None
}

/// `<([A-Za-z_][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>` at `start`, with the
/// name as long as the attributes allow: a name holding a quote may end
/// before it so that the quote opens a value.
fn start_tag_token(xml: &str, start: usize) -> Option<(usize, Option<String>)> {
    let name_from = start + 2;
    let longest = xml[name_from..]
        .find(|c: char| is_js_space(c) || c == '/' || c == '>')
        .map_or(xml.len(), |len| name_from + len);
    let last_quote = xml[name_from..longest]
        .rfind(['"', '\''])
        .map(|at| name_from + at);
    let ends = std::iter::once(longest).chain(
        last_quote
            .into_iter()
            .flat_map(|quote| (name_from..=quote).rev())
            .filter(|&at| xml.is_char_boundary(at)),
    );
    for name_end in ends {
        let Some(close) = attributes_end(xml, name_end) else {
            continue;
        };
        let name = &xml[start + 1..name_end];
        let attributes = &xml[name_end..close];
        let replacement = (!plain_attributes(attributes)).then(|| {
            let mut out = format!("<{name}");
            for (key, value) in attribute_pairs(attributes) {
                out.push_str(&format!(" {key}=\"{value}\""));
            }
            out.push_str(if attributes.trim_end_matches(is_js_space).ends_with('/') {
                "/>"
            } else {
                ">"
            });
            out
        });
        return Some((close + 1, replacement));
    }
    None
}

/// `PLAIN_ATTRS_RE`: `^(?:\s+[^\s=/>"']+="[^"<>]*")*\s*\/?$`
fn plain_attributes(attributes: &str) -> bool {
    let mut at = 0;
    while let Some(next) = plain_attribute(attributes, at) {
        at = next;
    }
    let rest = attributes[at..].trim_start_matches(is_js_space);
    rest.is_empty() || rest == "/"
}

/// One `\s+[^\s=/>"']+="[^"<>]*"` of `PLAIN_ATTRS_RE` at byte `at`: where it ends.
fn plain_attribute(attributes: &str, at: usize) -> Option<usize> {
    let rest = &attributes[at..];
    let name = rest.trim_start_matches(is_js_space);
    let spaces = rest.len() - name.len();
    if spaces == 0 {
        return None;
    }
    let name_len = name
        .find(|c: char| is_js_space(c) || matches!(c, '=' | '/' | '>' | '"' | '\''))
        .unwrap_or(name.len());
    let value = name[name_len..].strip_prefix("=\"")?;
    if name_len == 0 {
        return None;
    }
    let value_len = value.find(['"', '<', '>'])?;
    value[value_len..]
        .starts_with('"')
        .then_some(at + spaces + name_len + 2 + value_len + 1)
}

/// The matches of `ANY_ATTR_RE`, `([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')`,
/// over an attribute text, each as its name and its value written for a
/// double-quoted attribute.
fn attribute_pairs(attributes: &str) -> Vec<(&str, String)> {
    let is_name = |c: char| !(is_js_space(c) || matches!(c, '=' | '/' | '>'));
    let mut pairs = Vec::new();
    let mut at = 0;
    while let Some(c) = attributes[at..].chars().next() {
        if !is_name(c) {
            at += c.len_utf8();
            continue;
        }
        // every start inside one run of name characters reads the same tail
        let name_end = attributes[at..]
            .find(|c: char| !is_name(c))
            .map_or(attributes.len(), |len| at + len);
        match attribute_value(attributes, name_end) {
            Some((value, end)) => {
                pairs.push((&attributes[at..name_end], value));
                at = end;
            }
            None => at = name_end,
        }
    }
    pairs
}

/// `\s*=\s*(?:"([^"]*)"|'([^']*)')` at byte `at`: the value as a
/// double-quoted attribute holds it (`"` as `&quot;`, `>` as `&gt;`), and where the match ends.
fn attribute_value(attributes: &str, at: usize) -> Option<(String, usize)> {
    let after_name = attributes[at..].trim_start_matches(is_js_space);
    let after_equals = after_name
        .strip_prefix('=')?
        .trim_start_matches(is_js_space);
    let quote = after_equals
        .chars()
        .next()
        .filter(|c| matches!(c, '"' | '\''))?;
    let value = &after_equals[1..];
    let len = value.find(quote)?;
    let escaped = if quote == '"' {
        value[..len].replace('>', "&gt;")
    } else {
        value[..len].replace('"', "&quot;").replace('>', "&gt;")
    };
    Some((escaped, attributes.len() - value.len() + len + 1))
}

struct Attr {
    name: String,
    value: String,
}

struct Frame {
    /// The rewritten name to write for the matching end tag.
    name: String,
    scoped: bool,
    wsp_scope: bool,
}

/// A `Map<string, string>` of one scope: insertion order, last `set` wins.
type Scope = Vec<(String, String)>;

fn set(scope: &mut Scope, key: &str, value: &str) {
    match scope.iter_mut().find(|(existing, _)| existing == key) {
        Some(entry) => entry.1 = value.to_owned(),
        None => scope.push((key.to_owned(), value.to_owned())),
    }
}

/// Inner declarations shadow outer ones.
fn lookup<'a>(stack: &'a [Scope], key: &str) -> Option<&'a str> {
    stack.iter().rev().find_map(|scope| {
        scope
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| &**value)
    })
}

fn split_q_name(name: &str) -> (&str, &str) {
    name.split_once(':').unwrap_or(("", name))
}

fn is_xmlns(name: &str) -> bool {
    name == "xmlns" || name.starts_with("xmlns:")
}

pub fn normalize_ooxml_xml(xml: &str) -> String {
    // source prefix to transitional URI
    let mut bindings: Vec<Scope> = vec![Scope::new()];
    // source prefix to output prefix
    let mut renames: Vec<Scope> = vec![Scope::new()];
    // output prefix to transitional URI
    let mut out_bindings: Vec<Scope> = vec![Scope::new()];
    let mut frames: Vec<Frame> = Vec::new();
    let mut wsp_depth = 0i64;

    let bytes = xml.as_bytes();
    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0;
    while cursor < xml.len() {
        let Some(start) = xml[cursor..].find('<').map(|at| cursor + at) else {
            break;
        };
        out.push_str(&xml[cursor..start]);

        let rest = &xml[start..];
        let special_end = if rest.starts_with("<!--") {
            Some("-->")
        } else if rest.starts_with("<![CDATA[") {
            Some("]]>")
        } else if rest.starts_with("<?") {
            Some("?>")
        } else if rest.starts_with("<!") {
            Some(">")
        } else {
            None
        };
        if let Some(special_end) = special_end {
            let end = xml[start + 2..]
                .find(special_end)
                .map_or(xml.len(), |at| start + 2 + at + special_end.len());
            out.push_str(&xml[start..end]);
            cursor = end;
            continue;
        }

        // the tag end, with '>' allowed inside quoted attribute values
        let mut quote = 0u8;
        let mut end = start + 1;
        while end < bytes.len() {
            let byte = bytes[end];
            if quote != 0 {
                if byte == quote {
                    quote = 0;
                }
            } else if byte == b'"' || byte == b'\'' {
                quote = byte;
            } else if byte == b'>' {
                break;
            }
            end += 1;
        }
        if end >= bytes.len() {
            out.push_str(&xml[start..]);
            cursor = xml.len();
            continue;
        }
        let tag = &xml[start..=end];
        cursor = end + 1;

        if tag.starts_with("</") {
            match frames.pop() {
                Some(frame) => {
                    out.push_str("</");
                    out.push_str(&frame.name);
                    out.push('>');
                    if frame.scoped {
                        bindings.pop();
                        renames.pop();
                        out_bindings.pop();
                    }
                    if frame.wsp_scope {
                        wsp_depth -= 1;
                    }
                }
                None => out.push_str(tag),
            }
            continue;
        }

        let self_closing = js_regex!(r"\/\s*>$").test(tag);
        let name_match = js_regex!(r"^<\/?\s*([^\s/>]+)").exec(tag);
        let Some((name, name_end)) = name_match
            .as_ref()
            .and_then(|found| Some((found.get(1)?, found.end())))
        else {
            out.push_str(tag);
            continue;
        };
        let mut attrs: Vec<Attr> = js_regex!(r#"([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
            .find_from(tag, name_end)
            .map(|found| Attr {
                name: found.get(1).unwrap_or("").to_owned(),
                value: found.get(2).or(found.get(3)).unwrap_or("").to_owned(),
            })
            .collect();

        // namespace declarations open a scope; strict URIs map to transitional
        let mut new_bindings = Scope::new();
        // prefix to the index of its (last) declaration in `attrs`
        let mut decl_by_prefix: Vec<(String, usize)> = Vec::new();
        for (index, attr) in attrs.iter_mut().enumerate() {
            if !is_xmlns(&attr.name) {
                continue;
            }
            if let Some(mapped) = map_uri_value(&attr.value) {
                attr.value = mapped;
            }
            let decl_prefix = attr.name.strip_prefix("xmlns:").unwrap_or("");
            set(&mut new_bindings, decl_prefix, &attr.value);
            match decl_by_prefix
                .iter_mut()
                .find(|(prefix, _)| prefix == decl_prefix)
            {
                Some(entry) => entry.1 = index,
                None => decl_by_prefix.push((decl_prefix.to_owned(), index)),
            }
        }
        let mut scoped = false;
        if !new_bindings.is_empty() {
            scoped = true;
            bindings.push(new_bindings.clone());
            renames.push(Scope::new());
            out_bindings.push(Scope::new());
            let mut drop: Vec<usize> = Vec::new();
            let mut inject: Vec<Attr> = Vec::new();
            // declarations that keep their prefix claim it in the output
            // first, so a rename can neither steal it nor be blocked by a
            // prefix that is itself being renamed away
            for (prefix, uri) in &new_bindings {
                if canonical_prefix(uri).is_none_or(|canonical| canonical == prefix) {
                    set(out_bindings.last_mut().expect("pushed above"), prefix, uri);
                }
            }
            for (prefix, uri) in &new_bindings {
                let Some(canonical) = canonical_prefix(uri).filter(|canonical| canonical != prefix)
                else {
                    continue;
                };
                let bound = lookup(&out_bindings, canonical).map(str::to_owned);
                let new_out = out_bindings.last_mut().expect("pushed above");
                if bound.as_deref().is_some_and(|bound| bound != uri) {
                    // the canonical prefix is taken by another namespace
                    set(new_out, prefix, uri);
                    continue;
                }
                set(renames.last_mut().expect("pushed above"), prefix, canonical);
                // by captured index: finding by name could hit a declaration
                // whose name an earlier rename already rewrote to this prefix
                let decl = decl_by_prefix
                    .iter()
                    .find(|(declared, _)| declared == prefix)
                    .map(|(_, index)| *index)
                    .expect("every binding has a declaration");
                if bound.as_deref() == Some(&**uri) {
                    if !prefix.is_empty() {
                        drop.push(decl);
                    }
                } else if prefix.is_empty() {
                    // xmlns= stays for the other content
                    inject.push(Attr {
                        name: format!("xmlns:{canonical}"),
                        value: uri.clone(),
                    });
                } else {
                    attrs[decl].name = format!("xmlns:{canonical}");
                }
                set(new_out, canonical, uri);
                if prefix.is_empty() {
                    set(new_out, "", uri);
                }
            }
            if !drop.is_empty() || !inject.is_empty() {
                let mut index = 0;
                attrs.retain(|_| {
                    index += 1;
                    !drop.contains(&(index - 1))
                });
                attrs.extend(inject);
            }
        }

        let (prefix, local) = split_q_name(name);
        let element_uri = lookup(&bindings, prefix).map(str::to_owned);
        let element_uri = element_uri.as_deref();

        // Word 2013 strict writes wordprocessingShape children in the wp
        // namespace inside <a:graphicData uri="...wordprocessingShape">; the
        // engine matches wps:*, so those elements (only there) move to wps.
        let mut target_prefix = lookup(&renames, prefix).unwrap_or(prefix).to_owned();
        if wsp_depth > 0 && element_uri == Some(WP_URI) {
            target_prefix = "wps".to_owned();
            if lookup(&out_bindings, "wps") != Some(WPS_URI) {
                attrs.push(Attr {
                    name: "xmlns:wps".to_owned(),
                    value: WPS_URI.to_owned(),
                });
                if !scoped {
                    scoped = true;
                    bindings.push(Scope::new());
                    renames.push(Scope::new());
                    out_bindings.push(Scope::new());
                }
                set(
                    out_bindings.last_mut().expect("never empty"),
                    "wps",
                    WPS_URI,
                );
            }
        }
        let new_name = if target_prefix.is_empty() {
            local.to_owned()
        } else {
            format!("{target_prefix}:{local}")
        };

        let in_w_ns = element_uri == Some(W_URI);
        let factors = if in_w_ns { measure_attrs(local) } else { None };
        out.push('<');
        out.push_str(&new_name);
        for attr in &mut attrs {
            let (attr_prefix, attr_local) = split_q_name(&attr.name);
            let (attr_prefix, attr_local) = (attr_prefix.to_owned(), attr_local.to_owned());
            if !is_xmlns(&attr.name) {
                if in_w_ns && local == "document" && attr_local == "conformance" {
                    continue;
                }
                if !attr_prefix.is_empty() && attr_prefix != "xml" {
                    let renamed = lookup(&renames, &attr_prefix).unwrap_or(&attr_prefix);
                    if renamed != attr_prefix {
                        attr.name = format!("{renamed}:{attr_local}");
                    }
                }
                // MCE prefix lists must keep referring to the renamed prefixes
                let mce_list = if (attr_local == "Ignorable" || attr_local == "MustUnderstand")
                    && lookup(&bindings, &attr_prefix) == Some(MC_URI)
                {
                    true
                } else {
                    attr_local == "Requires"
                        && attr_prefix.is_empty()
                        && element_uri == Some(MC_URI)
                };
                if mce_list {
                    attr.value = js_regex!(r"\s+")
                        .split(&attr.value)
                        .into_iter()
                        .map(|listed| lookup(&renames, listed).unwrap_or(listed))
                        .collect::<Vec<_>>()
                        .join(" ");
                } else {
                    if let Some(mapped) = map_uri_value(&attr.value) {
                        attr.value = mapped;
                    }
                    let factor = factors.and_then(|factors| {
                        factors
                            .iter()
                            .find(|(measured, _)| *measured == attr_local)
                            .map(|(_, factor)| *factor)
                    });
                    if let Some(factor) = factor
                        && (attr_prefix.is_empty()
                            || lookup(&bindings, &attr_prefix) == Some(W_URI))
                        && let Some(converted) = convert_measure(&attr.value, factor)
                    {
                        attr.value = converted;
                    }
                }
            }
            out.push(' ');
            out.push_str(&attr.name);
            out.push_str("=\"");
            out.push_str(&attr.value.replace('"', "&quot;"));
            out.push('"');
        }
        out.push_str(if self_closing { "/>" } else { ">" });

        let wsp_scope = !self_closing
            && local == "graphicData"
            && element_uri == Some(A_URI)
            && attrs
                .iter()
                .any(|attr| attr.name == "uri" && attr.value == WPS_URI);
        if wsp_scope {
            wsp_depth += 1;
        }

        if self_closing {
            if scoped {
                bindings.pop();
                renames.pop();
                out_bindings.pop();
            }
        } else {
            frames.push(Frame {
                name: new_name,
                scoped,
                wsp_scope,
            });
        }
    }
    out.push_str(&xml[cursor..]);
    out
}

const DUP_STYLE_REF: &str = r"(?:<w:([pr])Style\b[^>]*\/>\s*)+(?=<w:\1Style\b[^>]*\/>)";

/// `hasDuplicateStyleRefs`: cheap pre-check, `dedupe_style_refs` is only worth
/// calling when this is true.
pub fn has_duplicate_style_refs(xml: &str) -> Result<bool, RegexLimit> {
    try_js_regex!(DUP_STYLE_REF, "g").try_test(xml)
}

/// `dedupeStyleRefs`: repeated `w:pStyle` / `w:rStyle` children of one
/// property set: Word applies the last one, so the earlier siblings are
/// dropped.
pub fn dedupe_style_refs(xml: &str) -> Result<String, RegexLimit> {
    try_js_regex!(DUP_STYLE_REF, "g").try_replace_all(xml, |_| String::new())
}
