//! `page/odf.ts`: small readers and narrow editors for the ODF side of the
//! page layer. Every offset here is a UTF-8 byte offset.

use jscompat::{JsObject, Radix, is_js_space, js_regex, parse_int, trim};
use serde::Serialize;

use crate::core::convert::{TextPatch, apply_text_patches};
use crate::core::errors::OdtError;
use crate::core::styles::{OdtMasterPage, OdtStyle, OdtStylePart, OdtStyleScope, OdtStyleTable};
use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementRange, ElementVisitor, OpenVerdict, PrefixMap,
    attribute_map, escape_xml_attr, walk_elements,
};
use crate::offset::{U16, to_byte, u16_len};
use crate::text::props::AttrOverrides;
use crate::text::style_xml::patch_start_tag;

use super::model::{HF_REGIONS, HfRegion, master_region};

/// What `startTagAt` returns.
#[derive(Debug, Clone)]
pub struct StartTag {
    pub name: String,
    pub attrs: JsObject<String>,
    pub end: usize,
}

/// `startTagAt`: canonical name and decoded attributes of the start tag at
/// `start`. The tag name is read from the first 200 UTF-16 units, as the
/// TypeScript slices them (a half pair at the cut goes with its character).
pub fn start_tag_at(xml: &str, start: usize, prefixes: &PrefixMap) -> Option<StartTag> {
    let from = xml.get(start..)?;
    let mut units = 0usize;
    let mut cut = from.len();
    for (at, ch) in from.char_indices() {
        if units >= 200 {
            cut = at;
            break;
        }
        units += ch.len_utf16();
    }
    let m = js_regex!(r"^<([^\s/>]+)").exec(&from[..cut])?;
    let end = from.find('>')? + 1 + start;
    let name_end = start + m.end();
    Some(StartTag {
        name: prefixes.canonical(m.get(1)?).into_owned(),
        attrs: attribute_map(xml, name_end, end, prefixes),
        end,
    })
}

/// `RegionChild`: a direct child element of a region.
#[derive(Debug, Clone, PartialEq)]
pub struct RegionChild {
    pub name: String,
    pub start: usize,
    pub open_end: usize,
    pub close_start: usize,
    pub end: usize,
    pub self_closing: bool,
}

struct Children {
    out: Vec<RegionChild>,
}

impl ElementVisitor for Children {
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
            let range = el.range();
            self.out.push(RegionChild {
                name: el.name.clone(),
                start: range.start,
                open_end: range.open_end,
                close_start: range.close_start,
                end: range.end,
                self_closing: range.self_closing,
            });
        }
        CloseVerdict::Continue
    }
}

/// `childElements`: direct child elements of `[from, to)`.
pub fn child_elements(xml: &str, prefixes: &PrefixMap, from: usize, to: usize) -> Vec<RegionChild> {
    let mut visitor = Children { out: Vec::new() };
    walk_elements(xml, prefixes, &mut visitor, from, to);
    visitor.out
}

impl RegionChild {
    /// The `ElementRange` of the child.
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

/// `masterOf`: the master page a style switches to (empty = none).
pub fn master_of(style: Option<&OdtStyle>) -> Option<String> {
    style
        .and_then(|s| s.master_page_name.as_deref())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// `pageNumberOf`: `style:page-number` of a style that starts a page run.
pub fn page_number_of(styles: &OdtStyleTable, name: &str, family: &str) -> Option<f64> {
    let resolved = styles.resolve(name, family, OdtStyleScope::Content);
    let path = if family == "paragraph" {
        "style:paragraph-properties"
    } else {
        "style:table-properties"
    };
    let value = resolved
        .as_ref()
        .and_then(|r| r.properties.get(path))
        .and_then(|p| p.get("style:page-number"))?;
    if !js_regex!(r"^\d+$").test(trim(value)) {
        return None;
    }
    Some(parse_int(value, Radix::Ten))
}

/// `regionsOf`: the header/footer regions a master page has (document order).
pub fn regions_of(master: Option<&OdtMasterPage>) -> Vec<HfRegion> {
    match master {
        Some(m) => m
            .regions
            .iter()
            .filter_map(|(name, _)| HfRegion::from_name(name.as_str()))
            .collect(),
        None => Vec::new(),
    }
}

fn has_region(master: Option<&OdtMasterPage>, region: HfRegion) -> bool {
    master.is_some_and(|m| master_region(m, region).is_some())
}

/// `titlePgOf`
pub fn title_pg_of(master: Option<&OdtMasterPage>) -> bool {
    has_region(master, HfRegion::HeaderFirst) || has_region(master, HfRegion::FooterFirst)
}

/// `evenOddOf`
pub fn even_odd_of(master: Option<&OdtMasterPage>) -> bool {
    has_region(master, HfRegion::HeaderLeft) || has_region(master, HfRegion::FooterLeft)
}

/// One edit of the local patch helper.
#[derive(Debug, Clone)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub xml: String,
}

/// `localPatch`
fn local_patch(xml: &str, edits: &[Edit]) -> Result<String, OdtError> {
    let patches: Vec<TextPatch> = edits
        .iter()
        .map(|e| TextPatch {
            part: OdtStylePart::StylesXml,
            start: e.start,
            end: e.end,
            xml: e.xml.clone(),
        })
        .collect();
    apply_text_patches(xml, &patches)
}

/// `.replace(/\s*\/>$/, '>')` of a tag that ends with `/>`.
fn open_form(tag: &str) -> String {
    let stem = tag.strip_suffix("/>").unwrap_or(tag);
    let mut end = stem.len();
    for (at, ch) in stem.char_indices().rev() {
        if is_js_space(ch) {
            end = at;
        } else {
            break;
        }
    }
    format!("{}>", &stem[..end])
}

fn tag_name(open: &str) -> Option<&str> {
    js_regex!(r"^<([^\s/>]+)").exec(open).and_then(|m| m.get(1))
}

/// The `edit` argument of `editLayoutXml`.
#[derive(Debug, Clone, Default)]
pub struct LayoutEdit {
    pub name: Option<String>,
    pub page: Option<AttrOverrides>,
    pub header: Option<AttrOverrides>,
    pub footer: Option<AttrOverrides>,
}

fn patch_props(
    xml: &str,
    prefixes: &PrefixMap,
    edits: &mut Vec<Edit>,
    el: Option<&RegionChild>,
    overrides: Option<&AttrOverrides>,
) -> Result<(), OdtError> {
    let (Some(el), Some(overrides)) = (el, overrides) else {
        return Ok(());
    };
    if overrides.is_empty() {
        return Ok(());
    }
    edits.push(Edit {
        start: el.start,
        end: el.open_end,
        xml: patch_start_tag(&xml[el.start..el.open_end], prefixes, overrides)?,
    });
    Ok(())
}

/// `editLayoutXml`: a page layout element with attribute overrides applied to
/// its `style:page-layout-properties` and the `style:header-footer-properties`
/// of its header and footer styles, and optionally a new name.
pub fn edit_layout_xml(
    xml: &str,
    prefixes: &PrefixMap,
    edit: &LayoutEdit,
) -> Result<String, OdtError> {
    let mut edits: Vec<Edit> = Vec::new();
    let root_end = xml.find('>').map_or(0, |at| at + 1);
    if xml[..root_end].ends_with("/>") {
        let open = open_form(&xml[..root_end]);
        let name = tag_name(&open).unwrap_or("style:page-layout").to_owned();
        return edit_layout_xml(&format!("{open}</{name}>"), prefixes, edit);
    }
    if let Some(name) = &edit.name {
        let mut overrides = AttrOverrides::new();
        overrides.set("style:name", Some(name.clone()));
        overrides.set("style:display-name", None);
        edits.push(Edit {
            start: 0,
            end: root_end,
            xml: patch_start_tag(&xml[..root_end], prefixes, &overrides)?,
        });
    }
    let children = if root_end < xml.len() {
        child_elements(xml, prefixes, root_end, xml.len())
    } else {
        Vec::new()
    };
    let page_props = children
        .iter()
        .find(|c| c.name == "style:page-layout-properties");
    if page_props.is_some() {
        patch_props(xml, prefixes, &mut edits, page_props, edit.page.as_ref())?;
    } else if let Some(page) = edit
        .page
        .as_ref()
        .filter(|page| page.entries().iter().any(|(_, v)| v.is_some()))
    {
        let attrs: String = page
            .entries()
            .into_iter()
            .filter_map(|(k, v)| {
                v.as_ref()
                    .map(|v| format!(" {k}=\"{}\"", escape_xml_attr(v)))
            })
            .collect();
        edits.push(Edit {
            start: root_end,
            end: root_end,
            xml: format!("<style:page-layout-properties{attrs}/>"),
        });
    }
    for (kind, overrides) in [
        ("header", edit.header.as_ref()),
        ("footer", edit.footer.as_ref()),
    ] {
        let Some(overrides) = overrides.filter(|o| !o.is_empty()) else {
            continue;
        };
        let want = format!("style:{kind}-style");
        let Some(host) = children.iter().find(|c| c.name == want) else {
            continue;
        };
        if host.self_closing {
            continue;
        }
        let inner = child_elements(xml, prefixes, host.open_end, host.close_start);
        patch_props(
            xml,
            prefixes,
            &mut edits,
            inner
                .iter()
                .find(|c| c.name == "style:header-footer-properties"),
            Some(overrides),
        )?;
    }
    if edits.is_empty() {
        Ok(xml.to_owned())
    } else {
        local_patch(xml, &edits)
    }
}

/// `MasterEdit.regions`: region to new inner XML (`None` removes the region),
/// in the order the keys were set.
pub type RegionEdits = Vec<(HfRegion, Option<String>)>;

/// `MasterEdit`
#[derive(Debug, Clone, Default)]
pub struct MasterEdit {
    pub name: Option<String>,
    pub layout: Option<String>,
    pub regions: Option<RegionEdits>,
}

/// `editMasterXml`: a master page element with a new name / page layout and
/// replaced, removed or added header/footer regions.
pub fn edit_master_xml(
    xml: &str,
    prefixes: &PrefixMap,
    style_tag: &str,
    edit: &MasterEdit,
) -> Result<String, OdtError> {
    let mut source = xml.to_owned();
    let mut root_end = source.find('>').map_or(0, |at| at + 1);
    let mut root_tag = source[..root_end].to_owned();
    let root_name = tag_name(&root_tag)
        .unwrap_or("style:master-page")
        .to_owned();
    if root_tag.ends_with("/>") {
        root_tag = open_form(&root_tag);
        source = format!("{root_tag}</{root_name}>");
        root_end = root_tag.len();
    }
    let mut tag_overrides = AttrOverrides::new();
    if let Some(name) = &edit.name {
        tag_overrides.set("style:name", Some(name.clone()));
        tag_overrides.set("style:display-name", None);
        let attrs = attribute_map(&root_tag, root_name.len() + 1, root_tag.len(), prefixes);
        let next = attrs.get("style:next-style-name");
        let own = attrs.get("style:name");
        if next.is_some() && next == own {
            tag_overrides.set("style:next-style-name", Some(name.clone()));
        }
    }
    if let Some(layout) = &edit.layout {
        tag_overrides.set("style:page-layout-name", Some(layout.clone()));
    }
    let mut edits: Vec<Edit> = Vec::new();
    if !tag_overrides.is_empty() {
        edits.push(Edit {
            start: 0,
            end: root_end,
            xml: patch_start_tag(&root_tag, prefixes, &tag_overrides)?,
        });
    }
    // `source.length - tag.length` counts UTF-16 units: a name with a character outside the
    // ASCII range is longer in bytes than in units.
    let close_start = to_byte(
        &source,
        U16(u16_len(&source)
            .0
            .saturating_sub(u16_len(&format!("</{root_name}>")).0)),
    );
    let children = if close_start >= root_end {
        child_elements(&source, prefixes, root_end, close_start)
    } else {
        Vec::new()
    };
    let region_of = |c: &RegionChild| c.name.strip_prefix("style:").map(str::to_owned);
    let present: Vec<(&RegionChild, HfRegion)> = children
        .iter()
        .filter_map(|c| {
            region_of(c)
                .and_then(|r| HfRegion::from_name(&r))
                .map(|r| (c, r))
        })
        .collect();
    for region in HF_REGIONS {
        let Some(regions) = &edit.regions else {
            continue;
        };
        let Some((_, inner)) = regions.iter().find(|(r, _)| *r == region) else {
            continue;
        };
        let el = present.iter().find(|(_, r)| *r == region).map(|(c, _)| *c);
        if let Some(el) = el {
            let Some(inner) = inner else {
                edits.push(Edit {
                    start: el.start,
                    end: el.end,
                    xml: String::new(),
                });
                continue;
            };
            let mut open = source[el.start..el.open_end].to_owned();
            let name = tag_name(&open)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("style:{}", region.as_str()));
            if open.ends_with("/>") {
                open = open_form(&open);
            }
            let written = if inner.is_empty() {
                // `open.replace(/>$/, '/>')`
                match open.strip_suffix('>') {
                    Some(stem) => format!("{stem}/>"),
                    None => open,
                }
            } else {
                format!("{open}{inner}</{name}>")
            };
            edits.push(Edit {
                start: el.start,
                end: el.end,
                xml: written,
            });
            continue;
        }
        let Some(inner) = inner else { continue };
        let rank = region.rank();
        let after = present
            .iter()
            .find(|(_, r)| r.rank() > rank)
            .map(|(c, _)| *c);
        let before = present
            .iter()
            .rev()
            .find(|(_, r)| r.rank() < rank)
            .map(|(c, _)| *c);
        let at = match (after, before) {
            (Some(after), _) => after.start,
            (None, Some(before)) => before.end,
            (None, None) => root_end,
        };
        let tag = format!("{style_tag}:{}", region.as_str());
        edits.push(Edit {
            start: at,
            end: at,
            xml: if inner.is_empty() {
                format!("<{tag}/>")
            } else {
                format!("<{tag}>{inner}</{tag}>")
            },
        });
    }
    if edits.is_empty() {
        Ok(source)
    } else {
        local_patch(&source, &edits)
    }
}

/// A `RegionChild` for the (f) adapter, offsets as `U16`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionChildU16 {
    pub name: String,
    pub start: crate::offset::U16,
    pub open_end: crate::offset::U16,
    pub close_start: crate::offset::U16,
    pub end: crate::offset::U16,
    pub self_closing: bool,
}
