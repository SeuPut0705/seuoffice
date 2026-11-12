//! `table/reverse.ts`: OOXML -> ODF for tables the editor changed.
//!
//! Same grid (rows, columns and merges as in the original): every cell is
//! compared with the bridge; an untouched cell keeps its original bytes, an
//! edited cell is rewritten in place - only its changed paragraphs are
//! replaced, everything else (row and table tags, other cells, styles) is
//! copied. Cell paragraphs carry no identity bookmark, so they are matched by
//! position and text (common prefix/suffix, then in order); form-field
//! bookmarks follow their text through `placeMarkers`, also across paragraphs
//! split or joined inside a cell.
//!
//! Changed grid (rows/columns added or deleted, cells merged or split): the
//! table is rebuilt from the original pieces. Rows and columns are matched to
//! the original ones by content; matched cells keep their bytes when
//! unchanged, new rows copy a neighbour row's row style and per-cell styles,
//! new columns copy a neighbour column, and the frame around a framed table is
//! kept with its size updated.
//!
//! Cells Hancom locked never change: an edit there is dropped with a warning,
//! and a structural change that would move, merge or delete a locked cell
//! leaves the whole table as it was.
//!
//! Offsets: the records of the `ext` hold UTF-16 offsets (`U16`); every slice
//! of the part string here goes through `IndexedText::to_byte`, and the
//! patches handed to `applyTextPatches` are byte offsets, as everywhere in the
//! engine.

use std::collections::HashMap;
use std::rc::Rc;

use docx_engine::model::{
    CellBorder, CellBorders, TableCell, TableModel, TableModelAlign, TableModelRowHeightRulesItem,
};
use jscompat::{JsObject, js_regex, math_max, number_to_string};
use serde_json::json;

use crate::core::convert::{
    BridgeMarkerKind, BridgeParagraph, OdtPartInfo, OoxmlToOdfContext, TextPatch,
    apply_text_patches,
};
use crate::core::errors::OdtError;
use crate::core::styles::OdtStylePart;
use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementRange, ElementVisitor, OpenVerdict, PrefixMap,
    decode_xml_entities, walk_elements,
};
use crate::objects::package::paragraph_needs_rewrite;
use crate::offset::{IndexedText, U16, u16_len};
use crate::text::markers::{Placement, kept_characters, place_markers};
use crate::text::paragraph_model::{ReadParagraphOptions, ReadParagraphSource, read_paragraph};
use crate::text::paragraph_odf::{
    ParagraphWriteOptions, edited_paragraph_from_table_paragraph, original_model, paragraph_to_odf,
};
use crate::text::props::AttrOverrides;
use crate::text::style_xml::{StyleXmlEdit, edit_style_xml, new_style_xml, patch_start_tag};
use crate::text::units::{length_to_twips, to_fixed, twips_to_cm};

use super::forward::{CellProps, CellVAlign, cell_props_from_odf};
use super::model::{
    AnchorCellRecord, CellRecord, Span, Synthetic, TABLE_OWNER, TableExt, TableRecord, UnitRecord,
    anchor_of, empty_table_ext, span_of,
};
use super::odf_read::{length_cm, style_props};
use super::ooxml_read::{
    EditedAnchor, EditedGrid, EditedItem, EditedTable, OxCell, OxItemKind, OxTable, edited_grid,
    edited_items as cell_items, normalized_tc_pr, para_text, segment_table,
    without_bridge_bookmarks,
};

/// `PART`
const PART: OdtStylePart = OdtStylePart::ContentXml;

/// `TableResult`
#[derive(Clone, Debug, PartialEq)]
pub struct TableResult {
    /// ODF of the `table:table` element
    pub xml: String,
    pub changed: bool,
    /// change of the summed row heights (cm), for the frame around the table
    pub height_delta_cm: f64,
    /// change of the table width (twips)
    pub width_delta_twips: f64,
}

/// `tableExt`
pub fn table_ext(rctx: &mut OoxmlToOdfContext) -> Result<Rc<TableExt>, OdtError> {
    Ok(rctx
        .ext::<TableExt>(TABLE_OWNER)?
        .unwrap_or_else(|| Rc::new(empty_table_ext())))
}

/// `xmlOf`: the content.xml string with its UTF-16 index.
fn xml_of(rctx: &OoxmlToOdfContext) -> Rc<IndexedText> {
    rctx.part(PART).xml.clone()
}

/// `rctx.part(PART).prefixes`
fn prefixes_of(rctx: &OoxmlToOdfContext) -> Rc<PrefixMap> {
    rctx.part(PART).prefixes.clone()
}

/// A record offset as a byte offset of the part string.
fn at(xml: &IndexedText, offset: U16) -> usize {
    xml.to_byte(offset)
}

/// `xml.slice(start, end)` over two record offsets.
fn cut(xml: &IndexedText, start: U16, end: U16) -> String {
    xml.text[at(xml, start)..at(xml, end)].to_string()
}

/// A patch of the part string: byte offsets.
#[derive(Clone, Debug)]
struct Patch {
    start: usize,
    end: usize,
    xml: String,
}

/// `patchSlice`: applies patches whose offsets index the part string to
/// `source`, which starts at `base`.
fn patch_slice(source: &str, base: usize, patches: &[Patch]) -> Result<String, OdtError> {
    let patches: Vec<TextPatch> = patches
        .iter()
        .map(|p| TextPatch {
            part: PART,
            start: p.start.saturating_sub(base),
            end: p.end.saturating_sub(base),
            xml: p.xml.clone(),
        })
        .collect();
    apply_text_patches(source, &patches)
}

/// `tagName`
fn tag_name(start_tag: &str) -> String {
    js_regex!(r"^<([^\s/>]+)")
        .exec(start_tag)
        .and_then(|m| m.get(1))
        .unwrap_or("table:table-cell")
        .to_string()
}

/// `openTag`: a start tag that can take content (self-closing ones are opened).
fn open_tag(tag: &str) -> String {
    js_regex!(r"\s*\/>$").replace_all(tag, |_| ">".to_string())
}

/// `rctx.derivedStyle(PART, key, base, build)` where `build` may throw: the
/// error is raised once the context has answered.
fn derive(
    rctx: &mut OoxmlToOdfContext,
    key: &str,
    base: &str,
    build: impl FnOnce(&str) -> Result<String, OdtError>,
) -> Result<String, OdtError> {
    let mut failure: Option<OdtError> = None;
    let name = rctx.derived_style(PART, key, base, |name| match build(name) {
        Ok(xml) => xml,
        Err(error) => {
            failure = Some(error);
            String::new()
        }
    });
    match failure {
        Some(error) => Err(error),
        None => Ok(name),
    }
}

/// `JSON.stringify` of a derived-style key.
fn key_of(value: serde_json::Value) -> String {
    serde_json::to_string(&value).expect("a style key serializes")
}

// ---------------------------------------------------------------------------
// Paragraphs

/// The tops of a candidate paragraph's markup (`sameParagraph`'s walk).
struct Tops {
    tops: Vec<ElementRange>,
}

impl ElementVisitor for Tops {
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
            self.tops.push(el.range());
        }
        CloseVerdict::Continue
    }
}

/// `sameParagraph`: the original paragraph's semantics equal those of
/// `candidate` (same tags around the same text). The character frames are
/// walked per UTF-16 unit, as `charSets` indexes them.
fn same_paragraph(
    rctx: &mut OoxmlToOdfContext,
    origin: &BridgeParagraph,
    candidate: &str,
) -> Result<bool, OdtError> {
    // atoms with text (notes) cannot be compared; zero-length ones (pictures,
    // placeholders) read back as kept markers and are compared by their bytes
    if origin
        .markers
        .iter()
        .any(|m| m.kind == BridgeMarkerKind::Handler && m.length.0 > 0)
    {
        return Ok(false);
    }
    let Some(a) = original_model(rctx, origin)? else {
        return Ok(false);
    };
    let prefixes = prefixes_of(rctx);
    let mut walker = Tops { tops: Vec::new() };
    walk_elements(candidate, &prefixes, &mut walker, 0, candidate.len());
    let tops = walker.tops;
    if tops.len() != 1 || tops[0].start != 0 || tops[0].end != candidate.len() {
        return Ok(false);
    }
    let part = rctx.part(PART);
    let info = OdtPartInfo {
        part: part.part,
        xml: Rc::new(IndexedText::new(candidate.to_string())),
        prefixes: part.prefixes.clone(),
        font_faces: part.font_faces.clone(),
        scope: part.scope,
    };
    let doc = rctx.doc.clone();
    let b = read_paragraph(
        &ReadParagraphSource {
            info: &info,
            styles: &doc.styles,
        },
        tops[0],
        ReadParagraphOptions::default(),
    )?;
    if a.open_tag != b.open_tag {
        return Ok(false);
    }
    let text: &str = if a.text.ends_with('\u{c}') && !b.text.ends_with('\u{c}') {
        &a.text[..a.text.len() - 1]
    } else {
        &a.text
    };
    if text != b.text {
        return Ok(false);
    }
    for i in 0..u16_len(&b.text).0 as usize {
        let sa = a.char_sets[i];
        let sb = b.char_sets[i];
        if sa < 0 || sb < 0 {
            return Ok(false);
        }
        if a.sets[sa as usize].key != b.sets[sb as usize].key {
            return Ok(false);
        }
    }
    if a.markers.len() != b.markers.len() {
        return Ok(false);
    }
    let xml = xml_of(rctx);
    let candidate_xml = IndexedText::new(candidate.to_string());
    Ok(a.markers.iter().zip(b.markers.iter()).all(|(m, n)| {
        (m.kind == n.kind
            || (m.kind == BridgeMarkerKind::Handler && n.kind == BridgeMarkerKind::Keep))
            && m.offset == n.offset
            && cut(&xml, m.start, m.end) == cut(&candidate_xml, n.start, n.end)
    }))
}

/// `styleIdOf`: the docx style id the bridge wrote for a paragraph (its
/// `w:pStyle`), if any.
fn style_id_of(p: Option<&BridgeParagraph>) -> Option<String> {
    let p = p?;
    js_regex!(r#"<w:pStyle w:val="([^"]*)"\/>"#)
        .exec(&p.p_pr)
        .and_then(|m| m.get(1))
        .map(decode_xml_entities)
}

/// `WriteParaOptions`
#[derive(Default)]
struct WriteParaOptions<'a> {
    follows: Option<&'a BridgeParagraph>,
    placements: Option<&'a [Placement]>,
    /// the bridge `w:p` of the origin (None when not comparable)
    bridge_xml: Option<&'a str>,
}

/// `writeParagraph`: writes an edited cell paragraph; an unchanged one
/// returns its original bytes.
fn write_paragraph(
    rctx: &mut OoxmlToOdfContext,
    item: &EditedItem<'_>,
    origin: Option<&BridgeParagraph>,
    opts: &WriteParaOptions<'_>,
) -> Result<(String, bool), OdtError> {
    let item_para = item.para.as_deref().cloned().unwrap_or_default();
    let mut para = edited_paragraph_from_table_paragraph(&item_para);
    // the docx engine regenerates a table's cell paragraphs without `w:pStyle`
    // (`generateTableModelXml`): a missing style id there means "not changed"
    if para.style_id.is_none() {
        para.style_id = style_id_of(origin.or(opts.follows));
    }
    let Some(origin) = origin else {
        let xml = paragraph_to_odf(
            rctx,
            &para,
            None,
            &ParagraphWriteOptions {
                part: PART,
                neighbour: opts.follows,
                follows: opts.follows,
                placements: opts.placements,
            },
        )?;
        return Ok((xml, true));
    };
    let xml_all = xml_of(rctx);
    let src = cut(&xml_all, origin.start, origin.end);
    // a note in it changed although the paragraph's OOXML did not (objects layer)
    let dirty = paragraph_needs_rewrite(rctx, origin.id);
    if !dirty
        && opts.placements.is_none()
        && let Some(bridge_xml) = opts.bridge_xml
        && !item.xml.is_empty()
        && (item.xml == bridge_xml
            || without_bridge_bookmarks(&item.xml) == without_bridge_bookmarks(bridge_xml))
    {
        return Ok((src, false));
    }
    let candidate = paragraph_to_odf(
        rctx,
        &para,
        Some(origin),
        &ParagraphWriteOptions {
            part: PART,
            neighbour: None,
            follows: None,
            placements: opts.placements,
        },
    )?;
    if candidate == src {
        return Ok((src, false));
    }
    if !dirty
        && opts.placements.is_none()
        && para_text(item.para.as_deref()) == origin.text
        && same_paragraph(rctx, origin, &candidate)?
    {
        return Ok((src, false));
    }
    Ok((candidate, true))
}

// ---------------------------------------------------------------------------
// Cell content

/// `OrigItem`
#[derive(Clone)]
enum OrigItem {
    P {
        para: BridgeParagraph,
        unit: usize,
        foreign: bool,
        /// the bridge `w:p` this item lines up with
        bridge_xml: Option<String>,
    },
    T {
        table: usize,
        unit: usize,
        foreign: bool,
        /// the bridge `w:tbl` this item lines up with
        bridge_xml: Option<String>,
    },
    /// the synthetic `w:p` the bridge added
    S,
}

/// `originalItems`: a cell's content as the bridge showed it, in order
/// (matches the bridge `w:tc` items).
fn original_items(
    rctx: &OoxmlToOdfContext,
    cell: &AnchorCellRecord,
    foreign: bool,
) -> Vec<OrigItem> {
    let mut out: Vec<OrigItem> = Vec::new();
    let para = |out: &mut Vec<OrigItem>, id: usize, unit: usize| {
        if let Some(p) = rctx.map.paragraphs.get(id) {
            out.push(OrigItem::P {
                para: p.clone(),
                unit,
                foreign,
                bridge_xml: None,
            });
        }
    };
    for (i, u) in cell.units.iter().enumerate() {
        match u {
            UnitRecord::P { paragraph, .. } => para(&mut out, *paragraph, i),
            UnitRecord::T { table, .. } => out.push(OrigItem::T {
                table: *table,
                unit: i,
                foreign,
                bridge_xml: None,
            }),
            UnitRecord::F {
                paragraph,
                paragraph_first,
                tables,
                ..
            } => {
                if let (Some(p), true) = (paragraph, *paragraph_first) {
                    para(&mut out, *p, i);
                }
                for t in tables {
                    out.push(OrigItem::T {
                        table: *t,
                        unit: i,
                        foreign,
                        bridge_xml: None,
                    });
                }
                if let (Some(p), false) = (paragraph, *paragraph_first) {
                    para(&mut out, *p, i);
                }
            }
        }
    }
    if !foreign && cell.synthetic.is_some() {
        out.push(OrigItem::S);
    }
    out
}

/// `TableOutcome`
#[derive(Clone, Debug)]
pub enum TableOutcome {
    Result(TableResult),
    Deleted,
    Unchanged,
}

/// `ParaOutcome`
#[derive(Clone, Debug)]
pub enum ParaOutcome {
    Unchanged,
    Deleted,
    Changed { xml: String },
}

/// `ContentResult`
#[derive(Clone, Debug)]
pub struct ContentResult {
    /// new inner XML of the cell (between its tags)
    pub inner: String,
    pub changed: bool,
}

/// `writeCellContent`: rewrites the content of `primary` from the edited cell
/// items. `others` are original cells merged into it (their paragraphs follow
/// the primary's and lend their markers). Untouched paragraphs and tables keep
/// their bytes.
pub fn write_cell_content(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    primary: &AnchorCellRecord,
    others: &[&AnchorCellRecord],
    edited: &[EditedItem<'_>],
    bridge: Option<&OxCell>,
    neighbour: Option<&BridgeParagraph>,
) -> Result<ContentResult, OdtError> {
    let xml = xml_of(rctx);
    let mut own = original_items(rctx, primary, false);
    // bridge items line up with the primary's own items
    if let Some(bridge) = bridge
        && bridge.items.len() == own.len()
    {
        for (o, item) in own.iter_mut().zip(&bridge.items) {
            match o {
                OrigItem::P { bridge_xml, .. } | OrigItem::T { bridge_xml, .. } => {
                    *bridge_xml = Some(item.xml.clone());
                }
                OrigItem::S => {}
            }
        }
    }
    let mut origs: Vec<OrigItem> = own
        .into_iter()
        .filter(|o| !matches!(o, OrigItem::S))
        .collect();
    for c in others {
        origs.extend(original_items(rctx, c, true));
    }

    let mut items: Vec<&EditedItem<'_>> = edited.iter().collect();
    if primary.synthetic == Some(Synthetic::Trailing) {
        let n = items.len();
        if n >= 2 {
            let last = items[n - 1];
            if last.kind == OxItemKind::P
                && para_text(last.para.as_deref()).is_empty()
                && items[n - 2].kind == OxItemKind::Tbl
            {
                items.truncate(n - 1);
            }
        }
    } else if primary.synthetic == Some(Synthetic::Empty)
        && others.is_empty()
        && items.len() == 1
        && items[0].kind == OxItemKind::P
        && para_text(items[0].para.as_deref()).is_empty()
    {
        items.clear();
    }

    // indexes into `origs`
    let o_paras: Vec<usize> = (0..origs.len())
        .filter(|&i| matches!(origs[i], OrigItem::P { .. }))
        .collect();
    let o_tables: Vec<usize> = (0..origs.len())
        .filter(|&i| matches!(origs[i], OrigItem::T { foreign: false, .. }))
        .collect();
    // indexes into `items`
    let e_paras: Vec<usize> = (0..items.len())
        .filter(|&i| items[i].kind == OxItemKind::P)
        .collect();
    let e_tables: Vec<usize> = (0..items.len())
        .filter(|&i| items[i].kind == OxItemKind::Tbl)
        .collect();
    let o_para = |k: usize| -> &BridgeParagraph {
        match &origs[o_paras[k]] {
            OrigItem::P { para, .. } => para,
            _ => unreachable!("o_paras holds paragraphs"),
        }
    };
    let e_text = |k: usize| para_text(items[e_paras[k]].para.as_deref());

    // paragraphs: common prefix and suffix by text, then in order
    let mut origin: HashMap<usize, usize> = HashMap::new(); // edited item -> orig index in o_paras
    let mut placements: HashMap<usize, Vec<Placement>> = HashMap::new();
    let mut pre = 0usize;
    while pre < o_paras.len() && pre < e_paras.len() && e_text(pre) == o_para(pre).text {
        origin.insert(e_paras[pre], pre);
        pre += 1;
    }
    let mut suf = 0usize;
    while suf < o_paras.len() - pre
        && suf < e_paras.len() - pre
        && e_text(e_paras.len() - 1 - suf) == o_para(o_paras.len() - 1 - suf).text
    {
        origin.insert(e_paras[e_paras.len() - 1 - suf], o_paras.len() - 1 - suf);
        suf += 1;
    }
    let om: Vec<usize> = (pre..o_paras.len() - suf).collect();
    let em: Vec<usize> = (pre..e_paras.len() - suf).collect();
    for k in 0..om.len().min(em.len()) {
        origin.insert(e_paras[em[k]], om[k]);
    }
    if !om.is_empty() && !em.is_empty() && om.len() != em.len() {
        // split or joined paragraphs: markers follow the text across them
        let texts: Vec<String> = em.iter().map(|&k| e_text(k)).collect();
        let recs: Vec<&BridgeParagraph> = om.iter().map(|&k| o_para(k)).collect();
        let kept = kept_characters(&recs, &texts);
        let mut sources: Vec<&BridgeParagraph> = vec![recs[0]];
        for (n, &p) in recs.iter().enumerate().skip(1) {
            if u16_len(&p.text).0 > 0 && (kept[n] as u64) * 2 >= u64::from(u16_len(&p.text).0) {
                sources.push(p);
            } else if kept[n] > 0
                && p.markers.iter().any(|m| {
                    matches!(
                        m.kind,
                        BridgeMarkerKind::Bookmark
                            | BridgeMarkerKind::BookmarkStart
                            | BridgeMarkerKind::BookmarkEnd
                    )
                })
            {
                rctx.warn(
                    "bookmarks of a deleted cell paragraph were dropped although part of its text survives",
                );
            }
        }
        let placed = place_markers(rctx, &sources, &texts);
        for (k, &e) in em.iter().enumerate() {
            placements.insert(e_paras[e], placed.placements[k].clone());
        }
    }

    // tables: in order
    let mut table_origin: HashMap<usize, usize> = HashMap::new(); // edited item -> index in `origs`
    for (k, &e) in e_tables.iter().enumerate() {
        if let Some(&o) = o_tables.get(k) {
            table_origin.insert(e, o);
        }
    }

    // outcomes per original unit item
    let mut para_outcome: HashMap<usize, ParaOutcome> = HashMap::new(); // by paragraph id
    let mut table_outcome: HashMap<usize, TableOutcome> = HashMap::new(); // by table id
    for &k in &o_paras {
        if let OrigItem::P { para, .. } = &origs[k] {
            para_outcome.insert(para.id, ParaOutcome::Deleted);
        }
    }
    for &k in &o_tables {
        if let OrigItem::T { table, .. } = &origs[k] {
            table_outcome.insert(*table, TableOutcome::Deleted);
        }
    }

    let unit_end = |unit: usize| primary.units[unit].end();
    let mut inserts: Vec<(U16, String)> = Vec::new();
    let first_start = primary
        .units
        .first()
        .map_or(primary.element.open_end, UnitRecord::start);
    let mut insert_at = first_start;
    // a paragraph typed before the first original one takes that one's style
    let mut follows: Option<BridgeParagraph> = neighbour.cloned().or_else(|| {
        o_paras.iter().find_map(|&k| match &origs[k] {
            OrigItem::P {
                para,
                foreign: false,
                ..
            } => Some(para.clone()),
            _ => None,
        })
    });
    let mut changed = false;
    for (ei, e) in items.iter().enumerate() {
        if e.kind == OxItemKind::P {
            let o = origin.get(&ei).map(|&k| &origs[o_paras[k]]);
            let (o_para_ref, o_foreign, o_unit, o_bridge) = match o {
                Some(OrigItem::P {
                    para,
                    foreign,
                    unit,
                    bridge_xml,
                }) => (Some(para), *foreign, *unit, bridge_xml.as_deref()),
                _ => (None, false, 0, None),
            };
            let (xml_out, did_change) = write_paragraph(
                rctx,
                e,
                o_para_ref,
                &WriteParaOptions {
                    follows: follows.as_ref(),
                    placements: placements.get(&ei).map(Vec::as_slice),
                    bridge_xml: o_bridge,
                },
            )?;
            if let (Some(p), false) = (o_para_ref, o_foreign) {
                para_outcome.insert(
                    p.id,
                    if did_change {
                        ParaOutcome::Changed { xml: xml_out }
                    } else {
                        ParaOutcome::Unchanged
                    },
                );
                insert_at = unit_end(o_unit);
            } else {
                inserts.push((insert_at, xml_out));
                changed = true;
            }
            if let Some(p) = o_para_ref {
                follows = Some(p.clone());
            }
            continue;
        }
        let o = table_origin.get(&ei).map(|&k| &origs[k]);
        if let (
            Some(OrigItem::T {
                table,
                unit,
                bridge_xml,
                ..
            }),
            Some(model),
        ) = (o, &e.table)
        {
            let bridge_tbl = bridge_xml.as_deref().map(segment_table);
            let res = write_table(rctx, ext, &ext.tables[*table], model, bridge_tbl.as_ref())?;
            table_outcome.insert(
                *table,
                if res.changed {
                    TableOutcome::Result(res)
                } else {
                    TableOutcome::Unchanged
                },
            );
            insert_at = unit_end(*unit);
        } else if let Some(OrigItem::T { table, unit, .. }) = o {
            table_outcome.insert(*table, TableOutcome::Unchanged);
            insert_at = unit_end(*unit);
        } else if let Some(model) = &e.table {
            inserts.push((insert_at, new_table_odf(rctx, model)?));
            changed = true;
        }
    }

    // replacements per original unit
    let mut patches: Vec<Patch> = Vec::new();
    for u in &primary.units {
        if let Some(r) = unit_replacement(rctx, ext, u, &para_outcome, &table_outcome)? {
            patches.push(Patch {
                start: at(&xml, u.start()),
                end: at(&xml, u.end()),
                xml: r,
            });
        }
    }
    for (insert_at, ins) in inserts {
        let b = at(&xml, insert_at);
        patches.push(Patch {
            start: b,
            end: b,
            xml: ins,
        });
    }
    let inner_source = if primary.element.self_closing {
        String::new()
    } else {
        cut(&xml, primary.element.open_end, primary.element.close_start)
    };
    if patches.is_empty() && !changed {
        return Ok(ContentResult {
            inner: inner_source,
            changed: false,
        });
    }
    let inner = patch_slice(&inner_source, at(&xml, primary.element.open_end), &patches)?;
    let changed = inner != inner_source;
    Ok(ContentResult { inner, changed })
}

/// `unitReplacement`: the new XML of one original content unit, or `None`
/// when it is unchanged.
fn unit_replacement(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    u: &UnitRecord,
    paras: &HashMap<usize, ParaOutcome>,
    tables: &HashMap<usize, TableOutcome>,
) -> Result<Option<String>, OdtError> {
    match u {
        UnitRecord::P { paragraph, .. } => Ok(match paras.get(paragraph) {
            None | Some(ParaOutcome::Unchanged) => None,
            Some(ParaOutcome::Deleted) => Some(String::new()),
            Some(ParaOutcome::Changed { xml }) => Some(xml.clone()),
        }),
        UnitRecord::T { table, .. } => Ok(match tables.get(table) {
            None | Some(TableOutcome::Unchanged) => None,
            Some(TableOutcome::Deleted) => Some(String::new()),
            Some(TableOutcome::Result(o)) => {
                if o.changed {
                    Some(o.xml.clone())
                } else {
                    None
                }
            }
        }),
        UnitRecord::F {
            start,
            end,
            paragraph,
            tables: ids,
            ..
        } => {
            let unchanged = ParaOutcome::Unchanged;
            let para = match paragraph {
                None => &unchanged,
                Some(p) => paras.get(p).unwrap_or(&unchanged),
            };
            let res = write_frame_host(
                rctx,
                ext,
                &FrameHostRange {
                    start: *start,
                    end: *end,
                    paragraph: *paragraph,
                    tables: ids.clone(),
                },
                para,
                tables,
            )?;
            Ok(if res.changed { Some(res.xml) } else { None })
        }
    }
}

// ---------------------------------------------------------------------------
// Frames

/// The `host` argument of `writeFrameHost`.
#[derive(Clone, Debug)]
pub struct FrameHostRange {
    pub start: U16,
    pub end: U16,
    pub paragraph: Option<usize>,
    pub tables: Vec<usize>,
}

/// What one table of a frame host is replaced by.
struct FrameChange<'a> {
    rec: &'a TableRecord,
    outcome: TableOutcome,
    replacement: Option<String>,
}

/// `writeFrameHost`: the paragraph holding framed tables, with each frame's
/// table replaced (or the frame removed when its table was deleted). A changed
/// paragraph text is written by the text layer, which keeps the frames as
/// markers; they are then swapped for the new frames.
pub fn write_frame_host(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    host: &FrameHostRange,
    para: &ParaOutcome,
    tables: &HashMap<usize, TableOutcome>,
) -> Result<FrameHostResult, OdtError> {
    let xml = xml_of(rctx);
    let src = cut(&xml, host.start, host.end);
    let mut frames: Vec<FrameChange<'_>> = Vec::new();
    for &id in &host.tables {
        let rec = &ext.tables[id];
        let outcome = tables.get(&id).cloned().unwrap_or(TableOutcome::Unchanged);
        let mut replacement: Option<String> = None;
        if rec.frame.is_some() {
            match &outcome {
                TableOutcome::Deleted => replacement = Some(String::new()),
                TableOutcome::Result(res) if res.changed => {
                    replacement = Some(frame_xml(rctx, rec, res)?);
                }
                _ => {}
            }
        }
        frames.push(FrameChange {
            rec,
            outcome,
            replacement,
        });
    }
    if host.paragraph.is_none()
        && frames
            .iter()
            .all(|f| matches!(f.outcome, TableOutcome::Deleted))
    {
        return Ok(FrameHostResult {
            xml: String::new(),
            changed: true,
        });
    }
    let by_offsets = |xml: &IndexedText| -> Result<String, OdtError> {
        let patches: Vec<Patch> = frames
            .iter()
            .filter_map(|f| match (&f.replacement, &f.rec.frame) {
                (Some(replacement), Some(frame)) => Some(Patch {
                    start: at(xml, frame.frame.start),
                    end: at(xml, frame.frame.end),
                    xml: replacement.clone(),
                }),
                _ => None,
            })
            .collect();
        patch_slice(&src, at(xml, host.start), &patches)
    };
    let out: String;
    if let ParaOutcome::Changed { xml: changed_xml } = para {
        let mut text = changed_xml.clone();
        let mut cursor = 0usize;
        let mut lost = false;
        for f in &frames {
            let Some(frame) = &f.rec.frame else { continue };
            let original = cut(&xml, frame.frame.start, frame.frame.end);
            let from = cursor.min(text.len());
            let found = text[from..].find(&original).map(|i| from + i);
            let Some(found) = found else {
                lost = true;
                break;
            };
            let replacement = f.replacement.clone().unwrap_or_else(|| original.clone());
            text = format!(
                "{}{}{}",
                &text[..found],
                replacement,
                &text[found + original.len()..]
            );
            cursor = found + replacement.len();
        }
        if lost {
            rctx.warn(
                "a paragraph holding a table could not keep its text edit; its text was kept",
            );
            out = by_offsets(&xml)?;
        } else {
            out = text;
        }
    } else {
        if matches!(para, ParaOutcome::Deleted) {
            rctx.warn("the text beside a framed table cannot be deleted on its own; it was kept");
        }
        out = by_offsets(&xml)?;
    }
    let changed = out != src;
    Ok(FrameHostResult { xml: out, changed })
}

/// What `writeFrameHost` returns.
#[derive(Clone, Debug)]
pub struct FrameHostResult {
    pub xml: String,
    pub changed: bool,
}

/// `cm`
fn cm(value: f64) -> String {
    format!("{}cm", to_fixed(math_max(0.0, value), 3))
}

/// `frameXml`: the frame element around a rewritten table, its size
/// following the table.
fn frame_xml(
    rctx: &mut OoxmlToOdfContext,
    rec: &TableRecord,
    res: &TableResult,
) -> Result<String, OdtError> {
    let xml = xml_of(rctx);
    let frame_rec = rec.frame.as_ref().expect("a frame table has its frame");
    let frame = &frame_rec.frame;
    let mut tag = cut(&xml, frame.start, frame.open_end);
    let dh = res.height_delta_cm;
    let dw = (res.width_delta_twips * 2.54) / 1440.0;
    if dh.abs() > 0.0005 || dw.abs() > 0.0005 {
        let prefixes = prefixes_of(rctx);
        let attrs = |name: &str| -> Option<String> {
            let found = match name {
                "svg:height" => js_regex!(r#"\ssvg:height="([^"]*)""#).exec(&tag),
                "fo:min-height" => js_regex!(r#"\sfo:min-height="([^"]*)""#).exec(&tag),
                "svg:width" => js_regex!(r#"\ssvg:width="([^"]*)""#).exec(&tag),
                _ => js_regex!(r#"\sfo:min-width="([^"]*)""#).exec(&tag),
            };
            found.and_then(|m| m.get(1)).map(str::to_string)
        };
        let mut over = AttrOverrides::new();
        let mut grow = |name: &str, delta: f64| {
            let v = length_cm(attrs(name).as_deref());
            if let Some(v) = v
                && delta.abs() > 0.0005
            {
                over.set(name, Some(cm(v + delta)));
            }
        };
        grow("svg:height", dh);
        grow("fo:min-height", dh);
        grow("svg:width", dw);
        grow("fo:min-width", dw);
        let style_name = frame_rec.style.as_deref();
        let style = style_name.and_then(|n| {
            rctx.doc
                .styles
                .find(n, "graphic", crate::core::styles::OdtStyleScope::Content)
        });
        if let Some(style) = style.filter(|s| s.automatic && s.part == PART) {
            let empty = JsObject::new();
            let gp = style
                .properties
                .get("style:graphic-properties")
                .unwrap_or(&empty);
            let mut props = AttrOverrides::new();
            let h = length_cm(gp.get("fo:min-height").map(String::as_str));
            let w = length_cm(gp.get("fo:min-width").map(String::as_str));
            if let Some(h) = h
                && dh.abs() > 0.0005
            {
                props.set("fo:min-height", Some(cm(h + dh)));
            }
            if let Some(w) = w
                && dw.abs() > 0.0005
            {
                props.set("fo:min-width", Some(cm(w + dw)));
            }
            let sh = length_cm(gp.get("svg:height").map(String::as_str));
            if let Some(sh) = sh
                && dh.abs() > 0.0005
            {
                props.set("svg:height", Some(cm(sh + dh)));
            }
            if !props.is_empty() {
                let style_src = xml.text[style.start..style.end].to_string();
                let key = key_of(json!(["frame", style.name, props]));
                let name = derive(rctx, &key, &style.name, |n| {
                    let mut attrs = AttrOverrides::new();
                    attrs.set("style:display-name", None);
                    let mut edit_props = JsObject::new();
                    edit_props.set("style:graphic-properties", props.clone());
                    edit_style_xml(
                        &style_src,
                        &prefixes,
                        &StyleXmlEdit {
                            name: Some(n.to_string()),
                            attrs: Some(attrs),
                            props: Some(edit_props),
                            ..StyleXmlEdit::default()
                        },
                    )
                })?;
                over.set("draw:style-name", Some(name));
            }
        }
        if !over.is_empty() {
            tag = patch_start_tag(&tag, &prefixes, &over)?;
        }
    }
    Ok(format!(
        "{}{}{}{}",
        tag,
        cut(&xml, frame.open_end, rec.element.start),
        res.xml,
        cut(&xml, rec.element.end, frame.end)
    ))
}

// ---------------------------------------------------------------------------
// Cell formatting

/// `normStyle`
fn norm_style(b: Option<&CellBorder>) -> String {
    match b {
        Some(b) if b.style != "none" && b.style != "nil" => format!(
            "{}|{}|{}",
            b.style,
            number_to_string(b.sz_eighths.map_or(4.0, |n| n.0)),
            b.color.as_deref().unwrap_or("auto").to_uppercase()
        ),
        _ => "none".to_string(),
    }
}

/// `OOXML_TO_ODF_BORDER`
fn ooxml_to_odf_border(style: &str) -> Option<&'static str> {
    Some(match style {
        "single" => "solid",
        "thick" => "solid",
        "double" => "double",
        "dotted" => "dotted",
        "dashed" => "dashed",
        "dotDash" => "dash-dot",
        "dotDotDash" => "dash-dot-dot",
        "threeDEngrave" => "groove",
        "threeDEmboss" => "ridge",
        "inset" => "inset",
        "outset" => "outset",
        "dashSmallGap" => "fine-dashed",
        "wave" => "wave",
        _ => return None,
    })
}

/// `borderToOdf`: an engine border as an ODF border value.
pub fn border_to_odf(b: Option<&CellBorder>) -> String {
    let Some(b) = b else {
        return "none".to_string();
    };
    if b.style == "none" || b.style == "nil" {
        return "none".to_string();
    }
    let style = ooxml_to_odf_border(&b.style).unwrap_or("solid");
    let pt = (b.sz_eighths.map_or(4.0, |n| n.0) / 8.0) * if style == "double" { 3.0 } else { 1.0 };
    let color = match &b.color {
        Some(c) if js_regex!(r"^[0-9a-fA-F]{6}$").test(c) => format!("#{}", c.to_lowercase()),
        _ => "#000000".to_string(),
    };
    format!("{}cm {} {}", to_fixed((pt * 2.54) / 72.0, 3), style, color)
}

/// `eb[side]`
fn side_of<'a>(b: &'a CellBorders, side: &str) -> Option<&'a CellBorder> {
    match side {
        "top" => b.top.as_ref(),
        "left" => b.left.as_ref(),
        "bottom" => b.bottom.as_ref(),
        "right" => b.right.as_ref(),
        "tl2br" => b.tl2br.as_ref(),
        _ => b.tr2bl.as_ref(),
    }
}

/// `cellOverrides`: ODF cell-style overrides for what the editor changed
/// against the bridge's mapped props.
fn cell_overrides(
    original: &CellProps,
    cell: &TableCell,
    style_attrs: &JsObject<String>,
) -> AttrOverrides {
    let mut over = AttrOverrides::new();
    let fill = cell.fill.as_ref().map(|f| f.to_uppercase());
    if fill.as_deref().unwrap_or("") != original.fill.as_deref().unwrap_or("") {
        over.set(
            "fo:background-color",
            Some(match fill.as_deref() {
                Some(f) if !f.is_empty() => format!("#{}", f.to_lowercase()),
                _ => "transparent".to_string(),
            }),
        );
    }
    let va = match cell.v_align.as_ref().map(|v| v.as_str()) {
        Some("center") => Some(CellVAlign::Center),
        Some("bottom") => Some(CellVAlign::Bottom),
        _ => None,
    };
    if va != original.v_align {
        over.set(
            "style:vertical-align",
            Some(
                match va {
                    Some(CellVAlign::Center) => "middle",
                    Some(CellVAlign::Bottom) => "bottom",
                    None => "top",
                }
                .to_string(),
            ),
        );
    }
    let default_borders = CellBorders::default();
    let ob = original.borders.as_ref().unwrap_or(&default_borders);
    // undefined borders on the edited side: the editor did not model them (kept as they were)
    if let Some(eb) = cell.borders.as_ref() {
        let sides = ["top", "left", "bottom", "right"];
        if sides
            .iter()
            .any(|s| norm_style(side_of(eb, s)) != norm_style(side_of(ob, s)))
        {
            let all = style_attrs.get("fo:border");
            for s in sides {
                let value = match side_of(eb, s) {
                    Some(b) => border_to_odf(Some(b)),
                    None => style_attrs
                        .get(&format!("fo:border-{s}"))
                        .or(all)
                        .cloned()
                        .unwrap_or_else(|| "none".to_string()),
                };
                over.set(format!("fo:border-{s}"), Some(value));
            }
            if all.is_some() {
                over.set("fo:border", None);
            }
        }
        if norm_style(side_of(eb, "tl2br")) != norm_style(side_of(ob, "tl2br")) {
            over.set(
                "style:diagonal-tl-br",
                Some(border_to_odf(side_of(eb, "tl2br"))),
            );
        }
        if norm_style(side_of(eb, "tr2bl")) != norm_style(side_of(ob, "tr2bl")) {
            over.set(
                "style:diagonal-bl-tr",
                Some(border_to_odf(side_of(eb, "tr2bl"))),
            );
        }
    }
    over
}

/// A style element looked up as a reference from content.xml sees it, when it
/// is an automatic style of content.xml.
fn auto_style(
    rctx: &OoxmlToOdfContext,
    base: Option<&str>,
    family: &str,
) -> (
    Option<Rc<crate::core::styles::OdtStyle>>,
    Option<Rc<crate::core::styles::OdtStyle>>,
) {
    let style = base.and_then(|b| {
        rctx.doc
            .styles
            .find(b, family, crate::core::styles::OdtStyleScope::Content)
    });
    let auto = style.clone().filter(|s| s.automatic && s.part == PART);
    (style, auto)
}

/// `derivedCellStyle`: a cell style deriving from `base` with `over` applied
/// (a new automatic style).
fn derived_cell_style(
    rctx: &mut OoxmlToOdfContext,
    base: Option<&str>,
    over: &AttrOverrides,
) -> Result<String, OdtError> {
    let xml = xml_of(rctx);
    let prefixes = prefixes_of(rctx);
    let (style, auto) = auto_style(rctx, base, "table-cell");
    let key = key_of(json!(["cell", base, over]));
    derive(rctx, &key, base.unwrap_or("Cell"), |name| {
        let mut edit_props = JsObject::new();
        edit_props.set("style:table-cell-properties", over.clone());
        match &auto {
            Some(auto) => {
                let mut attrs = AttrOverrides::new();
                attrs.set("style:display-name", None);
                edit_style_xml(
                    &xml.text[auto.start..auto.end],
                    &prefixes,
                    &StyleXmlEdit {
                        name: Some(name.to_string()),
                        attrs: Some(attrs),
                        props: Some(edit_props),
                        ..StyleXmlEdit::default()
                    },
                )
            }
            None => edit_style_xml(
                &new_style_xml(name, "table-cell", style.as_ref().map(|s| s.name.as_str())),
                &prefixes,
                &StyleXmlEdit {
                    props: Some(edit_props),
                    ..StyleXmlEdit::default()
                },
            ),
        }
    })
}

// ---------------------------------------------------------------------------
// Cells

/// `CellOutcome`
struct CellOutcome {
    xml: String,
    #[allow(dead_code)]
    changed: bool,
    #[allow(dead_code)]
    content_changed: bool,
}

/// `writeCellElement`: writes one anchor cell: original bytes when untouched,
/// else the patched tag and content.
#[allow(clippy::too_many_arguments)]
fn write_cell_element(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    src: &AnchorCellRecord,
    others: &[&AnchorCellRecord],
    a: &EditedAnchor<'_>,
    bridge: Option<&OxCell>,
    spans: Option<Span>,
    neighbour: Option<&BridgeParagraph>,
) -> Result<CellOutcome, OdtError> {
    let xml = xml_of(rctx);
    let original = cut(&xml, src.element.start, src.element.end);
    let content = write_cell_content(
        rctx,
        ext,
        src,
        others,
        &cell_items(a.cell, a.ox),
        bridge,
        neighbour,
    )?;
    let mut over = AttrOverrides::new();
    let same_tc_pr = match (bridge, a.ox) {
        (Some(bridge), Some(ox)) => normalized_tc_pr(&ox.tc_pr) == normalized_tc_pr(&bridge.tc_pr),
        _ => false,
    };
    if !same_tc_pr {
        let attrs = style_props(
            &rctx.doc,
            src.style.as_deref(),
            "table-cell",
            "style:table-cell-properties",
        );
        let props = cell_overrides(&props_of(rctx, src), a.cell, &attrs);
        if !props.is_empty() {
            over.set(
                "table:style-name",
                Some(derived_cell_style(rctx, src.style.as_deref(), &props)?),
            );
        }
    }
    if let Some(spans) = spans {
        let own = span_of(&CellRecord::Cell(src.clone()));
        if spans.col_span != own.col_span {
            over.set(
                "table:number-columns-spanned",
                if spans.col_span > 1 {
                    Some(spans.col_span.to_string())
                } else {
                    None
                },
            );
        }
        if spans.row_span != own.row_span {
            over.set(
                "table:number-rows-spanned",
                if spans.row_span > 1 {
                    Some(spans.row_span.to_string())
                } else {
                    None
                },
            );
        }
    }
    if !content.changed && over.is_empty() {
        return Ok(CellOutcome {
            xml: original,
            changed: false,
            content_changed: false,
        });
    }
    let mut tag = cut(&xml, src.element.start, src.element.open_end);
    if !over.is_empty() {
        tag = patch_start_tag(&tag, &prefixes_of(rctx), &over)?;
    }
    let out = if src.element.self_closing {
        if content.inner.is_empty() {
            tag
        } else {
            format!("{}{}</{}>", open_tag(&tag), content.inner, tag_name(&tag))
        }
    } else {
        format!(
            "{}{}{}",
            tag,
            content.inner,
            cut(&xml, src.element.close_start, src.element.end)
        )
    };
    let changed = out != original;
    Ok(CellOutcome {
        xml: out,
        changed,
        content_changed: content.changed,
    })
}

/// `firstParagraph`: the first paragraph record of a cell, or `None`.
fn first_paragraph(
    rctx: &OoxmlToOdfContext,
    cell: Option<&AnchorCellRecord>,
) -> Option<BridgeParagraph> {
    for u in cell.map_or(&[][..], |c| c.units.as_slice()) {
        if let Some(id) = u.paragraph_id()
            && let Some(p) = rctx.map.paragraphs.get(id)
        {
            return Some(p.clone());
        }
    }
    None
}

/// `newCellFromTemplate`: a new cell copying `template`'s tag (style, value
/// type) without its lock and spans.
fn new_cell_from_template(
    rctx: &mut OoxmlToOdfContext,
    template: Option<&AnchorCellRecord>,
    a: &EditedAnchor<'_>,
) -> Result<String, OdtError> {
    let xml = xml_of(rctx);
    let prefixes = prefixes_of(rctx);
    let mut tag = match template {
        Some(t) if t.element.start.0 < u32::MAX => {
            open_tag(&cut(&xml, t.element.start, t.element.open_end))
        }
        _ => "<table:table-cell office:value-type=\"string\">".to_string(),
    };
    let mut over = AttrOverrides::new();
    over.set(
        "table:number-columns-spanned",
        if a.col_span > 1 {
            Some(a.col_span.to_string())
        } else {
            None
        },
    );
    over.set(
        "table:number-rows-spanned",
        if a.row_span > 1 {
            Some(a.row_span.to_string())
        } else {
            None
        },
    );
    over.set("table:protected", None);
    if let Some(template) = template {
        let attrs = style_props(
            &rctx.doc,
            template.style.as_deref(),
            "table-cell",
            "style:table-cell-properties",
        );
        let props = cell_overrides(&props_of(rctx, template), a.cell, &attrs);
        if !props.is_empty() {
            over.set(
                "table:style-name",
                Some(derived_cell_style(rctx, template.style.as_deref(), &props)?),
            );
        }
    }
    tag = patch_start_tag(&tag, &prefixes, &over)?;
    let follows = first_paragraph(rctx, template);
    let mut inner = String::new();
    for item in cell_items(a.cell, a.ox) {
        if item.kind == OxItemKind::P {
            inner.push_str(
                &write_paragraph(
                    rctx,
                    &item,
                    None,
                    &WriteParaOptions {
                        follows: follows.as_ref(),
                        placements: None,
                        bridge_xml: None,
                    },
                )?
                .0,
            );
        } else if let Some(table) = &item.table {
            inner.push_str(&new_table_odf(rctx, table)?);
        }
    }
    Ok(format!("{tag}{inner}</{}>", tag_name(&tag)))
}

// ---------------------------------------------------------------------------
// Tables

/// `isAnchor`: cell records whose anchor is their own position (cells,
/// unexplained covered cells, gaps).
fn is_anchor(cell: &CellRecord) -> bool {
    !matches!(cell, CellRecord::Covered(_))
}

/// `propsOf`: the cell look the bridge mapped for a cell (recomputed from its
/// ODF style).
fn props_of(rctx: &OoxmlToOdfContext, cell: &AnchorCellRecord) -> CellProps {
    cell_props_from_odf(&style_props(
        &rctx.doc,
        cell.style.as_deref(),
        "table-cell",
        "style:table-cell-properties",
    ))
    .props
}

/// `sameGrid`
fn same_grid(rec: &TableRecord, g: &EditedGrid<'_>) -> bool {
    if g.rows != rec.rows.len() || g.cols != rec.columns.len() {
        return false;
    }
    for r in 0..g.rows {
        for c in 0..g.cols {
            let cell = rec.cells.get(r).and_then(|row| row.get(c));
            let a = g.anchor_at(r, c);
            let (Some(cell), Some(a)) = (cell, a) else {
                return false;
            };
            let (ar, ac) = anchor_of(cell, r, c);
            if a.row != ar || a.col != ac {
                return false;
            }
            let span = span_of(cell);
            if is_anchor(cell) && (a.col_span != span.col_span || a.row_span != span.row_span) {
                return false;
            }
        }
    }
    true
}

/// `unchangedResult`
fn unchanged_result(rctx: &OoxmlToOdfContext, rec: &TableRecord) -> TableResult {
    let xml = xml_of(rctx);
    TableResult {
        xml: cut(&xml, rec.element.start, rec.element.end),
        changed: false,
        height_delta_cm: 0.0,
        width_delta_twips: 0.0,
    }
}

/// `writeTable`: writes an edited table over its original. `bridge` is the
/// bridge `w:tbl` of this table (segmented), or `None` when it cannot be
/// located.
pub fn write_table(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    rec: &TableRecord,
    edited: &EditedTable<'_>,
    bridge: Option<&OxTable>,
) -> Result<TableResult, OdtError> {
    if let Some(bridge) = bridge
        && !edited.ox.xml.is_empty()
        && edited.ox.xml == bridge.xml
        && !table_needs_rewrite(rctx, ext, rec)
    {
        return Ok(unchanged_result(rctx, rec));
    }
    let grid = edited_grid(edited.model, &edited.ox);
    if same_grid(rec, &grid) {
        return patch_table(rctx, ext, rec, &grid, bridge);
    }
    if let Some(why) = &rec.structure_locked {
        rctx.warn(&format!(
            "a table whose structure cannot be rewritten ({why}) was kept"
        ));
        return Ok(unchanged_result(rctx, rec));
    }
    rebuild_table(rctx, ext, rec, &grid, edited, bridge)
}

/// `cellNeedsRewrite`: a note in one of the cell's paragraphs (or nested
/// tables) changed: the cell must be rewritten.
fn cell_needs_rewrite(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    cell: &AnchorCellRecord,
) -> bool {
    for o in original_items(rctx, cell, false) {
        let needs = match o {
            OrigItem::P { para, .. } => paragraph_needs_rewrite(rctx, para.id),
            OrigItem::T { table, .. } => table_needs_rewrite(rctx, ext, &ext.tables[table]),
            OrigItem::S => false,
        };
        if needs {
            return true;
        }
    }
    false
}

/// `tableNeedsRewrite`
fn table_needs_rewrite(rctx: &mut OoxmlToOdfContext, ext: &TableExt, rec: &TableRecord) -> bool {
    for row in &rec.cells {
        for cell in row {
            if let CellRecord::Cell(cell) = cell
                && cell_needs_rewrite(rctx, ext, cell)
            {
                return true;
            }
        }
    }
    false
}

/// `LOCKED_WARNING`
const LOCKED_WARNING: &str = "a locked table cell (Hancom cell protection) was not changed";

/// `modelTexts`: paragraph texts of a table model in reading order (empty
/// ones skipped).
fn model_texts(model: &TableModel) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for row in &model.rows {
        for cell in row {
            if *cell.v_merge == Some(docx_engine::model::TableCellVMerge::Continue)
                || cell.grid_gap.unwrap_or(false)
            {
                continue;
            }
            for p in cell.rich_paras.as_deref().unwrap_or(&[]) {
                let t = para_text(Some(p));
                if !t.is_empty() {
                    out.push(t);
                }
            }
            for t in cell.nested_tables.as_deref().unwrap_or(&[]) {
                out.extend(model_texts(t));
            }
        }
    }
    out
}

/// `recordTexts`: paragraph texts of an original table in reading order
/// (empty ones skipped).
fn record_texts(rctx: &OoxmlToOdfContext, ext: &TableExt, rec: &TableRecord) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for row in &rec.cells {
        for cell in row {
            if let CellRecord::Cell(cell) = cell {
                out.extend(cell_texts(rctx, ext, cell));
            }
        }
    }
    out
}

/// `cellTexts`
fn cell_texts(rctx: &OoxmlToOdfContext, ext: &TableExt, cell: &AnchorCellRecord) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for o in original_items(rctx, cell, false) {
        match o {
            OrigItem::P { para, .. } if !para.text.is_empty() => out.push(para.text.clone()),
            OrigItem::T { table, .. } => out.extend(record_texts(rctx, ext, &ext.tables[table])),
            _ => {}
        }
    }
    out
}

/// `lockedCellTouched`: whether the editor changed a locked cell (its text,
/// its tables or its look) - only to report it; a locked cell is never
/// written.
fn locked_cell_touched(
    rctx: &OoxmlToOdfContext,
    ext: &TableExt,
    cell: &AnchorCellRecord,
    a: &EditedAnchor<'_>,
) -> bool {
    let mut edited: Vec<String> = Vec::new();
    for item in cell_items(a.cell, a.ox) {
        if item.kind == OxItemKind::P {
            let t = para_text(item.para.as_deref());
            if !t.is_empty() {
                edited.push(t);
            }
        } else if let Some(table) = &item.table {
            edited.extend(model_texts(table.model));
        }
    }
    if edited.join("\u{1}") != cell_texts(rctx, ext, cell).join("\u{1}") {
        return true;
    }
    let attrs = style_props(
        &rctx.doc,
        cell.style.as_deref(),
        "table-cell",
        "style:table-cell-properties",
    );
    !cell_overrides(&props_of(rctx, cell), a.cell, &attrs).is_empty()
}

/// `bridgeCell`: the bridge `w:tc` of an original anchor cell.
fn bridge_cell(bridge: Option<&OxTable>, r: usize, tc: Option<usize>) -> Option<&OxCell> {
    match (bridge, tc) {
        (Some(bridge), Some(tc)) => bridge.rows.get(r).and_then(|row| row.cells.get(tc)),
        _ => None,
    }
}

/// `patchTable`: same grid: only edited cells (and changed column widths) are
/// patched in place.
fn patch_table(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    rec: &TableRecord,
    grid: &EditedGrid<'_>,
    bridge: Option<&OxTable>,
) -> Result<TableResult, OdtError> {
    let xml = xml_of(rctx);
    let mut patches: Vec<Patch> = Vec::new();
    for (r, row) in rec.cells.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            if !is_anchor(cell) {
                continue;
            }
            let Some(a) = grid.anchor_at(r, c) else {
                continue;
            };
            let b = bridge_cell(bridge, r, cell.tc());
            if let (Some(ox), Some(b)) = (a.ox, b)
                && ox.xml == b.xml
            {
                let needs = match cell {
                    CellRecord::Cell(cell) => cell_needs_rewrite(rctx, ext, cell),
                    _ => false,
                };
                if !needs {
                    continue;
                }
            }
            let CellRecord::Cell(cell_rec) = cell else {
                if cell_items(a.cell, a.ox)
                    .iter()
                    .any(|i| i.kind == OxItemKind::Tbl || !para_text(i.para.as_deref()).is_empty())
                {
                    rctx.warn("text typed into a merged-away or missing table cell was not saved");
                }
                continue;
            };
            if cell_rec.protected {
                // never written (the writers would already register new styles)
                if locked_cell_touched(rctx, ext, cell_rec, a) {
                    rctx.warn(LOCKED_WARNING);
                }
                continue;
            }
            let res = write_cell_element(rctx, ext, cell_rec, &[], a, b, None, None)?;
            if res.changed {
                patches.push(Patch {
                    start: at(&xml, cell_rec.element.start),
                    end: at(&xml, cell_rec.element.end),
                    xml: res.xml,
                });
            }
        }
    }
    let widths = column_patches(rctx, rec, &grid.widths)?;
    patches.extend(widths.patches);
    let original = cut(&xml, rec.element.start, rec.element.end);
    let out = if patches.is_empty() {
        original.clone()
    } else {
        patch_slice(&original, at(&xml, rec.element.start), &patches)?
    };
    Ok(TableResult {
        changed: out != original,
        xml: out,
        height_delta_cm: 0.0,
        width_delta_twips: widths.delta_twips,
    })
}

/// What `columnPatches` returns.
struct ColumnPatches {
    patches: Vec<Patch>,
    delta_twips: f64,
}

/// `columnPatches`: width changes of columns that keep their place: their
/// start tags and the table's.
fn column_patches(
    rctx: &mut OoxmlToOdfContext,
    rec: &TableRecord,
    widths: &[f64],
) -> Result<ColumnPatches, OdtError> {
    let mut patches: Vec<Patch> = Vec::new();
    if widths.len() != rec.columns.len() {
        return Ok(ColumnPatches {
            patches,
            delta_twips: 0.0,
        });
    }
    let mut delta = 0.0f64;
    let changed_at: Vec<usize> = rec
        .columns
        .iter()
        .enumerate()
        .filter(|(i, col)| (widths[*i] - col.width_twips.0).abs() > 2.0)
        .map(|(i, _)| i)
        .collect();
    if changed_at.is_empty() {
        return Ok(ColumnPatches {
            patches,
            delta_twips: 0.0,
        });
    }
    let xml = xml_of(rctx);
    let prefixes = prefixes_of(rctx);
    let mut done: Vec<usize> = Vec::new();
    for (i, col) in rec.columns.iter().enumerate() {
        let (Some(start), Some(open_end)) = (col.element.start.0, col.element.open_end.0) else {
            continue;
        };
        if !changed_at.contains(&i) || done.contains(&at(&xml, start)) {
            continue;
        }
        if col.repeated {
            rctx.warn("a width change of a repeated table column was not saved");
            continue;
        }
        done.push(at(&xml, start));
        let name = derived_column_style(rctx, col.style.as_deref(), widths[i])?;
        let mut over = AttrOverrides::new();
        over.set("table:style-name", Some(name));
        patches.push(Patch {
            start: at(&xml, start),
            end: at(&xml, open_end),
            xml: patch_start_tag(&cut(&xml, start, open_end), &prefixes, &over)?,
        });
        delta += widths[i] - col.width_twips.0;
    }
    if delta != 0.0
        && !delta.is_nan()
        && let Some(table_tag) = table_start_tag(rctx, rec, delta)?
    {
        patches.push(Patch {
            start: at(&xml, rec.element.start),
            end: at(&xml, rec.element.open_end),
            xml: table_tag,
        });
    }
    Ok(ColumnPatches {
        patches,
        delta_twips: delta,
    })
}

/// `derivedColumnStyle`
fn derived_column_style(
    rctx: &mut OoxmlToOdfContext,
    base: Option<&str>,
    width: f64,
) -> Result<String, OdtError> {
    let xml = xml_of(rctx);
    let prefixes = prefixes_of(rctx);
    let (style, auto) = auto_style(rctx, base, "table-column");
    let mut props = AttrOverrides::new();
    props.set("style:column-width", Some(twips_to_cm(width)));
    let key = key_of(json!(["column", base, width]));
    derive(rctx, &key, base.unwrap_or("Column"), |name| {
        let mut edit_props = JsObject::new();
        edit_props.set("style:table-column-properties", props);
        match &auto {
            Some(auto) => {
                let mut attrs = AttrOverrides::new();
                attrs.set("style:display-name", None);
                edit_style_xml(
                    &xml.text[auto.start..auto.end],
                    &prefixes,
                    &StyleXmlEdit {
                        name: Some(name.to_string()),
                        attrs: Some(attrs),
                        props: Some(edit_props),
                        ..StyleXmlEdit::default()
                    },
                )
            }
            None => edit_style_xml(
                &new_style_xml(
                    name,
                    "table-column",
                    style.as_ref().map(|s| s.name.as_str()),
                ),
                &prefixes,
                &StyleXmlEdit {
                    props: Some(edit_props),
                    ..StyleXmlEdit::default()
                },
            ),
        }
    })
}

/// `tableStartTag`: the table's start tag with a derived style whose width
/// grew by `delta_twips`, or `None` when the table style sets no width.
fn table_start_tag(
    rctx: &mut OoxmlToOdfContext,
    rec: &TableRecord,
    delta_twips: f64,
) -> Result<Option<String>, OdtError> {
    let xml = xml_of(rctx);
    let prefixes = prefixes_of(rctx);
    let tag = cut(&xml, rec.element.start, rec.element.open_end);
    let name = js_regex!(r#"\btable:style-name="([^"]*)""#)
        .exec(&tag)
        .and_then(|m| m.get(1))
        .map(str::to_string);
    let style = name.and_then(|n| {
        rctx.doc.styles.find(
            &decode_xml_entities(&n),
            "table",
            crate::core::styles::OdtStyleScope::Content,
        )
    });
    let Some(style) = style.filter(|s| s.automatic && s.part == PART) else {
        return Ok(None);
    };
    let current = length_to_twips(
        style
            .properties
            .get("style:table-properties")
            .and_then(|p| p.get("style:width"))
            .map(String::as_str),
    );
    let Some(current) = current else {
        return Ok(None);
    };
    let width = math_max(1.0, jscompat::math_round(current + delta_twips));
    let key = key_of(json!(["table", style.name, width]));
    let derived = derive(rctx, &key, &style.name, |n| {
        let mut attrs = AttrOverrides::new();
        attrs.set("style:display-name", None);
        let mut width_props = AttrOverrides::new();
        width_props.set("style:width", Some(twips_to_cm(width)));
        let mut edit_props = JsObject::new();
        edit_props.set("style:table-properties", width_props);
        edit_style_xml(
            &xml.text[style.start..style.end],
            &prefixes,
            &StyleXmlEdit {
                name: Some(n.to_string()),
                attrs: Some(attrs),
                props: Some(edit_props),
                ..StyleXmlEdit::default()
            },
        )
    })?;
    let mut over = AttrOverrides::new();
    over.set("table:style-name", Some(derived));
    Ok(Some(patch_start_tag(&tag, &prefixes, &over)?))
}

/// `nearest`: the original index nearest to edited position `at` that maps
/// somewhere (earlier first), or -1.
fn nearest(map: &[i64], at: usize) -> i64 {
    let mut k = at as i64;
    while k >= 0 {
        if (k as usize) < map.len() && map[k as usize] >= 0 {
            return map[k as usize];
        }
        k -= 1;
    }
    for &v in map.iter().skip(at + 1) {
        if v >= 0 {
            return v;
        }
    }
    -1
}

// ---------------------------------------------------------------------------
// Rebuilding a table whose grid changed

/// `mapSequence`: maps edited positions to original ones: equal signatures in
/// order (LCS), then gaps in order. -1 where an edited position maps nowhere.
pub fn map_sequence(original: &[String], edited: &[String]) -> Vec<i64> {
    let n = original.len();
    let m = edited.len();
    let mut out = vec![-1i64; m];
    if n * m > 4_000_000 {
        for (k, slot) in out.iter_mut().enumerate().take(n.min(m)) {
            *slot = k as i64;
        }
        return out;
    }
    let width = m + 1;
    let mut dp = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * width + j] = if original[i] == edited[j] {
                dp[(i + 1) * width + j + 1] + 1
            } else {
                dp[(i + 1) * width + j].max(dp[i * width + j + 1])
            };
        }
    }
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0usize;
    let mut j = 0usize;
    while i < n && j < m {
        if original[i] == edited[j] {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * width + j] >= dp[i * width + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    // gaps between matches pair up in order
    let mut pi = 0usize;
    let mut pj = 0usize;
    pairs.push((n, m));
    for (a, b) in pairs {
        for k in 0..(a - pi).min(b - pj) {
            out[pj + k] = (pi + k) as i64;
        }
        if a < n {
            out[b] = a as i64;
        }
        pi = a + 1;
        pj = b + 1;
    }
    out
}

/// `originalCellText`
fn original_cell_text(rctx: &OoxmlToOdfContext, cell: &CellRecord) -> String {
    let CellRecord::Cell(cell) = cell else {
        return String::new();
    };
    let mut texts: Vec<String> = Vec::new();
    for u in &cell.units {
        if let Some(id) = u.paragraph_id() {
            texts.push(
                rctx.map
                    .paragraphs
                    .get(id)
                    .map_or_else(String::new, |p| p.text.clone()),
            );
        }
    }
    texts.join("\u{2}")
}

/// `editedCellText`
fn edited_cell_text(a: &EditedAnchor<'_>) -> String {
    cell_items(a.cell, a.ox)
        .iter()
        .filter(|i| i.kind == OxItemKind::P)
        .map(|i| para_text(i.para.as_deref()))
        .collect::<Vec<_>>()
        .join("\u{2}")
}

/// `rebuildTable`
fn rebuild_table(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    rec: &TableRecord,
    grid: &EditedGrid<'_>,
    edited: &EditedTable<'_>,
    bridge: Option<&OxTable>,
) -> Result<TableResult, OdtError> {
    let xml = xml_of(rctx);
    let r_count = rec.rows.len();
    let c_count = rec.columns.len();
    // Blank columns must not break row matching when rows also changed. Column
    // alignment below still uses the complete grid over those matched rows.
    let both_axes_changed = grid.rows != r_count && grid.cols != c_count;
    let row_signature = |texts: Vec<String>| -> String {
        if both_axes_changed {
            texts
                .into_iter()
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\u{1}")
        } else {
            texts.join("\u{1}")
        }
    };
    // rows by content
    let orig_row_sig: Vec<String> = rec
        .cells
        .iter()
        .map(|row| {
            row_signature(
                row.iter()
                    .map(|cell| original_cell_text(rctx, cell))
                    .collect(),
            )
        })
        .collect();
    let edit_row_sig: Vec<String> = (0..grid.at.len())
        .map(|r| {
            row_signature(
                (0..grid.at[r].len())
                    .map(|c| match grid.anchor_at(r, c) {
                        Some(a) if a.row == r && a.col == c => edited_cell_text(a),
                        _ => String::new(),
                    })
                    .collect(),
            )
        })
        .collect();
    let row_map: Vec<i64> = if grid.rows == r_count {
        (0..r_count as i64).collect()
    } else {
        map_sequence(&orig_row_sig, &edit_row_sig)
    };
    // columns by content over the matched rows
    let col_map: Vec<i64> = if grid.cols == c_count {
        (0..c_count as i64).collect()
    } else {
        let pairs: Vec<(usize, usize)> = row_map
            .iter()
            .enumerate()
            .filter(|(_, o)| **o >= 0)
            .map(|(e, o)| (*o as usize, e))
            .collect();
        let orig_col_sig: Vec<String> = (0..c_count)
            .map(|c| {
                pairs
                    .iter()
                    .map(|(o, _)| original_cell_text(rctx, &rec.cells[*o][c]))
                    .collect::<Vec<_>>()
                    .join("\u{1}")
            })
            .collect();
        let edit_col_sig: Vec<String> = (0..grid.cols)
            .map(|c| {
                pairs
                    .iter()
                    .map(|(_, e)| match grid.anchor_at(*e, c) {
                        Some(a) if a.row == *e && a.col == c => edited_cell_text(a),
                        _ => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("\u{1}")
            })
            .collect();
        map_sequence(&orig_col_sig, &edit_col_sig)
    };
    let mut row_back: HashMap<usize, usize> = HashMap::new();
    for (e, o) in row_map.iter().enumerate() {
        if *o >= 0 {
            row_back.insert(*o as usize, e);
        }
    }
    let mut col_back: HashMap<usize, usize> = HashMap::new();
    for (e, o) in col_map.iter().enumerate() {
        if *o >= 0 {
            col_back.insert(*o as usize, e);
        }
    }

    // locked cells must stay where they are, with the same merge
    for r in 0..r_count {
        for c in 0..c_count {
            let CellRecord::Cell(cell) = &rec.cells[r][c] else {
                continue;
            };
            if !cell.protected {
                continue;
            }
            let er = row_back.get(&r).copied();
            let ec = col_back.get(&c).copied();
            let a = match (er, ec) {
                (Some(er), Some(ec)) => grid.anchor_at(er, ec),
                _ => None,
            };
            let span = span_of(&rec.cells[r][c]);
            let bad = match a {
                None => true,
                Some(a) => {
                    Some(a.row) != er
                        || Some(a.col) != ec
                        || a.col_span != span.col_span
                        || a.row_span != span.row_span
                }
            };
            if bad {
                rctx.warn(
                    "a table with locked cells (Hancom cell protection) kept its structure: rows, columns or merges touching them were not changed",
                );
                return Ok(unchanged_result(rctx, rec));
            }
        }
    }

    let prefixes = prefixes_of(rctx);
    // columns
    let identity_cols =
        grid.cols == c_count && col_map.iter().enumerate().all(|(e, o)| *o == e as i64);

    let widths = &grid.widths;
    let mut columns_xml = String::new();
    let mut width_delta = 0.0f64;
    let col_elements: Vec<&super::model::ColumnRecord> = rec
        .columns
        .iter()
        .filter(|c| c.element.start.is_some())
        .collect();
    let widths_same = identity_cols
        && rec
            .columns
            .iter()
            .enumerate()
            .all(|(i, col)| (widths[i] - col.width_twips.0).abs() <= 2.0);
    if widths_same && col_elements.len() == c_count {
        let first = col_elements[0]
            .element
            .start
            .0
            .expect("a column element has a start");
        let last = col_elements[col_elements.len() - 1]
            .element
            .end
            .0
            .expect("a column element has an end");
        columns_xml = cut(&xml, first, last);
        // anything between the column elements is part of that slice already
    } else {
        for e in 0..grid.cols {
            let o = if col_map[e] >= 0 {
                col_map[e]
            } else {
                nearest(&col_map, e)
            };
            let col = if o >= 0 {
                Some(&rec.columns[o as usize])
            } else {
                None
            };
            let width = widths[e];
            let base = col.and_then(|c| c.style.as_deref());
            let mut tag = match col {
                Some(col) if col.element.start.is_some() => cut(
                    &xml,
                    col.element.start.0.expect("checked"),
                    col.element.end.0.expect("a column element has an end"),
                ),
                _ => "<table:table-column/>".to_string(),
            };
            if col.is_some_and(|c| c.repeated) {
                let mut over = AttrOverrides::new();
                over.set("table:number-columns-repeated", None);
                tag = patch_start_tag(&tag, &prefixes, &over)?;
            }
            // a new column as wide as its neighbour simply copies the neighbour's column
            if col.is_none_or(|c| (width - c.width_twips.0).abs() > 2.0) {
                let mut over = AttrOverrides::new();
                over.set(
                    "table:style-name",
                    Some(derived_column_style(rctx, base, width)?),
                );
                tag = patch_start_tag(&tag, &prefixes, &over)?;
            }
            columns_xml.push_str(&tag);
        }
        width_delta = widths.iter().fold(0.0, |a, b| a + b) - rec.width_twips.0;
    }

    // rows
    let header_of = |e: usize| -> bool {
        let flag = edited
            .model
            .repeat_header_rows
            .as_ref()
            .and_then(|f| f.get(e))
            .copied()
            .flatten();
        match flag {
            Some(flag) => flag,
            None => {
                if row_map[e] >= 0 {
                    rec.rows[row_map[e] as usize].header
                } else {
                    false
                }
            }
        }
    };
    let mut height_delta = 0.0f64;
    let mut rows_out: Vec<(String, bool)> = Vec::new();
    for e in 0..grid.rows {
        let o = row_map[e];
        let tmpl_index = if o >= 0 { o } else { nearest(&row_map, e) };
        let tmpl = if tmpl_index >= 0 {
            Some(&rec.rows[tmpl_index as usize])
        } else {
            None
        };
        height_delta += tmpl.and_then(|t| t.height_cm).map_or(0.0, |h| h.0);
        let mut cells = String::new();
        let mut same = o >= 0 && identity_cols;
        for c in 0..grid.cols {
            let a = grid.anchor_at(e, c);
            let oc = col_map[c];
            let orig_cell = if o >= 0 && oc >= 0 {
                Some(&rec.cells[o as usize][oc as usize])
            } else {
                None
            };

            let cell_xml: String = match a {
                None => {
                    // a row the editor left short: an empty cell keeps the grid whole
                    "<table:table-cell office:value-type=\"string\"><text:p/></table:table-cell>"
                        .to_string()
                }
                Some(a) if a.row == e && a.col == c => {
                    rebuild_anchor(rctx, ext, rec, a, &row_map, &col_map, bridge)?
                }
                Some(_) => match orig_cell {
                    Some(cell @ CellRecord::Covered(_)) if cell.range().start.is_some() => {
                        let range = cell.range();
                        cut(
                            &xml,
                            range.start.0.expect("checked"),
                            range.end.0.expect("a covered cell has an end"),
                        )
                    }
                    _ => "<table:covered-table-cell/>".to_string(),
                },
            };
            if same {
                let identical = match orig_cell {
                    Some(cell) if cell.range().start.is_some() => {
                        let range = cell.range();
                        cell_xml
                            == cut(
                                &xml,
                                range.start.0.expect("checked"),
                                range.end.0.expect("a cell has an end"),
                            )
                    }
                    _ => false,
                };
                if !identical {
                    same = false;
                }
            }
            cells.push_str(&cell_xml);
        }
        let row_xml: String;
        if same && o >= 0 {
            let r = &rec.rows[o as usize].element;
            row_xml = cut(&xml, r.start, r.end);
        } else if let Some(tmpl) = tmpl {
            let tag = cut(&xml, tmpl.element.start, tmpl.element.open_end);
            row_xml = if tmpl.element.self_closing {
                format!("{}{}</{}>", open_tag(&tag), cells, tag_name(&tag))
            } else {
                format!(
                    "{}{}{}",
                    tag,
                    cells,
                    cut(&xml, tmpl.element.close_start, tmpl.element.end)
                )
            };
        } else {
            row_xml = format!("<table:table-row>{cells}</table:table-row>");
        }
        rows_out.push((row_xml, header_of(e)));
    }
    for r in &rec.rows {
        height_delta -= r.height_cm.map_or(0.0, |h| h.0);
    }

    // header rows lead the table
    let mut rows_xml = String::new();
    let mut k = 0usize;
    if !rows_out.is_empty() && rows_out[0].1 {
        let group = rec.header_rows.as_ref();
        rows_xml.push_str(&match group {
            Some(g) => cut(&xml, g.start, g.open_end),
            None => "<table:table-header-rows>".to_string(),
        });
        while k < rows_out.len() && rows_out[k].1 {
            rows_xml.push_str(&rows_out[k].0);
            k += 1;
        }
        rows_xml.push_str(&match group {
            Some(g) if !g.self_closing => cut(&xml, g.close_start, g.end),
            _ => "</table:table-header-rows>".to_string(),
        });
    }
    if rows_out[k.min(rows_out.len())..].iter().any(|r| r.1) {
        rctx.warn("header rows after the first body row became body rows");
    }
    while k < rows_out.len() {
        rows_xml.push_str(&rows_out[k].0);
        k += 1;
    }

    // the table element: its start tag, anything before the columns, then the rebuilt grid
    let mut tag = cut(&xml, rec.element.start, rec.element.open_end);
    if width_delta != 0.0 && !width_delta.is_nan() {
        tag = table_start_tag(rctx, rec, width_delta)?.unwrap_or(tag);
    }
    let mut first_child = at(&xml, rec.element.close_start);
    for c in &col_elements {
        first_child = first_child.min(at(
            &xml,
            c.element.start.0.expect("a column element has a start"),
        ));
    }
    if let Some(h) = &rec.header_rows {
        first_child = first_child.min(at(&xml, h.start));
    }
    for r in &rec.rows {
        first_child = first_child.min(at(&xml, r.element.start));
    }
    let lead = &xml.text[at(&xml, rec.element.open_end)..first_child];
    let out = format!(
        "{}{}{}{}{}",
        tag,
        lead,
        columns_xml,
        rows_xml,
        cut(&xml, rec.element.close_start, rec.element.end)
    );
    Ok(TableResult {
        changed: out != cut(&xml, rec.element.start, rec.element.end),
        xml: out,
        height_delta_cm: height_delta,
        width_delta_twips: width_delta,
    })
}

/// `rebuildAnchor`: one anchor cell of a rebuilt table.
fn rebuild_anchor(
    rctx: &mut OoxmlToOdfContext,
    ext: &TableExt,
    rec: &TableRecord,
    a: &EditedAnchor<'_>,
    row_map: &[i64],
    col_map: &[i64],
    bridge: Option<&OxTable>,
) -> Result<String, OdtError> {
    let xml = xml_of(rctx);
    let o = row_map[a.row];
    let oc = col_map[a.col];
    let at_cell = if o >= 0 && oc >= 0 {
        Some(&rec.cells[o as usize][oc as usize])
    } else {
        None
    };
    // the anchor record at a position and its row
    let owner =
        |cell: &CellRecord, r: usize, c: usize| -> Option<(&AnchorCellRecord, usize, usize)> {
            let (ar, ac) = anchor_of(cell, r, c);
            match &rec.cells[ar][ac] {
                CellRecord::Cell(anchor) => Some((anchor, ar, ac)),
                _ => None,
            }
        };
    // (record, row, col)
    let mut src: Option<(&AnchorCellRecord, usize, usize)> = match at_cell {
        Some(CellRecord::Cell(c)) => Some((c, o as usize, oc as usize)),
        _ => None,
    };
    // original cells the edited span now covers (a merge)
    let mut others: Vec<(&AnchorCellRecord, usize, usize)> = Vec::new();
    for i in 0..a.row_span {
        for j in 0..a.col_span {
            let r = row_map.get(a.row + i).copied();
            let c = col_map.get(a.col + j).copied();
            let (Some(r), Some(c)) = (r, c) else { continue };
            if r < 0 || c < 0 {
                continue;
            }
            let CellRecord::Cell(cell) = &rec.cells[r as usize][c as usize] else {
                continue;
            };
            if src.is_some_and(|s| s.1 == r as usize && s.2 == c as usize) {
                continue;
            }
            if !others
                .iter()
                .any(|x| x.1 == r as usize && x.2 == c as usize)
            {
                others.push((cell, r as usize, c as usize));
            }
        }
    }
    if src.is_none() && !others.is_empty() {
        src = Some(others.remove(0));
    }
    if let Some((cell, row, _)) = src {
        if cell.protected {
            // its place and merge were checked to be the same; it is never written
            if locked_cell_touched(rctx, ext, cell, a) {
                rctx.warn(LOCKED_WARNING);
            }
            return Ok(cut(&xml, cell.element.start, cell.element.end));
        }
        let other_cells: Vec<&AnchorCellRecord> = others.iter().map(|x| x.0).collect();
        let b = bridge_cell(bridge, row, Some(cell.tc));
        return Ok(write_cell_element(
            rctx,
            ext,
            cell,
            &other_cells,
            a,
            b,
            Some(Span {
                col_span: a.col_span,
                row_span: a.row_span,
            }),
            None,
        )?
        .xml);
    }
    // a new cell: its style comes from the cell it was split from, else from the
    // neighbour row's (new row) or neighbour column's (new column) cell
    let mut template: Option<&AnchorCellRecord> = at_cell
        .and_then(|cell| owner(cell, o as usize, oc as usize))
        .map(|x| x.0);
    if template.is_none() {
        let r = if o >= 0 { o } else { nearest(row_map, a.row) };
        let c = if oc >= 0 { oc } else { nearest(col_map, a.col) };
        template = if r >= 0 && c >= 0 {
            owner(&rec.cells[r as usize][c as usize], r as usize, c as usize).map(|x| x.0)
        } else {
            None
        };
    }
    if template.is_none() {
        template = rec.cells.iter().flatten().find_map(|cell| match cell {
            CellRecord::Cell(c) => Some(c),
            _ => None,
        });
    }
    new_cell_from_template(rctx, template, a)
}

// ---------------------------------------------------------------------------
// New tables (no original)

/// `sideBorder`: an ODF border from a table-level border model side.
fn side_border(b: Option<&CellBorder>, fallback: &str) -> String {
    match b {
        Some(b) => border_to_odf(Some(b)),
        None => fallback.to_string(),
    }
}

/// `newTableOdf`: a body-level ODF table for a table the editor created, with
/// new automatic styles.
pub fn new_table_odf(
    rctx: &mut OoxmlToOdfContext,
    table: &EditedTable<'_>,
) -> Result<String, OdtError> {
    let model = table.model;
    let grid = edited_grid(model, &table.ox);
    let widths = grid.widths.clone();
    let total = widths.iter().fold(0.0, |a, b| a + b);
    const DEFAULT_BORDER: &str = "0.018cm solid #000000";
    let tb = model.borders.as_ref();
    let align_key = model.align.map_or("left", TableModelAlign::as_str);
    let table_style = derive(
        rctx,
        &key_of(json!(["new-table", total, align_key])),
        "Table",
        |name| {
            Ok(format!(
                "<style:style style:name=\"{name}\" style:family=\"table\"><style:table-properties style:width=\"{}\" table:align=\"{}\" table:border-model=\"collapsing\"/></style:style>",
                twips_to_cm(total),
                match model.align {
                    Some(TableModelAlign::Center) => "center",
                    Some(TableModelAlign::Right) => "right",
                    _ => "left",
                }
            ))
        },
    )?;
    let mut out = format!("<table:table table:style-name=\"{table_style}\">");
    for &w in &widths {
        let name = derive(
            rctx,
            &key_of(json!(["new-column", w])),
            "TableColumn",
            |n| {
                Ok(format!(
                    "<style:style style:name=\"{n}\" style:family=\"table-column\"><style:table-column-properties style:column-width=\"{}\"/></style:style>",
                    twips_to_cm(w)
                ))
            },
        )?;
        out.push_str(&format!(
            "<table:table-column table:style-name=\"{name}\"/>"
        ));
    }
    let mut rows: Vec<(String, bool)> = Vec::new();
    for r in 0..grid.rows {
        let h = model
            .row_heights_twips
            .as_ref()
            .and_then(|v| v.get(r))
            .copied()
            .flatten();
        let mut row_style: Option<String> = None;
        if let Some(h) = h.filter(|h| h.0 > 0.0) {
            let exact = model
                .row_height_rules
                .as_ref()
                .and_then(|v| v.get(r))
                .copied()
                .flatten()
                == Some(TableModelRowHeightRulesItem::Exact);
            row_style = Some(derive(
                rctx,
                &key_of(json!(["new-row", h.0, exact])),
                "TableRow",
                |n| {
                    Ok(format!(
                        "<style:style style:name=\"{n}\" style:family=\"table-row\"><style:table-row-properties {}=\"{}\"/></style:style>",
                        if exact {
                            "style:row-height"
                        } else {
                            "style:min-row-height"
                        },
                        twips_to_cm(h.0)
                    ))
                },
            )?);
        }
        let mut cells = String::new();
        for c in 0..grid.cols {
            let a = grid.anchor_at(r, c);
            if let Some(a) = a
                && (a.row != r || a.col != c)
            {
                cells.push_str("<table:covered-table-cell/>");
                continue;
            }
            let cell: Option<&TableCell> = a.map(|a| a.cell);
            let last_row = match a {
                Some(a) => a.row + a.row_span >= grid.rows,
                None => r + 1 == grid.rows,
            };
            let last_col = match a {
                Some(a) => a.col + a.col_span >= grid.cols,
                None => c + 1 == grid.cols,
            };
            let fallback = if tb.is_some() { "none" } else { DEFAULT_BORDER };
            let default_borders = CellBorders::default();
            let b = cell
                .and_then(|c| c.borders.as_ref())
                .unwrap_or(&default_borders);
            let tb_side = |name: &str| -> Option<&CellBorder> {
                tb.and_then(|tb| match name {
                    "insideH" => tb.inside_h.as_ref(),
                    "insideV" => tb.inside_v.as_ref(),
                    other => side_of(&tb.cell_borders, other),
                })
            };
            let mut props: JsObject<String> = JsObject::new();
            props.set(
                "fo:border-top",
                match b.top.as_ref() {
                    Some(t) => border_to_odf(Some(t)),
                    None => side_border(tb_side(if r == 0 { "top" } else { "insideH" }), fallback),
                },
            );
            props.set(
                "fo:border-bottom",
                match b.bottom.as_ref() {
                    Some(t) => border_to_odf(Some(t)),
                    None => side_border(
                        tb_side(if last_row { "bottom" } else { "insideH" }),
                        fallback,
                    ),
                },
            );
            props.set(
                "fo:border-left",
                match b.left.as_ref() {
                    Some(t) => border_to_odf(Some(t)),
                    None => side_border(tb_side(if c == 0 { "left" } else { "insideV" }), fallback),
                },
            );
            props.set(
                "fo:border-right",
                match b.right.as_ref() {
                    Some(t) => border_to_odf(Some(t)),
                    None => side_border(
                        tb_side(if last_col { "right" } else { "insideV" }),
                        fallback,
                    ),
                },
            );
            if let Some(fill) = cell
                .and_then(|c| c.fill.as_deref())
                .filter(|f| !f.is_empty())
            {
                props.set("fo:background-color", format!("#{}", fill.to_lowercase()));
            }
            match cell.and_then(|c| c.v_align.as_ref()).map(|v| v.as_str()) {
                Some("center") => props.set("style:vertical-align", "middle".to_string()),
                Some("bottom") => props.set("style:vertical-align", "bottom".to_string()),
                _ => {}
            }
            for side in ["top", "left", "bottom", "right"] {
                let base = model.cell_mar_twips.as_ref().map_or_else(
                    || match side {
                        "left" | "right" => Some(108.0),
                        _ => None,
                    },
                    |m| margin_of(m, side),
                );
                let own = cell
                    .and_then(|c| c.cell_mar_twips.as_ref())
                    .and_then(|m| margin_of(m, side));
                if let Some(v) = own.or(base) {
                    props.set(format!("fo:padding-{side}"), twips_to_cm(v));
                }
            }
            let attrs: String = props
                .entries()
                .into_iter()
                .map(|(k, v)| format!(" {k}=\"{v}\""))
                .collect();
            let cell_style = derive(
                rctx,
                &key_of(json!(["new-cell", props])),
                "TableCell",
                |n| {
                    Ok(format!(
                        "<style:style style:name=\"{n}\" style:family=\"table-cell\"><style:table-cell-properties{attrs}/></style:style>"
                    ))
                },
            )?;
            let mut tag = format!(
                "<table:table-cell table:style-name=\"{cell_style}\" office:value-type=\"string\""
            );
            if let Some(a) = a {
                if a.col_span > 1 {
                    tag.push_str(&format!(" table:number-columns-spanned=\"{}\"", a.col_span));
                }
                if a.row_span > 1 {
                    tag.push_str(&format!(" table:number-rows-spanned=\"{}\"", a.row_span));
                }
            }
            tag.push('>');
            let mut inner = String::new();
            let items = match a {
                Some(a) => cell_items(a.cell, a.ox),
                None => Vec::new(),
            };
            for item in &items {
                if item.kind == OxItemKind::P {
                    inner.push_str(
                        &write_paragraph(rctx, item, None, &WriteParaOptions::default())?.0,
                    );
                } else if let Some(t) = &item.table {
                    inner.push_str(&new_table_odf(rctx, t)?);
                }
            }
            if inner.is_empty() {
                let empty = EditedItem {
                    kind: OxItemKind::P,
                    xml: String::new(),
                    para: Some(std::borrow::Cow::Owned(Default::default())),
                    table: None,
                };
                inner = write_paragraph(rctx, &empty, None, &WriteParaOptions::default())?.0;
            }
            cells.push_str(&format!("{tag}{inner}</table:table-cell>"));
        }
        let row_tag = match &row_style {
            Some(s) => format!("<table:table-row table:style-name=\"{s}\">"),
            None => "<table:table-row>".to_string(),
        };
        let header = model
            .repeat_header_rows
            .as_ref()
            .and_then(|v| v.get(r))
            .copied()
            .flatten()
            .unwrap_or(false);
        rows.push((format!("{row_tag}{cells}</table:table-row>"), header));
    }
    let mut k = 0usize;
    if !rows.is_empty() && rows[0].1 {
        out.push_str("<table:table-header-rows>");
        while k < rows.len() && rows[k].1 {
            out.push_str(&rows[k].0);
            k += 1;
        }
        out.push_str("</table:table-header-rows>");
    }
    while k < rows.len() {
        out.push_str(&rows[k].0);
        k += 1;
    }
    Ok(format!("{out}</table:table>"))
}

/// `mar[side]` of a cell-margin object.
fn margin_of(m: &docx_engine::model::CellMargins, side: &str) -> Option<f64> {
    let v = match side {
        "top" => *m.top,
        "left" => *m.left,
        "bottom" => *m.bottom,
        _ => *m.right,
    };
    v.map(|n| n.0)
}
