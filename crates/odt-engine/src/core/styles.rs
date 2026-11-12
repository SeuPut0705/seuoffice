//! `core/styles.ts`: the style table of an ODT: common styles, default
//! styles, list styles, page layouts and master pages from styles.xml, plus
//! the automatic styles of both styles.xml and content.xml, each with its
//! source range.
//!
//! Every offset (`start`, `open_end`, `close_start`, `end`) is a UTF-8 byte
//! offset into the decoded part string (see `core/body.rs`). A style is an
//! `Rc<OdtStyle>`, immutable once the table is read; the table's lookups
//! answer clones of the `Rc`.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use jscompat::{JsMap, JsObject, Radix, parse_int};
use serde::{Deserialize, Serialize};

use super::xml::CloseVerdict;
use super::xml::{
    ElementFrame, ElementRange, ElementVisitor, OpenVerdict, PrefixMap, attribute_map,
    read_attributes, read_root, walk_elements,
};

/// `OdtStylePart`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OdtStylePart {
    #[serde(rename = "styles.xml")]
    StylesXml,
    #[serde(rename = "content.xml")]
    ContentXml,
}

impl OdtStylePart {
    /// The string the TypeScript holds (`content.xml`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StylesXml => "styles.xml",
            Self::ContentXml => "content.xml",
        }
    }

    /// `part === 'content.xml' ? 'content' : 'styles'`
    pub fn scope(self) -> OdtStyleScope {
        match self {
            Self::ContentXml => OdtStyleScope::Content,
            Self::StylesXml => OdtStyleScope::Styles,
        }
    }

    /// `content.xml` then `styles.xml`: the order the TypeScript loops write
    /// `['content.xml', 'styles.xml']` in.
    pub const BOTH: [OdtStylePart; 2] = [Self::ContentXml, Self::StylesXml];
}

/// `Record<OdtStylePart, T>`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PerPart<T> {
    pub content: T,
    pub styles: T,
}

impl<T> PerPart<T> {
    pub fn get(&self, part: OdtStylePart) -> &T {
        match part {
            OdtStylePart::ContentXml => &self.content,
            OdtStylePart::StylesXml => &self.styles,
        }
    }

    pub fn get_mut(&mut self, part: OdtStylePart) -> &mut T {
        match part {
            OdtStylePart::ContentXml => &mut self.content,
            OdtStylePart::StylesXml => &mut self.styles,
        }
    }
}

/// `OdtStyleScope`: which automatic styles a reference can see: the body's
/// (`content`) or the master pages' (`styles`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OdtStyleScope {
    Content,
    Styles,
}

impl OdtStyleScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::Styles => "styles",
        }
    }
}

/// `OdtStyleKind`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OdtStyleKind {
    /// `style:style`
    Style,
    /// `style:default-style`
    DefaultStyle,
    /// `text:list-style`
    ListStyle,
    /// `text:outline-style`
    OutlineStyle,
    /// `style:page-layout`
    PageLayout,
    /// data styles, notes configuration, gradients ...
    Other,
}

impl OdtStyleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Style => "style",
            Self::DefaultStyle => "default-style",
            Self::ListStyle => "list-style",
            Self::OutlineStyle => "outline-style",
            Self::PageLayout => "page-layout",
            Self::Other => "other",
        }
    }
}

/// `OdtPropertyBag`: attribute bags of property elements keyed by their
/// element path below the style element (`style:paragraph-properties`,
/// `style:header-style/style:header-footer-properties`).
pub type OdtPropertyBag = JsObject<JsObject<String>>;

/// `OdtListLevel['kind']`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OdtListLevelKind {
    Number,
    Bullet,
    Image,
    Outline,
    Other,
}

impl OdtListLevelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Number => "number",
            Self::Bullet => "bullet",
            Self::Image => "image",
            Self::Outline => "outline",
            Self::Other => "other",
        }
    }
}

/// `OdtListLevel` (extends `ElementRange`: its fields come first)
#[derive(Clone, Debug)]
pub struct OdtListLevel {
    pub start: usize,
    pub open_end: usize,
    pub close_start: usize,
    pub end: usize,
    pub self_closing: bool,
    /// `text:level` (1-based; 0 when missing or not a number; a value past
    /// `i64` saturates)
    pub level: i64,
    pub kind: OdtListLevelKind,
    /// canonical element name
    pub element_name: String,
    pub attrs: JsObject<String>,
    pub properties: OdtPropertyBag,
}

impl OdtListLevel {
    pub fn range(&self) -> ElementRange {
        ElementRange {
            start: self.start,
            open_end: self.open_end,
            close_start: self.close_start,
            end: self.end,
            self_closing: self.self_closing,
        }
    }
}

/// `OdtStyle` (extends `ElementRange`: its fields come first)
#[derive(Clone, Debug)]
pub struct OdtStyle {
    pub start: usize,
    pub open_end: usize,
    pub close_start: usize,
    pub end: usize,
    pub self_closing: bool,
    pub kind: OdtStyleKind,
    /// canonical element name (`style:style`)
    pub element_name: String,
    /// element name as written
    pub tag: String,
    /// decoded `style:name` (`""` for default styles)
    pub name: String,
    /// `style:name` exactly as written (entity references intact)
    pub raw_name: Option<String>,
    pub display_name: Option<String>,
    /// `style:family`; `None` for list styles, outline styles and page layouts
    pub family: Option<String>,
    pub parent_name: Option<String>,
    pub master_page_name: Option<String>,
    pub list_style_name: Option<String>,
    pub next_style_name: Option<String>,
    /// an automatic style (`office:automatic-styles`) rather than a common one
    pub automatic: bool,
    pub part: OdtStylePart,
    /// decoded attributes of the style element
    pub attrs: JsObject<String>,
    /// this style's own properties (not inherited)
    pub properties: OdtPropertyBag,
    /// own tab stops (attribute maps of `style:tab-stop`); `None` when the style does not set them
    pub tab_stops: Option<Vec<JsObject<String>>>,
    /// levels of a list or outline style; empty otherwise
    pub levels: Vec<OdtListLevel>,
}

impl OdtStyle {
    pub fn range(&self) -> ElementRange {
        ElementRange {
            start: self.start,
            open_end: self.open_end,
            close_start: self.close_start,
            end: self.end,
            self_closing: self.self_closing,
        }
    }
}

/// `OdtMasterPageRegionName`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OdtMasterPageRegionName {
    Header,
    Footer,
    HeaderLeft,
    FooterLeft,
    HeaderFirst,
    FooterFirst,
}

impl OdtMasterPageRegionName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Header => "header",
            Self::Footer => "footer",
            Self::HeaderLeft => "header-left",
            Self::FooterLeft => "footer-left",
            Self::HeaderFirst => "header-first",
            Self::FooterFirst => "footer-first",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "header" => Self::Header,
            "footer" => Self::Footer,
            "header-left" => Self::HeaderLeft,
            "footer-left" => Self::FooterLeft,
            "header-first" => Self::HeaderFirst,
            "footer-first" => Self::FooterFirst,
            _ => return None,
        })
    }
}

/// `OdtMasterPageRegion` (extends `ElementRange`)
#[derive(Clone, Debug)]
pub struct OdtMasterPageRegion {
    pub start: usize,
    pub open_end: usize,
    pub close_start: usize,
    pub end: usize,
    pub self_closing: bool,
    pub attrs: JsObject<String>,
}

impl OdtMasterPageRegion {
    pub fn range(&self) -> ElementRange {
        ElementRange {
            start: self.start,
            open_end: self.open_end,
            close_start: self.close_start,
            end: self.end,
            self_closing: self.self_closing,
        }
    }
}

/// `OdtMasterPage` (extends `ElementRange`; its `part` is always `styles.xml`)
#[derive(Clone, Debug)]
pub struct OdtMasterPage {
    pub start: usize,
    pub open_end: usize,
    pub close_start: usize,
    pub end: usize,
    pub self_closing: bool,
    pub name: String,
    pub raw_name: Option<String>,
    pub display_name: Option<String>,
    pub page_layout_name: Option<String>,
    pub next_style_name: Option<String>,
    pub tag: String,
    pub attrs: JsObject<String>,
    /// header/footer regions present, in document order (the first of a name wins)
    pub regions: Vec<(OdtMasterPageRegionName, OdtMasterPageRegion)>,
}

impl OdtMasterPage {
    pub fn range(&self) -> ElementRange {
        ElementRange {
            start: self.start,
            open_end: self.open_end,
            close_start: self.close_start,
            end: self.end,
            self_closing: self.self_closing,
        }
    }

    /// `page.regions[name]`
    pub fn region(&self, name: OdtMasterPageRegionName) -> Option<&OdtMasterPageRegion> {
        self.regions
            .iter()
            .find(|(own, _)| *own == name)
            .map(|(_, region)| region)
    }
}

/// `OdtStyleContainers`
#[derive(Clone, Debug, Default)]
pub struct OdtStyleContainers {
    pub font_face_decls: Option<ElementRange>,
    pub styles: Option<ElementRange>,
    pub automatic_styles: Option<ElementRange>,
    pub master_styles: Option<ElementRange>,
    /// the TypeScript keys (`fontFaceDecls`, `styles`, `automaticStyles`,
    /// `masterStyles`) in the order they were first set: the key order of
    /// the JavaScript object
    pub order: Vec<&'static str>,
}

impl OdtStyleContainers {
    /// `containers.<key> ??= range`
    fn set_once(&mut self, key: &'static str, range: ElementRange) {
        let slot = match key {
            "fontFaceDecls" => &mut self.font_face_decls,
            "styles" => &mut self.styles,
            "automaticStyles" => &mut self.automatic_styles,
            _ => &mut self.master_styles,
        };
        if slot.is_none() {
            *slot = Some(range);
            self.order.push(key);
        }
    }
}

/// `OdtResolvedStyle`
#[derive(Clone, Debug)]
pub struct OdtResolvedStyle {
    pub style: Rc<OdtStyle>,
    /// the style, then its common ancestors, nearest first
    pub chain: Vec<Rc<OdtStyle>>,
    /// the default style of the family, if any
    pub default_style: Option<Rc<OdtStyle>>,
    /// effective properties: default style, then ancestors, then the style; nearest wins per attribute
    pub properties: OdtPropertyBag,
    /// effective tab stops: from the nearest style (or default style) that sets them
    pub tab_stops: Option<Vec<JsObject<String>>>,
    /// a parent name that could not be found among common styles (Hancom's `Standard`)
    pub missing_parent: Option<String>,
}

/// `STYLE_KINDS[name]`
fn style_kind(name: &str) -> OdtStyleKind {
    match name {
        "style:style" => OdtStyleKind::Style,
        "style:default-style" => OdtStyleKind::DefaultStyle,
        "text:list-style" => OdtStyleKind::ListStyle,
        "text:outline-style" => OdtStyleKind::OutlineStyle,
        "style:page-layout" => OdtStyleKind::PageLayout,
        _ => OdtStyleKind::Other,
    }
}

type Key = (String, String);

/// `key(family, name)`
fn key(family: &str, name: &str) -> Key {
    (family.to_owned(), name.to_owned())
}

/// `OdtStyleTable`
#[derive(Default)]
pub struct OdtStyleTable {
    /// every style record (styles.xml first, then content.xml), document order
    pub all: Vec<Rc<OdtStyle>>,
    pub master_pages: Vec<Rc<OdtMasterPage>>,
    /// `containers.styles` and `containers.content`
    pub containers: PerPart<OdtStyleContainers>,
    common_by_key: HashMap<Key, Rc<OdtStyle>>,
    auto_by_key: PerPart<HashMap<Key, Rc<OdtStyle>>>,
    defaults: HashMap<String, Rc<OdtStyle>>,
    common_lists: HashMap<String, Rc<OdtStyle>>,
    auto_lists: PerPart<HashMap<String, Rc<OdtStyle>>>,
    layouts: HashMap<String, Rc<OdtStyle>>,
    masters: HashMap<String, Rc<OdtMasterPage>>,
}

fn set_once<K: std::hash::Hash + Eq, V>(map: &mut HashMap<K, V>, k: K, v: V) {
    map.entry(k).or_insert(v);
}

impl OdtStyleTable {
    /// `new OdtStyleTable()`
    pub fn new() -> Self {
        Self::default()
    }

    /// `table.add(style)` (internal to the reader)
    fn add(&mut self, style: OdtStyle) {
        let style = Rc::new(style);
        self.all.push(Rc::clone(&style));
        let part = style.part;
        match (style.kind, style.family.as_deref()) {
            (OdtStyleKind::Style, Some(family)) => {
                let map = if style.automatic {
                    self.auto_by_key.get_mut(part)
                } else {
                    &mut self.common_by_key
                };
                set_once(map, key(family, &style.name), Rc::clone(&style));
            }
            (OdtStyleKind::DefaultStyle, Some(family)) => {
                set_once(&mut self.defaults, family.to_owned(), Rc::clone(&style));
            }
            (OdtStyleKind::ListStyle, _) => {
                let map = if style.automatic {
                    self.auto_lists.get_mut(part)
                } else {
                    &mut self.common_lists
                };
                set_once(map, style.name.clone(), Rc::clone(&style));
            }
            (OdtStyleKind::PageLayout, _) => {
                set_once(&mut self.layouts, style.name.clone(), Rc::clone(&style));
            }
            _ => {}
        }
    }

    /// `table.addMasterPage(page)` (internal to the reader)
    fn add_master_page(&mut self, page: OdtMasterPage) {
        let page = Rc::new(page);
        self.master_pages.push(Rc::clone(&page));
        set_once(&mut self.masters, page.name.clone(), page);
    }

    /// `find`: a style as a reference from `scope` sees it: that part's
    /// automatic styles, then common styles.
    pub fn find(&self, name: &str, family: &str, scope: OdtStyleScope) -> Option<Rc<OdtStyle>> {
        let k = key(family, name);
        let auto = match scope {
            OdtStyleScope::Content => &self.auto_by_key.content,
            OdtStyleScope::Styles => &self.auto_by_key.styles,
        };
        auto.get(&k).or_else(|| self.common_by_key.get(&k)).cloned()
    }

    /// `common`: a common (`office:styles`) style.
    pub fn common(&self, name: &str, family: &str) -> Option<Rc<OdtStyle>> {
        self.common_by_key.get(&key(family, name)).cloned()
    }

    /// `defaultStyle`: the `style:default-style` of a family.
    pub fn default_style(&self, family: &str) -> Option<Rc<OdtStyle>> {
        self.defaults.get(family).cloned()
    }

    /// `listStyle`: a list style as seen from `scope`.
    pub fn list_style(&self, name: &str, scope: OdtStyleScope) -> Option<Rc<OdtStyle>> {
        let auto = match scope {
            OdtStyleScope::Content => &self.auto_lists.content,
            OdtStyleScope::Styles => &self.auto_lists.styles,
        };
        auto.get(name)
            .or_else(|| self.common_lists.get(name))
            .cloned()
    }

    /// `pageLayout`
    pub fn page_layout(&self, name: &str) -> Option<Rc<OdtStyle>> {
        self.layouts.get(name).cloned()
    }

    /// `masterPage`
    pub fn master_page(&self, name: &str) -> Option<Rc<OdtMasterPage>> {
        self.masters.get(name).cloned()
    }

    /// `resolve`: effective properties of a style: its family's default
    /// style, then its common ancestors (farthest first), then the style
    /// itself. Parents are looked up among common styles only; a missing
    /// parent ends the chain and is reported, and a cycle ends it silently.
    pub fn resolve(
        &self,
        name: &str,
        family: &str,
        scope: OdtStyleScope,
    ) -> Option<OdtResolvedStyle> {
        let style = self.find(name, family, scope)?;
        let mut chain: Vec<Rc<OdtStyle>> = vec![Rc::clone(&style)];
        let mut seen: HashSet<*const OdtStyle> = HashSet::new();
        seen.insert(Rc::as_ptr(&style));
        let mut missing_parent: Option<String> = None;
        let mut current = Rc::clone(&style);
        while let Some(parent_name) = current.parent_name.clone() {
            let Some(parent) = self.common(&parent_name, family) else {
                missing_parent = Some(parent_name);
                break;
            };
            if !seen.insert(Rc::as_ptr(&parent)) {
                break;
            }
            chain.push(Rc::clone(&parent));
            current = parent;
        }
        let default_style = self.defaults.get(family).cloned();
        let mut layers: Vec<&Rc<OdtStyle>> = Vec::new();
        if let Some(default_style) = &default_style {
            layers.push(default_style);
        }
        layers.extend(chain.iter().rev());
        let mut properties: OdtPropertyBag = JsObject::new();
        for layer in layers {
            for (path, bag) in layer.properties.entries() {
                match properties.get_mut(path) {
                    Some(target) => target.assign(bag),
                    None => properties.set(path, bag.clone()),
                }
            }
        }
        let mut tab_stops: Option<Vec<JsObject<String>>> = None;
        let mut tab_layers: Vec<&Rc<OdtStyle>> = chain.iter().collect();
        if let Some(default_style) = &default_style {
            tab_layers.push(default_style);
        }
        for layer in tab_layers {
            if let Some(stops) = &layer.tab_stops {
                tab_stops = Some(stops.clone());
                break;
            }
        }
        Some(OdtResolvedStyle {
            style,
            chain,
            default_style,
            properties,
            tab_stops,
            missing_parent,
        })
    }
}

/// `TreeElement`: a light element tree used for the style sections only
/// (an arena entry; `children` index the arena).
struct TreeElement {
    name: String,
    tag: String,
    name_end: usize,
    start: usize,
    open_end: usize,
    close_start: usize,
    end: usize,
    self_closing: bool,
    children: Vec<usize>,
}

struct Tree {
    nodes: Vec<TreeElement>,
    roots: Vec<usize>,
    stop_at: Option<&'static str>,
}

impl ElementVisitor for Tree {
    type Data = usize;

    fn open(
        &mut self,
        el: &mut ElementFrame<usize>,
        parent: Option<&ElementFrame<usize>>,
    ) -> OpenVerdict {
        if self.stop_at == Some(el.name.as_str()) {
            return OpenVerdict::Stop;
        }
        let index = self.nodes.len();
        self.nodes.push(TreeElement {
            name: el.name.clone(),
            tag: el.tag.clone(),
            name_end: el.name_end,
            start: el.start,
            open_end: el.open_end,
            close_start: el.open_end,
            end: el.open_end,
            self_closing: el.self_closing,
            children: Vec::new(),
        });
        el.data = Some(index);
        match parent.and_then(|p| p.data) {
            Some(owner) => self.nodes[owner].children.push(index),
            None => self.roots.push(index),
        }
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<usize>,
        _parent: Option<&ElementFrame<usize>>,
    ) -> CloseVerdict {
        if let Some(index) = el.data {
            let node = &mut self.nodes[index];
            node.close_start = el.close_start.unwrap_or(node.close_start);
            node.end = el.end.unwrap_or(node.end);
        }
        CloseVerdict::Continue
    }
}

/// `buildTree`
fn build_tree(xml: &str, prefixes: &PrefixMap, stop_at: Option<&'static str>) -> Tree {
    let mut tree = Tree {
        nodes: Vec::new(),
        roots: Vec::new(),
        stop_at,
    };
    walk_elements(xml, prefixes, &mut tree, 0, xml.len());
    tree
}

/// `readOdtStyles`: builds the style table from styles.xml (may be missing)
/// and content.xml. Never fails on malformed style markup.
pub fn read_odt_styles(styles_xml: Option<&str>, content_xml: &str) -> OdtStyleTable {
    let mut table = OdtStyleTable::new();
    if let Some(styles_xml) = styles_xml {
        read_part(&mut table, styles_xml, OdtStylePart::StylesXml);
    }
    read_part(&mut table, content_xml, OdtStylePart::ContentXml);
    table
}

/// `rangeOf`
fn range_of(el: &TreeElement) -> ElementRange {
    ElementRange {
        start: el.start,
        open_end: el.open_end,
        close_start: el.close_start,
        end: el.end,
        self_closing: el.self_closing,
    }
}

struct PartReader<'a> {
    xml: &'a str,
    prefixes: &'a PrefixMap,
    nodes: &'a [TreeElement],
}

impl PartReader<'_> {
    fn attrs(&self, el: usize) -> JsObject<String> {
        let el = &self.nodes[el];
        attribute_map(self.xml, el.name_end, el.open_end, self.prefixes)
    }

    fn raw_name(&self, el: usize) -> Option<String> {
        let el = &self.nodes[el];
        read_attributes(self.xml, el.name_end, el.open_end)
            .into_iter()
            .find(|a| self.prefixes.canonical(&a.name) == "style:name")
            .map(|a| a.raw)
    }

    /// `collectProperties`
    fn collect_properties(&self, el: usize) -> OdtPropertyBag {
        let mut bag: OdtPropertyBag = JsObject::new();
        self.visit(&mut bag, el, "", false);
        bag
    }

    fn visit(&self, bag: &mut OdtPropertyBag, node: usize, path: &str, inside_properties: bool) {
        let children = &self.nodes[node].children;
        let mut counts: JsMap<usize> = JsMap::new();
        for &child in children {
            let name = &self.nodes[child].name;
            let next = counts.get(name).copied().unwrap_or(0) + 1;
            counts.set(name.clone(), next);
        }
        for &child in children {
            let child_name = self.nodes[child].name.as_str();
            if child_name == "style:tab-stops" {
                continue;
            }
            let child_path = if path.is_empty() {
                child_name.to_owned()
            } else {
                format!("{path}/{child_name}")
            };
            let is_properties = child_name.ends_with("-properties");
            let own = self.attrs(child);
            if is_properties
                || (inside_properties && counts.get(child_name) == Some(&1) && own.len() > 0)
            {
                match bag.get_mut(&child_path) {
                    Some(target) => target.assign(&own),
                    None => bag.set(child_path.clone(), own),
                }
            }
            self.visit(bag, child, &child_path, inside_properties || is_properties);
        }
    }

    /// `tabStopsOf`
    fn tab_stops_of(&self, el: usize) -> Option<Vec<JsObject<String>>> {
        let props = self.nodes[el]
            .children
            .iter()
            .copied()
            .find(|&c| self.nodes[c].name == "style:paragraph-properties")?;
        let stops = self.nodes[props]
            .children
            .iter()
            .copied()
            .find(|&c| self.nodes[c].name == "style:tab-stops")?;
        Some(
            self.nodes[stops]
                .children
                .iter()
                .copied()
                .filter(|&c| self.nodes[c].name == "style:tab-stop")
                .map(|c| self.attrs(c))
                .collect(),
        )
    }

    /// `record`
    fn record(&self, el: usize, automatic: bool, part: OdtStylePart) -> OdtStyle {
        let node = &self.nodes[el];
        let a = self.attrs(el);
        let kind = style_kind(&node.name);
        let mut levels = Vec::new();
        if kind == OdtStyleKind::ListStyle || kind == OdtStyleKind::OutlineStyle {
            for &child in &node.children {
                let child_node = &self.nodes[child];
                let local = &child_node.name[child_node.name.find(':').map_or(0, |i| i + 1)..];
                if !local.starts_with("list-level-style-") && local != "outline-level-style" {
                    continue;
                }
                let level_attrs = self.attrs(child);
                let level_kind = if local == "outline-level-style" {
                    OdtListLevelKind::Outline
                } else if local == "list-level-style-number" {
                    OdtListLevelKind::Number
                } else if local == "list-level-style-bullet" {
                    OdtListLevelKind::Bullet
                } else if local == "list-level-style-image" {
                    OdtListLevelKind::Image
                } else {
                    OdtListLevelKind::Other
                };
                let range = range_of(child_node);
                let parsed = parse_int(
                    level_attrs.get("text:level").map_or("", String::as_str),
                    Radix::Ten,
                );
                let level = if parsed.is_nan() { 0 } else { parsed as i64 };
                levels.push(OdtListLevel {
                    start: range.start,
                    open_end: range.open_end,
                    close_start: range.close_start,
                    end: range.end,
                    self_closing: range.self_closing,
                    level,
                    kind: level_kind,
                    element_name: child_node.name.clone(),
                    properties: self.collect_properties(child),
                    attrs: level_attrs,
                });
            }
        }
        let get = |name: &str| a.get(name).cloned();
        let range = range_of(node);
        OdtStyle {
            start: range.start,
            open_end: range.open_end,
            close_start: range.close_start,
            end: range.end,
            self_closing: range.self_closing,
            kind,
            element_name: node.name.clone(),
            tag: node.tag.clone(),
            name: get("style:name").unwrap_or_default(),
            raw_name: self.raw_name(el),
            display_name: get("style:display-name"),
            family: if kind == OdtStyleKind::Style || kind == OdtStyleKind::DefaultStyle {
                get("style:family")
            } else {
                None
            },
            parent_name: get("style:parent-style-name"),
            master_page_name: get("style:master-page-name"),
            list_style_name: get("style:list-style-name"),
            next_style_name: get("style:next-style-name"),
            automatic,
            part,
            properties: if kind == OdtStyleKind::ListStyle || kind == OdtStyleKind::OutlineStyle {
                JsObject::new()
            } else {
                self.collect_properties(el)
            },
            tab_stops: if kind == OdtStyleKind::Style || kind == OdtStyleKind::DefaultStyle {
                self.tab_stops_of(el)
            } else {
                None
            },
            levels,
            attrs: a,
        }
    }
}

/// `readPart`
fn read_part(table: &mut OdtStyleTable, xml: &str, part: OdtStylePart) {
    let Some(root) = read_root(xml) else {
        return;
    };
    let prefixes = root.prefixes;
    let tree = build_tree(
        xml,
        &prefixes,
        if part == OdtStylePart::ContentXml {
            Some("office:body")
        } else {
            None
        },
    );
    let Some(&doc_element) = tree.roots.first() else {
        return;
    };
    let reader = PartReader {
        xml,
        prefixes: &prefixes,
        nodes: &tree.nodes,
    };
    for &section in &tree.nodes[doc_element].children {
        let section_node = &tree.nodes[section];
        match section_node.name.as_str() {
            "office:font-face-decls" => {
                table
                    .containers
                    .get_mut(part)
                    .set_once("fontFaceDecls", range_of(section_node));
            }
            "office:styles" => {
                table
                    .containers
                    .get_mut(part)
                    .set_once("styles", range_of(section_node));
                for &el in &section_node.children {
                    table.add(reader.record(el, false, part));
                }
            }
            "office:automatic-styles" => {
                table
                    .containers
                    .get_mut(part)
                    .set_once("automaticStyles", range_of(section_node));
                for &el in &section_node.children {
                    table.add(reader.record(el, true, part));
                }
            }
            "office:master-styles" => {
                table
                    .containers
                    .get_mut(part)
                    .set_once("masterStyles", range_of(section_node));
                if part != OdtStylePart::StylesXml {
                    continue;
                }
                for &el in &section_node.children {
                    let node = &tree.nodes[el];
                    if node.name != "style:master-page" {
                        continue;
                    }
                    let a = reader.attrs(el);
                    let mut regions: Vec<(OdtMasterPageRegionName, OdtMasterPageRegion)> =
                        Vec::new();
                    for &child in &node.children {
                        let child_node = &tree.nodes[child];
                        let local = child_node.name.strip_prefix("style:").unwrap_or("");
                        let Some(region_name) = OdtMasterPageRegionName::parse(local) else {
                            continue;
                        };
                        if regions.iter().any(|(own, _)| *own == region_name) {
                            continue;
                        }
                        let range = range_of(child_node);
                        regions.push((
                            region_name,
                            OdtMasterPageRegion {
                                start: range.start,
                                open_end: range.open_end,
                                close_start: range.close_start,
                                end: range.end,
                                self_closing: range.self_closing,
                                attrs: reader.attrs(child),
                            },
                        ));
                    }
                    let range = range_of(node);
                    table.add_master_page(OdtMasterPage {
                        start: range.start,
                        open_end: range.open_end,
                        close_start: range.close_start,
                        end: range.end,
                        self_closing: range.self_closing,
                        name: a.get("style:name").cloned().unwrap_or_default(),
                        raw_name: reader.raw_name(el),
                        display_name: a.get("style:display-name").cloned(),
                        page_layout_name: a.get("style:page-layout-name").cloned(),
                        next_style_name: a.get("style:next-style-name").cloned(),
                        tag: node.tag.clone(),
                        attrs: a,
                        regions,
                    });
                }
            }
            _ => {}
        }
    }
}
