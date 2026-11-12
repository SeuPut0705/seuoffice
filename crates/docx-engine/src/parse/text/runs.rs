//! Runs: their resolved properties, the legacy direct reader, the note
//! display run and note numbers.

use std::collections::HashSet;

use jscompat::{JsMap, JsNum, Radix, js_regex, math_max, parse_int, truthy};
use ooxml_xml::XNode;

use crate::model::{
    EffectiveRPr, NoteInfo, NoteProps, NotePropsNumRestart, NoteRun, NoteRunCaps, PropSource, Run,
    RunCaps, RunVertAlign,
};
use crate::props::themed_r_fonts;
use crate::resolve::{self, ResolveCtx, resolve_run_props};
use crate::theme::ThemeFonts;
use crate::xml_text::on_off_of;

/// `RunResolve`, the members `effectiveRunOf` reads: the paragraph resolved,
/// the resolver context its runs read through, and one resolved run per
/// distinct rPr key.
pub struct RunResolve<'a> {
    pub eff: std::borrow::Cow<'a, resolve::EffectivePPr>,
    pub rctx: &'a ResolveCtx,
    pub memo: JsMap<resolve::EffectiveRPr>,
    /// the paragraph style chain's w:rtl (the inherited value of a run without its own flag)
    pub para_rtl: Option<bool>,
    /// shadow mode collector (`diff`)
    pub diff: Option<std::rc::Rc<std::cell::RefCell<Vec<super::context::ShadowDiff>>>>,
}

/// `effectiveRunOf`: the run properties of `r_pr` resolved over the
/// paragraph, once per `key` (the TypeScript's default key is `""`).
pub fn effective_run_of<'r>(
    res: &'r mut RunResolve<'_>,
    r_pr: Option<&XNode>,
    key: &str,
) -> &'r resolve::EffectiveRPr {
    if !res.memo.has(key) {
        let eff = resolve_run_props(
            r_pr,
            res.eff.style_id.as_deref(),
            res.eff.bidi,
            res.rctx,
            false,
        );
        res.memo.set(key, eff);
    }
    res.memo
        .get(key)
        .unwrap_or_else(|| unreachable!("the key was set above"))
}

/// `attrsOf(findChild(node, name) ?? {})['w:val']`
fn child_val<'a>(node: &'a XNode, name: &str) -> Option<&'a str> {
    node.find_child(name).and_then(|child| child.attr("w:val"))
}

/// `legacyDirectRunFormat`: extractRun's former reader of the direct w:rPr
/// keys the resolver now owns (shadow mode).
pub fn legacy_direct_run_format(r_pr: &XNode, cs: bool, theme_fonts: Option<&ThemeFonts>) -> Run {
    let mut run = Run::default();
    run.text.set(String::new());
    if let Some(bold) = on_off_of(r_pr, if cs { "w:bCs" } else { "w:b" }) {
        run.bold.set(bold);
    }
    if let Some(italic) = on_off_of(r_pr, if cs { "w:iCs" } else { "w:i" }) {
        run.italic.set(italic);
    }
    // `underlineProp`: a w:u without w:val is no underline
    let underline = child_val(r_pr, "w:u");
    if underline.is_some_and(|val| val != "none") {
        run.underline.set(true);
    } else if underline == Some("none") {
        run.underline.set(false);
    }
    if let Some(strike) = on_off_of(r_pr, "w:strike") {
        run.strike.set(strike);
    }
    let sz = parse_int(
        child_val(r_pr, if cs { "w:szCs" } else { "w:sz" }).unwrap_or(""),
        Radix::Ten,
    );
    // Word clamps w:sz to one half-point: sz=0 lays out at 0.5pt, not at the default size
    if sz.is_finite() {
        run.size_half_points.set(JsNum(math_max(1.0, sz)));
    }
    let empty = XNode::empty();
    let rf = themed_r_fonts(r_pr.find_child("w:rFonts").unwrap_or(&empty), theme_fonts);
    // w:hAnsi alone never stands in for the ascii slot: Word inherits ascii from the
    // style chain and uses hAnsi only for the high-ANSI range (probe 2026-11-02)
    let font = truthy(rf.east_asia.as_deref().or(rf.ascii.as_deref()));
    if let Some(font) = font {
        run.font.set(font.to_owned());
    }
    if let Some(east_asia) = truthy(rf.east_asia.as_deref()) {
        run.east_asia_font.set(east_asia.to_owned());
    }
    if rf.ea_slot_empty && font.is_some() && font == rf.east_asia.as_deref() {
        run.ea_slot_empty.set(true);
    }
    if let Some(ascii) = truthy(rf.ascii.as_deref()) {
        run.font_ascii.set(ascii.to_owned());
    }
    // theme-resolved cs font for display consumers
    if let Some(cs_font) = truthy(rf.cs.as_deref()) {
        run.cs_font.set(cs_font.to_owned());
    }
    let spc = parse_int(child_val(r_pr, "w:spacing").unwrap_or(""), Radix::Ten);
    // an explicit 0 must beat the style's letter spacing
    if !spc.is_nan() {
        run.char_spacing_twips.set(JsNum(spc));
    }
    if let Some(kern) = child_val(r_pr, "w:kern") {
        let kern = parse_int(kern, Radix::Ten);
        // `|| 0`: NaN and -0 alike
        run.kern_half_points
            .set(JsNum(if kern == 0.0 || kern.is_nan() {
                0.0
            } else {
                kern
            }));
    }
    // w:caps wins over w:smallCaps when both are on (Word)
    let caps_on = on_off_of(r_pr, "w:caps");
    let small_caps_on = on_off_of(r_pr, "w:smallCaps");
    if caps_on == Some(true) {
        run.caps.set(RunCaps::All);
    } else if small_caps_on == Some(true) {
        run.caps.set(RunCaps::Small);
    } else if caps_on == Some(false) || small_caps_on == Some(false) {
        run.caps.set(RunCaps::None);
    }
    match child_val(r_pr, "w:vertAlign") {
        Some("superscript") => run.vert_align.set(RunVertAlign::Superscript),
        Some("subscript") => run.vert_align.set(RunVertAlign::Subscript),
        _ => {}
    }
    run
}

/// `noteRunOf`: a note display run, the run's direct look over the
/// paragraph's resolved base.
pub fn note_run_of(run: &Run, base: &EffectiveRPr) -> NoteRun {
    let mut out = NoteRun {
        text: run.text.as_deref().unwrap_or_default().to_owned(),
        ..NoteRun::default()
    };
    let cs = run.effective.as_ref().filter(|effective| effective.cs);
    if (*run.bold).or(cs.map(|cs| cs.bold)).unwrap_or(base.bold) {
        out.bold = Some(true);
    }
    if (*run.italic)
        .or(cs.map(|cs| cs.italic))
        .unwrap_or(base.italic)
    {
        out.italic = Some(true);
    }
    if (*run.underline).unwrap_or(base.underline) {
        out.underline = Some(true);
    }
    if (*run.strike).unwrap_or(base.strike) {
        out.strike = Some(true);
    }
    let color = run.color.as_deref().or(base.color.as_deref());
    if let Some(color) = truthy(color).filter(|color| js_regex!(r"^[0-9A-Fa-f]{6}$").test(color)) {
        out.color = Some(color.to_ascii_uppercase());
    }
    let size = (*run.size_half_points)
        .or(cs.map(|cs| cs.size_half_points))
        .or_else(|| {
            (base.source.get("sizeHalfPoints") != Some(&PropSource::Builtin))
                .then_some(base.size_half_points)
        });
    if let Some(size) = size.filter(|size| size.0 != 0.0 && !size.0.is_nan()) {
        out.size_half_points = Some(size);
    }
    let font_ascii = run.font_ascii.as_deref().or(base.fonts.ascii.as_deref());
    if let Some(font_ascii) = truthy(font_ascii) {
        out.font_ascii = Some(font_ascii.to_owned());
    }
    let caps = (*run.caps).map_or(base.caps.as_str(), RunCaps::as_str);
    out.caps = match caps {
        "all" => Some(NoteRunCaps::All),
        "small" => Some(NoteRunCaps::Small),
        _ => None,
    };
    if let Some(outline) = run.text_outline.as_ref() {
        out.text_outline = Some(outline.clone());
    }
    if let Some(ins) = run.ins.as_ref() {
        out.ins = Some(ins.clone());
    }
    if let Some(del) = run.del.as_ref() {
        out.del = Some(del.clone());
    }
    out
}

/// The two kinds of note.
#[derive(Clone, Copy)]
enum NoteKind {
    Footnote,
    Endnote,
}

/// `noteNumbersOf`: the display number of each note, `"footnote:<id>"` or
/// `"endnote:<id>"`. A referenced note takes the next number of its kind at
/// its first reference (restarting per section under eachSect); later
/// references reuse it; an unreferenced note keeps its part-order number.
pub fn note_numbers_of(
    document_xml: &str,
    footnotes: &[NoteInfo],
    endnotes: &[NoteInfo],
    footnote_props: Option<&NoteProps>,
    endnote_props: Option<&NoteProps>,
) -> JsMap<JsNum> {
    let mut out = JsMap::new();
    for (i, n) in footnotes.iter().enumerate() {
        out.set(format!("footnote:{}", n.id), JsNum((i + 1) as f64));
    }
    for (i, n) in endnotes.iter().enumerate() {
        out.set(format!("endnote:{}", n.id), JsNum((i + 1) as f64));
    }
    let props = |kind: NoteKind| match kind {
        NoteKind::Footnote => footnote_props,
        NoteKind::Endnote => endnote_props,
    };
    let mut count = [0.0_f64; 2];
    let mut numbered: HashSet<String> = HashSet::new();
    let mut depth: i64 = 0;
    let mut sect_depth: i64 = -1;
    let re = js_regex!(
        r"<w:(footnote|endnote)Reference\b([^>]*?)\/?>|<w:sectPr[\s>]|<w:p(?:\s[^>]*)?\/?>|<\/w:p>",
        "g"
    );
    for m in re.find_iter(document_xml) {
        let whole = m.as_str();
        if whole.starts_with("<w:sectPr") {
            sect_depth = depth;
            continue;
        }
        if whole.starts_with("<w:p") {
            if !whole.ends_with("/>") {
                depth += 1;
            }
            continue;
        }
        if whole == "</w:p>" {
            depth -= 1;
            if sect_depth > depth {
                sect_depth = -1;
                for kind in [NoteKind::Footnote, NoteKind::Endnote] {
                    if props(kind).and_then(|p| *p.num_restart)
                        == Some(NotePropsNumRestart::EachSect)
                    {
                        count[kind as usize] = 0.0;
                    }
                }
            }
            continue;
        }
        let (kind, name) = if m.get(1) == Some("footnote") {
            (NoteKind::Footnote, "footnote")
        } else {
            (NoteKind::Endnote, "endnote")
        };
        let attrs = m.get(2).unwrap_or("");
        if js_regex!(r#"w:customMarkFollows="(?:1|true)""#).test(attrs) {
            continue;
        }
        let Some(id) = truthy(
            js_regex!(r#"w:id="([^"]+)""#)
                .exec(attrs)
                .and_then(|found| found.get(1)),
        ) else {
            continue;
        };
        let key = format!("{name}:{id}");
        if !out.has(&key) || numbered.contains(&key) {
            continue;
        }
        let start = props(kind)
            .and_then(|p| *p.num_start)
            .map_or(1.0, |start| start.0);
        let number = start + count[kind as usize];
        count[kind as usize] += 1.0;
        numbered.insert(key.clone());
        out.set(key, JsNum(number));
    }
    out
}
