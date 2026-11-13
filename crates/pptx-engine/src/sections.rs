//! Port of packages/pptx-engine/src/sections.ts: section read/write, modeled
//! after PowerPoint's "sections" (the `p14:sectionLst` in the extLst of
//! ppt/presentation.xml), and the slide moves that keep sections in step.
//!
//! The TypeScript draws section ids from `randomUUID()`; the engine draws no
//! randomness, so every function that can mint an id takes `uuid`, a closure
//! that answers a UUID in the text form `crypto.randomUUID()` gives. It is
//! called exactly where the TypeScript calls `randomUUID()`, in that order.

use std::collections::HashMap;

use jscompat::{JsMap, js_regex, replace_first_with};
use serde::{Deserialize, Serialize};

use crate::deck::OpenedPptx;
use crate::notes::{replace_literal, set_entry, unescape_xml};
use crate::types::Slide;
use crate::xml_utils::{attribute_of, escape_xml_attr};
use crate::zip::resolve_target;

/// `SectionInfo`
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionInfo {
    /// Section GUID (with braces, PowerPoint style)
    pub id: String,
    pub name: String,
    /// Indices in deck.slides of the slides in this section (in slide order)
    pub slide_indices: Vec<usize>,
}

/// The `_opts` of `removeSection`, which the TypeScript never reads.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveSectionOptions {
    pub keep_slides: Option<bool>,
}

/// The `dir` of `moveSection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SectionDirection {
    Up,
    Down,
}

/// What `normalizeSections` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NormalizedSections {
    pub lead: Vec<usize>,
    pub starts: Vec<usize>,
    pub sections: Vec<SectionInfo>,
}

const PRES_PATH: &str = "ppt/presentation.xml";
/// Fixed uri of the extension hosting sectionLst (defined in [MS-PPTX])
const SECTION_EXT_URI: &str = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}";
const P14_NS: &str = "http://schemas.microsoft.com/office/powerpoint/2010/main";

/// `newSectionId`: uppercase with braces (the format found in pptx files).
fn new_section_id(uuid: &mut dyn FnMut() -> String) -> String {
    format!("{{{}}}", uuid().to_uppercase())
}

/// `range`: index array for [start, end).
fn range(start: usize, end: usize) -> Vec<usize> {
    (start..end).collect()
}

/// `SlideEntry`: numeric sldId / rId / deck index (-1 when the slide is not in the deck).
struct SlideEntry {
    sld_id: String,
    r_id: String,
    deck_index: i64,
}

/// `readSlideEntries`
fn read_slide_entries(opened: &OpenedPptx) -> Result<Vec<SlideEntry>, String> {
    let Some(pres) = opened
        .archive
        .read_text(PRES_PATH)
        .filter(|pres| !pres.is_empty())
    else {
        return Ok(Vec::new());
    };
    let inner = js_regex!(r"<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>")
        .exec(&pres)
        .and_then(|m| m.get(1))
        .unwrap_or_default();
    let rels = opened.archive.read_rels(PRES_PATH)?;
    let mut out = Vec::new();
    for m in js_regex!(r"<p:sldId\b[^>]*\/>", "g").find_iter(inner) {
        let sld_id = js_regex!(r#"\bid="(\d+)""#)
            .exec(m.as_str())
            .and_then(|m| m.get(1))
            .filter(|id| !id.is_empty());
        let r_id = attribute_of(m.as_str(), "r:id").filter(|id| !id.is_empty());
        let (Some(sld_id), Some(r_id)) = (sld_id, r_id.as_deref()) else {
            continue;
        };
        let path = rels
            .get(r_id)
            .map(|rel| resolve_target(PRES_PATH, &rel.target))
            .filter(|path| !path.is_empty());
        let deck_index = path
            .and_then(|path| {
                opened
                    .deck
                    .slides
                    .iter()
                    .position(|s| s.path.as_deref() == Some(path.as_str()))
            })
            .map_or(-1, |at| at as i64);
        out.push(SlideEntry {
            sld_id: sld_id.to_owned(),
            r_id: r_id.to_owned(),
            deck_index,
        });
    }
    Ok(out)
}

/// `getSections`: parse presentation.xml's `p14:sectionLst`. Empty if there
/// are no sections (older documents). sldIds referencing deleted slides are
/// silently skipped.
pub fn get_sections(
    opened: &OpenedPptx,
    uuid: &mut dyn FnMut() -> String,
) -> Result<Vec<SectionInfo>, String> {
    let Some(pres) = opened
        .archive
        .read_text(PRES_PATH)
        .filter(|pres| !pres.is_empty())
    else {
        return Ok(Vec::new());
    };
    let Some(lst) = js_regex!(r"<p14:sectionLst[^>]*>([\s\S]*?)<\/p14:sectionLst>")
        .exec(&pres)
        .and_then(|m| m.get(1))
        .filter(|lst| !lst.is_empty())
    else {
        return Ok(Vec::new());
    };
    let entries = read_slide_entries(opened)?;
    let mut by_sld_id: JsMap<i64> = JsMap::new();
    let mut by_rid: JsMap<i64> = JsMap::new();
    for e in &entries {
        by_sld_id.set(e.sld_id.clone(), e.deck_index);
        by_rid.set(e.r_id.clone(), e.deck_index);
    }
    let mut out = Vec::new();
    for m in js_regex!(
        r"<p14:section\b([^>]*?)(?:\/>|>([\s\S]*?)<\/p14:section>)",
        "g"
    )
    .find_iter(lst)
    {
        let attrs = m.get(1).unwrap_or_default();
        let inner = m.get(2).unwrap_or_default();
        let name = unescape_xml(
            js_regex!(r#"\bname="([^"]*)""#)
                .exec(attrs)
                .and_then(|m| m.get(1))
                .unwrap_or_default(),
        );
        let id = match js_regex!(r#"\bid="([^"]+)""#)
            .exec(attrs)
            .and_then(|m| m.get(1))
        {
            Some(id) => id.to_owned(),
            None => new_section_id(uuid),
        };
        let mut slide_indices = Vec::new();
        for sm in js_regex!(r#"<p14:sldId\s[^>]*id="([^"]+)""#, "g").find_iter(inner) {
            let key = sm.get(1).unwrap_or_default();
            let idx = by_sld_id
                .get(key)
                .or_else(|| by_rid.get(key))
                .copied()
                .unwrap_or(-1);
            if idx >= 0 {
                slide_indices.push(idx as usize);
            }
        }
        out.push(SectionInfo {
            id,
            name,
            slide_indices,
        });
    }
    Ok(out)
}

/// `setSections`: write the section structure back into presentation.xml's
/// extLst (created if missing). With empty sections the whole sectionLst
/// extension is removed (and the extLst too if it becomes empty). Only
/// presentation.xml is touched; [Content_Types]/rels are unaffected.
pub fn set_sections(
    opened: &mut OpenedPptx,
    sections: &[SectionInfo],
    uuid: &mut dyn FnMut() -> String,
) -> Result<(), String> {
    let Some(pres) = opened
        .archive
        .read_text(PRES_PATH)
        .filter(|pres| !pres.is_empty())
        .map(|pres| pres.into_owned())
    else {
        return Ok(());
    };
    let mut by_index: HashMap<i64, String> = HashMap::new();
    for e in read_slide_entries(opened)? {
        by_index.insert(e.deck_index, e.sld_id);
    }

    // First remove the whole p:ext hosting the existing sectionLst; drop the extLst too if it becomes empty
    let mut next = replace_first_with(
        js_regex!(r"<p:ext\b[^>]*>\s*<p14:sectionLst[\s\S]*?<\/p14:sectionLst>\s*<\/p:ext>"),
        &pres,
        |_| String::new(),
    );
    next = replace_first_with(js_regex!(r"<p:extLst>\s*<\/p:extLst>"), &next, |_| {
        String::new()
    });

    if !sections.is_empty() {
        let mut sec_xml = String::new();
        for s in sections {
            let ids: Vec<&String> = s
                .slide_indices
                .iter()
                .filter_map(|i| by_index.get(&(*i as i64)))
                .collect();
            let lst = if ids.is_empty() {
                "<p14:sldIdLst/>".to_owned()
            } else {
                format!(
                    "<p14:sldIdLst>{}</p14:sldIdLst>",
                    ids.iter()
                        .map(|id| format!("<p14:sldId id=\"{id}\"/>"))
                        .collect::<String>()
                )
            };
            let id = if s.id.is_empty() {
                new_section_id(uuid)
            } else {
                s.id.clone()
            };
            sec_xml.push_str(&format!(
                "<p14:section name=\"{}\" id=\"{id}\">{lst}</p14:section>",
                escape_xml_attr(&s.name)
            ));
        }
        let ext = format!(
            "<p:ext uri=\"{SECTION_EXT_URI}\"><p14:sectionLst xmlns:p14=\"{P14_NS}\">{sec_xml}</p14:sectionLst></p:ext>"
        );
        next = if next.contains("</p:extLst>") {
            replace_literal(&next, "</p:extLst>", &format!("{ext}</p:extLst>"))
        } else if next.contains("<p:extLst/>") {
            replace_literal(&next, "<p:extLst/>", &format!("<p:extLst>{ext}</p:extLst>"))
        } else {
            replace_literal(
                &next,
                "</p:presentation>",
                &format!("<p:extLst>{ext}</p:extLst></p:presentation>"),
            )
        };
    }
    set_entry(&mut opened.archive, PRES_PATH, next);
    Ok(())
}

/// `normalizeSections`: positional normalization: each section's start = its
/// minimum index (empty sections take the next section's start), section i
/// covers [starts[i], starts[i+1]), the last section runs to total. Returns
/// the unsectioned leading slides + the normalized sections.
pub fn normalize_sections(sections: &[SectionInfo], total: usize) -> NormalizedSections {
    if sections.is_empty() {
        return NormalizedSections {
            lead: range(0, total),
            starts: Vec::new(),
            sections: Vec::new(),
        };
    }
    let mut starts = Vec::with_capacity(sections.len());
    let mut next_start = total;
    for section in sections.iter().rev() {
        let own = section
            .slide_indices
            .iter()
            .fold(next_start, |own, &index| own.min(index));
        let start = own.min(next_start);
        starts.push(start);
        next_start = start;
    }
    starts.reverse();
    let norm = sections
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let start = starts.get(i).copied().unwrap_or(total);
            let end = starts.get(i + 1).copied().unwrap_or(total);
            SectionInfo {
                id: s.id.clone(),
                name: s.name.clone(),
                slide_indices: range(start, end),
            }
        })
        .collect();
    NormalizedSections {
        lead: range(0, starts.first().copied().unwrap_or(0)),
        starts,
        sections: norm,
    }
}

/// `addSection`: add a section before slide `at_slide_index` (covering it
/// through the end of its containing section). For documents without
/// sections: slides before it go into an auto-created "default section".
/// Returns the updated section list; `None` for an invalid index (one that is
/// out of range, and also one that is not a whole number).
pub fn add_section(
    opened: &mut OpenedPptx,
    at_slide_index: f64,
    name: &str,
    uuid: &mut dyn FnMut() -> String,
) -> Result<Option<Vec<SectionInfo>>, String> {
    let total = opened.deck.slides.len();
    if !(at_slide_index >= 0.0 && at_slide_index < total as f64) || at_slide_index.fract() != 0.0 {
        return Ok(None);
    }
    let at = at_slide_index as usize;
    let cur = get_sections(opened, uuid)?;
    let mut new_sec = SectionInfo {
        id: new_section_id(uuid),
        name: name.to_owned(),
        slide_indices: Vec::new(),
    };
    let next: Vec<SectionInfo>;
    if cur.is_empty() {
        let mut list = Vec::new();
        if at > 0 {
            list.push(SectionInfo {
                id: new_section_id(uuid),
                name: "Default Section".to_owned(),
                slide_indices: range(0, at),
            });
        }
        new_sec.slide_indices = range(at, total);
        list.push(new_sec);
        next = list;
    } else {
        let NormalizedSections {
            starts, sections, ..
        } = normalize_sections(&cur, total);
        let first_start = starts.first().copied().unwrap_or(0);
        if at < first_start {
            // Inserting within the unsectioned leading slides: new section covers [at, first section's start)
            new_sec.slide_indices = range(at, first_start);
            let mut list = vec![new_sec];
            list.extend(sections);
            next = list;
        } else {
            // Find section g containing at, split into [g.start, at) + new section [at, g.end)
            let mut g = sections.len().saturating_sub(1);
            for (i, start) in starts.iter().enumerate() {
                let end = starts.get(i + 1).copied().unwrap_or(total);
                if at >= *start && at < end {
                    g = i;
                    break;
                }
            }
            let end = starts.get(g + 1).copied().unwrap_or(total);
            new_sec.slide_indices = range(at, end);
            let g_start = starts.get(g).copied().unwrap_or(total);
            let mut list = Vec::new();
            let mut new_sec = Some(new_sec);
            for (i, section) in sections.into_iter().enumerate() {
                if i == g {
                    list.push(SectionInfo {
                        slide_indices: range(g_start, at),
                        ..section
                    });
                    list.extend(new_sec.take());
                } else {
                    list.push(section);
                }
            }
            next = list;
        }
    }
    set_sections(opened, &next, uuid)?;
    get_sections(opened, uuid).map(Some)
}

/// `renameSection`: rename a section; `None` if the id does not exist.
pub fn rename_section(
    opened: &mut OpenedPptx,
    id: &str,
    name: &str,
    uuid: &mut dyn FnMut() -> String,
) -> Result<Option<Vec<SectionInfo>>, String> {
    let mut cur = get_sections(opened, uuid)?;
    let Some(s) = cur.iter_mut().find(|x| x.id == id) else {
        return Ok(None);
    };
    s.name = name.to_owned();
    set_sections(opened, &cur, uuid)?;
    get_sections(opened, uuid).map(Some)
}

/// `removeSection`: delete a section but keep its slides: the section's
/// slides merge into the previous section (or the next one for the first
/// section); when no sections remain the whole sectionLst is removed. `None`
/// if the id does not exist.
pub fn remove_section(
    opened: &mut OpenedPptx,
    id: &str,
    _opts: Option<&RemoveSectionOptions>,
    uuid: &mut dyn FnMut() -> String,
) -> Result<Option<Vec<SectionInfo>>, String> {
    let total = opened.deck.slides.len();
    let cur = get_sections(opened, uuid)?;
    let Some(i) = cur.iter().position(|x| x.id == id) else {
        return Ok(None);
    };
    let NormalizedSections { mut sections, .. } = normalize_sections(&cur, total);
    let removed = sections.remove(i);
    if !sections.is_empty() {
        if i > 0 {
            if let Some(previous) = sections.get_mut(i - 1) {
                previous.slide_indices.extend(removed.slide_indices);
            }
        } else if let Some(first) = sections.first_mut() {
            let mut merged = removed.slide_indices;
            merged.append(&mut first.slide_indices);
            first.slide_indices = merged;
        }
    }
    set_sections(opened, &sections, uuid)?;
    get_sections(opened, uuid).map(Some)
}

/// The sldId tags of the `<p:sldIdLst>` of a presentation part: the whole
/// element and its tags.
fn sld_id_tags(pres: &str) -> Option<(String, Vec<String>)> {
    let m = js_regex!(r"<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>").exec(pres)?;
    let tags = js_regex!(r"<p:sldId\b[^>]*\/>", "g")
        .find_iter(m.get(1).unwrap_or_default())
        .map(|t| t.as_str().to_owned())
        .collect();
    Some((m.as_str().to_owned(), tags))
}

/// `moveSlide`: move slide `from_index` to `to_index` (the insertion index
/// after removal, i.e. drag-drop semantics). Keeps presentation.xml's
/// sldIdLst order and deck.slides in sync; with sections, the moved slide
/// joins the section at the drop position (a section emptied by the move
/// stays as an empty section). An index that is not a whole number answers
/// `false`.
pub fn move_slide(
    opened: &mut OpenedPptx,
    from_index: f64,
    to_index: f64,
    uuid: &mut dyn FnMut() -> String,
) -> Result<bool, String> {
    let total = opened.deck.slides.len();
    if !(from_index >= 0.0 && from_index < total as f64) {
        return Ok(false);
    }
    let to = to_index.min(total as f64 - 1.0).max(0.0);
    if from_index.fract() != 0.0 || to.fract() != 0.0 {
        return Ok(false);
    }
    let (from, to) = (from_index as usize, to as usize);
    if from == to {
        return Ok(false);
    }

    // Before moving, label each slide with its section by position (-1 = unsectioned leading slide)
    let cur = get_sections(opened, uuid)?;
    let mut labels: Option<Vec<i64>> = None;
    if !cur.is_empty() {
        let NormalizedSections { sections, .. } = normalize_sections(&cur, total);
        let mut marks = vec![-1_i64; total];
        for (si, s) in sections.iter().enumerate() {
            for &i in &s.slide_indices {
                if let Some(mark) = marks.get_mut(i) {
                    *mark = si as i64;
                }
            }
        }
        labels = Some(marks);
    }

    // presentation.xml sldIdLst: move the sldId tag wholesale (id/rId travel with it)
    let Some(pres) = opened
        .archive
        .read_text(PRES_PATH)
        .filter(|pres| !pres.is_empty())
        .map(|pres| pres.into_owned())
    else {
        return Ok(false);
    };
    let Some((whole, mut tags)) = sld_id_tags(&pres) else {
        return Ok(false);
    };
    if tags.len() != total {
        return Ok(false);
    }
    let tag = tags.remove(from);
    tags.insert(to, tag);
    let next = replace_literal(
        &pres,
        &whole,
        &format!("<p:sldIdLst>{}</p:sldIdLst>", tags.concat()),
    );
    set_entry(&mut opened.archive, PRES_PATH, next);

    // Sync deck.slides
    let slide = opened.deck.slides.remove(from);
    opened.deck.slides.insert(to, slide);

    // Section membership: the moved slide adopts the label of the slide it displaces at the drop point (keeping sections contiguous), written back in the new order
    if let Some(mut labels) = labels {
        labels.remove(from);
        let adopt = labels
            .get(to)
            .or_else(|| labels.last())
            .copied()
            .unwrap_or(-1);
        labels.insert(to, adopt);
        let rebuilt: Vec<SectionInfo> = cur
            .iter()
            .enumerate()
            .map(|(si, s)| SectionInfo {
                id: s.id.clone(),
                name: s.name.clone(),
                slide_indices: labels
                    .iter()
                    .enumerate()
                    .filter(|(_, l)| **l == si as i64)
                    .map(|(pos, _)| pos)
                    .collect(),
            })
            .collect();
        set_sections(opened, &rebuilt, uuid)?;
    }
    Ok(true)
}

/// `moveSection`: move a whole section up/down: swaps places with the
/// adjacent section, keeping presentation.xml's sldIdLst order and
/// deck.slides order in sync (unsectioned leading slides stay pinned at the
/// front). Returns the updated section list.
pub fn move_section(
    opened: &mut OpenedPptx,
    id: &str,
    dir: SectionDirection,
    uuid: &mut dyn FnMut() -> String,
) -> Result<Option<Vec<SectionInfo>>, String> {
    let total = opened.deck.slides.len();
    let cur = get_sections(opened, uuid)?;
    let Some(idx) = cur.iter().position(|s| s.id == id) else {
        return Ok(None);
    };
    let j = match dir {
        SectionDirection::Up => idx.checked_sub(1),
        SectionDirection::Down => Some(idx + 1),
    };
    let Some(j) = j.filter(|j| *j < cur.len()) else {
        return Ok(None);
    };

    let NormalizedSections { lead, sections, .. } = normalize_sections(&cur, total);
    let mut order = sections;
    order.swap(idx, j);
    let new_old_order: Vec<usize> = lead
        .iter()
        .copied()
        .chain(order.iter().flat_map(|s| s.slide_indices.iter().copied()))
        .collect();
    if new_old_order.len() != total {
        return Ok(None);
    }

    // Sync presentation.xml sldIdLst order (sldId tags moved wholesale, id/rId travel with them)
    let Some(pres) = opened
        .archive
        .read_text(PRES_PATH)
        .filter(|pres| !pres.is_empty())
        .map(|pres| pres.into_owned())
    else {
        return Ok(None);
    };
    let Some((whole, tags)) = sld_id_tags(&pres) else {
        return Ok(None);
    };
    if tags.len() != total {
        return Ok(None);
    }
    let new_inner: String = new_old_order
        .iter()
        .map(|&i| tags.get(i).map_or("undefined", String::as_str))
        .collect();
    let next = replace_literal(
        &pres,
        &whole,
        &format!("<p:sldIdLst>{new_inner}</p:sldIdLst>"),
    );
    set_entry(&mut opened.archive, PRES_PATH, next);

    // Sync deck.slides order
    let mut old: Vec<Option<Slide>> = std::mem::take(&mut opened.deck.slides)
        .into_iter()
        .map(Some)
        .collect();
    opened.deck.slides = new_old_order
        .iter()
        .filter_map(|&i| old.get_mut(i).and_then(Option::take))
        .collect();

    // Recompute section indices for the new slide order and write back
    let mut pos = lead.len();
    let rebuilt: Vec<SectionInfo> = order
        .iter()
        .map(|s| {
            let indices = range(pos, pos + s.slide_indices.len());
            pos += s.slide_indices.len();
            SectionInfo {
                id: s.id.clone(),
                name: s.name.clone(),
                slide_indices: indices,
            }
        })
        .collect();
    set_sections(opened, &rebuilt, uuid)?;
    get_sections(opened, uuid).map(Some)
}
