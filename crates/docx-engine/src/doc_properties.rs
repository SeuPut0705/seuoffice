//! The read side of the docProps parts (`doc-properties.ts`): core.xml,
//! app.xml and custom.xml, each read by pattern, not by an XML parser. The
//! Zotero document data kept in custom.xml is in [`zotero`].

pub mod zotero;

use std::sync::LazyLock;

use jscompat::{JsObject, RegexLimit, TryJsRegex, js_regex};
use ooxml_pkg::{Package, ReadError};
use serde::Serialize;

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
/// `setOwn(out, key, value)`.
pub type Record = JsObject<String>;

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
fn element_re(local: &str) -> TryJsRegex {
    TryJsRegex::new(
        &format!(
            r"<([A-Za-z_][\w.-]*:)?{local}(?=[\s/>])([^>]*?)(?:/>|>([\s\S]*?)</([A-Za-z_][\w.-]*:)?{local}\s*>)"
        ),
        "",
    )
    .expect("a pattern built from a table entry compiles")
}

static CORE_ELEMENTS: LazyLock<Vec<(&str, TryJsRegex)>> = LazyLock::new(|| {
    CORE_PROPERTIES
        .iter()
        .map(|(key, local)| (*key, element_re(local)))
        .collect()
});

static APP_ELEMENTS: LazyLock<Vec<(&str, TryJsRegex)>> = LazyLock::new(|| {
    APP_PROPERTIES
        .iter()
        .map(|(key, local)| (*key, element_re(local)))
        .collect()
});

/// The text of each element a table names, where the part carries it.
fn element_texts(xml: &str, elements: &[(&str, TryJsRegex)]) -> Result<Record, RegexLimit> {
    let mut out = Record::default();
    for (key, element) in elements {
        if let Some(found) = element.try_exec(xml)? {
            out.set(*key, decode_xml_text(found.get(3).unwrap_or("")));
        }
    }
    Ok(out)
}

/// `parseCorePropertiesXml`: the core properties of a core.xml part.
pub fn parse_core_properties_xml(xml: &str) -> Result<Record, RegexLimit> {
    element_texts(xml, &CORE_ELEMENTS)
}

/// `parseAppPropertiesXml`: the extended properties of an app.xml part.
pub fn parse_app_properties_xml(xml: &str) -> Result<Record, RegexLimit> {
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
    // a part whose search passes the regex bound cannot be read
    let unreadable = |part: &str| {
        let part = part.to_owned();
        move |limit: RegexLimit| ReadError {
            part,
            reason: limit.to_string(),
        }
    };
    Ok(DocumentProperties {
        core: core
            .map(parse_core_properties_xml)
            .transpose()
            .map_err(unreadable(CORE_PROPERTIES_PATH))?
            .unwrap_or_default(),
        app: app
            .map(parse_app_properties_xml)
            .transpose()
            .map_err(unreadable(APP_PROPERTIES_PATH))?
            .unwrap_or_default(),
        custom: custom.map(parse_custom_properties_xml).unwrap_or_default(),
        custom_types: custom
            .map(parse_custom_property_types_xml)
            .unwrap_or_default(),
    })
}
