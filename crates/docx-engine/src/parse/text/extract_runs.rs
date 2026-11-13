//! `extractRuns` of parse.ts: the runs of one w:p, fields folded away.

use std::collections::{BTreeSet, HashSet};

use jscompat::{JsMap, Radix, js_regex, parse_int, trim, truthy};
use omml::omml_ends_with_break;
use ooxml_xml::{XElement, XNode, serialize};
use serde_json::{Map, Value};

use super::build_run::{build_run, find_in};
use super::context::BuildContext;
use super::convert::{PictureUrls, json, model_of, num, put_picture_urls, take_picture_urls};
use super::paragraph::{ParaResolve, inherited_cs_font, run_resolve_of};
use super::runs::RunResolve;
use super::{ZoteroFieldParagraph, break_char_of};
use crate::checkbox_control::sdt_checkbox_control;
use crate::eq_field::eq_field_to_omml;
use crate::fields::tag_attr;
use crate::inline_opaque::{
    InlineRawSource, inline_wrap_text_of, inline_wrapper_shell, is_inline_wrapper,
    sdt_follows_its_text, valid_inline_wrap,
};
use crate::model::{InlineWrap, RevisionInfo, Run, RunLink};
use crate::package::Thrown;
use crate::props::{
    checkbox_state_of, convertible_hyperlink, merge_runs, mergefield_instr, ruby_part_text,
    simple_inline_field, split_image_run, zotero_inline_field,
};
use crate::xml_text::{decode_numeric_char_refs, math_tokens};

/// Run keys that are content or field machinery, not formatting a field result inherits
const RESULT_FORMAT_SKIP: [&str; 18] = [
    "text",
    "image",
    "math",
    "sym",
    "ruby",
    "noteRef",
    "xeTerm",
    "refField",
    "refInstr",
    "instrField",
    "fldBeginXml",
    "fldDirty",
    "sdtCheckboxXml",
    "wrap",
    "commentIds",
    "ins",
    "del",
    "link",
];

/// `IMAGE_RUN_CHILDREN`
const IMAGE_RUN_CHILDREN: [&str; 4] = ["w:drawing", "w:pict", "w:object", "mc:AlternateContent"];

/// A run read from its JSON.
fn run_of(map: Map<String, Value>) -> Result<Run, Thrown> {
    model_of(Value::Object(map))
}

/// `Object.fromEntries(Object.entries(run).filter(([k]) => !RESULT_FORMAT_SKIP.has(k)))`
fn result_format_of(run: &Run) -> Map<String, Value> {
    let mut map = super::convert::into_map(json(run));
    map.retain(|key, _| !RESULT_FORMAT_SKIP.contains(&key.as_str()));
    map
}

/// `Array.prototype.sort()` order of strings: by UTF-16 code unit.
fn sort_ids(ids: &mut [String]) {
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

#[derive(Clone, Default)]
struct RevCtx {
    ins: Option<RevisionInfo>,
    del: Option<RevisionInfo>,
    wrap: Option<Vec<InlineWrap>>,
}

fn revision_of(node: &XNode) -> Result<Map<String, Value>, Thrown> {
    let mut info = Map::new();
    info.insert(
        "author".to_owned(),
        Value::from(node.attr("w:author").unwrap_or("")),
    );
    for (attr, key) in [
        ("w:date", "date"),
        ("w16du:dateUtc", "dateUtc"),
        ("w:id", "id"),
    ] {
        if let Some(value) = truthy(node.attr(attr)) {
            info.insert(key.to_owned(), Value::from(value));
        }
    }
    Ok(info)
}

struct Walker<'a, 'c> {
    ctx: &'a BuildContext<'c>,
    res: RunResolve<'a>,
    runs: Vec<Run>,
    math_fragments: &'a [&'a str],
    ruby_fragments: &'a [&'a str],
    with_images: bool,
    zotero_field: Option<&'a ZoteroFieldParagraph>,
    raw: Option<&'a InlineRawSource<'a>>,
    math_index: usize,
    math_para_depth: usize,
    ruby_index: usize,
    p_style_id: Option<String>,
    complete: HashSet<String>,
    active_comments: BTreeSet<String>,
    wrap_seq: f64,
    not_carried: HashSet<u64>,
    field_depth: i64,
    field_instr: String,
    field_separated: bool,
    field_cached: String,
    field_cached_runs: Vec<Run>,
    field_begin_run: Option<&'a XNode>,
    field_dirty: bool,
    pending_ref_ids: Vec<String>,
}

fn collect_range_ids(nodes: &[XNode], starts: &mut HashSet<String>, ends: &mut HashSet<String>) {
    for node in nodes {
        match node.name() {
            Some("w:commentRangeStart") => {
                if let Some(id) = truthy(node.attr("w:id")) {
                    starts.insert(id.to_owned());
                }
            }
            Some("w:commentRangeEnd") => {
                if let Some(id) = truthy(node.attr("w:id")) {
                    ends.insert(id.to_owned());
                }
            }
            _ => {}
        }
        collect_range_ids(node.children(), starts, ends);
    }
}

/// A w:r built of `rPr` and one w:t of `text`, as `resultFormat` and the
/// legacy checkbox build it.
fn synthetic_text_run(r_pr: Option<&XNode>, text: &str) -> Vec<XNode> {
    let _ = r_pr;
    vec![XNode::Element(XElement {
        name: "w:t".to_owned(),
        attrs: Vec::new(),
        children: vec![XNode::Text(text.to_owned())],
    })]
}

impl<'a, 'c> Walker<'a, 'c> {
    fn build(
        &mut self,
        children: &[&XNode],
        link: Option<&RunLink>,
        media: bool,
    ) -> Result<Option<Run>, Thrown> {
        let ctx = self.ctx;
        let media_ref = ctx.media_by_rid.as_ref().map(|cell| cell.borrow());
        let empty = JsMap::new();
        let media_map = if media {
            Some(media_ref.as_deref().unwrap_or(&empty))
        } else {
            None
        };
        build_run(
            children,
            link,
            ctx.resolver.theme_colors.as_ref(),
            ctx.resolver.theme_fonts.as_ref(),
            media_map,
            &mut self.res,
            Some(ctx.xml_space_preserve),
            if media {
                ctx.vml_shape_types.as_ref()
            } else {
                None
            },
        )
    }

    /// `buildRun` of a run made of `r_pr` and one w:t.
    fn build_text_run(
        &mut self,
        r_pr: Option<&XNode>,
        text: &str,
        link: Option<&RunLink>,
    ) -> Result<Option<Run>, Thrown> {
        let t = synthetic_text_run(r_pr, text);
        let mut children: Vec<&XNode> = r_pr.into_iter().collect();
        children.push(&t[0]);
        self.build(&children, link, false)
    }

    fn add_comment_ids(run: &mut Run, ids: &[String]) {
        let mut all: Vec<String> = (*run.comment_ids).clone().unwrap_or_default();
        for id in ids {
            if !all.contains(id) {
                all.push(id.clone());
            }
        }
        sort_ids(&mut all);
        run.comment_ids.set(all);
    }

    fn push_run(&mut self, mut run: Run, rev: Option<&RevCtx>) {
        if !self.active_comments.is_empty() {
            let mut ids: Vec<String> = self.active_comments.iter().cloned().collect();
            sort_ids(&mut ids);
            run.comment_ids.set(ids);
        }
        if !self.pending_ref_ids.is_empty() {
            let pending = std::mem::take(&mut self.pending_ref_ids);
            Self::add_comment_ids(&mut run, &pending);
        }
        if let Some(rev) = rev {
            if let Some(ins) = &rev.ins {
                run.ins.set(ins.clone());
            }
            if let Some(del) = &rev.del {
                run.del.set(del.clone());
            }
            if let Some(wrap) = &rev.wrap {
                run.wrap.set(wrap.clone());
            }
        }
        self.runs.push(run);
    }

    fn push_map(&mut self, map: Map<String, Value>, rev: Option<&RevCtx>) -> Result<(), Thrown> {
        let run = run_of(map)?;
        self.push_run(run, rev);
        Ok(())
    }

    /// `resultFormat`: formatting of the field result: the first cached run, else the field code's rPr.
    fn result_format(&mut self) -> Result<Map<String, Value>, Thrown> {
        if let Some(first) = self.field_cached_runs.first() {
            return Ok(result_format_of(first));
        }
        let Some(begin) = self.field_begin_run else {
            return Ok(Map::new());
        };
        let r_pr = begin.find_child("w:rPr");
        Ok(self
            .build_text_run(r_pr, "x", None)?
            .map(|run| result_format_of(&run))
            .unwrap_or_default())
    }

    fn push_zotero_cached_runs(&mut self, part: &str, rev: Option<&RevCtx>) -> Result<(), Thrown> {
        let cached_runs: Vec<Run> = if self.field_cached_runs.is_empty() {
            let mut map = Map::new();
            let text = if self.field_cached.is_empty() {
                " "
            } else {
                &self.field_cached
            };
            map.insert("text".to_owned(), Value::from(text));
            vec![run_of(map)?]
        } else {
            self.field_cached_runs.clone()
        };
        let id = match self.zotero_field {
            Some(field) => f64::from(field.id),
            None => {
                let next = self.ctx.next_zotero_field_id.get();
                let id = if next == 0.0 || next.is_nan() {
                    1.0
                } else {
                    next
                };
                self.ctx.next_zotero_field_id.set(id + 1.0);
                id
            }
        };
        let instruction = trim(
            self.zotero_field
                .map_or(self.field_instr.as_str(), |field| {
                    field.instruction.as_str()
                }),
        )
        .to_owned();
        let count = cached_runs.len();
        for (index, cached) in cached_runs.into_iter().enumerate() {
            let run_part = if part == "single" && count > 1 {
                if index == 0 {
                    "begin"
                } else if index == count - 1 {
                    "end"
                } else {
                    "inside"
                }
            } else if (part == "begin" && index > 0) || (part == "end" && index < count - 1) {
                "inside"
            } else {
                part
            };
            let mut map = super::convert::into_map(json(&cached));
            map.insert("instrField".to_owned(), Value::from(instruction.as_str()));
            map.insert("zoteroFieldId".to_owned(), num(id));
            map.insert("zoteroFieldPart".to_owned(), Value::from(run_part));
            self.push_map(map, rev)?;
        }
        Ok(())
    }

    fn handle_run(
        &mut self,
        node: &'a XNode,
        link: Option<&RunLink>,
        rev: Option<&RevCtx>,
    ) -> Result<(), Thrown> {
        let ctx = self.ctx;
        if let Some(fld_char) = node.find_child("w:fldChar") {
            let kind = fld_char.attr("w:fldCharType");
            match kind {
                Some("begin") => {
                    self.field_depth += 1;
                    if self.field_depth == 1 {
                        self.field_instr.clear();
                        self.field_separated = false;
                        self.field_cached.clear();
                        self.field_cached_runs.clear();
                        self.field_begin_run = Some(node);
                        self.field_dirty = matches!(fld_char.attr("w:dirty"), Some("true" | "1"));
                    }
                }
                Some("separate") => {
                    if self.field_depth == 1 {
                        self.field_separated = true;
                    }
                }
                Some("end") => {
                    self.field_depth = (self.field_depth - 1).max(0);
                    if self.field_depth == 0 {
                        self.end_field(link, rev)?;
                    }
                }
                _ => {}
            }
            return Ok(());
        }
        if self.field_depth > 0 {
            // keep the fragment index aligned even for ruby inside a field cache
            if node.find_child("w:ruby").is_some() {
                self.ruby_index += 1;
            }
            if let Some(instr) = node.find_child("w:instrText") {
                self.field_instr += &instr.text();
            } else if self.field_separated && self.field_depth == 1 {
                // REF/HYPERLINK cached result is the display text; other fields' caches are dropped
                let children: Vec<&XNode> = node.children().iter().collect();
                if let Some(cached) = self.build(&children, link, false)? {
                    self.field_cached += cached.text.as_deref().unwrap_or("");
                    self.field_cached_runs.push(cached);
                }
            }
            return Ok(());
        }
        if let Some(ruby_node) = node.find_child("w:ruby") {
            let xml = self.ruby_fragments.get(self.ruby_index).copied();
            self.ruby_index += 1;
            let base = ruby_part_text(ruby_node, "w:rubyBase");
            let rt = ruby_part_text(ruby_node, "w:rt");
            // no fragment (textbox paths): degrade to the base characters
            if !base.is_empty() {
                let mut map = Map::new();
                map.insert("text".to_owned(), Value::from(base.as_str()));
                if let Some(xml) = xml.filter(|xml| !xml.is_empty()) {
                    let mut ruby = Map::new();
                    ruby.insert("rt".to_owned(), Value::from(rt.as_str()));
                    ruby.insert("xml".to_owned(), Value::from(xml));
                    map.insert("ruby".to_owned(), Value::Object(ruby));
                }
                self.push_map(map, rev)?;
            }
            return Ok(());
        }
        let note_ref = node
            .find_child("w:footnoteReference")
            .or_else(|| node.find_child("w:endnoteReference"));
        if let Some(note_ref) = note_ref {
            let kind = if note_ref.name() == Some("w:footnoteReference") {
                "footnote"
            } else {
                "endnote"
            };
            if let Some(id) = truthy(note_ref.attr("w:id")) {
                let number = ctx.note_numbers.get(&format!("{kind}:{id}"));
                // the marker's rPr rides along verbatim
                let marker = node.find_child("w:rPr");
                let mut map = Map::new();
                map.insert(
                    "text".to_owned(),
                    match number {
                        Some(n) => Value::from(jscompat::number_to_string(n.0)),
                        None => Value::from("*"),
                    },
                );
                let mut reference = Map::new();
                reference.insert("kind".to_owned(), Value::from(kind));
                reference.insert("id".to_owned(), Value::from(id));
                map.insert("noteRef".to_owned(), Value::Object(reference));
                if let Some(marker) = marker {
                    map.insert("rawRPr".to_owned(), Value::from(serialize(marker)));
                }
                self.push_map(map, rev)?;
                return Ok(());
            }
        }
        if let Some(comment_ref) = node.find_child("w:commentReference")
            && let Some(id) = truthy(comment_ref.attr("w:id"))
            && ctx
                .reference_only_comments
                .as_ref()
                .is_some_and(|set| set.contains(id))
        {
            let id = id.to_owned();
            match self.runs.last_mut() {
                Some(prev) => Self::add_comment_ids(prev, &[id]),
                None => self.pending_ref_ids.push(id),
            }
        }
        // Run.image is singular: a run carrying several drawings/picts must
        // split into one run per picture
        let image_children = node
            .children()
            .iter()
            .filter(|child| IMAGE_RUN_CHILDREN.contains(&child.name().unwrap_or("")))
            .count();
        let mut parts: Vec<Vec<&XNode>> = Vec::new();
        let whole: Vec<Vec<&XNode>> = if self.with_images && image_children > 1 {
            split_image_run(node)
                .into_iter()
                .map(|part| part.children)
                .collect()
        } else {
            vec![node.children().iter().collect()]
        };
        for children in whole {
            match split_sym_children(&children) {
                Some(split) => parts.extend(split),
                None => parts.push(children),
            }
        }
        for children in parts {
            let run = self.build(&children, link, self.with_images)?;
            if let Some(mut run) = run {
                // only a w:rtl run reads the cs slot
                if !run.cs_font.as_deref().is_some_and(|f| !f.is_empty()) && run.cs.unwrap_or(false)
                {
                    let cs =
                        inherited_cs_font(run.style_id.as_deref(), self.p_style_id.as_deref(), ctx);
                    if let Some(cs) = truthy(cs.as_deref()) {
                        run.cs_font.set(cs.to_owned());
                    }
                }
                self.push_run(run, rev);
            }
        }
        Ok(())
    }

    /// The end of a field at depth 0: the run the field folds into.
    fn end_field(&mut self, link: Option<&RunLink>, rev: Option<&RevCtx>) -> Result<(), Thrown> {
        let instr = self.field_instr.clone();
        let xe = js_regex!(r#"^\s*XE\s+(?:"([^"]*)"|(\S+))"#).exec(&instr);
        let reference = js_regex!(r#"^\s*REF\s+(?:"([^"]+)"|([^\s\\]+))"#).exec(&instr);
        let hyper = convertible_hyperlink(&instr);
        let cached = self.field_cached.clone();
        let dirty = self.field_dirty;
        let mut map = Map::new();
        if let Some(xe) = xe {
            map.insert("text".to_owned(), Value::from(""));
            map.insert(
                "xeTerm".to_owned(),
                Value::from(xe.get(1).or(xe.get(2)).unwrap_or("")),
            );
            self.push_map(map, rev)?;
        } else if let Some(reference) = reference {
            let name = reference.get(1).or(reference.get(2)).unwrap_or("");
            map.insert(
                "text".to_owned(),
                Value::from(if cached.is_empty() {
                    name
                } else {
                    cached.as_str()
                }),
            );
            map.insert("refField".to_owned(), Value::from(name));
            map.insert("refInstr".to_owned(), Value::from(instr.as_str()));
            if dirty {
                map.insert("fldDirty".to_owned(), Value::Bool(true));
            }
            self.push_map(map, rev)?;
        } else if let Some(hyper) = hyper {
            let mut link_val = Map::new();
            link_val.insert("href".to_owned(), Value::from(hyper.href.as_str()));
            if let Some(tip) = truthy(hyper.tooltip.as_deref()) {
                link_val.insert("tooltip".to_owned(), Value::from(tip));
            }
            if self.field_cached_runs.is_empty() {
                let mut map = Map::new();
                map.insert("text".to_owned(), Value::from(hyper.href.as_str()));
                map.insert("link".to_owned(), Value::Object(link_val));
                self.push_map(map, rev)?;
            } else {
                for cached in std::mem::take(&mut self.field_cached_runs) {
                    let mut map = super::convert::into_map(json(&cached));
                    map.insert("link".to_owned(), Value::Object(link_val.clone()));
                    self.push_map(map, rev)?;
                }
            }
        } else if js_regex!(r"^\s*FORMCHECKBOX\s*$").test(&instr) {
            // Legacy checkbox form field: no cached result; display a glyph, write the begin run back verbatim
            if let Some(state) = checkbox_state_of(self.field_begin_run) {
                let glyph = if state.checked {
                    "\u{2612}"
                } else {
                    "\u{2610}"
                };
                let begin = self.field_begin_run;
                let r_pr = begin.and_then(|begin| begin.find_child("w:rPr"));
                let glyph_run = self.build_text_run(r_pr, glyph, link)?;
                let mut map = match glyph_run {
                    Some(run) => super::convert::into_map(json(&run)),
                    None => {
                        let mut m = Map::new();
                        m.insert("text".to_owned(), Value::from(glyph));
                        m
                    }
                };
                map.insert("instrField".to_owned(), Value::from("FORMCHECKBOX"));
                map.insert(
                    "fldBeginXml".to_owned(),
                    Value::from(begin.map(serialize).unwrap_or_default()),
                );
                self.push_map(map, rev)?;
            }
        } else if zotero_inline_field().test(&instr) {
            match &self.zotero_field {
                Some(field) => {
                    let part = field.part.as_str().to_owned();
                    self.push_zotero_cached_runs(&part, rev)?;
                }
                None => self.push_zotero_cached_runs("single", rev)?,
            }
        } else if let Some(merge) = mergefield_instr().exec(&instr) {
            let mut map = self.result_format()?;
            let placeholder = format!(
                "\u{ab}{}\u{bb}",
                merge.get(1).or(merge.get(2)).unwrap_or("")
            );
            map.insert(
                "text".to_owned(),
                Value::from(if cached.is_empty() {
                    placeholder.as_str()
                } else {
                    cached.as_str()
                }),
            );
            map.insert("instrField".to_owned(), Value::from(trim(&instr)));
            if dirty {
                map.insert("fldDirty".to_owned(), Value::Bool(true));
            }
            if let Some(link) = link {
                map.insert("link".to_owned(), json(link));
            }
            self.push_map(map, rev)?;
        } else if simple_inline_field().test(&instr) {
            let mut map = self.result_format()?;
            map.insert(
                "text".to_owned(),
                Value::from(if cached.is_empty() {
                    " "
                } else {
                    cached.as_str()
                }),
            );
            map.insert("instrField".to_owned(), Value::from(trim(&instr)));
            if dirty {
                map.insert("fldDirty".to_owned(), Value::Bool(true));
            }
            if let Some(link) = link {
                map.insert("link".to_owned(), json(link));
            }
            self.push_map(map, rev)?;
        } else if js_regex!(r"^\s*EQ\b", "i").test(&instr)
            && let Some(eq) = eq_field_to_omml(&instr)
        {
            let mut map = self.result_format()?;
            map.insert("text".to_owned(), Value::from(eq.text.as_str()));
            let mut math = Map::new();
            math.insert("omml".to_owned(), Value::from(eq.omml.as_str()));
            map.insert("math".to_owned(), Value::Object(math));
            self.push_map(map, rev)?;
        } else if trim(&instr).is_empty() {
            // an instruction-less field keeps its result as an empty-instruction run
            let mut map = self.result_format()?;
            map.insert(
                "text".to_owned(),
                Value::from(if cached.is_empty() {
                    " "
                } else {
                    cached.as_str()
                }),
            );
            map.insert("instrField".to_owned(), Value::from(""));
            if let Some(link) = link {
                map.insert("link".to_owned(), json(link));
            }
            self.push_map(map, rev)?;
        } else if !self.field_cached_runs.is_empty() {
            // any other field: the cached result is still the visible text
            for cached in std::mem::take(&mut self.field_cached_runs) {
                self.push_run(cached, rev);
            }
        }
        self.field_instr.clear();
        self.field_separated = false;
        self.field_cached.clear();
        self.field_cached_runs.clear();
        self.field_begin_run = None;
        Ok(())
    }

    /// `foldSimpleField`
    fn fold_simple_field(
        &mut self,
        node: &'a XNode,
        link: Option<&RunLink>,
        rev: Option<&RevCtx>,
    ) -> Result<(), Thrown> {
        let raw = node.attr("w:instr").unwrap_or("");
        let instr = decode_numeric_char_refs(raw).into_owned();
        let xe = js_regex!(r#"^\s*XE\s+(?:"([^"]*)"|(\S+))"#).exec(&instr);
        let reference = js_regex!(r#"^\s*REF\s+(?:"([^"]+)"|([^\s\\]+))"#).exec(&instr);
        let merge = mergefield_instr().exec(&instr);
        if xe.is_none()
            && reference.is_none()
            && merge.is_none()
            && !simple_inline_field().test(&instr)
        {
            return self.walk(node.children(), link, rev);
        }
        let first = self.runs.len();
        self.walk(node.children(), link, rev)?;
        let cached: Vec<Run> = self.runs.split_off(first);
        let text: String = cached
            .iter()
            .map(|r| r.text.as_deref().unwrap_or(""))
            .collect();
        let format = cached.first().map(result_format_of).unwrap_or_default();
        let dirty = matches!(node.attr("w:dirty"), Some("true" | "1"));
        let mut map: Map<String, Value>;
        if let Some(xe) = xe {
            let mut m = Map::new();
            m.insert("text".to_owned(), Value::from(""));
            m.insert(
                "xeTerm".to_owned(),
                Value::from(xe.get(1).or(xe.get(2)).unwrap_or("")),
            );
            return self.push_map(m, rev);
        } else if let Some(reference) = reference {
            let name = reference.get(1).or(reference.get(2)).unwrap_or("");
            map = format;
            map.insert(
                "text".to_owned(),
                Value::from(if text.is_empty() { name } else { text.as_str() }),
            );
            map.insert("refField".to_owned(), Value::from(name));
            map.insert(
                "refInstr".to_owned(),
                Value::from(format!(" {} ", trim(&instr))),
            );
        } else if let Some(merge) = merge {
            map = format;
            let placeholder = format!(
                "\u{ab}{}\u{bb}",
                merge.get(1).or(merge.get(2)).unwrap_or("")
            );
            map.insert(
                "text".to_owned(),
                Value::from(if text.is_empty() {
                    placeholder.as_str()
                } else {
                    text.as_str()
                }),
            );
            map.insert("instrField".to_owned(), Value::from(trim(&instr)));
        } else {
            map = format;
            map.insert(
                "text".to_owned(),
                Value::from(if text.is_empty() { " " } else { text.as_str() }),
            );
            map.insert("instrField".to_owned(), Value::from(trim(&instr)));
        }
        if dirty {
            map.insert("fldDirty".to_owned(), Value::Bool(true));
        }
        if let Some(link) = link {
            map.insert("link".to_owned(), json(link));
        }
        self.push_map(map, rev)
    }

    /// `enters`
    fn enters(&mut self, container: &str, chain: Option<&Vec<InlineWrap>>) {
        for wrap in chain.into_iter().flatten() {
            let inside = wrap.inside.as_ref().map(|inside| inside.as_str());
            if inside == Some("link") || (container == "revision" && inside == Some("revision")) {
                self.not_carried.insert(wrap.seq.0 as u64);
            }
        }
    }

    fn walk(
        &mut self,
        nodes: &'a [XNode],
        link: Option<&RunLink>,
        rev: Option<&RevCtx>,
    ) -> Result<(), Thrown> {
        let ctx = self.ctx;
        for node in nodes {
            let name = node.name();
            match name {
                Some("w:commentRangeStart" | "w:commentRangeEnd") => {
                    if let Some(id) = truthy(node.attr("w:id"))
                        && self.complete.contains(id)
                    {
                        if name == Some("w:commentRangeStart") {
                            self.active_comments.insert(id.to_owned());
                        } else {
                            self.active_comments.remove(id);
                        }
                    }
                }
                Some("w:ins" | "w:del") => {
                    let info: RevisionInfo = model_of(Value::Object(revision_of(node)?))?;
                    let mut next = rev.cloned().unwrap_or_default();
                    if name == Some("w:ins") {
                        next.ins = Some(info);
                    } else {
                        next.del = Some(info);
                    }
                    self.enters("revision", rev.and_then(|r| r.wrap.as_ref()));
                    self.walk(node.children(), link, Some(&next))?;
                }
                Some("w:moveFromRangeStart" | "w:moveToRangeStart") => {
                    let id = node.attr("w:id").unwrap_or("");
                    let move_name = node
                        .attr("w:name")
                        .map_or_else(|| format!("move{id}"), str::to_owned);
                    ctx.open_moves.borrow_mut().push(super::OpenMove {
                        id: id.to_owned(),
                        name: move_name,
                        side: if name == Some("w:moveFromRangeStart") {
                            "from"
                        } else {
                            "to"
                        },
                    });
                }
                Some("w:moveFromRangeEnd" | "w:moveToRangeEnd") => {
                    let id = node.attr("w:id").unwrap_or("");
                    let mut open = ctx.open_moves.borrow_mut();
                    if let Some(at) = open.iter().rposition(|m| m.id == id) {
                        open.remove(at);
                    }
                }
                Some("w:moveFrom" | "w:moveTo") => {
                    // moveFrom is a deletion at the source, moveTo an insertion at the destination
                    let mut info = revision_of(node)?;
                    let side = if name == Some("w:moveFrom") {
                        "from"
                    } else {
                        "to"
                    };
                    let range_name = ctx
                        .open_moves
                        .borrow()
                        .iter()
                        .rev()
                        .find(|m| m.side == side)
                        .map(|m| m.name.clone());
                    let move_name = range_name.unwrap_or_else(|| {
                        node.attr("w:name").map_or_else(
                            || format!("move{}", node.attr("w:id").unwrap_or("")),
                            str::to_owned,
                        )
                    });
                    info.insert("move".to_owned(), Value::from(move_name));
                    let info: RevisionInfo = model_of(Value::Object(info))?;
                    let mut next = rev.cloned().unwrap_or_default();
                    if side == "from" {
                        next.del = Some(info);
                    } else {
                        next.ins = Some(info);
                    }
                    self.enters("revision", rev.and_then(|r| r.wrap.as_ref()));
                    self.walk(node.children(), link, Some(&next))?;
                }
                Some("w:r") => self.handle_run(node, link, rev)?,
                Some("m:oMath") => {
                    // atomic inline formula; the raw fragment saves verbatim on regeneration
                    let omml = self.math_fragments.get(self.math_index).copied();
                    self.math_index += 1;
                    if let Some(omml) = omml.filter(|omml| !omml.is_empty()) {
                        let sz = parse_int(
                            tag_attr(omml, "w:sz", "w:val")
                                .map_err(|error| error.to_string())?
                                .unwrap_or(""),
                            Radix::Ten,
                        );
                        let mut map = Map::new();
                        map.insert("text".to_owned(), Value::from(math_tokens(omml).join("")));
                        let mut math = Map::new();
                        math.insert("omml".to_owned(), Value::from(omml));
                        if self.math_para_depth > 0 {
                            math.insert("display".to_owned(), Value::Bool(true));
                        }
                        if omml_ends_with_break(omml) {
                            math.insert("breakAfter".to_owned(), Value::Bool(true));
                        }
                        map.insert("math".to_owned(), Value::Object(math));
                        if sz.is_finite() {
                            map.insert(
                                "sizeHalfPoints".to_owned(),
                                num(jscompat::math_max(1.0, sz)),
                            );
                        }
                        self.push_map(map, rev)?;
                    }
                }
                Some("w:hyperlink") => {
                    let r_id = node.attr("r:id");
                    let anchor = node.attr("w:anchor");
                    let tooltip = node.attr("w:tooltip");
                    let anchor_part = truthy(anchor).map(|a| format!("#{a}"));
                    let href = match truthy(r_id) {
                        Some(r_id) => format!(
                            "{}{}",
                            ctx.rels.get(r_id).map_or("", |rel| rel.target.as_str()),
                            anchor_part.as_deref().unwrap_or("")
                        ),
                        None => anchor_part.unwrap_or_default(),
                    };
                    let first = self.runs.len();
                    self.enters("link", rev.and_then(|r| r.wrap.as_ref()));
                    let mut link_map = Map::new();
                    link_map.insert("href".to_owned(), Value::from(href));
                    if let Some(r_id) = r_id {
                        link_map.insert("rId".to_owned(), Value::from(r_id));
                    }
                    if let Some(tooltip) = truthy(tooltip) {
                        link_map.insert("tooltip".to_owned(), Value::from(tooltip));
                    }
                    let new_link: RunLink = model_of(Value::Object(link_map))?;
                    self.walk(node.children(), Some(&new_link), rev)?;
                    // Word paints a bookmark link only through its character style
                    if !truthy(r_id).is_some() && truthy(anchor).is_some() {
                        for run in &mut self.runs[first..] {
                            if let Some(existing) = run.link.as_ref()
                                && !run.style_id.as_deref().is_some_and(|s| !s.is_empty())
                            {
                                let mut plain = super::convert::into_map(json(existing));
                                plain.insert("plain".to_owned(), Value::Bool(true));
                                run.link.set(model_of(Value::Object(plain))?);
                            }
                        }
                    }
                }
                Some("w:sdt") if sdt_checkbox_control(node).is_some() => {
                    // one glyph run per control, whatever the content held
                    let control = sdt_checkbox_control(node)
                        .unwrap_or_else(|| unreachable!("checked just above"));
                    let first = self.runs.len();
                    self.walk(node.children(), link, rev)?;
                    let inner: Vec<Run> = self.runs.split_off(first);
                    let base = inner
                        .iter()
                        .find(|r| !jscompat::trim(r.text.as_deref().unwrap_or("")).is_empty())
                        .or(inner.first());
                    let mut map = base
                        .map(|r| super::convert::into_map(json(r)))
                        .unwrap_or_default();
                    map.insert("text".to_owned(), Value::from(control.glyph.to_string()));
                    map.insert(
                        "sdtCheckboxXml".to_owned(),
                        Value::from(control.sdt_pr_xml.as_str()),
                    );
                    self.push_map(map, rev)?;
                }
                Some(wrapper) if is_inline_wrapper(wrapper) => {
                    let shell =
                        inline_wrapper_shell(node, self.raw).map_err(|limit| limit.to_string())?;
                    let first = self.runs.len();
                    let depth_at_entry = self.field_depth;
                    match shell {
                        None => self.walk(node.children(), link, rev)?,
                        Some(shell) => {
                            let seq = self.wrap_seq;
                            self.wrap_seq += 1.0;
                            let mut wrap = Map::new();
                            wrap.insert("seq".to_owned(), num(seq));
                            wrap.insert("open".to_owned(), Value::from(shell.open.as_str()));
                            wrap.insert("close".to_owned(), Value::from(shell.close.as_str()));
                            if link.is_some() {
                                wrap.insert("inside".to_owned(), Value::from("link"));
                            } else if rev.is_some_and(|r| r.ins.is_some() || r.del.is_some()) {
                                wrap.insert("inside".to_owned(), Value::from("revision"));
                            }
                            let wrap: InlineWrap = model_of(Value::Object(wrap))?;
                            let mut chain = rev.and_then(|r| r.wrap.clone()).unwrap_or_default();
                            chain.push(wrap.clone());
                            let mut next = rev.cloned().unwrap_or_default();
                            next.wrap = Some(chain);
                            self.walk_content(&shell.content, link, &next)?;
                            let carried = self.runs[first..].iter().any(carries_wrap);
                            let key = seq as u64;
                            if depth_at_entry > 0 || self.field_depth != depth_at_entry {
                                // inside a field, or cut by a field's edge
                                self.not_carried.insert(key);
                            } else if carried {
                                if !valid_inline_wrap(
                                    &wrap,
                                    // `ctx.partNamespaces ?? NO_NAMESPACES`: a part with none known declares none
                                    Some(ctx.part_namespaces.as_ref().unwrap_or(&JsMap::new())),
                                ) {
                                    self.not_carried.insert(key);
                                } else if sdt_follows_its_text(&wrap.open) {
                                    let text =
                                        inline_wrap_text_of(&self.runs, first, self.runs.len());
                                    for run in &mut self.runs[first..] {
                                        set_wrap_text(run, key, &text);
                                    }
                                }
                            } else {
                                // nothing in it to hold the wrapper on
                                self.not_carried.insert(key);
                            }
                        }
                    }
                }
                Some("w:sdtContent") => self.walk(node.children(), link, rev)?,
                Some("m:oMathPara") => {
                    // display equation inside a cell paragraph
                    self.math_para_depth += 1;
                    self.walk(node.children(), link, rev)?;
                    self.math_para_depth -= 1;
                }
                Some("w:fldSimple") => {
                    // single-element field form: the children are the cached result runs
                    if self.field_depth == 0 {
                        self.fold_simple_field(node, link, rev)?;
                    } else if self.field_separated {
                        self.walk(node.children(), link, rev)?;
                    }
                }
                Some("w:br") => {
                    // Word honors a <w:br> sitting outside any <w:r>
                    let mut map = Map::new();
                    map.insert(
                        "text".to_owned(),
                        Value::from(
                            break_char_of(node.attr("w:clear"), node.attr("w:type")).to_string(),
                        ),
                    );
                    self.push_map(map, rev)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// `walk(shell.content, ...)`: the content nodes of a wrapper are references into the tree.
    fn walk_content(
        &mut self,
        content: &[&'a XNode],
        link: Option<&RunLink>,
        rev: &RevCtx,
    ) -> Result<(), Thrown> {
        for node in content {
            self.walk(std::slice::from_ref(*node), link, Some(rev))?;
        }
        Ok(())
    }
}

/// `carriesWrap`: something the editor can hold a wrapper on: text, a picture or an atom.
fn carries_wrap(run: &Run) -> bool {
    run.text.as_deref().is_some_and(|text| !text.is_empty())
        || run.image.is_some()
        || run.xe_term.is_some()
        || run.math.is_some()
}

fn set_wrap_text(run: &mut Run, seq: u64, text: &str) {
    if let Some(chain) = run.wrap.as_mut() {
        for wrap in chain.iter_mut().filter(|w| w.seq.0 as u64 == seq) {
            wrap.text = Some(text.to_owned());
        }
    }
}

/// `splitSymRun` over the children of a synthetic run.
fn split_sym_children<'a>(children: &[&'a XNode]) -> Option<Vec<Vec<&'a XNode>>> {
    let kids: Vec<&XNode> = children
        .iter()
        .copied()
        .filter(|child| child.name() != Some("w:rPr"))
        .collect();
    if kids.len() < 2 || !kids.iter().any(|child| child.name() == Some("w:sym")) {
        return None;
    }
    let r_pr = find_in(children, "w:rPr");
    let mut parts: Vec<Vec<&XNode>> = Vec::new();
    let mut current: Vec<&XNode> = Vec::new();
    for child in kids {
        if child.name() == Some("w:sym") {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            parts.push(vec![child]);
        } else {
            current.push(child);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    Some(
        parts
            .into_iter()
            .map(|part| r_pr.into_iter().chain(part).collect())
            .collect(),
    )
}

/// `extractRuns`: the runs of `p_node`.
#[allow(clippy::too_many_arguments)]
pub fn extract_runs<'a>(
    p_node: &'a XNode,
    ctx: &'a BuildContext<'_>,
    math_fragments: &'a [&'a str],
    ruby_fragments: &'a [&'a str],
    with_images: bool,
    zotero_field: Option<&'a ZoteroFieldParagraph>,
    para: Option<&ParaResolve<'a>>,
    raw: Option<&'a InlineRawSource<'a>>,
) -> Result<Vec<Run>, Thrown> {
    let p_style_id = p_node
        .find_child("w:pPr")
        .and_then(|p_pr| p_pr.find_child("w:pStyle"))
        .and_then(|child| child.attr("w:val"))
        .map(str::to_owned);
    let res = run_resolve_of(ctx, p_node, para)?;
    // Comments are only tracked when the whole range lives inside this paragraph
    let mut starts = HashSet::new();
    let mut ends = HashSet::new();
    collect_range_ids(p_node.children(), &mut starts, &mut ends);
    let complete: HashSet<String> = starts.intersection(&ends).cloned().collect();
    let mut walker = Walker {
        ctx,
        res,
        runs: Vec::new(),
        math_fragments,
        ruby_fragments,
        with_images,
        zotero_field,
        raw,
        math_index: 0,
        math_para_depth: 0,
        ruby_index: 0,
        p_style_id,
        complete,
        active_comments: BTreeSet::new(),
        wrap_seq: 0.0,
        not_carried: HashSet::new(),
        field_depth: i64::from(
            zotero_field.is_some_and(|f| f.part != crate::model::RunZoteroFieldPart::Begin),
        ),
        field_instr: zotero_field
            .map(|f| f.instruction.clone())
            .unwrap_or_default(),
        field_separated: zotero_field
            .is_some_and(|f| f.part != crate::model::RunZoteroFieldPart::Begin),
        field_cached: String::new(),
        field_cached_runs: Vec::new(),
        field_begin_run: None,
        field_dirty: false,
        pending_ref_ids: Vec::new(),
    };
    walker.walk(p_node.children(), None, None)?;
    if let Some(field) = zotero_field
        && walker.field_depth > 0
        && field.part != crate::model::RunZoteroFieldPart::End
    {
        walker.push_zotero_cached_runs(field.part.as_str(), None)?;
    } else if walker.field_depth > 0 && walker.field_separated {
        // a field whose result runs on into the next paragraph has no fldChar end here
        for cached in std::mem::take(&mut walker.field_cached_runs) {
            walker.push_run(cached, None);
        }
    }
    if !walker.not_carried.is_empty() {
        let not_carried = walker.not_carried.clone();
        for run in &mut walker.runs {
            let Some(chain) = run.wrap.as_ref() else {
                continue;
            };
            let kept: Vec<InlineWrap> = chain
                .iter()
                .filter(|w| !not_carried.contains(&(w.seq.0 as u64)))
                .cloned()
                .collect();
            if kept.len() == chain.len() {
                continue;
            }
            if kept.is_empty() {
                run.wrap.delete();
            } else {
                run.wrap.set(kept);
            }
        }
    }
    let merged = merge_runs_model(&walker.runs)?;
    Ok(merged)
}

/// `mergeRuns` over model runs. A run with a picture never merges with another,
/// so the pictures come out in the order they went in: their data URLs stay
/// out of the JSON, which would copy each, and are put back.
fn merge_runs_model(runs: &[Run]) -> Result<Vec<Run>, Thrown> {
    let mut urls: Vec<PictureUrls> = Vec::new();
    let maps: Vec<Map<String, Value>> = runs
        .iter()
        .map(|run| {
            let map = if run.image.is_some() {
                let mut bare = run.clone();
                urls.extend(take_picture_urls(&mut bare));
                json(&bare)
            } else {
                json(run)
            };
            super::convert::into_map(map)
        })
        .collect();
    let mut merged = merge_runs(&maps)
        .into_iter()
        .map(run_of)
        .collect::<Result<Vec<Run>, Thrown>>()?;
    let mut urls = urls.into_iter();
    for run in merged.iter_mut().filter(|run| run.image.is_some()) {
        if let Some(urls) = urls.next() {
            put_picture_urls(run, urls);
        }
    }
    Ok(merged)
}

/// `extractRuns(p, ctx, [], [], withImages)`
pub fn extract_runs_plain(
    p_node: &XNode,
    ctx: &BuildContext<'_>,
    with_images: bool,
) -> Result<Vec<Run>, Thrown> {
    extract_runs(p_node, ctx, &[], &[], with_images, None, None, None)
}
