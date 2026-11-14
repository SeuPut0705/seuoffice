//! The tree readers of `package.ts` (container, encryption list, package
//! document) and `toc.ts` (navigation document, NCX), with the helpers of
//! `xml.ts` they use. Each takes an element tree in the shape `xml.ts` builds;
//! the parsers that build it (`parseXml`, `parseHtml`) are in `xml.rs`.

use jscompat::{Radix, parse_int, trim, truthy};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{is_font_obfuscation_algorithm, resolve_href};
use crate::xml_positions_types::{MAX_DEPTH, Thrown};

pub const CONTAINER_PATH: &str = "META-INF/container.xml";
pub const RIGHTS_PATH: &str = "META-INF/rights.xml";
pub const ENCRYPTION_PATH: &str = "META-INF/encryption.xml";

const OPF_MEDIA_TYPE: &str = "application/oebps-package+xml";
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
const OPF_NS: &str = "http://www.idpf.org/2007/opf";
const OPS_NS: &str = "http://www.idpf.org/2007/ops";
const SKIP_IN_TITLES: &[&str] = &["rt", "rp"];

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct XmlAttribute {
    pub name: String,
    pub local: String,
    pub uri: Option<String>,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct XmlElement {
    pub name: String,
    pub local: String,
    pub uri: Option<String>,
    pub attributes: Vec<XmlAttribute>,
    pub children: Vec<XmlNode>,
}

/// A tree as deep as a hostile file makes it must not overflow the stack
/// when it is dropped: the children are taken down level by level.
impl Drop for XmlElement {
    fn drop(&mut self) {
        let mut pending = std::mem::take(&mut self.children);
        while let Some(node) = pending.pop() {
            if let XmlNode::Element(mut element) = node {
                pending.append(&mut element.children);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum XmlNode {
    Text(String),
    Element(XmlElement),
}

/// `NotEpubError`: a plain `Error` subclass, so JavaScript names it `Error`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotEpubError(pub String);

/// `el.local.toLowerCase() === ascii`. Final sigma and other context rules
/// cannot make a string equal to an ASCII one, so lowering char by char agrees.
pub fn lower_is(text: &str, ascii: &str) -> bool {
    text.chars().flat_map(char::to_lowercase).eq(ascii.chars())
}

pub fn child_elements(element: &XmlElement) -> impl Iterator<Item = &XmlElement> {
    element.children.iter().filter_map(|node| match node {
        XmlNode::Element(child) => Some(child),
        XmlNode::Text(_) => None,
    })
}

pub fn children_named<'a>(
    element: &'a XmlElement,
    local: &'a str,
) -> impl Iterator<Item = &'a XmlElement> {
    child_elements(element).filter(move |el| el.local == local)
}

/// `walk`: depth first, document order, `element` itself first.
pub fn walk(element: &XmlElement) -> Walk<'_> {
    Walk {
        first: Some(element),
        stack: Vec::new(),
    }
}

pub struct Walk<'a> {
    first: Option<&'a XmlElement>,
    stack: Vec<std::slice::Iter<'a, XmlNode>>,
}

impl<'a> Iterator for Walk<'a> {
    type Item = &'a XmlElement;

    fn next(&mut self) -> Option<&'a XmlElement> {
        if let Some(element) = self.first.take() {
            self.stack.push(element.children.iter());
            return Some(element);
        }
        loop {
            match self.stack.last_mut()?.next() {
                Some(XmlNode::Element(element)) => {
                    self.stack.push(element.children.iter());
                    return Some(element);
                }
                Some(XmlNode::Text(_)) => {}
                None => {
                    self.stack.pop();
                }
            }
        }
    }
}

/// `attr`: by local name; without `uri` the attribute must have none.
pub fn attr<'a>(element: &'a XmlElement, local: &str, uri: Option<&str>) -> Option<&'a str> {
    element
        .attributes
        .iter()
        .find(|a| a.local == local && a.uri.as_deref() == uri)
        .map(|a| a.value.as_str())
}

pub fn attr_by_name<'a>(element: &'a XmlElement, name: &str) -> Option<&'a str> {
    element
        .attributes
        .iter()
        .find(|a| a.name == name)
        .map(|a| a.value.as_str())
}

/// `textContent`: all descendant text, joined, without the elements `skip`
/// names (by lower-cased local name).
pub fn text_content(element: &XmlElement, skip: &[&str]) -> String {
    let mut out = String::new();
    let mut stack = vec![element.children.iter()];
    while let Some(children) = stack.last_mut() {
        match children.next() {
            Some(XmlNode::Text(text)) => out.push_str(text),
            Some(XmlNode::Element(child)) => {
                if !skip.iter().any(|local| lower_is(&child.local, local)) {
                    stack.push(child.children.iter());
                }
            }
            None => {
                stack.pop();
            }
        }
    }
    out
}

fn is_xml_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\n')
}

/// `collapseWhitespace`: runs of XML white space become one space, then one
/// space is dropped at each end.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_xml_space(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    if out.starts_with(' ') {
        out.remove(0);
    }
    out
}

pub fn tokens(value: Option<&str>) -> impl Iterator<Item = &str> {
    value
        .into_iter()
        .flat_map(|v| v.split(is_xml_space))
        .filter(|t| !t.is_empty())
}

/// `packagePathFromContainer`.
pub fn package_path_from_container(container: &XmlElement) -> Result<String, NotEpubError> {
    let rootfiles = || {
        walk(container)
            .filter(|el| el.local == "rootfile" && truthy(attr(el, "full-path", None)).is_some())
    };
    let chosen = rootfiles()
        .find(|el| attr(el, "media-type", None).map(trim) == Some(OPF_MEDIA_TYPE))
        .or_else(|| rootfiles().next());
    match chosen.and_then(|el| resolve_href("", attr(el, "full-path", None).unwrap_or_default())) {
        Some(resolved) if !resolved.path.is_empty() => Ok(resolved.path),
        _ => Err(NotEpubError(format!(
            "{CONTAINER_PATH} names no package document"
        ))),
    }
}

#[derive(Debug, Serialize)]
pub struct EncryptionScan<'a> {
    pub drm: Option<String>,
    pub fonts: Vec<ObfuscatedFont<'a>>,
}

#[derive(Debug, Serialize)]
pub struct ObfuscatedFont<'a> {
    pub path: String,
    pub algorithm: &'a str,
}

/// `scanEncryption`.
pub fn scan_encryption(encryption: &XmlElement) -> EncryptionScan<'_> {
    let drm = |reason: String| EncryptionScan {
        drm: Some(reason),
        fonts: Vec::new(),
    };
    let mut fonts = Vec::new();
    for el in walk(encryption) {
        if el.local == "EncryptionMethod" {
            let algorithm = attr(el, "Algorithm", None).map(trim).unwrap_or_default();
            if !is_font_obfuscation_algorithm(algorithm) {
                let named = if algorithm.is_empty() {
                    "(none)"
                } else {
                    algorithm
                };
                return drm(format!("encryption algorithm {named}"));
            }
        }
        if el.local != "EncryptedData" {
            continue;
        }
        let method = children_named(el, "EncryptionMethod").next();
        let algorithm = method.and_then(|m| attr(m, "Algorithm", None)).map(trim);
        let algorithm = match algorithm {
            Some(a) if !a.is_empty() && is_font_obfuscation_algorithm(a) => a,
            _ => {
                return drm(format!(
                    "encrypted data with algorithm {}",
                    algorithm.unwrap_or("(none)")
                ));
            }
        };
        for reference in walk(el) {
            if reference.local != "CipherReference" {
                continue;
            }
            if let Some(resolved) =
                attr(reference, "URI", None).and_then(|uri| resolve_href("", uri))
                && !resolved.path.is_empty()
            {
                fonts.push(ObfuscatedFont {
                    path: resolved.path,
                    algorithm,
                });
            }
        }
    }
    EncryptionScan { drm: None, fonts }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPackage<'a> {
    pub version: &'static str,
    pub package_version: &'a str,
    pub metadata: Metadata<'a>,
    pub manifest: Vec<ManifestItem<'a>>,
    pub spine_refs: Vec<SpineRef<'a>>,
    pub page_progression_direction: Option<&'a str>,
    pub toc_id: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata<'a> {
    pub title: String,
    pub titles: Vec<String>,
    pub creators: Vec<String>,
    pub languages: Vec<String>,
    pub identifiers: Vec<Identifier<'a>>,
    pub unique_identifier: Option<String>,
    pub layout: &'static str,
    pub primary_writing_mode: Option<&'a str>,
}

#[derive(Debug, Serialize)]
pub struct Identifier<'a> {
    pub id: Option<&'a str>,
    pub value: String,
    pub scheme: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestItem<'a> {
    pub id: &'a str,
    pub href: &'a str,
    pub path: Option<String>,
    pub media_type: &'a str,
    pub properties: Vec<&'a str>,
}

#[derive(Debug, Serialize)]
pub struct SpineRef<'a> {
    pub idref: &'a str,
    pub linear: bool,
    pub properties: Vec<&'a str>,
    pub layout: Option<&'static str>,
}

fn is_dc(el: &XmlElement, local: &str) -> bool {
    lower_is(&el.local, local)
        && (el.uri.as_deref() == Some(DC_NS)
            || el
                .name
                .chars()
                .flat_map(char::to_lowercase)
                .take(3)
                .eq("dc:".chars()))
}

fn layout_value(value: &str) -> Option<&'static str> {
    match value {
        "pre-paginated" => Some("pre-paginated"),
        "reflowable" => Some("reflowable"),
        _ => None,
    }
}

fn itemref_layout(properties: &[&str]) -> Option<&'static str> {
    properties.iter().find_map(|p| match *p {
        "rendition:layout-pre-paginated" => Some("pre-paginated"),
        "rendition:layout-reflowable" => Some("reflowable"),
        _ => None,
    })
}

fn read_metadata(metadata: Option<&XmlElement>) -> Metadata<'_> {
    let mut titles: Vec<(Option<&str>, String)> = Vec::new();
    let mut creators = Vec::new();
    let mut languages = Vec::new();
    let mut identifiers = Vec::new();
    let mut metas: Vec<&XmlElement> = Vec::new();
    for el in metadata.into_iter().flat_map(walk) {
        let value = || trim(&text_content(el, &[])).to_owned();
        if is_dc(el, "title") {
            titles.push((attr(el, "id", None), value()));
        } else if is_dc(el, "creator") {
            creators.push(value());
        } else if is_dc(el, "language") {
            languages.push(value());
        } else if is_dc(el, "identifier") {
            identifiers.push(Identifier {
                id: attr(el, "id", None),
                value: value(),
                scheme: attr(el, "scheme", Some(OPF_NS)).or_else(|| attr_by_name(el, "opf:scheme")),
            });
        } else if el.local == "meta" {
            metas.push(el);
        }
    }

    let main_title_ids: Vec<&str> = metas
        .iter()
        .filter(|m| {
            attr(m, "property", None) == Some("title-type") && trim(&text_content(m, &[])) == "main"
        })
        .filter_map(|m| {
            attr(m, "refines", None)
                .map(trim)
                .map(|r| r.strip_prefix('#').unwrap_or(r))
        })
        .collect();
    let main = titles
        .iter()
        .find(|(id, _)| id.is_some_and(|id| main_title_ids.contains(&id)))
        .or(titles.first());
    let title = main.map(|(_, text)| text.clone()).unwrap_or_default();

    let global_layout = metas.iter().find(|m| {
        attr(m, "property", None) == Some("rendition:layout") && attr(m, "refines", None).is_none()
    });
    let writing_mode = metas
        .iter()
        .copied()
        .find(|m| attr(m, "name", None) == Some("primary-writing-mode"));

    Metadata {
        title,
        titles: titles.into_iter().map(|(_, text)| text).collect(),
        creators,
        languages,
        identifiers,
        unique_identifier: None,
        layout: global_layout
            .and_then(|g| layout_value(&collapse_whitespace(&text_content(g, &[]))))
            .unwrap_or("reflowable"),
        primary_writing_mode: writing_mode
            .and_then(|w| attr(w, "content", None))
            .map(trim),
    }
}

/// `parsePackage`. `find_entry` maps a resolved path to the archive's own
/// entry name, or None.
pub fn parse_package<'a>(
    root: &'a XmlElement,
    opf_path: &str,
    find_entry: impl Fn(&str) -> Option<String>,
) -> Result<ParsedPackage<'a>, NotEpubError> {
    if root.local != "package" {
        return Err(NotEpubError(format!(
            "{opf_path} is not a package document"
        )));
    }
    let manifest_el = children_named(root, "manifest").next();
    let spine_el = children_named(root, "spine").next();
    let Some(manifest_el) = manifest_el else {
        return Err(NotEpubError(format!("{opf_path} has no manifest")));
    };
    let Some(spine_el) = spine_el else {
        return Err(NotEpubError(format!("{opf_path} has no spine")));
    };

    let package_version = attr(root, "version", None).map(trim).unwrap_or_default();
    let major = parse_int(package_version, Radix::Ten);
    let mut metadata = read_metadata(children_named(root, "metadata").next());
    let uid_ref = truthy(attr(root, "unique-identifier", None).map(trim));
    let unique = uid_ref.and_then(|uid| metadata.identifiers.iter().find(|i| i.id == Some(uid)));
    metadata.unique_identifier = unique.map(|i| i.value.clone());

    let mut manifest = Vec::new();
    for item in children_named(manifest_el, "item") {
        let Some(href) = attr(item, "href", None) else {
            continue;
        };
        let resolved = resolve_href(opf_path, href);
        manifest.push(ManifestItem {
            id: attr(item, "id", None).unwrap_or_default(),
            href,
            path: resolved.map(|r| find_entry(&r.path).unwrap_or(r.path)),
            media_type: attr(item, "media-type", None).map(trim).unwrap_or_default(),
            properties: tokens(attr(item, "properties", None)).collect(),
        });
    }

    let spine_refs = children_named(spine_el, "itemref")
        .map(|reference| {
            let properties: Vec<&str> = tokens(attr(reference, "properties", None)).collect();
            let layout = itemref_layout(&properties);
            SpineRef {
                idref: attr(reference, "idref", None).map(trim).unwrap_or_default(),
                linear: attr(reference, "linear", None).map(trim) != Some("no"),
                properties,
                layout,
            }
        })
        .collect();
    let direction = attr(spine_el, "page-progression-direction", None).map(trim);

    Ok(ParsedPackage {
        version: if major >= 3.0 { "3" } else { "2" },
        package_version,
        metadata,
        manifest,
        spine_refs,
        page_progression_direction: direction.filter(|d| matches!(*d, "ltr" | "rtl" | "default")),
        toc_id: truthy(attr(spine_el, "toc", None).map(trim)),
    })
}

/// A table of contents entry before its spine index is known (`RawEntry`).
#[derive(Debug, Serialize)]
pub struct RawEntry {
    pub title: String,
    pub path: Option<String>,
    pub fragment: Option<String>,
    pub depth: u32,
}

pub fn title_of(el: &XmlElement) -> String {
    collapse_whitespace(&text_content(el, SKIP_IN_TITLES))
}

fn entry(title: String, base_path: &str, href: Option<&str>, depth: u32) -> RawEntry {
    let target = href.and_then(|href| resolve_href(base_path, href));
    let (path, fragment) = match target {
        Some(target) => (Some(target.path), target.fragment),
        None => (None, None),
    };
    RawEntry {
        title,
        path,
        fragment,
        depth,
    }
}

fn label_title(label: &XmlElement) -> String {
    let text = title_of(label);
    if !text.is_empty() {
        return text;
    }
    if let Some(titled) = truthy(attr(label, "title", None).map(trim)) {
        return titled.to_owned();
    }
    walk(label)
        .find_map(|el| {
            if lower_is(&el.local, "img") {
                truthy(attr(el, "alt", None).map(trim))
            } else {
                None
            }
        })
        .unwrap_or_default()
        .to_owned()
}

/// `navList`. A list nested deeper than `MAX_DEPTH` is the stack overflow of
/// the TypeScript.
fn nav_list(
    ol: &XmlElement,
    nav_path: &str,
    depth: u32,
    out: &mut Vec<RawEntry>,
) -> Result<(), Thrown> {
    if depth as usize > MAX_DEPTH {
        return Err(Thrown::stack_overflow());
    }
    for li in child_elements(ol) {
        if !lower_is(&li.local, "li") {
            continue;
        }
        if let Some(label) =
            child_elements(li).find(|el| lower_is(&el.local, "a") || lower_is(&el.local, "span"))
        {
            let href = if lower_is(&label.local, "a") {
                attr(label, "href", None)
            } else {
                None
            };
            let item = entry(label_title(label), nav_path, href, depth);
            if !item.title.is_empty() || item.path.is_some() {
                out.push(item);
            }
        }
        if let Some(nested) = child_elements(li).find(|el| lower_is(&el.local, "ol")) {
            nav_list(nested, nav_path, depth + 1, out)?;
        }
    }
    Ok(())
}

/// `navTocEntries`.
pub fn nav_toc_entries(root: &XmlElement, nav_path: &str) -> Result<Vec<RawEntry>, Thrown> {
    for el in walk(root) {
        if !lower_is(&el.local, "nav") {
            continue;
        }
        let kind = attr(el, "type", Some(OPS_NS)).or_else(|| attr_by_name(el, "epub:type"));
        if !tokens(kind).any(|t| t == "toc") {
            continue;
        }
        let mut out = Vec::new();
        if let Some(ol) = walk(el).find(|child| lower_is(&child.local, "ol")) {
            nav_list(ol, nav_path, 1, &mut out)?;
        }
        return Ok(out);
    }
    Ok(Vec::new())
}

fn ncx_points(
    parent: &XmlElement,
    ncx_path: &str,
    depth: u32,
    out: &mut Vec<RawEntry>,
) -> Result<(), Thrown> {
    if depth as usize > MAX_DEPTH {
        return Err(Thrown::stack_overflow());
    }
    for point in child_elements(parent) {
        if !lower_is(&point.local, "navpoint") {
            continue;
        }
        let label = child_elements(point).find(|el| lower_is(&el.local, "navlabel"));
        let text_el =
            label.and_then(|label| child_elements(label).find(|el| lower_is(&el.local, "text")));
        let content = child_elements(point).find(|el| lower_is(&el.local, "content"));
        let item = entry(
            text_el.map(title_of).unwrap_or_default(),
            ncx_path,
            content.and_then(|content| attr(content, "src", None)),
            depth,
        );
        if !item.title.is_empty() || item.path.is_some() {
            out.push(item);
        }
        ncx_points(point, ncx_path, depth + 1, out)?;
    }
    Ok(())
}

/// `ncxEntries`.
pub fn ncx_entries(root: &XmlElement, ncx_path: &str) -> Result<Vec<RawEntry>, Thrown> {
    let mut out = Vec::new();
    if let Some(nav_map) = walk(root).find(|el| lower_is(&el.local, "navmap")) {
        ncx_points(nav_map, ncx_path, 1, &mut out)?;
    }
    Ok(out)
}

/// The `findEntry` the gate gives `parsePackage`: `Archive.find` of `open.ts`
/// over a list of file entry names. The paths it is asked for come from
/// `resolveHref` and are already normalized, so it does not normalize again.
struct Entries<'a> {
    names: Vec<&'a str>,
    by_lower_case: Vec<(String, &'a str)>,
}

impl<'a> Entries<'a> {
    fn new(names: Vec<&'a str>) -> Self {
        let mut by_lower_case: Vec<(String, &'a str)> = Vec::new();
        for name in &names {
            let lower = name.to_lowercase();
            if !by_lower_case.iter().any(|(seen, _)| *seen == lower) {
                by_lower_case.push((lower, *name));
            }
        }
        Entries {
            names,
            by_lower_case,
        }
    }

    fn find(&self, path: &str) -> Option<String> {
        if self.names.contains(&path) {
            return Some(path.to_owned());
        }
        let lower = path.to_lowercase();
        self.by_lower_case
            .iter()
            .find(|(seen, _)| *seen == lower)
            .map(|(_, name)| (*name).to_owned())
    }
}

type CallError = (String, String);

fn not_epub(error: NotEpubError) -> CallError {
    ("Error".to_owned(), error.0)
}

fn bad_argument(message: String) -> CallError {
    ("ArgumentError".to_owned(), message)
}

fn json(value: impl Serialize) -> Result<Value, CallError> {
    serde_json::to_value(value).map_err(|error| ("Error".to_owned(), error.to_string()))
}

/// The gate's entry: `args.tree` is the element tree, plus `opfPath` and
/// `entries` (`parsePackage`), `navPath` (`navTocEntries`) or `ncxPath`
/// (`ncxEntries`).
pub fn call(function: &str, _text: &str, _bytes: &[u8], args: &Value) -> Result<Value, CallError> {
    let tree = || {
        let tree = args
            .get("tree")
            .ok_or_else(|| bad_argument("args.tree is missing".to_owned()))?;
        XmlElement::deserialize(tree).map_err(|error| bad_argument(format!("args.tree: {error}")))
    };
    let string = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| bad_argument(format!("args.{key} is not a string")))
    };
    match function {
        "packagePathFromContainer" => package_path_from_container(&tree()?)
            .map(Value::String)
            .map_err(not_epub),
        "scanEncryption" => json(scan_encryption(&tree()?)),
        "parsePackage" => {
            let names = args
                .get("entries")
                .and_then(Value::as_array)
                .and_then(|entries| {
                    entries
                        .iter()
                        .map(Value::as_str)
                        .collect::<Option<Vec<&str>>>()
                })
                .ok_or_else(|| bad_argument("args.entries is not a list of strings".to_owned()))?;
            let entries = Entries::new(names);
            let root = tree()?;
            json(
                parse_package(&root, string("opfPath")?, |path| entries.find(path))
                    .map_err(not_epub)?,
            )
        }
        "navTocEntries" => json(
            nav_toc_entries(&tree()?, string("navPath")?)
                .map_err(|error| (error.name, error.message))?,
        ),
        "ncxEntries" => json(
            ncx_entries(&tree()?, string("ncxPath")?)
                .map_err(|error| (error.name, error.message))?,
        ),
        _ => Err(bad_argument(format!(
            "unknown epub package function: {function}"
        ))),
    }
}
