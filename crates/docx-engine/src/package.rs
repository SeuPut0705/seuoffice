//! The package-level readers `parseDocx` runs before it reaches the body:
//! relationships, the main part, content types
//! (packages/docx-engine/src/parse-package.ts and `contentTypesOf` of parse.ts).

use std::borrow::Cow;

use jscompat::{JsMap, decode_uri_component, js_regex, truthy, try_js_regex};
use ooxml_pkg::{Package, canonical_xml_syntax};
use ooxml_xml::{XNode, parse_ordered};
use serde::{Deserialize, Serialize};

use crate::props::XML_PARSER_MAX_NESTED_TAGS;

/// What a reader throws in TypeScript: a part that cannot be read, or XML the
/// parser refuses. Only that it throws is part of the contract.
pub type Thrown = String;

/// `xmlParser.parse(xml)`
pub fn parse_part(xml: &str) -> Result<Vec<XNode>, Thrown> {
    parse_ordered(xml, XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())
}

/// `await zip.file(path)?.async('string')`
pub fn part_text<'a>(package: &'a Package, path: &str) -> Result<Option<&'a str>, Thrown> {
    package.text(path).map_err(|error| error.to_string())
}

/// `partText` of parse.ts: the text of a part that is only read, written the
/// usual way (see `canonicalXmlSyntax`). The document part and the parts the
/// save path splices keep their bytes.
pub fn canonical_part_text<'a>(
    package: &'a Package,
    path: &str,
) -> Result<Option<Cow<'a, str>>, Thrown> {
    Ok(part_text(package, path)?.map(canonical_xml_syntax))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelInfo {
    pub target: String,
    #[serde(rename = "type")]
    pub rel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_mode: Option<String>,
}

/// The relationships part next to `part_path`.
pub fn rels_path_of(part_path: &str) -> String {
    js_regex!(r"([^/]+)$").exec(part_path).map_or_else(
        || part_path.to_owned(),
        |name| format!("{}_rels/{}.rels", &part_path[..name.start()], name.as_str()),
    )
}

/// Relationships by id, in document order.
pub fn parse_rels(package: &Package, path: &str) -> Result<JsMap<RelInfo>, Thrown> {
    let mut rels = JsMap::new();
    let Some(text) = part_text(package, path)? else {
        return Ok(rels);
    };
    // the parser rejects a DOCTYPE; the prologue is dropped so the document
    // still opens (entities never resolve, and a Relationship carries
    // everything in attributes)
    let doctype = try_js_regex!(
        r#"<!DOCTYPE(?:[^>"'\x5B\x5D]|\[[\s\S]*?\]|"[^"]*"|'[^']*')*>"#,
        "i"
    );
    let rels_xml = match doctype.try_exec(text).map_err(|limit| limit.to_string())? {
        Some(found) => format!("{}{}", &text[..found.start()], &text[found.end()..]),
        None => text.to_owned(),
    };
    let parsed = parse_part(&rels_xml)?;
    let Some(root) = parsed
        .iter()
        .find(|node| node.name() == Some("Relationships"))
    else {
        return Ok(rels);
    };
    for rel_node in root.find_children("Relationship") {
        let Some(id) = truthy(rel_node.attr("Id")) else {
            continue;
        };
        rels.set(
            id,
            RelInfo {
                target: rel_node.attr("Target").unwrap_or("").to_owned(),
                rel_type: rel_node.attr("Type").unwrap_or("").to_owned(),
                target_mode: rel_node.attr("TargetMode").map(str::to_owned),
            },
        );
    }
    Ok(rels)
}

/// The part a relationship target names, relative to the part that owns the
/// relationship. `None` for an external target, a target that is not a valid
/// escape sequence, or one that climbs out of the package.
pub fn resolve_relationship_target_path(source_path: &str, target: &str) -> Option<String> {
    let without_fragment = target.split('#').next().unwrap_or("");
    if without_fragment.is_empty() || js_regex!(r"^[A-Za-z][A-Za-z0-9+.-]*:").test(without_fragment)
    {
        return None;
    }
    let decoded = decode_uri_component(without_fragment).ok()?;
    let base = source_path
        .rfind('/')
        .map_or("", |slash| &source_path[..=slash]);
    // the root anchor is tested after normalizing: a backslash-led target is rooted too
    let normalized = decoded.replace('\\', "/");
    let path = match normalized.strip_prefix('/') {
        Some(rooted) => rooted.to_owned(),
        None => format!("{base}{normalized}"),
    };
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(segment),
        }
    }
    let joined = parts.join("/");
    (!joined.is_empty()).then_some(joined)
}

/// The main document part: word/document.xml when present, else the target
/// of the package-level officeDocument relationship.
pub fn resolve_main_document_path(package: &Package) -> Result<Option<String>, Thrown> {
    if package.has("word/document.xml") {
        return Ok(Some("word/document.xml".to_owned()));
    }
    let rels = parse_rels(package, "_rels/.rels")?;
    for rel in rels.values() {
        if !rel.rel_type.ends_with("/officeDocument")
            || rel.target_mode.as_deref() == Some("External")
        {
            continue;
        }
        if let Some(target) = resolve_relationship_target_path("", &rel.target)
            && package.has(&target)
        {
            return Ok(Some(target));
        }
    }
    Ok(None)
}

#[derive(Debug, Default, Serialize)]
pub struct ContentTypes {
    /// Lower-cased extension to content type.
    pub defaults: JsMap<String>,
    /// Part name to content type.
    pub overrides: JsMap<String>,
}

/// `contentTypesOf` of parse.ts: [Content_Types].xml as two tables.
pub fn content_types_of(package: &Package) -> Result<ContentTypes, Thrown> {
    let mut types = ContentTypes::default();
    let Some(text) = part_text(package, "[Content_Types].xml")? else {
        return Ok(types);
    };
    let parsed = parse_part(text)?;
    let Some(root) = parsed.iter().find(|node| node.name() == Some("Types")) else {
        return Ok(types);
    };
    for node in root.find_children("Default") {
        let extension = node.attr("Extension").map(str::to_lowercase);
        if let (Some(extension), Some(content_type)) = (
            truthy(extension.as_deref()),
            truthy(node.attr("ContentType")),
        ) {
            types.defaults.set(extension, content_type.to_owned());
        }
    }
    for node in root.find_children("Override") {
        if let (Some(part_name), Some(content_type)) = (
            truthy(node.attr("PartName")),
            truthy(node.attr("ContentType")),
        ) {
            types.overrides.set(part_name, content_type.to_owned());
        }
    }
    Ok(types)
}
