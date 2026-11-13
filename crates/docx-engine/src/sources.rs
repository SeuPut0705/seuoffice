//! The read side of the bibliography sources (`sources.ts`): a customXml
//! part in Word's b:Sources schema, and the citation and bibliography texts
//! made from one source.

use jscompat::{JsRegex, js_regex, trim};
use ooxml_pkg::{Package, ReadError};
use serde::{Deserialize, Serialize};

pub const SOURCES_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography";

pub const CUSTOM_XML_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml";

/// One b:Source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceInfo {
    /// b:Tag, unique
    pub tag: String,
    /// b:SourceType: "Book", "JournalArticle", "InternetSite", "Report"...
    #[serde(rename = "type")]
    pub kind: String,
    /// "Last, First", or b:Corporate
    pub author: String,
    pub title: String,
    pub year: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// `findSourcesPart`: the name of the first customXml item that holds
/// b:Sources, in the order of the package's entries.
pub fn find_sources_part(package: &Package) -> Result<Option<String>, ReadError> {
    let item = js_regex!(r"^customXml\/item\d+\.xml$");
    for part in package.parts() {
        if !item.test(&part.name) {
            continue;
        }
        let xml = part.text()?;
        if xml.contains("Sources") && xml.contains(SOURCES_NS) {
            return Ok(Some(part.name.to_string()));
        }
    }
    Ok(None)
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The trimmed, decoded text of the first such element of a b:Source; `None`
/// where it is missing or empty, `Some("")` where it holds only white space.
fn field(body: &str, element: &JsRegex) -> Option<String> {
    let text = element.exec(body)?.get(1)?;
    (!text.is_empty()).then(|| decode_entities(trim(text)))
}

/// `parseSourcesXml`
pub fn parse_sources_xml(xml: &str) -> Vec<SourceInfo> {
    let mut out = Vec::new();
    for source in js_regex!(r"<b:Source>([\s\S]*?)<\/b:Source>").find_iter(xml) {
        let body = source.get(1).unwrap_or("");
        let Some(tag) =
            field(body, js_regex!(r"<b:Tag>([\s\S]*?)</b:Tag>")).filter(|tag| !tag.is_empty())
        else {
            continue;
        };
        // author: person name list (Last, First) or corporate name
        let mut author =
            field(body, js_regex!(r"<b:Corporate>([\s\S]*?)</b:Corporate>")).unwrap_or_default();
        if author.is_empty() {
            let last = field(body, js_regex!(r"<b:Last>([\s\S]*?)</b:Last>")).unwrap_or_default();
            let first =
                field(body, js_regex!(r"<b:First>([\s\S]*?)</b:First>")).unwrap_or_default();
            author = [last, first]
                .into_iter()
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
        }
        out.push(SourceInfo {
            tag,
            kind: field(body, js_regex!(r"<b:SourceType>([\s\S]*?)</b:SourceType>"))
                .unwrap_or_else(|| "Misc".to_owned()),
            author,
            title: field(body, js_regex!(r"<b:Title>([\s\S]*?)</b:Title>")).unwrap_or_default(),
            year: field(body, js_regex!(r"<b:Year>([\s\S]*?)</b:Year>")).unwrap_or_default(),
            publisher: field(body, js_regex!(r"<b:Publisher>([\s\S]*?)</b:Publisher>"))
                .or_else(|| {
                    field(
                        body,
                        js_regex!(r"<b:JournalName>([\s\S]*?)</b:JournalName>"),
                    )
                })
                .or_else(|| {
                    field(
                        body,
                        js_regex!(r"<b:InternetSiteTitle>([\s\S]*?)</b:InternetSiteTitle>"),
                    )
                }),
            url: field(body, js_regex!(r"<b:URL>([\s\S]*?)</b:URL>")),
        });
    }
    out
}

/// `citationText`: the in-text citation, "(Smith, 2024)".
pub fn citation_text(source: &SourceInfo) -> String {
    let author = if source.author.is_empty() {
        &source.title
    } else {
        &source.author
    };
    if source.year.is_empty() {
        format!("({author})")
    } else {
        format!("({author}, {})", source.year)
    }
}

/// `bibliographyLine`: one bibliography line in a simple APA-like format.
pub fn bibliography_line(source: &SourceInfo) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !source.author.is_empty() {
        parts.push(format!("{}.", source.author));
    }
    if !source.year.is_empty() {
        parts.push(format!("({}).", source.year));
    }
    if !source.title.is_empty() {
        parts.push(format!("{}.", source.title));
    }
    if let Some(publisher) = source.publisher.as_deref().filter(|p| !p.is_empty()) {
        parts.push(format!("{publisher}."));
    }
    if let Some(url) = source.url.as_deref().filter(|url| !url.is_empty()) {
        parts.push(url.to_owned());
    }
    parts.join(" ")
}
