//! `page/reverse.ts`: OOXML to ODF for pages: page setup, headers/footers and
//! section breaks of the edited docx written back into `styles.xml` (page
//! layouts, master pages) and into the styles of the paragraphs that start
//! page runs.
//!
//! 1. Normalise: the `w:sectPr` the bridge put into paragraphs is stripped
//!    from the bridge elements and from the edited elements.
//! 2. Map the edited sections onto the bridge's.
//! 3. Each edited page run wants a state of its master page; runs that want a
//!    different state than the others get a clone (`<name>_io<n>`).
//! 4. A run moved to a clone changes the style of the paragraph that starts
//!    it: in place, else through the decorator (`register.rs`).
//!
//! Columns are never written. Everything not named keeps its bytes.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use docx_engine::model::{Block, BlockType, HfParagraph};
use docx_engine::section::{
    SectionBlock, SectionInfo, SectionSettings, read_sections, section_from_sect_pr,
    section_settings_from_xml,
};
use jscompat::{JsMap, TryJsRegex, js_regex};
use serde_json::{Map, Value};

use crate::core::body::OdtNodeKind;
use crate::core::convert::{AlignedItem, ItemRef, OdtPartInfo, OoxmlToOdfContext};
use crate::core::errors::OdtError;
use crate::core::flow::{align_items, edited_items, paragraph_block_of};
use crate::core::open::OdtDocument;
use crate::core::styles::{OdtMasterPage, OdtStyle, OdtStylePart, OdtStyleScope};
use crate::text::lists::num_fmt_to_odf;
use crate::text::props::AttrOverrides;
use crate::text::style_xml::{StyleXmlEdit, edit_style_xml};

use super::geometry::{LayoutOverrides, is_empty_overrides, layout_overrides};
use super::hf::{
    EditedPart, baseline_paragraphs, canonical, read_edited_parts, region_inner, region_inner_xml,
};
use super::model::{HF_REGIONS, HfFill, HfRegion, PageExt, master_region, read_page_ext};
use super::odf::{LayoutEdit, MasterEdit, RegionEdits, edit_layout_xml, edit_master_xml};
use super::register::{FORCE_MARK, PagePlan, StartChange, has_page_decorator};
use super::sectpr::{paragraph_sect_pr, strip_p_pr_sect_pr, strip_paragraph_sect_pr};

/// `EditedRun`
#[derive(Debug, Clone)]
struct EditedRun {
    /// edited section indexes (a page run plus its continuous `text:section` parts)
    sections: Vec<usize>,
    /// bridge run it continues, or `None` for a run whose break was added in the editor
    continues: Option<usize>,
    /// bridge run its content comes from
    base_run: usize,
    /// bridge docx section to compare its first section with
    base_section: usize,
    /// index (into `aligned`) of the first edited element mapped onto the bridge
    carrier: Option<usize>,
}

/// `RunState`
#[derive(Debug, Clone)]
struct RunState {
    layout: LayoutOverrides,
    regions: RegionEdits,
    key: String,
    page_number: Option<Option<String>>,
}

/// `'a' | 'b'`: how a run's start paragraph can be re-pointed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// in place
    A,
    /// via the decorator
    B,
}

/// `preparePageWriteBack`: prepares the page write-back and returns the edited
/// body items to rebuild with (`rebuildOdtBody(rctx, items)`). Queues every
/// styles.xml patch for page layouts and master pages. Call before
/// `rebuildOdtBody`.
pub fn prepare_page_write_back(rctx: &mut OoxmlToOdfContext) -> Result<Vec<ItemRef>, OdtError> {
    let items = edited_items(&rctx.edited);
    let Some(ext) = read_page_ext(&rctx.map) else {
        return Ok(items);
    };
    let breaks = normalise(rctx, &ext, &items);
    let aligned = align_items(rctx, &items)?;
    let section_blocks: Vec<SectionBlock> = rctx
        .edited
        .blocks
        .iter()
        .map(|b| SectionBlock {
            hidden: b.hidden.as_ref().copied(),
            original_xml: b.original_xml.clone().into_option().flatten(),
            docx_index: b.docx_index.clone().into_option().flatten().map(|n| n.0),
        })
        .collect();
    let edited = read_sections(&section_blocks, rctx.edited.gutter_at_top);
    let mut writer = PageWriter::new(rctx, &ext, &aligned, &edited);
    writer.run()?;
    // a section break the editor inserted is an empty paragraph of its own: ODF needs none
    let dropped: HashSet<usize> = aligned
        .iter()
        .filter(|a| {
            a.element.is_none()
                && breaks.contains(&(Rc::as_ptr(&a.item) as usize))
                && !a
                    .item
                    .borrow()
                    .blocks
                    .iter()
                    .any(|b| b.runs.as_ref().is_some_and(|r| !r.is_empty()))
        })
        .map(|a| Rc::as_ptr(&a.item) as usize)
        .collect();
    if dropped.is_empty() {
        return Ok(items);
    }
    Ok(items
        .into_iter()
        .filter(|item| !dropped.contains(&(Rc::as_ptr(item) as usize)))
        .collect())
}

// ---------------------------------------------------------------------------
// 1. normalise

/// `normalise`: strips the bridge's and the edited section breaks; returns the
/// items (by identity) that carried one.
fn normalise(rctx: &mut OoxmlToOdfContext, ext: &PageExt, items: &[ItemRef]) -> HashSet<usize> {
    let mut breaks = HashSet::new();
    for s in &ext.sections {
        let Some(carrier) = s.carrier else { continue };
        if let Some(el) = rctx.map.elements.get_mut(carrier) {
            el.xml = strip_paragraph_sect_pr(&el.xml);
        }
    }
    for item in items {
        let xml = item.borrow().xml.clone();
        if paragraph_sect_pr(&xml).is_none() {
            continue;
        }
        let stripped = strip_paragraph_sect_pr(&xml);
        let mut inner = item.borrow_mut();
        inner.xml = stripped.clone();
        inner.blocks = inner
            .blocks
            .iter()
            .map(|b| paragraph_block(b, &stripped))
            .collect();
        breaks.insert(Rc::as_ptr(item) as usize);
    }
    breaks
}

/// `paragraphBlock`: an edited block without its section break (a text-less
/// one parses as a passthrough "section break").
fn paragraph_block(b: &Block, xml: &str) -> Block {
    let mut out = b.clone();
    if b.r#type.as_ref() == Some(&BlockType::Passthrough) {
        let p_pr = js_regex!(r"^<w:p(?:\s[^>]*)?>(<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)")
            .exec(xml)
            .and_then(|m| m.get(1));
        let style_id = p_pr.and_then(|p| {
            js_regex!(r#"<w:pStyle w:val="([^"]*)""#)
                .exec(p)
                .and_then(|m| m.get(1))
        });
        let hidden: Vec<String> = js_regex!(r#"<w:bookmarkStart\b[^>]*\bw:name="(_[^"]*)""#)
            .find_iter(xml)
            .filter_map(|m| m.get(1).map(str::to_owned))
            .collect();
        out.r#type.set(BlockType::Paragraph);
        out.runs.set(Vec::new());
        if let Some(style_id) = style_id.filter(|s| !s.is_empty()) {
            out.style_id.set(style_id.to_owned());
        }
        if let Some(p_pr) = p_pr.filter(|s| !s.is_empty()) {
            out.raw_p_pr.set(p_pr.to_owned());
        }
        out.hidden_bookmarks.set(hidden);
        return out;
    }
    if let Some(raw) = b.raw_p_pr.as_ref() {
        if raw.contains("<w:sectPr") {
            out.raw_p_pr.assign(strip_p_pr_sect_pr(Some(raw)));
        }
    }
    out
}

// ---------------------------------------------------------------------------

/// `sameGeometry`: `GEOMETRY_KEYS.every((k) => a[k] === b[k])`
fn same_geometry(a: &SectionSettings, b: &SectionSettings) -> bool {
    a.page_width.0 == b.page_width.0
        && a.page_height.0 == b.page_height.0
        && a.orientation == b.orientation
        && a.margin_top.0 == b.margin_top.0
        && a.margin_right.0 == b.margin_right.0
        && a.margin_bottom.0 == b.margin_bottom.0
        && a.margin_left.0 == b.margin_left.0
        && a.header_dist.map(|n| n.0) == b.header_dist.map(|n| n.0)
        && a.footer_dist.map(|n| n.0) == b.footer_dist.map(|n| n.0)
}

fn regions_value(regions: &RegionEdits) -> Value {
    let mut map = Map::new();
    for (region, plan) in regions {
        map.insert(
            region.as_str().to_owned(),
            plan.as_ref()
                .map_or(Value::Null, |inner| Value::String(inner.clone())),
        );
    }
    Value::Object(map)
}

fn state_key(layout: &LayoutOverrides, regions: &RegionEdits) -> String {
    let mut map = Map::new();
    map.insert(
        "layout".to_owned(),
        serde_json::to_value(layout).unwrap_or(Value::Null),
    );
    map.insert("regions".to_owned(), regions_value(regions));
    canonical(&Value::Object(map))
}

fn escape_reg_exp(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ".*+?^${}()|[]\\".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `PageWriter`
struct PageWriter<'a> {
    rctx: &'a mut OoxmlToOdfContext,
    doc: Rc<OdtDocument>,
    ext: &'a PageExt,
    aligned: &'a [AlignedItem],
    edited: &'a [SectionInfo],
    info: Rc<OdtPartInfo>,
    content: Rc<OdtPartInfo>,
    decorated: bool,
    body: Option<String>,
    item_by_element: HashMap<usize, &'a AlignedItem>,
    element_by_paragraph: HashMap<usize, usize>,
    parts: JsMap<EditedPart>,
    baselines: JsMap<Vec<HfParagraph>>,
    patched_styles: HashSet<String>,
    /// paragraphs whose page-run start was already written
    started: HashSet<usize>,
}

/// A member of a master page group.
struct Member {
    run: usize,
    state: RunState,
    mode: Option<Mode>,
}

/// A target of the write: a master page edited in place or a clone of one.
struct Target {
    /// index into `styles.masterPages` of the master page (the first of its name)
    master: usize,
    /// `None`: the master page itself (edited in place)
    clone: Option<String>,
    state: RunState,
    members: Vec<usize>,
    layout_name: Option<String>,
}

impl<'a> PageWriter<'a> {
    fn new(
        rctx: &'a mut OoxmlToOdfContext,
        ext: &'a PageExt,
        aligned: &'a [AlignedItem],
        edited: &'a [SectionInfo],
    ) -> Self {
        let info = rctx.part(OdtStylePart::StylesXml);
        let content = rctx.part(OdtStylePart::ContentXml);
        let decorated = has_page_decorator(&rctx.registry);
        let mut item_by_element = HashMap::new();
        for a in aligned {
            if let Some(e) = a.element {
                item_by_element.insert(e, a);
            }
        }
        let mut element_by_paragraph = HashMap::new();
        for e in &rctx.map.elements {
            if let Some(p) = e.paragraph {
                element_by_paragraph.insert(p, e.id);
            }
        }
        let doc = rctx.doc.clone();
        PageWriter {
            rctx,
            doc,
            ext,
            aligned,
            edited,
            info,
            content,
            decorated,
            body: None,
            item_by_element,
            element_by_paragraph,
            parts: JsMap::new(),
            baselines: JsMap::new(),
            patched_styles: HashSet::new(),
            started: HashSet::new(),
        }
    }

    /// `run`
    fn run(&mut self) -> Result<(), OdtError> {
        let runs = self.edited_runs();
        // header/footer parts of every edited run
        let mut r_ids: Vec<String> = Vec::new();
        for r in &runs {
            let i = r.sections[0];
            for kind in [HfKind::Header, HfKind::Footer] {
                for variant in [Variant::Default, Variant::First, Variant::Even] {
                    if let Some(r_id) = self.effective_ref(i, kind, variant) {
                        r_ids.push(r_id);
                    }
                }
            }
        }
        self.parts = read_edited_parts(self.rctx, self.ext, &r_ids)?;
        let changed_bridge_parts: Vec<_> = self
            .parts
            .iter()
            .filter(|(_, p)| !p.unchanged)
            .filter_map(|(_, p)| self.ext.parts.get(&p.r_id).cloned())
            .collect();
        self.baselines = baseline_paragraphs(
            &changed_bridge_parts,
            self.rctx.options.edited_styles_xml.as_deref(),
        )?;
        self.write(&runs)
    }

    // ---- 2. edited sections -> edited page runs

    /// `sectionOf`
    fn section_of(&self, element: usize) -> Option<usize> {
        self.ext.sections.iter().position(
            |s| matches!((s.first, s.last), (Some(f), Some(l)) if f <= element && element <= l),
        )
    }

    /// `editedRuns`
    fn edited_runs(&mut self) -> Vec<EditedRun> {
        let mut claimed: HashSet<usize> = HashSet::new();
        let mut out: Vec<EditedRun> = Vec::new();
        for (i, e) in self.edited.iter().enumerate() {
            let first = self.aligned.iter().position(|a| {
                a.element.is_some() && {
                    let index = a.item.borrow().index as f64;
                    index >= e.first_block_index.0 && index <= e.last_block_index.0
                }
            });
            let mut cont: Option<usize> = None;
            let mut base: Option<usize> = None;
            if let Some(first_element) = first.and_then(|f| self.aligned[f].element) {
                if let Some(k) = self.section_of(first_element) {
                    base = Some(k);
                    let mut ok = !claimed.contains(&k);
                    let mut el = self.ext.sections[k].first.unwrap_or(0);
                    while ok && el < first_element {
                        if self.rctx.matched.contains(&el) {
                            ok = false;
                        }
                        el += 1;
                    }
                    if ok {
                        claimed.insert(k);
                        cont = Some(k);
                    }
                }
            }
            if let (Some(prev), Some(c)) = (out.last_mut(), cont) {
                if self.ext.sections[c].continuous {
                    prev.sections.push(i);
                    continue;
                }
            }
            let base_section = cont
                .or(base)
                .or(out.last().map(|p| p.base_section))
                .unwrap_or(0);
            let bridge_run = self.ext.sections.get(base_section).map_or(0, |s| s.run);
            let continues = if cont.is_some() || i == 0 {
                Some(bridge_run)
            } else {
                None
            };
            if continues.is_none() {
                if first.is_none() {
                    self.rctx
                        .warn("a section break before new content only was not written");
                    if let Some(prev) = out.last_mut() {
                        prev.sections.push(i);
                    }
                    continue;
                }
                if e.start_type == "continuous" {
                    self.rctx
                        .warn("a continuous section break was written as a page break");
                }
            }
            out.push(EditedRun {
                sections: vec![i],
                continues,
                base_run: bridge_run,
                base_section,
                carrier: first,
            });
        }
        out
    }

    /// `effectiveRef`: the header/footer part a section shows for a slot (its
    /// own or inherited, as Word does).
    fn effective_ref(&self, section: usize, kind: HfKind, variant: Variant) -> Option<String> {
        for j in (0..=section).rev() {
            let refs = if kind == HfKind::Header {
                &self.edited[j].header_refs
            } else {
                &self.edited[j].footer_refs
            };
            if let Some(r_id) = refs.get(variant.as_str()).filter(|r| !r.is_empty()) {
                return Some(r_id.clone());
            }
        }
        None
    }

    // ---- 3. wanted states

    fn master_of_run(&self, run: usize) -> Option<Rc<OdtMasterPage>> {
        let name = self
            .ext
            .runs
            .get(run)?
            .master
            .as_deref()
            .filter(|n| !n.is_empty())?;
        self.doc.styles.master_page(name)
    }

    fn layout_of(&self, master: &OdtMasterPage) -> Option<Rc<OdtStyle>> {
        master
            .page_layout_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .and_then(|n| self.doc.styles.page_layout(n))
    }

    /// `sourceSection`: the bridge section an edited section's `w:sectPr` comes from.
    fn source_section(&self, i: usize, fallback: usize) -> usize {
        let e = &self.edited[i];
        if i == self.edited.len() - 1 {
            return self.ext.sections.len().saturating_sub(1);
        }
        let carrier = self
            .aligned
            .iter()
            .find(|a| a.item.borrow().index as f64 == e.last_block_index.0);
        if let Some(element) = carrier.and_then(|c| c.element) {
            if let Some(j) = self
                .ext
                .sections
                .iter()
                .position(|s| s.carrier == Some(element))
            {
                return j;
            }
        }
        for a in self.aligned.iter().rev() {
            let Some(element) = a.element else { continue };
            let index = a.item.borrow().index as f64;
            if index < e.first_block_index.0 || index > e.last_block_index.0 {
                continue;
            }
            if let Some(j) = self.section_of(element) {
                return j;
            }
        }
        fallback
    }

    /// `stateOf`
    fn state_of(&mut self, r: &EditedRun, master: &OdtMasterPage) -> Result<RunState, OdtError> {
        let layout = self.layout_of(master);
        let mut overrides = LayoutOverrides::default();
        for &i in &r.sections {
            let source = self.source_section(i, r.base_section);
            let before = section_settings_from_xml(&self.ext.sections[source].sect_pr, None);
            let after = &self.edited[i].settings;
            if same_geometry(&before, after) {
                continue;
            }
            overrides = layout_overrides(layout.as_deref(), &before, after);
            break;
        }
        let first = &self.edited[r.sections[0]];
        let source = self.source_section(r.sections[0], r.base_section);
        let bridge_first = section_from_sect_pr(&self.ext.sections[source].sect_pr, 0.0, 0.0, None);
        if first.page_number_fmt != bridge_first.page_number_fmt {
            overrides.page.set(
                "style:num-format",
                first.page_number_fmt.as_deref().map(num_fmt_to_odf),
            );
        }
        let first_start = first.page_number_start.map(|n| n.0);
        let bridge_start = bridge_first.page_number_start.map(|n| n.0);
        let page_number = if first_start != bridge_start {
            Some(first_start.map(jscompat::number_to_string))
        } else {
            None
        };
        let regions = self.region_plans(r, master, source, bridge_first.title_pg)?;
        let key = state_key(&overrides, &regions);
        Ok(RunState {
            layout: overrides,
            regions,
            key,
            page_number,
        })
    }

    /// `regionPlans`
    fn region_plans(
        &mut self,
        r: &EditedRun,
        master: &OdtMasterPage,
        source: usize,
        source_title_pg: bool,
    ) -> Result<RegionEdits, OdtError> {
        let mut out: RegionEdits = Vec::new();
        let i = r.sections[0];
        let e = &self.edited[i];
        let even_odd = self.rctx.edited.even_and_odd_headers.unwrap_or(false);
        let source_run = self.ext.sections.get(source).map_or(r.base_run, |s| s.run);
        let doc = self.doc.clone();
        for region in HF_REGIONS {
            let name = region.as_str();
            let kind = if name.starts_with("header") {
                HfKind::Header
            } else {
                HfKind::Footer
            };
            let variant = if name.ends_with("-first") {
                Variant::First
            } else if name.ends_with("-left") {
                Variant::Even
            } else {
                Variant::Default
            };
            let on = variant == Variant::Default
                || (if variant == Variant::First {
                    e.title_pg
                } else {
                    even_odd
                });
            let was_on = variant == Variant::Default
                || (if variant == Variant::First {
                    source_title_pg
                } else {
                    self.ext.even_and_odd
                });
            let has = master_region(master, region);
            let kind_region = if kind == HfKind::Header {
                HfRegion::Header
            } else {
                HfRegion::Footer
            };
            let has_plain = master_region(master, kind_region).is_some();
            if !on {
                if was_on && has.is_some() {
                    out.push((region, None));
                }
                continue;
            }
            let Some(r_id) = self.effective_ref(i, kind, variant) else {
                // a first / left page newly switched on that shows nothing in the editor
                if !was_on && has.is_none() && has_plain {
                    out.push((region, Some(String::new())));
                }
                continue;
            };
            let part = self.ext.parts.get(&r_id);
            let state = self.parts.get(&r_id);
            if let (Some(part), Some(state)) = (part, state) {
                if state.unchanged {
                    let source_slot = self
                        .ext
                        .runs
                        .get(source_run)
                        .and_then(|run| run.slots.get(name));
                    if source_slot == Some(&r_id) {
                        continue;
                    }
                    if part.master == master.name
                        && part.region == Some(region)
                        && part.fill == HfFill::Content
                    {
                        continue;
                    }
                    if part.fill == HfFill::Fallback
                        && part.master == master.name
                        && part.region == Some(kind_region)
                        && has.is_none()
                    {
                        continue;
                    }
                    if part.fill == HfFill::Empty {
                        if has.is_none() && !(variant != Variant::Default && has_plain) {
                            continue;
                        }
                        out.push((region, Some(String::new())));
                        continue;
                    }
                    // content of another master page's region (Link to Previous)
                    let source_master = doc.styles.master_page(&part.master);
                    let from = part
                        .region
                        .and_then(|pr| source_master.as_deref().and_then(|m| master_region(m, pr)));
                    let inner = from.map_or(String::new(), |f| region_inner(self.rctx, f));
                    if let Some(has) = has {
                        if region_inner(self.rctx, has) == inner {
                            continue;
                        }
                    }
                    if has.is_none()
                        && variant != Variant::Default
                        && part.region == Some(kind_region)
                        && part.master == master.name
                    {
                        continue;
                    }
                    out.push((region, Some(inner)));
                    continue;
                }
            }
            // changed or new part
            let source_master = part.and_then(|p| doc.styles.master_page(&p.master));
            let from = part
                .and_then(|p| p.region)
                .and_then(|pr| source_master.as_deref().and_then(|m| master_region(m, pr)));
            let records: Vec<_> = part
                .map(|p| {
                    p.paragraphs
                        .iter()
                        .map(|id| self.rctx.map.paragraphs[*id].clone())
                        .collect()
                })
                .unwrap_or_default();
            let baseline = part.and_then(|p| self.baselines.get(&p.r_id));
            let edited_paras: &[HfParagraph] = state.map_or(&[], |s| s.paragraphs.as_slice());
            let inner = region_inner_xml(
                self.rctx,
                from,
                &records,
                baseline.map(Vec::as_slice),
                edited_paras,
            )?;
            if let Some(has) = has {
                if region_inner(self.rctx, has) == inner {
                    continue;
                }
            }
            out.push((region, Some(inner)));
        }
        Ok(out)
    }

    // ---- 4. writing

    /// `write`
    fn write(&mut self, runs: &[EditedRun]) -> Result<(), OdtError> {
        let doc = self.doc.clone();
        let styles = &doc.styles;
        // states, grouped by master page
        let mut members: Vec<Member> = Vec::new();
        let mut by_master: JsMap<Vec<usize>> = JsMap::new();
        for (ri, r) in runs.iter().enumerate() {
            let Some(master) = self.master_of_run(r.continues.unwrap_or(r.base_run)) else {
                if r.continues.is_none() {
                    self.rctx
                        .warn("a section break in a document without master pages was not written");
                }
                continue;
            };
            let state = self.state_of(r, &master)?;
            let mode = self.start_mode(r);
            members.push(Member {
                run: ri,
                state,
                mode,
            });
            let index = members.len() - 1;
            match by_master.get_mut(&master.name) {
                Some(list) => list.push(index),
                None => by_master.set(master.name.clone(), vec![index]),
            }
        }

        let mut targets: Vec<Target> = Vec::new();
        for (name, member_ids) in by_master.iter() {
            let master_index = styles
                .master_pages
                .iter()
                .position(|m| m.name == name)
                .unwrap_or(0);
            let mut groups: JsMap<Vec<usize>> = JsMap::new();
            for &m in member_ids {
                let key = members[m].state.key.clone();
                match groups.get_mut(&key) {
                    Some(g) => g.push(m),
                    None => groups.set(key, vec![m]),
                }
            }
            let continuing = |g: &[usize]| -> Vec<usize> {
                g.iter()
                    .copied()
                    .filter(|m| runs[members[*m].run].continues.is_some())
                    .collect()
            };
            let entries: Vec<(&str, &Vec<usize>)> = groups
                .iter()
                .filter(|(_, g)| !continuing(g).is_empty())
                .collect();
            // the master page stays with the runs that cannot move, else the
            // unchanged ones, else the first
            let stuck: Vec<&(&str, &Vec<usize>)> = entries
                .iter()
                .filter(|(_, g)| continuing(g).iter().any(|m| members[*m].mode.is_none()))
                .collect();
            if stuck.len() > 1 {
                self.rctx.warn(&format!(
                    "page style \"{name}\": a section's change could not be kept apart from the others"
                ));
            }
            let empty_key = state_key(&LayoutOverrides::default(), &Vec::new());
            let keeper: Option<String> = stuck
                .first()
                .map(|(k, _)| (*k).to_owned())
                .or_else(|| {
                    entries
                        .iter()
                        .find(|(k, _)| *k == empty_key)
                        .map(|(k, _)| (*k).to_owned())
                })
                .or_else(|| entries.first().map(|(k, _)| (*k).to_owned()));
            for (key, g) in groups.iter() {
                let stay: Vec<usize> = if keeper.as_deref() == Some(key) {
                    continuing(g)
                } else {
                    Vec::new()
                };
                let moved: Vec<usize> = g.iter().copied().filter(|m| !stay.contains(m)).collect();
                if !stay.is_empty() {
                    targets.push(Target {
                        master: master_index,
                        clone: None,
                        state: members[g[0]].state.clone(),
                        members: stay,
                        layout_name: None,
                    });
                }
                if !moved.is_empty() {
                    let movable: Vec<usize> = moved
                        .iter()
                        .copied()
                        .filter(|m| {
                            members[*m].mode.is_some() || runs[members[*m].run].continues.is_none()
                        })
                        .collect();
                    let blocked = moved.iter().any(|m| !movable.contains(m));
                    if blocked && keeper.as_deref() != Some(key) {
                        self.rctx.warn(&format!(
                            "page style \"{name}\": a section's change could not be written"
                        ));
                    }
                    if !movable.is_empty() {
                        targets.push(Target {
                            master: master_index,
                            clone: Some(self.rctx.allocate_style_name(name)),
                            state: members[g[0]].state.clone(),
                            members: movable,
                            layout_name: None,
                        });
                    }
                }
            }
        }

        // page layouts: in place when every master page using it wants the same change
        struct User {
            target: Option<usize>,
            key: String,
        }
        let layout_key = |s: &RunState| {
            if is_empty_overrides(&s.layout) {
                String::new()
            } else {
                canonical(&serde_json::to_value(&s.layout).unwrap_or(Value::Null))
            }
        };
        let mut layout_users: JsMap<Vec<User>> = JsMap::new();
        for (mi, m) in styles.master_pages.iter().enumerate() {
            let Some(layout_name) = m.page_layout_name.as_deref().filter(|n| !n.is_empty()) else {
                continue;
            };
            let own = targets
                .iter()
                .position(|t| t.master == mi && t.clone.is_none());
            let user = User {
                target: own,
                key: own.map_or(String::new(), |t| layout_key(&targets[t].state)),
            };
            match layout_users.get_mut(layout_name) {
                Some(list) => list.push(user),
                None => layout_users.set(layout_name.to_owned(), vec![user]),
            }
        }
        for (ti, t) in targets.iter().enumerate() {
            if t.clone.is_none() {
                continue;
            }
            let Some(layout_name) = styles.master_pages[t.master]
                .page_layout_name
                .as_deref()
                .filter(|n| !n.is_empty())
            else {
                continue;
            };
            if let Some(list) = layout_users.get_mut(layout_name) {
                list.push(User {
                    target: Some(ti),
                    key: layout_key(&t.state),
                });
            }
        }
        for (name, users) in layout_users.iter() {
            let Some(layout) = styles.page_layout(name) else {
                continue;
            };
            let keys: HashSet<&str> = users.iter().map(|u| u.key.as_str()).collect();
            let source = self.info.xml.text[layout.start..layout.end].to_owned();
            // nobody keeps the layout as it is: one change takes it in place
            // (the master page edited in place first), the other changes get clones
            let in_place: Option<String> = if keys.contains("") {
                None
            } else {
                let chosen = users
                    .iter()
                    .find(|u| u.target.is_some_and(|t| targets[t].clone.is_none()))
                    .unwrap_or(&users[0]);
                Some(chosen.key.clone())
            };
            let mut clones: JsMap<String> = JsMap::new();
            for u in users {
                let Some(target) = u.target else { continue };
                if u.key.is_empty() {
                    continue;
                }
                if in_place.as_deref() == Some(u.key.as_str()) {
                    if !clones.has(&u.key) {
                        clones.set(u.key.clone(), name.to_owned());
                        let edit = layout_edit(None, &targets[target].state.layout);
                        let patched = edit_layout_xml(&source, &self.info.prefixes, &edit)?;
                        self.rctx.patch(
                            OdtStylePart::StylesXml,
                            layout.start,
                            layout.end,
                            &patched,
                        );
                    }
                    continue;
                }
                let clone = match clones.get(&u.key).filter(|c| !c.is_empty()) {
                    Some(c) => c.clone(),
                    None => {
                        let clone = self.rctx.allocate_style_name(name);
                        clones.set(u.key.clone(), clone.clone());
                        let edit = layout_edit(Some(clone.clone()), &targets[target].state.layout);
                        let xml = edit_layout_xml(&source, &self.info.prefixes, &edit)?;
                        self.rctx.add_automatic_style(OdtStylePart::StylesXml, &xml);
                        clone
                    }
                };
                targets[target].layout_name = Some(clone);
            }
        }

        // master pages
        for t in &targets {
            let master = &styles.master_pages[t.master];
            let regions = &t.state.regions;
            let source = self.info.xml.text[master.start..master.end].to_owned();
            let style_tag = match master.tag.find(':') {
                Some(at) if at > 0 => &master.tag[..at],
                _ => "style",
            };
            let edit = MasterEdit {
                name: t.clone.clone(),
                layout: t.layout_name.clone(),
                regions: if regions.is_empty() {
                    None
                } else {
                    Some(regions.clone())
                },
            };
            if t.clone.is_none() {
                if edit.name.is_none() && edit.layout.is_none() && edit.regions.is_none() {
                    continue;
                }
                let patched = edit_master_xml(&source, &self.info.prefixes, style_tag, &edit)?;
                self.rctx
                    .patch(OdtStylePart::StylesXml, master.start, master.end, &patched);
            } else {
                let patched = edit_master_xml(&source, &self.info.prefixes, style_tag, &edit)?;
                self.rctx
                    .patch(OdtStylePart::StylesXml, master.end, master.end, &patched);
            }
        }

        // run starts
        for t in &targets {
            let master_name = t
                .clone
                .clone()
                .unwrap_or_else(|| styles.master_pages[t.master].name.clone());
            for &m in &t.members {
                let member = &members[m];
                self.point_run(
                    &runs[member.run],
                    &master_name,
                    member.state.page_number.clone(),
                    member.mode,
                );
            }
        }
        // removed breaks: the run follows the previous one
        let continued: HashSet<usize> = runs.iter().filter_map(|r| r.continues).collect();
        for (index, run) in self.ext.runs.iter().enumerate() {
            if index == 0 || run.hidden || continued.contains(&index) {
                continue;
            }
            if let Some(start_paragraph) = run.start_paragraph {
                let Some(element) = self.element_by_paragraph.get(&start_paragraph).copied() else {
                    continue;
                };
                if !self.rctx.matched.contains(&element) {
                    continue;
                }
                if self.started.contains(&start_paragraph) {
                    continue;
                }
                let mut change = StartChange {
                    paragraph: start_paragraph,
                    master: Some(None),
                    page_number: None,
                };
                if self.has_page_number(run.start_style.as_deref()) {
                    change.page_number = Some(None);
                }
                let mode = self.paragraph_mode(start_paragraph, true);
                self.apply_start(change, mode);
            } else if let (Some(style), Some(family)) = (&run.start_style, run.start_family) {
                let change = StartChange {
                    paragraph: 0,
                    master: Some(None),
                    page_number: None,
                };
                if !self.patch_style_in_place(style, family.as_str(), &change) {
                    self.rctx.warn(&format!(
                        "the page style switch of style \"{style}\" could not be removed"
                    ));
                }
            }
        }
        Ok(())
    }

    /// `hasPageNumber`
    fn has_page_number(&self, style: Option<&str>) -> bool {
        let Some(style) = style else { return false };
        self.doc
            .styles
            .find(style, "paragraph", OdtStyleScope::Content)
            .and_then(|s| s.properties.get("style:paragraph-properties").cloned())
            .is_some_and(|p| p.get("style:page-number").is_some())
    }

    // ---- run starts

    /// `startMode`: how a run's start paragraph can be re-pointed: in place
    /// (`a`), via the decorator (`b`), or not.
    fn start_mode(&mut self, r: &EditedRun) -> Option<Mode> {
        if let Some(continues) = r.continues {
            let run = &self.ext.runs[continues];
            if let Some(sp) = run.start_paragraph {
                if let Some(element) = self.element_by_paragraph.get(&sp).copied() {
                    if self.rctx.matched.contains(&element) {
                        return self.paragraph_mode(sp, true);
                    }
                }
            } else if let (Some(style), Some(family)) = (&run.start_style, run.start_family) {
                return if self.exclusive_start(style, family.as_str()) {
                    Some(Mode::A)
                } else {
                    None
                };
            }
        }
        let carrier = r
            .carrier
            .and_then(|c| self.aligned[c].element)
            .and_then(|e| self.rctx.map.elements[e].paragraph);
        carrier.and_then(|c| self.paragraph_mode(c, false))
    }

    /// `paragraphMode`
    fn paragraph_mode(&mut self, paragraph: usize, existing_start: bool) -> Option<Mode> {
        let record = self.rctx.map.paragraphs.get(paragraph)?;
        let element = self.element_by_paragraph.get(&paragraph).copied();
        let item = element.and_then(|e| self.item_by_element.get(&e).copied())?;
        let block = record.block.and_then(|b| self.rctx.map.blocks.get(b));
        let text_owned = block.is_some_and(|b| {
            b.owner == "text" && matches!(b.kind, OdtNodeKind::Paragraph | OdtNodeKind::Heading)
        }) && record.list.is_none();
        let style_name = record.style_name.clone();
        let not_text = block.map_or(true, |b| b.owner != "text");
        let unchanged = item.unchanged;
        if existing_start {
            if let Some(style_name) = &style_name {
                if (unchanged || not_text) && self.exclusive_start(style_name, "paragraph") {
                    return Some(Mode::A);
                }
            }
        }
        if text_owned && self.decorated && paragraph_block_of(&item.item.borrow()).is_some() {
            return Some(Mode::B);
        }
        None
    }

    /// `exclusiveStart`: the automatic style switches the master page and is
    /// used by one element only.
    fn exclusive_start(&mut self, name: &str, family: &str) -> bool {
        let doc = self.doc.clone();
        let Some(style) = doc.styles.find(name, family, OdtStyleScope::Content) else {
            return false;
        };
        if !style.automatic
            || style.part != OdtStylePart::ContentXml
            || style.master_page_name.as_deref().is_none_or(str::is_empty)
        {
            return false;
        }
        let attr = if family == "paragraph" {
            "text:style-name"
        } else {
            "table:style-name"
        };
        let raw = style.raw_name.as_deref().unwrap_or(name);
        if self.body.is_none() {
            self.body = Some(
                self.content.xml.text[doc.body.text.open_end..doc.body.text.close_start].to_owned(),
            );
        }
        let body = self.body.as_deref().unwrap_or("");
        let Ok(pattern) = TryJsRegex::new(&format!("\\s{attr}=\"{}\"", escape_reg_exp(raw)), "g")
        else {
            return false;
        };
        let mut count = 0usize;
        for m in pattern.try_find_iter(body) {
            if m.is_err() {
                return false;
            }
            count += 1;
            if count > 1 {
                return false;
            }
        }
        count == 1
    }

    /// `patchStyleInPlace`
    fn patch_style_in_place(&mut self, name: &str, family: &str, change: &StartChange) -> bool {
        if !self.exclusive_start(name, family) {
            return false;
        }
        let doc = self.doc.clone();
        let Some(style) = doc.styles.find(name, family, OdtStyleScope::Content) else {
            return false;
        };
        let key = format!("{family}\u{0}{name}");
        if !self.patched_styles.insert(key) {
            return false;
        }
        let mut attrs = AttrOverrides::new();
        if let Some(master) = &change.master {
            attrs.set("style:master-page-name", master.clone());
        }
        let path = if family == "paragraph" {
            "style:paragraph-properties"
        } else {
            "style:table-properties"
        };
        let props = change.page_number.as_ref().map(|page_number| {
            let mut inner = AttrOverrides::new();
            inner.set("style:page-number", page_number.clone());
            let mut props = jscompat::JsObject::new();
            props.set(path, inner);
            props
        });
        let xml = &self.content.xml.text[style.start..style.end];
        let Ok(edited) = edit_style_xml(
            xml,
            &self.content.prefixes,
            &StyleXmlEdit {
                attrs: Some(attrs),
                props,
                ..Default::default()
            },
        ) else {
            return false;
        };
        self.rctx
            .patch(OdtStylePart::ContentXml, style.start, style.end, &edited);
        true
    }

    /// `pointRun`
    fn point_run(
        &mut self,
        r: &EditedRun,
        master: &str,
        page_number: Option<Option<String>>,
        mode: Option<Mode>,
    ) {
        let current = r.continues.map(|c| &self.ext.runs[c]);
        let mut change = StartChange {
            paragraph: 0,
            master: None,
            page_number: None,
        };
        if page_number.is_some() {
            change.page_number = page_number;
        }
        if let Some(current) = current {
            let start_survives = current.start_paragraph.is_some_and(|sp| {
                self.element_by_paragraph
                    .get(&sp)
                    .is_some_and(|e| self.rctx.matched.contains(e))
            });
            if let (Some(sp), true) = (current.start_paragraph, start_survives) {
                if current.master.as_deref() != Some(master) {
                    change.master = Some(Some(master.to_owned()));
                }
                if change.master.is_none() && change.page_number.is_none() {
                    return;
                }
                change.paragraph = sp;
                self.apply_start(change, mode);
                return;
            }
            if let (None, Some(style), Some(family)) = (
                current.start_paragraph,
                &current.start_style,
                current.start_family,
            ) {
                if current.master.as_deref() != Some(master) {
                    change.master = Some(Some(master.to_owned()));
                }
                if change.master.is_none() && change.page_number.is_none() {
                    return;
                }
                if !self.patch_style_in_place(style, family.as_str(), &change) {
                    self.rctx.warn(&format!(
                        "the page style of style \"{style}\" could not be changed"
                    ));
                }
                return;
            }
            // implicit first run, or its start paragraph was deleted: the first element starts it
            let needed =
                current.master.as_deref() != Some(master) || current.start_paragraph.is_some();
            if !needed && change.page_number.is_none() {
                return;
            }
        }
        change.master = Some(Some(master.to_owned()));
        let carrier = r
            .carrier
            .and_then(|c| self.aligned[c].element)
            .and_then(|e| self.rctx.map.elements[e].paragraph);
        let Some(carrier) = carrier else {
            self.rctx
                .warn("a section break before a table or object was not written");
            return;
        };
        change.paragraph = carrier;
        let mode = mode.or_else(|| self.paragraph_mode(carrier, false));
        self.apply_start(change, mode);
    }

    /// `applyStart`
    fn apply_start(&mut self, change: StartChange, mut mode: Option<Mode>) {
        self.started.insert(change.paragraph);
        let (style_name, block) = {
            let record = &self.rctx.map.paragraphs[change.paragraph];
            (record.style_name.clone(), record.block)
        };
        if mode == Some(Mode::A) {
            if let Some(style_name) = &style_name {
                if self.patch_style_in_place(style_name, "paragraph", &change) {
                    return;
                }
                mode = self.paragraph_mode(change.paragraph, false);
            }
        }
        let Some(block) = block.filter(|_| mode == Some(Mode::B)) else {
            self.rctx
                .warn("a page style switch could not be written for a section");
            return;
        };
        {
            let mut plan = self.rctx.state::<PagePlan>();
            let merged = match plan.starts.get(&block) {
                Some(existing) => StartChange {
                    paragraph: change.paragraph,
                    master: change.master.clone().or_else(|| existing.master.clone()),
                    page_number: change
                        .page_number
                        .clone()
                        .or_else(|| existing.page_number.clone()),
                },
                None => change.clone(),
            };
            plan.starts.insert(block, merged);
        }
        let element = self.element_by_paragraph.get(&change.paragraph).copied();
        let item = element.and_then(|e| self.item_by_element.get(&e).copied());
        if let Some(item) = item {
            if item.unchanged {
                let index = item.item.borrow().index;
                let mut plan = self.rctx.state::<PagePlan>();
                if !plan.forced.contains_key(&index) {
                    let xml = item.item.borrow().xml.clone();
                    plan.forced.insert(index, xml);
                    item.item.borrow_mut().xml.push_str(FORCE_MARK);
                }
            }
        }
    }
}

fn layout_edit(name: Option<String>, layout: &LayoutOverrides) -> LayoutEdit {
    LayoutEdit {
        name,
        page: Some(layout.page.clone()),
        header: Some(layout.header.clone()),
        footer: Some(layout.footer.clone()),
    }
}

/// `'header' | 'footer'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HfKind {
    Header,
    Footer,
}

/// `'default' | 'first' | 'even'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Variant {
    Default,
    First,
    Even,
}

impl Variant {
    fn as_str(self) -> &'static str {
        match self {
            Variant::Default => "default",
            Variant::First => "first",
            Variant::Even => "even",
        }
    }
}
