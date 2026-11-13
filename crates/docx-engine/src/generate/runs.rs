use crate::inline_opaque::{
    ContentControlPart, PlacedWraps, inline_wrap_key, inline_wrap_prefixes, inline_wrap_text_of,
    inline_wrap_writes_once, place_inline_wraps, same_inline_wrap, sdt_open_for_changed_text,
};
use crate::model::{InlineWrap, RevisionInfo, Run};
use jscompat::{JsMap, JsRegex, Radix, RegexLimit, js_regex, parse_int};
use std::collections::{HashMap, HashSet};

use super::rpr::run_r_pr_xml;
use super::{escape_xml_attr as attr, escape_xml_text as text};

type Allocator<'a> = Option<&'a mut dyn FnMut(&str) -> String>;
type RevisionAllocator<'a> = Option<&'a mut dyn FnMut() -> String>;

/// `RunsXmlOptions`
#[derive(Default)]
pub struct RunsXmlOptions<'a> {
    /// the content controls already written for this paragraph, shared by a
    /// caller that writes one paragraph's runs in several calls
    pub written: HashSet<String>,
    /// xml written in place of a run (the fields of a header), by the run's index
    pub fragments: HashMap<usize, String>,
    /// the part the runs are written into (see `GenerateContext.part`)
    pub part: Option<&'a ContentControlPart>,
}

/// `inlineRunsXml`: OOXML runs without relationship allocation (header/footer
/// parts, ...).
pub fn inline_runs_xml(runs: &[Run]) -> Result<String, RegexLimit> {
    inline_runs_xml_with(runs, &mut RunsXmlOptions::default())
}

/// `inlineRunsXml(runs, options)`
pub fn inline_runs_xml_with(
    runs: &[Run],
    options: &mut RunsXmlOptions<'_>,
) -> Result<String, RegexLimit> {
    runs_xml_core(runs, None, None, options)
}

/// `runsXml(runs, null, { part })`
pub(crate) fn runs_xml_in(runs: &[Run], part: &ContentControlPart) -> Result<String, RegexLimit> {
    runs_xml_with_revisions(runs, None, None, Some(part))
}

/// `runsXml(runs, allocate, { allocateRevisionId, part })` of the paragraph generator.
pub(crate) fn runs_xml_with_revisions(
    runs: &[Run],
    allocate: Allocator<'_>,
    allocate_revision: RevisionAllocator<'_>,
    part: Option<&ContentControlPart>,
) -> Result<String, RegexLimit> {
    runs_xml_core(
        runs,
        allocate,
        allocate_revision,
        &mut RunsXmlOptions {
            part,
            ..RunsXmlOptions::default()
        },
    )
}

/// `runsXml`
pub(crate) fn runs_xml_core(
    given: &[Run],
    allocate: Allocator<'_>,
    allocate_revision: RevisionAllocator<'_>,
    options: &mut RunsXmlOptions<'_>,
) -> Result<String, RegexLimit> {
    let part = options.part;
    // The wrappers a run carries may come from a co-editing peer: each is
    // checked before it is written, and one that fails goes without taking the
    // run's text with it.
    let wrap_ok = |wrap: &InlineWrap| {
        inline_wrap_prefixes(wrap)
            .is_some_and(|prefixes| part.is_none_or(|part| part.takes(&prefixes)))
    };
    let filtered: Vec<Run>;
    let runs: &[Run] = if given.iter().any(|run| run.wrap.is_some()) {
        filtered = given
            .iter()
            .map(|run| {
                let Some(given_wrap) = run.wrap.as_ref() else {
                    return run.clone();
                };
                let kept: Vec<InlineWrap> = given_wrap
                    .iter()
                    .filter(|wrap| wrap_ok(wrap))
                    .cloned()
                    .collect();
                if kept.len() == given_wrap.len() {
                    return run.clone();
                }
                let mut rest = run.clone();
                rest.wrap.delete();
                if !kept.is_empty() {
                    rest.wrap.set(kept);
                }
                rest
            })
            .collect();
        &filtered
    } else {
        given
    };
    let placed = place_inline_wraps(runs, &|run| revision_key(run));
    let mut emitter = Emitter {
        runs,
        allocate,
        allocate_revision,
        revision_seq: 9001,
        emitted_ids: HashSet::new(),
        first_of: JsMap::new(),
        last_of: JsMap::new(),
        placed,
        written: &mut options.written,
        fragments: &options.fragments,
        part,
        open_range: None,
    };
    for (index, run) in runs.iter().enumerate() {
        for id in run.comment_ids.as_deref().unwrap_or_default() {
            if emitter.first_of.get(id).is_none() {
                emitter.first_of.set(id.clone(), index);
            }
            emitter.last_of.set(id.clone(), index);
        }
    }
    let mut out = String::new();
    emitter.within(0, runs.len(), 0, 0, Leaf::Revisions, &mut out)?;
    Ok(out)
}

/// What `within` writes inside the innermost wrapper of a level.
#[derive(Clone, Copy)]
enum Leaf {
    /// `emitRevisions`
    Revisions,
    /// `emitRange`
    Range,
    /// the runs of a hyperlink group, one fragment each
    Fragments { inside_link: bool },
}

struct Emitter<'r, 'h, 'v, 'w> {
    runs: &'r [Run],
    allocate: Allocator<'h>,
    allocate_revision: RevisionAllocator<'v>,
    revision_seq: u64,
    emitted_ids: HashSet<String>,
    first_of: JsMap<usize>,
    last_of: JsMap<usize>,
    placed: Option<Vec<PlacedWraps>>,
    written: &'w mut HashSet<String>,
    fragments: &'w HashMap<usize, String>,
    part: Option<&'w ContentControlPart>,
    open_range: Option<(&'static str, String)>,
}

/// `revKey` of the generator's tracked-change grouping: empty for a run with no revision.
fn revision_key(run: &Run) -> String {
    if run.ins.is_none() && run.del.is_none() {
        return String::new();
    }
    let field = |info: Option<&RevisionInfo>| {
        [
            info.map(|info| info.author.clone()),
            info.and_then(|info| info.date.clone()),
            info.and_then(|info| info.date_utc.clone()),
            info.and_then(|info| info.id.clone()),
            info.and_then(|info| info.r#move.clone()),
        ]
    };
    let mut parts = Vec::new();
    parts.extend(field(run.ins.as_ref()));
    parts.extend(field(run.del.as_ref()));
    serde_json::to_string(&parts).unwrap_or_default()
}

fn move_of(run: Option<&Run>) -> Option<(&'static str, &str)> {
    let run = run?;
    run.del
        .as_ref()
        .and_then(|info| info.r#move.as_deref())
        .filter(|value| !value.is_empty())
        .map(|name| ("From", name))
        .or_else(|| {
            run.ins
                .as_ref()
                .and_then(|info| info.r#move.as_deref())
                .filter(|value| !value.is_empty())
                .map(|name| ("To", name))
        })
}

impl Emitter<'_, '_, '_, '_> {
    fn starts_at(&self, at: usize, out: &mut String) {
        for (id, index) in self.first_of.iter() {
            if *index == at {
                out.push_str(&format!("<w:commentRangeStart w:id=\"{}\"/>", attr(id)));
            }
        }
    }
    fn ends_at(&self, at: usize, out: &mut String) {
        for (id, index) in self.last_of.iter() {
            if *index == at {
                out.push_str(&format!("<w:commentRangeEnd w:id=\"{0}\"/><w:r><w:commentReference w:id=\"{0}\"/></w:r>", attr(id)));
            }
        }
    }
    /// `fragment`
    fn fragment(&self, index: usize, inside_link: bool) -> Result<String, RegexLimit> {
        match self.fragments.get(&index) {
            Some(xml) => Ok(xml.clone()),
            None => run_fragment_xml(&self.runs[index], inside_link),
        }
    }
    /// `within`: runs [from, to) inside their wrappers of one level: adjacent
    /// runs that share a wrapper go back inside one element, written with the
    /// bytes it was read with; `leaf` writes what sits inside the innermost one.
    fn within(
        &mut self,
        from: usize,
        to: usize,
        level: usize,
        depth: usize,
        leaf: Leaf,
        out: &mut String,
    ) -> Result<(), RegexLimit> {
        if self.placed.is_none() {
            return self.leaf(leaf, from, to, out);
        }
        let wrap_at = |emitter: &Self, index: usize| -> Option<InlineWrap> {
            emitter
                .placed
                .as_ref()
                .and_then(|placed| placed[index][level].get(depth).cloned())
        };
        let mut g = from;
        while g < to {
            let wrap = wrap_at(self, g);
            let mut end = g + 1;
            let Some(wrap) = wrap else {
                while end < to && wrap_at(self, end).is_none() {
                    end += 1;
                }
                self.leaf(leaf, g, end, out)?;
                g = end;
                continue;
            };
            while end < to && same_inline_wrap(wrap_at(self, end).as_ref(), Some(&wrap)) {
                end += 1;
            }
            let once = inline_wrap_writes_once(&wrap);
            let key = inline_wrap_key(&wrap);
            if once && self.written.contains(&key) {
                // a content control is one element: runs that left its first group
                // go back without it rather than as a second control with its w:id
                self.within(g, end, level, depth + 1, leaf, out)?;
            } else {
                if once {
                    self.written.insert(key);
                }
                // text typed into a placeholder or a data-bound control: the two
                // properties that would make Word discard it go (see InlineWrap.text)
                let edited = wrap
                    .text
                    .as_ref()
                    .is_some_and(|text| inline_wrap_text_of(self.runs, g, end) != *text);
                let open = if edited {
                    sdt_open_for_changed_text(&wrap.open)?
                } else {
                    wrap.open.clone()
                };
                // a control written from runs is the one that gives way to a taken id
                match self.part {
                    Some(part) if once => out.push_str(&part.yielding(&open)),
                    _ => out.push_str(&open),
                }
                self.within(g, end, level, depth + 1, leaf, out)?;
                out.push_str(&wrap.close);
            }
            g = end;
        }
        Ok(())
    }
    fn leaf(
        &mut self,
        leaf: Leaf,
        from: usize,
        to: usize,
        out: &mut String,
    ) -> Result<(), RegexLimit> {
        match leaf {
            Leaf::Revisions => self.emit_revisions(from, to, out),
            Leaf::Range => self.emit_range(from, to, out),
            Leaf::Fragments { inside_link } => {
                for index in from..to {
                    out.push_str(&self.fragment(index, inside_link)?);
                }
                Ok(())
            }
        }
    }
    /// The runs of a hyperlink group, inside the wrappers that sat in the hyperlink.
    fn link_inner(
        &mut self,
        start: usize,
        end: usize,
        inside_link: bool,
    ) -> Result<String, RegexLimit> {
        let mut inner = String::new();
        self.within(
            start,
            end,
            2,
            0,
            Leaf::Fragments { inside_link },
            &mut inner,
        )?;
        Ok(inner)
    }
    fn emit_range(&mut self, from: usize, to: usize, out: &mut String) -> Result<(), RegexLimit> {
        let mut i = from;
        while i < to {
            let run = &self.runs[i];
            if let Some(link) = (*run.link).clone() {
                let start = i;
                let href = &link.href;
                let mut rid = link.r_id.clone();
                while i < to {
                    let Some(next_link) =
                        self.runs[i].link.as_ref().filter(|link| link.href == *href)
                    else {
                        break;
                    };
                    let next = next_link.r_id.as_deref();
                    if i > start && next.is_some() && rid.is_some() && next != rid.as_deref() {
                        break;
                    }
                    if rid.is_none() {
                        rid = next.map(str::to_owned);
                    }
                    i += 1;
                }
                for index in start..i {
                    self.starts_at(index, out);
                }
                let tip = link
                    .tooltip
                    .as_deref()
                    .filter(|tip| !tip.is_empty())
                    .map(|tip| format!(" w:tooltip=\"{}\"", attr(tip)))
                    .unwrap_or_default();
                if let Some(anchor) = href.strip_prefix('#') {
                    let inner = self.link_inner(start, i, true)?;
                    out.push_str(&format!(
                        "<w:hyperlink w:anchor=\"{}\"{tip}>{inner}</w:hyperlink>",
                        attr(anchor)
                    ));
                } else {
                    let allocated = if rid.is_none() {
                        self.allocate.as_mut().map(|allocate| allocate(href))
                    } else {
                        None
                    };
                    let final_rid = rid
                        .as_deref()
                        .or(allocated.as_deref())
                        .filter(|rid| !rid.is_empty());
                    if let Some(rid) = final_rid {
                        let inner = self.link_inner(start, i, true)?;
                        out.push_str(&format!(
                            "<w:hyperlink r:id=\"{}\"{tip}>{inner}</w:hyperlink>",
                            attr(rid)
                        ));
                    } else {
                        let inner = self.link_inner(start, i, false)?;
                        out.push_str(&inner);
                    }
                }
                for index in start..i {
                    self.ends_at(index, out);
                }
            } else {
                self.starts_at(i, out);
                out.push_str(&self.fragment(i, false)?);
                self.ends_at(i, out);
                i += 1;
            }
        }
        Ok(())
    }
    fn mint_id(&mut self) -> String {
        if let Some(allocate) = self.allocate_revision.as_mut() {
            allocate()
        } else {
            let id = self.revision_seq.to_string();
            self.revision_seq += 1;
            id
        }
    }
    fn revision_id(&mut self, info: &RevisionInfo) -> String {
        let mut id = info
            .id
            .as_ref()
            .filter(|id| !id.is_empty() && !self.emitted_ids.contains(*id))
            .cloned()
            .unwrap_or_else(|| self.mint_id());
        while self.emitted_ids.contains(&id) {
            id = self.mint_id();
        }
        self.emitted_ids.insert(id.clone());
        id
    }
    fn revision_attrs(&mut self, info: &RevisionInfo) -> String {
        let mut out = format!(
            " w:id=\"{}\" w:author=\"{}\"",
            attr(&self.revision_id(info)),
            attr(&info.author)
        );
        if let Some(date) = info.date.as_deref().filter(|date| !date.is_empty()) {
            out.push_str(&format!(" w:date=\"{}\"", attr(date)));
        }
        if let Some(date) = info.date_utc.as_deref().filter(|date| !date.is_empty()) {
            out.push_str(&format!(" w16du:dateUtc=\"{}\"", attr(date)));
        }
        out
    }
    /// `emitRevisions`: runs [from, to), each tracked-change group in its w:ins / w:del
    fn emit_revisions(
        &mut self,
        from: usize,
        to: usize,
        out: &mut String,
    ) -> Result<(), RegexLimit> {
        let runs = self.runs;
        let mut g = from;
        while g < to {
            let key = revision_key(&runs[g]);
            let mut end = g;
            while end < to && revision_key(&runs[end]) == key {
                end += 1;
            }
            if key.is_empty() {
                self.within(g, end, 1, 0, Leaf::Range, out)?;
            } else {
                let run = &runs[g];
                let (ins, del) = ((*run.ins).clone(), (*run.del).clone());
                let movement = move_of(Some(run));
                if let Some((side, name)) = movement.filter(|movement| {
                    Some(*movement) != move_of(g.checked_sub(1).map(|i| &runs[i]))
                }) {
                    let info = if side == "From" {
                        del.as_ref()
                    } else {
                        ins.as_ref()
                    }
                    .expect("move has a revision");
                    let name = name.to_owned();
                    let id = self.mint_id();
                    out.push_str(&format!(
                        "<w:move{side}RangeStart w:id=\"{}\" w:author=\"{}\"{} w:name=\"{}\"/>",
                        attr(&id),
                        attr(&info.author),
                        info.date
                            .as_deref()
                            .filter(|v| !v.is_empty())
                            .map(|date| format!(" w:date=\"{}\"", attr(date)))
                            .unwrap_or_default(),
                        attr(&name)
                    ));
                    self.open_range = Some((side, id));
                }
                let ins_tag = if ins
                    .as_ref()
                    .and_then(|info| info.r#move.as_deref())
                    .is_some_and(|v| !v.is_empty())
                {
                    "w:moveTo"
                } else {
                    "w:ins"
                };
                let del_tag = if del
                    .as_ref()
                    .and_then(|info| info.r#move.as_deref())
                    .is_some_and(|v| !v.is_empty())
                {
                    "w:moveFrom"
                } else {
                    "w:del"
                };
                let movement = move_of(Some(&runs[g])).map(|(side, name)| (side, name.to_owned()));
                if let Some(info) = &ins {
                    out.push_str(&format!("<{ins_tag}{}>", self.revision_attrs(info)));
                }
                if let Some(info) = &del {
                    out.push_str(&format!("<{del_tag}{}>", self.revision_attrs(info)));
                }
                self.within(g, end, 1, 0, Leaf::Range, out)?;
                if del.is_some() {
                    out.push_str(&format!("</{del_tag}>"));
                }
                if ins.is_some() {
                    out.push_str(&format!("</{ins_tag}>"));
                }
                let next = runs
                    .get(end)
                    .and_then(|run| move_of(Some(run)))
                    .map(|(side, name)| (side, name.to_owned()));
                if self.open_range.is_some()
                    && movement != next
                    && let Some((side, id)) = self.open_range.take()
                {
                    out.push_str(&format!("<w:move{side}RangeEnd w:id=\"{}\"/>", attr(&id)));
                }
            }
            g = end;
        }
        Ok(())
    }
}

fn glyph_runs(
    run: &Run,
    is_glyph: impl Fn(char) -> bool,
    glyph: impl Fn(char) -> Result<String, RegexLimit>,
    plain: impl Fn(&str) -> Result<String, RegexLimit>,
) -> Result<String, RegexLimit> {
    let mut out = String::new();
    let mut buffer = String::new();
    for ch in run.text.as_deref().unwrap_or_default().chars() {
        if is_glyph(ch) {
            if !buffer.is_empty() {
                out.push_str(&plain(&buffer)?);
                buffer.clear();
            }
            out.push_str(&glyph(ch)?);
        } else {
            buffer.push(ch);
        }
    }
    if !buffer.is_empty() {
        out.push_str(&plain(&buffer)?);
    }
    Ok(out)
}

fn checkbox_glyphs(xml: &str) -> (char, char) {
    let state = |re: &JsRegex, fallback: char| {
        let value = re.exec(xml).and_then(|m| m.get(1).or_else(|| m.get(2)));
        let code = parse_int(value.unwrap_or_default(), Radix::Sixteen);
        if code.is_finite() && code > 0.0 && code <= 0x10ffff as f64 {
            char::from_u32(code as u32).unwrap_or(fallback)
        } else {
            fallback
        }
    };
    (
        state(
            js_regex!(r#"<w14:checkedState\b[^>]*\bw14:val=(?:"([^"]*)"|'([^']*)')"#),
            '\u{2612}',
        ),
        state(
            js_regex!(r#"<w14:uncheckedState\b[^>]*\bw14:val=(?:"([^"]*)"|'([^']*)')"#),
            '\u{2610}',
        ),
    )
}

fn sync_checkbox(xml: &str, checked: bool) -> String {
    let val = format!("<w14:checked w14:val=\"{}\"/>", u8::from(checked));
    let stripped =
        js_regex!(r"<w14:checked(?:\s[^>]*)?/>", "g").replace_all(xml, |_| String::new());
    if let Some(m) = js_regex!(r"<w14:checkbox((?:\s[^>]*)?)/>").exec(&stripped) {
        format!(
            "{}<w14:checkbox{}>{val}</w14:checkbox>{}",
            &stripped[..m.start()],
            m.get(1).unwrap_or_default(),
            &stripped[m.end()..]
        )
    } else if let Some(m) = js_regex!(r"<w14:checkbox(?:\s[^>]*)?>").exec(&stripped) {
        format!("{}{val}{}", &stripped[..m.end()], &stripped[m.end()..])
    } else {
        stripped
    }
}

fn run_fragment_xml(run: &Run, inside_link: bool) -> Result<String, RegexLimit> {
    let run_text = run.text.as_deref().unwrap_or_default();
    if let Some(math) = &*run.math {
        return Ok(if math.display.unwrap_or(false) {
            format!("<m:oMathPara>{}</m:oMathPara>", math.omml)
        } else {
            math.omml.clone()
        });
    }
    if let Some(ruby) = &*run.ruby {
        return Ok(format!("<w:r>{}</w:r>", ruby.xml));
    }
    if let Some(image) = &*run.image {
        return Ok(format!(
            "{}<w:r>{}{}</w:r>",
            if run_text.is_empty() {
                String::new()
            } else {
                generate_run_xml(run, run_text, inside_link)?
            },
            run.raw_r_pr.as_deref().unwrap_or_default(),
            image.xml
        ));
    }
    if let Some(sym) = &*run.sym {
        return Ok(format!(
            "<w:r>{}<w:sym w:font=\"{}\" w:char=\"{}\"/></w:r>",
            run_r_pr_xml(run, inside_link)?,
            attr(&sym.font),
            attr(&sym.char)
        ));
    }
    if let Some(note) = &*run.note_ref {
        return Ok(format!(
            "<w:r>{}<w:{}Reference w:id=\"{}\"/></w:r>",
            run.raw_r_pr
                .as_deref()
                .unwrap_or("<w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr>"),
            note.kind.as_str(),
            attr(&note.id)
        ));
    }
    let begin = || {
        format!(
            "<w:r><w:fldChar w:fldCharType=\"begin\"{}/></w:r>",
            if run.fld_dirty.is_some() {
                " w:dirty=\"true\""
            } else {
                ""
            }
        )
    };
    let end = "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>";
    if let Some(reference) = &*run.ref_field {
        let default_instr = format!(" REF {} \\h ", reference.replace('"', ""));
        let instr = run.ref_instr.as_deref().unwrap_or(&default_instr);
        return Ok(format!(
            "{}<w:r><w:instrText xml:space=\"preserve\">{}</w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>{}{end}",
            begin(),
            text(instr),
            generate_run_xml(run, run_text, inside_link)?
        ));
    }
    if let Some(xml) = run
        .sdt_checkbox_xml
        .as_deref()
        .filter(|xml| !xml.is_empty())
    {
        let (checked, unchecked) = checkbox_glyphs(xml);
        return glyph_runs(
            run,
            |ch| ch == checked || ch == unchecked,
            |ch| {
                Ok(format!(
                    "<w:sdt>{}<w:sdtContent>{}</w:sdtContent></w:sdt>",
                    sync_checkbox(xml, ch == checked),
                    generate_run_xml(run, &ch.to_string(), inside_link)?
                ))
            },
            |plain| generate_run_xml(run, plain, inside_link),
        );
    }
    if let Some(instr) = &*run.instr_field {
        let instr_xml = format!(
            "<w:r><w:instrText xml:space=\"preserve\"> {} </w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
            text(instr)
        );
        if let Some(part) = run
            .zotero_field_part
            .as_ref()
            .map(|v| v.as_str())
            .filter(|v| *v != "single")
        {
            let cached = generate_run_xml(run, run_text, inside_link)?;
            return Ok(match part {
                "begin" => {
                    format!("<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>{instr_xml}{cached}")
                }
                "end" => format!("{cached}{end}"),
                _ => cached,
            });
        }
        if let Some(begin_xml) = run.fld_begin_xml.as_deref().filter(|xml| !xml.is_empty()) {
            return glyph_runs(
                run,
                |ch| matches!(ch, '\u{2610}' | '\u{2612}'),
                |ch| {
                    let val = format!("<w:checked w:val=\"{}\"/>", u8::from(ch == '\u{2612}'));
                    let mut synced = js_regex!(r"<w:checked(?:\s[^>]*)?/>", "g")
                        .replace_all(begin_xml, |_| String::new());
                    if synced.contains("</w:checkBox>") {
                        synced =
                            synced.replacen("</w:checkBox>", &format!("{val}</w:checkBox>"), 1);
                    } else if let Some(m) = js_regex!(r"<w:checkBox((?:\s[^>]*)?)/>").exec(&synced)
                    {
                        synced = format!(
                            "{}<w:checkBox{}>{val}</w:checkBox>{}",
                            &synced[..m.start()],
                            m.get(1).unwrap_or_default(),
                            &synced[m.end()..]
                        );
                    }
                    Ok(format!("{synced}{instr_xml}{end}"))
                },
                |plain| generate_run_xml(run, plain, inside_link),
            );
        }
        return Ok(format!(
            "{}{instr_xml}{}{end}",
            begin(),
            generate_run_xml(run, run_text, inside_link)?
        ));
    }
    let mut xml = if run_text.is_empty() {
        String::new()
    } else {
        generate_run_xml(run, run_text, inside_link)?
    };
    if let Some(term) = &*run.xe_term {
        xml.push_str(&format!("<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText xml:space=\"preserve\"> XE \"{}\" </w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",text(&term.replace('"',""))));
    }
    Ok(xml)
}

pub(crate) fn generate_run_xml(
    run: &Run,
    content: &str,
    inside_link: bool,
) -> Result<String, RegexLimit> {
    let text_tag = if run.del.is_some() {
        "w:delText"
    } else {
        "w:t"
    };
    let mut segments = String::new();
    let mut buffer = String::new();
    let flush = |segments: &mut String, buffer: &mut String| {
        if !buffer.is_empty() {
            segments.push_str(&format!(
                "<{text_tag} xml:space=\"preserve\">{}</{text_tag}>",
                text(buffer)
            ));
            buffer.clear();
        }
    };
    for ch in content.chars() {
        let atom = match ch {
            '\t' => Some("<w:tab/>"),
            '\n' => Some("<w:br/>"),
            '\u{c}' => Some("<w:br w:type=\"page\"/>"),
            '\u{b}' => Some("<w:br w:type=\"column\"/>"),
            '\u{1e}' => Some("<w:br w:type=\"textWrapping\" w:clear=\"all\"/>"),
            '\u{2011}' => Some("<w:noBreakHyphen/>"),
            '\u{ad}' => Some("<w:softHyphen/>"),
            _ => None,
        };
        if let Some(atom) = atom {
            flush(&mut segments, &mut buffer);
            segments.push_str(atom);
        } else {
            buffer.push(ch);
        }
    }
    flush(&mut segments, &mut buffer);
    Ok(format!(
        "<w:r>{}{segments}</w:r>",
        run_r_pr_xml(run, inside_link)?
    ))
}
