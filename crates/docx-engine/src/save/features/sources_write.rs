//! The write half of sources.ts: the bibliography part (b:Sources) a document
//! keeps in customXml. The reader and the citation texts are in
//! `crate::sources`.

use std::collections::HashMap;

use jscompat::{js_regex, trim, try_js_regex};

use crate::generate::escape_xml_text;
use crate::model::SourceInfo;
use crate::sources::{SOURCES_NS, parse_sources_xml};

/// `sourceEntryXml`
fn source_entry_xml(source: &SourceInfo) -> String {
    let t = |tag: &str, value: Option<&str>| match value.filter(|value| !value.is_empty()) {
        Some(value) => format!("<b:{tag}>{}</b:{tag}>", escape_xml_text(value)),
        None => String::new(),
    };
    // "Last, First" splits into Last/First; anything else is stored as Last
    let comma = source.author.find(',');
    let last = match comma {
        None => source.author.as_str(),
        Some(at) => trim(&source.author[..at]),
    };
    let first = match comma {
        None => "",
        Some(at) => trim(&source.author[at + 1..]),
    };
    let author_xml = if source.author.is_empty() {
        String::new()
    } else {
        format!(
            "<b:Author><b:Author><b:NameList><b:Person>{}{}</b:Person></b:NameList></b:Author></b:Author>",
            t("Last", Some(last)),
            t("First", Some(first))
        )
    };
    let publisher_tag = match source.r#type.as_str() {
        "JournalArticle" => "JournalName",
        "InternetSite" => "InternetSiteTitle",
        _ => "Publisher",
    };
    format!(
        "<b:Source>{}{}{author_xml}{}{}{}{}</b:Source>",
        t("Tag", Some(&source.tag)),
        t("SourceType", Some(&source.r#type)),
        t("Title", Some(&source.title)),
        t("Year", Some(&source.year)),
        t(publisher_tag, source.publisher.as_deref()),
        t("URL", source.url.as_deref()),
    )
}

/// `buildSourcesXml`: surgical rebuild of b:Sources: unchanged b:Source
/// entries keep their original bytes (unmodeled fields like
/// Editor/Volume/Pages/DOI/multi-author lists are preserved), the root element
/// attributes (SelectedStyle citation style) come from the original document,
/// and only new/edited entries are rebuilt from the modeled fields.
pub fn build_sources_xml(
    sources: &[SourceInfo],
    original_xml: Option<&str>,
) -> Result<String, String> {
    let mut originals: HashMap<String, (String, crate::sources::SourceInfo)> = HashMap::new();
    let mut root_open = format!(
        "<b:Sources SelectedStyle=\"\\APASixthEditionOfficeOnline.xsl\" StyleName=\"APA\" Version=\"6\" xmlns:b=\"{SOURCES_NS}\" xmlns=\"{SOURCES_NS}\">"
    );
    if let Some(original_xml) = original_xml.filter(|xml| !xml.is_empty()) {
        if let Some(open) = js_regex!(r"<b:Sources(?:\s[^>]*)?>").exec(original_xml) {
            root_open = open.as_str().to_owned();
        }
        for found in
            try_js_regex!(r"<b:Source>[\s\S]*?<\/b:Source>", "g").try_find_iter(original_xml)
        {
            let found = found.map_err(|limit| limit.to_string())?;
            if let Some(parsed) = parse_sources_xml(found.as_str()).into_iter().next() {
                originals.insert(parsed.tag.clone(), (found.as_str().to_owned(), parsed));
            }
        }
    }
    let unchanged = |a: &crate::sources::SourceInfo, b: &SourceInfo| {
        a.kind == b.r#type
            && a.author == b.author
            && a.title == b.title
            && a.year == b.year
            && a.publisher.as_deref().unwrap_or("") == b.publisher.as_deref().unwrap_or("")
            && a.url.as_deref().unwrap_or("") == b.url.as_deref().unwrap_or("")
    };
    let body: String = sources
        .iter()
        .map(|source| match originals.get(&source.tag) {
            Some((xml, parsed)) if unchanged(parsed, source) => xml.clone(),
            _ => source_entry_xml(source),
        })
        .collect();
    Ok(format!("{root_open}{body}</b:Sources>"))
}

/// `buildSourcesItemPropsXml`
pub fn build_sources_item_props_xml() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<ds:datastoreItem ds:itemID=\"{{4A8D2934-D5B1-4C15-A6F4-7A1B2C3D4E5F}}\" xmlns:ds=\"http://schemas.openxmlformats.org/officeDocument/2006/customXml\"><ds:schemaRefs><ds:schemaRef ds:uri=\"{SOURCES_NS}\"/></ds:schemaRefs></ds:datastoreItem>"
    )
}
