//! The readers of packages/docx-engine/src/xml-utils.ts over the ordered tree.

use crate::ordered::{XElement, XNode};

impl XElement {
    /// The stand-in for `{}`, which the TypeScript code passes where it has no
    /// node: no name, no attributes, no children.
    pub fn empty() -> Self {
        Self {
            name: String::new(),
            attrs: Vec::new(),
            children: Vec::new(),
        }
    }
}

impl XNode {
    pub fn empty() -> Self {
        Self::Element(XElement::empty())
    }

    fn named_element(&self) -> Option<&XElement> {
        match self {
            // `nameOf` finds no usable key in these three
            Self::Element(element) if !matches!(&*element.name, "" | ":@" | "#text") => {
                Some(element)
            }
            _ => None,
        }
    }

    /// `nameOf`
    pub fn name(&self) -> Option<&str> {
        self.named_element().map(|element| &*element.name)
    }

    /// `childrenOf`
    pub fn children(&self) -> &[XNode] {
        self.named_element()
            .map_or(&[], |element| &element.children)
    }

    /// `attrsOf(node)[key]`
    pub fn attr(&self, key: &str) -> Option<&str> {
        match self {
            Self::Element(element) => element
                .attrs
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| &**value),
            Self::Text(_) => None,
        }
    }

    /// `node[':@']`: `None` when the element carries no attribute at all.
    pub fn attrs(&self) -> Option<&[(String, String)]> {
        match self {
            Self::Element(element) if !element.attrs.is_empty() => Some(&element.attrs),
            _ => None,
        }
    }

    /// `findChild`
    pub fn find_child(&self, name: &str) -> Option<&XNode> {
        self.children()
            .iter()
            .find(|child| child.name() == Some(name))
    }

    /// `findChildren`
    pub fn find_children<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a XNode> + 'a {
        self.children()
            .iter()
            .filter(move |child| child.name() == Some(name))
    }

    /// `textOf`: the text below the node, in document order.
    pub fn text(&self) -> String {
        let mut out = String::new();
        let mut pending: Vec<&XNode> = self.children().iter().rev().collect();
        while let Some(node) = pending.pop() {
            match node {
                Self::Text(text) => out.push_str(text),
                Self::Element(_) => pending.extend(node.children().iter().rev()),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use crate::parse_ordered;

    #[test]
    fn readers_see_what_the_typescript_readers_see() {
        let nodes =
            parse_ordered(r#"<w:p a="1">x<w:r><w:t>y</w:t></w:r><w:r/>z</w:p>"#, 100).unwrap();
        let p = &nodes[0];
        assert_eq!(p.name(), Some("w:p"));
        assert_eq!(p.attr("a"), Some("1"));
        assert_eq!(p.attr("b"), None);
        assert_eq!(p.children().len(), 4);
        assert_eq!(p.find_children("w:r").count(), 2);
        assert_eq!(p.find_child("w:r").unwrap().text(), "y");
        assert_eq!(p.text(), "xyz");
        assert!(p.find_child("w:t").is_none());
    }

    #[test]
    fn a_text_node_and_an_unnamed_element_have_no_name_and_no_children() {
        let nodes = parse_ordered("<w:p>x<>y</></w:p>", 100).unwrap();
        let [text, unnamed] = nodes[0].children() else {
            panic!("two children")
        };
        assert_eq!(text.name(), None);
        assert!(text.children().is_empty());
        assert_eq!(unnamed.name(), None);
        assert!(unnamed.children().is_empty());
        // textOf does not descend into what it cannot name
        assert_eq!(nodes[0].text(), "x");
    }
}
