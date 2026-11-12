//! inline-opaque.ts: run-level wrapper elements the run model has no field for
//! (`w:sdt`, `w:smartTag`, `w:customXml`, `w:dir`, `w:bdo`). The bytes of a
//! wrapper that holds runs ride on those runs (`Run.wrap`), so a rebuilt
//! paragraph writes the wrapper back around them.
//!
//! Offsets of a [`RawTree`] are byte offsets into the text it was read from
//! (the TypeScript counts UTF-16 units; the slices taken with them are the
//! same).

use std::borrow::Cow;
use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use jscompat::{JsMap, RegexLimit, js_regex, try_js_regex};
use ooxml_xml::{XElement, XNode, serialize};

use crate::model::{InlineWrap, InlineWrapInside, Run};
use crate::xml_text::decode_entities;

/// `WRAPPER_PROPS`: the child of each wrapper element that holds its own
/// properties (`Some("")` is not used: `undefined` is `None`).
fn wrapper_props(name: &str) -> Option<Option<&'static str>> {
    match name {
        "w:sdt" | "w:dir" | "w:bdo" => Some(None),
        "w:smartTag" => Some(Some("w:smartTagPr")),
        "w:customXml" => Some(Some("w:customXmlPr")),
        _ => None,
    }
}

/// `isInlineWrapper`
pub fn is_inline_wrapper(name: &str) -> bool {
    wrapper_props(name).is_some()
}

/// `PartNamespaces`: prefix to namespace URI, as the root element of a part
/// declares them.
pub type PartNamespaces = JsMap<String>;

const W_NAMESPACE: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const EXTENSION_NAMESPACE_START: &str = "http://schemas.microsoft.com/office/word/";
/// `MAX_CARRIED_DEPTH`: nesting inside one carried element.
const MAX_CARRIED_DEPTH: usize = 32;
/// `MAX_WRAP_LENGTH`: opening and closing bytes of one wrapper together, in
/// UTF-16 code units.
const MAX_WRAP_LENGTH: usize = 65536;

/// `EXTENSION_PREFIX_RE`: `^w1[4-9][a-z]*$`
fn is_extension_prefix(prefix: &str) -> bool {
    prefix.strip_prefix("w1").is_some_and(|rest| {
        let mut chars = rest.chars();
        matches!(chars.next(), Some('4'..='9')) && chars.all(|c| c.is_ascii_lowercase())
    })
}

/// `partNamespaces`: the namespace declarations on the root element of a part.
pub fn part_namespaces(part_xml: &str) -> Result<PartNamespaces, RegexLimit> {
    let mut out = PartNamespaces::new();
    let mut at = 0;
    // the declaration, comments and a doctype may come before the root element
    loop {
        while let Some(c) = part_xml[at..].chars().next() {
            if !jscompat::is_js_space(c) {
                break;
            }
            at += c.len_utf8();
        }
        let rest = &part_xml[at..];
        let closer = if rest.starts_with("<?") {
            "?>"
        } else if rest.starts_with("<!--") {
            "-->"
        } else if rest.starts_with("<!") {
            ">"
        } else {
            break;
        };
        let Some(end) = rest.find(closer) else {
            return Ok(out);
        };
        at += end + closer.len();
    }
    let Some(root) = try_js_regex!(r#"^<[A-Za-z_][\w:.-]*((?:"[^"]*"|'[^']*'|[^"'>])*)>"#)
        .try_exec(&part_xml[at..])?
    else {
        return Ok(out);
    };
    let attrs = root.get(1).unwrap_or("");
    // each match takes a whole attribute, so text inside a value is never read as one
    for attr in
        try_js_regex!(r#"\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#, "g").try_find_iter(attrs)
    {
        let attr = attr?;
        if let Some(prefix) = attr.get(1).and_then(|name| name.strip_prefix("xmlns:")) {
            out.set(
                prefix,
                decode_entities(attr.get(2).or(attr.get(3)).unwrap_or("")),
            );
        }
    }
    Ok(out)
}

/// An element of strictly scanned bytes, by index into [`Scan::elements`].
struct CarriedElement {
    name: String,
    children: Vec<usize>,
}

struct Scan {
    elements: Vec<CarriedElement>,
    root: usize,
    /// the element the runs go into (a wrapper split around its content), with
    /// the number of its children before them
    holder: Option<(usize, usize)>,
    /// prefixes the bytes use without declaring them: the part root has to
    outer: HashSet<String>,
}

const fn is_name_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

const fn is_name_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

/// `NAME_RE` read at `at`: the length of `[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?`.
fn name_len_at(bytes: &[u8], at: usize) -> Option<usize> {
    let mut i = at;
    if !bytes.get(i).copied().is_some_and(is_name_start) {
        return None;
    }
    i += 1;
    while bytes.get(i).copied().is_some_and(is_name_char) {
        i += 1;
    }
    if bytes.get(i) == Some(&b':') && bytes.get(i + 1).copied().is_some_and(is_name_start) {
        i += 2;
        while bytes.get(i).copied().is_some_and(is_name_char) {
            i += 1;
        }
    }
    Some(i - at)
}

/// `isXmlChar`
const fn is_xml_char(code: u32) -> bool {
    matches!(code, 0x9 | 0xa | 0xd)
        || matches!(code, 0x20..=0xd7ff)
        || matches!(code, 0xe000..=0xfffd)
        || matches!(code, 0x10000..=0x10ffff)
}

/// `REFERENCE_RE` read at the `&` at `at`: `Some(None)` for a named
/// reference, `Some(Some(code))` for a numeric one, `None` for no reference.
fn reference_at(bytes: &[u8], at: usize) -> Option<Option<u32>> {
    let rest = &bytes[at + 1..];
    for name in [&b"lt;"[..], b"gt;", b"amp;", b"quot;", b"apos;"] {
        if rest.starts_with(name) {
            return Some(None);
        }
    }
    let (radix, digits) = match rest {
        [b'#', b'x', digits @ ..] => (16, digits),
        [b'#', digits @ ..] => (10, digits),
        _ => return None,
    };
    let (max, valid): (usize, fn(&u8) -> bool) = if radix == 16 {
        (7, u8::is_ascii_hexdigit)
    } else {
        (8, u8::is_ascii_digit)
    };
    let len = digits.iter().take_while(|byte| valid(byte)).count();
    if len == 0 || len > max || digits.get(len) != Some(&b';') {
        // `#x41;` is not a decimal reference: the second alternative reads it
        if radix == 10 && digits.first() == Some(&b'x') {
            return None;
        }
        return None;
    }
    let text = std::str::from_utf8(&digits[..len]).ok()?;
    Some(Some(u32::from_str_radix(text, radix).ok()?))
}

/// `validAttributeValue`: an attribute value as XML allows it: no `<`, only
/// real references, only XML characters. (A lone surrogate cannot be held by
/// a Rust string.)
fn valid_attribute_value(value: &str) -> bool {
    if value.chars().any(|c| {
        matches!(c, '<' | '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' | '\u{FFFE}' | '\u{FFFF}')
    }) {
        return false;
    }
    let bytes = value.as_bytes();
    for (at, byte) in bytes.iter().enumerate() {
        if *byte != b'&' {
            continue;
        }
        match reference_at(bytes, at) {
            None => return false,
            Some(Some(code)) if !is_xml_char(code) => return false,
            Some(_) => {}
        }
    }
    true
}

const fn is_space(byte: u8) -> bool {
    matches!(byte, 0x20 | 0x9 | 0xa | 0xd)
}

/// `scanCarried`: strict scan of carried bytes. They may hold tags and white
/// space, nothing else: no text, comment, CDATA, processing instruction or
/// doctype. Every tag has to be well-formed and a namespace declared inside
/// the bytes has to be the w namespace itself or one of Word's extension
/// namespaces. The two segments are a wrapper split around its content.
fn scan_carried(segments: &[&str]) -> Option<Scan> {
    let mut elements: Vec<CarriedElement> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut stack: Vec<(usize, Vec<String>)> = Vec::new();
    let mut active: HashMap<String, i64> = HashMap::new();
    let mut outer: HashSet<String> = HashSet::new();
    let mut holder = None;
    for (s, xml) in segments.iter().enumerate() {
        let bytes = xml.as_bytes();
        let n = bytes.len();
        let mut i = 0;
        let skip_space = |i: &mut usize| {
            while *i < n && is_space(bytes[*i]) {
                *i += 1;
            }
        };
        while i < n {
            if is_space(bytes[i]) {
                i += 1;
                continue;
            }
            if bytes[i] != b'<' {
                return None;
            }
            i += 1;
            let closing = bytes.get(i) == Some(&b'/');
            if closing {
                i += 1;
            }
            let len = name_len_at(bytes, i)?;
            let name = &xml[i..i + len];
            i += len;
            if closing {
                skip_space(&mut i);
                if bytes.get(i) != Some(&b'>') {
                    return None;
                }
                i += 1;
                let (top, declared) = stack.pop()?;
                if elements[top].name != name {
                    return None;
                }
                for prefix in declared {
                    *active.get_mut(&prefix)? -= 1;
                }
                continue;
            }
            let colon = name.find(':')?;
            let mut used = vec![name[..colon].to_owned()];
            let mut declared: Vec<String> = Vec::new();
            let mut seen: HashSet<&str> = HashSet::new();
            let self_closing;
            loop {
                let before = i;
                skip_space(&mut i);
                match bytes.get(i) {
                    Some(b'>') => {
                        i += 1;
                        self_closing = false;
                        break;
                    }
                    Some(b'/') => {
                        if bytes.get(i + 1) != Some(&b'>') {
                            return None;
                        }
                        i += 2;
                        self_closing = true;
                        break;
                    }
                    _ => {}
                }
                if i == before {
                    return None;
                }
                let attr_len = name_len_at(bytes, i)?;
                let attr = &xml[i..i + attr_len];
                if !seen.insert(attr) {
                    return None;
                }
                i += attr_len;
                skip_space(&mut i);
                if bytes.get(i) != Some(&b'=') {
                    return None;
                }
                i += 1;
                skip_space(&mut i);
                let quote = *bytes.get(i)?;
                if quote != b'"' && quote != b'\'' {
                    return None;
                }
                let end = i + 1 + bytes[i + 1..].iter().position(|byte| *byte == quote)?;
                let value = &xml[i + 1..end];
                i = end + 1;
                if !valid_attribute_value(value) {
                    return None;
                }
                if attr == "xmlns" {
                    return None;
                }
                if let Some(prefix) = attr.strip_prefix("xmlns:") {
                    let allowed = if prefix == "w" {
                        value == W_NAMESPACE
                    } else {
                        is_extension_prefix(prefix) && value.starts_with(EXTENSION_NAMESPACE_START)
                    };
                    if !allowed {
                        return None;
                    }
                    declared.push(prefix.to_owned());
                } else if let Some(at) = attr.find(':')
                    && !attr.starts_with("xml:")
                {
                    used.push(attr[..at].to_owned());
                }
            }
            for prefix in &declared {
                *active.entry(prefix.clone()).or_insert(0) += 1;
            }
            for prefix in used {
                if active.get(&prefix).copied().unwrap_or(0) == 0 {
                    outer.insert(prefix);
                }
            }
            let element = elements.len();
            elements.push(CarriedElement {
                name: name.to_owned(),
                children: Vec::new(),
            });
            match stack.last() {
                Some((parent, _)) => {
                    let parent = *parent;
                    elements[parent].children.push(element);
                }
                None => roots.push(element),
            }
            if self_closing {
                for prefix in &declared {
                    *active.get_mut(prefix)? -= 1;
                }
            } else {
                if stack.len() >= MAX_CARRIED_DEPTH {
                    return None;
                }
                stack.push((element, declared));
            }
        }
        if s + 1 < segments.len() {
            let (top, _) = stack.last()?;
            holder = Some((*top, elements[*top].children.len()));
        }
    }
    if !stack.is_empty() || roots.len() != 1 {
        return None;
    }
    Some(Scan {
        root: roots[0],
        elements,
        holder,
        outer,
    })
}

/// `PROPERTY_NAMES`: the w: elements that describe a wrapper.
fn is_property_name(name: &str) -> bool {
    const NAMES: &str = "alias tag id lock placeholder docPart temporary showingPlcHdr dataBinding label tabIndex \
        equation comboBox listItem date dateFormat lid storeMappedDataAs calendar docPartObj \
        docPartList docPartGallery docPartCategory docPartUnique dropDownList picture richText \
        text citation group bibliography attr \
        rPr rPrChange rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow \
        emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs \
        highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath";
    name.strip_prefix("w:")
        .is_some_and(|local| NAMES.split(' ').any(|known| known == local))
}

/// `propertiesOnly`: every element below `holder` describes the wrapper.
fn properties_only(scan: &Scan, holder: usize) -> bool {
    let mut todo: Vec<usize> = scan.elements[holder].children.clone();
    while let Some(el) = todo.pop() {
        let element = &scan.elements[el];
        let prefix = element.name.split(':').next().unwrap_or("");
        if !is_property_name(&element.name) && !is_extension_prefix(prefix) {
            return false;
        }
        todo.extend(element.children.iter().copied());
    }
    true
}

/// `declaredBy`
fn declared_by(prefixes: &HashSet<String>, namespaces: Option<&PartNamespaces>) -> bool {
    namespaces.is_none_or(|namespaces| prefixes.iter().all(|prefix| namespaces.has(prefix)))
}

/// `inlineWrapPrefixes`: the prefixes a wrapper needs its part root to
/// declare, `None` when it may not be carried. (A value that has not the
/// fields of an `InlineWrap` cannot be built here; one with a non-finite
/// `seq` is not one.)
pub fn inline_wrap_prefixes(wrap: &InlineWrap) -> Option<HashSet<String>> {
    if !wrap.seq.0.is_finite() {
        return None;
    }
    let length = wrap.open.encode_utf16().count() + wrap.close.encode_utf16().count();
    if length > MAX_WRAP_LENGTH {
        return None;
    }
    let scan = scan_carried(&[&wrap.open, &wrap.close])?;
    let (holder, before) = scan.holder?;
    let root = &scan.elements[scan.root];
    let props = wrapper_props(&root.name)?;
    if root.name == "w:sdt" {
        let ok = scan.elements[holder].name == "w:sdtContent"
            && scan.elements[holder].children.is_empty()
            && root.children.contains(&holder)
            && root.children.iter().all(|&child| {
                child == holder
                    || ((scan.elements[child].name == "w:sdtPr"
                        || scan.elements[child].name == "w:sdtEndPr")
                        && properties_only(&scan, child))
            });
        return ok.then_some(scan.outer);
    }
    let ok = holder == scan.root
        && before == root.children.len()
        && root.children.len() <= usize::from(props.is_some())
        && root.children.iter().all(|&child| {
            Some(scan.elements[child].name.as_str()) == props && properties_only(&scan, child)
        });
    ok.then_some(scan.outer)
}

/// `validInlineWrap`: the wrapper may be carried in a part whose root declares
/// `namespaces` (`None`: not judged).
pub fn valid_inline_wrap(wrap: &InlineWrap, namespaces: Option<&PartNamespaces>) -> bool {
    inline_wrap_prefixes(wrap).is_some_and(|prefixes| declared_by(&prefixes, namespaces))
}

/// `RawElement`: one element of the scanned xml, by index into its
/// [`RawTree`].
#[derive(Debug, Clone)]
pub struct RawElement {
    pub name: String,
    pub start: usize,
    /// end of the opening tag
    pub open_end: usize,
    /// start of the closing tag (= end for a self-closing element)
    pub close_start: usize,
    pub end: usize,
    pub self_closing: bool,
    pub children: Vec<usize>,
}

/// The elements `rawElements` returns, with their children by index.
#[derive(Debug, Default)]
pub struct RawTree {
    elements: Vec<RawElement>,
    pub roots: Vec<usize>,
}

impl RawTree {
    pub fn get(&self, index: usize) -> &RawElement {
        &self.elements[index]
    }

    /// The children of `element`, in order.
    pub fn children<'a>(&'a self, element: &'a RawElement) -> impl Iterator<Item = &'a RawElement> {
        element.children.iter().map(|&child| &self.elements[child])
    }
}

/// `rawElements`
pub fn raw_elements(xml: &str, skip_non_elements: bool) -> Result<RawTree, RegexLimit> {
    // Pairing a parse tree cannot skip these (its element children differ).
    if !skip_non_elements && (xml.contains("<!") || xml.contains("<?")) {
        return Ok(RawTree::default());
    }
    let mut tree = RawTree::default();
    let mut stack: Vec<usize> = Vec::new();
    let tag = try_js_regex!(
        r#"<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>"#,
        "g"
    );
    for found in tag.try_find_iter(xml) {
        let found = found?;
        let Some(name) = found.get(2) else {
            continue;
        };
        let end = found.end();
        if found.get(1) == Some("/") {
            let Some(top) = stack.pop() else {
                return Ok(RawTree::default());
            };
            if tree.elements[top].name != name {
                return Ok(RawTree::default());
            }
            tree.elements[top].close_start = found.start();
            tree.elements[top].end = end;
            continue;
        }
        let self_closing = found.get(3).unwrap_or("").ends_with('/');
        let index = tree.elements.len();
        tree.elements.push(RawElement {
            name: name.to_owned(),
            start: found.start(),
            open_end: end,
            close_start: end,
            end,
            self_closing,
            children: Vec::new(),
        });
        match stack.last() {
            Some(&parent) => tree.elements[parent].children.push(index),
            None => tree.roots.push(index),
        }
        if !self_closing {
            stack.push(index);
        }
    }
    if stack.is_empty() {
        Ok(tree)
    } else {
        Ok(RawTree::default())
    }
}

/// `elementChildren`
fn element_children(node: &XNode) -> Vec<&XNode> {
    node.children()
        .iter()
        .filter(|child| child.name().is_some())
        .collect()
}

/// What pairing the parse tree with the raw elements gives.
struct Paired {
    tree: RawTree,
    by_node: HashMap<*const XNode, usize>,
}

/// The element the pairing starts from.
enum Root<'a> {
    Borrowed(&'a XNode),
    /// A parsed top-level node list kept alive with the source (the table being read).
    Owned(Rc<Vec<XNode>>, usize),
}

/// `InlineRawSource`: the source text a parse tree came from, with the byte
/// range of each of its elements. `root` is the element of that name at the
/// top level of `xml`; pairing runs on first use.
pub struct InlineRawSource<'a> {
    xml: Cow<'a, str>,
    root: Root<'a>,
    paired: OnceCell<Result<Paired, RegexLimit>>,
}

/// `inlineRawSource`
pub fn inline_raw_source<'a>(xml: &'a str, root: &'a XNode) -> InlineRawSource<'a> {
    InlineRawSource {
        xml: Cow::Borrowed(xml),
        root: Root::Borrowed(root),
        paired: OnceCell::new(),
    }
}

impl InlineRawSource<'static> {
    /// `inlineRawSource(xml, nodes[root_at])` for a source the context keeps
    /// beyond the call that parsed it (`ctx.tableRaw`): it holds the parsed
    /// nodes, so the nodes `of` is asked about are the ones of `nodes`.
    pub fn owned(xml: String, nodes: Rc<Vec<XNode>>, root_at: usize) -> Self {
        Self {
            xml: Cow::Owned(xml),
            root: Root::Owned(nodes, root_at),
            paired: OnceCell::new(),
        }
    }
}

impl InlineRawSource<'_> {
    /// `source.xml`
    pub fn xml(&self) -> &str {
        &self.xml
    }

    fn root(&self) -> &XNode {
        match &self.root {
            Root::Borrowed(root) => root,
            Root::Owned(nodes, at) => &nodes[*at],
        }
    }

    fn pair(&self) -> Result<Paired, RegexLimit> {
        let tree = raw_elements(&self.xml, false)?;
        let mut by_node: HashMap<*const XNode, usize> = HashMap::new();
        let root = self.root();
        let root_name = root.name();
        let raw_root = tree
            .roots
            .iter()
            .copied()
            .find(|&index| root_name == Some(tree.get(index).name.as_str()));
        if let Some(raw_root) = raw_root {
            // explicit stack: table sources nest far deeper than a call stack allows
            let mut todo: Vec<(&XNode, usize)> = vec![(root, raw_root)];
            while let Some((node, raw)) = todo.pop() {
                by_node.insert(std::ptr::from_ref(node), raw);
                let kids = element_children(node);
                let raw_kids = &tree.get(raw).children;
                // children that do not line up stay unpaired, with everything below them
                if kids.len() != raw_kids.len() {
                    continue;
                }
                for (kid, &raw_kid) in kids.iter().zip(raw_kids) {
                    if kid.name() == Some(tree.get(raw_kid).name.as_str()) {
                        todo.push((kid, raw_kid));
                    }
                }
            }
        }
        Ok(Paired { tree, by_node })
    }

    fn paired(&self) -> Result<&Paired, RegexLimit> {
        self.paired
            .get_or_init(|| self.pair())
            .as_ref()
            .map_err(|limit| *limit)
    }

    /// `of`: the raw element of `node`, when it lines up with the text.
    pub fn of(&self, node: &XNode) -> Result<Option<&RawElement>, RegexLimit> {
        let paired = self.paired()?;
        Ok(paired
            .by_node
            .get(&std::ptr::from_ref(node))
            .map(|&index| paired.tree.get(index)))
    }

    /// The tree `of` reads, for walking the children of what it returned.
    pub fn tree(&self) -> Result<&RawTree, RegexLimit> {
        Ok(&self.paired()?.tree)
    }
}

/// `openTagXml`: `<name attrs>`.
fn open_tag_xml(node: &XNode) -> String {
    let XNode::Element(element) = node else {
        return String::new();
    };
    let mut out = serialize(&XNode::Element(XElement {
        name: element.name.clone(),
        attrs: element.attrs.clone(),
        children: Vec::new(),
    }));
    // an element without content serializes as `<name attrs/>`
    out.pop();
    out.pop();
    out.push('>');
    out
}

fn serialize_all(nodes: &[&XNode]) -> String {
    nodes.iter().map(|node| serialize(node)).collect()
}

/// What `inlineWrapperShell` returns: a wrapper split around its run content.
#[derive(Debug)]
pub struct WrapperShell<'a> {
    pub open: String,
    pub close: String,
    pub content: Vec<&'a XNode>,
}

/// `inlineWrapperShell`: the bytes before and after the content of a wrapper
/// element, and the content nodes. `None` when the wrapper has nowhere to
/// hold runs (a `w:sdt` without `w:sdtContent`, a self-closing wrapper).
pub fn inline_wrapper_shell<'a>(
    node: &'a XNode,
    source: Option<&InlineRawSource<'_>>,
) -> Result<Option<WrapperShell<'a>>, RegexLimit> {
    let Some(name) = node.name() else {
        return Ok(None);
    };
    let kids = element_children(node);
    let raw = match source {
        Some(source) => source.of(node)?,
        None => None,
    };
    let tree = match (source, raw) {
        (Some(source), Some(_)) => Some(source.tree()?),
        _ => None,
    };
    let raw_kids: Option<Vec<&RawElement>> = match (raw, tree) {
        (Some(raw), Some(tree)) if raw.children.len() == kids.len() => {
            Some(tree.children(raw).collect())
        }
        _ => None,
    };
    if name == "w:sdt" {
        let Some(at) = kids
            .iter()
            .position(|kid| kid.name() == Some("w:sdtContent"))
        else {
            return Ok(None);
        };
        // Only one content child may supply the visible runs. Anything else
        // readable must be walked, never hidden in the shell's original bytes.
        if kids.iter().enumerate().any(|(i, kid)| {
            i != at && kid.name() != Some("w:sdtPr") && kid.name() != Some("w:sdtEndPr")
        }) {
            return Ok(None);
        }
        let content: Vec<&XNode> = kids[at].children().iter().collect();
        let raw_content = raw_kids.as_ref().and_then(|kids| kids.get(at));
        if let (Some(source), Some(raw), Some(raw_content)) = (source, raw, raw_content)
            && raw_content.name == "w:sdtContent"
        {
            if raw_content.self_closing {
                return Ok(None);
            }
            return Ok(Some(WrapperShell {
                open: source.xml()[raw.start..raw_content.open_end].to_owned(),
                close: source.xml()[raw_content.close_start..raw.end].to_owned(),
                content,
            }));
        }
        if content.is_empty() {
            return Ok(None);
        }
        return Ok(Some(WrapperShell {
            open: open_tag_xml(node) + &serialize_all(&kids[..at]) + &open_tag_xml(kids[at]),
            close: format!("</w:sdtContent>{}</w:sdt>", serialize_all(&kids[at + 1..])),
            content,
        }));
    }
    let props_name = wrapper_props(name).flatten();
    let props = match (props_name, kids.first()) {
        (Some(props_name), Some(first)) if first.name() == Some(props_name) => Some(*first),
        _ => None,
    };
    let content: Vec<&XNode> = node
        .children()
        .iter()
        .filter(|child| props.is_none_or(|props| !std::ptr::eq(*child, props)))
        .collect();
    if let (Some(source), Some(raw)) = (source, raw) {
        if raw.self_closing {
            return Ok(None);
        }
        let raw_props = if props.is_some() {
            raw_kids.as_ref().and_then(|kids| kids.first())
        } else {
            None
        };
        if props.is_none() || raw_props.is_some() {
            return Ok(Some(WrapperShell {
                open: source.xml()[raw.start..raw_props.map_or(raw.open_end, |props| props.end)]
                    .to_owned(),
                close: source.xml()[raw.close_start..raw.end].to_owned(),
                content,
            }));
        }
    }
    if content.is_empty() {
        return Ok(None);
    }
    Ok(Some(WrapperShell {
        open: open_tag_xml(node) + &props.map_or_else(String::new, serialize),
        close: format!("</{name}>"),
        content,
    }))
}

/// `sameInlineWrap`: two runs sit in the same wrapper element.
pub fn same_inline_wrap(a: Option<&InlineWrap>, b: Option<&InlineWrap>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.seq.0 == b.seq.0 && a.open == b.open && a.close == b.close,
        (None, None) => true,
        _ => false,
    }
}

/// `inlineWrapKey`: stable across copied mark objects, scoped to one
/// paragraph's writer.
pub fn inline_wrap_key(wrap: &InlineWrap) -> String {
    serde_json::to_string(&(wrap.seq, &wrap.open, &wrap.close))
        .unwrap_or_else(|_| unreachable!("a number and two strings serialize"))
}

/// `sameInlineWrapChain`: two runs sit in the same chain of wrapper elements.
pub fn same_inline_wrap_chain(a: Option<&[InlineWrap]>, b: Option<&[InlineWrap]>) -> bool {
    let (x, y) = (a.unwrap_or(&[]), b.unwrap_or(&[]));
    x.len() == y.len()
        && x.iter()
            .zip(y)
            .all(|(a, b)| same_inline_wrap(Some(a), Some(b)))
}

/// `isContentControl`
fn is_content_control(wrap: &InlineWrap) -> bool {
    js_regex!(r"^<w:sdt[\s>]").test(&wrap.open)
}

/// `inlineWrapContentLocked`: the wrapper is a content control whose content
/// may not be edited (`w:lock` contentLocked / sdtContentLocked in its own
/// `w:sdtPr`).
pub fn inline_wrap_content_locked(wrap: &InlineWrap) -> bool {
    if !is_content_control(wrap) {
        return false;
    }
    let lock = js_regex!(r#"<w:lock\b[^>]*\bw:val\s*=\s*(?:"([^"]*)"|'([^']*)')"#).exec(&wrap.open);
    let val = lock.as_ref().and_then(|lock| lock.get(1).or(lock.get(2)));
    matches!(val, Some("contentLocked" | "sdtContentLocked"))
}

/// `inlineWrapWritesOnce`: a content control carries a `w:id` (and often a
/// data binding), and two elements from one original would repeat it.
pub fn inline_wrap_writes_once(wrap: &InlineWrap) -> bool {
    is_content_control(wrap)
}

/// `sdtFollowsItsText`: the opening bytes are a content control with a
/// placeholder flag or a data binding.
pub fn sdt_follows_its_text(open: &str) -> bool {
    js_regex!(r"^<w:sdt[\s>]").test(open)
        && js_regex!(r"<(?:w:showingPlcHdr|w:dataBinding|w15:dataBinding)[\s/>]").test(open)
}

/// `inlineWrapTextOf`: what a reader sees of `runs[from..to]` with pending
/// deletions gone; note markers are display numbers, not content.
pub fn inline_wrap_text_of(runs: &[Run], from: usize, to: usize) -> String {
    let mut text = String::new();
    for run in &runs[from..to] {
        if run.del.is_none() && run.note_ref.is_none() {
            text.push_str(run.text.as_deref().unwrap_or("undefined"));
        }
    }
    text
}

/// `sdtOpenForChangedText`: a control's opening bytes for text that is no
/// longer the text it was read with: `w:showingPlcHdr` goes, and so does the
/// data binding.
pub fn sdt_open_for_changed_text(open: &str) -> Result<String, RegexLimit> {
    try_js_regex!(
        concat!(
            r#"<w:showingPlcHdr(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*/>|<w:showingPlcHdr(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>\s*</w:showingPlcHdr>"#,
            r#"|<w:dataBinding(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*/>|<w:dataBinding(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>\s*</w:dataBinding>"#,
            r#"|<w15:dataBinding(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*/>|<w15:dataBinding(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>\s*</w15:dataBinding>"#
        ),
        "g"
    )
    .try_replace_all(open, |_| String::new())
}

/// `PlacedWraps`: the wrappers of one run by the depth they are written at:
/// outside its revision element, inside it (outside the hyperlink), inside the
/// hyperlink.
pub type PlacedWraps = [Vec<InlineWrap>; 3];

/// `nominalLevel`
fn nominal_level(wrap: &InlineWrap) -> usize {
    match wrap.inside {
        Some(InlineWrapInside::Link) => 2,
        Some(InlineWrapInside::Revision) => 1,
        Some(InlineWrapInside::Unlisted(_)) | None => 0,
    }
}

/// `sharesWrapPrefix`
fn shares_wrap_prefix(chain: Option<&[InlineWrap]>, other: &[InlineWrap], depth: usize) -> bool {
    let Some(chain) = chain.filter(|chain| chain.len() > depth) else {
        return false;
    };
    (0..=depth).all(|k| same_inline_wrap(chain.get(k), other.get(k)))
}

/// `placeInlineWraps`: the depth each wrapper of each run is written at, `None`
/// when no run sits in a wrapper. A wrapper goes back where it was read
/// (`InlineWrap.inside`) as long as the runs it holds still share that
/// revision element / hyperlink; runs that no longer do keep the wrapper around
/// all of them, one level out. A hyperlink that grew past a wrapper takes the
/// wrapper inside it instead of being cut in two at the wrapper's edge.
///
/// `rev_key_of` is the generator's grouping key for tracked-change elements.
pub fn place_inline_wraps(
    runs: &[Run],
    rev_key_of: &dyn Fn(&Run) -> String,
) -> Option<Vec<PlacedWraps>> {
    let wrap_of = |run: &Run| -> Option<Vec<InlineWrap>> { (*run.wrap).clone() };
    let chains: Vec<Option<Vec<InlineWrap>>> = runs.iter().map(wrap_of).collect();
    let max_depth = chains
        .iter()
        .map(|chain| chain.as_ref().map_or(0, Vec::len))
        .max()
        .unwrap_or(0);
    if max_depth == 0 {
        return None;
    }
    let n = runs.len();
    let rev: Vec<String> = runs.iter().map(rev_key_of).collect();
    // hyperlink groups as the generator forms them inside one revision group
    let mut link_group: Vec<i64> = vec![-1; n];
    let mut groups = 0;
    let mut i = 0;
    while i < n {
        let Some(link) = runs[i].link.as_ref() else {
            i += 1;
            continue;
        };
        let start = i;
        let mut r_id = link.r_id.clone();
        while i < n
            && rev[i] == rev[start]
            && runs[i]
                .link
                .as_ref()
                .is_some_and(|other| other.href == link.href)
        {
            let next = runs[i].link.as_ref().and_then(|other| other.r_id.clone());
            if i > start && next.is_some() && r_id.is_some() && next != r_id {
                break;
            }
            r_id = r_id.or(next);
            link_group[i] = groups;
            i += 1;
        }
        groups += 1;
    }
    let mut level: Vec<Vec<usize>> = chains
        .iter()
        .map(|chain| vec![0; chain.as_ref().map_or(0, Vec::len)])
        .collect();
    for d in 0..max_depth {
        let mut a = 0;
        while a < n {
            let Some(chain) = chains[a].as_ref().filter(|chain| chain.len() > d) else {
                a += 1;
                continue;
            };
            // [a, b): the adjacent runs that sit in this element
            let mut b = a + 1;
            while b < n && shares_wrap_prefix(chains[b].as_deref(), chain, d) {
                b += 1;
            }
            let mut one_rev = true;
            let mut one_link = link_group[a] != -1;
            for i in a + 1..b {
                if rev[i] != rev[a] {
                    one_rev = false;
                }
                if link_group[i] != link_group[a] {
                    one_link = false;
                }
            }
            let mut lvl = nominal_level(&chain[d]);
            if !one_rev {
                lvl = 0;
            } else if !one_link {
                lvl = lvl.min(1);
            } else if lvl < 2
                && (lvl == 1 || rev[a].is_empty())
                && (a.checked_sub(1).map(|before| link_group[before]) == Some(link_group[a])
                    || link_group.get(b).copied() == Some(link_group[a]))
            {
                lvl = 2;
            }
            // never outside the wrapper that holds it
            if d > 0 {
                lvl = lvl.max(level[a][d - 1]);
            }
            for row in &mut level[a..b] {
                row[d] = lvl;
            }
            a = b;
        }
    }
    Some(
        chains
            .iter()
            .enumerate()
            .map(|(i, chain)| {
                let mut placed: PlacedWraps = [Vec::new(), Vec::new(), Vec::new()];
                for (d, wrap) in chain.iter().flatten().enumerate() {
                    placed[level[i][d]].push(wrap.clone());
                }
                placed
            })
            .collect(),
    )
}

/// `runCopiedElsewhere`: a run as it goes into ANOTHER paragraph or document:
/// a content control carries an id that belongs to the original, so the copy
/// goes without it.
pub fn run_copied_elsewhere(run: &Run) -> Run {
    let Some(wrap) = run.wrap.as_ref() else {
        return run.clone();
    };
    if !wrap.iter().any(is_content_control) {
        return run.clone();
    }
    let kept: Vec<InlineWrap> = wrap
        .iter()
        .filter(|wrap| !is_content_control(wrap))
        .cloned()
        .collect();
    let mut copy = run.clone();
    copy.wrap.delete();
    if !kept.is_empty() {
        copy.wrap.set(kept);
    }
    copy
}

/// `ContentControlPart` of inline-control-ids.ts: one part as the run writer
/// sees it while the part is put together.
///
/// Namespaces: wrapper bytes carried on runs are written under elements the
/// engine generates, so every prefix they use has to be declared by the part
/// root; the writer asks before it writes a wrapper.
///
/// Control ids: a content control written from `Run.wrap` is the only kind that
/// gives way when its `w:id` is taken. The run writer marks it with a comment
/// directly before its opening tag; `finish` removes the comments and unwraps a
/// marked control whose id an unmarked control holds or an earlier marked one
/// took. Nothing unmarked is ever rewritten.
pub struct ContentControlPart {
    marker: String,
    namespaces: Option<PartNamespaces>,
}

impl ContentControlPart {
    /// `sources`: every text copied into the part as it is (the marker must
    /// not occur in it). `namespaces`: what the part root declares; None when
    /// the root is not known (a fragment written outside a part), and then
    /// prefixes are not judged.
    pub fn new(sources: &[&str], namespaces: Option<PartNamespaces>) -> Self {
        let mut name = String::from("seuoffice-inline-yields");
        while sources.iter().any(|xml| xml.contains(&name)) {
            name.push('_');
        }
        Self {
            marker: format!("<!--{name}-->"),
            namespaces,
        }
    }

    /// The part root declares all of `prefixes` (a root that is not known: not judged).
    pub fn takes(&self, prefixes: &HashSet<String>) -> bool {
        match &self.namespaces {
            None => true,
            Some(namespaces) => prefixes.iter().all(|prefix| namespaces.has(prefix)),
        }
    }

    /// `control_xml` (bytes starting a `w:sdt`) marked as written from a run: it gives way to a taken id.
    pub fn yielding(&self, control_xml: &str) -> String {
        format!("{}{control_xml}", self.marker)
    }

    /// `finish`: the part with the markers removed and the marked controls
    /// whose id is taken unwrapped.
    pub fn finish(&self, xml: &str) -> Result<String, RegexLimit> {
        let mut cuts: Vec<(usize, usize)> = Vec::new();
        let mut marked: HashSet<usize> = HashSet::new();
        let mut from = 0;
        while let Some(found) = xml[from..].find(&self.marker) {
            let at = from + found;
            let end = at + self.marker.len();
            cuts.push((at, end));
            marked.insert(end);
            // `indexOf(marker, at + 1)`: the next character boundary
            from = at + xml[at..].chars().next().map_or(1, char::len_utf8);
        }
        if cuts.is_empty() {
            return Ok(xml.to_owned());
        }
        struct Control {
            element: usize,
            id: String,
            yields: bool,
        }
        let mut controls: Vec<Control> = Vec::new();
        let tree = raw_elements(xml, true)?;
        let mut todo: Vec<usize> = tree.roots.iter().rev().copied().collect();
        while let Some(index) = todo.pop() {
            let element = tree.get(index);
            if element.name == "w:sdt" {
                let id_tag = tree
                    .children(element)
                    .find(|child| child.name == "w:sdtPr")
                    .and_then(|props| tree.children(props).find(|child| child.name == "w:id"));
                let attr = id_tag.and_then(|tag| {
                    js_regex!(r#"\bw:val\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
                        .exec(&xml[tag.start..tag.open_end])
                        .map(|found| {
                            found
                                .get(1)
                                .or_else(|| found.get(2))
                                .unwrap_or_default()
                                .to_owned()
                        })
                });
                if let Some(attr) = attr {
                    let mut id = decode_entities(&attr);
                    if js_regex!(r"^[+-]?\d+$").test(&id) {
                        id = canonical_integer(&id);
                    }
                    controls.push(Control {
                        element: index,
                        id,
                        yields: marked.contains(&element.start),
                    });
                }
            }
            for child in element.children.iter().rev() {
                todo.push(*child);
            }
        }
        let mut taken: HashSet<&str> = controls
            .iter()
            .filter(|control| !control.yields)
            .map(|control| control.id.as_str())
            .collect();
        for control in &controls {
            if !control.yields {
                continue;
            }
            if taken.insert(control.id.as_str()) {
                continue;
            }
            // unwrap, do not delete: what the control held stays where it was
            let element = tree.get(control.element);
            cuts.push((element.start, element.open_end));
            cuts.push((element.close_start, element.end));
            for child in tree.children(element) {
                if child.name == "w:sdtPr" || child.name == "w:sdtEndPr" {
                    cuts.push((child.start, child.end));
                } else if child.name == "w:sdtContent" {
                    cuts.push((child.start, child.open_end));
                    cuts.push((child.close_start, child.end));
                }
            }
        }
        cuts.sort_by_key(|cut| cut.0);
        let mut out = String::with_capacity(xml.len());
        let mut cursor = 0;
        for (start, end) in cuts {
            if start > cursor {
                out.push_str(&xml[cursor..start]);
            }
            cursor = cursor.max(end);
        }
        out.push_str(&xml[cursor..]);
        Ok(out)
    }
}

/// The id of a control as an integer is read: a plus sign and leading zeros
/// go, and `-0` is `0`.
fn canonical_integer(id: &str) -> String {
    let id = id.strip_prefix('+').unwrap_or(id);
    let (sign, digits) = match id.strip_prefix('-') {
        Some(digits) => ("-", digits),
        None => ("", id),
    };
    let trimmed = digits.trim_start_matches('0');
    let digits = if trimmed.is_empty() && !digits.is_empty() {
        "0"
    } else {
        trimmed
    };
    if sign == "-" && digits == "0" {
        "0".to_owned()
    } else {
        format!("{sign}{digits}")
    }
}
