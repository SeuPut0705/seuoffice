//! `text/paragraph-ooxml.ts`: ODF to OOXML for one paragraph.
//!
//! Formatting is mapped onto the docx engine's model and written by the
//! engine's own generator, so the bridge paragraph is exactly the kind of XML
//! the engine regenerates when the editor changes it:
//! - `w:pStyle` = the docx style of the paragraph's ODF common style (the
//!   automatic style's parent); the automatic style's own paragraph properties
//!   become direct `w:pPr`, with the effective tab list.
//! - each run's direct `w:rPr` = the paragraph automatic style's own text
//!   properties overlaid with its spans' (and link's) styles.
//! - a hidden identity bookmark `_odtp<id>` opens the paragraph; every ODF
//!   bookmark and kept inline element gets a hidden `_odtm<id>_<n>` bookmark at
//!   its position. Positions are restored on save from the bridge record, not
//!   from these bookmarks (the engine moves them to the paragraph start when it
//!   regenerates a paragraph).

use std::collections::HashMap;

use docx_engine::model::{
    GeneratedBlock, GeneratedBlockList, GeneratedBlockListKind, GeneratedBlockType, Run, RunLink,
};
use jscompat::{JsNum, js_regex, math_min, number_truthy, slice_utf16};

use crate::core::convert::{
    BridgeListItem, BridgeMap, BridgeMarkerKind, BridgeParagraph, BridgeParagraphElement,
    OdfToOoxmlContext, paragraph_identity_name,
};
use crate::core::errors::OdtError;
use crate::core::open::OdtDocument;
use crate::core::styles::OdtStylePart;
use crate::core::xml::{ElementRange, escape_xml_attr};

use super::paragraph_model::{
    ParagraphElement, ParagraphModel, ReadParagraphOptions, ReadParagraphSource, read_paragraph,
    runs_xml,
};
use super::props::{OdfAttrs, TextFormat, para_format_from_odf, text_format_from_odf};
use super::styles::{ooxml_p_pr, ooxml_r_pr, style_entry_for_odf};
use super::units::twips;

/// The list membership of `ParagraphOoxmlOptions.list`: a `BridgeListItem` and
/// the docx list kind of the level.
#[derive(Debug, Clone)]
pub struct ParagraphList {
    pub item: BridgeListItem,
    pub kind: GeneratedBlockListKind,
}

/// `ParagraphOoxmlOptions`
#[derive(Debug, Clone)]
pub struct ParagraphOoxmlOptions {
    pub part: OdtStylePart,
    /// converter id recorded as the paragraph's owner (default `text`)
    pub owner: Option<String>,
    /// bridge block containing the paragraph, or `None`
    pub block: Option<usize>,
    /// list membership; `kind` is the docx list kind of the level
    pub list: Option<ParagraphList>,
}

impl Default for ParagraphOoxmlOptions {
    fn default() -> Self {
        Self {
            part: OdtStylePart::ContentXml,
            owner: None,
            block: None,
            list: None,
        }
    }
}

/// `ParagraphOoxml`
#[derive(Debug, Clone)]
pub struct ParagraphOoxml {
    /// the `w:p` element
    pub xml: String,
    pub paragraph: BridgeParagraph,
    pub model: ParagraphModel,
}

/// `ParagraphStyleInfo`: the paragraph-level facts of an ODF paragraph style,
/// as the bridge maps them.
#[derive(Debug, Clone)]
pub struct ParagraphStyleInfo {
    /// docx style id for `w:pStyle`, if any
    pub style_id: Option<String>,
    /// own paragraph properties written as direct formatting
    pub own_paragraph: OdfAttrs,
    /// own text properties applied to every run
    pub own_text: OdfAttrs,
    /// text properties the docx paragraph style chain gives every run (resolved common style)
    pub style_text: OdfAttrs,
    /// effective tab stops
    pub tab_stops: Option<Vec<OdfAttrs>>,
    /// effective left margin (twips)
    pub margin_left: f64,
    /// effective `fo:break-after` is `page`
    pub break_after: bool,
}

/// `paragraphStyleInfo` (`ctx` is `Pick<OdfToOoxmlContext, 'doc' | 'map'>`).
pub fn paragraph_style_info(
    doc: &OdtDocument,
    map: &BridgeMap,
    part: OdtStylePart,
    style_name: Option<&str>,
) -> ParagraphStyleInfo {
    let scope = part.scope();
    let style = style_name.and_then(|name| doc.styles.find(name, "paragraph", scope));
    let Some(style) = style else {
        return ParagraphStyleInfo {
            style_id: None,
            own_paragraph: OdfAttrs::new(),
            own_text: OdfAttrs::new(),
            style_text: OdfAttrs::new(),
            tab_stops: None,
            margin_left: 0.0,
            break_after: false,
        };
    };
    let resolved = doc.styles.resolve(&style.name, "paragraph", scope);
    let common: Option<&str> = if style.automatic {
        style.parent_name.as_deref()
    } else {
        Some(style.name.as_str())
    };
    let pp = resolved
        .as_ref()
        .and_then(|r| r.properties.get("style:paragraph-properties"))
        .cloned()
        .unwrap_or_default();
    ParagraphStyleInfo {
        style_id: style_entry_for_odf(map, common).map(|e| e.style_id.clone()),
        own_paragraph: if style.automatic {
            style
                .properties
                .get("style:paragraph-properties")
                .cloned()
                .unwrap_or_default()
        } else {
            OdfAttrs::new()
        },
        own_text: if style.automatic {
            style
                .properties
                .get("style:text-properties")
                .cloned()
                .unwrap_or_default()
        } else {
            OdfAttrs::new()
        },
        style_text: match common {
            None => OdfAttrs::new(),
            Some(common) => doc
                .styles
                .resolve(common, "paragraph", scope)
                .and_then(|r| r.properties.get("style:text-properties").cloned())
                .unwrap_or_default(),
        },
        tab_stops: resolved.as_ref().and_then(|r| r.tab_stops.clone()),
        margin_left: twips(pp.get("fo:margin-left").map(String::as_str)).unwrap_or(0.0),
        break_after: pp.get("fo:break-after").map(String::as_str) == Some("page"),
    }
}

/// An insertion point of one paragraph: a marker's bookmark or a converter splice.
struct Insert {
    offset: usize,
    seq: usize,
    xml: String,
}

/// `formatOf`: the run format of a frame set, built once per set.
fn format_of(
    ctx: &mut OdfToOoxmlContext,
    cache: &mut HashMap<usize, Run>,
    model: &ParagraphModel,
    style: &ParagraphStyleInfo,
    inherited: &TextFormat,
    font_faces: &jscompat::JsMap<String>,
    set: usize,
) -> Result<Run, OdtError> {
    if let Some(r) = cache.get(&set) {
        return Ok(r.clone());
    }
    let s = &model.sets[set];
    let mut merged = style.own_text.clone();
    merged.assign(&s.attrs);
    let mut r = Run::default();
    r.text.set(String::new());
    r.assign(&text_format_from_odf(&merged, font_faces));
    if let Some(href) = &s.href {
        r.link.set(RunLink {
            href: href.clone(),
            r_id: None,
            tooltip: None,
            plain: Some(true),
        });
    }
    let offs = explicit_offs(&r, inherited);
    if !offs.is_empty() {
        let mut fmt = r.clone();
        fmt.text.delete();
        fmt.link.delete();
        r.raw_r_pr
            .set(with_children(&ooxml_r_pr(ctx, &fmt)?, &offs));
    }
    cache.insert(set, r.clone());
    Ok(r)
}

/// `paragraphToOoxml`: converts the paragraph at `range` of `opts.part` and
/// records it in the bridge map.
pub fn paragraph_to_ooxml(
    ctx: &mut OdfToOoxmlContext,
    range: &ElementRange,
    opts: &ParagraphOoxmlOptions,
) -> Result<ParagraphOoxml, OdtError> {
    let id = ctx.reserve_paragraph_id();
    let info = ctx.part(opts.part);
    let doc = ctx.doc.clone();
    let model = read_paragraph(
        &ReadParagraphSource {
            info: &info,
            styles: &doc.styles,
        },
        *range,
        ReadParagraphOptions {
            forward: Some((&mut *ctx, id)),
            record: None,
        },
    )?;
    let style = paragraph_style_info(&doc, &ctx.map, opts.part, model.style_name.as_deref());
    let mut format = para_format_from_odf(
        &style.own_paragraph,
        style.tab_stops.as_deref(),
        style.margin_left,
    );

    // runs per character group
    let styles_info = ctx.part(OdtStylePart::StylesXml);
    let inherited = text_format_from_odf(&style.style_text, &styles_info.font_faces);
    let mut run_format: HashMap<usize, Run> = HashMap::new();
    let mut text = model.text.clone();
    let mut char_sets = model.char_sets.clone();
    if style.break_after {
        text.push('\u{c}');
        let set = match char_sets.last() {
            Some(last) => (*last).max(0),
            None => model.empty_set as i64,
        };
        char_sets.push(set);
    }
    if text.is_empty() {
        let empty = format_of(
            ctx,
            &mut run_format,
            &model,
            &style,
            &inherited,
            &info.font_faces,
            model.empty_set,
        )?;
        if let Some(size) = empty.size_half_points.filter(|s| number_truthy(s.0)) {
            format.empty_run_size_half_points.set(size);
        }
    }

    // insertion points: markers with OOXML bookmarks, converter splices
    let mut inserts: Vec<Insert> = Vec::new();
    for (i, m) in model.markers.iter().enumerate() {
        let Some(ooxml_name) = &m.ooxml_name else {
            continue;
        };
        let seq = model.marker_seq[i];
        if m.kind == BridgeMarkerKind::BookmarkStart && m.pair.is_some() {
            let bid = ctx.allocate_bookmark_id();
            inserts.push(Insert {
                offset: m.offset.0 as usize,
                seq,
                xml: format!(
                    "<w:bookmarkStart w:id=\"{bid}\" w:name=\"{}\"/>",
                    escape_xml_attr(ooxml_name)
                ),
            });
            let pair = m.pair.unwrap_or(0);
            let end = &model.markers[pair];
            inserts.push(Insert {
                offset: end.offset.0 as usize,
                seq: model.marker_seq[pair],
                xml: format!("<w:bookmarkEnd w:id=\"{bid}\"/>"),
            });
            continue;
        }
        if m.kind == BridgeMarkerKind::BookmarkEnd && m.pair.is_some() {
            continue;
        }
        let bid = ctx.allocate_bookmark_id();
        inserts.push(Insert {
            offset: m.offset.0 as usize,
            seq,
            xml: format!(
                "<w:bookmarkStart w:id=\"{bid}\" w:name=\"{}\"/><w:bookmarkEnd w:id=\"{bid}\"/>",
                escape_xml_attr(ooxml_name)
            ),
        });
    }
    for s in &model.splices {
        inserts.push(Insert {
            offset: s.offset.0 as usize,
            seq: s.seq,
            xml: s.xml.clone(),
        });
    }
    inserts.sort_by(|a, b| a.offset.cmp(&b.offset).then(a.seq.cmp(&b.seq)));

    let units: Vec<u16> = text.encode_utf16().collect();
    let mut body = String::new();
    let mut at = 0usize;
    // `flushRuns`
    let flush_runs = |ctx: &mut OdfToOoxmlContext,
                      cache: &mut HashMap<usize, Run>,
                      body: &mut String,
                      at: &mut usize,
                      to: usize|
     -> Result<(), OdtError> {
        let mut runs: Vec<Run> = Vec::new();
        let mut i = *at;
        while i < to {
            let set = char_sets.get(i).copied();
            let Some(set) = set.filter(|s| *s >= 0) else {
                // a converter's character (set < 0) belongs to its splice
                if set.is_some() {
                    i += 1;
                    continue;
                }
                break;
            };
            let mut j = i;
            while j < to && char_sets.get(j).copied() == Some(set) {
                j += 1;
            }
            let mut run = format_of(
                ctx,
                cache,
                &model,
                &style,
                &inherited,
                &info.font_faces,
                set as usize,
            )?;
            run.text
                .set(String::from_utf16_lossy(&units[i..j.min(units.len())]));
            runs.push(run);
            i = j;
        }
        body.push_str(&runs_xml(ctx, &runs)?);
        *at = to;
        Ok(())
    };
    for ins in &inserts {
        flush_runs(ctx, &mut run_format, &mut body, &mut at, ins.offset)?;
        body.push_str(&ins.xml);
    }
    flush_runs(ctx, &mut run_format, &mut body, &mut at, units.len())?;

    let list = opts.list.as_ref();
    let mut block: GeneratedBlock = if let Some(list) = list {
        GeneratedBlock {
            r#type: GeneratedBlockType::ListItem,
            style_id: style.style_id.clone(),
            list: Some(GeneratedBlockList {
                kind: list.kind,
                num_id: list.item.num_id.clone(),
                ilvl: JsNum(math_min(8.0, list.item.level as f64)),
            }),
            format: Some(format),
            ..super::paragraph_model::paragraph_block(Vec::new())
        }
    } else if model.element == ParagraphElement::H {
        GeneratedBlock {
            r#type: GeneratedBlockType::Heading,
            level: Some(JsNum(math_min(
                9.0,
                model.outline_level.unwrap_or(1) as f64,
            ))),
            outline_only: Some(true),
            style_id: style.style_id.clone(),
            format: Some(format),
            ..super::paragraph_model::paragraph_block(Vec::new())
        }
    } else {
        GeneratedBlock {
            r#type: GeneratedBlockType::Paragraph,
            style_id: style.style_id.clone(),
            format: Some(format),
            ..super::paragraph_model::paragraph_block(Vec::new())
        }
    };
    if list.is_some_and(|l| l.item.header || l.item.continuation) {
        // a list header / continuation paragraph shows no number
        block.r#type = GeneratedBlockType::Paragraph;
        block.list = None;
    }
    let p_pr = ooxml_p_pr(ctx, &block)?;
    let id_bookmark = ctx.allocate_bookmark_id();
    let xml = format!(
        "<w:p>{p_pr}<w:bookmarkStart w:id=\"{id_bookmark}\" w:name=\"{}\"/><w:bookmarkEnd w:id=\"{id_bookmark}\"/>{body}</w:p>",
        paragraph_identity_name(id)
    );
    let paragraph = BridgeParagraph {
        id,
        part: opts.part,
        start: info.xml.to_u16(range.start),
        end: info.xml.to_u16(range.end),
        element: match model.element {
            ParagraphElement::P => BridgeParagraphElement::TextP,
            ParagraphElement::H => BridgeParagraphElement::TextH,
        },
        style_name: model.style_name.clone(),
        text,
        markers: model.markers.clone(),
        p_pr,
        list: list.map(|l| BridgeListItem {
            num_id: l.item.num_id.clone(),
            level: l.item.level,
            header: l.item.header,
            continuation: l.item.continuation,
        }),
        owner: opts.owner.clone().unwrap_or_else(|| "text".to_owned()),
        block: opts.block,
    };
    ctx.add_paragraph(paragraph.clone());
    Ok(ParagraphOoxml {
        xml,
        paragraph,
        model,
    })
}

/// `RPR_ORDER`: schema order of the run properties written here.
const RPR_ORDER: [&str; 16] = [
    "w:rStyle",
    "w:rFonts",
    "w:b",
    "w:bCs",
    "w:i",
    "w:iCs",
    "w:strike",
    "w:color",
    "w:spacing",
    "w:w",
    "w:sz",
    "w:szCs",
    "w:highlight",
    "w:u",
    "w:shd",
    "w:vertAlign",
];

/// `explicitOffs`: explicit "off" toggles a run needs because its paragraph's
/// docx style turns them on while the ODF span says normal (the engine model
/// only writes "on").
fn explicit_offs(run: &TextFormat, inherited: &TextFormat) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if *run.bold == Some(false) && inherited.bold.unwrap_or(false) {
        out.push("<w:b w:val=\"0\"/>".to_owned());
        out.push("<w:bCs w:val=\"0\"/>".to_owned());
    }
    if *run.italic == Some(false) && inherited.italic.unwrap_or(false) {
        out.push("<w:i w:val=\"0\"/>".to_owned());
        out.push("<w:iCs w:val=\"0\"/>".to_owned());
    }
    if *run.strike == Some(false) && inherited.strike.unwrap_or(false) {
        out.push("<w:strike w:val=\"0\"/>".to_owned());
    }
    if *run.underline == Some(false) && inherited.underline.unwrap_or(false) {
        out.push("<w:u w:val=\"none\"/>".to_owned());
    }
    out
}

/// `withChildren`
fn with_children(r_pr: &str, extra: &[String]) -> String {
    let inner = if r_pr.is_empty() {
        String::new()
    } else {
        slice_utf16(
            r_pr,
            "<w:rPr>".len() as f64,
            Some(-("</w:rPr>".len() as f64)),
        )
    };
    let mut children: Vec<String> = js_regex!(r"<w:[A-Za-z]+(?:\s[^>]*)?/>")
        .find_iter(&inner)
        .map(|m| m.as_str().to_owned())
        .collect();
    children.extend(extra.iter().cloned());
    let rank = |c: &str| {
        let name = crate::text::style_xml::tag_name(c).unwrap_or("");
        RPR_ORDER
            .iter()
            .position(|n| *n == name)
            .unwrap_or(RPR_ORDER.len())
    };
    children.sort_by_key(|c| rank(c));
    format!("<w:rPr>{}</w:rPr>", children.concat())
}
