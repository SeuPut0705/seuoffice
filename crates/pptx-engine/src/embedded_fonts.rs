//! Port of packages/pptx-engine/src/embedded-fonts.ts: embedded font
//! extraction. `<p:embeddedFontLst>` declares document-embedded faces whose
//! fntdata parts are EOT containers; only uncompressed payloads are usable
//! directly, MicroType-Express-compressed EOTs (flag 0x4) inflate through the
//! `mtx` crate.
//!
//! Recursion: [`collect_runs`] follows `GroupElement.children`, whose nesting
//! the parse bounds at 64 levels.

use std::collections::{HashMap, HashSet};

use jscompat::{JsMap, JsRegex, is_js_space, js_regex, replace_first_string, value_to_string};
use ooxml_xml::ObjectOptions;
use serde::Serialize;
use serde_json::Value;

use crate::types::{Slide, SlideElement, TextRun};
use crate::xml_utils::{as_xml_node, attribute_of, xml_array, xml_parse_object};
use crate::zip::{PackageArchive, resolve_target};

/// `EmbeddedFontStyle`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EmbeddedFontStyle {
    Regular,
    Bold,
    Italic,
    BoldItalic,
}

impl EmbeddedFontStyle {
    /// The style as the TypeScript spells it: a key and an element name suffix.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Regular => "regular",
            Self::Bold => "bold",
            Self::Italic => "italic",
            Self::BoldItalic => "boldItalic",
        }
    }
}

/// `EmbeddedFontFace`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EmbeddedFontFace {
    pub typeface: String,
    pub style: EmbeddedFontStyle,
    /// Single-face sfnt bytes (TTF/OTF), ready for opentype.js / FontFace
    pub sfnt: Vec<u8>,
}

const EOT_FLAG_COMPRESSED: u32 = 0x0000_0004; // TTEMBED_TTCOMPRESSED (MicroType Express)
const EOT_FLAG_XOR: u32 = 0x1000_0000; // TTEMBED_XORENCRYPTDATA (payload XORed with 0x50)

/// TrueType / 'OTTO' / 'true' / 'ttcf'
const SFNT_MAGICS: [u32; 4] = [0x0001_0000, 0x4f54_544f, 0x7472_7565, 0x7474_6366];

/// `dv.getUint32(at, littleEndian)` over a slice that is at least `at + 4` long.
fn u32_of(bytes: &[u8], at: usize, little: bool) -> Option<u32> {
    let raw: [u8; 4] = bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
    Some(if little {
        u32::from_le_bytes(raw)
    } else {
        u32::from_be_bytes(raw)
    })
}

/// Unwrap an EOT container to its sfnt payload; `None` when compressed or
/// malformed (a payload shorter than the four bytes of the magic included).
pub fn eot_to_sfnt(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 16 {
        return None;
    }
    // Some producers (LibreOffice) store the bare sfnt without an EOT wrapper
    if u32_of(bytes, 0, false).is_some_and(|magic| SFNT_MAGICS.contains(&magic)) {
        return Some(bytes.to_vec());
    }
    let eot_size = u32_of(bytes, 0, true).unwrap_or(0);
    let font_data_size = u32_of(bytes, 4, true).unwrap_or(0);
    let flags = u32_of(bytes, 12, true).unwrap_or(0);
    if eot_size as usize != bytes.len()
        || font_data_size == 0
        || font_data_size as usize > bytes.len() - 16
    {
        return None;
    }
    // The variable-length header precedes the payload, so the payload sits at the tail
    let mut sfnt: Vec<u8> = bytes
        .get(bytes.len() - font_data_size as usize..)
        .unwrap_or_default()
        .to_vec();
    if flags & EOT_FLAG_XOR != 0 {
        for b in sfnt.iter_mut() {
            *b ^= 0x50;
        }
    }
    if flags & EOT_FLAG_COMPRESSED != 0 {
        sfnt = mtx::mtx_to_sfnt(&sfnt)?;
    }
    // FontDataSize can be 1..3 and still pass the checks above; refuse before
    // reading the magic
    let magic = u32_of(&sfnt, 0, false)?;
    if !SFNT_MAGICS.contains(&magic) {
        return None;
    }
    Some(sfnt)
}

/// The code points one demand key asks of its part, in the order they were
/// first added (a JavaScript `Set<number>`).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(transparent)]
pub struct GlyphSet {
    order: Vec<u32>,
    #[serde(skip)]
    seen: HashSet<u32>,
}

impl GlyphSet {
    /// `set.add(cp)`
    pub fn add(&mut self, cp: u32) {
        if self.seen.insert(cp) {
            self.order.push(cp);
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = u32> + '_ {
        self.order.iter().copied()
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

/// Code points each embedded part must cover, keyed by `${typeface}|${style}`
/// (typeface lower-cased; '*' collects runs with no resolved family).
pub type GlyphDemand = JsMap<GlyphSet>;

const EMBEDDED_STYLES: [EmbeddedFontStyle; 4] = [
    EmbeddedFontStyle::Regular,
    EmbeddedFontStyle::Bold,
    EmbeddedFontStyle::Italic,
    EmbeddedFontStyle::BoldItalic,
];

/// `demandKey`
pub fn demand_key(typeface: &str, style: EmbeddedFontStyle) -> String {
    format!("{}|{}", typeface.to_lowercase(), style.as_str())
}

/// `runStyle`
fn run_style(r: &TextRun) -> EmbeddedFontStyle {
    let bold = r.bold.unwrap_or(false);
    let italic = r.italic.unwrap_or(false);
    if bold && italic {
        return EmbeddedFontStyle::BoldItalic;
    }
    if bold {
        return EmbeddedFontStyle::Bold;
    }
    if italic {
        return EmbeddedFontStyle::Italic;
    }
    EmbeddedFontStyle::Regular
}

/// `EAST_ASIAN_RE.test(ch)`
fn is_east_asian(ch: &str) -> bool {
    js_regex!(
        r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303F\uFF00-\uFFEF]",
        "u"
    )
    .test(ch)
}

/// `collectRuns`
fn collect_runs<'a>(el: &'a SlideElement, out: &mut Vec<&'a TextRun>) {
    match el {
        SlideElement::Group(group) => {
            for c in group.children.as_deref().unwrap_or_default() {
                collect_runs(c, out);
            }
        }
        SlideElement::Table(table) => {
            for row in table.rows.as_deref().unwrap_or_default() {
                for cell in row {
                    if let Some(text) = cell.text.as_ref() {
                        for p in text.paragraphs.as_deref().unwrap_or_default() {
                            out.extend(p.runs.as_deref().unwrap_or_default());
                        }
                    }
                }
            }
        }
        SlideElement::Text(text) => {
            if let Some(body) = text.text.as_ref() {
                for p in body.paragraphs.as_deref().unwrap_or_default() {
                    out.extend(p.runs.as_deref().unwrap_or_default());
                }
            }
        }
        _ => {}
    }
}

/// Glyphs the edited text needs, per typeface. Only edited elements count: the
/// producer's subsets already cover the untouched text. `None` when nothing is edited.
pub fn edited_glyph_demand(slides: &[Slide]) -> Option<GlyphDemand> {
    let mut runs: Vec<&TextRun> = Vec::new();
    let mut edited = false;
    for s in slides {
        let structure_dirty = s.structure_dirty.unwrap_or(false);
        for el in s.elements.as_deref().unwrap_or_default() {
            let dirty = crate::with_element!(el, e => e.dirty.unwrap_or(false));
            if !structure_dirty && !dirty {
                continue;
            }
            edited = true;
            collect_runs(el, &mut runs);
        }
    }
    if !edited {
        return None;
    }
    let mut demand: GlyphDemand = JsMap::new();
    for r in runs {
        let style = run_style(r);
        let fam = r.font_family.as_deref().unwrap_or("*");
        let latin = r.latin_family.as_deref().filter(|latin| !latin.is_empty());
        let text = r.text.as_deref().unwrap_or_default();
        for ch in text.chars() {
            let cp = u32::from(ch);
            if cp <= 0x20 || is_js_space(ch) {
                continue;
            }
            let mut buffer = [0u8; 4];
            let key = demand_key(
                match latin {
                    Some(latin) if !is_east_asian(ch.encode_utf8(&mut buffer)) => latin,
                    _ => fam,
                },
                style,
            );
            if let Some(set) = demand.get_mut(&key) {
                set.add(cp);
            } else {
                let mut set = GlyphSet::default();
                set.add(cp);
                demand.set(key, set);
            }
        }
    }
    Some(demand)
}

/// One `cmap` subtable the lookup consults.
#[derive(Debug, Clone, Copy)]
enum Subtable {
    Format4 {
        seg_count: u64,
        ends: u64,
        starts: u64,
        deltas: u64,
        range_offsets: u64,
    },
    Format12 {
        sub: u64,
        n_groups: u64,
    },
}

/// Code-point lookup over the sfnt's cmap (formats 4 and 12).
#[derive(Debug, Clone)]
pub struct CmapLookup {
    sfnt: Vec<u8>,
    subtables: Vec<Subtable>,
}

/// `dv.getUint16(at, false)`; `None` where the DataView throws.
fn u16_at(sfnt: &[u8], at: u64) -> Option<u64> {
    let at = usize::try_from(at).ok()?;
    let raw: [u8; 2] = sfnt.get(at..at.checked_add(2)?)?.try_into().ok()?;
    Some(u64::from(u16::from_be_bytes(raw)))
}

/// `dv.getUint32(at, false)`; `None` where the DataView throws.
fn u32_at(sfnt: &[u8], at: u64) -> Option<u64> {
    let at = usize::try_from(at).ok()?;
    u32_of(sfnt, at, false).map(u64::from)
}

/// `inBounds(off, len)`
fn in_bounds(sfnt: &[u8], off: u64, len: u64) -> bool {
    off.checked_add(len)
        .is_some_and(|end| end <= sfnt.len() as u64)
}

impl CmapLookup {
    /// `lookup(cp)`
    pub fn covers(&self, cp: u32) -> bool {
        let sfnt = self.sfnt.as_slice();
        let cp = u64::from(cp);
        self.subtables.iter().any(|sub| match *sub {
            Subtable::Format4 {
                seg_count,
                ends,
                starts,
                deltas,
                range_offsets,
            } => {
                if cp > 0xffff {
                    return false;
                }
                for k in 0..seg_count {
                    let Some(end) = u16_at(sfnt, ends + k * 2) else {
                        return false;
                    };
                    if cp > end {
                        continue;
                    }
                    let Some(start) = u16_at(sfnt, starts + k * 2) else {
                        return false;
                    };
                    if cp < start {
                        return false;
                    }
                    let (Some(delta), Some(ro)) = (
                        u16_at(sfnt, deltas + k * 2),
                        u16_at(sfnt, range_offsets + k * 2),
                    ) else {
                        return false;
                    };
                    if ro == 0 {
                        return ((cp + delta) & 0xffff) != 0;
                    }
                    let at = range_offsets + k * 2 + ro + (cp - start) * 2;
                    if !in_bounds(sfnt, at, 2) {
                        return false;
                    }
                    let Some(g) = u16_at(sfnt, at) else {
                        return false;
                    };
                    return g != 0 && ((g + delta) & 0xffff) != 0;
                }
                false
            }
            Subtable::Format12 { sub, n_groups } => {
                for k in 0..n_groups {
                    let g = sub + 16 + k * 12;
                    if !in_bounds(sfnt, g, 12) {
                        return false;
                    }
                    let (Some(start), Some(end)) = (u32_at(sfnt, g), u32_at(sfnt, g + 4)) else {
                        return false;
                    };
                    if cp >= start && cp <= end {
                        return u32_at(sfnt, g + 8).is_some_and(|glyph| glyph + (cp - start) != 0);
                    }
                }
                false
            }
        })
    }
}

/// `sfntCmapLookup`: `None` when unreadable.
pub fn sfnt_cmap_lookup(sfnt: &[u8]) -> Option<CmapLookup> {
    // every read below throws in the TypeScript when it leaves the buffer: that is `None`
    let mut base = 0u64;
    if u32_at(sfnt, 0)? == 0x7474_6366 {
        base = u32_at(sfnt, 12)?;
    }
    let num_tables = u16_at(sfnt, base + 4)?;
    let mut cmap: Option<u64> = None;
    for i in 0..num_tables {
        let rec = base + 12 + 16 * i;
        if u32_at(sfnt, rec)? == 0x636d_6170 {
            cmap = Some(u32_at(sfnt, rec + 8)?);
        }
    }
    let cmap = cmap?;
    let mut subtables = Vec::new();
    let n = u16_at(sfnt, cmap + 2)?;
    for i in 0..n {
        let sub = cmap + u32_at(sfnt, cmap + 4 + 8 * i + 4)?;
        let format = u16_at(sfnt, sub)?;
        if format == 4 {
            let seg_count = u16_at(sfnt, sub + 6)? >> 1;
            let ends = sub + 14;
            let starts = ends + seg_count * 2 + 2;
            let deltas = starts + seg_count * 2;
            let range_offsets = deltas + seg_count * 2;
            if !in_bounds(sfnt, range_offsets, seg_count * 2) {
                continue;
            }
            subtables.push(Subtable::Format4 {
                seg_count,
                ends,
                starts,
                deltas,
                range_offsets,
            });
        } else if format == 12 {
            let n_groups = u32_at(sfnt, sub + 12)?;
            if !in_bounds(sfnt, sub + 16, n_groups * 12) {
                continue;
            }
            subtables.push(Subtable::Format12 { sub, n_groups });
        }
    }
    if subtables.is_empty() {
        return None;
    }
    Some(CmapLookup {
        sfnt: sfnt.to_vec(),
        subtables,
    })
}

/// `EmbeddedFontBlock`
struct EmbeddedFontBlock {
    xml: String,
    typeface: String,
    rel_ids: Vec<String>,
    /// Style name → relationship id, in the order the keys were first set.
    parts: JsMap<String>,
}

/// `embeddedFontBlocks`
fn embedded_font_blocks(pres: &str) -> Vec<EmbeddedFontBlock> {
    let mut out = Vec::new();
    for m in js_regex!(r"<p:embeddedFont>[\s\S]*?<\/p:embeddedFont>", "g").find_iter(pres) {
        let xml = m.as_str();
        let typeface = js_regex!(r"<p:font\b[^>]*>")
            .exec(xml)
            .and_then(|open| attribute_of(open.as_str(), "typeface"))
            .unwrap_or_default();
        let mut parts: JsMap<String> = JsMap::new();
        for r in js_regex!(r"<p:(regular|bold|italic|boldItalic)\b[^>]*>", "g").find_iter(xml) {
            if let Some(rel_id) = attribute_of(r.as_str(), "r:id") {
                parts.set(r.get(1).unwrap_or_default().to_owned(), rel_id);
            }
        }
        out.push(EmbeddedFontBlock {
            xml: xml.to_owned(),
            typeface,
            rel_ids: parts.values().cloned().collect(),
            parts,
        });
    }
    out
}

/// Embedded typefaces whose subsets no longer cover the glyphs the edited text
/// asks of them. Each style is checked against its own part; a style with no
/// part of its own renders from the regular one. A part that cannot be decoded
/// or has no readable cmap counts as stale when anything demands it.
pub fn stale_embedded_typefaces(
    archive: &PackageArchive,
    demand: &GlyphDemand,
) -> Result<Vec<String>, String> {
    let Some(pres) = archive
        .read_text("ppt/presentation.xml")
        .filter(|pres| pres.contains("embeddedFont"))
    else {
        return Ok(Vec::new());
    };
    let rels = archive.read_rels("ppt/presentation.xml")?;
    let mut lookups: HashMap<String, Option<CmapLookup>> = HashMap::new();
    let mut stale = Vec::new();
    for face in embedded_font_blocks(&pres) {
        if face.rel_ids.is_empty() {
            continue;
        }
        let mut covers = true;
        for style in EMBEDDED_STYLES {
            // the union of the two demands, in `Set` order
            let mut needed = GlyphSet::default();
            for key in [demand_key(&face.typeface, style), demand_key("*", style)] {
                if let Some(set) = demand.get(&key) {
                    for cp in set.iter() {
                        needed.add(cp);
                    }
                }
            }
            if needed.is_empty() {
                continue;
            }
            let rel_id = face
                .parts
                .get(style.as_str())
                .or_else(|| face.parts.get("regular"))
                .or_else(|| face.rel_ids.first())
                .cloned()
                .unwrap_or_default();
            if !lookups.contains_key(&rel_id) {
                let bytes = match rels.get(&rel_id) {
                    Some(rel) => {
                        archive.read_bytes(&resolve_target("ppt/presentation.xml", &rel.target))
                    }
                    None => None,
                };
                let sfnt = match bytes {
                    Some(bytes) => eot_to_sfnt(bytes),
                    None => None,
                };
                lookups.insert(
                    rel_id.clone(),
                    sfnt.and_then(|sfnt| sfnt_cmap_lookup(&sfnt)),
                );
            }
            let ok = match lookups.get(&rel_id).and_then(Option::as_ref) {
                Some(lookup) => needed.iter().all(|cp| lookup.covers(cp)),
                None => false,
            };
            if !ok {
                covers = false;
                break;
            }
        }
        if !covers {
            stale.push(face.typeface.clone());
        }
    }
    Ok(stale)
}

/// `archive.entries.delete(path)` for a set of paths, the other entries keeping their order.
pub(crate) fn delete_entries(archive: &mut PackageArchive, paths: &HashSet<String>) {
    if paths.is_empty() || !paths.iter().any(|path| archive.has(path)) {
        return;
    }
    let entries = std::mem::take(archive.entries_mut());
    let kept: JsMap<Vec<u8>> = entries
        .into_iter()
        .filter(|(path, _)| !paths.contains(path))
        .collect();
    *archive.entries_mut() = kept;
}

/// Remove embedded faces from the package: their `<p:embeddedFont>` entries,
/// font relationships, fntdata parts and [Content_Types] overrides. With no
/// typeface filter every face goes; once no face remains the
/// `<p:embeddedFontLst>` itself, the embedTrueTypeFonts/saveSubsetFonts
/// attributes and the fntdata Default are dropped too. Idempotent; returns
/// whether anything was removed.
pub fn strip_embedded_fonts(
    archive: &mut PackageArchive,
    typefaces: Option<&HashSet<String>>,
) -> bool {
    let pres_path = "ppt/presentation.xml";
    let Some(pres) = archive
        .read_text(pres_path)
        .map(|pres| pres.into_owned())
        .filter(|pres| pres.contains("embeddedFont"))
    else {
        return false;
    };
    let wanted: Option<HashSet<String>> =
        typefaces.map(|set| set.iter().map(|t| t.to_lowercase()).collect());
    let blocks = embedded_font_blocks(&pres);
    let removed: Vec<&EmbeddedFontBlock> = blocks
        .iter()
        .filter(|b| {
            wanted
                .as_ref()
                .is_none_or(|wanted| wanted.contains(&b.typeface.to_lowercase()))
        })
        .collect();
    if removed.is_empty() {
        return false;
    }
    let remove_all = removed.len() == blocks.len();

    let mut next_pres = pres.clone();
    for b in &removed {
        next_pres = replace_first_string(&next_pres, &b.xml, "");
    }
    if remove_all {
        next_pres = js_regex!(
            r"<p:embeddedFontLst\b[^>]*\/>|<p:embeddedFontLst\b[^>]*>[\s\S]*?<\/p:embeddedFontLst>"
        )
        .exec(&next_pres)
        .map_or_else(
            || next_pres.clone(),
            |found| {
                format!(
                    "{}{}",
                    next_pres.get(..found.start()).unwrap_or_default(),
                    next_pres.get(found.end()..).unwrap_or_default()
                )
            },
        );
        next_pres = remove_first(js_regex!(r#" embedTrueTypeFonts="[^"]*""#), &next_pres);
        next_pres = remove_first(js_regex!(r#" saveSubsetFonts="[^"]*""#), &next_pres);
    }
    archive
        .entries_mut()
        .set(pres_path.to_owned(), next_pres.into_bytes());

    let rel_ids: HashSet<&str> = removed
        .iter()
        .flat_map(|b| b.rel_ids.iter().map(String::as_str))
        .collect();
    let mut parts: HashSet<String> = HashSet::new();
    let rels_path = "ppt/_rels/presentation.xml.rels";
    if let Some(rels) = archive.read_text(rels_path).map(|rels| rels.into_owned()) {
        let next_rels = js_regex!(r"<Relationship\b[^>]*\/>", "g").replace_all(&rels, |m| {
            let tag = m.as_str();
            let is_font = js_regex!(r#"\bType=["'][^"']*\/font["']"#).test(tag);
            let id = attribute_of(tag, "Id").unwrap_or_default();
            if !is_font || !(remove_all || rel_ids.contains(id.as_str())) {
                return tag.to_owned();
            }
            let target = attribute_of(tag, "Target").filter(|target| !target.is_empty());
            if let Some(target) = target {
                parts.insert(resolve_target(pres_path, &target));
            }
            String::new()
        });
        if next_rels != rels {
            archive
                .entries_mut()
                .set(rels_path.to_owned(), next_rels.into_bytes());
        }
    }
    if remove_all {
        for path in archive.entries().keys() {
            if js_regex!(r"^ppt\/fonts\/[^/]+\.fntdata$").test(path) {
                parts.insert(path.to_owned());
            }
        }
    }
    delete_entries(archive, &parts);

    let ct_path = "[Content_Types].xml";
    if let Some(ct) = archive.read_text(ct_path).map(|ct| ct.into_owned()) {
        let mut next_ct = js_regex!(r"<Override\b[^>]*\/>", "g").replace_all(&ct, |m| {
            let tag = m.as_str();
            let part_name = attribute_of(tag, "PartName").unwrap_or_default();
            let bare = part_name.strip_prefix('/').unwrap_or(&part_name);
            if parts.contains(bare) {
                String::new()
            } else {
                tag.to_owned()
            }
        });
        if remove_all {
            next_ct = js_regex!(r#"<Default\b[^>]*\bExtension=["']fntdata["'][^>]*\/>"#, "g")
                .replace_all(&next_ct, |_| String::new());
        }
        if next_ct != ct {
            archive
                .entries_mut()
                .set(ct_path.to_owned(), next_ct.into_bytes());
        }
    }
    true
}

/// `text.replace(regex, '')` of a regex without the `g` flag.
fn remove_first(regex: &JsRegex, text: &str) -> String {
    match regex.exec(text) {
        Some(found) => format!(
            "{}{}",
            text.get(..found.start()).unwrap_or_default(),
            text.get(found.end()..).unwrap_or_default()
        ),
        None => text.to_owned(),
    }
}

/// Save-time guard: an embedded subset cannot grow, so text edited into glyphs
/// it lacks renders as invisible text in WPS. Faces the edits outgrew are
/// stripped so viewers fall back to system fonts; covered faces, and untouched
/// decks, stay byte-identical. Returns the stripped typefaces.
pub fn strip_stale_embedded_fonts(
    slides: &[Slide],
    archive: &mut PackageArchive,
) -> Result<Vec<String>, String> {
    let Some(demand) = edited_glyph_demand(slides) else {
        return Ok(Vec::new());
    };
    let stale = stale_embedded_typefaces(archive, &demand)?;
    if !stale.is_empty() {
        let set: HashSet<String> = stale.iter().cloned().collect();
        strip_embedded_fonts(archive, Some(&set));
    }
    Ok(stale)
}

/// `x ?? ''` over a parse-tree value.
fn text_or_empty(value: Option<&Value>) -> String {
    match value.filter(|value| !value.is_null()) {
        Some(value) => value_to_string(Some(value)),
        None => String::new(),
    }
}

/// Usable (uncompressed) embedded faces of a package; empty when none are declared.
pub fn list_embedded_fonts(archive: &PackageArchive) -> Result<Vec<EmbeddedFontFace>, String> {
    let Some(pres_xml) = archive
        .read_text("ppt/presentation.xml")
        .filter(|xml| xml.contains("embeddedFont"))
    else {
        return Ok(Vec::new());
    };
    let options = ObjectOptions {
        array_names: &["p:embeddedFont"],
        ..ObjectOptions::default()
    };
    let Ok(parsed) = xml_parse_object(&pres_xml, &options) else {
        return Ok(Vec::new());
    };
    let root = as_xml_node(as_xml_node(Some(&parsed)).get("p:presentation"));
    let lst = as_xml_node(root.get("p:embeddedFontLst").filter(|v| !v.is_null()));
    let rels = archive.read_rels("ppt/presentation.xml")?;
    let mut out = Vec::new();
    for ef in xml_array(lst.get("p:embeddedFont")) {
        let font = as_xml_node(as_xml_node(Some(ef)).get("p:font").filter(|v| !v.is_null()));
        let typeface = text_or_empty(font.get("@_typeface"));
        if typeface.is_empty() {
            continue;
        }
        for style in EMBEDDED_STYLES {
            let element = as_xml_node(
                as_xml_node(Some(ef))
                    .get(format!("p:{}", style.as_str()).as_str())
                    .filter(|v| !v.is_null()),
            );
            let Some(rel_id) = element.get("@_r:id").filter(|v| !v.is_null()) else {
                continue;
            };
            let Some(rel) = rels.get(&value_to_string(Some(rel_id))) else {
                continue;
            };
            let part = resolve_target("ppt/presentation.xml", &rel.target);
            let Some(bytes) = archive.read_bytes(&part) else {
                continue;
            };
            if let Some(sfnt) = eot_to_sfnt(bytes) {
                out.push(EmbeddedFontFace {
                    typeface: typeface.clone(),
                    style,
                    sfnt,
                });
            }
        }
    }
    Ok(out)
}
