//! Element-level hyperlinks, `<a:hlinkClick>` under `<p:cNvPr>`
//! (packages/pptx-engine/src/hyperlink.ts).
//!
//! Two kinds of targets:
//! - External URL: a hyperlink relationship with TargetMode="External" in the slide rels;
//! - In-document slide jump: hlinkClick with action="ppaction://hlinksldjump",
//!   whose relationship (type=slide) points at the target slideN.xml.
//! - Named show action (next/previous/first/last slide, last viewed, end show):
//!   action="ppaction://hlinkshowjump?jump=<name>" with an empty r:id and no relationship.
//!
//! Implemented via "XML surgery + materialize": edit the cNvPr in the element's
//! current fragment, then reparse the whole slide (same path as `append_raw_elements`).
//!
//! The recursion over group children is bounded at [`MAX_GROUP_DEPTH`] levels.

use jscompat::{
    JsNum, js_regex, number_to_string, replace_first_with, to_number, truthy, try_js_regex,
};
use serde::{Deserialize, Serialize};

use crate::deck::{OpenedPptx, materialize_slide, patch_slide_xml, patched_element_xml};
use crate::named_action::{named_action_attr, named_action_of};
use crate::notes::unescape_xml;
use crate::parse::slice_group_child_xmls;
use crate::resource_cleanup::cleanup_superseded_slide_resources;
use crate::types::{ElementType, Paragraph, Slide, SlideElement};
use crate::with_element;
use crate::xml_utils::{escape_xml_attr, max_relationship_id_number};
use crate::zip::{PackageArchive, rels_path_for, resolve_target};

const HYPERLINK_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const SLIDE_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const SLDJUMP_ACTION: &str = "ppaction://hlinksldjump";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// How deep a group tree is walked.
const MAX_GROUP_DEPTH: usize = 1024;

/// `LinkTarget`, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum LinkTarget {
    #[serde(rename = "url")]
    Url {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tooltip: Option<String>,
    },
    #[serde(rename = "slide")]
    Slide {
        #[serde(rename = "slideIndex")]
        slide_index: JsNum,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tooltip: Option<String>,
    },
    /// `action` is a `NamedAction`.
    #[serde(rename = "action")]
    Action {
        action: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tooltip: Option<String>,
    },
}

impl LinkTarget {
    fn tooltip(&self) -> Option<&String> {
        match self {
            LinkTarget::Url { tooltip, .. }
            | LinkTarget::Slide { tooltip, .. }
            | LinkTarget::Action { tooltip, .. } => tooltip.as_ref(),
        }
    }
}

const EMPTY_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>";

/// `text.replace(needle, () => replacement)`: the first occurrence, written as given.
fn replace_first_literal(text: &str, needle: &str, replacement: &str) -> String {
    match text.find(needle) {
        Some(at) => format!("{}{replacement}{}", &text[..at], &text[at + needle.len()..]),
        None => text.to_owned(),
    }
}

/// `deck.slides[index]` for a number: an integer in range, else `undefined`.
fn slide_at(slides: &[Slide], index: JsNum) -> Option<&Slide> {
    let n = index.0;
    if n.fract() != 0.0 || n < 0.0 || n >= slides.len() as f64 {
        return None;
    }
    slides.get(n as usize)
}

fn slide_path(slide: &Slide) -> String {
    (*slide.path).clone().unwrap_or_default()
}

/// Append a relationship to the slide rels and return the new rId.
fn append_rel(
    archive: &mut PackageArchive,
    slide_path: &str,
    kind: &str,
    target: &str,
    external: bool,
) -> String {
    let rels_path = rels_path_for(slide_path);
    let rels = archive
        .read_text(&rels_path)
        .map(|r| r.into_owned())
        .unwrap_or_else(|| EMPTY_RELS.to_owned());
    let max_rid = max_relationship_id_number(&rels);
    let rid = format!("rId{}", number_to_string(max_rid + 1.0));
    let mode = if external {
        " TargetMode=\"External\""
    } else {
        ""
    };
    let rel_xml = format!(
        "<Relationship Id=\"{rid}\" Type=\"{kind}\" Target=\"{}\"{mode}/>",
        escape_xml_attr(target)
    );
    let next = replace_first_literal(
        &rels,
        "</Relationships>",
        &format!("{rel_xml}</Relationships>"),
    );
    archive.entries_mut().set(rels_path, next.into_bytes());
    rid
}

fn tooltip_of(tag: Option<&str>) -> Option<String> {
    let tag = tag.filter(|t| !t.is_empty())?;
    let m = js_regex!(r#"\btooltip=(?:"([^"]*)"|'([^']*)')"#).exec(tag)?;
    let raw = truthy(m.get(1)).or_else(|| truthy(m.get(2)))?;
    Some(unescape_xml(raw))
}

/// Strip the hlinkClick inside the element XML's first cNvPr (keeping other children).
fn strip_hlink(xml: &str) -> String {
    replace_first_with(
        js_regex!(r"<a:hlinkClick\b[^>]*\/>|<a:hlinkClick\b[^>]*>[\s\S]*?<\/a:hlinkClick>"),
        xml,
        |_| String::new(),
    )
}

/// Set/clear an element hyperlink. Relationships no longer used by any live slide
/// XML are pruned after the fragment changes. `true`: the slide was materialized
/// (all element ids refreshed; the new model is `opened.deck.slides[slide_index]`);
/// `false` is TS null.
pub fn set_element_link(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
    target: Option<&LinkTarget>,
) -> Result<bool, String> {
    {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Ok(false);
        };
        let found = (*slide.elements)
            .as_ref()
            .is_some_and(|els| els.iter().any(|e| e.id() == element_id));
        if !found {
            return Ok(false);
        }
    }
    let path = {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Ok(false);
        };
        slide_path(slide)
    };

    let (previous_xml, existing_xml) = {
        let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
            return Ok(false);
        };
        let previous_xml = patch_slide_xml(slide);
        let Some(el) = slide
            .elements
            .as_mut()
            .and_then(|els| els.iter_mut().find(|e| e.id() == element_id))
        else {
            return Ok(false);
        };
        (previous_xml, patched_element_xml(el))
    };
    let mut xml = strip_hlink(&existing_xml);

    if let Some(target) = target {
        // The UI edits the target only; keep PowerPoint's ScreenTip unless the caller sets one
        let tooltip = match target.tooltip() {
            Some(t) => Some(t.clone()),
            None => tooltip_of(
                js_regex!(r"<a:hlinkClick\b[^>]*>")
                    .exec(&existing_xml)
                    .map(|m| m.as_str()),
            ),
        };
        let tip = match tooltip.as_deref().filter(|t| !t.is_empty()) {
            Some(t) => format!(" tooltip=\"{}\"", escape_xml_attr(t)),
            None => String::new(),
        };
        let hlink: String = match target {
            LinkTarget::Url { url, .. } => {
                let rid = append_rel(&mut opened.archive, &path, HYPERLINK_REL_TYPE, url, true);
                format!("<a:hlinkClick xmlns:r=\"{R_NS}\" r:id=\"{rid}\"{tip}/>")
            }
            LinkTarget::Action { action, .. } => {
                format!(
                    "<a:hlinkClick xmlns:r=\"{R_NS}\" r:id=\"\" action=\"{}\"{tip}/>",
                    named_action_attr(action)
                )
            }
            LinkTarget::Slide {
                slide_index: dst, ..
            } => {
                let Some(dst) = slide_at(&opened.deck.slides, *dst) else {
                    return Ok(false);
                };
                // Same directory ppt/slides/, so Target is just the file name
                let dst_path = slide_path(dst);
                let file_name = dst_path.rsplit('/').next().unwrap_or(&dst_path);
                let rid = append_rel(&mut opened.archive, &path, SLIDE_REL_TYPE, file_name, false);
                format!(
                    "<a:hlinkClick xmlns:r=\"{R_NS}\" r:id=\"{rid}\" action=\"{SLDJUMP_ACTION}\"{tip}/>"
                )
            }
        };
        // Insert into the first cNvPr (hlinkClick is cNvPr's first valid child)
        let Some(c_nv_pr) = try_js_regex!(r#"<p:cNvPr\b((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>"#)
            .try_exec(&xml)
            .map_err(|e| e.to_string())?
        else {
            return Ok(false);
        };
        let (start, end) = (c_nv_pr.start(), c_nv_pr.end());
        let attrs = c_nv_pr.get(1).unwrap_or_default();
        let before = xml.get(..start).unwrap_or_default();
        let after = xml.get(end..).unwrap_or_default();
        xml = if c_nv_pr.get(2) == Some("/") {
            // Self-closing → expand into a tag pair
            format!("{before}<p:cNvPr{attrs}>{hlink}</p:cNvPr>{after}")
        } else {
            let at = xml.get(..end).unwrap_or_default();
            format!("{at}{hlink}{after}")
        };
    }

    // Post-surgery fragment is the sole truth: clear text dirty so patches don't overwrite;
    // structural rebuild persists it
    let current_xml = {
        let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
            return Ok(false);
        };
        if let Some(el) = slide
            .elements
            .as_mut()
            .and_then(|els| els.iter_mut().find(|e| e.id() == element_id))
        {
            with_element!(el, e => {
                if let Some(anchor) = e.anchor.as_mut() {
                    anchor.original_xml = xml.as_str().into();
                }
                e.dirty.set(false);
            });
        }
        slide.structure_dirty.set(true);
        patch_slide_xml(slide)
    };
    cleanup_superseded_slide_resources(opened, slide_index, &previous_xml, &current_xml)?;
    materialize_slide(opened, slide_index)
}

/// Parse a TextRun.hyperlink encoded target ("slide:N", "action:<name>" or url); `None` on bad input.
pub fn decode_run_link(s: &str) -> Option<LinkTarget> {
    if let Some(m) = js_regex!(r"^slide:(\d+)$").exec(s) {
        return Some(LinkTarget::Slide {
            slide_index: JsNum(to_number(m.get(1).unwrap_or_default())),
            tooltip: None,
        });
    }
    if let Some(a) = js_regex!(r"^action:(\w+)$").exec(s) {
        let name = a.get(1).unwrap_or_default();
        let action = named_action_of(Some(&named_action_attr(name)))?;
        return Some(LinkTarget::Action {
            action: action.to_owned(),
            tooltip: None,
        });
    }
    if s.is_empty() {
        None
    } else {
        Some(LinkTarget::Url {
            url: s.to_owned(),
            tooltip: None,
        })
    }
}

/// TextRun.hyperlink encoding of a link target.
pub fn encode_run_link(target: &LinkTarget) -> String {
    match target {
        LinkTarget::Slide { slide_index, .. } => {
            format!("slide:{}", number_to_string(slide_index.0))
        }
        LinkTarget::Action { action, .. } => format!("action:{action}"),
        LinkTarget::Url { url, .. } => url.clone(),
    }
}

/// Allocate slide-rels relationships for runs whose hyperlink was set this session
/// (hyperlink present, hyperlinkRId absent: the edit path clears the rId on change).
/// The caller reconciles the before/after slide XML after its text patch so cleared
/// or replaced relationship ids can be removed safely. Returns whether anything
/// was allocated.
pub fn ensure_run_link_rels(
    opened: &mut OpenedPptx,
    slide_index: usize,
    paragraphs: &mut [Paragraph],
) -> bool {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return false;
    };
    let path = slide_path(slide);
    let mut changed = false;
    for p in paragraphs.iter_mut() {
        let Some(runs) = p.runs.as_mut() else {
            continue;
        };
        for run in runs.iter_mut() {
            let Some(hyperlink) = truthy((*run.hyperlink).as_deref()).map(str::to_owned) else {
                continue;
            };
            if run.hyperlink_r_id.is_some() {
                continue;
            }
            let Some(target) = decode_run_link(&hyperlink) else {
                continue;
            };
            match target {
                LinkTarget::Url { url, .. } => {
                    let rid =
                        append_rel(&mut opened.archive, &path, HYPERLINK_REL_TYPE, &url, true);
                    run.hyperlink_r_id.set(rid);
                    run.hyperlink_action.delete();
                }
                LinkTarget::Action { action, .. } => {
                    run.hyperlink_r_id.set(String::new());
                    run.hyperlink_action.set(named_action_attr(&action));
                }
                LinkTarget::Slide {
                    slide_index: dst, ..
                } => {
                    let Some(dst) = slide_at(&opened.deck.slides, dst) else {
                        continue;
                    };
                    let dst_path = slide_path(dst);
                    let file_name = dst_path.rsplit('/').next().unwrap_or(&dst_path).to_owned();
                    let rid = append_rel(
                        &mut opened.archive,
                        &path,
                        SLIDE_REL_TYPE,
                        &file_name,
                        false,
                    );
                    run.hyperlink_r_id.set(rid);
                    run.hyperlink_action.set(SLDJUMP_ACTION.to_owned());
                }
            }
            changed = true;
        }
    }
    changed
}

/// One of the run-level hyperlinks `get_run_links` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLink {
    pub element_id: String,
    pub para_index: usize,
    pub run_index: usize,
    pub target: LinkTarget,
}

/// The target a relationship id names: a url, or the slide it jumps to.
fn target_of_rel(
    rel_type: &str,
    rel_target: &str,
    slide_path: &str,
    slide_paths: &[String],
    tooltip: Option<String>,
) -> Option<LinkTarget> {
    if rel_type == HYPERLINK_REL_TYPE {
        return Some(LinkTarget::Url {
            url: rel_target.to_owned(),
            tooltip,
        });
    }
    if rel_type == SLIDE_REL_TYPE {
        let abs = resolve_target(slide_path, rel_target);
        let idx = slide_paths.iter().position(|p| *p == abs)?;
        return Some(LinkTarget::Slide {
            slide_index: JsNum(idx as f64),
            tooltip,
        });
    }
    None
}

/// All run-level hyperlinks on a slide, resolved live against the rels (parse-time
/// TextRun.hyperlink can go stale after slide reorders). Keyed by element + paragraph +
/// run indexes; the slideshow matches these against layout glyph runs to hit-test clicks.
pub fn get_run_links(opened: &OpenedPptx, slide_index: usize) -> Result<Vec<RunLink>, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let path = slide_path(slide);
    let rels = opened.archive.read_rels(&path)?;
    let slide_paths: Vec<String> = opened.deck.slides.iter().map(slide_path).collect();

    fn walk(
        elements: &[SlideElement],
        rels: &jscompat::JsMap<crate::zip::Relationship>,
        path: &str,
        slide_paths: &[String],
        out: &mut Vec<RunLink>,
        depth: usize,
    ) {
        for el in elements {
            if let SlideElement::Group(g) = el {
                if depth < MAX_GROUP_DEPTH
                    && let Some(children) = (*g.children).as_ref()
                {
                    walk(children, rels, path, slide_paths, out, depth + 1);
                }
                continue;
            }
            if !matches!(
                el.element_type(),
                Some(ElementType::Text | ElementType::Shape)
            ) {
                continue;
            }
            let SlideElement::Text(t) = el else {
                continue;
            };
            let Some(body) = (*t.text).as_ref() else {
                continue;
            };
            for (para_index, p) in body.paragraphs.as_deref().unwrap_or(&[]).iter().enumerate() {
                for (run_index, run) in p.runs.as_deref().unwrap_or(&[]).iter().enumerate() {
                    let tooltip = truthy((*run.hyperlink_tooltip).as_deref()).map(str::to_owned);
                    let action = named_action_of((*run.hyperlink_action).as_deref());
                    let target = if let Some(action) = action {
                        Some(LinkTarget::Action {
                            action: action.to_owned(),
                            tooltip: tooltip.clone(),
                        })
                    } else if let Some(rid) = truthy((*run.hyperlink_r_id).as_deref()) {
                        rels.get(rid).and_then(|rel| {
                            target_of_rel(
                                &rel.r#type,
                                &rel.target,
                                path,
                                slide_paths,
                                tooltip.clone(),
                            )
                        })
                    } else {
                        None
                    };
                    if let Some(target) = target {
                        out.push(RunLink {
                            element_id: el.id().to_owned(),
                            para_index,
                            run_index,
                            target,
                        });
                    }
                }
            }
        }
    }
    if let Some(elements) = (*slide.elements).as_ref() {
        walk(elements, &rels, &path, &slide_paths, &mut out, 0);
    }
    Ok(out)
}

/// Resolve the hlinkClick rId in an element fragment against the slide rels; `None` if none/unresolvable.
fn resolve_link_in_xml(
    opened: &OpenedPptx,
    slide_path: &str,
    xml: &str,
) -> Result<Option<LinkTarget>, String> {
    let Some(tag) = js_regex!(r"<a:hlinkClick\b[^>]*>")
        .exec(xml)
        .map(|m| m.as_str())
    else {
        return Ok(None);
    };
    let tooltip = tooltip_of(Some(tag));
    let action_attr = js_regex!(r#"\baction=(?:"([^"]*)"|'([^']*)')"#)
        .exec(tag)
        .and_then(|m| truthy(m.get(1)).or_else(|| truthy(m.get(2))));
    if let Some(action) = named_action_of(action_attr) {
        return Ok(Some(LinkTarget::Action {
            action: action.to_owned(),
            tooltip,
        }));
    }
    let Some(m) = js_regex!(r#"\br:id=(?:"(rId\d+)"|'(rId\d+)')"#).exec(tag) else {
        return Ok(None);
    };
    let rid = m.get(1).or_else(|| m.get(2)).unwrap_or_default();
    let rels = opened.archive.read_rels(slide_path)?;
    let Some(rel) = rels.get(rid) else {
        return Ok(None);
    };
    let slide_paths: Vec<String> = opened.deck.slides.iter().map(slide_path_of).collect();
    Ok(target_of_rel(
        &rel.r#type,
        &rel.target,
        slide_path,
        &slide_paths,
        tooltip,
    ))
}

fn slide_path_of(slide: &Slide) -> String {
    slide_path(slide)
}

/// Read an element's current hyperlink (for UI echo-back); `None` if none.
pub fn get_element_link(
    opened: &OpenedPptx,
    slide_index: usize,
    element_id: &str,
) -> Result<Option<LinkTarget>, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Ok(None);
    };
    let Some(el) = (*slide.elements)
        .as_ref()
        .and_then(|els| els.iter().find(|e| e.id() == element_id))
    else {
        return Ok(None);
    };
    let xml = with_element!(el, e => (*e.anchor).as_ref().map(|a| a.original_xml.clone()));
    let Some(xml) = xml else {
        // an element without an anchor: the TypeScript reads `undefined.originalXml` and throws
        return Err(
            "TypeError: Cannot read properties of undefined (reading 'originalXml')".to_owned(),
        );
    };
    resolve_link_in_xml(opened, &slide_path(slide), &xml)
}

/// One of the element hyperlinks `get_slide_links` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideLink {
    pub element_id: String,
    pub target: LinkTarget,
}

fn walk_links(
    opened: &OpenedPptx,
    path: &str,
    elements: &[SlideElement],
    xmls: &[&str],
    out: &mut Vec<SlideLink>,
    depth: usize,
) -> Result<(), String> {
    for (i, el) in elements.iter().enumerate() {
        let xml = xmls.get(i).copied().unwrap_or_default();
        if let SlideElement::Group(g) = el {
            // Restrict the group's own match to its nvGrpSpPr header so a child link
            // doesn't make the whole group clickable
            let own = js_regex!(r"<p:nvGrpSpPr\b[^>]*>[\s\S]*?<\/p:nvGrpSpPr>")
                .exec(xml)
                .map(|m| m.as_str())
                .unwrap_or_default();
            if let Some(target) = resolve_link_in_xml(opened, path, own)? {
                out.push(SlideLink {
                    element_id: el.id().to_owned(),
                    target,
                });
            }
            // Child fragments are in document order, matching the group's children
            let child_xmls = slice_group_child_xmls(xml)?;
            if depth < MAX_GROUP_DEPTH
                && let Some(children) = (*g.children).as_ref()
            {
                walk_links(opened, path, children, &child_xmls, out, depth + 1)?;
            }
            continue;
        }
        if let Some(target) = resolve_link_in_xml(opened, path, xml)? {
            out.push(SlideLink {
                element_id: el.id().to_owned(),
                target,
            });
        }
    }
    Ok(())
}

/// All element hyperlinks on a slide (groups scanned recursively): the slideshow
/// uses this to hit-test clicks and follow slide jumps (Zoom) / external URLs.
/// Group children have empty anchors (their bytes live only inside the group's
/// fragment), so each child's XML is sliced out of the group XML by index.
pub fn get_slide_links(opened: &OpenedPptx, slide_index: usize) -> Result<Vec<SlideLink>, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let path = slide_path(slide);
    if let Some(elements) = (*slide.elements).as_ref() {
        let xmls: Vec<&str> = elements
            .iter()
            .map(|el| {
                with_element!(el, e => (*e.anchor).as_ref().map(|a| &*a.original_xml))
                    .unwrap_or_default()
            })
            .collect();
        walk_links(opened, &path, elements, &xmls, &mut out, 0)?;
    }
    Ok(out)
}
