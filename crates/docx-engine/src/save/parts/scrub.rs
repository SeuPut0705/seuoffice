//! The personal-information scrub of patch.ts: author names, initials and the
//! people part, rewritten start tag by start tag so that text, CDATA,
//! comments and processing instructions stay byte-identical.

use jscompat::{RegexError, RegexLimit, TryJsRegex, regex_escape};
use ooxml_pkg::Package;

use super::markup::{namespace_prefixes, opaque_markup_end, xml_tag_end};
use super::thrown;
use crate::doc_properties::CORE_PROPERTIES_PATH;
use crate::xml_tag::{TagName, find_start_tag};

const WORDPROCESSINGML_NAMESPACES: [&str; 2] = [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
];
const CORE_PROPERTIES_NAMESPACE: &str =
    "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DUBLIN_CORE_NAMESPACE: &str = "http://purl.org/dc/elements/1.1/";
const EXTENDED_PROPERTIES_NAMESPACES: [&str; 2] = [
    "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
    "http://purl.oclc.org/ooxml/officeDocument/extendedProperties",
];
const PEOPLE_NAMESPACE: &str = "http://schemas.microsoft.com/office/word/2012/wordml";

/// `mapXmlStartTags`: rewrite start tags only; text, CDATA, comments and
/// processing instructions stay byte-identical.
pub fn map_xml_start_tags(
    xml: &str,
    mut rewrite: impl FnMut(&str) -> Result<String, RegexLimit>,
) -> Result<String, RegexLimit> {
    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0;
    while cursor < xml.len() {
        let Some(offset) = xml[cursor..].find('<') else {
            out.push_str(&xml[cursor..]);
            return Ok(out);
        };
        let start = cursor + offset;
        out.push_str(&xml[cursor..start]);
        if let Some(opaque_end) = opaque_markup_end(xml, start) {
            out.push_str(&xml[start..opaque_end]);
            cursor = opaque_end;
            continue;
        }
        let end = xml_tag_end(xml, start);
        let tag = &xml[start..end];
        if tag.starts_with("</") || tag.starts_with("<!") {
            out.push_str(tag);
        } else {
            out.push_str(&rewrite(tag)?);
        }
        cursor = end;
    }
    Ok(out)
}

/// The alternation of `names` as a pattern: each escaped, joined by `|`.
fn alternation<'a>(names: impl Iterator<Item = &'a str>) -> String {
    names.map(regex_escape).collect::<Vec<_>>().join("|")
}

fn replacement_of<'a>(replacements: &[(&'a str, &'a str)], local_name: &str) -> &'a str {
    replacements
        .iter()
        .find(|(name, _)| *name == local_name)
        .map_or("", |(_, value)| value)
}

/// `replaceQualifiedAttributes`
pub fn replace_qualified_attributes(
    xml: &str,
    prefixes: &[String],
    replacements: &[(&str, &str)],
) -> Result<String, RegexError> {
    let qualified: Vec<&str> = prefixes
        .iter()
        .map(String::as_str)
        .filter(|prefix| !prefix.is_empty())
        .collect();
    if qualified.is_empty() {
        return Ok(xml.to_owned());
    }
    let prefix_pattern = alternation(qualified.into_iter());
    let local_pattern = alternation(replacements.iter().map(|(name, _)| *name));
    let attribute = TryJsRegex::new(
        &format!(r#"(\b(?:{prefix_pattern}):({local_pattern})\s*=\s*)(["'])([\s\S]*?)\3"#),
        "",
    )?;
    Ok(map_xml_start_tags(xml, |tag| {
        attribute.try_replace_all(tag, |found| {
            format!(
                "{}{}{}{}",
                found.get(1).unwrap_or_default(),
                found.get(3).unwrap_or_default(),
                replacement_of(replacements, found.get(2).unwrap_or_default()),
                found.get(3).unwrap_or_default(),
            )
        })
    })?)
}

/// `replaceUnqualifiedAttributes`
pub fn replace_unqualified_attributes(
    xml: &str,
    replacements: &[(&str, &str)],
) -> Result<String, RegexError> {
    let local_pattern = alternation(replacements.iter().map(|(name, _)| *name));
    let attribute = TryJsRegex::new(
        &format!(r#"(\s({local_pattern})\s*=\s*)(["'])([\s\S]*?)\3"#),
        "",
    )?;
    Ok(map_xml_start_tags(xml, |tag| {
        attribute.try_replace_all(tag, |found| {
            format!(
                "{}{}{}{}",
                found.get(1).unwrap_or_default(),
                found.get(3).unwrap_or_default(),
                replacement_of(replacements, found.get(2).unwrap_or_default()),
                found.get(3).unwrap_or_default(),
            )
        })
    })?)
}

/// `clearQualifiedElements`: the content of every element named `local_names`
/// under a prefix bound to one of `namespaces` is emptied.
pub fn clear_qualified_elements(
    xml: &str,
    namespaces: &[&str],
    local_names: &[&str],
) -> Result<String, RegexError> {
    let mut q_names = Vec::new();
    for prefix in namespace_prefixes(xml, namespaces) {
        for local_name in local_names {
            q_names.push(if prefix.is_empty() {
                (*local_name).to_owned()
            } else {
                format!("{prefix}:{local_name}")
            });
        }
    }
    let mut out = xml.to_owned();
    for q_name in &q_names {
        let close = TryJsRegex::new(&format!(r"<\/{}\s*>", regex_escape(q_name)), "")?;
        let mut from = 0;
        while let Some(tag) = find_start_tag(&out, TagName::Exact(q_name), from) {
            let tag_end = tag.end;
            from = tag_end;
            if tag.self_closing {
                continue;
            }
            // the close tag at or after the end of the start tag: the pattern reads nothing before it
            let Some(end) = close.try_exec(&out[tag_end..])? else {
                break;
            };
            let end_at = tag_end + end.start();
            out.replace_range(tag_end..end_at, "");
        }
    }
    Ok(out)
}

/// `scrubWordprocessingMetadata`
pub fn scrub_wordprocessing_metadata(xml: &str) -> Result<String, RegexError> {
    let prefixes = namespace_prefixes(xml, &WORDPROCESSINGML_NAMESPACES);
    if prefixes.is_empty() {
        return Ok(xml.to_owned());
    }
    let replacements = [("author", "Author"), ("initials", "A")];
    replace_unqualified_attributes(
        &replace_qualified_attributes(xml, &prefixes, &replacements)?,
        &replacements,
    )
}

/// `scrubPeopleMetadata`
pub fn scrub_people_metadata(xml: &str) -> Result<String, RegexError> {
    let prefixes = namespace_prefixes(xml, &[PEOPLE_NAMESPACE]);
    if prefixes.is_empty() {
        return Ok(xml.to_owned());
    }
    let mut out = xml.to_owned();
    for prefix in prefixes {
        let q_name = if prefix.is_empty() {
            "person".to_owned()
        } else {
            format!("{prefix}:person")
        };
        let escaped = regex_escape(&q_name);
        let person = TryJsRegex::new(
            &format!(r"<{escaped}\b[^>]*(?:\/\s*>|>[\s\S]*?<\/{escaped}\s*>)"),
            "",
        )?;
        out = person.try_replace_all(&out, |_| String::new())?;
    }
    Ok(out)
}

/// `scrubPersonalMetadata`: the strict final-package scrub. It runs after
/// generated and copy-through parts are assembled, so headers, footers, notes,
/// glossary and people data all receive the same namespace-aware treatment.
/// Custom XML/properties and binary parts are deliberately untouched.
pub fn scrub_personal_metadata(zip: &mut Package) -> Result<(), String> {
    let names: Vec<(String, bool)> = zip
        .parts()
        .iter()
        .map(|part| (part.name.clone(), part.is_dir))
        .collect();
    for (name, is_dir) in names {
        if is_dir || !name.to_ascii_lowercase().ends_with(".xml") {
            continue;
        }
        let is_custom_data = name.starts_with("customXml/") || name == "docProps/custom.xml";
        let is_core = name == CORE_PROPERTIES_PATH;
        let is_app = name == "docProps/app.xml";
        let is_people = name == "word/people.xml";
        if is_custom_data {
            continue;
        }
        let original = match zip.text(&name).map_err(thrown)? {
            Some(text) => text.to_owned(),
            None => continue,
        };
        let mut scrubbed = scrub_wordprocessing_metadata(&original).map_err(thrown)?;
        if is_core {
            scrubbed = clear_qualified_elements(&scrubbed, &[DUBLIN_CORE_NAMESPACE], &["creator"])
                .map_err(thrown)?;
            scrubbed = clear_qualified_elements(
                &scrubbed,
                &[CORE_PROPERTIES_NAMESPACE],
                &["lastModifiedBy"],
            )
            .map_err(thrown)?;
        }
        if is_app {
            scrubbed = clear_qualified_elements(
                &scrubbed,
                &EXTENDED_PROPERTIES_NAMESPACES,
                &["Manager", "Company"],
            )
            .map_err(thrown)?;
        }
        if is_people {
            scrubbed = scrub_people_metadata(&scrubbed).map_err(thrown)?;
        }
        if scrubbed != original {
            zip.set_file(name, scrubbed.into_bytes());
        }
    }
    Ok(())
}
