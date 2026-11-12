//! `text/paragraph-odf.ts`: OOXML to ODF for one paragraph the editor changed
//! (or created).
//!
//! Style: when the paragraph continues an original one, a changed format
//! creates a NEW automatic style that is a byte copy of the original automatic
//! style (tab stops, Hancom attributes, unknown children) with only the changed
//! attributes overridden; ODF automatic styles cannot be parents of automatic
//! styles. An unchanged format keeps the original style name. A brand-new
//! paragraph gets an automatic style whose parent is the common style of its
//! docx style, or the document's base paragraph style.
//!
//! Text: every edited character is mapped onto an original character (common
//! prefix/suffix of the two texts; replaced text positionally). Runs whose
//! formatting equals that character's original formatting keep the original
//! span/link markup; others get a copy of the original span style with the
//! changed text properties overridden.
//!
//! Markers: bookmarks (Hancom form fields included) and kept inline elements
//! are re-emitted byte for byte at their mapped offsets. A form-field pair keeps
//! typed text inside it, becomes an empty pair when its text was deleted, and
//! disappears only with its paragraph.
//!
//! Offsets: the paragraph texts are walked by UTF-16 code unit, as the bridge
//! counts them. A surrogate pair is written as one step: the TypeScript walks
//! its halves apart, which a Rust string cannot hold between two writes.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use docx_engine::model::{
    Block, BlockList, BlockListKind, BlockType, ParaFormat, Run, TableParagraph,
    TableParagraphListKind,
};
use jscompat::{js_regex, number_to_string};

use crate::core::convert::{
    Attach, BridgeMarkerKind, BridgeParagraph, EditedParagraph, EditedParagraphType, MapBias,
    OoxmlToOdfContext, ParagraphWriteEnv, Scratch,
};
use crate::core::errors::OdtError;
use crate::core::styles::{OdtStyle, OdtStylePart};
use crate::core::xml::{ElementRange, PrefixMap, escape_xml_attr, escape_xml_text, slice};
use crate::offset::{U16, u16_len};

use super::align::{Bias, TextAlignment, align_texts};
use super::markers::{Placement, place_markers};
use super::paragraph_model::{
    Frame, ParagraphElement, ParagraphModel, ReadParagraphOptions, ReadParagraphSource,
    read_paragraph,
};
use super::paragraph_ooxml::paragraph_style_info;
use super::props::{
    AttrOverrides, TextKeys, changed_para_keys, changed_text_keys, cleared_to_inherited,
    para_format_from_odf, para_keys, para_overrides, text_format_from_odf, text_keys,
    text_overrides,
};
use super::style_xml::{StyleXmlEdit, edit_style_xml, new_style_xml, patch_start_tag};
use super::styles::style_entry_by_id;
use super::units::half_points_to_pt;

/// `editedParagraphFromBlock`
pub fn edited_paragraph_from_block(b: &Block) -> EditedParagraph {
    EditedParagraph {
        r#type: match *b.r#type {
            Some(BlockType::Heading) => EditedParagraphType::Heading,
            Some(BlockType::ListItem) => EditedParagraphType::ListItem,
            _ => EditedParagraphType::Paragraph,
        },
        runs: (*b.runs).clone().unwrap_or_default(),
        format: (*b.format).clone(),
        style_id: (*b.style_id).clone(),
        level: *b.level,
        outline_only: *b.outline_only,
        list: (*b.list).clone(),
        raw_p_pr: (*b.raw_p_pr).clone(),
        hidden_bookmarks: (*b.hidden_bookmarks).clone(),
    }
}

/// `editedParagraphFromTableParagraph`: a table-cell paragraph of the engine's
/// table model, for the paragraph writer.
pub fn edited_paragraph_from_table_paragraph(p: &TableParagraph) -> EditedParagraph {
    EditedParagraph {
        r#type: if p.list.is_some() {
            EditedParagraphType::ListItem
        } else {
            EditedParagraphType::Paragraph
        },
        runs: p.runs.clone(),
        format: Some(p.para_format.clone()),
        style_id: p.style_id.clone(),
        level: None,
        outline_only: None,
        list: p.list.as_ref().map(|l| BlockList {
            kind: match l.kind {
                TableParagraphListKind::Bullet => BlockListKind::Bullet,
                TableParagraphListKind::Ordered => BlockListKind::Ordered,
            },
            num_id: l.num_id.clone(),
            ilvl: l.ilvl,
        }),
        raw_p_pr: None,
        hidden_bookmarks: None,
    }
}

/// `ParagraphWriteOptions`
#[derive(Debug, Clone)]
pub struct ParagraphWriteOptions<'a> {
    pub part: OdtStylePart,
    /// an original paragraph next to a NEW one: its text styles are reused when formatting matches
    pub neighbour: Option<&'a BridgeParagraph>,
    /// The original paragraph a NEW one directly follows (the first half of an
    /// Enter split, or the paragraph it was typed after). When both have the same
    /// docx style, the new paragraph's style is derived from this paragraph's
    /// automatic style (all its properties, tab list and Hancom attributes
    /// included) instead of from the common style.
    pub follows: Option<&'a BridgeParagraph>,
    /// Markers already placed on this paragraph's text (by `place_markers` over a
    /// split or joined sequence); default: the origin's markers mapped onto it.
    pub placements: Option<&'a [Placement]>,
}

impl Default for ParagraphWriteOptions<'_> {
    fn default() -> Self {
        Self {
            part: OdtStylePart::ContentXml,
            neighbour: None,
            follows: None,
            placements: None,
        }
    }
}

/// `modelCache`: per context, the original models by paragraph id.
#[derive(Default)]
struct ModelCache(HashMap<usize, Option<Rc<ParagraphModel>>>);

/// `originalModel`: the original paragraph re-read with its character frames
/// (`None` when it no longer matches its record).
pub fn original_model(
    rctx: &mut OoxmlToOdfContext,
    record: &BridgeParagraph,
) -> Result<Option<Rc<ParagraphModel>>, OdtError> {
    if let Some(cached) = rctx.state::<ModelCache>().0.get(&record.id) {
        return Ok(cached.clone());
    }
    let info = rctx.part(record.part);
    let doc = Rc::clone(&rctx.doc);
    let xml: &str = &info.xml.text;
    let start = info.xml.to_byte(record.start);
    let end = info.xml.to_byte(record.end);
    let head_end = xml[start.min(xml.len())..]
        .find('>')
        .map_or(0, |gt| start + gt + 1);
    let head = slice(xml, start, head_end);
    let self_closing = head.ends_with("/>");
    let close_start = if self_closing {
        end
    } else {
        // `xml.lastIndexOf('<', record.end - 1)`
        xml[..end.min(xml.len())].rfind('<').unwrap_or(0)
    };
    let mut model = read_paragraph(
        &ReadParagraphSource {
            info: &info,
            styles: &doc.styles,
        },
        ElementRange {
            start,
            open_end: start + head.len(),
            close_start,
            end,
            self_closing,
        },
        ReadParagraphOptions {
            forward: None,
            record: Some(record),
        },
    )?;
    let text = if record.text.ends_with('\u{c}') && !model.text.ends_with('\u{c}') {
        format!("{}\u{c}", model.text)
    } else {
        model.text.clone()
    };
    let ok = text == record.text;
    if !ok {
        rctx.warn(&format!(
            "paragraph {}: original text no longer matches its record",
            record.id
        ));
    }
    if ok && u16_len(&text).0 > u16_len(&model.text).0 {
        let fill = model
            .char_sets
            .last()
            .copied()
            .unwrap_or(model.empty_set as i64);
        model.char_sets.push(fill);
    }
    let result = if ok { Some(Rc::new(model)) } else { None };
    rctx.state::<ModelCache>()
        .0
        .insert(record.id, result.clone());
    Ok(result)
}

/// `Insert`
#[derive(Debug, Clone)]
struct Insert {
    offset: usize,
    xml: String,
    attach: Attach,
    /// document order among inserts at the same offset
    seq: u64,
    /// characters of the edited text this insert replaces (text atoms)
    replaces: Option<usize>,
}

/// `ownAttr`
fn own_attr<'a>(style: Option<&'a OdtStyle>, path: &str, name: &str) -> Option<&'a str> {
    style
        .and_then(|s| s.properties.get(path))
        .and_then(|p| p.get(name))
        .map(String::as_str)
}

/// `JSON.stringify` of a value built here (a derived-style cache key).
fn json_key(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// The values `paragraphToOdf` reads while it writes one paragraph, and the
/// caches of its closures.
struct Writer<'a> {
    part: OdtStylePart,
    scope: crate::core::styles::OdtStyleScope,
    doc: Rc<crate::core::open::OdtDocument>,
    info: Rc<crate::core::convert::OdtPartInfo>,
    prefixes: Rc<PrefixMap>,
    runs: &'a [Run],
    /// the model whose frames the text takes: the origin's, or a neighbour's
    tpl_model: Option<Rc<ParagraphModel>>,
    /// the origin's own model
    model: Option<Rc<ParagraphModel>>,
    original_len: u32,
    mapper: Rc<TextAlignment>,
    own_text: super::props::OdfAttrs,
    /// what a docx run inherits from its paragraph style chain (cleared run values)
    inherited: TextKeys,
    run_keys: Vec<TextKeys>,
    keys_cache: HashMap<i64, TextKeys>,
    frame_cache: HashMap<(usize, i64), Rc<Vec<Frame>>>,
}

impl Writer<'_> {
    /// `templateSet`
    fn template_set(&self, i: usize) -> i64 {
        let Some(tpl) = &self.tpl_model else {
            return -1;
        };
        let Some(model) = &self.model else {
            // a new paragraph next to an original one: its last character's styles
            let last = tpl
                .char_sets
                .iter()
                .copied()
                .filter(|s| *s >= 0)
                .next_back();
            return last.unwrap_or(tpl.empty_set as i64);
        };
        let o_len = self.original_len as i64;
        if o_len == 0 {
            return model.empty_set as i64;
        }
        let idx = self.mapper.original_of(U16(i as u32)).min(o_len - 1).max(0);
        if let Some(set) = model.char_sets.get(idx as usize).copied() {
            if set >= 0 {
                return set;
            }
        }
        let mut k = idx;
        while k >= 0 {
            if model.char_sets.get(k as usize).is_some_and(|s| *s >= 0) {
                return model.char_sets[k as usize];
            }
            k -= 1;
        }
        model.empty_set as i64
    }

    /// `templateKeys`
    fn template_keys(&mut self, set: i64) -> TextKeys {
        if let Some(k) = self.keys_cache.get(&set) {
            return k.clone();
        }
        let attrs = match (&self.tpl_model, set >= 0) {
            (Some(tpl), true) => tpl.sets[set as usize].attrs.clone(),
            _ => super::props::OdfAttrs::new(),
        };
        let mut merged = self.own_text.clone();
        merged.assign(&attrs);
        let k = text_keys(Some(&text_format_from_odf(&merged, &self.info.font_faces)));
        self.keys_cache.insert(set, k.clone());
        k
    }

    /// `framesFor`
    fn frames_for(
        &mut self,
        rctx: &mut OoxmlToOdfContext,
        run_index: usize,
        set: i64,
    ) -> Result<Rc<Vec<Frame>>, OdtError> {
        if let Some(cached) = self.frame_cache.get(&(run_index, set)) {
            return Ok(Rc::clone(cached));
        }
        let runs = self.runs;
        let run = &runs[run_index];
        let from_template = set >= 0 && self.tpl_model.is_some();
        let mut frames: Vec<Frame> = if from_template {
            self.tpl_model
                .as_ref()
                .map_or_else(Vec::new, |t| t.sets[set as usize].frames.clone())
        } else {
            Vec::new()
        };
        let href: Option<String> = if from_template {
            self.tpl_model
                .as_ref()
                .and_then(|t| t.sets[set as usize].href.clone())
        } else {
            None
        };
        let link: Option<String> = run.link.as_ref().map(|l| l.href.clone());
        if link != href {
            frames.retain(|f| !f.is_link());
            if let Some(link) = &link {
                frames.insert(
                    0,
                    Frame::A {
                        href: link.clone(),
                        style: None,
                        open: format!(
                            "<text:a xlink:type=\"simple\" xlink:href=\"{}\">",
                            escape_xml_attr(link)
                        ),
                        close: "</text:a>".to_owned(),
                    },
                );
            }
        }
        let template = self.template_keys(set);
        let changed = changed_text_keys(&template, &self.run_keys[run_index]);
        if !changed.is_empty() {
            let target = cleared_to_inherited(&changed, &self.run_keys[run_index], &self.inherited);
            let part = self.part;
            let over = text_overrides(&changed, &target, &mut |family: &str| {
                rctx.font_face(part, family)
            });
            let span_at = frames.iter().rposition(|f| matches!(f, Frame::Span { .. }));
            let span: Option<Frame> = span_at.map(|i| frames[i].clone());
            let span_style: Option<Rc<OdtStyle>> = span
                .as_ref()
                .and_then(|s| s.style())
                .and_then(|n| self.doc.styles.find(n, "text", self.scope));
            let base: Option<Rc<OdtStyle>> = span_style
                .clone()
                .filter(|s| s.automatic && s.part == self.part);
            let mut effective = AttrOverrides::new();
            for (k, v) in over.entries() {
                if base.is_none()
                    || own_attr(base.as_deref(), "style:text-properties", k) != v.as_deref()
                {
                    effective.set(k, v.clone());
                }
            }
            if !effective.is_empty() {
                let parent: Option<String> = if base.is_some() {
                    None
                } else {
                    span_style.as_ref().map(|s| s.name.clone())
                };
                let key = json_key(&serde_json::json!([
                    base.as_ref().map(|b| b.name.clone()),
                    parent.clone(),
                    effective
                ]));
                let base_xml = base
                    .as_ref()
                    .map(|b| slice(&self.info.xml.text, b.start, b.end).to_owned());
                let base_name = base.as_ref().map(|b| b.name.clone());
                let prefixes = Rc::clone(&self.prefixes);
                let mut failed: Option<OdtError> = None;
                let name =
                    rctx.derived_style(self.part, &key, base_name.as_deref().unwrap_or("T"), |n| {
                        let mut props: jscompat::JsObject<AttrOverrides> =
                            jscompat::JsObject::new();
                        props.set("style:text-properties", effective.clone());
                        let built = match &base_xml {
                            Some(xml) => {
                                let mut element = AttrOverrides::new();
                                element.set("style:display-name", None);
                                edit_style_xml(
                                    xml,
                                    &prefixes,
                                    &StyleXmlEdit {
                                        name: Some(n.to_owned()),
                                        attrs: Some(element),
                                        props: Some(props),
                                        ..Default::default()
                                    },
                                )
                            }
                            None => edit_style_xml(
                                &new_style_xml(n, "text", parent.as_deref()),
                                &prefixes,
                                &StyleXmlEdit {
                                    props: Some(props),
                                    ..Default::default()
                                },
                            ),
                        };
                        match built {
                            Ok(xml) => xml,
                            Err(e) => {
                                failed = Some(e);
                                String::new()
                            }
                        }
                    });
                if let Some(e) = failed {
                    return Err(e);
                }
                match (span_at, span) {
                    (Some(at), Some(Frame::Span { open, close, .. })) => {
                        let mut name_override = AttrOverrides::new();
                        name_override.set("text:style-name", Some(name.clone()));
                        frames[at] = Frame::Span {
                            style: Some(name.clone()),
                            open: patch_start_tag(&open, &self.prefixes, &name_override)?,
                            close,
                        };
                    }
                    _ => frames.push(Frame::Span {
                        style: Some(name.clone()),
                        open: format!("<text:span text:style-name=\"{}\">", escape_xml_attr(&name)),
                        close: "</text:span>".to_owned(),
                    }),
                }
            }
        }
        let frames = Rc::new(frames);
        self.frame_cache
            .insert((run_index, set), Rc::clone(&frames));
        Ok(frames)
    }

    /// `templateFrames`
    fn template_frames(&self, k: usize) -> Rc<Vec<Frame>> {
        let set = self.template_set(k);
        match (&self.tpl_model, set >= 0) {
            (Some(tpl), true) => Rc::new(tpl.sets[set as usize].frames.clone()),
            _ => Rc::new(Vec::new()),
        }
    }
}

/// `isCharacterObjectXml`: ODF markup that starts with a drawing anchored as a
/// character (it takes a character position).
fn is_character_object_xml(xml: &str) -> bool {
    let Some(tag) = js_regex!(r"^<([\w.-]+):[\w.-]+(?=[\s/>])[^>]*>").exec(xml) else {
        return false;
    };
    tag.get(1) == Some("draw")
        && js_regex!(r#"\stext:anchor-type\s*=\s*["']as-char["']"#).test(tag.as_str())
}

/// `paragraphToOdf`: writes the ODF for an edited paragraph. Usually one
/// `text:p`/`text:h`; a page break typed inside the paragraph splits it (ODF has
/// no inline page break), the later part starting on a new page.
pub fn paragraph_to_odf(
    rctx: &mut OoxmlToOdfContext,
    para: &EditedParagraph,
    origin: Option<&BridgeParagraph>,
    opts: &ParagraphWriteOptions<'_>,
) -> Result<String, OdtError> {
    let part = opts.part;
    let info = rctx.part(part);
    let prefixes = Rc::clone(&info.prefixes);
    let doc = Rc::clone(&rctx.doc);
    let runs = &para.runs;
    let edited: String = runs
        .iter()
        .map(|r| r.text.as_deref().unwrap_or(""))
        .collect();
    let original: &str = origin.map_or("", |o| o.text.as_str());
    let mapper = Rc::new(align_texts(original, &edited));
    let env = ParagraphWriteEnv {
        origin: origin.cloned(),
        part,
        text: edited.clone(),
        map_offset: {
            let mapper = Rc::clone(&mapper);
            Box::new(move |offset, bias| {
                mapper.map(
                    offset,
                    match bias {
                        MapBias::Start => Bias::Start,
                        MapBias::End => Bias::End,
                    },
                )
            })
        },
        scratch: Scratch::default(),
    };
    let model: Option<Rc<ParagraphModel>> = match origin {
        Some(o) => original_model(rctx, o)?,
        None => None,
    };
    let neighbour_model: Option<Rc<ParagraphModel>> = match (origin, opts.neighbour) {
        (None, Some(n)) => original_model(rctx, n)?,
        _ => None,
    };

    // ---- paragraph style
    // the original whose style this paragraph continues: its own, or for a new
    // paragraph the one it follows when both have the same docx style
    let mut template: Option<&BridgeParagraph> = origin;
    if origin.is_none() {
        if let Some(follows) = opts.follows.filter(|f| f.part == part) {
            let followed =
                paragraph_style_info(&doc, &rctx.map, part, follows.style_name.as_deref());
            if followed.style_id == para.style_id {
                template = Some(follows);
            }
        }
    }
    let continues = origin.is_none() && template.is_some();
    let style_info = paragraph_style_info(
        &doc,
        &rctx.map,
        part,
        template.and_then(|t| t.style_name.as_deref()),
    );
    let scope = part.scope();
    let base_style: Option<Rc<OdtStyle>> = template
        .and_then(|t| t.style_name.as_deref())
        .and_then(|n| doc.styles.find(n, "paragraph", scope));
    let f0 = if template.is_some() {
        para_format_from_odf(
            &style_info.own_paragraph,
            style_info.tab_stops.as_deref(),
            style_info.margin_left,
        )
    } else {
        ParaFormat::default()
    };
    let k0 = para_keys(Some(&f0));
    let format_untouched = origin.is_some()
        && para.raw_p_pr.is_some()
        && para.raw_p_pr.as_deref() == origin.map(|o| o.p_pr.as_str());
    let keys = if format_untouched {
        Vec::new()
    } else {
        changed_para_keys(&k0, &para_keys(para.format.as_ref()))
    };
    let margin_after = para
        .format
        .as_ref()
        .and_then(|f| *f.indent_left)
        .map_or(style_info.margin_left, |n| n.0);
    let default_format = ParaFormat::default();
    let p_over = para_overrides(
        &keys,
        para.format.as_ref().unwrap_or(&default_format),
        margin_after,
        &k0,
    );
    let entry = style_entry_by_id(&rctx.map, para.style_id.as_deref()).cloned();
    let style_changed = origin.is_some() && para.style_id != style_info.style_id;
    let new_parent: Option<String> = entry
        .as_ref()
        .and_then(|e| e.odf_name.clone())
        .or_else(|| rctx.map.styles.base_paragraph_style.clone());
    let mut heading_text = AttrOverrides::new();
    if let Some(level) = entry
        .as_ref()
        .and_then(|e| e.heading_level)
        .filter(|l| *l != 0)
    {
        if template.is_none() || style_changed {
            let size = [32.0, 28.0, 26.0, 24.0, 22.0, 22.0]
                .get(level as usize - 1)
                .copied()
                .unwrap_or(24.0);
            let pt = half_points_to_pt(size);
            heading_text.set("fo:font-weight", Some("bold".to_owned()));
            heading_text.set("style:font-weight-asian", Some("bold".to_owned()));
            heading_text.set("style:font-weight-complex", Some("bold".to_owned()));
            heading_text.set("fo:font-size", Some(pt.clone()));
            heading_text.set("style:font-size-asian", Some(pt.clone()));
            heading_text.set("style:font-size-complex", Some(pt));
        }
    }

    // `styleFor`
    let style_for = |rctx: &mut OoxmlToOdfContext,
                     extra: &AttrOverrides|
     -> Result<Option<String>, OdtError> {
        let mut merged = p_over.attrs.clone();
        merged.assign(extra);
        let master_page: Option<Option<String>> = merged.get("style:master-page-name").cloned();
        let mut attrs = AttrOverrides::new();
        for (k, v) in merged.entries() {
            if k != "style:master-page-name" {
                attrs.set(k, v.clone());
            }
        }
        let base = base_style
            .as_deref()
            .filter(|b| b.automatic && b.part == part);
        // attributes of the style element itself (a section start lives there)
        let mut element = AttrOverrides::new();
        element.set("style:display-name", None);
        let drop_master = master_page == Some(None)
            && base.is_some_and(|b| b.master_page_name.as_deref().is_some_and(|m| !m.is_empty()));
        if drop_master {
            element.set("style:master-page-name", None);
        }
        let mut effective = AttrOverrides::new();
        for (k, v) in attrs.entries() {
            let cur = own_attr(base, "style:paragraph-properties", k);
            let differs = if base.is_some() {
                cur != v.as_deref()
            } else {
                v.is_some()
            };
            if differs {
                effective.set(k, v.clone());
            }
        }
        let mut text = AttrOverrides::new();
        for (k, v) in heading_text.entries() {
            if own_attr(base, "style:text-properties", k) != v.as_deref() {
                text.set(k, v.clone());
            }
        }
        let parent_change: Option<Option<String>> = if style_changed {
            Some(new_parent.clone())
        } else {
            None
        };
        let nothing = effective.is_empty()
            && p_over.tab_stops.is_none()
            && text.is_empty()
            && parent_change.is_none()
            && !drop_master;
        if template.is_some() && nothing {
            return Ok(template.and_then(|t| t.style_name.clone()));
        }
        let mut props: jscompat::JsObject<AttrOverrides> = jscompat::JsObject::new();
        if !effective.is_empty() {
            props.set("style:paragraph-properties", effective);
        }
        if !text.is_empty() {
            props.set("style:text-properties", text);
        }
        let key = json_key(&serde_json::json!([
            base.map(|b| b.name.clone()),
            if base.is_some() {
                None
            } else {
                template.and_then(|t| t.style_name.clone())
            },
            parent_change.clone().flatten(),
            props,
            p_over.tab_stops.clone(),
            if template.is_some() {
                None
            } else {
                new_parent.clone()
            },
            drop_master
        ]));
        let base_xml = base.map(|b| slice(&info.xml.text, b.start, b.end).to_owned());
        let base_name = base.map(|b| b.name.clone());
        let mut failed: Option<OdtError> = None;
        let name = rctx.derived_style(part, &key, base_name.as_deref().unwrap_or("P"), |name| {
            let built = match &base_xml {
                Some(xml) => edit_style_xml(
                    xml,
                    &prefixes,
                    &StyleXmlEdit {
                        name: Some(name.to_owned()),
                        parent: parent_change.clone(),
                        attrs: Some(element.clone()),
                        props: Some(props.clone()),
                        tab_stops: p_over.tab_stops.clone(),
                    },
                ),
                None => {
                    let parent: Option<String> = parent_change.clone().flatten().or_else(|| {
                        if template.is_some() {
                            template.and_then(|t| t.style_name.clone())
                        } else {
                            new_parent.clone()
                        }
                    });
                    edit_style_xml(
                        &new_style_xml(name, "paragraph", parent.as_deref()),
                        &prefixes,
                        &StyleXmlEdit {
                            props: Some(props.clone()),
                            tab_stops: p_over.tab_stops.clone(),
                            ..Default::default()
                        },
                    )
                }
            };
            match built {
                Ok(xml) => xml,
                Err(e) => {
                    failed = Some(e);
                    String::new()
                }
            }
        });
        match failed {
            Some(e) => Err(e),
            None => Ok(Some(name)),
        }
    };

    // ---- character templates
    let tpl_model = model.clone().or(neighbour_model);
    let own_text = if template.is_some() {
        style_info.own_text.clone()
    } else {
        super::props::OdfAttrs::new()
    };
    let inherited = text_keys(Some(&text_format_from_odf(
        &style_info.style_text,
        &rctx.part(OdtStylePart::StylesXml).font_faces,
    )));
    let mut writer = Writer {
        part,
        scope,
        doc: Rc::clone(&doc),
        info: Rc::clone(&info),
        prefixes: Rc::clone(&prefixes),
        runs,
        tpl_model,
        model: model.clone(),
        original_len: u16_len(original).0,
        mapper: Rc::clone(&mapper),
        own_text,
        inherited,
        run_keys: runs.iter().map(|r| text_keys(Some(r))).collect(),
        keys_cache: HashMap::new(),
        frame_cache: HashMap::new(),
    };

    // ---- inserts: markers, run writers, injectors
    let edited_units: Vec<u16> = edited.encode_utf16().collect();
    let edited_len = edited_units.len();
    let mut inserts: Vec<Insert> = Vec::new();
    let mut skip = vec![false; edited_len];
    let placed: Vec<Placement> = match opts.placements {
        Some(p) => p.to_vec(),
        None => match origin {
            Some(o) => place_markers(rctx, &[o], std::slice::from_ref(&edited))
                .placements
                .into_iter()
                .next()
                .unwrap_or_default(),
            None => Vec::new(),
        },
    };
    for x in &placed {
        inserts.push(Insert {
            offset: x.offset.0 as usize,
            xml: x.xml.clone(),
            attach: x.attach,
            seq: x.seq as u64,
            replaces: x.replaces.map(|r| r.0 as usize),
        });
        let mut k = x.offset.0 as usize;
        while k < x.offset.0 as usize + x.replaces.map_or(0, |r| r.0 as usize) && k < skip.len() {
            skip[k] = true;
            k += 1;
        }
    }
    // an atom continuing one of the origin's handler markers keeps that marker's
    // document order among the markers at its offset (a picture before a bookmark)
    let mut used_handlers: HashSet<usize> = HashSet::new();
    let registry = Rc::clone(&rctx.registry);
    let mut offset = 0usize;
    for (i, run) in runs.iter().enumerate() {
        let len = u16_len(run.text.as_deref().unwrap_or("")).0 as usize;
        if let Some(writer_) = registry.run_writer_for(run) {
            let seq = {
                match origin.filter(|_| opts.placements.is_none()) {
                    None => None,
                    Some(o) => {
                        let found = o.markers.iter().enumerate().position(|(k, m)| {
                            m.kind == BridgeMarkerKind::Handler
                                && m.owner.as_deref() == Some(writer_.id())
                                && !used_handlers.contains(&k)
                                && mapper.map(m.offset, Bias::Start).0 as usize == offset
                        });
                        if let Some(index) = found {
                            used_handlers.insert(index);
                        }
                        found.map(|i| i as u64)
                    }
                }
            }
            .unwrap_or(1_000_000_000 + i as u64);
            inserts.push(Insert {
                offset,
                xml: writer_.to_odf(rctx, run, &env)?,
                attach: Attach::Next,
                seq,
                replaces: None,
            });
            for k in offset..offset + len {
                if k < skip.len() {
                    skip[k] = true;
                }
            }
        } else if run.image.is_some() || run.note_ref.is_some() {
            rctx.warn(&format!(
                "dropped an unsupported {} in a paragraph",
                if run.image.is_some() {
                    "picture"
                } else {
                    "note reference"
                }
            ));
            for k in offset..offset + len {
                if k < skip.len() {
                    skip[k] = true;
                }
            }
        }
        offset += len;
    }
    for injector in registry.injectors.iter() {
        for x in injector.inject(rctx, para, &env)? {
            let seq = 2_000_000_000 + inserts.len() as u64;
            inserts.push(Insert {
                offset: x.offset.0 as usize,
                xml: x.xml,
                attach: x.attach.unwrap_or(Attach::Next),
                seq,
                replaces: None,
            });
        }
    }
    inserts.sort_by(|a, b| a.offset.cmp(&b.offset).then(a.seq.cmp(&b.seq)));

    // ---- emission
    let mut run_at: Vec<usize> = Vec::new();
    for (i, r) in runs.iter().enumerate() {
        for _ in 0..u16_len(r.text.as_deref().unwrap_or("")).0 {
            run_at.push(i);
        }
    }
    let mut bodies: Vec<String> = Vec::new();
    let mut body = String::new();
    let mut open: Rc<Vec<Frame>> = Rc::new(Vec::new());
    let mut space_ok = false;
    // `switchTo`
    fn switch_to(body: &mut String, open: &mut Rc<Vec<Frame>>, target: Rc<Vec<Frame>>) {
        let mut common = 0usize;
        while common < open.len()
            && common < target.len()
            && open[common].open() == target[common].open()
        {
            common += 1;
        }
        for k in (common..open.len()).rev() {
            body.push_str(open[k].close());
        }
        for frame in target.iter().skip(common) {
            body.push_str(frame.open());
        }
        *open = target;
    }
    // `framesAt`
    fn frames_at(
        writer: &mut Writer<'_>,
        rctx: &mut OoxmlToOdfContext,
        edited_units: &[u16],
        skip: &[bool],
        run_at: &[usize],
        k: usize,
    ) -> Result<Option<Rc<Vec<Frame>>>, OdtError> {
        if k < edited_units.len() && !skip[k] && edited_units[k] != 0x0c {
            let set = writer.template_set(k);
            Ok(Some(writer.frames_for(rctx, run_at[k], set)?))
        } else {
            Ok(None)
        }
    }
    let mut ins = 0usize;
    let mut k = 0usize;
    loop {
        let mut here: Vec<Insert> = Vec::new();
        while ins < inserts.len() && inserts[ins].offset <= k {
            here.push(inserts[ins].clone());
            ins += 1;
        }
        // document order; a start-like insert sits inside the following text's spans
        for x in &here {
            if x.attach == Attach::Next {
                // skipped characters belong to atoms: they sit in the original spans as they were
                let target = match frames_at(&mut writer, rctx, &edited_units, &skip, &run_at, k)? {
                    Some(t) => Some(t),
                    None if k < edited_len && skip[k] => Some(writer.template_frames(k)),
                    None => None,
                };
                if let Some(target) = target {
                    switch_to(&mut body, &mut open, target);
                }
            }
            body.push_str(&x.xml);
            // markers are not text: a literal space after one is still leading/collapsed;
            // a drawing placed as a character is one, so a space after it is kept
            if x.replaces.is_some_and(|r| r != 0) || is_character_object_xml(&x.xml) {
                space_ok = true;
            }
        }
        if k == edited_len {
            break;
        }
        if skip[k] {
            k += 1;
            continue;
        }
        let unit = edited_units[k];
        if unit == 0x0c {
            switch_to(&mut body, &mut open, Rc::new(Vec::new()));
            bodies.push(std::mem::take(&mut body));
            space_ok = false;
            k += 1;
            continue;
        }
        let set = writer.template_set(k);
        let target = writer.frames_for(rctx, run_at[k], set)?;
        switch_to(&mut body, &mut open, target);
        match unit {
            0x09 => {
                body.push_str("<text:tab/>");
                space_ok = true;
                k += 1;
            }
            0x0a | 0x0b | 0x1e | 0x0d => {
                body.push_str("<text:line-break/>");
                space_ok = true;
                k += 1;
            }
            0x20 => {
                let mut n = 1usize;
                while k + n < edited_len && edited_units[k + n] == 0x20 && !skip[k + n] {
                    let next = frames_at(&mut writer, rctx, &edited_units, &skip, &run_at, k + n)?;
                    if !next.as_ref().is_some_and(|f| Rc::ptr_eq(f, &open)) {
                        break;
                    }
                    n += 1;
                }
                let at_end = k + n >= edited_len;
                if n == 1 && space_ok && !at_end {
                    body.push(' ');
                    // a second literal space would collapse into this one
                    space_ok = false;
                } else {
                    if space_ok && !at_end {
                        if n == 2 {
                            body.push_str(" <text:s/>");
                        } else {
                            body.push_str(&format!(" <text:s text:c=\"{}\"/>", n - 1));
                        }
                    } else if n == 1 {
                        body.push_str("<text:s/>");
                    } else {
                        body.push_str(&format!("<text:s text:c=\"{n}\"/>"));
                    }
                    space_ok = true;
                }
                k += n;
            }
            _ => {
                // a surrogate pair is one character
                let (text, width) = if (0xD800..0xDC00).contains(&unit)
                    && k + 1 < edited_len
                    && (0xDC00..0xE000).contains(&edited_units[k + 1])
                    && !skip[k + 1]
                {
                    (String::from_utf16_lossy(&edited_units[k..k + 2]), 2)
                } else {
                    (String::from_utf16_lossy(&edited_units[k..k + 1]), 1)
                };
                body.push_str(&escape_xml_text(&text));
                space_ok = true;
                k += width;
            }
        }
    }
    switch_to(&mut body, &mut open, Rc::new(Vec::new()));
    bodies.push(body);

    // ---- page breaks split the paragraph
    let mut pieces: Vec<String> = bodies;
    let mut break_after_last = false;
    if pieces.len() > 1 && pieces[pieces.len() - 1].is_empty() {
        pieces.pop();
        break_after_last = true;
    }
    let mut break_before_first = false;
    if pieces.len() > 1 && pieces[0].is_empty() {
        pieces.remove(0);
        break_before_first = true;
    }
    let mut out = String::new();
    let piece_count = pieces.len();
    for (i, piece) in pieces.iter().enumerate() {
        let mut extra = AttrOverrides::new();
        let is_first = i == 0;
        let is_last = i == piece_count - 1;
        if !is_first || break_before_first {
            extra.set("fo:break-before", Some("page".to_owned()));
        }
        // a section starts once: never on a split-off part or a paragraph that only follows the start
        if !is_first || continues {
            extra.set("style:master-page-name", None);
        }
        if is_last && break_after_last {
            extra.set("fo:break-after", Some("page".to_owned()));
        } else if style_info.break_after {
            extra.set("fo:break-after", Some("auto".to_owned()));
        }
        let style_name = style_for(rctx, &extra)?;
        out.push_str(&wrap_paragraph(
            rctx,
            para,
            if is_first { model.as_deref() } else { None },
            style_name.as_deref(),
            piece,
            part,
            !style_changed,
        )?);
    }
    Ok(out)
}

/// `wrapParagraph`: the paragraph element; the original start tag (ids, unknown
/// attributes) is reused when it fits. A `text:p` that is a heading only through
/// its style's outline level (how Hancom writes its outline paragraphs and how
/// docxToOdt writes headings) stays a `text:p` while its style is unchanged:
/// Hancom numbers every `text:h` ("1.", "1.1.").
fn wrap_paragraph(
    rctx: &mut OoxmlToOdfContext,
    para: &EditedParagraph,
    model: Option<&ParagraphModel>,
    style_name: Option<&str>,
    body: &str,
    part: OdtStylePart,
    same_style: bool,
) -> Result<String, OdtError> {
    let prefixes = Rc::clone(&rctx.part(part).prefixes);
    let heading = para.r#type == EditedParagraphType::Heading
        && !(same_style && model.is_some_and(|m| m.element == ParagraphElement::P));
    let element = if heading {
        ParagraphElement::H
    } else {
        ParagraphElement::P
    };
    let level: Option<String> = if heading {
        let l = para.level.map_or(1.0, |n| n.0);
        Some(number_to_string(jscompat::math_max(
            1.0,
            jscompat::math_min(10.0, l),
        )))
    } else {
        None
    };
    let (open, close) = match model.filter(|m| m.element == element) {
        Some(model) => {
            let mut overrides = AttrOverrides::new();
            overrides.set("text:style-name", style_name.map(str::to_owned));
            if let Some(level) = &level {
                overrides.set("text:outline-level", Some(level.clone()));
            }
            (
                patch_start_tag(&model.open_tag, &prefixes, &overrides)?,
                model.close_tag.clone(),
            )
        }
        None => {
            let style = style_name
                .map(|s| format!(" text:style-name=\"{}\"", escape_xml_attr(s)))
                .unwrap_or_default();
            let level_attr = level
                .as_ref()
                .map(|l| format!(" text:outline-level=\"{l}\""))
                .unwrap_or_default();
            (
                format!("<{}{style}{level_attr}>", element.as_str()),
                format!("</{}>", element.as_str()),
            )
        }
    };
    Ok(format!("{open}{body}{close}"))
}
