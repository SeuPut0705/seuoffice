//! `xml.ts`: the element tree of the book's own XML files, built with saxes
//! (`parseXml`) or, for markup only a browser parser accepts, by the host's
//! parse5 (`parseHtml`). The tree and the helpers that read it are in
//! `package.rs`; they are re-exported here under the names of `xml.ts`.
//!
//! Namespaces are resolved here rather than by saxes, which runs with
//! `xmlns: false`, so that an undeclared prefix leaves the name without a
//! namespace instead of failing the whole file.

use saxes::{Attribute, Error as SaxError, Handler, HandlerResult, Options, Parser, Str, Tag};
use serde_json::{Value, json};

pub use crate::package::{
    XmlAttribute, XmlElement, XmlNode, attr, attr_by_name, child_elements, collapse_whitespace,
    text_content, tokens, walk,
};
use crate::xml_positions_types::Thrown;

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";

/// HTML named entities often found in navigation documents and titles, which
/// XML without a DTD does not define. A file using any other undefined entity
/// fails to parse.
const EXTRA_ENTITIES: [(&str, &str); 21] = [
    ("nbsp", "\u{a0}"),
    ("ensp", "\u{2002}"),
    ("emsp", "\u{2003}"),
    ("thinsp", "\u{2009}"),
    ("zwnj", "\u{200c}"),
    ("zwj", "\u{200d}"),
    ("shy", "\u{ad}"),
    ("ndash", "\u{2013}"),
    ("mdash", "\u{2014}"),
    ("lsquo", "\u{2018}"),
    ("rsquo", "\u{2019}"),
    ("ldquo", "\u{201c}"),
    ("rdquo", "\u{201d}"),
    ("laquo", "\u{ab}"),
    ("raquo", "\u{bb}"),
    ("hellip", "\u{2026}"),
    ("middot", "\u{b7}"),
    ("bull", "\u{2022}"),
    ("copy", "\u{a9}"),
    ("reg", "\u{ae}"),
    ("trade", "\u{2122}"),
];

/// `splitName`: the prefix and the local part, split at the first colon.
fn split_name(name: &str) -> (&str, &str) {
    match name.find(':') {
        None => ("", name),
        Some(colon) => (&name[..colon], &name[colon + 1..]),
    }
}

/// An error of saxes as what the TypeScript throws.
pub(crate) fn thrown(error: SaxError) -> Thrown {
    Thrown::new(error.name, error.message_lossy())
}

/// What a step of the host threw.
pub(crate) fn host_thrown(error: seu_host::HostError) -> Thrown {
    Thrown::new(&error.name, error.message)
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// The handlers of `parseXml`.
struct TreeBuilder {
    /// `scopes`: the prefixes each open element declares, the first being the
    /// `xml` prefix. A prefix set again in one scope replaces the earlier one,
    /// which a search from the end finds.
    scopes: Vec<Vec<(String, String)>>,
    stack: Vec<XmlElement>,
    root: Option<XmlElement>,
}

impl TreeBuilder {
    fn new() -> Self {
        Self {
            scopes: vec![vec![("xml".to_owned(), XML_NS.to_owned())]],
            stack: Vec::new(),
            root: None,
        }
    }

    /// `lookup`: the namespace the innermost declaration of a prefix gives.
    fn lookup(&self, prefix: &str) -> Option<String> {
        for scope in self.scopes.iter().rev() {
            if let Some((_, uri)) = scope.iter().rev().find(|(name, _)| name == prefix) {
                return if uri.is_empty() {
                    None
                } else {
                    Some(uri.clone())
                };
            }
        }
        None
    }

    fn add_text(&mut self, text: &[u16]) {
        if let Some(parent) = self.stack.last_mut() {
            parent.children.push(XmlNode::Text(text_of(text)));
        }
    }
}

impl Handler for TreeBuilder {
    fn wants_text(&self) -> bool {
        true
    }

    fn wants_error(&self) -> bool {
        true
    }

    fn error(&mut self, _cx: &mut Parser, error: &SaxError) -> HandlerResult {
        Err(error.clone())
    }

    fn entity(&mut self, name: &[u16]) -> Result<Option<Str>, SaxError> {
        let name = String::from_utf16(name).ok();
        Ok(EXTRA_ENTITIES
            .iter()
            .find(|(known, _)| Some(*known) == name.as_deref())
            .map(|(_, value)| value.encode_utf16().collect()))
    }

    fn opentag(&mut self, _cx: &mut Parser, tag: &Tag) -> HandlerResult {
        let raw: Vec<(String, String)> = tag
            .attributes
            .iter()
            .map(|Attribute { name, value, .. }| (text_of(name), text_of(value)))
            .collect();
        let mut scope = Vec::new();
        for (name, value) in &raw {
            if name == "xmlns" {
                scope.push((String::new(), value.clone()));
            } else if let Some(prefix) = name.strip_prefix("xmlns:") {
                scope.push((prefix.to_owned(), value.clone()));
            }
        }
        self.scopes.push(scope);
        let name = text_of(&tag.name);
        let (prefix, local) = split_name(&name);
        let attributes = raw
            .iter()
            .filter(|(name, _)| name != "xmlns" && !name.starts_with("xmlns:"))
            .map(|(name, value)| {
                let (prefix, local) = split_name(name);
                XmlAttribute {
                    name: name.clone(),
                    local: local.to_owned(),
                    uri: if prefix.is_empty() {
                        None
                    } else {
                        self.lookup(prefix)
                    },
                    value: value.clone(),
                }
            })
            .collect();
        let element = XmlElement {
            uri: self.lookup(prefix),
            local: local.to_owned(),
            name,
            attributes,
            children: Vec::new(),
        };
        self.stack.push(element);
        Ok(())
    }

    fn closetag(&mut self, _cx: &mut Parser, _tag: &Tag) -> HandlerResult {
        if let Some(element) = self.stack.pop() {
            match self.stack.last_mut() {
                Some(parent) => parent.children.push(XmlNode::Element(element)),
                None => self.root = Some(element),
            }
        }
        self.scopes.pop();
        Ok(())
    }

    fn text(&mut self, _cx: &mut Parser, text: &[u16]) -> HandlerResult {
        self.add_text(text);
        Ok(())
    }

    fn cdata(&mut self, _cx: &mut Parser, cdata: &[u16]) -> HandlerResult {
        self.add_text(cdata);
        Ok(())
    }
}

/// `parseXml`: well-formed XML into an element tree; `Err` is what the
/// TypeScript throws.
pub fn parse_xml(text: &str) -> Result<XmlElement, Thrown> {
    let mut parser = Parser::new(Options::default()).map_err(thrown)?;
    let mut builder = TreeBuilder::new();
    parser.write_str(&mut builder, text).map_err(thrown)?;
    parser.close(&mut builder).map_err(thrown)?;
    builder
        .root
        .take()
        .ok_or_else(|| Thrown::new("Error", "xml: no root element"))
}

/// The tree the host's `epub.parseHtml` answers, written flat so that no
/// nesting reaches JSON: `{ elements: [{ name, local, uri, attributes:
/// [{ name, local, uri, value }], children }], root: 0 }`, the elements in
/// document order and a child either a string or `{ element: id }`.
fn tree_from_flat(value: &Value) -> Result<XmlElement, String> {
    let listed = value
        .get("elements")
        .and_then(Value::as_array)
        .ok_or("the tree has no elements")?;
    let text_of = |item: &Value, key: &str| -> Result<String, String> {
        item.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("{key} is not a string"))
    };
    let uri_of = |item: &Value| -> Result<Option<String>, String> {
        match item.get("uri") {
            Some(Value::Null) => Ok(None),
            Some(Value::String(uri)) => Ok(Some(uri.clone())),
            _ => Err("uri is neither null nor a string".to_owned()),
        }
    };
    // an element is built after every element listed below it
    let mut built: Vec<Option<XmlElement>> = (0..listed.len()).map(|_| None).collect();
    for (id, item) in listed.iter().enumerate().rev() {
        let mut attributes = Vec::new();
        for attribute in item
            .get("attributes")
            .and_then(Value::as_array)
            .ok_or("attributes is not a list")?
        {
            attributes.push(XmlAttribute {
                name: text_of(attribute, "name")?,
                local: text_of(attribute, "local")?,
                uri: uri_of(attribute)?,
                value: text_of(attribute, "value")?,
            });
        }
        let mut children = Vec::new();
        for child in item
            .get("children")
            .and_then(Value::as_array)
            .ok_or("children is not a list")?
        {
            if let Some(text) = child.as_str() {
                children.push(XmlNode::Text(text.to_owned()));
                continue;
            }
            let at = child
                .get("element")
                .and_then(Value::as_u64)
                .and_then(|at| usize::try_from(at).ok())
                .filter(|&at| at > id && at < listed.len())
                .ok_or("a child is neither text nor a later element")?;
            let element = built[at].take().ok_or("an element has two parents")?;
            children.push(XmlNode::Element(element));
        }
        built[id] = Some(XmlElement {
            name: text_of(item, "name")?,
            local: text_of(item, "local")?,
            uri: uri_of(item)?,
            attributes,
            children,
        });
    }
    built
        .first_mut()
        .and_then(Option::take)
        .ok_or_else(|| "the tree has no root".to_owned())
}

/// `parseHtml`: markup read the way a browser would, in the same tree shape.
/// parse5 is the host's: the step `epub.parseHtml` answers the tree
/// `parseHtml` of `xml.ts` builds, or throws what it throws.
pub fn parse_html(text: &str) -> Result<XmlElement, Thrown> {
    let answer = seu_host::call("epub.parseHtml", &json!({ "text": text })).map_err(host_thrown)?;
    tree_from_flat(&answer).map_err(|message| Thrown::new("HostProtocolError", message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(value: &str) -> XmlElement {
        tree_from_flat(&serde_json::from_str(value).unwrap()).unwrap()
    }

    #[test]
    fn a_flat_tree_is_read_back_into_its_nesting() {
        let root = flat(
            r#"{"elements":[
                {"name":"html","local":"html","uri":null,"attributes":[],"children":[{"element":1},"tail"]},
                {"name":"b","local":"b","uri":"u","attributes":[{"name":"x:k","local":"k","uri":"u","value":"v"}],"children":["bold"]}
            ]}"#,
        );
        assert_eq!(root.local, "html");
        let XmlNode::Element(b) = &root.children[0] else {
            panic!("the first child is the element");
        };
        assert_eq!(b.uri.as_deref(), Some("u"));
        assert_eq!(b.attributes[0].local, "k");
        assert_eq!(root.children[1], XmlNode::Text("tail".to_owned()));
    }

    #[test]
    fn a_flat_tree_that_lists_a_child_earlier_is_refused() {
        let value: Value = serde_json::from_str(
            r#"{"elements":[{"name":"a","local":"a","uri":null,"attributes":[],"children":[{"element":0}]}]}"#,
        )
        .unwrap();
        assert!(tree_from_flat(&value).is_err());
    }
}
