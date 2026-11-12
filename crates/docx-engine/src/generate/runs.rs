use crate::model::{RevisionInfo, Run};
use jscompat::{JsMap, Radix, RegexLimit, js_regex, parse_int};
use std::collections::HashSet;

use super::rpr::run_r_pr_xml;
use super::{escape_xml_attr as attr, escape_xml_text as text};

type Allocator<'a> = Option<&'a mut dyn FnMut(&str) -> String>;
type RevisionAllocator<'a> = Option<&'a mut dyn FnMut() -> String>;

pub fn inline_runs_xml(runs: &[Run]) -> Result<String, RegexLimit> {
    runs_xml(runs, None)
}

pub(crate) fn runs_xml(runs: &[Run], allocate: Allocator<'_>) -> Result<String, RegexLimit> {
    runs_xml_with_revisions(runs, allocate, None)
}

pub(crate) fn runs_xml_with_revisions(
    runs: &[Run],
    allocate: Allocator<'_>,
    allocate_revision: RevisionAllocator<'_>,
) -> Result<String, RegexLimit> {
    let mut emitter = Emitter {
        runs,
        allocate,
        allocate_revision,
        revision_seq: 9001,
        emitted_ids: HashSet::new(),
        first_of: JsMap::new(),
        last_of: JsMap::new(),
    };
    for (index, run) in runs.iter().enumerate() {
        for id in run.comment_ids.as_deref().unwrap_or_default() {
            if emitter.first_of.get(id).is_none() {
                emitter.first_of.set(id.clone(), index);
            }
            emitter.last_of.set(id.clone(), index);
        }
    }
    emitter.emit()
}

struct Emitter<'r, 'h, 'v> {
    runs: &'r [Run],
    allocate: Allocator<'h>,
    allocate_revision: RevisionAllocator<'v>,
    revision_seq: u64,
    emitted_ids: HashSet<String>,
    first_of: JsMap<usize>,
    last_of: JsMap<usize>,
}

fn revision_key(run: &Run) -> Option<(&Option<RevisionInfo>, &Option<RevisionInfo>)> {
    (run.ins.is_some() || run.del.is_some()).then_some((&*run.ins, &*run.del))
}

fn same_info(a: &RevisionInfo, b: &RevisionInfo) -> bool {
    a.author == b.author
        && a.date == b.date
        && a.date_utc == b.date_utc
        && a.id == b.id
        && a.r#move == b.r#move
}

fn same_revision(a: &Run, b: &Run) -> bool {
    let same = |a: &Option<RevisionInfo>, b: &Option<RevisionInfo>| match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => same_info(a, b),
        _ => false,
    };
    same(&a.ins, &b.ins) && same(&a.del, &b.del)
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

impl Emitter<'_, '_, '_> {
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
    fn emit_range(&mut self, from: usize, to: usize, out: &mut String) -> Result<(), RegexLimit> {
        let mut i = from;
        while i < to {
            let run = &self.runs[i];
            if let Some(link) = &*run.link {
                let start = i;
                let href = &link.href;
                let mut rid = link.r_id.as_deref();
                while i < to {
                    let Some(next_link) =
                        self.runs[i].link.as_ref().filter(|link| link.href == *href)
                    else {
                        break;
                    };
                    let next = next_link.r_id.as_deref();
                    if i > start && next.is_some() && rid.is_some() && next != rid {
                        break;
                    }
                    rid = rid.or(next);
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
                    out.push_str(&format!("<w:hyperlink w:anchor=\"{}\"{tip}>", attr(anchor)));
                    for run in &self.runs[start..i] {
                        out.push_str(&run_fragment_xml(run, true)?);
                    }
                    out.push_str("</w:hyperlink>");
                } else {
                    let allocated = if rid.is_none() {
                        self.allocate.as_mut().map(|allocate| allocate(href))
                    } else {
                        None
                    };
                    let final_rid = rid.or(allocated.as_deref()).filter(|rid| !rid.is_empty());
                    if let Some(rid) = final_rid {
                        out.push_str(&format!("<w:hyperlink r:id=\"{}\"{tip}>", attr(rid)));
                    }
                    for run in &self.runs[start..i] {
                        out.push_str(&run_fragment_xml(run, final_rid.is_some())?);
                    }
                    if final_rid.is_some() {
                        out.push_str("</w:hyperlink>");
                    }
                }
                for index in start..i {
                    self.ends_at(index, out);
                }
            } else {
                self.starts_at(i, out);
                out.push_str(&run_fragment_xml(run, false)?);
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
    fn emit(&mut self) -> Result<String, RegexLimit> {
        let mut out = String::new();
        let mut g = 0;
        let mut open_range: Option<(&str, String)> = None;
        while g < self.runs.len() {
            let mut end = g;
            while end < self.runs.len() && same_revision(&self.runs[g], &self.runs[end]) {
                end += 1;
            }
            let run = &self.runs[g];
            if revision_key(run).is_none() {
                self.emit_range(g, end, &mut out)?;
            } else {
                let movement = move_of(Some(run));
                if let Some((side, name)) = movement.filter(|movement| {
                    Some(*movement) != move_of(g.checked_sub(1).map(|i| &self.runs[i]))
                }) {
                    let info = if side == "From" {
                        run.del.as_ref()
                    } else {
                        run.ins.as_ref()
                    }
                    .expect("move has a revision");
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
                        attr(name)
                    ));
                    open_range = Some((side, id));
                }
                let ins_tag = if run
                    .ins
                    .as_ref()
                    .and_then(|info| info.r#move.as_deref())
                    .is_some_and(|v| !v.is_empty())
                {
                    "w:moveTo"
                } else {
                    "w:ins"
                };
                let del_tag = if run
                    .del
                    .as_ref()
                    .and_then(|info| info.r#move.as_deref())
                    .is_some_and(|v| !v.is_empty())
                {
                    "w:moveFrom"
                } else {
                    "w:del"
                };
                if let Some(info) = &*run.ins {
                    out.push_str(&format!("<{ins_tag}{}>", self.revision_attrs(info)));
                }
                if let Some(info) = &*run.del {
                    out.push_str(&format!("<{del_tag}{}>", self.revision_attrs(info)));
                }
                self.emit_range(g, end, &mut out)?;
                if run.del.is_some() {
                    out.push_str(&format!("</{del_tag}>"));
                }
                if run.ins.is_some() {
                    out.push_str(&format!("</{ins_tag}>"));
                }
                if open_range.is_some()
                    && movement != move_of(self.runs.get(end))
                    && let Some((side, id)) = open_range.take()
                {
                    out.push_str(&format!("<w:move{side}RangeEnd w:id=\"{}\"/>", attr(&id)));
                }
            }
            g = end;
        }
        Ok(out)
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
    let state = |name: &str, fallback: char| {
        let value = jscompat::JsRegex::new(
            &format!(r#"<w14:{name}\b[^>]*\bw14:val=(?:"([^"]*)"|'([^']*)')"#),
            "",
        )
        .ok()
        .and_then(|re| re.exec(xml).and_then(|m| m.get(1).or_else(|| m.get(2))));
        let code = parse_int(value.unwrap_or_default(), Radix::Sixteen);
        if code.is_finite() && code > 0.0 && code <= 0x10ffff as f64 {
            char::from_u32(code as u32).unwrap_or(fallback)
        } else {
            fallback
        }
    };
    (
        state("checkedState", '\u{2612}'),
        state("uncheckedState", '\u{2610}'),
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
