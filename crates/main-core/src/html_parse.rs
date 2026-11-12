//! `parseFragment` and `serialize` of parse5 8.0.1, over the tree builder of
//! html5ever.
//!
//! Both parsers implement the WHATWG parsing algorithm, so they build the same
//! tree from a fragment. Where html5ever differs from parse5 in what it is
//! given or what it writes, this module follows parse5:
//!
//! - the context element of `parseFragment(html)` is a `<template>`;
//! - a leading U+FEFF is text (html5ever drops it unless told not to);
//! - the serializer is parse5's: the void elements are its 18 names, text under
//!   a raw text element is written as it is, and `&`, `<`, `>` and U+00A0 of
//!   text, `&`, `"` and U+00A0 of an attribute value are the only escapes.

use html5ever::tendril::TendrilSink;
use html5ever::tokenizer::TokenizerOpts;
use html5ever::{ParseOpts, QualName, local_name, ns, parse_fragment as html5ever_fragment};
use markup5ever_rcdom::{Handle, NodeData, RcDom};

pub const HTML_NS: &str = "http://www.w3.org/1999/xhtml";
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

/// An attribute of the tree parse5 builds: `namespace` is empty where parse5
/// has none.
#[derive(Debug, Clone, PartialEq)]
pub struct Attr {
    pub namespace: String,
    pub prefix: Option<String>,
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Element {
    /// the namespace URI
    pub namespace: String,
    /// `tagName`: the local name, adjusted for foreign elements
    pub name: String,
    pub attrs: Vec<Attr>,
    pub children: Vec<Node>,
    /// the template contents of an HTML `<template>`; `children` is empty there
    pub content: Option<Vec<Node>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Text(String),
    Comment(String),
    Element(Element),
}

/// `parseFragment(html)`: the children of the fragment.
pub fn parse_fragment(html: &str) -> Vec<Node> {
    let opts = ParseOpts {
        tokenizer: TokenizerOpts {
            discard_bom: false,
            ..TokenizerOpts::default()
        },
        ..ParseOpts::default()
    };
    let context = QualName::new(None, ns!(html), local_name!("template"));
    let dom = html5ever_fragment(RcDom::default(), opts, context, Vec::new(), false).one(html);
    let document = dom.document.children.borrow();
    // the fragment's nodes sit under the root `html` element the parser makes
    match document.first() {
        Some(root) => convert_children(root),
        None => Vec::new(),
    }
}

fn convert_children(parent: &Handle) -> Vec<Node> {
    parent
        .children
        .borrow()
        .iter()
        .filter_map(convert)
        .collect()
}

fn convert(handle: &Handle) -> Option<Node> {
    match &handle.data {
        NodeData::Text { contents } => {
            let guard = contents.borrow();
            let text: &str = &guard;
            Some(Node::Text(text.to_owned()))
        }
        NodeData::Comment { contents } => {
            let text: &str = contents;
            Some(Node::Comment(text.to_owned()))
        }
        NodeData::Element {
            name,
            attrs,
            template_contents,
            ..
        } => {
            let attrs = attrs
                .borrow()
                .iter()
                .map(|attr| Attr {
                    namespace: (*attr.name.ns).to_owned(),
                    prefix: attr.name.prefix.as_ref().map(|p| (**p).to_owned()),
                    name: (*attr.name.local).to_owned(),
                    value: {
                        let value: &str = &attr.value;
                        value.to_owned()
                    },
                })
                .collect();
            let content = template_contents.borrow().as_ref().map(convert_children);
            Some(Node::Element(Element {
                namespace: (*name.ns).to_owned(),
                name: (*name.local).to_owned(),
                attrs,
                children: convert_children(handle),
                content,
            }))
        }
        // a fragment holds no doctype and the parser makes no instruction
        NodeData::Document | NodeData::Doctype { .. } | NodeData::ProcessingInstruction { .. } => {
            None
        }
    }
}

const VOID_ELEMENTS: [&str; 18] = [
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input",
    "keygen", "link", "meta", "param", "source", "track", "wbr",
];

const UNESCAPED_TEXT: [&str; 7] = [
    "style",
    "script",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "plaintext",
];

fn is_void(element: &Element) -> bool {
    element.namespace == HTML_NS && VOID_ELEMENTS.contains(&element.name.as_str())
}

/// `hasUnescapedText(tn, true)`: scripting is on in the default options.
fn has_unescaped_text(name: &str) -> bool {
    UNESCAPED_TEXT.contains(&name) || name == "noscript"
}

/// `escapeText` of the `entities` package.
fn escape_text(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}

/// `escapeAttribute` of the `entities` package.
fn escape_attribute(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}

/// `serialize(fragment)`: the nodes written one after the other.
pub fn serialize(nodes: &[Node]) -> String {
    let mut out = String::new();
    serialize_children(nodes, None, &mut out);
    out
}

/// `parent` is the element a text node is a child of, for the raw text rule.
fn serialize_children(nodes: &[Node], parent: Option<&Element>, out: &mut String) {
    for node in nodes {
        match node {
            Node::Element(element) => serialize_element(element, out),
            Node::Text(text) => {
                let raw =
                    parent.is_some_and(|p| p.namespace == HTML_NS && has_unescaped_text(&p.name));
                if raw {
                    out.push_str(text);
                } else {
                    escape_text(text, out);
                }
            }
            Node::Comment(data) => {
                out.push_str("<!--");
                out.push_str(data);
                out.push_str("-->");
            }
        }
    }
}

fn serialize_element(element: &Element, out: &mut String) {
    out.push('<');
    out.push_str(&element.name);
    for attr in &element.attrs {
        out.push(' ');
        if attr.namespace.is_empty() {
            out.push_str(&attr.name);
        } else {
            match attr.namespace.as_str() {
                XML_NS => {
                    out.push_str("xml:");
                    out.push_str(&attr.name);
                }
                XMLNS_NS => {
                    if attr.name != "xmlns" {
                        out.push_str("xmlns:");
                    }
                    out.push_str(&attr.name);
                }
                XLINK_NS => {
                    out.push_str("xlink:");
                    out.push_str(&attr.name);
                }
                _ => {
                    // `${attr.prefix}:${attr.name}`
                    out.push_str(attr.prefix.as_deref().unwrap_or("undefined"));
                    out.push(':');
                    out.push_str(&attr.name);
                }
            }
        }
        out.push_str("=\"");
        escape_attribute(&attr.value, out);
        out.push('"');
    }
    out.push('>');
    if is_void(element) {
        return;
    }
    if element.namespace == HTML_NS && element.name == "template" {
        // the contents are a fragment, not an element: its text is escaped
        serialize_children(element.content.as_deref().unwrap_or(&[]), None, out);
    } else {
        serialize_children(&element.children, Some(element), out);
    }
    out.push_str("</");
    out.push_str(&element.name);
    out.push('>');
}
