//! `text/style-xml.ts`: narrow string edits of one ODF style element: rename,
//! re-parent, set or remove attributes of its property elements, replace its
//! tab-stop list. Everything the edit does not name keeps its exact bytes: this
//! is how a new automatic style "inherits" ALL properties of the original one
//! (tab stops, Hancom attributes, unknown children) and overrides only what
//! changed.
//!
//! Offsets are UTF-8 byte offsets here, the part string being a tag or an
//! element source cut from a part.

use jscompat::{JsObject, is_js_space, slice_utf16};
use serde::{Deserialize, Deserializer};

use crate::core::convert::{TextPatch, apply_text_patches};
use crate::core::errors::OdtError;
use crate::core::styles::OdtStylePart;
use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementRange, ElementVisitor, OpenVerdict, PrefixMap,
    escape_xml_attr, read_attributes, walk_elements,
};
use crate::offset::{to_u16, u16_len};

use super::props::AttrOverrides;

/// `Option<Option<T>>` for a key that is absent (`undefined`), null, or a value.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `StyleXmlEdit`
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleXmlEdit {
    /// new `style:name`
    #[serde(default)]
    pub name: Option<String>,
    /// new `style:parent-style-name`; `Some(None)` (null) removes it
    #[serde(default, deserialize_with = "double_option")]
    pub parent: Option<Option<String>>,
    /// attributes of the style element to set (value) or remove (null)
    #[serde(default)]
    pub attrs: Option<AttrOverrides>,
    /// property element (`style:paragraph-properties` ...) to attribute overrides
    #[serde(default)]
    pub props: Option<JsObject<AttrOverrides>>,
    /// new inner XML of `style:paragraph-properties/style:tab-stops`
    #[serde(default)]
    pub tab_stops: Option<String>,
}

/// `PROPERTY_ORDER`: schema order of property elements inside `style:style`.
const PROPERTY_ORDER: [&str; 11] = [
    "style:graphic-properties",
    "style:drawing-page-properties",
    "style:paragraph-properties",
    "style:text-properties",
    "style:ruby-properties",
    "style:section-properties",
    "style:table-properties",
    "style:table-column-properties",
    "style:table-row-properties",
    "style:table-cell-properties",
    "style:chart-properties",
];

/// One `{ start, end, xml }` of `local`.
struct Edit {
    start: usize,
    end: usize,
    xml: String,
}

/// `local`: `applyTextPatches` over one string, as the patches of `content.xml`.
fn local(xml: &str, edits: Vec<Edit>) -> Result<String, OdtError> {
    let patches: Vec<TextPatch> = edits
        .into_iter()
        .map(|e| TextPatch {
            part: OdtStylePart::ContentXml,
            start: e.start,
            end: e.end,
            xml: e.xml,
        })
        .collect();
    apply_text_patches(xml, &patches)
}

/// `/^<([^\s/>]+)/.exec(tag)?.[1]`: the name a start tag opens with.
pub(crate) fn tag_name(tag: &str) -> Option<&str> {
    let rest = tag.strip_prefix('<')?;
    let end = rest
        .find(|c: char| is_js_space(c) || c == '/' || c == '>')
        .unwrap_or(rest.len());
    if end == 0 { None } else { Some(&rest[..end]) }
}

/// `.replace(/\s*\/>$/, '>')`: an empty-element tag written as an open tag.
pub(crate) fn as_open_tag(tag: &str) -> String {
    match tag.strip_suffix("/>") {
        Some(head) => format!("{}>", head.trim_end_matches(is_js_space)),
        None => tag.to_owned(),
    }
}

/// `patchStartTag`: applies attribute overrides to one start tag (`<x a="1" ...>`
/// or `<x .../>`).
pub fn patch_start_tag(
    tag: &str,
    prefixes: &PrefixMap,
    overrides: &AttrOverrides,
) -> Result<String, OdtError> {
    let name_end = tag_name(tag).map_or(1, |n| 1 + n.len());
    let attrs = read_attributes(tag, name_end, tag.len());
    let mut edits: Vec<Edit> = Vec::new();
    let mut appended: Vec<String> = Vec::new();
    for (name, value) in overrides.entries() {
        let found = attrs.iter().find(|a| prefixes.canonical(&a.name) == name);
        if let Some(found) = found {
            match value {
                None => {
                    let mut s = found.name_start;
                    while s > name_end && tag[..s].chars().next_back().is_some_and(is_js_space) {
                        s -= tag[..s].chars().next_back().map_or(1, char::len_utf8);
                    }
                    edits.push(Edit {
                        start: s,
                        end: tag.len().min(found.value_end + 1),
                        xml: String::new(),
                    });
                }
                Some(value) => edits.push(Edit {
                    start: found.value_start,
                    end: found.value_end,
                    xml: escape_xml_attr(value),
                }),
            }
        } else if let Some(value) = value {
            appended.push(format!(" {name}=\"{}\"", escape_xml_attr(value)));
        }
    }
    if !appended.is_empty() {
        // `tag.length - 1` or `- 2` units: one character back (the last character of a tag
        // is one unit unless it is outside the BMP, where the TypeScript's index falls
        // between the halves and this string cannot, so the insertion goes before the pair)
        let Some(last) = (if tag.ends_with("/>") {
            Some(2)
        } else {
            tag.chars().next_back().map(char::len_utf8)
        }) else {
            // an empty tag: the TypeScript's insertion at -1 is refused by applyTextPatches
            return Err(OdtError::thrown("odt: overlapping patches at -1"));
        };
        let close = tag.len() - last;
        let mut at = close;
        while at > name_end && tag[..at].chars().next_back().is_some_and(is_js_space) {
            at -= tag[..at].chars().next_back().map_or(1, char::len_utf8);
        }
        edits.push(Edit {
            start: at,
            end: at,
            xml: appended.concat(),
        });
    }
    if edits.is_empty() {
        Ok(tag.to_owned())
    } else {
        local(tag, edits)
    }
}

/// `Child`
struct Child {
    name: String,
    tag: String,
    range: ElementRange,
}

/// The visitor of `directChildren`.
struct DirectChildren {
    out: Vec<Child>,
}

impl ElementVisitor for DirectChildren {
    type Data = ();

    fn open(
        &mut self,
        _el: &mut ElementFrame<()>,
        parent: Option<&ElementFrame<()>>,
    ) -> OpenVerdict {
        if parent.is_some() {
            OpenVerdict::Skip
        } else {
            OpenVerdict::Continue
        }
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<()>,
        parent: Option<&ElementFrame<()>>,
    ) -> CloseVerdict {
        if parent.is_none() {
            self.out.push(Child {
                name: el.name.clone(),
                tag: el.tag.clone(),
                range: el.range(),
            });
        }
        CloseVerdict::Continue
    }
}

/// `directChildren`
fn direct_children(xml: &str, prefixes: &PrefixMap, from: usize, to: usize) -> Vec<Child> {
    let mut visitor = DirectChildren { out: Vec::new() };
    walk_elements(xml, prefixes, &mut visitor, from, to);
    visitor.out
}

/// `editStyleXml`: applies `edit` to the style element `xml` (the exact element
/// source).
pub fn edit_style_xml(
    xml: &str,
    prefixes: &PrefixMap,
    edit: &StyleXmlEdit,
) -> Result<String, OdtError> {
    let root_tag_end = xml.find('>').map_or(0, |gt| gt + 1);
    let mut root_tag = xml[..root_tag_end].to_owned();
    let root_name = tag_name(&root_tag).unwrap_or("style:style").to_owned();
    let mut body = String::new();
    if root_tag.ends_with("/>") {
        root_tag = as_open_tag(&root_tag);
    } else {
        // `xml.slice(rootTagEnd, xml.length - closing.length)`, counted in UTF-16 units
        let closing = format!("</{root_name}>");
        body = slice_utf16(
            xml,
            f64::from(to_u16(xml, root_tag_end).0),
            Some(f64::from(u16_len(xml).0) - f64::from(u16_len(&closing).0)),
        );
    }
    let mut tag_overrides = AttrOverrides::new();
    if let Some(attrs) = &edit.attrs {
        tag_overrides.assign(attrs);
    }
    if let Some(name) = &edit.name {
        tag_overrides.set("style:name", Some(name.clone()));
    }
    if let Some(parent) = &edit.parent {
        tag_overrides.set("style:parent-style-name", parent.clone());
    }
    root_tag = patch_start_tag(&root_tag, prefixes, &tag_overrides)?;

    let mut props: JsObject<AttrOverrides> = JsObject::new();
    if let Some(given) = &edit.props {
        props.assign(given);
    }
    if edit.tab_stops.is_some() && props.get("style:paragraph-properties").is_none() {
        props.set("style:paragraph-properties", AttrOverrides::new());
    }
    let children = direct_children(&body, prefixes, 0, body.len());
    let mut edits: Vec<Edit> = Vec::new();
    for (prop_name, overrides) in props.entries() {
        let child = children.iter().find(|c| c.name == prop_name);
        let tabs = if prop_name == "style:paragraph-properties" {
            edit.tab_stops.as_deref()
        } else {
            None
        };
        if let Some(child) = child {
            let range = child.range;
            let mut open = patch_start_tag(
                crate::core::xml::slice(&body, range.start, range.open_end),
                prefixes,
                overrides,
            )?;
            let Some(tabs) = tabs else {
                edits.push(Edit {
                    start: range.start,
                    end: range.open_end,
                    xml: open,
                });
                continue;
            };
            let tabs_xml = if tabs.is_empty() {
                "<style:tab-stops/>".to_owned()
            } else {
                format!("<style:tab-stops>{tabs}</style:tab-stops>")
            };
            if range.self_closing {
                open = as_open_tag(&open);
                edits.push(Edit {
                    start: range.start,
                    end: range.end,
                    xml: format!("{open}{tabs_xml}</{}>", child.tag),
                });
                continue;
            }
            edits.push(Edit {
                start: range.start,
                end: range.open_end,
                xml: open,
            });
            let inner = direct_children(&body, prefixes, range.open_end, range.close_start);
            if let Some(stops) = inner.iter().find(|c| c.name == "style:tab-stops") {
                edits.push(Edit {
                    start: stops.range.start,
                    end: stops.range.end,
                    xml: tabs_xml,
                });
            } else {
                edits.push(Edit {
                    start: range.open_end,
                    end: range.open_end,
                    xml: tabs_xml,
                });
            }
            continue;
        }
        let attrs: String = overrides
            .entries()
            .into_iter()
            .filter_map(|(k, v)| {
                v.as_ref()
                    .map(|v| format!(" {k}=\"{}\"", escape_xml_attr(v)))
            })
            .collect();
        if attrs.is_empty() && tabs.is_none() {
            continue;
        }
        let created = match tabs {
            None => format!("<{prop_name}{attrs}/>"),
            Some(tabs) => format!(
                "<{prop_name}{attrs}>{}</{prop_name}>",
                if tabs.is_empty() {
                    String::new()
                } else {
                    format!("<style:tab-stops>{tabs}</style:tab-stops>")
                }
            ),
        };
        let rank = PROPERTY_ORDER.iter().position(|p| *p == prop_name);
        let before = children.iter().find(|c| {
            let r = PROPERTY_ORDER.iter().position(|p| *p == c.name);
            match (r, rank) {
                (Some(r), Some(rank)) => r > rank,
                // indexOf gives -1 for an unlisted name: -1 > rank only when rank is -2 (never)
                (Some(_), None) => true,
                (None, _) => !c.name.ends_with("-properties"),
            }
        });
        let at = before.map_or(body.len(), |b| b.range.start);
        edits.push(Edit {
            start: at,
            end: at,
            xml: created,
        });
    }
    if !edits.is_empty() {
        body = local(&body, edits)?;
    }
    Ok(format!("{root_tag}{body}</{root_name}>"))
}

/// `newStyleXml`: a fresh automatic style element.
pub fn new_style_xml(name: &str, family: &str, parent: Option<&str>) -> String {
    let p = parent.map_or_else(String::new, |p| {
        format!(" style:parent-style-name=\"{}\"", escape_xml_attr(p))
    });
    format!(
        "<style:style style:name=\"{}\" style:family=\"{family}\"{p}></style:style>",
        escape_xml_attr(name)
    )
}
