//! Text half of generate.ts: surgical patches of runs and paragraphs, and the
//! rebuild path that regenerates a `<p:txBody>`.

use jscompat::{
    JsNum, JsRegex, index_of, js_regex, last_index_of, number_truthy, prefix_utf16,
    replace_first_with, try_js_regex,
};

use super::{
    TopLevelChild, clamp_int, escape_xml_attr, escape_xml_text, from_, hex6, is_fill_tag, lim, n,
    sl, spc_pct_xml, spc_pts_xml, sz_attr, top_level_children, upto,
};
use crate::placeholder::BulletType;
use crate::redaction_xml::{has_redact_ext_in, redact_ext_xml, sync_redact_ext};
use crate::types::{
    EaLang, FontScriptHint, PPrDirty, PPrExplicit, Paragraph, ParagraphBullet,
    ParagraphDefaultRunProps, TextAlign, TextAnchor, TextBody, TextElement, TextRun,
};
use crate::xml_utils::attribute_of;

use jscompat::math_round;

// ── Model readers (JavaScript truthiness of a model slot) ───────────────

/// A boolean key that is `true`.
fn tb(o: &Option<bool>) -> bool {
    *o == Some(true)
}

/// A string key that is set and not empty.
fn ts(o: &Option<String>) -> Option<&str> {
    o.as_deref().filter(|s| !s.is_empty())
}

fn runs_of(p: &Paragraph) -> &[TextRun] {
    p.runs.as_deref().unwrap_or(&[])
}

fn paragraphs_of(b: &TextBody) -> &[Paragraph] {
    b.paragraphs.as_deref().unwrap_or(&[])
}

// ── Bullets ──────────────────────────────────────────────────────────────

/// buSzPts wins over buSzPct (both never round-trip together).
fn bullet_size_xml(b: &ParagraphBullet) -> String {
    if let Some(pt) = *b.size_pt {
        return format!(
            "<a:buSzPts val=\"{}\"/>",
            n(clamp_int(pt.0 * 100.0, 100.0, 400_000.0))
        );
    }
    if let Some(pct) = *b.size_pct {
        return format!(
            "<a:buSzPct val=\"{}\"/>",
            n(clamp_int(pct.0 * 1000.0, 25_000.0, 400_000.0))
        );
    }
    String::new()
}

/// The glyph element. A picture bullet inherited from the layout/master carries no slide-part
/// relationship, so nothing is written and the paragraph keeps inheriting the picture.
fn bullet_glyph_xml(b: &ParagraphBullet) -> String {
    if *b.r#type == Some(BulletType::Number) {
        let start = match *b.start_at {
            Some(s) => format!(" startAt=\"{}\"", n(s.0)),
            None => String::new(),
        };
        return format!(
            "<a:buAutoNum type=\"{}\"{start}/>",
            escape_xml_attr(b.num_type.as_deref().unwrap_or("arabicPeriod"))
        );
    }
    if *b.r#type == Some(BulletType::Blip) {
        return match ts(&b.blip_embed_id) {
            Some(id) => format!(
                "<a:buBlip><a:blip r:embed=\"{}\"/></a:buBlip>",
                escape_xml_attr(id)
            ),
            None => String::new(),
        };
    }
    format!(
        "<a:buChar char=\"{}\"/>",
        escape_xml_attr(b.char.as_deref().unwrap_or("\u{2022}"))
    )
}

/// The bullet's color, size, font and glyph, as written by both the patch and the rebuild.
fn bullet_kids_xml(b: &ParagraphBullet) -> String {
    let mut s = String::new();
    if let Some(node) = ts(&b.color_node_xml) {
        s += &format!("<a:buClr>{node}</a:buClr>");
    } else if let Some(color) = ts(&b.color) {
        s += &format!("<a:buClr><a:srgbClr val=\"{}\"/></a:buClr>", hex6(color));
    }
    s += &bullet_size_xml(b);
    if let Some(font) = ts(&b.font) {
        s += &format!("<a:buFont typeface=\"{}\"/>", escape_xml_attr(font));
    }
    s += &bullet_glyph_xml(b);
    s
}

// ── Text element patch ───────────────────────────────────────────────────

/// In-place patch of a text/shape element's original XML.
/// `original_xml` = the `<p:sp>`'s full original byte slice (anchor.originalXml).
pub fn patch_text_element_xml(el: &TextElement, original_xml: &str) -> Result<String, String> {
    let Some(body) = el.text.as_ref() else {
        return Ok(original_xml.to_owned());
    };
    let model_paragraphs = paragraphs_of(body);
    if model_paragraphs.is_empty() {
        return Ok(original_xml.to_owned());
    }
    // The in-place patch writes each run into the old run at the same position; when a
    // traced paragraph/run moved, that position holds another run's attributes, so the
    // model's own paragraphs are rebuilt from their traced runs instead.
    if tb(&el.text_moved) {
        return Ok(rebuild_tx_body(el, original_xml));
    }

    let model_runs: Vec<&TextRun> = model_paragraphs
        .iter()
        .flat_map(|p| runs_of(p).iter())
        .collect();
    let run_spans = find_run_spans(original_xml);

    let paragraph_spans = find_paragraph_spans(original_xml);
    let paragraphs_aligned = paragraph_spans.len() == model_paragraphs.len()
        && paragraph_spans.iter().enumerate().all(|(index, span)| {
            find_run_spans(sl(original_xml, span.0, span.1)).len()
                == model_paragraphs.get(index).map_or(0, |p| runs_of(p).len())
        });

    let aligned = paragraphs_aligned
        && run_spans.len() == model_runs.len()
        && !run_spans.is_empty()
        && run_spans.iter().enumerate().all(|(i, s)| {
            (s.is_br || s.newline_only) == model_runs.get(i).is_some_and(|r| is_soft_break_run(r))
        });
    if aligned {
        let mut out = String::new();
        let mut cursor = 0;
        for (i, span) in run_spans.iter().enumerate() {
            out += sl(original_xml, cursor, span.start);
            let slice = sl(original_xml, span.start, span.end);
            let Some(run) = model_runs.get(i) else {
                break;
            };
            if span.is_br || span.newline_only {
                out += slice;
            } else if span.raw {
                match run.raw_xml.as_deref() {
                    Some(raw) => out += raw,
                    None => out += &generate_run_xml(run),
                }
            } else {
                out += &patch_run(slice, run)?;
            }
            cursor = span.end;
        }
        out += from_(original_xml, cursor);
        return Ok(out);
    }

    // Structural change → rebuild the <p:txBody> content, keeping the txBody wrapper and bodyPr
    Ok(rebuild_tx_body(el, original_xml))
}

#[derive(Clone, Copy)]
enum PprGroup {
    LnSpc,
    SpcBef,
    SpcAft,
    Bullet,
}

const PPR_GROUPS: [PprGroup; 4] = [
    PprGroup::LnSpc,
    PprGroup::SpcBef,
    PprGroup::SpcAft,
    PprGroup::Bullet,
];

/// pPr children we model (extracted and reordered by group during surgical patches).
fn ppr_child_re(group: PprGroup) -> &'static JsRegex {
    match group {
        PprGroup::LnSpc => js_regex!(r"<a:lnSpc\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/a:lnSpc>)"),
        PprGroup::SpcBef => js_regex!(r"<a:spcBef\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/a:spcBef>)"),
        PprGroup::SpcAft => js_regex!(r"<a:spcAft\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/a:spcAft>)"),
        PprGroup::Bullet => js_regex!(
            r"<a:bu(?:ClrTx|Clr|SzTx|SzPct|SzPts|FontTx|Font|None|AutoNum|Char|Blip)\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/a:bu(?:ClrTx|Clr|SzTx|SzPct|SzPts|FontTx|Font|None|AutoNum|Char|Blip)>)"
        ),
    }
}

fn spacing_xml(tag: &str, pts: Option<JsNum>, pct: Option<JsNum>) -> String {
    if let Some(v) = pts {
        return format!("<a:{tag}>{}</a:{tag}>", spc_pts_xml(v.0));
    }
    if let Some(v) = pct {
        return format!("<a:{tag}>{}</a:{tag}>", spc_pct_xml(v.0));
    }
    String::new()
}

/// Generate one group of pPr children from the model paragraph (for surgical patches).
fn build_p_pr_group(p: &Paragraph, group: PprGroup) -> String {
    match group {
        PprGroup::LnSpc => spacing_xml("lnSpc", *p.line_exact, *p.line_height),
        PprGroup::SpcBef => spacing_xml("spcBef", *p.space_before, *p.space_before_pct),
        PprGroup::SpcAft => spacing_xml("spcAft", *p.space_after, *p.space_after_pct),
        PprGroup::Bullet => {
            let Some(b) = p.bullet.as_ref() else {
                return String::new();
            };
            if *b.r#type == Some(BulletType::None) {
                return "<a:buNone/>".to_owned();
            }
            bullet_kids_xml(b)
        }
    }
}

fn align_code(a: TextAlign) -> &'static str {
    match a {
        TextAlign::Left => "l",
        TextAlign::Center => "ctr",
        TextAlign::Right => "r",
        TextAlign::Justify => "just",
    }
}

/// Set or remove one attribute of an `<a:pPr` open tag.
fn set_p_pr_attr(open_tag: &mut String, name: &str, value: Option<&str>) -> Result<(), String> {
    // `name` is one of the attributes of an `<a:pPr>` this file sets: a literal pattern each
    macro_rules! attr_re {
        ($name:literal) => {
            js_regex!(concat!(r"\s", $name, r#"="[^"]*""#))
        };
    }
    let re = match name {
        "algn" => attr_re!("algn"),
        "rtl" => attr_re!("rtl"),
        "lvl" => attr_re!("lvl"),
        "marL" => attr_re!("marL"),
        "indent" => attr_re!("indent"),
        _ => return Err(format!("no attribute pattern for {name}")),
    };
    let Some(value) = value else {
        *open_tag = replace_first_with(re, open_tag, |_| String::new());
        return Ok(());
    };
    let decl = format!(" {name}=\"{}\"", escape_xml_attr(value));
    if re.test(open_tag) {
        *open_tag = replace_first_with(re, open_tag, |_| decl.clone());
    } else if let Some(rest) = open_tag.strip_prefix("<a:pPr") {
        *open_tag = format!("<a:pPr{decl}{rest}");
    }
    Ok(())
}

/// Surgically patch the `<a:pPr>` of one `<a:p>…</a:p>` slice: only reorder groups we
/// model that are flagged dirty (lnSpc/spcBef/spcAft/bu*); non-dirty groups keep
/// their original bytes and join the reorder in schema order. Attrs (algn/marL/indent)
/// are set in place.
pub fn patch_paragraph_p_pr_xml(
    para_xml: &str,
    p: &Paragraph,
    which: &PPrDirty,
) -> Result<String, String> {
    let re_ppr = js_regex!(r"<a:pPr\b([^>]*?)(\/?)>");
    let locate = |s: &str| {
        re_ppr.exec(s).map(|m| {
            (
                m.start(),
                m.end(),
                m.get(1).unwrap_or_default().to_owned(),
                m.get(2).unwrap_or_default().to_owned(),
            )
        })
    };
    let mut para = para_xml.to_owned();
    let missing = || "Cannot read properties of null (reading 'index')".to_owned();
    let m = match locate(&para) {
        None => {
            if let Some(rest) = para.strip_prefix("<a:p>") {
                para = format!("<a:p><a:pPr></a:pPr>{rest}");
            }
            locate(&para).ok_or_else(missing)?
        }
        Some((start, end, attrs, close)) => {
            if close == "/" {
                para = format!(
                    "{}<a:pPr{attrs}></a:pPr>{}",
                    upto(&para, start),
                    from_(&para, end)
                );
                locate(&para).ok_or_else(missing)?
            } else {
                (start, end, attrs, close)
            }
        }
    };
    let (m_start, open_end) = (m.0, m.1);
    let Some(close_at) = index_of(&para, "</a:pPr>", open_end) else {
        return Ok(para);
    };
    let mut open_tag = sl(&para, m_start, open_end).to_owned();
    let mut inner = sl(&para, open_end, close_at).to_owned();

    if tb(&which.align) {
        set_p_pr_attr(&mut open_tag, "algn", p.align.map(align_code))?;
    }
    if tb(&which.rtl) {
        set_p_pr_attr(
            &mut open_tag,
            "rtl",
            p.rtl.map(|v| if v { "1" } else { "0" }),
        )?;
    }
    if tb(&which.level) {
        let level = match *p.level {
            Some(l) if number_truthy(l.0) => Some(n(l.0)),
            _ => None,
        };
        set_p_pr_attr(&mut open_tag, "lvl", level.as_deref())?;
    }
    if tb(&which.indents) {
        let mar_l = (*p.mar_l).map(|v| n(clamp_int(v.0, 0.0, 51_206_400.0)));
        set_p_pr_attr(&mut open_tag, "marL", mar_l.as_deref())?;
        let indent = (*p.indent).map(|v| n(clamp_int(v.0, -51_206_400.0, 51_206_400.0)));
        set_p_pr_attr(&mut open_tag, "indent", indent.as_deref())?;
    }

    // Child groups: extract all (keeping original bytes), regenerate dirty groups from the
    // model, then splice back at the start in schema order
    let mut kept: Vec<String> = Vec::with_capacity(4);
    for g in PPR_GROUPS {
        let re = ppr_child_re(g);
        kept.push(re.find_iter(&inner).map(|m| m.as_str()).collect::<String>());
        inner = re.replace_all(&inner, |_| String::new());
    }
    let mut block = String::new();
    for (g, kept) in PPR_GROUPS.iter().zip(&kept) {
        let dirty = match g {
            PprGroup::LnSpc => &which.ln_spc,
            PprGroup::SpcBef => &which.spc_bef,
            PprGroup::SpcAft => &which.spc_aft,
            PprGroup::Bullet => &which.bullet,
        };
        if tb(dirty) {
            block += &build_p_pr_group(p, *g);
        } else {
            block += kept;
        }
    }

    Ok(format!(
        "{}{open_tag}{block}{inner}{}",
        upto(&para, m_start),
        from_(&para, close_at)
    ))
}

/// Locate all top-level `<a:p>…</a:p>` spans (start, end) in document order.
fn find_paragraph_spans(xml: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(start) = index_of(xml, "<a:p>", from) {
        let after = start + "<a:p>".len();
        let Some(close) = index_of(xml, "</a:p>", after) else {
            break;
        };
        let end = close + "</a:p>".len();
        spans.push((start, end));
        from = end;
    }
    spans
}

/// Element-level paragraph formatting patch: surgically patch pPr per `<a:p>` (run
/// bytes untouched). `None` when the paragraph count doesn't match the model
/// (the caller falls back to rebuild).
pub fn patch_element_p_pr(
    el: &TextElement,
    xml: &str,
    which: &PPrDirty,
) -> Result<Option<String>, String> {
    let paras = el.text.as_ref().map_or(&[][..], paragraphs_of);
    let spans = find_paragraph_spans(xml);
    if spans.len() != paras.len() || spans.is_empty() {
        return Ok(None);
    }
    let mut out = String::new();
    let mut cursor = 0;
    for (i, (start, end)) in spans.iter().enumerate() {
        out += sl(xml, cursor, *start);
        let skipped = which
            .para_indices
            .as_ref()
            .is_some_and(|list| !list.iter().any(|v| v.0 == i as f64));
        match paras.get(i) {
            Some(p) if !skipped => {
                out += &patch_paragraph_p_pr_xml(sl(xml, *start, *end), p, which)?;
            }
            _ => out += sl(xml, *start, *end),
        }
        cursor = *end;
    }
    out += from_(xml, cursor);
    Ok(Some(out))
}

/// Soft-break sentinel run (parse rewrites `<a:br/>` as a run with text="\n").
fn is_soft_break_run(r: &TextRun) -> bool {
    r.text.as_deref() == Some("\n") && !tb_str(&r.field)
}

fn tb_str(o: &Option<String>) -> bool {
    ts(o).is_some()
}

struct Span {
    start: usize,
    end: usize,
    is_br: bool,
    newline_only: bool,
    /// an `<mc:AlternateContent>` math block standing in the run sequence
    raw: bool,
}

/// Locate all top-level `<a:r>…</a:r>` and `<a:br/>` (incl. paired form) spans in document order.
fn find_run_spans(xml: &str) -> Vec<Span> {
    let re =
        js_regex!(r"<a:r>|<a:r\s[^>]*>|<a:br\b[^>]*\/>|<a:br\b[^>]*>|<mc:AlternateContent\b[^>]*>");
    let mut spans = Vec::new();
    // `re.lastIndex = end` of the TypeScript: a match that starts before it is skipped
    let mut resume = 0;
    for m in re.find_iter(xml) {
        if m.start() < resume {
            continue;
        }
        let start = m.start();
        let whole = m.as_str();
        let last = m.end();
        if whole.starts_with("<mc:AlternateContent") {
            // Only a paragraph-level math block is a run; a shape-level AC anchor is scanned through
            let head = prefix_utf16(from_(xml, last), 400);
            if !js_regex!(r"^\s*<mc:Choice\b[^>]*>\s*<a14:m\b").test(head) {
                continue;
            }
            let Some(close) = index_of(xml, "</mc:AlternateContent>", last) else {
                break;
            };
            let end = close + "</mc:AlternateContent>".len();
            spans.push(Span {
                start,
                end,
                is_br: false,
                newline_only: false,
                raw: true,
            });
            resume = end;
            continue;
        }
        if whole.starts_with("<a:br") {
            if whole.ends_with("/>") {
                spans.push(Span {
                    start,
                    end: last,
                    is_br: true,
                    newline_only: false,
                    raw: false,
                });
            } else {
                let Some(close) = index_of(xml, "</a:br>", last) else {
                    break;
                };
                let end = close + "</a:br>".len();
                spans.push(Span {
                    start,
                    end,
                    is_br: true,
                    newline_only: false,
                    raw: false,
                });
                resume = end;
            }
            continue;
        }
        let Some(close) = index_of(xml, "</a:r>", last) else {
            break;
        };
        let end = close + "</a:r>".len();
        // A run whose text is only a line break parses as a soft-break sentinel (XML folds
        // CRLF to LF); keeping its bytes preserves the formatting a bare <a:br/> would drop
        let newline_only = js_regex!(r"<a:t(?:\s[^>]*)?>\r?\n<\/a:t>").test(sl(xml, start, end));
        spans.push(Span {
            start,
            end,
            is_br: false,
            newline_only,
            raw: false,
        });
        resume = end;
    }
    spans
}

// ── Run patch ────────────────────────────────────────────────────────────

/// Patch a single `<a:r>`: replace the `<a:t>` text + adjust `<a:rPr>` formatting as needed.
fn patch_run(run_xml: &str, run: &TextRun) -> Result<String, String> {
    let text = run.text.as_deref().unwrap_or_default();
    let mut out = run_xml.to_owned();

    // 1. Replace the <a:t> text content (keeping attributes like xml:space); a self-closing
    // <a:t/> (empty run) opens up when text is typed into it
    let self_closing_t = js_regex!(r"<a:t(\s[^>]*?)?\/>");
    if !text.is_empty() && self_closing_t.test(&out) {
        out = replace_first_with(self_closing_t, &out, |m| {
            format!(
                "<a:t{}>{}</a:t>",
                m.get(1).unwrap_or_default(),
                escape_xml_text(text)
            )
        });
    }
    out = replace_first_with(
        js_regex!(r"(<a:t(?:\s[^>]*)?>)([\s\S]*?)(<\/a:t>)"),
        &out,
        |m| {
            format!(
                "{}{}{}",
                m.get(1).unwrap_or_default(),
                escape_xml_text(text),
                m.get(3).unwrap_or_default()
            )
        },
    );
    // If the original run has no <a:t> (rare), leave it alone
    if !js_regex!(r"<a:t").test(run_xml) {
        return Ok(out);
    }
    // Still-empty paragraph-mark run: its props are <a:endParaRPr>'s, not the empty run's.
    if tb(&run.para_mark) && text.is_empty() {
        return Ok(out);
    }
    // 2. Patch <a:rPr> boolean/size attributes + solidFill color
    patch_run_props(&out, run)
}

fn attr_re(name: &str) -> &'static JsRegex {
    match name {
        "b" => js_regex!(r#"\sb="[^"]*""#),
        "i" => js_regex!(r#"\si="[^"]*""#),
        "u" => js_regex!(r#"\su="[^"]*""#),
        "strike" => js_regex!(r#"\sstrike="[^"]*""#),
        "baseline" => js_regex!(r#"\sbaseline="[^"]*""#),
        "sz" => js_regex!(r#"\ssz="[^"]*""#),
        _ => js_regex!(r#"\sspc="[^"]*""#),
    }
}

/// Hangul syllables, jamo and compatibility jamo: what the layout wraps by word in a Korean run.
fn hangul_re() -> &'static JsRegex {
    js_regex!(r"[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7a3\ud7b0-\ud7ff]")
}

/// `hangulLang`: the language tag for text written without one: `ko-KR` when it holds Hangul
/// (alone or mixed with Latin), which is what PowerPoint writes for a Korean user's typing.
pub fn hangul_lang(text: &str) -> Option<&'static str> {
    hangul_re().test(text).then_some("ko-KR")
}

/// The tag `tagHangulRun` would add; `None` where it returns the run itself.
fn hangul_tag_of(run: &TextRun) -> Option<&'static str> {
    if run.lang.is_some() || run.alt_lang.is_some() || ts(&run.raw_xml).is_some() {
        return None;
    }
    hangul_lang(run.text.as_deref().unwrap_or_default())
}

/// `tagHangulRun`: a run as an authoring writer stores it, tagged per `hangulLang` unless it
/// already carries a language, which is never replaced. Importers do not call this.
pub fn tag_hangul_run(run: &TextRun) -> TextRun {
    let mut out = run.clone();
    if let Some(lang) = hangul_tag_of(run) {
        out.lang.set(lang.to_owned());
        out.ea_lang.set(EaLang::Ko);
        out.font_script_hint.set(FontScriptHint::Ko);
    }
    out
}

/// `tagHangulParagraphs`: `tagHangulRun` over every run; `None` (the same array) when no run
/// needed a tag.
pub fn tag_hangul_paragraphs(paragraphs: &[Paragraph]) -> Option<Vec<Paragraph>> {
    let mut changed = false;
    let out = paragraphs
        .iter()
        .map(|p| {
            if !runs_of(p).iter().any(|run| hangul_tag_of(run).is_some()) {
                return p.clone();
            }
            changed = true;
            let mut tagged = p.clone();
            tagged
                .runs
                .set(runs_of(p).iter().map(tag_hangul_run).collect());
            tagged
        })
        .collect();
    changed.then_some(out)
}

/// Set a boolean attribute (true→="1", false→explicit ="0" overriding inheritance, undefined→untouched).
fn set_bool_attr(tag: &str, name: &str, val: Option<bool>) -> String {
    match val {
        None => tag.to_owned(),
        Some(v) => set_attr(tag, name, Some(if v { "1" } else { "0" })),
    }
}

/// Set/replace an attribute. `None` means untouched (keep the original value).
/// The value goes in as given, not as a JavaScript replacement string.
fn set_attr(tag: &str, name: &str, value: Option<&str>) -> String {
    let Some(value) = value else {
        return tag.to_owned();
    };
    let existing_re = attr_re(name);
    let decl = format!(" {name}=\"{}\"", escape_xml_attr(value));
    if existing_re.test(tag) {
        return replace_first_with(existing_re, tag, |_| decl.clone());
    }
    // Inject after the tag name (after <a:rPr)
    match tag.strip_prefix("<a:rPr") {
        Some(rest) => format!("<a:rPr{decl}{rest}"),
        None => tag.to_owned(),
    }
}

/// Patch or inject the b/i/u/sz attributes and color on `<a:rPr>`.
fn patch_run_props(run_xml: &str, run: &TextRun) -> Result<String, String> {
    let attr_patch = |rpr_open: &str| -> String {
        let mut tag = rpr_open.to_owned();
        // A language the model gained (tagHangulRun on text written into an untagged run) is
        // written; one that is already in the bytes is never replaced
        if let Some(lang) = run.lang.as_deref()
            && !js_regex!(r"\slang\s*=").test(&tag)
            && let Some(rest) = tag.strip_prefix("<a:rPr")
        {
            // The value goes in as given, not as a JavaScript replacement string
            tag = format!("<a:rPr lang=\"{}\"{rest}", escape_xml_attr(lang));
        }
        tag = set_bool_attr(
            &tag,
            "b",
            if tb(&run.bold_implicit) {
                None
            } else {
                *run.bold
            },
        );
        tag = set_bool_attr(
            &tag,
            "i",
            if tb(&run.italic_implicit) {
                None
            } else {
                *run.italic
            },
        );
        // Underline: keep the original style; on removal an existing u becomes none, and no u
        // is injected when there was none unless the model asks for an explicit none.
        let u_val: Option<&str> = if tb(&run.underline) {
            if tb(&run.underline_implicit) {
                None
            } else {
                Some(run.underline_style.as_deref().unwrap_or("sng"))
            }
        } else if attr_re("u").test(&tag) || tb(&run.underline_explicit_none) {
            Some("none")
        } else {
            None
        };
        tag = set_attr(&tag, "u", u_val);
        let strike_val: Option<&str> = if tb(&run.strike) {
            Some(run.strike_style.as_deref().unwrap_or("sngStrike"))
        } else if attr_re("strike").test(&tag) {
            Some("noStrike")
        } else {
            None
        };
        tag = set_attr(&tag, "strike", strike_val);
        let bl_val: Option<String> = match *run.baseline {
            Some(b) if number_truthy(b.0) => Some(n(math_round(b.0 * 1000.0))),
            _ => {
                if attr_re("baseline").test(&tag) {
                    Some("0".to_owned())
                } else {
                    None
                }
            }
        };
        tag = set_attr(&tag, "baseline", bl_val.as_deref());
        let sz = match *run.font_size {
            Some(s) if !tb(&run.font_size_implicit) => Some(sz_attr(s.0)),
            _ => None,
        };
        tag = set_attr(&tag, "sz", sz.as_deref());
        // Letter spacing: only an edited value is written; normal spacing drops the attribute
        if tb(&run.letter_spacing_edited) {
            tag = match *run.letter_spacing {
                Some(ls) if number_truthy(ls.0) => {
                    set_attr(&tag, "spc", Some(&n(math_round(ls.0 * 100.0))))
                }
                _ => replace_first_with(attr_re("spc"), &tag, |_| String::new()),
            };
        }
        tag
    };

    let mut run_xml = run_xml.to_owned();
    if js_regex!(r"<a:rPr\b").test(&run_xml) {
        // Handle self-closing <a:rPr .../> and paired <a:rPr ...>…</a:rPr>
        run_xml = replace_first_with(js_regex!(r"<a:rPr\b([^>]*?)(\/?)>"), &run_xml, |m| {
            let patched = attr_patch(&format!("<a:rPr{}", m.get(1).unwrap_or_default()));
            let close = if m.get(2).unwrap_or_default().is_empty() {
                ">"
            } else {
                "/>"
            };
            format!("{patched}{close}")
        });
        // Color: patch or inject solidFill. colorFollowsTheme / colorInherited: keep the
        // original bytes.
        if let Some(color) = ts(&run.color)
            && !tb(&run.color_follows_theme)
            && !tb(&run.color_inherited)
        {
            run_xml = patch_run_color(&run_xml, color)?;
        }
        // Font: only when the user actually changed it
        if let Some(family) = ts(&run.font_family)
            && ts(&run.latin_font).is_none()
            && ts(&run.ea_font).is_none()
            && !tb(&run.font_implicit)
        {
            run_xml = patch_run_font(&run_xml, family)?;
        }
        run_xml = patch_run_hlink(&run_xml, run)?;
        if tb(&run.highlight_edited) {
            run_xml = patch_run_highlight(&run_xml, ts(&run.highlight))?;
        }
        // "Withheld from the model": apply or clear it when the model disagrees
        if let Some(label) = ts(&run.redact) {
            run_xml = sync_redact_ext(&run_xml, "a:rPr", Some(label)).map_err(|e| e.to_string())?;
        } else if has_redact_ext_in(&run_xml).map_err(|e| e.to_string())? {
            run_xml = sync_redact_ext(&run_xml, "a:rPr", None).map_err(|e| e.to_string())?;
        }
    } else {
        // No rPr: inject a minimal rPr after <a:r>
        let attrs = build_r_pr_attrs(run);
        let color = if let Some(node) = ts(&run.color_node_xml) {
            format!("<a:solidFill>{node}</a:solidFill>")
        } else if let Some(c) = ts(&run.color)
            && !tb(&run.color_follows_theme)
            && !tb(&run.color_inherited)
        {
            format!(
                "<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>",
                hex6(c)
            )
        } else {
            String::new()
        };
        let font = match ts(&run.font_family) {
            Some(f)
                if !tb(&run.font_implicit)
                    && ts(&run.latin_font).is_none()
                    && ts(&run.ea_font).is_none() =>
            {
                font_slots_xml(&escape_xml_attr(f))
            }
            _ => String::new(),
        };
        let highlight = match ts(&run.highlight) {
            Some(h) => format!(
                "<a:highlight><a:srgbClr val=\"{}\"/></a:highlight>",
                hex6(h)
            ),
            None => String::new(),
        };
        // schema order: fill, highlight, the font slots, hlinkClick
        let inner = format!("{color}{highlight}{font}{}", hlink_xml(run));
        let rpr = if inner.is_empty() {
            format!("<a:rPr{attrs}/>")
        } else {
            format!("<a:rPr{attrs}>{inner}</a:rPr>")
        };
        // the rPr text goes in as given (document text; no `$` expansion)
        run_xml = replace_first_with(js_regex!(r"(<a:r(?:\s[^>]*)?>)"), &run_xml, |m| {
            format!("{}{rpr}", m.get(1).unwrap_or_default())
        });
    }
    Ok(run_xml)
}

/// Write the run's own `<a:highlight>` (color) or remove it (None), in schema order.
fn patch_run_highlight(run_xml: &str, color: Option<&str>) -> Result<String, String> {
    let Some(r_pr) = own_r_pr(run_xml)? else {
        return Ok(run_xml.to_owned());
    };
    let node = match color {
        Some(c) => format!(
            "<a:highlight><a:srgbClr val=\"{}\"/></a:highlight>",
            hex6(c)
        ),
        None => String::new(),
    };
    if r_pr.self_closing {
        if node.is_empty() {
            return Ok(run_xml.to_owned());
        }
        return Ok(format!(
            "{}<a:rPr{}>{node}</a:rPr>{}",
            upto(run_xml, r_pr.start),
            r_pr.attrs,
            from_(run_xml, r_pr.end)
        ));
    }
    let children = top_level_children(run_xml, r_pr.inner_start, r_pr.inner_end)?;
    if let Some(existing) = children.iter().find(|c| c.name == "a:highlight") {
        return Ok(format!(
            "{}{node}{}",
            upto(run_xml, existing.start),
            from_(run_xml, existing.end)
        ));
    }
    if node.is_empty() {
        return Ok(run_xml.to_owned());
    }
    // CT_TextCharacterProperties: ln, the fill group and the effect list come before highlight
    let before = |name: &str| {
        name == "a:ln" || is_fill_tag(name) || name == "a:effectLst" || name == "a:effectDag"
    };
    let at = children
        .iter()
        .rfind(|c| before(&c.name))
        .map_or(r_pr.inner_start, |c| c.end);
    Ok(format!("{}{node}{}", upto(run_xml, at), from_(run_xml, at)))
}

/// `<a:hlinkClick>` for the model's rId (empty when none).
fn hlink_xml(run: &TextRun) -> String {
    // Named show actions carry an empty r:id, so presence (not truthiness) decides
    let Some(r_id) = run.hyperlink_r_id.as_deref() else {
        return String::new();
    };
    if r_id.is_empty() && ts(&run.hyperlink_action).is_none() {
        return String::new();
    }
    let mut s = format!(
        "<a:hlinkClick xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" r:id=\"{}\"",
        escape_xml_attr(r_id)
    );
    if let Some(action) = ts(&run.hyperlink_action) {
        s += &format!(" action=\"{}\"", escape_xml_attr(action));
    }
    if let Some(tip) = ts(&run.hyperlink_tooltip) {
        s += &format!(" tooltip=\"{}\"", escape_xml_attr(tip));
    }
    s += "/>";
    s
}

/// The run's own `<a:rPr>`, with the range of its content.
struct OwnRPr {
    start: usize,
    end: usize,
    attrs: String,
    self_closing: bool,
    inner_start: usize,
    inner_end: usize,
}

/// The first element's open tag of a fragment (`^<name attrs>`), the attribute loop lazy.
fn open_tag_len(xml: &str) -> Result<Option<usize>, String> {
    let re = try_js_regex!(r#"^<[^\s/>]+(?:"[^"]*"|'[^']*'|[^"'>])*?>"#);
    Ok(re.try_exec(xml).map_err(lim)?.map(|m| m.end()))
}

/// The run's own `<a:rPr>` (a direct child, not an a:rPr inside an extension payload) with the
/// range of its content; `None` when it cannot be located structurally.
fn own_r_pr(run_xml: &str) -> Result<Option<OwnRPr>, String> {
    let Some(open_len) = open_tag_len(run_xml)? else {
        return Ok(None);
    };
    let children = top_level_children(run_xml, open_len, run_xml.len())?;
    let Some(r_pr) = children.into_iter().find(|c| c.name == "a:rPr") else {
        return Ok(None);
    };
    let el = sl(run_xml, r_pr.start, r_pr.end);
    let self_re = try_js_regex!(r#"^<a:rPr\b((?:"[^"]*"|'[^']*'|[^"'>])*?)\/>$"#);
    if let Some(m) = self_re.try_exec(el).map_err(lim)? {
        return Ok(Some(OwnRPr {
            start: r_pr.start,
            end: r_pr.end,
            attrs: m.get(1).unwrap_or_default().to_owned(),
            self_closing: true,
            inner_start: r_pr.end,
            inner_end: r_pr.end,
        }));
    }
    let open_re = try_js_regex!(r#"^<a:rPr\b(?:"[^"]*"|'[^']*'|[^"'>])*?>"#);
    let Some(open) = open_re.try_exec(el).map_err(lim)? else {
        return Ok(None);
    };
    let inner_end = r_pr.start + last_index_of(el, "</", i64::MAX).unwrap_or(0);
    Ok(Some(OwnRPr {
        start: r_pr.start,
        end: r_pr.end,
        attrs: String::new(),
        self_closing: false,
        inner_start: r_pr.start + open.end(),
        inner_end,
    }))
}

/// Sync `<a:hlinkClick>` in the rPr with the model: no-op when the rId already matches.
fn patch_run_hlink(run_xml: &str, run: &TextRun) -> Result<String, String> {
    let existing = js_regex!(r"<a:hlinkClick\b[^>]*>")
        .exec(run_xml)
        .map(|m| m.as_str());
    // Read as the parser reads them into the model: decoded (the same value spelled another way
    // is not a change), and an id that is present but empty is '', which a named action carries
    let (existing_r_id, existing_action) = match existing {
        Some(tag) => (
            Some(attribute_of(tag, "r:id").unwrap_or_default()),
            attribute_of(tag, "action").filter(|action| !action.is_empty()),
        ),
        None => (None, None),
    };
    if existing_r_id.as_deref() == run.hyperlink_r_id.as_deref()
        && existing_action.as_deref() == run.hyperlink_action.as_deref()
    {
        return Ok(run_xml.to_owned());
    }
    // Strip the old one (self-closing or paired)
    let run_xml = replace_first_with(
        js_regex!(r"<a:hlinkClick\b[^>]*\/>|<a:hlinkClick\b[^>]*>[\s\S]*?<\/a:hlinkClick>"),
        run_xml,
        |_| String::new(),
    );
    let hlink = hlink_xml(run);
    if hlink.is_empty() {
        return Ok(run_xml);
    }
    let Some(r_pr) = own_r_pr(&run_xml)? else {
        return Ok(run_xml);
    };
    if r_pr.self_closing {
        return Ok(format!(
            "{}<a:rPr{}>{hlink}</a:rPr>{}",
            upto(&run_xml, r_pr.start),
            r_pr.attrs,
            from_(&run_xml, r_pr.end)
        ));
    }
    // hlinkClick sits after latin/ea/cs/sym but before rtl/extLst — among the rPr's OWN children
    let at = top_level_children(&run_xml, r_pr.inner_start, r_pr.inner_end)?
        .iter()
        .find(|c| c.name == "a:rtl" || c.name == "a:extLst")
        .map_or(r_pr.inner_end, |c| c.start);
    Ok(format!(
        "{}{hlink}{}",
        upto(&run_xml, at),
        from_(&run_xml, at)
    ))
}

/// The three script slots written together. Takes an already-escaped typeface.
fn font_slots_xml(esc: &str) -> String {
    format!("<a:latin typeface=\"{esc}\"/><a:ea typeface=\"{esc}\"/><a:cs typeface=\"{esc}\"/>")
}

/// The font slots, in CT_TextCharacterProperties order.
const FONT_SLOTS: [&str; 3] = ["a:latin", "a:ea", "a:cs"];

/// The rPr children that follow the font slots.
fn after_font_slots(name: &str) -> bool {
    matches!(
        name,
        "a:sym" | "a:hlinkClick" | "a:hlinkMouseOver" | "a:rtl" | "a:extLst"
    )
}

/// Point an element's own typeface attribute at a new value (start tag only).
fn set_typeface(el: &str, esc: &str) -> Result<String, String> {
    let tag_re = try_js_regex!(r#"^<[^\s/>]+(?:"[^"]*"|'[^']*'|[^"'>])*>"#);
    let Some(tag) = tag_re.try_exec(el).map_err(lim)?.map(|m| m.as_str()) else {
        return Ok(el.to_owned());
    };
    let name = js_regex!(r"^<[^\s/>]+")
        .exec(tag)
        .map(|m| m.as_str())
        .unwrap_or_default();
    let close = if tag.ends_with("/>") { "/>" } else { ">" };
    let mut had = false;
    let attrs = js_regex!(r#"\s([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')"#).replace_all(
        sl(tag, name.len(), tag.len().saturating_sub(close.len())),
        |m| {
            if m.get(1) != Some("typeface") {
                return m.as_str().to_owned();
            }
            had = true;
            format!(" typeface=\"{esc}\"")
        },
    );
    let attrs = if had {
        attrs
    } else {
        format!("{attrs} typeface=\"{esc}\"")
    };
    Ok(format!("{name}{attrs}{close}{}", from_(el, tag.len())))
}

/// CT_TextCharacterProperties children. Anything else means the scan below cannot be trusted.
fn is_known_r_pr_child(name: &str) -> bool {
    matches!(
        name,
        "a:ln"
            | "a:noFill"
            | "a:solidFill"
            | "a:gradFill"
            | "a:blipFill"
            | "a:pattFill"
            | "a:grpFill"
            | "a:effectLst"
            | "a:effectDag"
            | "a:highlight"
            | "a:uLnTx"
            | "a:uLn"
            | "a:uFillTx"
            | "a:uFill"
            | "a:latin"
            | "a:ea"
            | "a:cs"
            | "a:sym"
            | "a:hlinkClick"
            | "a:hlinkMouseOver"
            | "a:rtl"
            | "a:extLst"
    )
}

/// The font patch as it stood before complex-script support, kept for any run this file
/// cannot scan structurally. `escaped` goes in as given.
fn patch_run_font_unscannable(run_xml: &str, escaped: &str) -> String {
    if js_regex!(r"<a:latin\b").test(run_xml) {
        let mut run_xml = replace_first_with(
            js_regex!(r#"(<a:latin\b[^>]*?\btypeface=")[^"]*(")"#),
            run_xml,
            |m| {
                format!(
                    "{}{escaped}{}",
                    m.get(1).unwrap_or_default(),
                    m.get(2).unwrap_or_default()
                )
            },
        );
        if js_regex!(r"<a:ea\b").test(&run_xml) {
            run_xml = replace_first_with(
                js_regex!(r#"(<a:ea\b[^>]*?\btypeface=")[^"]*(")"#),
                &run_xml,
                |m| {
                    format!(
                        "{}{escaped}{}",
                        m.get(1).unwrap_or_default(),
                        m.get(2).unwrap_or_default()
                    )
                },
            );
        } else {
            run_xml = replace_first_with(
                js_regex!(r"(<a:latin\b[^>]*\/>|<a:latin\b[^>]*>[\s\S]*?<\/a:latin>)"),
                &run_xml,
                |m| {
                    format!(
                        "{}<a:ea typeface=\"{escaped}\"/>",
                        m.get(1).unwrap_or_default()
                    )
                },
            );
        }
        return run_xml;
    }
    let fonts = format!("<a:latin typeface=\"{escaped}\"/><a:ea typeface=\"{escaped}\"/>");
    if js_regex!(r"<a:rPr\b[^>]*\/>").test(run_xml) {
        return replace_first_with(js_regex!(r"<a:rPr\b([^>]*?)\/>"), run_xml, |m| {
            format!("<a:rPr{}>{fonts}</a:rPr>", m.get(1).unwrap_or_default())
        });
    }
    replace_first_with(js_regex!(r"<\/a:rPr>"), run_xml, |_| {
        format!("{fonts}</a:rPr>")
    })
}

/// Patch or inject the run font: `<a:latin>`/`<a:ea>`/`<a:cs>` typeface, kept in sync.
/// Works on the direct children of the run's own `<a:rPr>`.
fn patch_run_font(run_xml: &str, family: &str) -> Result<String, String> {
    let esc = escape_xml_attr(family);
    // Comments, CDATA and processing instructions can all carry element-looking text
    if js_regex!(r"<!--|<!\[CDATA\[|<\?").test(run_xml) {
        return Ok(patch_run_font_unscannable(run_xml, &esc));
    }
    // A name outside what top_level_children reads would be taken short: refuse the run
    for m in js_regex!(r"<\/?([^\s/>!?][^\s/>]*)").find_iter(run_xml) {
        if !js_regex!(r"^[a-zA-Z][\w:]*$").test(m.get(1).unwrap_or_default()) {
            return Ok(patch_run_font_unscannable(run_xml, &esc));
        }
    }
    let Some(open_len) = open_tag_len(run_xml)? else {
        return Ok(patch_run_font_unscannable(run_xml, &esc));
    };
    let Some(r_pr) = top_level_children(run_xml, open_len, run_xml.len())?
        .into_iter()
        .find(|c| c.name == "a:rPr")
    else {
        return Ok(patch_run_font_unscannable(run_xml, &esc));
    };
    let el = sl(run_xml, r_pr.start, r_pr.end);
    // Self-closing rPr → expand to a pair around the slots (checked before the open-tag match)
    let self_re = try_js_regex!(r#"^<a:rPr\b((?:"[^"]*"|'[^']*'|[^"'>])*?)\/>$"#);
    if let Some(m) = self_re.try_exec(el).map_err(lim)? {
        return Ok(format!(
            "{}<a:rPr{}>{}</a:rPr>{}",
            upto(run_xml, r_pr.start),
            m.get(1).unwrap_or_default(),
            font_slots_xml(&esc),
            from_(run_xml, r_pr.end)
        ));
    }
    let open_re = try_js_regex!(r#"^<a:rPr\b(?:"[^"]*"|'[^']*'|[^"'>])*?>"#);
    let Some(r_pr_open) = open_re.try_exec(el).map_err(lim)?.map(|m| m.end()) else {
        return Ok(patch_run_font_unscannable(run_xml, &esc));
    };
    let inner_start = r_pr.start + r_pr_open;
    // the closing tag's own start, since a valid one may carry whitespace before its '>'
    let inner_end = r_pr.start + last_index_of(el, "</", i64::MAX).unwrap_or(0);
    if inner_end <= inner_start {
        return Ok(patch_run_font_unscannable(run_xml, &esc));
    }
    let children = top_level_children(run_xml, inner_start, inner_end)?;
    // An unrecognised child is a markup-compatibility wrapper or something else that supplies
    // the real children indirectly
    if children.iter().any(|c| !is_known_r_pr_child(&c.name)) {
        return Ok(patch_run_font_unscannable(run_xml, &esc));
    }
    let slots: Vec<&TopLevelChild> = children
        .iter()
        .filter(|c| FONT_SLOTS.contains(&c.name.as_str()))
        .collect();
    // A repeated slot is not something to reason about
    let mut names: Vec<&str> = slots.iter().map(|c| c.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    if names.len() != slots.len() {
        return Ok(patch_run_font_unscannable(run_xml, &esc));
    }
    // Rebuild the group whole so it comes out as latin, ea, cs, keeping each existing
    // element's other attributes (pitchFamily, charset, panose)
    let mut block = String::new();
    for tag in FONT_SLOTS {
        match slots.iter().find(|s| s.name == tag) {
            None => block += &format!("<{tag} typeface=\"{esc}\"/>"),
            Some(found) => block += &set_typeface(sl(run_xml, found.start, found.end), &esc)?,
        }
    }
    // Every removal below sits at or after this point, so the index stays valid through them
    let at = match slots.first() {
        Some(first) => first.start,
        None => children
            .iter()
            .find(|c| after_font_slots(&c.name))
            .map_or(inner_end, |c| c.start),
    };
    let mut out = run_xml.to_owned();
    for c in slots.iter().rev() {
        out = format!("{}{}", upto(&out, c.start), from_(&out, c.end));
    }
    Ok(format!("{}{block}{}", upto(&out, at), from_(&out, at)))
}

fn patch_run_color(run_xml: &str, color: &str) -> Result<String, String> {
    let hex = hex6(color);
    let fill = format!("<a:solidFill><a:srgbClr val=\"{hex}\"/></a:solidFill>");
    let Some(r_pr) = own_r_pr(run_xml)? else {
        return Ok(run_xml.to_owned());
    };
    if r_pr.self_closing {
        return Ok(format!(
            "{}<a:rPr{}>{fill}</a:rPr>{}",
            upto(run_xml, r_pr.start),
            r_pr.attrs,
            from_(run_xml, r_pr.end)
        ));
    }
    let inner_start = r_pr.inner_start;
    let children = top_level_children(run_xml, inner_start, r_pr.inner_end)?;
    // One fill child, after a:ln. The text fill is the rPr's own direct child: the solidFill
    // inside a:ln is the outline and must not be recolored instead.
    if let Some(existing) = children.iter().find(|c| is_fill_tag(&c.name)) {
        let existing_xml = sl(run_xml, existing.start, existing.end);
        // solidFill/srgbClr keeps its modifiers (alpha…) and only changes val
        let patched = if js_regex!(r"^<a:solidFill>\s*<a:srgbClr\b").test(existing_xml) {
            replace_first_with(
                js_regex!(r#"(<a:srgbClr\b[^>]*?\bval=")[^"]*(")"#),
                existing_xml,
                |m| {
                    format!(
                        "{}{hex}{}",
                        m.get(1).unwrap_or_default(),
                        m.get(2).unwrap_or_default()
                    )
                },
            )
        } else {
            fill
        };
        return Ok(format!(
            "{}{patched}{}",
            upto(run_xml, existing.start),
            from_(run_xml, existing.end)
        ));
    }
    let at = children
        .iter()
        .find(|c| c.name == "a:ln")
        .map_or(inner_start, |c| c.end);
    Ok(format!("{}{fill}{}", upto(run_xml, at), from_(run_xml, at)))
}

fn build_r_pr_attrs(run: &TextRun) -> String {
    // Explicit "off" values (b="0", u="none", strike="noStrike", spc="0"…) are overrides of
    // inherited styling, not defaults — dropping them on a rebuild flips the run.
    let mut s = String::new();
    // The language tag picks the run's line-breaking rules: a rebuild must keep it
    if let Some(lang) = run.lang.as_deref() {
        s += &format!(" lang=\"{}\"", escape_xml_attr(lang));
    }
    if let Some(alt_lang) = run.alt_lang.as_deref() {
        s += &format!(" altLang=\"{}\"", escape_xml_attr(alt_lang));
    }
    if let Some(sz) = *run.font_size
        && !tb(&run.font_size_implicit)
    {
        s += &format!(" sz=\"{}\"", sz_attr(sz.0));
    }
    if let Some(b) = *run.bold
        && !tb(&run.bold_implicit)
    {
        s += &format!(" b=\"{}\"", if b { "1" } else { "0" });
    }
    if let Some(i) = *run.italic
        && !tb(&run.italic_implicit)
    {
        s += &format!(" i=\"{}\"", if i { "1" } else { "0" });
    }
    if tb(&run.underline) && !tb(&run.underline_implicit) {
        s += &format!(
            " u=\"{}\"",
            escape_xml_attr(run.underline_style.as_deref().unwrap_or("sng"))
        );
    } else if tb(&run.underline_explicit_none) {
        s += " u=\"none\"";
    }
    if tb(&run.strike) {
        s += &format!(
            " strike=\"{}\"",
            escape_xml_attr(run.strike_style.as_deref().unwrap_or("sngStrike"))
        );
    } else if tb(&run.strike_explicit_none) {
        s += " strike=\"noStrike\"";
    }
    if let Some(kern) = *run.kern {
        s += &format!(" kern=\"{}\"", n(math_round(kern.0 * 100.0)));
    }
    if let Some(cap) = ts(&run.cap_explicit) {
        s += &format!(" cap=\"{}\"", escape_xml_attr(cap));
    }
    if let Some(ls) = *run.letter_spacing {
        s += &format!(" spc=\"{}\"", n(math_round(ls.0 * 100.0)));
    }
    if let Some(bl) = *run.baseline {
        s += &format!(" baseline=\"{}\"", n(math_round(bl.0 * 1000.0)));
    }
    s
}

/// Bytes of a `<p:cxnSp>`. CT_Connector's sequence is nvCxnSpPr/spPr/style/extLst —
/// there is no txBody child, so a connector can never gain text.
pub fn is_connector_xml(xml: &str) -> bool {
    js_regex!(r"^\s*<p:cxnSp[\s/>]").test(xml)
}

/// A shape that never carried text gains a whole `<p:txBody>`, after `</p:style>` whenever
/// the shape references a theme style.
fn inject_tx_body(body: &TextBody, original_xml: &str, paras: &str) -> String {
    if is_connector_xml(original_xml) {
        return original_xml.to_owned();
    }
    let anchor = match *body.anchor {
        Some(TextAnchor::Middle) => " anchor=\"ctr\"",
        Some(TextAnchor::Bottom) => " anchor=\"b\"",
        _ => "",
    };
    let tx_body = format!("<p:txBody><a:bodyPr{anchor}/><a:lstStyle/>{paras}</p:txBody>");
    // Placeholders inherit their geometry, so a self-closing <p:spPr/> is routine
    let res: [&JsRegex; 3] = [
        js_regex!(r"<\/p:style>"),
        js_regex!(r"<\/p:spPr>"),
        js_regex!(r"<p:spPr\b[^>]*\/>"),
    ];
    for re in res {
        if let Some(at) = re.exec(original_xml) {
            let end = at.end();
            return format!(
                "{}{tx_body}{}",
                upto(original_xml, end),
                from_(original_xml, end)
            );
        }
    }
    // Nothing recognizable to anchor against: appending still beats dropping the text
    match last_index_of(original_xml, "</p:sp>", i64::MAX) {
        None => original_xml.to_owned(),
        Some(close) => format!(
            "{}{tx_body}{}",
            upto(original_xml, close),
            from_(original_xml, close)
        ),
    }
}

/// Rebuild the `<p:txBody>`'s paragraph content on structural change, keeping the txBody
/// wrapper and `<a:bodyPr>`.
pub fn rebuild_tx_body(el: &TextElement, original_xml: &str) -> String {
    let Some(body) = el.text.as_ref() else {
        return original_xml.to_owned();
    };
    // CT_TextBody requires at least one <a:p>
    let mut paras: String = paragraphs_of(body)
        .iter()
        .map(generate_paragraph_xml)
        .collect();
    if paras.is_empty() {
        paras = "<a:p/>".to_owned();
    }

    // Keep the original txBody's bodyPr / lstStyle prefix verbatim; only the <a:p>… after it is replaced
    let Some(tx_open) = js_regex!(r"<p:txBody\b[^>]*>").exec(original_xml) else {
        return inject_tx_body(body, original_xml, &paras);
    };
    let tx_content_start = tx_open.end();
    // lastIndexOf('</p:txBody>') is -1 on a part that is not closed: slice(.., -1) drops the last character
    let (inner, tail) = match last_index_of(original_xml, "</p:txBody>", i64::MAX) {
        Some(tx_end) => (
            sl(original_xml, tx_content_start, tx_end),
            from_(original_xml, tx_end),
        ),
        None => {
            let cut = original_xml
                .char_indices()
                .next_back()
                .map_or(0, |(at, _)| at);
            (
                sl(original_xml, tx_content_start, cut),
                from_(original_xml, cut),
            )
        }
    };

    // Keep bodyPr + lstStyle, discard the old <a:p>
    let body_pr = js_regex!(r"<a:bodyPr\b(?:[^>]*?)(?:\/>|>[\s\S]*?<\/a:bodyPr>)")
        .exec(inner)
        .map_or("<a:bodyPr/>", |m| m.as_str());
    let lst_style = js_regex!(r"<a:lstStyle\b(?:[^>]*?)(?:\/>|>[\s\S]*?<\/a:lstStyle>)")
        .exec(inner)
        .map_or("", |m| m.as_str());

    format!(
        "{}{body_pr}{lst_style}{paras}{tail}",
        upto(original_xml, tx_content_start)
    )
}

fn explicit(ex: Option<&PPrExplicit>, key: impl Fn(&PPrExplicit) -> &Option<bool>) -> bool {
    ex.is_none_or(|e| tb(key(e)))
}

/// Generate `<a:p>` from a model paragraph (for the rebuild path).
pub fn generate_paragraph_xml(p: &Paragraph) -> String {
    let ex = p.p_pr_explicit.as_ref();
    let mut attrs: Vec<String> = Vec::new();
    let flag = |v: bool| if v { 1 } else { 0 };
    if let Some(v) = *p.mar_l
        && explicit(ex, |e| &*e.mar_l)
    {
        attrs.push(format!("marL=\"{}\"", n(clamp_int(v.0, 0.0, 51_206_400.0))));
    }
    if let Some(v) = *p.mar_r
        && explicit(ex, |e| &*e.mar_r)
    {
        attrs.push(format!("marR=\"{}\"", n(math_round(v.0))));
    }
    if let Some(v) = *p.def_tab_sz
        && explicit(ex, |e| &*e.def_tab_sz)
    {
        attrs.push(format!("defTabSz=\"{}\"", n(math_round(v.0))));
    }
    if let Some(v) = *p.indent
        && explicit(ex, |e| &*e.indent)
    {
        attrs.push(format!(
            "indent=\"{}\"",
            n(clamp_int(v.0, -51_206_400.0, 51_206_400.0))
        ));
    }
    if let Some(a) = *p.align
        && explicit(ex, |e| &*e.align)
    {
        attrs.push(format!("algn=\"{}\"", align_code(a)));
    }
    if let Some(v) = *p.rtl {
        attrs.push(format!("rtl=\"{}\"", flag(v)));
    }
    if let Some(v) = *p.ea_ln_brk
        && explicit(ex, |e| &*e.ea_ln_brk)
    {
        attrs.push(format!("eaLnBrk=\"{}\"", flag(v)));
    }
    if let Some(v) = *p.latin_ln_brk
        && explicit(ex, |e| &*e.latin_ln_brk)
    {
        attrs.push(format!("latinLnBrk=\"{}\"", flag(v)));
    }
    if let Some(v) = *p.hanging_punct
        && explicit(ex, |e| &*e.hanging_punct)
    {
        attrs.push(format!("hangingPunct=\"{}\"", flag(v)));
    }
    if let Some(level) = *p.level
        && number_truthy(level.0)
    {
        attrs.push(format!("lvl=\"{}\"", n(level.0)));
    }

    // CT_TextParagraphProperties child order: lnSpc → spcBef → spcAft → buClr → buSzPct → buFont → bu*
    let mut kids = String::new();
    if explicit(ex, |e| &*e.ln_spc) {
        kids += &spacing_xml("lnSpc", *p.line_exact, *p.line_height);
    }
    if explicit(ex, |e| &*e.spc_bef) {
        kids += &spacing_xml("spcBef", *p.space_before, *p.space_before_pct);
    }
    if explicit(ex, |e| &*e.spc_aft) {
        kids += &spacing_xml("spcAft", *p.space_after, *p.space_after_pct);
    }
    if let Some(b) = p.bullet.as_ref()
        && explicit(ex, |e| &*e.bullet)
    {
        if *b.r#type == Some(BulletType::None) {
            kids += "<a:buNone/>";
        } else {
            kids += &bullet_kids_xml(b);
        }
    }
    if let Some(stops) = p.tab_stops.as_deref()
        && !stops.is_empty()
        && explicit(ex, |e| &*e.tab_lst)
    {
        kids += "<a:tabLst>";
        for t in stops {
            kids += &format!("<a:tab pos=\"{}\"", n(math_round(t.pos.0)));
            if let Some(algn) = t.algn.as_deref().filter(|a| !a.is_empty()) {
                kids += &format!(" algn=\"{}\"", escape_xml_attr(algn));
            }
            kids += "/>";
        }
        kids += "</a:tabLst>";
    }
    // Paragraph default run properties come last (schema: … → tabLst → defRPr)
    if let Some(d) = p.def_r_pr.as_ref() {
        kids += &def_r_pr_xml(d);
    }

    let attr_str = if attrs.is_empty() {
        String::new()
    } else {
        format!(" {}", attrs.join(" "))
    };
    let p_pr = if !kids.is_empty() {
        format!("<a:pPr{attr_str}>{kids}</a:pPr>")
    } else if !attrs.is_empty() {
        format!("<a:pPr{attr_str}/>")
    } else {
        String::new()
    };
    let runs: String = runs_of(p).iter().map(generate_run_xml).collect();
    format!("<a:p>{p_pr}{runs}</a:p>")
}

/// `<a:defRPr>` from the modeled paragraph defaults (fill → latin → ea → cs).
fn def_r_pr_xml(d: &ParagraphDefaultRunProps) -> String {
    let mut attrs = String::new();
    if let Some(sz) = d.font_size {
        attrs += &format!(" sz=\"{}\"", sz_attr(sz.0));
    }
    if let Some(b) = d.bold {
        attrs += &format!(" b=\"{}\"", if b { 1 } else { 0 });
    }
    if let Some(i) = d.italic {
        attrs += &format!(" i=\"{}\"", if i { 1 } else { 0 });
    }
    if let Some(cap) = d.cap.as_deref().filter(|c| !c.is_empty()) {
        attrs += &format!(" cap=\"{}\"", escape_xml_attr(cap));
    }
    let mut inner = String::new();
    if let Some(node) = d.color_node_xml.as_deref().filter(|c| !c.is_empty()) {
        inner += &format!("<a:solidFill>{node}</a:solidFill>");
    } else if let Some(color) = d.color.as_deref().filter(|c| !c.is_empty()) {
        inner += &format!(
            "<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>",
            hex6(color)
        );
    }
    for (tag, font) in [
        ("latin", &d.latin_font),
        ("ea", &d.ea_font),
        ("cs", &d.cs_font),
    ] {
        if let Some(f) = font.as_deref().filter(|f| !f.is_empty()) {
            inner += &format!("<a:{tag} typeface=\"{}\"/>", escape_xml_attr(f));
        }
    }
    if attrs.is_empty() && inner.is_empty() {
        return String::new();
    }
    if inner.is_empty() {
        format!("<a:defRPr{attrs}/>")
    } else {
        format!("<a:defRPr{attrs}>{inner}</a:defRPr>")
    }
}

fn generate_run_xml(r: &TextRun) -> String {
    if let Some(raw) = ts(&r.raw_xml) {
        return raw.to_owned();
    }
    // Soft-break sentinel → <a:br/>
    if is_soft_break_run(r) {
        return "<a:br/>".to_owned();
    }
    let text = r.text.as_deref().unwrap_or_default();
    // CRLF (Windows) and a lone CR (old Mac) are line breaks too
    if !tb_str(&r.field) && js_regex!(r"[\r\n]").test(text) {
        return js_regex!(r"\r\n|\r|\n")
            .split(text)
            .into_iter()
            .map(|part| {
                if part.is_empty() {
                    String::new()
                } else {
                    let mut copy = r.clone();
                    copy.text.set(part.to_owned());
                    generate_run_xml(&copy)
                }
            })
            .collect::<Vec<_>>()
            .join("<a:br/>");
    }
    let attrs = build_r_pr_attrs(r);
    // Text outline (WordArt): the child order requires ln before fill
    let ln = match r.outline.as_ref() {
        Some(o) => format!(
            "<a:ln w=\"{}\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:ln>",
            n(math_round(o.width_emu.0)),
            hex6(&o.color)
        ),
        None => String::new(),
    };
    // A non-plain-srgb original restores its captured node verbatim so theme linkage and
    // modifiers survive the rebuild; only a truly changed color bakes an srgbClr.
    let color = if let Some(node) = ts(&r.color_node_xml) {
        format!("<a:solidFill>{node}</a:solidFill>")
    } else if let Some(c) = ts(&r.color)
        && !tb(&r.color_inherited)
    {
        format!(
            "<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>",
            hex6(c)
        )
    } else {
        String::new()
    };
    let highlight = match ts(&r.highlight) {
        Some(h) => format!(
            "<a:highlight><a:srgbClr val=\"{}\"/></a:highlight>",
            hex6(h)
        ),
        None => String::new(),
    };
    let font =
        if ts(&r.latin_font).is_some() || ts(&r.ea_font).is_some() || ts(&r.cs_font).is_some() {
            let mut f = String::new();
            for (tag, v) in [
                ("latin", &r.latin_font),
                ("ea", &r.ea_font),
                ("cs", &r.cs_font),
            ] {
                if let Some(v) = ts(v) {
                    f += &format!("<a:{tag} typeface=\"{}\"/>", escape_xml_attr(v));
                }
            }
            f
        } else if let Some(family) = ts(&r.font_family)
            && !tb(&r.font_implicit)
        {
            font_slots_xml(&escape_xml_attr(family))
        } else {
            String::new()
        };
    let hlink = hlink_xml(r);
    // "Withheld from the model" rides in the extension list, the last child
    let redact = match ts(&r.redact) {
        Some(label) => redact_ext_xml(label),
        None => String::new(),
    };
    let rpr_inner = format!("{ln}{color}{highlight}{font}{hlink}");
    let r_pr = if !redact.is_empty() {
        format!("<a:rPr{attrs}>{rpr_inner}<a:extLst>{redact}</a:extLst></a:rPr>")
    } else if !rpr_inner.is_empty() {
        format!("<a:rPr{attrs}>{rpr_inner}</a:rPr>")
    } else if !attrs.is_empty() {
        format!("<a:rPr{attrs}/>")
    } else {
        "<a:rPr/>".to_owned()
    };
    // Dynamic fields (slide number/date): `<a:fld>` has the same structure as `<a:r>`
    if let Some(field) = ts(&r.field) {
        return format!(
            "<a:fld id=\"{{{}}}\" type=\"{}\">{r_pr}<a:t>{}</a:t></a:fld>",
            field_guid(),
            escape_xml_attr(field),
            escape_xml_text(text)
        );
    }
    format!("<a:r>{r_pr}<a:t>{}</a:t></a:r>", escape_xml_text(text))
}

/// `Math.floor(Math.random() * 0x10000)`
fn random_u16() -> u16 {
    (jscompat::math_random() * 65536.0).floor() as u16
}

/// `<a:fld>` requires a unique GUID id.
fn field_guid() -> String {
    let hex = || format!("{:04X}", random_u16());
    format!(
        "{}{}-{}-{}-{}-{}{}{}",
        hex(),
        hex(),
        hex(),
        hex(),
        hex(),
        hex(),
        hex(),
        hex()
    )
}
