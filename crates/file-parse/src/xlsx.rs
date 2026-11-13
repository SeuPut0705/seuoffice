//! packages/file-parse/src/xlsx.ts with the withheld cells of
//! packages/file-parse/src/xlsx-redaction.ts, and the gateway readers that
//! file calls: `readRedactionRecord`, `parseRedactionPart` and
//! `parseRedactionNameMirror` of xlsx-gateway `gateway/xlsx-redaction.ts`,
//! `parseSheetElements` of `gateway/xlsx-sheets.ts` and the element scanner
//! it reads with ([`crate::xlsx_xml_scan`]), `offsetFormulaRefs` of
//! `domain/formula-shift.ts`, `parseAddress` and `columnIndex` of
//! `domain/cell-address.ts`, `decodeXlsxEscapes` of `gateway/xlsx-escapes.ts`.
//! The cells that compute from a withheld cell are
//! `xlsx-formula-redaction.ts` ([`crate::xlsx_formula_redaction`]), which reads
//! the formulas as `formula-reads.ts` ([`crate::xlsx_formula_reads`]) lists them.
//!
//! Every part goes through one fast-xml-parser 5.10.1 option set, the one
//! `manifestParser` of pptx.ts also uses: [`fxp`] gives the object it returns.

use jscompat::{JsMap, RegexLimit, js_regex, number_to_string, to_number, trim, try_js_regex};
use ooxml_pkg::{Package, load_zip_package};
use serde_json::Value;

use crate::opc::resolve_target;
use crate::redaction::{redaction_error, sanitize_label};
use crate::xlsx_dates::{
    DateFormatParts, builtin_date_format, classify_format_code, format_serial,
};
use crate::xlsx_formula_reads::{NameDefinition, RangeBounds};
use crate::xlsx_formula_redaction::{
    DerivedInput, DerivedSheet, FORMULA_SCAN_MAX_BYTES, PivotOutput, pivot_output_of,
    read_derived_cells,
};
use crate::xlsx_xml_scan::{element_text, root_namespace_elements};

use fxp::JVal;

/// `new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_',
/// trimValues: false, parseTagValue: false, removeNSPrefix: false,
/// transformTagName: stripNamespacePrefix, attributeValueProcessor })` without
/// `preserveOrder`: the object `parse` returns. The processor trims every
/// attribute value but the `name` of a workbook's `<sheet>`.
mod fxp {
    use jscompat::{JsObject, is_js_space, js_regex, trim, trim_start};
    use ooxml_xml::{AttributeMode, ParseError, XNode, parse_ordered_with_attributes};

    /// The parser's default `maxNestedTags`.
    const MAX_NESTED_TAGS: usize = 100;

    /// An element's name as the parser gives it, and whether the attribute
    /// value processor leaves its `name` attribute as written.
    struct ElementName {
        name: String,
        keeps_name: bool,
    }

    /// A value of the object the parser returns.
    pub enum JVal {
        Str(String),
        Arr(Vec<JVal>),
        Obj(JsObject<JVal>),
    }

    /// `String(value)`
    pub fn js_string(value: &JVal) -> String {
        match value {
            JVal::Str(text) => text.clone(),
            JVal::Arr(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
            JVal::Obj(_) => "[object Object]".to_owned(),
        }
    }

    fn strip_namespace_prefix(name: &str) -> &str {
        name.find(':')
            .map_or(name, |separator| &name[separator + 1..])
    }

    fn reserved_message(name: &str) -> String {
        format!(
            "[SECURITY] Invalid name: \"{name}\" is a reserved JavaScript keyword that could cause prototype pollution"
        )
    }

    /// `sanitizeName` with the default `onDangerousProperty`.
    fn sanitize_name(name: &str) -> Result<String, String> {
        if matches!(name, "__proto__" | "constructor" | "prototype") {
            return Err(reserved_message(name));
        }
        if matches!(
            name,
            "hasOwnProperty"
                | "toString"
                | "valueOf"
                | "__defineGetter__"
                | "__defineSetter__"
                | "__lookupGetter__"
                | "__lookupSetter__"
        ) {
            return Ok(format!("__{name}"));
        }
        Ok(name.to_owned())
    }

    fn type_error(property: &str) -> String {
        format!("Cannot read properties of undefined (reading '{property}')")
    }

    /// `xmlData.replace(/\r\n?/g, "\n")`
    fn normalize_newlines(xml: &str) -> String {
        let mut out = String::with_capacity(xml.len());
        let mut rest = xml;
        while let Some(at) = rest.find('\r') {
            out.push_str(&rest[..at]);
            out.push('\n');
            rest = &rest[at + 1..];
            rest = rest.strip_prefix('\n').unwrap_or(rest);
        }
        out.push_str(rest);
        out
    }

    fn find_from(text: &str, needle: &str, from: usize) -> Option<usize> {
        text.get(from..)?.find(needle).map(|at| from + at)
    }

    /// `tagExpWithClosingIndex`: where the first `closing` outside quotes starts.
    fn tag_end(source: &str, from: usize, closing: &[u8]) -> Option<usize> {
        let bytes = source.as_bytes();
        let mut quote = 0u8;
        for index in from..bytes.len() {
            let byte = bytes[index];
            if quote != 0 {
                if byte == quote {
                    quote = 0;
                }
            } else if byte == b'"' || byte == b'\'' {
                quote = byte;
            } else if bytes[index..].starts_with(closing) {
                return Some(index);
            }
        }
        None
    }

    /// What the parser throws when an opening tag never closes. The context is
    /// cut in UTF-16 units, so it can split a surrogate pair a Rust string
    /// cannot hold.
    fn unclosed_tag_message(source: &str, at: usize) -> String {
        let position = source[..at].encode_utf16().count();
        let units: Vec<u16> = source.encode_utf16().collect();
        let context = &units[position.saturating_sub(50)..units.len().min(position + 50)];
        match String::from_utf16(context) {
            Ok(context) => {
                format!(
                    "readTagExp returned undefined at position {position}. Context: \"{context}\""
                )
            }
            Err(_) => ParseError::SplitSurrogatePair.to_string(),
        }
    }

    /// The name the parser gives each element, in document order (`None`: a
    /// processing instruction, named as written), or the message of the first
    /// thing it throws on.
    fn element_names(xml: &str) -> Result<Vec<Option<ElementName>>, String> {
        let source = normalize_newlines(xml);
        let source = source.as_str();
        let mut names = Vec::new();
        let mut depth = 0usize;
        // a closing tag closed the document node: the parser's current node is
        // undefined from here on
        let mut detached = false;
        let mut text_pending = false;
        let mut cursor = 0;
        while let Some(found) = source[cursor..].find('<') {
            let at = cursor + found;
            if found > 0 {
                text_pending = true;
            }
            let rest = &source[at..];
            if rest.starts_with("</") {
                let close = find_from(source, ">", at).ok_or("Closing Tag is not closed.")?;
                sanitize_name(strip_namespace_prefix(trim(&source[at + 2..close])))?;
                if depth > 0 {
                    depth -= 1;
                } else {
                    detached = true;
                }
                text_pending = false;
                cursor = close + 1;
            } else if rest.starts_with("<?") {
                let close = tag_end(source, at + 1, b"?>").ok_or("Pi Tag is not closed.")?;
                if detached {
                    return Err(type_error(if text_pending { "child" } else { "addChild" }));
                }
                names.push(None);
                text_pending = false;
                cursor = close + 2;
            } else if rest.starts_with("<!--") {
                let close = find_from(source, "-->", at + 4).ok_or("Comment is not closed.")?;
                cursor = close + 3;
            } else if rest.starts_with("<!D") {
                return Err(ParseError::Doctype.to_string());
            } else if rest.starts_with("<![") {
                let close = find_from(source, "]]>", at).ok_or("CDATA is not closed.")?;
                if detached {
                    return Err(type_error(if text_pending { "child" } else { "tagname" }));
                }
                text_pending = false;
                cursor = close + 3;
            } else {
                let Some(close) = tag_end(source, at + 1, b">") else {
                    return Err(unclosed_tag_message(source, at));
                };
                let expression = &source[at + 1..close];
                let (raw_name, tag_exp) =
                    match expression.char_indices().find(|(_, ch)| is_js_space(*ch)) {
                        Some((index, space)) => (
                            &expression[..index],
                            trim_start(&expression[index + space.len_utf8()..]),
                        ),
                        None => (expression, expression),
                    };
                let first = sanitize_name(strip_namespace_prefix(raw_name))?;
                if first == "#text" {
                    return Err(format!("Invalid tag name: {first}"));
                }
                let self_closing = tag_exp.ends_with('/');
                // the processor's path ends in this element: its name after the
                // first transform (a self-closing name loses its slash first),
                // behind the prefix the raw name was written with
                let path_tag = if self_closing {
                    first.strip_suffix('/').unwrap_or(&first)
                } else {
                    &first
                };
                let segment = match raw_name
                    .find(':')
                    .filter(|at| *at > 0)
                    .map(|at| &raw_name[..at])
                {
                    Some(prefix) if prefix != "xmlns" => format!("{prefix}:{path_tag}"),
                    _ => path_tag.to_owned(),
                };
                let keeps_name = js_regex!(r"(?:^|[.:])sheet$").test(&segment);
                let name = if self_closing {
                    let bare = first.strip_suffix('/').unwrap_or(&first);
                    // the self-closing branch runs the name transform a second time
                    sanitize_name(strip_namespace_prefix(bare))?
                } else {
                    if depth > MAX_NESTED_TAGS {
                        return Err(ParseError::MaxNestedTags.to_string());
                    }
                    first
                };
                if detached {
                    return Err(type_error("addChild"));
                }
                if !self_closing {
                    depth += 1;
                }
                names.push(Some(ElementName { name, keeps_name }));
                text_pending = false;
                cursor = close + 1;
            }
        }
        Ok(names)
    }

    /// Only reached where [`element_names`] saw nothing to throw on, which
    /// leaves what the docx options refuse and these options do not.
    fn parser_message(error: ParseError) -> String {
        match error {
            ParseError::ReservedName(name) => reserved_message(&name),
            other => other.to_string(),
        }
    }

    /// `attributeValueProcessor`: every attribute value trimmed, except the
    /// `name` of an element whose path matches `/(?:^|[.:])sheet$/`
    fn rename(nodes: &mut [XNode], names: &mut impl Iterator<Item = Option<ElementName>>) {
        for node in nodes {
            if let XNode::Element(element) = node {
                let mut keeps_name = false;
                if let Some(Some(named)) = names.next() {
                    element.name = named.name;
                    keeps_name = named.keeps_name;
                }
                for (attribute, value) in &mut element.attrs {
                    if !(keeps_name && attribute == "name") {
                        *value = trim(value).to_owned();
                    }
                }
                rename(&mut element.children, names);
            }
        }
    }

    /// `compress` of node2json: the object, and what goes under `#text` once
    /// the element keys are in.
    fn compress(nodes: &[XNode]) -> (JsObject<JVal>, Option<JVal>) {
        let mut text: Option<JVal> = None;
        let mut object: JsObject<JVal> = JsObject::new();
        for node in nodes {
            let element = match node {
                XNode::Text(value) => {
                    text = Some(match text {
                        None => JVal::Str(value.clone()),
                        Some(before) => JVal::Str(js_string(&before) + value),
                    });
                    continue;
                }
                XNode::Element(element) => element,
            };
            // `{ ':@': ... }` has no property name the walk sees
            if element.name == ":@" {
                continue;
            }
            // only a self-closing `#text` element parses, so its value is `[]`
            if element.name == "#text" {
                text = Some(match text {
                    None => JVal::Arr(Vec::new()),
                    Some(before) => JVal::Str(js_string(&before)),
                });
                continue;
            }
            let (mut map, own_text) = compress(&element.children);
            let value = if !element.attrs.is_empty() {
                if let Some(own_text) = own_text {
                    map.set("#text", own_text);
                }
                for (name, value) in &element.attrs {
                    map.set(format!("@_{name}"), JVal::Str(value.clone()));
                }
                JVal::Obj(map)
            } else if let Some(own_text) = own_text {
                if map.is_empty() {
                    own_text
                } else {
                    map.set("#text", own_text);
                    JVal::Obj(map)
                }
            } else if map.is_empty() {
                JVal::Str(String::new())
            } else {
                JVal::Obj(map)
            };
            match object.get_mut(&element.name) {
                Some(JVal::Arr(items)) => items.push(value),
                Some(existing) => {
                    let first = std::mem::replace(existing, JVal::Arr(Vec::new()));
                    *existing = JVal::Arr(vec![first, value]);
                }
                None => object.set(element.name.clone(), value),
            }
        }
        let text = match text {
            Some(JVal::Str(text)) if text.is_empty() => None,
            other => other,
        };
        (object, text)
    }

    /// `parser.parse(xml)`
    pub fn parse(xml: &str) -> Result<JVal, String> {
        let names = element_names(xml)?;
        let mut tree = parse_ordered_with_attributes(xml, MAX_NESTED_TAGS, AttributeMode::Prefixed)
            .map_err(parser_message)?;
        rename(&mut tree, &mut names.into_iter());
        let (mut root, text) = compress(&tree);
        if let Some(text) = text {
            root.set("#text", text);
        }
        Ok(JVal::Obj(root))
    }
}

use fxp::js_string;

/// `value?.[key]`: of the values the parser gives, only an object has the
/// keys read here.
fn prop<'a>(value: Option<&'a JVal>, key: &str) -> Option<&'a JVal> {
    match value {
        Some(JVal::Obj(map)) => map.get(key),
        _ => None,
    }
}

/// `String(node[key] ?? '')`
fn field(node: &JVal, key: &str) -> String {
    prop(Some(node), key).map(js_string).unwrap_or_default()
}

fn as_array(value: Option<&JVal>) -> Vec<&JVal> {
    match value {
        None => Vec::new(),
        Some(JVal::Arr(items)) => items.iter().collect(),
        Some(value) => vec![value],
    }
}

/// `if (value)` on what the parser gives: only the empty string is false.
fn is_truthy(value: Option<&JVal>) -> bool {
    match value {
        None => false,
        Some(JVal::Str(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// UTF-16 length, the `length` of a JavaScript string.
fn units(text: &str) -> f64 {
    text.encode_utf16().count() as f64
}

fn relationship_id(node: &JVal) -> String {
    let JVal::Obj(map) = node else {
        return String::new();
    };
    let qualified = map
        .entries()
        .into_iter()
        .find(|(key, _)| js_regex!(r"^@_[^:]+:id$").test(key));
    match qualified {
        Some((_, value)) => js_string(value),
        None => map.get("@_id").map(js_string).unwrap_or_default(),
    }
}

/// unwrap a parser text node (plain value, or `{ '#text': ... }` when it carried attributes)
fn text_of(node: Option<&JVal>) -> String {
    match node {
        None => String::new(),
        Some(JVal::Obj(map)) => text_of(map.get("#text")),
        Some(value) => js_string(value),
    }
}

/// `decodeXlsxEscapes`
fn decode_xlsx_escapes(text: &str) -> String {
    if !text.contains("_x") {
        return text.to_owned();
    }
    js_regex!("_x([0-9A-Fa-f]{4})_").replace_all(text, |found| {
        let hex = found.get(1).unwrap_or_default();
        let code = u32::from_str_radix(hex, 16).unwrap_or(0);
        match char::from_u32(code) {
            Some(ch) => ch.to_string(),
            // 0xd800..=0xdfff stays as written
            None => found.as_str().to_owned(),
        }
    })
}

/// shared string entry: `<si><t>…</t></si>` or rich-text runs `<si><r><t>…</t></r>…</si>`.
/// The keys come in the parser's order: every `t` of the entry before every
/// `r` when the first `t` came first.
fn shared_string_text(si: &JVal) -> String {
    let JVal::Obj(map) = si else {
        return String::new();
    };
    let mut out = String::new();
    for (key, value) in map.entries() {
        if key == "t" {
            for node in as_array(Some(value)) {
                out.push_str(&decode_xlsx_escapes(&text_of(Some(node))));
            }
        } else if key == "r" {
            for run in as_array(Some(value)) {
                for node in as_array(prop(Some(run), "t")) {
                    out.push_str(&decode_xlsx_escapes(&text_of(Some(node))));
                }
            }
        }
    }
    out
}

/// `"BC12"` to zero-based column index 54 (cell refs are case-insensitive per
/// ECMA-376); -1 without leading letters. A `ref` the parser made an element
/// of has no `toUpperCase`.
fn column_index(cell_ref: &JVal) -> Result<f64, String> {
    let JVal::Str(cell_ref) = cell_ref else {
        return Err(
            "cellRef.toUpperCase is not a function or its return value is not iterable".to_owned(),
        );
    };
    let mut index = 0.0;
    let mut letters = 0;
    for ch in cell_ref.to_uppercase().chars() {
        if !ch.is_ascii_uppercase() {
            break;
        }
        letters += 1;
        index = index * 26.0 + f64::from(ch as u8 - 64);
    }
    Ok(if letters == 0 { -1.0 } else { index - 1.0 })
}

struct SharedFormula {
    formula: String,
    cell_ref: Option<String>,
}

type SharedFormulas = JsMap<SharedFormula>;

fn shared_index(cell: &JVal) -> Option<String> {
    match prop(Some(cell), "f") {
        Some(formula @ JVal::Obj(_)) => prop(Some(formula), "@_si").map(js_string),
        _ => None,
    }
}

/// the master cell may well carry a cached value, so register it before the value check
fn record_shared_formula(cell: &JVal, shared_formulas: &mut SharedFormulas) {
    let si = shared_index(cell);
    let own = trim(&text_of(prop(Some(cell), "f"))).to_owned();
    if let Some(si) = si
        && !own.is_empty()
    {
        shared_formulas.set(
            si,
            SharedFormula {
                formula: own,
                cell_ref: prop(Some(cell), "@_r").map(js_string),
            },
        );
    }
}

const MAX_GRID_ROWS: f64 = 1_048_576.0;
const MAX_GRID_COLUMNS: f64 = 16_384.0;

/// `columnLabel` of cell-address.ts.
fn column_label(column: f64) -> Result<String, String> {
    if !column.is_finite() || column.trunc() != column || column < 0.0 {
        return Err(format!(
            "Invalid column index: {}",
            number_to_string(column)
        ));
    }
    let mut label = Vec::new();
    let mut remaining = column + 1.0;
    while remaining > 0.0 {
        remaining -= 1.0;
        label.push(char::from(b'A' + (remaining % 26.0) as u8));
        remaining = (remaining / 26.0).floor();
    }
    label.reverse();
    Ok(label.into_iter().collect())
}

/// `columnIndex` of cell-address.ts, for letters a pattern already matched.
pub(crate) fn letters_index(letters: &str) -> f64 {
    letters
        .to_ascii_uppercase()
        .bytes()
        .fold(0.0, |column, byte| column * 26.0 + f64::from(byte - 64))
        - 1.0
}

/// `parseAddress` of cell-address.ts, for an address the caller matched
/// against `^\$?[A-Z]+\$?[1-9]\d*$` with the `i` flag and upper-cased.
fn parse_address(address: &str) -> (f64, f64) {
    let found = js_regex!(r"^\$?([A-Z]+)\$?([1-9][0-9]*)$").exec(trim(address));
    let letters = found.as_ref().and_then(|m| m.get(1)).unwrap_or_default();
    let digits = found.as_ref().and_then(|m| m.get(2)).unwrap_or_default();
    (to_number(digits) - 1.0, letters_index(letters))
}

struct RefPart<'a> {
    col_abs: &'a str,
    col: f64,
    row_abs: &'a str,
    row: f64,
}

fn format_ref(part: &RefPart<'_>) -> Result<String, String> {
    Ok(format!(
        "{}{}{}{}",
        part.col_abs,
        column_label(part.col)?,
        part.row_abs,
        number_to_string(part.row + 1.0)
    ))
}

fn offset_ref_part<'a>(
    part: RefPart<'a>,
    row_delta: f64,
    column_delta: f64,
) -> Option<RefPart<'a>> {
    let row = if part.row_abs == "$" {
        part.row
    } else {
        part.row + row_delta
    };
    let col = if part.col_abs == "$" {
        part.col
    } else {
        part.col + column_delta
    };
    if row < 0.0 || row >= MAX_GRID_ROWS || col < 0.0 || col >= MAX_GRID_COLUMNS {
        return None;
    }
    Some(RefPart { row, col, ..part })
}

fn sheet_prefix(quoted: Option<&str>, bare: Option<&str>) -> String {
    match (quoted, bare) {
        (Some(quoted), _) => format!("'{quoted}'!"),
        (None, Some(bare)) => format!("{bare}!"),
        (None, None) => String::new(),
    }
}

/// `formula.split(REWRITE_SKIP_RE)`: the one capture group lands at the odd
/// indexes. The pattern never matches empty. A quoted text of more than
/// about a million characters passes the bound of one search.
fn split_rewrite_skips(formula: &str) -> Result<Vec<&str>, RegexLimit> {
    let skip =
        try_js_regex!(r#"((?:"(?:[^"]|"")*")|(?:(?<=[A-Za-z0-9_.])\[(?:[^\][]|\[[^\][]*\])*\]))"#);
    let mut pieces = Vec::new();
    let mut start = 0;
    for found in skip.try_find_iter(formula) {
        let found = found?;
        pieces.push(&formula[start..found.start()]);
        pieces.push(found.get(1).unwrap_or_default());
        start = found.end();
    }
    pieces.push(&formula[start..]);
    Ok(pieces)
}

/// `offsetFormulaRefs` of formula-shift.ts. Its `[A-Z]` under the `i` flag
/// matches the ASCII letters of both cases only, written out here.
pub(crate) fn offset_formula_refs(
    formula: &str,
    row_delta: f64,
    column_delta: f64,
) -> Result<String, String> {
    if row_delta == 0.0 && column_delta == 0.0 {
        return Ok(formula.to_owned());
    }
    let mut failure: Option<String> = None;
    // the first throw of a replacer ends the whole rewrite
    fn fail(failure: &mut Option<String>, error: String) -> String {
        failure.get_or_insert(error);
        String::new()
    }
    let mut rewritten = String::with_capacity(formula.len());
    for (index, segment) in split_rewrite_skips(formula)
        .map_err(|limit| limit.to_string())?
        .into_iter()
        .enumerate()
    {
        if index % 2 == 1 {
            rewritten.push_str(segment);
            continue;
        }
        let mut out = try_js_regex!(
            r"(?<![A-Za-z0-9_.$!])(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!)?(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})(?::(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7}))?(?![A-Za-z0-9(])"
        )
        .try_replace_all(segment, |found| {
            let group = |at| found.get(at).unwrap_or_default();
            let prefix = sheet_prefix(found.get(1), found.get(2));
            let first = offset_ref_part(
                RefPart {
                    col_abs: group(3),
                    col: letters_index(group(4)),
                    row_abs: group(5),
                    row: to_number(group(6)) - 1.0,
                },
                row_delta,
                column_delta,
            );
            if found.get(8).is_none() {
                return match first {
                    Some(first) => match format_ref(&first) {
                        Ok(text) => format!("{prefix}{text}"),
                        Err(error) => fail(&mut failure, error),
                    },
                    None => format!("{prefix}#REF!"),
                };
            }
            let second = offset_ref_part(
                RefPart {
                    col_abs: group(7),
                    col: letters_index(group(8)),
                    row_abs: group(9),
                    row: to_number(group(10)) - 1.0,
                },
                row_delta,
                column_delta,
            );
            let (Some(first), Some(second)) = (first, second) else {
                return format!("{prefix}#REF!");
            };
            let pair = format_ref(&first).and_then(|a| format_ref(&second).map(|b| format!("{a}:{b}")));
            match pair {
                Ok(text) => format!("{prefix}{text}"),
                Err(error) => fail(&mut failure, error),
            }
        })
        .map_err(|limit| limit.to_string())?;
        if column_delta != 0.0 {
            out = try_js_regex!(
                r"(?<![A-Za-z0-9_.$!:])(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!)?(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9($!:])"
            )
            .try_replace_all(&out, |found| {
                let prefix = sheet_prefix(found.get(1), found.get(2));
                let shift = |abs: &str, letters: &str| -> Result<Option<String>, String> {
                    if abs == "$" {
                        return Ok(Some(format!("${}", letters.to_ascii_uppercase())));
                    }
                    let shifted = letters_index(letters) + column_delta;
                    if shifted < 0.0 || shifted >= MAX_GRID_COLUMNS {
                        return Ok(None);
                    }
                    column_label(shifted).map(Some)
                };
                let first = shift(found.get(3).unwrap_or_default(), found.get(4).unwrap_or_default());
                let first = match first {
                    Ok(first) => first,
                    Err(error) => return fail(&mut failure, error),
                };
                let second = match shift(found.get(5).unwrap_or_default(), found.get(6).unwrap_or_default()) {
                    Ok(second) => second,
                    Err(error) => return fail(&mut failure, error),
                };
                match (first, second) {
                    (Some(first), Some(second)) => format!("{prefix}{first}:{second}"),
                    _ => format!("{prefix}#REF!"),
                }
            })
            .map_err(|limit| limit.to_string())?;
        }
        if row_delta != 0.0 {
            out = try_js_regex!(
                r"(?<![A-Za-z0-9_.$!:])(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!)?(\$?)([0-9]{1,7}):(\$?)([0-9]{1,7})(?![A-Za-z0-9($!:])"
            )
            .try_replace_all(&out, |found| {
                let prefix = sheet_prefix(found.get(1), found.get(2));
                let shift = |abs: &str, digits: &str| -> Option<String> {
                    if abs == "$" {
                        return Some(format!("${digits}"));
                    }
                    let shifted = to_number(digits) - 1.0 + row_delta;
                    if shifted < 0.0 || shifted >= MAX_GRID_ROWS {
                        return None;
                    }
                    Some(number_to_string(shifted + 1.0))
                };
                let first = shift(found.get(3).unwrap_or_default(), found.get(4).unwrap_or_default());
                let second = shift(found.get(5).unwrap_or_default(), found.get(6).unwrap_or_default());
                match (first, second) {
                    (Some(first), Some(second)) => format!("{prefix}{first}:{second}"),
                    _ => format!("{prefix}#REF!"),
                }
            })
            .map_err(|limit| limit.to_string())?;
        }
        rewritten.push_str(&out);
        if failure.is_some() {
            break;
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(rewritten),
    }
}

/// openpyxl/ExcelJS write formulas with no cached `<v>`; the formula text is
/// all there is until Excel recalculates.
fn formula_text(cell: &JVal, shared_formulas: &SharedFormulas) -> Result<String, String> {
    let si = shared_index(cell);
    let own = trim(&text_of(prop(Some(cell), "f"))).to_owned();
    let master = si.as_deref().and_then(|si| shared_formulas.get(si));
    let mut text = if !own.is_empty() {
        own.clone()
    } else {
        master
            .map(|master| master.formula.clone())
            .unwrap_or_default()
    };
    let cell_ref = prop(Some(cell), "@_r");
    if own.is_empty()
        && let Some(master) = master
        && let Some(master_ref) = master.cell_ref.as_deref().filter(|r| !r.is_empty())
        && is_truthy(cell_ref)
    {
        let target_ref = js_string(cell_ref.expect("truthy"));
        let address = js_regex!(r"^\$?[A-Za-z]+\$?[1-9]\d*$");
        if address.test(master_ref) && address.test(&target_ref) {
            let source = parse_address(&master_ref.to_ascii_uppercase());
            let target = parse_address(&target_ref.to_ascii_uppercase());
            text = offset_formula_refs(&master.formula, target.0 - source.0, target.1 - source.1)?;
        }
    }
    Ok(if text.is_empty() {
        String::new()
    } else {
        format!("={text}")
    })
}

/// cellXfs index to date/time parts, for the xf entries whose numFmt renders a
/// calendar value.
type DateStyles = Vec<Option<DateFormatParts>>;

/// A `Map` keyed by number: -0 and 0 are one key.
fn number_key(value: f64) -> u64 {
    (value + 0.0).to_bits()
}

/// A date cell is stored as a plain serial; without its style the model sees
/// 45292 where the sheet shows 1-Jan-24. Resolve each cellXfs entry's numFmt
/// once per workbook.
fn load_date_styles(zip: &Package, path: &str) -> Result<DateStyles, String> {
    let Some(xml) = zip_text(zip, path)?.filter(|xml| !xml.is_empty()) else {
        return Ok(Vec::new());
    };
    let parsed = fxp::parse(xml)?;
    let sheet = prop(Some(&parsed), "styleSheet");
    let mut custom: Vec<(u64, Option<DateFormatParts>)> = Vec::new();
    for fmt in as_array(prop(prop(sheet, "numFmts"), "numFmt")) {
        let id = prop(Some(fmt), "@_numFmtId").map_or(f64::NAN, |id| to_number(&js_string(id)));
        if id.is_finite() && id.trunc() == id {
            let parts = classify_format_code(&field(fmt, "@_formatCode"));
            let key = number_key(id);
            match custom.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = parts,
                None => custom.push((key, parts)),
            }
        }
    }
    let xfs = as_array(prop(prop(sheet, "cellXfs"), "xf"));
    Ok(xfs
        .into_iter()
        .map(|xf| {
            let id = prop(Some(xf), "@_numFmtId").map_or(0.0, |id| to_number(&js_string(id)));
            let key = number_key(id);
            match custom.iter().find(|(k, _)| *k == key) {
                Some((_, parts)) => *parts,
                None => builtin_date_format(id),
            }
        })
        .collect())
}

fn is_date_1904(workbook: &JVal) -> bool {
    let flag = prop(
        prop(prop(Some(workbook), "workbook"), "workbookPr"),
        "@_date1904",
    )
    .map(js_string)
    .unwrap_or_default();
    let flag = trim(&flag).to_lowercase();
    flag == "1" || flag == "true"
}

fn cell_text(
    cell: &JVal,
    shared: &[String],
    dates: &DateStyles,
    date_1904: bool,
    shared_formulas: &SharedFormulas,
) -> Result<String, String> {
    let kind = prop(Some(cell), "@_t").map(js_string).unwrap_or_default();
    if kind == "inlineStr" {
        let inline = prop(Some(cell), "is");
        return Ok(if is_truthy(inline) {
            shared_string_text(inline.expect("truthy"))
        } else {
            String::new()
        });
    }
    if prop(Some(cell), "f").is_some() && trim(&text_of(prop(Some(cell), "v"))).is_empty() {
        return formula_text(cell, shared_formulas);
    }
    // <v> is ST_Xstring so it reaches the caller verbatim; the two reads that
    // need it as a scalar handle their own whitespace
    let value = text_of(prop(Some(cell), "v"));
    if (kind.is_empty() || kind == "n")
        && let Some(style) = prop(Some(cell), "@_s")
    {
        let index = to_number(&js_string(style));
        let parts = (index.trunc() == index && index >= 0.0 && index < dates.len() as f64)
            .then(|| dates[index as usize])
            .flatten();
        if let Some(parts) = parts
            && !trim(&value).is_empty()
            && let Some(rendered) = format_serial(to_number(&value), &parts, date_1904)
        {
            return Ok(rendered);
        }
    }
    if kind == "s" {
        // An empty or missing <v> stays empty: Number('') is 0 and would leak
        // shared[0] into the cell.
        let trimmed = trim(&value);
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        let index = to_number(trimmed);
        if index.trunc() != index || index < 0.0 || index >= shared.len() as f64 {
            return Ok(String::new());
        }
        return Ok(shared[index as usize].clone());
    }
    if kind == "b" {
        let token = trim(&value).to_lowercase();
        return Ok(if token == "1" || token == "true" {
            "TRUE"
        } else {
            "FALSE"
        }
        .to_owned());
    }
    if kind == "str" {
        return Ok(decode_xlsx_escapes(&value));
    }
    Ok(value)
}

/// `zip.file(path)?.async('text')`
fn zip_text<'a>(zip: &'a Package, path: &str) -> Result<Option<&'a str>, String> {
    zip.text(path).map_err(|error| error.reason)
}

/// The size of the chunks JSZip's stream hands out: `DataWorker` slices a
/// stored entry by 16 KiB and pako's `Inflate` fills 16 KiB output buffers.
const STREAM_CHUNK: f64 = 16_384.0;

/// `new TextDecoder().decode(bytes)`: one leading byte order mark is dropped.
fn text_decoder(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Inflate only the first `max_bytes` of a part: the stream stops at the
/// first chunk that reaches the limit, and reaching it on the last chunk
/// still counts as truncated.
fn zip_text_prefix(
    zip: &Package,
    path: &str,
    max_bytes: f64,
) -> Result<Option<(String, bool)>, String> {
    let Some(part) = zip.file(path) else {
        return Ok(None);
    };
    if !max_bytes.is_finite() {
        return part
            .text()
            .map(|text| Some((text.to_owned(), false)))
            .map_err(|error| error.reason);
    }
    let bytes = part.bytes().map_err(|error| error.reason)?;
    let length = bytes.len() as f64;
    if length < max_bytes {
        return Ok(Some((text_decoder(bytes), false)));
    }
    let end = ((max_bytes / STREAM_CHUNK).ceil() * STREAM_CHUNK).min(length);
    Ok(Some((text_decoder(&bytes[..end as usize]), true)))
}

/// Malformed refs (e.g. XXXXXX99) would otherwise grow the cells array by
/// millions via the padding.
const MAX_XLSX_COLS: f64 = 16_384.0;

/// Longest run of empty slots kept verbatim between two filled cells.
const MAX_EMPTY_RUN: usize = 8;

/// Empty slots carry no text: trailing ones are dropped and long inner runs
/// collapse to a count.
fn join_row_cells(cells: &[String]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut run = 0usize;
    for cell in cells {
        if cell.is_empty() {
            run += 1;
            continue;
        }
        if run > MAX_EMPTY_RUN {
            out.push(format!("({run} empty)"));
        } else {
            out.extend(std::iter::repeat_n(String::new(), run));
        }
        run = 0;
        out.push(cell.clone());
    }
    out.join(" | ")
}

const XML_BYTES_PER_TEXT_CHAR: f64 = 8.0;
const XML_CLIP_SLACK: f64 = 256.0 * 1024.0;
const EMPTY_SHEET_XML: &str = "<worksheet><sheetData/></worksheet>";

/// `sheetXmlByteLimit`
pub fn sheet_xml_byte_limit(budget_chars: f64) -> f64 {
    budget_chars * XML_BYTES_PER_TEXT_CHAR + XML_CLIP_SLACK
}

/// The byte offset of `xml.slice(0, end)`. A cut inside a surrogate pair
/// keeps no half: what is read from the head is ASCII markup before it.
fn slice_end_byte(xml: &str, end: f64, length: f64) -> usize {
    let end = if end.is_nan() { 0.0 } else { end.trunc() };
    let end = if end < 0.0 {
        (length + end).max(0.0)
    } else {
        end.min(length)
    };
    let mut taken = 0.0;
    for (at, ch) in xml.char_indices() {
        let width = ch.len_utf16() as f64;
        if taken + width > end {
            return at;
        }
        taken += width;
    }
    xml.len()
}

/// `clipSheetXml`: drop whole rows past the budget, keeping the document
/// well-formed; a truncated prefix is always cut back to its last complete row.
pub fn clip_sheet_xml(xml: &str, budget_chars: f64, truncated: bool) -> String {
    let limit = sheet_xml_byte_limit(budget_chars);
    let length = units(xml);
    if !truncated && length <= limit {
        return xml.to_owned();
    }
    let head = &xml[..slice_end_byte(xml, limit, length)];
    let last = js_regex!(r"<\/([\w.-]+:)?row>").find_iter(head).last();
    let data_at = js_regex!(r"<([\w.-]+:)?sheetData[\s>]")
        .exec(head)
        .map(|found| found.start());
    let (Some(last), Some(data_at)) = (last, data_at) else {
        return if truncated {
            EMPTY_SHEET_XML.to_owned()
        } else {
            xml.to_owned()
        };
    };
    if last.start() < data_at {
        return if truncated {
            EMPTY_SHEET_XML.to_owned()
        } else {
            xml.to_owned()
        };
    }
    let ns = last.get(1).unwrap_or_default();
    format!("{}</{ns}sheetData></{ns}worksheet>", &head[..last.end()])
}

fn count_elements(value: &JVal, name: &str) -> f64 {
    match value {
        JVal::Arr(items) => items.iter().map(|item| count_elements(item, name)).sum(),
        JVal::Str(_) => 0.0,
        JVal::Obj(map) => map
            .entries()
            .into_iter()
            .map(|(key, child)| {
                let matches = match child {
                    _ if key != name => 0.0,
                    JVal::Arr(items) => items.len() as f64,
                    _ => 1.0,
                };
                matches + count_elements(child, name)
            })
            .sum(),
    }
}

/// `sheetPath.replace(/([^/]+)$/, '_rels/$1.rels')`
fn sheet_rels_path(sheet_path: &str) -> String {
    let start = sheet_path.rfind('/').map_or(0, |slash| slash + 1);
    if start == sheet_path.len() {
        return sheet_path.to_owned();
    }
    format!(
        "{}_rels/{}.rels",
        &sheet_path[..start],
        &sheet_path[start..]
    )
}

/// follow the sheet's `<drawing r:id>` to its drawing part and count the pictures anchored there
fn count_drawing_pictures(zip: &Package, sheet_path: &str, drawing: &JVal) -> Result<f64, String> {
    let Some(rels_xml) = zip_text(zip, &sheet_rels_path(sheet_path))?.filter(|xml| !xml.is_empty())
    else {
        return Ok(0.0);
    };
    let rels = fxp::parse(rels_xml)?;
    let wanted = relationship_id(drawing);
    for rel in as_array(prop(prop(Some(&rels), "Relationships"), "Relationship")) {
        if field(rel, "@_Id") != wanted {
            continue;
        }
        let target = resolve_target(sheet_path, &field(rel, "@_Target"));
        return Ok(
            match zip_text(zip, &target)?.filter(|xml| !xml.is_empty()) {
                Some(drawing_xml) => count_elements(&fxp::parse(drawing_xml)?, "pic"),
                None => 0.0,
            },
        );
    }
    Ok(0.0)
}

/// One withheld rectangle, in zero-based coordinates.
struct RedactionMark {
    start_row: f64,
    end_row: f64,
    start_column: f64,
    end_column: f64,
    label: String,
}

struct SheetRedactionState {
    sheet_name: String,
    marks: Vec<RedactionMark>,
}

const REDACTION_PART_PATH: &str = "xl/gxRedactions.json";
const WORKBOOK_PART_PATH: &str = "xl/workbook.xml";

/// The redaction reader throws on anything it does not understand; why it
/// threw never reaches the caller.
struct Unreadable;

/// `isNonNegativeInteger`
fn non_negative_integer(value: Option<&Value>) -> Result<f64, Unreadable> {
    let number = value.and_then(Value::as_f64).ok_or(Unreadable)?;
    if number.is_finite() && number.trunc() == number && number >= 0.0 {
        Ok(number)
    } else {
        Err(Unreadable)
    }
}

fn non_empty_string(value: Option<&Value>) -> Result<String, Unreadable> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Ok(text.clone()),
        _ => Err(Unreadable),
    }
}

/// `parseRedactionPart` of the gateway.
fn parse_redaction_part(text: &str) -> Result<Vec<SheetRedactionState>, Unreadable> {
    let parsed: Value = serde_json::from_str(text).map_err(|_| Unreadable)?;
    let Value::Object(root) = parsed else {
        return Err(Unreadable);
    };
    if root.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(Unreadable);
    }
    let Some(Value::Array(sheets)) = root.get("sheets") else {
        return Err(Unreadable);
    };
    sheets
        .iter()
        .map(|entry| {
            let Value::Object(sheet) = entry else {
                return Err(Unreadable);
            };
            let sheet_name = non_empty_string(sheet.get("name"))?;
            let Some(Value::Array(marks)) = sheet.get("marks") else {
                return Err(Unreadable);
            };
            let marks = marks
                .iter()
                .map(|mark| {
                    let Value::Object(record) = mark else {
                        return Err(Unreadable);
                    };
                    let start_row = non_negative_integer(record.get("startRow"))?;
                    let end_row = non_negative_integer(record.get("endRow"))?;
                    let start_column = non_negative_integer(record.get("startColumn"))?;
                    let end_column = non_negative_integer(record.get("endColumn"))?;
                    if end_row < start_row || end_column < start_column {
                        return Err(Unreadable);
                    }
                    let label = non_empty_string(record.get("label"))?;
                    Ok(RedactionMark {
                        start_row,
                        end_row,
                        start_column,
                        end_column,
                        label,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(SheetRedactionState { sheet_name, marks })
        })
        .collect()
}

/// `unmirrorFormula`
fn unmirror_formula(body: &str) -> String {
    let text = trim(body);
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        text[1..text.len() - 1].replace("\"\"", "\"")
    } else {
        text.to_owned()
    }
}

fn mirror_cell(value: Option<&Value>) -> Result<(f64, f64), Unreadable> {
    match value {
        Some(Value::Array(corner)) if corner.len() == 2 => Ok((
            non_negative_integer(corner.first())?,
            non_negative_integer(corner.get(1))?,
        )),
        _ => Err(Unreadable),
    }
}

/// `mirrorMarkOf`: the sheet comes from the payload's position.
fn mirror_mark_of(
    payload: &Value,
    sheet_order: &[String],
) -> Result<(String, RedactionMark), Unreadable> {
    let Value::Object(record) = payload else {
        return Err(Unreadable);
    };
    if record.get("v").and_then(Value::as_f64) != Some(1.0) {
        return Err(Unreadable);
    }
    let sheet = non_negative_integer(record.get("sheet"))?;
    let sheet_name = (sheet < sheet_order.len() as f64)
        .then(|| sheet_order[sheet as usize].clone())
        .ok_or(Unreadable)?;
    let from = mirror_cell(record.get("from"))?;
    let to = mirror_cell(record.get("to"))?;
    if to.0 < from.0 || to.1 < from.1 {
        return Err(Unreadable);
    }
    let label = non_empty_string(record.get("label"))?;
    Ok((
        sheet_name,
        RedactionMark {
            start_row: from.0,
            start_column: from.1,
            end_row: to.0,
            end_column: to.1,
            label,
        },
    ))
}

/// `parseRedactionNameMirror` of the gateway: the marks in the hidden
/// `_gxRedaction_N` defined names, grouped by sheet in first-seen order.
fn parse_redaction_name_mirror(
    workbook_xml: &str,
    sheet_order: &[String],
) -> Result<Vec<SheetRedactionState>, Unreadable> {
    let mut by_sheet: Vec<SheetRedactionState> = Vec::new();
    for element in root_namespace_elements(workbook_xml, "definedName") {
        if !js_regex!(r"^_gxRedaction_\d+$").test(element.attribute("name").unwrap_or_default()) {
            continue;
        }
        let payload: Value =
            serde_json::from_str(&unmirror_formula(&element_text(workbook_xml, &element)))
                .map_err(|_| Unreadable)?;
        let (sheet_name, mark) = mirror_mark_of(&payload, sheet_order)?;
        match by_sheet
            .iter_mut()
            .find(|state| state.sheet_name == sheet_name)
        {
            Some(state) => state.marks.push(mark),
            None => by_sheet.push(SheetRedactionState {
                sheet_name,
                marks: vec![mark],
            }),
        }
    }
    Ok(by_sheet)
}

/// The names `parseSheetElements` reads, in workbook order.
fn sheet_element_names(workbook_xml: &str) -> Vec<String> {
    root_namespace_elements(workbook_xml, "sheet")
        .iter()
        .filter_map(|element| element.attribute("name").map(str::to_owned))
        .collect()
}

/// `readRedactionRecord` of the gateway: the part when it parses, the copy in
/// the defined names when the part is missing or damaged. An empty copy
/// beside a damaged part is not "no marks".
fn read_redaction_record(
    zip: &Package,
    workbook_xml: &str,
) -> Result<Vec<SheetRedactionState>, Unreadable> {
    let mut damaged = false;
    if let Some(part) = zip.file(REDACTION_PART_PATH) {
        match part.text().ok().map(parse_redaction_part) {
            Some(Ok(states)) => return Ok(states),
            _ => damaged = true,
        }
    }
    let mirrored = parse_redaction_name_mirror(workbook_xml, &sheet_element_names(workbook_xml))?;
    if damaged && mirrored.is_empty() {
        return Err(Unreadable);
    }
    Ok(mirrored)
}

/// `readStates` of xlsx-redaction.ts: whatever the record's reader throws is
/// one refusal.
fn read_states(zip: &Package, workbook_xml: &str) -> Result<Vec<SheetRedactionState>, String> {
    read_redaction_record(zip, workbook_xml).map_err(|_| {
        redaction_error("the record of the cells withheld in this workbook cannot be read")
    })
}

/// `readXlsxRedactions`: the marks of every sheet that has any, by sheet name.
fn read_xlsx_redactions(
    zip: &Package,
    sheet_names: &[String],
) -> Result<Vec<(String, Vec<RedactionMark>)>, String> {
    let Some(workbook_xml) = zip_text(zip, WORKBOOK_PART_PATH)? else {
        return Ok(Vec::new());
    };
    let mut by_sheet: Vec<(String, Vec<RedactionMark>)> = Vec::new();
    for state in read_states(zip, workbook_xml)? {
        if state.marks.is_empty() {
            continue;
        }
        if !sheet_names.contains(&state.sheet_name) {
            return Err(redaction_error(
                "cells are withheld on a sheet this workbook does not have",
            ));
        }
        match by_sheet
            .iter_mut()
            .find(|(name, _)| *name == state.sheet_name)
        {
            Some((_, marks)) => marks.extend(state.marks),
            None => by_sheet.push((state.sheet_name, state.marks)),
        }
    }
    Ok(by_sheet)
}

/// the label for a cell that could not be checked against the marks
const UNKNOWN_LABEL: &str = "private";

/// what a model reads in place of the cell: `sanitizeLabel(label, { forComment: true })`,
/// which strips `*` and `/` beside what the default strips
fn marker(label: &str) -> String {
    let label = sanitize_label(&label.replace(['*', '/'], ""));
    format!(
        "{{{{{}}}}}",
        if label.is_empty() {
            UNKNOWN_LABEL
        } else {
            label.as_str()
        }
    )
}

/// `withheldCellMarker`: the marker standing in for the cell at `cell_ref`, or
/// `None` when the cell reads as itself. `marks` are one sheet's marks and
/// `derived` what the formula trace found on it; a workbook without marks
/// passes neither.
fn withheld_cell_marker(
    marks: Option<&[RedactionMark]>,
    cell_ref: Option<&str>,
    derived: Option<&DerivedSheet>,
    has_formula: bool,
) -> Option<String> {
    if marks.is_none() && derived.is_none() {
        return None;
    }
    let at =
        cell_ref.and_then(|cell_ref| js_regex!(r"^([A-Za-z]{1,3})([1-9]\d{0,6})$").exec(cell_ref));
    let Some(at) = at else {
        return (marks.is_some() || derived.is_some_and(|derived| derived.any) || has_formula)
            .then(|| marker(UNKNOWN_LABEL));
    };
    let row = to_number(at.get(2).unwrap_or_default()) - 1.0;
    let column = letters_index(at.get(1).unwrap_or_default());
    if let Some(mark) = marks.unwrap_or_default().iter().find(|mark| {
        row >= mark.start_row
            && row <= mark.end_row
            && column >= mark.start_column
            && column <= mark.end_column
    }) {
        return Some(marker(&mark.label));
    }
    let derived = derived?;
    // A formula the worksheet parser sees and the scan did not was never traced.
    (derived.withheld(row, column) || (has_formula && !derived.known_formula(row, column)))
        .then(|| marker(UNKNOWN_LABEL))
}

/// `UNKNOWN_CELL_MARKER`: what a model reads in place of text that may be a
/// withheld cell (a chart title, say).
pub fn unknown_cell_marker() -> String {
    marker(UNKNOWN_LABEL)
}

/// A cache definition opens with its `<cacheSource>`; the member lists that
/// follow can run to megabytes, and one that names its source later is not
/// searched for it (the pivot's output is then withheld untraced).
const PIVOT_CACHE_HEAD_BYTES: f64 = 1024.0 * 1024.0;
/// A pivot part is read whole: its `<location>` comes first, but its report
/// filters (`<pageFields>`) come after the fields and every item of them. One
/// larger than this is read as far as this and treated as not fully known.
const PIVOT_PART_MAX_BYTES: f64 = FORMULA_SCAN_MAX_BYTES;

/// the relationships of one kind a part declares, as part paths; external ones are left out
fn related_parts(zip: &Package, part_path: &str, kind: &str) -> Result<Vec<String>, String> {
    let Some(rels_xml) = zip_text(zip, &sheet_rels_path(part_path))?.filter(|xml| !xml.is_empty())
    else {
        return Ok(Vec::new());
    };
    let rels = fxp::parse(rels_xml)?;
    let mut parts = Vec::new();
    for rel in as_array(prop(prop(Some(&rels), "Relationships"), "Relationship")) {
        let target = field(rel, "@_Target");
        if field(rel, "@_Type").ends_with(&format!("/{kind}"))
            && field(rel, "@_TargetMode").to_lowercase() != "external"
            && !trim(&target).is_empty()
        {
            parts.push(resolve_target(part_path, &target));
        }
    }
    Ok(parts)
}

/// every PivotTable whose output is on this sheet, with the source its cache names
fn sheet_pivot_outputs(zip: &Package, sheet_path: &str) -> Result<Vec<PivotOutput>, String> {
    let mut outputs = Vec::new();
    for pivot_path in related_parts(zip, sheet_path, "pivotTable")? {
        let cache_path = related_parts(zip, &pivot_path, "pivotCacheDefinition")?
            .into_iter()
            .next();
        let pivot = zip_text_prefix(zip, &pivot_path, PIVOT_PART_MAX_BYTES)?;
        let cache = match cache_path {
            None => None,
            Some(cache_path) => {
                zip_text_prefix(zip, &cache_path, PIVOT_CACHE_HEAD_BYTES)?.map(|(text, _)| text)
            }
        };
        outputs.push(pivot_output_of(
            pivot
                .as_ref()
                .map(|(text, truncated)| (text.as_str(), *truncated)),
            cache.as_deref(),
        )?);
    }
    Ok(outputs)
}

fn plural(count: f64) -> &'static str {
    if count == 1.0 { "" } else { "s" }
}

/// What `readWorkbookIndex` returns. The sheets are those of `workbook`, as
/// `sheets` gives them.
struct WorkbookIndex {
    workbook: JVal,
    /// relationship id -> part path, from the workbook's own relationships
    rel_targets: JsMap<String>,
    styles_path: String,
    shared_strings_path: String,
    date_1904: bool,
    /// `xl/_rels/workbook.xml.rels` is there, empty or not
    has_rels_xml: bool,
}

impl WorkbookIndex {
    fn sheets(&self) -> Vec<&JVal> {
        as_array(prop(
            prop(prop(Some(&self.workbook), "workbook"), "sheets"),
            "sheet",
        ))
    }
}

/// `readWorkbookIndex`: sheet order, names and parts, as workbook.xml and its
/// relationships give them. Sheet order and names come from workbook.xml;
/// r:id maps to the actual sheet path via the workbook rels.
fn read_workbook_index(zip: &Package) -> Result<WorkbookIndex, String> {
    let Some(workbook_xml) = zip_text(zip, WORKBOOK_PART_PATH)?.filter(|xml| !xml.is_empty())
    else {
        return Err("Invalid xlsx: missing xl/workbook.xml".to_owned());
    };

    let workbook = fxp::parse(workbook_xml)?;
    let date_1904 = is_date_1904(&workbook);

    let rels_xml = zip_text(zip, "xl/_rels/workbook.xml.rels")?;
    let has_rels_xml = rels_xml.is_some();
    let mut rel_targets: JsMap<String> = JsMap::new();
    let mut styles_path = "xl/styles.xml".to_owned();
    let mut shared_strings_path = "xl/sharedStrings.xml".to_owned();
    if let Some(rels_xml) = rels_xml.filter(|xml| !xml.is_empty()) {
        let rels = fxp::parse(rels_xml)?;
        for rel in as_array(prop(prop(Some(&rels), "Relationships"), "Relationship")) {
            let id = field(rel, "@_Id");
            let target = field(rel, "@_Target");
            let resolved = if trim(&target).is_empty() {
                String::new()
            } else {
                resolve_target(WORKBOOK_PART_PATH, &target)
            };
            if !id.is_empty() && !resolved.is_empty() {
                rel_targets.set(id, resolved.clone());
            }
            if !resolved.is_empty() && field(rel, "@_TargetMode").to_lowercase() != "external" {
                let kind = field(rel, "@_Type");
                if kind.ends_with("/styles") {
                    styles_path = resolved.clone();
                }
                if kind.ends_with("/sharedStrings") {
                    shared_strings_path = resolved;
                }
            }
        }
    }

    Ok(WorkbookIndex {
        workbook,
        rel_targets,
        styles_path,
        shared_strings_path,
        date_1904,
        has_rels_xml,
    })
}

/// The cells a workbook withholds from a model, and the cells that compute
/// from them: the result of `readWithheldCells`, which `xlsxWithheldCells`
/// hands out as a reader.
pub struct WithheldCells {
    sheet_names: Vec<String>,
    redactions: Vec<(String, Vec<RedactionMark>)>,
    /// one entry per sheet; `None` for a workbook that withholds nothing
    derived: Option<Vec<DerivedSheet>>,
}

impl WithheldCells {
    /// The placeholder to give instead of the value and formula of the cell at
    /// `cell_ref` on `sheet`, or `None` when the cell reads as itself.
    pub fn marker(&self, sheet: &str, cell_ref: &str, has_formula: bool) -> Option<String> {
        let index = self.sheet_names.iter().position(|name| name == sheet);
        let marks = self
            .redactions
            .iter()
            .find(|(name, _)| name == sheet)
            .map(|(_, marks)| marks.as_slice());
        let derived = index.and_then(|index| self.derived.as_ref()?.get(index));
        withheld_cell_marker(marks, Some(cell_ref), derived, has_formula)
    }
}

/// `readWithheldCells`. Read before any cell is: a record of withheld cells
/// that cannot be read fails the whole workbook, and no sheet is handed over
/// without its marks.
fn read_withheld_cells(
    zip: &Package,
    workbook: &JVal,
    sheets: &[&JVal],
    rel_targets: &JsMap<String>,
    scan_limit: f64,
) -> Result<WithheldCells, String> {
    let sheet_names: Vec<String> = sheets.iter().map(|sheet| field(sheet, "@_name")).collect();
    let redactions = read_xlsx_redactions(zip, &sheet_names)?;
    // Nor without the formulas that compute from those cells, which may sit on
    // any sheet and reach the cell through any other.
    let derived: Option<Vec<DerivedSheet>> = if redactions.is_empty() {
        None
    } else {
        let inputs: Vec<DerivedInput<'_>> = sheets
            .iter()
            .zip(&sheet_names)
            .map(|(sheet, name)| {
                let part = rel_targets.get(&relationship_id(sheet));
                DerivedInput {
                    name: name.clone(),
                    xml: match part {
                        Some(part) => {
                            Some(Box::new(move || zip_text_prefix(zip, part, scan_limit)))
                        }
                        None => None,
                    },
                    marks: redactions
                        .iter()
                        .find(|(redacted, _)| redacted == name)
                        .map(|(_, marks)| {
                            marks
                                .iter()
                                .map(|mark| RangeBounds {
                                    start_row: mark.start_row,
                                    start_column: mark.start_column,
                                    end_row: mark.end_row,
                                    end_column: mark.end_column,
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    pivots: match part {
                        Some(part) => Some(Box::new(move || sheet_pivot_outputs(zip, part))),
                        None => None,
                    },
                }
            })
            .collect();
        let defined_names: Vec<NameDefinition> = as_array(prop(
            prop(prop(Some(workbook), "workbook"), "definedNames"),
            "definedName",
        ))
        .into_iter()
        .filter_map(|defined| match defined {
            JVal::Obj(_) => prop(Some(defined), "@_name").map(|name| NameDefinition {
                name: js_string(name),
                formula: text_of(Some(defined)),
            }),
            _ => None,
        })
        .collect();
        Some(read_derived_cells(inputs, &defined_names)?)
    };

    Ok(WithheldCells {
        sheet_names,
        redactions,
        derived,
    })
}

/// `xlsxWithheldCells`: the reader for the cells of a workbook that its sheet
/// editor withholds from a model, or `None` for a workbook that withholds
/// nothing. A workbook whose record cannot be read is an `Err`.
pub fn xlsx_withheld_cells(bytes: &[u8]) -> Result<Option<WithheldCells>, String> {
    let zip = load_zip_package(bytes)?;
    let index = read_workbook_index(&zip)?;
    let withheld = read_withheld_cells(
        &zip,
        &index.workbook,
        &index.sheets(),
        &index.rel_targets,
        FORMULA_SCAN_MAX_BYTES,
    )?;
    Ok((!withheld.redactions.is_empty()).then_some(withheld))
}

/// extract sheet text from an xlsx: one "# SheetName" section per sheet, cells
/// joined with " | ". `max_chars` is `opts.maxChars` and `formula_scan_max_bytes`
/// is `opts.formulaScanMaxBytes`, `None` for none given.
pub fn xlsx_to_text(
    bytes: &[u8],
    max_chars: Option<f64>,
    formula_scan_max_bytes: Option<f64>,
) -> Result<String, String> {
    let max_chars = max_chars.unwrap_or(f64::INFINITY);
    let mut used = 0.0;
    let zip = load_zip_package(bytes)?;
    let index = read_workbook_index(&zip)?;
    let sheets = index.sheets();
    let rel_targets = &index.rel_targets;
    let date_1904 = index.date_1904;

    let date_styles = load_date_styles(&zip, &index.styles_path)?;
    let mut shared: Vec<String> = Vec::new();
    if let Some(shared_xml) =
        zip_text(&zip, &index.shared_strings_path)?.filter(|xml| !xml.is_empty())
    {
        let sst = fxp::parse(shared_xml)?;
        for si in as_array(prop(prop(Some(&sst), "sst"), "si")) {
            shared.push(shared_string_text(si));
        }
    }
    let WithheldCells {
        sheet_names,
        redactions,
        derived,
    } = read_withheld_cells(
        &zip,
        &index.workbook,
        &sheets,
        rel_targets,
        formula_scan_max_bytes.unwrap_or(FORMULA_SCAN_MAX_BYTES),
    )?;

    let mut sections: Vec<String> = Vec::new();
    let mut sheets_with_data = 0.0;
    let mut image_only_sheets = 0.0;
    for (sheet_index, (sheet, sheet_name)) in sheets.iter().zip(&sheet_names).enumerate() {
        if used >= max_chars {
            break;
        }
        let path = rel_targets.get(&relationship_id(sheet));
        let budget = max_chars - used;
        let raw = match path {
            Some(path) => zip_text_prefix(&zip, path, sheet_xml_byte_limit(budget))?,
            None => None,
        };
        let Some((raw_text, raw_truncated)) = raw.filter(|(text, _)| !text.is_empty()) else {
            continue;
        };
        let sheet_xml = if max_chars == f64::INFINITY {
            raw_text
        } else {
            clip_sheet_xml(&raw_text, budget, raw_truncated)
        };
        let parsed = fxp::parse(&sheet_xml)?;
        let worksheet = prop(Some(&parsed), "worksheet");
        let marks = redactions
            .iter()
            .find(|(name, _)| name == sheet_name)
            .map(|(_, marks)| marks.as_slice());
        let derived_cells = derived.as_ref().map(|derived| &derived[sheet_index]);
        let mut lines: Vec<String> = vec![format!("# {sheet_name}")];
        let mut sheet_chars = units(&lines[0]);
        let rows = as_array(prop(prop(worksheet, "sheetData"), "row"));
        let mut has_data = false;
        let mut shared_formulas: SharedFormulas = JsMap::new();
        for &row in &rows {
            for cell in as_array(prop(Some(row), "c")) {
                record_shared_formula(cell, &mut shared_formulas);
            }
        }
        for &row in &rows {
            // Sparse by column; a slot holds several values only when refs collide.
            let mut slots: Vec<Option<Vec<String>>> = Vec::new();
            for cell in as_array(prop(Some(row), "c")) {
                let cell_ref = prop(Some(cell), "@_r");
                // A withheld cell is its marker and nothing else: neither its
                // cached value nor its formula is read into the row. The same
                // goes for a formula that computes from one.
                let text = match withheld_cell_marker(
                    marks,
                    cell_ref.map(js_string).as_deref(),
                    derived_cells,
                    prop(Some(cell), "f").is_some(),
                ) {
                    Some(marker) => marker,
                    None => cell_text(cell, &shared, &date_styles, date_1904, &shared_formulas)?,
                };
                let col = match cell_ref.filter(|cell_ref| is_truthy(Some(cell_ref))) {
                    Some(cell_ref) => column_index(cell_ref)?,
                    None => slots.len() as f64,
                };
                let target = if (0.0..MAX_XLSX_COLS).contains(&col) {
                    col as usize
                } else {
                    slots.len()
                };
                if target >= slots.len() {
                    slots.resize_with(target + 1, || None);
                }
                if !trim(&text).is_empty() {
                    has_data = true;
                }
                let slot = slots[target].get_or_insert_with(Vec::new);
                match slot.last_mut() {
                    Some(last) if last.is_empty() => *last = text,
                    _ => slot.push(text),
                }
            }
            let mut cells: Vec<String> = Vec::new();
            for slot in &slots {
                match slot {
                    None => cells.push(String::new()),
                    Some(slot) => cells.extend(slot.iter().rev().cloned()),
                }
            }
            let line = join_row_cells(&cells);
            sheet_chars += units(&line) + 1.0;
            lines.push(line);
            if used + sheet_chars >= max_chars {
                break;
            }
        }
        used += sheet_chars;
        let drawing = prop(worksheet, "drawing");
        if has_data {
            sheets_with_data += 1.0;
        } else if let (Some(path), true) = (path, is_truthy(drawing)) {
            image_only_sheets += 1.0;
            let pictures = count_drawing_pictures(&zip, path, drawing.expect("truthy"))?;
            lines.push(if pictures > 0.0 {
                format!(
                    "[image-only sheet: {} image{}, no cell data]",
                    number_to_string(pictures),
                    plural(pictures)
                )
            } else {
                "[image-only sheet: a drawing but no cell data]".to_owned()
            });
        }
        sections.push(lines.join("\n"));
    }
    if !sheets.is_empty() && sections.is_empty() {
        let declared = sheets.len() as f64;
        return Err(match index.has_rels_xml {
            false => format!(
                "Invalid xlsx: xl/_rels/workbook.xml.rels is missing, so none of the {} declared sheet{} can be resolved",
                number_to_string(declared),
                plural(declared)
            ),
            true => format!(
                "Invalid xlsx: no sheet relationship in xl/_rels/workbook.xml.rels resolves to a readable worksheet part ({} declared)",
                number_to_string(declared)
            ),
        });
    }
    let body = sections.join("\n\n");
    if sheets_with_data > 0.0 || image_only_sheets == 0.0 {
        return Ok(body);
    }
    let n = sections.len() as f64;
    Ok(format!(
        "[No extractable text: none of the {} sheet{} holds cell data; the content is in embedded images, which this extraction does not read.]\n\n{body}",
        number_to_string(n),
        plural(n)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_whole_rows() {
        let xml = format!(
            "<worksheet><sheetData>{}</sheetData></worksheet>",
            "<row><c><v>1</v></c></row>".repeat(4)
        );
        assert_eq!(clip_sheet_xml(&xml, 1.0, false), xml);
        let cut = clip_sheet_xml(&xml, -32_761.875, false);
        assert_eq!(
            cut,
            "<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>"
        );
        assert_eq!(clip_sheet_xml("<worksheet>", 1.0, true), EMPTY_SHEET_XML);
    }

    #[test]
    fn shared_formula_offsets_follow_fill() {
        assert_eq!(
            offset_formula_refs("SUM(A1:B2)+\"A1\"", 1.0, 1.0)
                .ok()
                .as_deref(),
            Some("SUM(B2:C3)+\"A1\"")
        );
        assert_eq!(
            offset_formula_refs("$A$1+A1", 0.0, -1.0).ok().as_deref(),
            Some("$A$1+#REF!")
        );
        assert!(offset_formula_refs("A1", 0.0, f64::NAN).is_err());
    }

    #[test]
    fn marker_falls_back_to_private() {
        assert_eq!(marker("*/"), "{{private}}");
        assert_eq!(marker("Pay roll"), "{{Pay roll}}");
    }
}
