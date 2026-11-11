//! The read side of the docProps parts (`doc-properties.ts`): core.xml,
//! app.xml and custom.xml, each read by pattern, not by an XML parser. The
//! Zotero document data kept in custom.xml is in [`zotero`].

pub mod zotero;

use std::sync::LazyLock;

use jscompat::{JsRegex, js_regex};
use ooxml_pkg::{Package, ReadError};
use serde::Serialize;
use serde::ser::{SerializeSeq, Serializer};

use self::zotero::{
    CUSTOM_PROPERTIES_PATH, PROPERTY_RE, attr_name, decode_xml_text, property_text,
};

/// docProps/core.xml: the core properties part.
pub const CORE_PROPERTIES_PATH: &str = "docProps/core.xml";
/// docProps/app.xml: the extended properties part.
pub const APP_PROPERTIES_PATH: &str = "docProps/app.xml";

pub const CORE_PROPERTIES_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-package.core-properties+xml";
pub const CORE_PROPERTIES_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
pub const APP_PROPERTIES_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.extended-properties+xml";
pub const APP_PROPERTIES_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";

/// Friendly key and the local name of the element of docProps/core.xml that
/// holds it, in the order the part lists them: the keys are
/// `CORE_PROPERTY_KEYS`.
pub const CORE_PROPERTIES: [(&str, &str); 14] = [
    ("title", "title"),
    ("subject", "subject"),
    ("creator", "creator"),
    ("keywords", "keywords"),
    ("description", "description"),
    ("lastModifiedBy", "lastModifiedBy"),
    ("revision", "revision"),
    ("created", "created"),
    ("modified", "modified"),
    ("category", "category"),
    ("contentStatus", "contentStatus"),
    ("identifier", "identifier"),
    ("language", "language"),
    ("version", "version"),
];

/// Friendly key and the element of docProps/app.xml that holds it: the keys
/// are `APP_PROPERTY_KEYS`.
pub const APP_PROPERTIES: [(&str, &str); 17] = [
    ("template", "Template"),
    ("totalTime", "TotalTime"),
    ("pages", "Pages"),
    ("words", "Words"),
    ("characters", "Characters"),
    ("application", "Application"),
    ("docSecurity", "DocSecurity"),
    ("lines", "Lines"),
    ("paragraphs", "Paragraphs"),
    ("scaleCrop", "ScaleCrop"),
    ("company", "Company"),
    ("linksUpToDate", "LinksUpToDate"),
    ("charactersWithSpaces", "CharactersWithSpaces"),
    ("sharedDoc", "SharedDoc"),
    ("hyperlinksChanged", "HyperlinksChanged"),
    ("appVersion", "AppVersion"),
    ("manager", "Manager"),
];

/// A plain JavaScript object used as a table of strings, written with
/// `setOwn(out, key, value)`: every key is an own entry, `__proto__` too.
/// It serializes in object order: array-index keys first, ascending, then the
/// rest in insertion order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Record(Vec<(String, String)>);

impl Record {
    fn set(&mut self, key: &str, value: String) {
        match self.0.iter_mut().find(|(have, _)| have == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(have, _)| have == key)
            .map(|(_, value)| value.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The index a JavaScript object orders a key by, when the key is an array
/// index ("0", "17", not "017").
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || !key.starts_with('0');
    let all_digits = !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit());
    (canonical && all_digits)
        .then(|| key.parse::<u32>().ok())
        .flatten()
        .filter(|index| *index != u32::MAX)
}

impl Serialize for Record {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut entries: Vec<&(String, String)> = self.0.iter().collect();
        entries.sort_by_key(|(key, _)| match array_index(key) {
            Some(index) => (0, index),
            None => (1, 0),
        });
        // as `Object.entries`: JSON objects lose their key order on the wire
        let mut list = serializer.serialize_seq(Some(entries.len()))?;
        for (key, value) in entries {
            list.serialize_element(&(key, value))?;
        }
        list.end()
    }
}

/// The document properties of a .docx, read from its three docProps parts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentProperties {
    pub core: Record,
    pub app: Record,
    /// By property name; a typed value is its vt text ("42", "true").
    pub custom: Record,
    /// By property name: the vt type the value is stored as.
    pub custom_types: Record,
}

/// `<dc:title>`, `<dc:title/>` and `<title>`: the element by local name, the
/// prefix optional because a part may bind it to another prefix.
fn element_re(local: &str) -> JsRegex {
    JsRegex::new(
        &format!(
            r"<([A-Za-z_][\w.-]*:)?{local}(?=[\s/>])([^>]*?)(?:/>|>([\s\S]*?)</([A-Za-z_][\w.-]*:)?{local}\s*>)"
        ),
        "",
    )
    .expect("a pattern built from a table entry compiles")
}

static CORE_ELEMENTS: LazyLock<Vec<(&str, JsRegex)>> = LazyLock::new(|| {
    CORE_PROPERTIES
        .iter()
        .map(|(key, local)| (*key, element_re(local)))
        .collect()
});

static APP_ELEMENTS: LazyLock<Vec<(&str, JsRegex)>> = LazyLock::new(|| {
    APP_PROPERTIES
        .iter()
        .map(|(key, local)| (*key, element_re(local)))
        .collect()
});

/// The text of each element a table names, where the part carries it.
fn element_texts(xml: &str, elements: &[(&str, JsRegex)]) -> Record {
    let mut out = Record::default();
    for (key, element) in elements {
        if let Some(found) = element.exec(xml) {
            out.set(key, decode_xml_text(found.get(3).unwrap_or("")));
        }
    }
    out
}

/// `parseCorePropertiesXml`: the core properties of a core.xml part.
pub fn parse_core_properties_xml(xml: &str) -> Record {
    element_texts(xml, &CORE_ELEMENTS)
}

/// `parseAppPropertiesXml`: the extended properties of an app.xml part.
pub fn parse_app_properties_xml(xml: &str) -> Record {
    element_texts(xml, &APP_ELEMENTS)
}

fn custom_property_value(property: &str) -> String {
    let value = js_regex!(
        r"<(?:[A-Za-z_][\w.-]*:)?(lpwstr|lpstr|bstr|i1|i2|i4|i8|ui1|ui2|ui4|ui8|int|uint|r4|r8|bool|filetime|date|decimal)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?\1\s*>"
    );
    match value.exec(property) {
        Some(found) => decode_xml_text(found.get(2).unwrap_or("")),
        None => property_text(property),
    }
}

/// `parseCustomPropertiesXml`: the custom properties of a custom.xml part, by
/// property name.
pub fn parse_custom_properties_xml(xml: &str) -> Record {
    let mut out = Record::default();
    for property in PROPERTY_RE.find_iter(xml) {
        let property = property.as_str();
        if let Some(name) = attr_name(property).filter(|name| !name.is_empty()) {
            out.set(&name, custom_property_value(property));
        }
    }
    out
}

/// `parseCustomPropertyTypesXml`: the vt types of a custom.xml part's
/// properties, by property name. Unknown value elements stay untyped.
pub fn parse_custom_property_types_xml(xml: &str) -> Record {
    let vt_type = js_regex!(
        r"<(?:[A-Za-z_][\w.-]*:)?(lpwstr|lpstr|bstr|i1|i2|i4|i8|ui1|ui2|ui4|ui8|int|uint|r4|r8|bool|filetime|date|decimal|cy|error|null|clsid|blob|stream|storage|variant|vector)\b"
    );
    let mut out = Record::default();
    for property in PROPERTY_RE.find_iter(xml) {
        let property = property.as_str();
        let name = attr_name(property);
        let kind = vt_type.exec(property).and_then(|found| found.get(1));
        if let (Some(name), Some(kind)) = (name.filter(|name| !name.is_empty()), kind)
            && !kind.is_empty()
        {
            out.set(&name, kind.to_owned());
        }
    }
    out
}

/// `readDocumentProperties`: the three docProps parts of a package, empty
/// where a part is missing.
pub fn read_document_properties(package: &Package) -> Result<DocumentProperties, ReadError> {
    let custom = package.text(CUSTOM_PROPERTIES_PATH)?;
    let core = package.text(CORE_PROPERTIES_PATH)?;
    let app = package.text(APP_PROPERTIES_PATH)?;
    Ok(DocumentProperties {
        core: core.map(parse_core_properties_xml).unwrap_or_default(),
        app: app.map(parse_app_properties_xml).unwrap_or_default(),
        custom: custom.map(parse_custom_properties_xml).unwrap_or_default(),
        custom_types: custom
            .map(parse_custom_property_types_xml)
            .unwrap_or_default(),
    })
}
