//! The write half of doc-properties.ts: set or remove the properties of the
//! three docProps parts, and write them into a package. The readers and the
//! constants of the part names are in `crate::doc_properties`.

use jscompat::serde::{Deserialize, Serialize};
use jscompat::{
    JsObject, Radix, RegexError, RegexLimit, TryJsRegex, js_regex, number_to_string, parse_int,
    to_number, trim,
};
use ooxml_pkg::Package;
use serde_json::Value;

use crate::doc_properties::zotero::{
    CUSTOM_PROPERTIES_CONTENT_TYPE, CUSTOM_PROPERTIES_PATH, CUSTOM_PROPERTIES_REL_TYPE,
    PROPERTY_RE, attr_value,
};
use crate::doc_properties::{
    APP_PROPERTIES, APP_PROPERTIES_CONTENT_TYPE, APP_PROPERTIES_PATH, APP_PROPERTIES_REL_TYPE,
    CORE_PROPERTIES, CORE_PROPERTIES_CONTENT_TYPE, CORE_PROPERTIES_PATH, CORE_PROPERTIES_REL_TYPE,
    parse_custom_property_types_xml,
};
use crate::generate::{escape_xml_attr, escape_xml_text};

/// the fmtid every Word custom property carries
const CUSTOM_PROPERTIES_FMTID: &str = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";

/// The prefix each core property is written under when the part binds it.
const CORE_PREFIXES: [(&str, &str); 14] = [
    ("title", "dc"),
    ("subject", "dc"),
    ("creator", "dc"),
    ("keywords", "cp"),
    ("description", "dc"),
    ("lastModifiedBy", "cp"),
    ("revision", "cp"),
    ("created", "dcterms"),
    ("modified", "dcterms"),
    ("category", "cp"),
    ("contentStatus", "cp"),
    ("identifier", "dc"),
    ("language", "dc"),
    ("version", "cp"),
];

/// The schema order of CT_Properties: app.xml is a sequence, so an element that
/// is not there yet has to be written where the schema puts it.
const APP_PROPERTY_ORDER: [&str; 27] = [
    "Template",
    "Manager",
    "Company",
    "Pages",
    "Words",
    "Characters",
    "PresentationFormat",
    "Lines",
    "Paragraphs",
    "Slides",
    "Notes",
    "TotalTime",
    "HiddenSlides",
    "MMClips",
    "ScaleCrop",
    "HeadingPairs",
    "TitlesOfParts",
    "LinksUpToDate",
    "CharactersWithSpaces",
    "SharedDoc",
    "HyperlinkBase",
    "HLinks",
    "HyperlinksChanged",
    "DigSig",
    "Application",
    "AppVersion",
    "DocSecurity",
];

/// `CORE_PROPERTY_KEYS`: the core property keys, in the order the part lists them
pub fn core_property_keys() -> impl Iterator<Item = &'static str> {
    CORE_PROPERTIES.iter().map(|(key, _)| *key)
}

/// `APP_PROPERTY_KEYS`: the extended (app) property keys
pub fn app_property_keys() -> impl Iterator<Item = &'static str> {
    APP_PROPERTIES.iter().map(|(key, _)| *key)
}

/// `PropertyValue`: a custom-property value of a set_properties op: text, or a
/// typed number/boolean
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(crate = "jscompat::serde", untagged)]
pub enum PropertyValue {
    Text(String),
    Number(f64),
    Bool(bool),
}

/// `PropertyChanges`: what a set_properties op asks for: a value per key, or
/// `None` to remove it
#[derive(Debug, Clone, Default)]
pub struct PropertyChanges {
    pub core: Option<JsObject<Option<String>>>,
    pub app: Option<JsObject<Option<String>>>,
    /// custom values: text stays lpwstr, a number/boolean takes a typed vt value
    pub custom: Option<JsObject<Option<PropertyValue>>>,
    /// remove every property of all three parts (a full metadata scrub)
    pub clear_all: bool,
}

impl PropertyChanges {
    /// The changes as `parsePropertyChanges` builds the object: `clear` first,
    /// then the sections core, app and custom.
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        if self.clear_all {
            out.insert("clear".to_owned(), Value::from("all"));
        }
        if let Some(core) = &self.core {
            out.insert(
                "core".to_owned(),
                serde_json::to_value(core).unwrap_or(Value::Null),
            );
        }
        if let Some(app) = &self.app {
            out.insert(
                "app".to_owned(),
                serde_json::to_value(app).unwrap_or(Value::Null),
            );
        }
        if let Some(custom) = &self.custom {
            out.insert(
                "custom".to_owned(),
                serde_json::to_value(custom).unwrap_or(Value::Null),
            );
        }
        Value::Object(out)
    }

    /// The changes a JSON object holds, as the TypeScript reads a typed
    /// `PropertyChanges` that nothing has validated: a value of another type
    /// than the interface names is left out.
    fn from_json(input: &Value) -> Self {
        let section = |name: &str| -> Option<JsObject<Value>> {
            let object = input.get(name)?.as_object()?;
            Some(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )
        };
        let texts = |name: &str| {
            section(name).map(|values| {
                let mut out = JsObject::new();
                for (key, value) in values.entries() {
                    match value {
                        Value::String(text) => out.set(key, Some(text.clone())),
                        Value::Null => out.set(key, None),
                        _ => {}
                    }
                }
                out
            })
        };
        Self {
            core: texts("core"),
            app: texts("app"),
            custom: section("custom").map(|values| {
                let mut out = JsObject::new();
                for (key, value) in values.entries() {
                    match value {
                        Value::String(text) => {
                            out.set(key, Some(PropertyValue::Text(text.clone())))
                        }
                        Value::Bool(flag) => out.set(key, Some(PropertyValue::Bool(*flag))),
                        Value::Number(n) => out.set(
                            key,
                            Some(PropertyValue::Number(n.as_f64().unwrap_or(f64::NAN))),
                        ),
                        Value::Null => out.set(key, None),
                        _ => {}
                    }
                }
                out
            }),
            clear_all: input.get("clear").and_then(Value::as_str) == Some("all"),
        }
    }
}

impl<'de> Deserialize<'de> for PropertyChanges {
    fn deserialize<D: jscompat::serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Self, D::Error> {
        Ok(Self::from_json(&Value::deserialize(deserializer)?))
    }
}

/// `elementRe`: `<dc:title>`, `<dc:title/>` and `<title>`: the element by
/// local name, the prefix optional because a part may bind it to another prefix.
fn element_re(local: &str) -> TryJsRegex {
    TryJsRegex::new(
        &format!(
            r"<([A-Za-z_][\w.-]*:)?{local}(?=[\s/>])([^>]*?)(?:/>|>([\s\S]*?)</([A-Za-z_][\w.-]*:)?{local}\s*>)"
        ),
        "g",
    )
    .expect("a pattern built from a table entry compiles")
}

/// `insertElement`: insert an element before the root's closing tag
fn insert_element(xml: &str, element: &str) -> String {
    match xml.rfind("</") {
        None => format!("{xml}{element}"),
        Some(at) => format!("{}{element}{}", &xml[..at], &xml[at..]),
    }
}

/// `out.replace(elementRe(local), (_, openPrefix, attrs) => <name attrs>value</name>)`
/// and whether it found one.
fn replace_element_text(xml: &str, local: &str, value: &str) -> Result<(String, bool), RegexLimit> {
    let mut found = false;
    let out = element_re(local).try_replace_all(xml, |found_match| {
        found = true;
        let name = format!("{}{local}", found_match.get(1).unwrap_or_default());
        format!(
            "<{name}{}>{}</{name}>",
            found_match.get(2).unwrap_or_default(),
            escape_xml_text(value)
        )
    })?;
    Ok((out, found))
}

/// `setElementText`: replace the text of the element, keeping its attributes;
/// insert it when missing
fn set_element_text(
    xml: &str,
    local: &str,
    value: &str,
    element: &str,
) -> Result<String, RegexLimit> {
    let (out, found) = replace_element_text(xml, local, value)?;
    Ok(if found {
        out
    } else {
        insert_element(xml, element)
    })
}

/// `blankCorePropertiesXml`
fn blank_core_properties_xml() -> &'static str {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"></cp:coreProperties>"
}

/// `blankAppPropertiesXml`
fn blank_app_properties_xml() -> &'static str {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"></Properties>"
}

/// `blankCustomPropertiesXml`
fn blank_custom_properties_xml() -> &'static str {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/custom-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"></Properties>"
}

/// `clearRootChildrenXml`: every child of the root goes, known or not; the
/// root itself stays
fn clear_root_children_xml(xml: &str, root: &str) -> Result<String, RegexLimit> {
    let re = TryJsRegex::new(
        &format!(
            r"(<(?:[A-Za-z_][\w.-]*:)?{root}(?=[\s>])[^>]*>)[\s\S]*(</(?:[A-Za-z_][\w.-]*:)?{root}\s*>)"
        ),
        "",
    )
    .expect("a pattern built from a root name compiles");
    Ok(match re.try_exec(xml)? {
        Some(found) => format!(
            "{}{}{}{}",
            &xml[..found.start()],
            found.get(1).unwrap_or_default(),
            found.get(2).unwrap_or_default(),
            &xml[found.end()..]
        ),
        None => xml.to_owned(),
    })
}

/// `patchCorePropertiesXml`: set or remove the core properties of a core.xml part
pub fn patch_core_properties_xml(
    xml: &str,
    changes: &JsObject<Option<String>>,
) -> Result<String, RegexLimit> {
    let mut out = xml.to_owned();
    for (key, value) in changes.entries() {
        let Some((_, local)) = CORE_PROPERTIES.iter().find(|(known, _)| *known == key) else {
            continue;
        };
        let prefix = CORE_PREFIXES
            .iter()
            .find(|(known, _)| *known == key)
            .map_or("", |(_, prefix)| *prefix);
        let Some(value) = value else {
            out = element_re(local).try_replace_all(&out, |_| String::new())?;
            continue;
        };
        let name = if out.contains(&format!("xmlns:{prefix}=")) {
            format!("{prefix}:{local}")
        } else {
            (*local).to_owned()
        };
        let attrs = if (*local == "created" || *local == "modified") && out.contains("xmlns:xsi=") {
            " xsi:type=\"dcterms:W3CDTF\""
        } else {
            ""
        };
        out = set_element_text(
            &out,
            local,
            value,
            &format!("<{name}{attrs}>{}</{name}>", escape_xml_text(value)),
        )?;
    }
    Ok(out)
}

/// `patchAppPropertiesXml`: set or remove the extended properties of an app.xml part
pub fn patch_app_properties_xml(
    xml: &str,
    changes: &JsObject<Option<String>>,
) -> Result<String, RegexLimit> {
    let mut out = xml.to_owned();
    for (key, value) in changes.entries() {
        let Some((_, local)) = APP_PROPERTIES.iter().find(|(known, _)| *known == key) else {
            continue;
        };
        match value {
            None => out = element_re(local).try_replace_all(&out, |_| String::new())?,
            Some(value) => out = set_app_element(&out, local, value)?,
        }
    }
    Ok(out)
}

/// `setAppElement`: an app.xml element goes where the schema sequence puts it
fn set_app_element(xml: &str, local: &str, value: &str) -> Result<String, RegexLimit> {
    let (out, found) = replace_element_text(xml, local, value)?;
    if found {
        return Ok(out);
    }
    let element = format!("<{local}>{}</{local}>", escape_xml_text(value));
    let at = APP_PROPERTY_ORDER.iter().position(|other| *other == local);
    for (index, other) in APP_PROPERTY_ORDER.iter().enumerate() {
        // `indexOf(local)` is -1 for an element the order does not name
        if at.is_some_and(|at| index <= at) {
            continue;
        }
        if let Some(found) = element_re(other).try_exec(xml)? {
            return Ok(format!(
                "{}{element}{}",
                &xml[..found.start()],
                &xml[found.start()..]
            ));
        }
    }
    Ok(insert_element(xml, &element))
}

/// the type a new custom property gets when the value cannot be typed
const CUSTOM_PROPERTY_DEFAULT_TYPE: &str = "lpwstr";

/// The range a vt integer type can hold.
fn vt_int_range(kind: &str) -> Option<(f64, f64)> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    Some(match kind {
        "i1" => (-128.0, 127.0),
        "i2" => (-32768.0, 32767.0),
        "i4" | "int" => (-2147483648.0, 2147483647.0),
        "i8" => (-MAX_SAFE, MAX_SAFE),
        "ui1" => (0.0, 255.0),
        "ui2" => (0.0, 65535.0),
        "ui4" | "uint" => (0.0, 4294967295.0),
        "ui8" => (0.0, MAX_SAFE),
        _ => return None,
    })
}

/// `scalarText`: the text form of a scalar op value (used for text fallbacks)
fn scalar_text(value: &PropertyValue) -> String {
    match value {
        PropertyValue::Bool(true) => "true".to_owned(),
        PropertyValue::Bool(false) => "false".to_owned(),
        PropertyValue::Number(n) => number_to_string(*n),
        PropertyValue::Text(text) => text.clone(),
    }
}

/// `w3cdtfValue`: Word's W3CDTF text (a bare date fills the day start, no zone means Z)
fn w3cdtf_value(value: &str) -> Option<String> {
    let found =
        js_regex!(r"^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$")
            .exec(trim(value))?;
    let date = found.get(1).unwrap_or_default();
    Some(match found.get(2).filter(|time| !time.is_empty()) {
        Some(time) => format!("{date}T{time}{}", found.get(3).unwrap_or("Z")),
        None => format!("{date}T00:00:00Z"),
    })
}

/// `typedCustomText`: the text a value carries in an existing vt type, `None`
/// when the value does not fit it: numbers for the integer/float types,
/// true/false for bool, an ISO-8601 stamp for filetime/date, anything for the
/// text types.
fn typed_custom_text(kind: &str, value: &PropertyValue) -> Option<String> {
    if matches!(kind, "lpwstr" | "lpstr" | "bstr") {
        return Some(scalar_text(value));
    }
    if kind == "bool" {
        match value {
            PropertyValue::Bool(flag) => return Some(flag.to_string()),
            PropertyValue::Number(n) if *n == 1.0 => return Some("true".to_owned()),
            PropertyValue::Number(n) if *n == 0.0 => return Some("false".to_owned()),
            PropertyValue::Text(text) => {
                let text = trim(text).to_lowercase();
                if text == "true" || text == "1" {
                    return Some("true".to_owned());
                }
                if text == "false" || text == "0" {
                    return Some("false".to_owned());
                }
            }
            PropertyValue::Number(_) => {}
        }
        return None;
    }
    if let Some((low, high)) = vt_int_range(kind) {
        let number = match value {
            PropertyValue::Number(n) => Some(*n),
            PropertyValue::Text(text) if js_regex!(r"^[+-]?\d+$").test(trim(text)) => {
                Some(to_number(trim(text)))
            }
            _ => None,
        }?;
        if !number.is_finite() || number.fract() != 0.0 || number < low || number > high {
            return None;
        }
        return Some(number_to_string(number));
    }
    if matches!(kind, "r4" | "r8" | "decimal" | "cy") {
        return match value {
            PropertyValue::Number(n) => n.is_finite().then(|| number_to_string(*n)),
            PropertyValue::Text(text)
                if js_regex!(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$").test(trim(text)) =>
            {
                Some(trim(text).to_owned())
            }
            _ => None,
        };
    }
    if matches!(kind, "filetime" | "date") {
        return match value {
            PropertyValue::Text(text) => w3cdtf_value(text),
            _ => None,
        };
    }
    None
}

/// `resolveCustomValue`: the vt type and text of a set value: an existing
/// property keeps its type while the value fits it, otherwise (and for a new
/// property) the type comes from the value — text stays lpwstr, a boolean is
/// bool, an integer i4/i8 and a fraction r8.
fn resolve_custom_value(existing_type: Option<&str>, value: &PropertyValue) -> (String, String) {
    if let Some(kind) = existing_type.filter(|kind| !kind.is_empty()) {
        return match typed_custom_text(kind, value) {
            Some(text) => (kind.to_owned(), text),
            None => (CUSTOM_PROPERTY_DEFAULT_TYPE.to_owned(), scalar_text(value)),
        };
    }
    match value {
        PropertyValue::Bool(flag) => ("bool".to_owned(), flag.to_string()),
        PropertyValue::Number(n) => {
            let text = number_to_string(*n);
            if !n.is_finite() {
                return (CUSTOM_PROPERTY_DEFAULT_TYPE.to_owned(), text);
            }
            if n.fract() == 0.0 && *n >= -2147483648.0 && *n <= 2147483647.0 {
                return ("i4".to_owned(), text);
            }
            if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
                return ("i8".to_owned(), text);
            }
            ("r8".to_owned(), text)
        }
        PropertyValue::Text(text) => (CUSTOM_PROPERTY_DEFAULT_TYPE.to_owned(), text.clone()),
    }
}

/// `vTypesPrefix`: the prefix a custom.xml part binds the docPropsVTypes namespace to
fn v_types_prefix(xml: &str) -> String {
    js_regex!(r#"xmlns:([A-Za-z_][\w.-]*)="[^"]*docPropsVTypes""#)
        .exec(xml)
        .and_then(|found| found.get(1))
        .unwrap_or("vt")
        .to_owned()
}

/// `out.replace(PROPERTY_RE, replacement)`, the replacement allowed to fail.
fn replace_properties(
    xml: &str,
    mut replacement: impl FnMut(&str) -> Result<String, RegexError>,
) -> Result<String, RegexError> {
    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0;
    for property in PROPERTY_RE.find_iter(xml) {
        out.push_str(&xml[cursor..property.start()]);
        out.push_str(&replacement(property.as_str())?);
        cursor = property.end();
    }
    out.push_str(&xml[cursor..]);
    Ok(out)
}

/// `patchCustomPropertiesXml`: set or remove the custom properties of a
/// custom.xml part, keeping stored vt types
pub fn patch_custom_properties_xml(
    xml: &str,
    changes: &JsObject<Option<PropertyValue>>,
) -> Result<String, RegexError> {
    let mut out = xml.to_owned();
    let mut max_pid = super::zotero_doc_props::max_pid(&out)?;
    let existing_types = parse_custom_property_types_xml(&out);
    let prefix = v_types_prefix(&out);
    for (name, value) in changes.entries() {
        let Some(value) = value else {
            out = replace_properties(&out, |property| {
                Ok(if attr_value(property, "name")?.as_deref() == Some(name) {
                    String::new()
                } else {
                    property.to_owned()
                })
            })?;
            continue;
        };
        let (kind, text) =
            resolve_custom_value(existing_types.get(name).map(String::as_str), value);
        let value_xml = format!(
            "<{prefix}:{kind}>{}</{prefix}:{kind}>",
            escape_xml_text(&text)
        );
        let mut replaced = false;
        out = replace_properties(&out, |property| {
            if attr_value(property, "name")?.as_deref() != Some(name) {
                return Ok(property.to_owned());
            }
            replaced = true;
            let fmtid = attr_value(property, "fmtid")?
                .unwrap_or_else(|| CUSTOM_PROPERTIES_FMTID.to_owned());
            let pid =
                attr_value(property, "pid")?.unwrap_or_else(|| number_to_string(max_pid + 1.0));
            Ok(format!(
                "<property fmtid=\"{}\" pid=\"{}\" name=\"{}\">{value_xml}</property>",
                escape_xml_attr(&fmtid),
                escape_xml_attr(&pid),
                escape_xml_attr(name)
            ))
        })?;
        if replaced {
            continue;
        }
        max_pid += 1.0;
        out = insert_element(
            &out,
            &format!(
                "<property fmtid=\"{CUSTOM_PROPERTIES_FMTID}\" pid=\"{}\" name=\"{}\">{value_xml}</property>",
                number_to_string(max_pid),
                escape_xml_attr(name)
            ),
        );
    }
    Ok(out)
}

/// `maxRelId`
fn max_rel_id(rels_xml: &str) -> f64 {
    let mut max = 0.0f64;
    for found in js_regex!(r#"\bId\s*=\s*["']rId(\d+)["']"#, "g").find_iter(rels_xml) {
        let n = parse_int(found.get(1).unwrap_or("0"), Radix::Ten);
        if n > max {
            max = n;
        }
    }
    max
}

/// `addContentTypeOverride`
fn add_content_type_override(
    package: &mut Package,
    part_name: &str,
    content_type: &str,
) -> Result<(), String> {
    let Some(xml) = package
        .text("[Content_Types].xml")
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    if xml.contains(&format!("PartName=\"{part_name}\"")) {
        return Ok(());
    }
    let out = xml.replacen(
        "</Types>",
        &format!("<Override PartName=\"{part_name}\" ContentType=\"{content_type}\"/></Types>"),
        1,
    );
    package.set_file("[Content_Types].xml".to_owned(), out.into_bytes());
    Ok(())
}

/// `addRootRelationship`
fn add_root_relationship(
    package: &mut Package,
    rel_type: &str,
    target: &str,
) -> Result<(), String> {
    let path = "_rels/.rels";
    let xml = match package.text(path).map_err(|error| error.to_string())? {
        Some(xml) => xml.to_owned(),
        None => "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".to_owned(),
    };
    if xml.contains(&format!("Type=\"{rel_type}\"")) {
        return Ok(());
    }
    let id = format!("rId{}", number_to_string(max_rel_id(&xml) + 1.0));
    let out = xml.replacen(
        "</Relationships>",
        &format!(
            "<Relationship Id=\"{id}\" Type=\"{rel_type}\" Target=\"{target}\"/></Relationships>"
        ),
        1,
    );
    package.set_file(path.to_owned(), out.into_bytes());
    Ok(())
}

/// `writePropertiesPart`: write a docProps part, creating it (with its
/// content type and relationship) when missing
fn write_properties_part(
    package: &mut Package,
    path: &str,
    xml: String,
    content_type: &str,
    rel_type: &str,
) -> Result<(), String> {
    let existed = package.has(path);
    package.set_file(path.to_owned(), xml.into_bytes());
    if existed {
        return Ok(());
    }
    add_content_type_override(package, &format!("/{path}"), content_type)?;
    add_root_relationship(package, rel_type, path)
}

/// `hasSetValue`
fn has_set_value<V>(values: Option<&JsObject<Option<V>>>) -> bool {
    values.is_some_and(|values| values.entries().iter().any(|(_, value)| value.is_some()))
}

/// `applyPropertyChanges`: write the requested property changes into the
/// package: a string sets a property, null removes it, clear: "all" empties
/// all three parts. A part that is not there yet is created, so a document
/// without docProps can still take properties.
pub fn apply_property_changes(
    package: &mut Package,
    changes: &PropertyChanges,
) -> Result<(), String> {
    let clear_all = changes.clear_all;
    if !clear_all && changes.core.is_none() && changes.app.is_none() && changes.custom.is_none() {
        return Ok(());
    }
    let limit = |error: RegexLimit| error.to_string();

    if clear_all || changes.core.is_some() {
        let entry = package
            .text(CORE_PROPERTIES_PATH)
            .map_err(|error| error.to_string())?
            .map(str::to_owned);
        let values = changes.core.clone().unwrap_or_default();
        if entry.is_some() || has_set_value(Some(&values)) {
            let xml = entry.unwrap_or_else(|| blank_core_properties_xml().to_owned());
            // the clear comes first: a value given in the same op still lands
            let base = if clear_all {
                clear_root_children_xml(&xml, "coreProperties").map_err(limit)?
            } else {
                xml
            };
            let out = patch_core_properties_xml(&base, &values).map_err(limit)?;
            write_properties_part(
                package,
                CORE_PROPERTIES_PATH,
                out,
                CORE_PROPERTIES_CONTENT_TYPE,
                CORE_PROPERTIES_REL_TYPE,
            )?;
        }
    }

    if clear_all || changes.app.is_some() {
        let entry = package
            .text(APP_PROPERTIES_PATH)
            .map_err(|error| error.to_string())?
            .map(str::to_owned);
        let values = changes.app.clone().unwrap_or_default();
        if entry.is_some() || has_set_value(Some(&values)) {
            let xml = entry.unwrap_or_else(|| blank_app_properties_xml().to_owned());
            let base = if clear_all {
                clear_root_children_xml(&xml, "Properties").map_err(limit)?
            } else {
                xml
            };
            let out = patch_app_properties_xml(&base, &values).map_err(limit)?;
            write_properties_part(
                package,
                APP_PROPERTIES_PATH,
                out,
                APP_PROPERTIES_CONTENT_TYPE,
                APP_PROPERTIES_REL_TYPE,
            )?;
        }
    }

    if clear_all || changes.custom.is_some() {
        let entry = package
            .text(CUSTOM_PROPERTIES_PATH)
            .map_err(|error| error.to_string())?
            .map(str::to_owned);
        let values = changes.custom.clone().unwrap_or_default();
        if entry.is_some() || has_set_value(Some(&values)) {
            let xml = entry.unwrap_or_else(|| blank_custom_properties_xml().to_owned());
            // every custom property goes; the part itself stays
            let base = if clear_all {
                replace_properties(&xml, |_| Ok(String::new()))
                    .map_err(|error| error.to_string())?
            } else {
                xml
            };
            let out =
                patch_custom_properties_xml(&base, &values).map_err(|error| error.to_string())?;
            write_properties_part(
                package,
                CUSTOM_PROPERTIES_PATH,
                out,
                CUSTOM_PROPERTIES_CONTENT_TYPE,
                CUSTOM_PROPERTIES_REL_TYPE,
            )?;
        }
    }
    Ok(())
}

/// `parsePropertyChanges`: the set_properties op: core / app / custom hold the
/// values to set (null removes), clear: "all" empties every part. Custom
/// values may be strings, numbers or booleans (a typed value keeps an
/// existing property's vt type); core/app stay strings. Errs on anything else.
pub fn parse_property_changes(input: &Value) -> Result<PropertyChanges, String> {
    let mut changes = PropertyChanges::default();
    if let Some(clear) = input.get("clear") {
        if clear.as_str() != Some("all") {
            return Err("set_properties: clear must be \"all\"".to_owned());
        }
        changes.clear_all = true;
    }
    for section in ["core", "app", "custom"] {
        let Some(values) = input.get(section) else {
            continue;
        };
        // a falsy value, an array and any other non-object all fail the same check
        let Some(object) = values.as_object() else {
            return Err(format!(
                "set_properties: {section} must be an object of property values"
            ));
        };
        let known: Vec<&str> = match section {
            "core" => core_property_keys().collect(),
            "app" => app_property_keys().collect(),
            _ => Vec::new(),
        };
        let entries: JsObject<Value> = object
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let mut text_values: JsObject<Option<String>> = JsObject::new();
        let mut custom_values: JsObject<Option<PropertyValue>> = JsObject::new();
        for (key, value) in entries.entries() {
            if !known.is_empty() && !known.contains(&key) {
                return Err(format!(
                    "set_properties: unknown {section} property \"{key}\" (known: {})",
                    known.join(", ")
                ));
            }
            if value.is_null() {
                if section == "custom" {
                    custom_values.set(key, None);
                } else {
                    text_values.set(key, None);
                }
                continue;
            }
            let typed = matches!(value, Value::Number(_) | Value::Bool(_));
            if !value.is_string() && !(section == "custom" && typed) {
                return Err(if section == "custom" {
                    format!(
                        "set_properties: custom.{key} must be a string, number, boolean or null"
                    )
                } else {
                    format!("set_properties: {section}.{key} must be a string or null")
                });
            }
            if section == "custom" {
                custom_values.set(
                    key,
                    Some(match value {
                        Value::String(text) => PropertyValue::Text(text.clone()),
                        Value::Bool(flag) => PropertyValue::Bool(*flag),
                        other => PropertyValue::Number(other.as_f64().unwrap_or(f64::NAN)),
                    }),
                );
            } else if let Value::String(text) = value {
                text_values.set(key, Some(text.clone()));
            }
        }
        match section {
            "core" => changes.core = Some(text_values),
            "app" => changes.app = Some(text_values),
            _ => changes.custom = Some(custom_values),
        }
    }
    let is_empty = |len: Option<usize>| len.is_none_or(|len| len == 0);
    if !changes.clear_all
        && is_empty(changes.core.as_ref().map(JsObject::len))
        && is_empty(changes.app.as_ref().map(JsObject::len))
        && is_empty(changes.custom.as_ref().map(JsObject::len))
    {
        return Err(
            "set_properties: nothing to change (give core, app, custom or clear)".to_owned(),
        );
    }
    Ok(changes)
}
