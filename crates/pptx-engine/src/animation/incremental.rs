//! Incremental write-back that keeps unmodeled timing nodes (animation.ts
//! from `animEq` to `getSlideAnimations`).

use jscompat::{
    JsMap, index_of, js_regex, last_index_of, math_max, math_round, number_to_string, to_number,
};

use super::model::{AnimTrigger, IdGen, SlideAnimation, is_media_effect};
use super::read::{EffectCtns, find_ctn_end, read_slide_timing_xml};
use super::write::{
    Placed, append_missing_media_nodes, effect_par_xml, group_par_xml, main_seq_span,
    patch_slide_timing_xml, place_anims, spid_key, timing_re,
};
use crate::types::Slide;

fn anim_eq(x: &SlideAnimation, y: &SlideAnimation) -> bool {
    x.spid == y.spid
        && x.effect == y.effect
        && x.trigger == y.trigger
        && x.duration_ms == y.duration_ms
        && x.delay_ms == y.delay_ms
        && x.motion_path == y.motion_path
        && x.paragraph == y.paragraph
        && x.direction == y.direction
        && x.preset_xml == y.preset_xml
}

/// The tags `findBalancedClose` is called with.
#[derive(Debug, Clone, Copy)]
pub(super) enum Balanced {
    Par,
    ChildTnLst,
    Seq,
    BldLst,
}

impl Balanced {
    /// `<tag` and `</tag>`, for [`tag_matches`].
    fn tags(self) -> (&'static str, &'static str) {
        match self {
            Self::Par => ("<p:par", "</p:par>"),
            Self::ChildTnLst => ("<p:childTnLst", "</p:childTnLst>"),
            Self::Seq => ("<p:seq", "</p:seq>"),
            Self::BldLst => ("<p:bldLst", "</p:bldLst>"),
        }
    }
}

/// One match of `<tag\b[^>]*?(/?)>|</tag>`.
pub(super) struct TagMatch {
    pub(super) start: usize,
    pub(super) closing: bool,
    pub(super) self_closing: bool,
}

/// The matches of `new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, 'g')` after
/// `lastIndex = from`, written out. The class `[^>]` makes every regex search
/// read the rest of the text first, and the balanced scans run once per
/// effect: through the regex they cost the number of effects times the
/// length of the timing. `open` is `<tag`, `close` is `</tag>`; the tag ends
/// in a word character.
pub(super) fn tag_matches<'t>(
    xml: &'t str,
    from: usize,
    open: &'static str,
    close: &'static str,
) -> impl Iterator<Item = TagMatch> + 't {
    let mut pos = from;
    std::iter::from_fn(move || {
        loop {
            let rest = xml.get(pos..)?;
            let (at, closing) = match (rest.find(open), rest.find(close)) {
                (None, None) => return None,
                (Some(o), Some(c)) if c < o => (c, true),
                (Some(o), _) => (o, false),
                (None, Some(c)) => (c, true),
            };
            let start = pos + at;
            if closing {
                pos = start + close.len();
                return Some(TagMatch {
                    start,
                    closing: true,
                    self_closing: false,
                });
            }
            let after = start + open.len();
            let tail = xml.get(after..).unwrap_or_default();
            // `\b` after the name: the next character is not [A-Za-z0-9_]
            let boundary = tail
                .chars()
                .next()
                .is_none_or(|ch| !(ch.is_ascii_alphanumeric() || ch == '_'));
            if boundary {
                // `[^>]*?(\/?)>` ends at the first `>`; no `>` after this
                // tag leaves no match for either alternative
                let gt = tail.find('>')?;
                pos = after + gt + 1;
                return Some(TagMatch {
                    start,
                    closing: false,
                    self_closing: gt > 0 && tail.as_bytes()[gt - 1] == b'/',
                });
            }
            // `<` is one byte: the next search starts on a character
            pos = start + 1;
        }
    })
}

/// Balanced scan for the matching close tag: `open_start` is the `<` of the
/// open tag; the start of the close tag, or `None`.
pub(super) fn find_balanced_close(xml: &str, open_start: usize, tag: Balanced) -> Option<usize> {
    let mut depth: i64 = 0;
    let (open, close) = tag.tags();
    for m in tag_matches(xml, open_start, open, close) {
        if m.closing {
            depth -= 1;
            if depth == 0 {
                return Some(m.start);
            }
        } else if !m.self_closing {
            depth += 1;
        }
    }
    None
}

/// Span `(start, end)` of the nth effect `<p:par>` of the main sequence, in
/// the order `readSlideTimingXml` reads them.
///
/// Ledger `anim-nth-par-skips-untargeted`: the TypeScript counts every
/// presetClass cTn, also one without a `<p:spTgt spid>` (an ink target, a
/// sound) that `readSlideTimingXml` leaves out, so after such an effect the
/// edit lands on the wrong `<p:par>`. Here an effect `readSlideTimingXml`
/// leaves out is not counted.
fn nth_effect_par_span(timing: &str, n: usize) -> Option<(usize, usize)> {
    let (seq_start, seq_end) = main_seq_span(timing)?;
    let mut ctns = EffectCtns::new(timing, seq_start);
    let mut last_index = seq_start;
    let mut i = 0;
    while let Some(m) = ctns.next_from(last_index) {
        if m.start >= seq_end {
            break;
        }
        let body_end = find_ctn_end(timing, m.end);
        let targeted = js_regex!(r#"<p:spTgt\s[^>]*\bspid="(\d+)""#)
            .test(timing.get(m.end..body_end).unwrap_or_default());
        if !targeted {
            last_index = body_end;
            continue;
        }
        let index = i;
        i += 1;
        if index < n {
            last_index = body_end;
            continue;
        }
        let par_start = last_index_of(timing, "<p:par", m.start as i64)?;
        let close_at = find_balanced_close(timing, par_start, Balanced::Par)?;
        return Some((par_start, close_at + "</p:par>".len()));
    }
    None
}

/// Each animation's absolute in-group start, as `placeAnims` computes it.
fn abs_starts(anims: &[SlideAnimation]) -> Vec<f64> {
    let mut out = Vec::with_capacity(anims.len());
    let mut prev_start = 0.0;
    let mut prev_end = 0.0;
    for a in anims {
        if a.trigger == AnimTrigger::OnClick {
            prev_start = 0.0;
            prev_end = 0.0;
        }
        let base = match a.trigger {
            AnimTrigger::AfterPrev => prev_end,
            AnimTrigger::WithPrev => prev_start,
            AnimTrigger::OnClick => 0.0,
        };
        let start = base + math_max(0.0, math_round(a.delay_ms.0));
        out.push(start);
        prev_start = start;
        prev_end = start + math_max(1.0, math_round(a.duration_ms.0));
    }
    out
}

/// Ids continue after the largest numeric id already in the timing.
pub(super) fn make_gen_after_max_id(timing: &str) -> IdGen {
    let mut max_id = 0.0;
    for m in js_regex!(r#"\bid="(\d+)""#).find_iter(timing) {
        max_id = math_max(max_id, to_number(m.get(1).unwrap_or_default()));
    }
    IdGen::after(max_id)
}

/// Append bldP to `<p:bldLst>` (created before `</p:timing>` if missing);
/// (spid, grpId) pairs already there are skipped, compared as written.
fn append_bld_ps(timing: &str, items: &[&Placed<'_>]) -> String {
    let mut seen: Vec<String> = js_regex!(r#"<p:bldP\b[^>]*\bspid="(\d+)"[^>]*\bgrpId="(\d+)""#)
        .find_iter(timing)
        .map(|m| {
            format!(
                "{}:{}",
                m.get(1).unwrap_or_default(),
                m.get(2).unwrap_or_default()
            )
        })
        .collect();
    // a shape that already has build="p" gets no second paragraph bldP
    let mut para_seen: Vec<String> = js_regex!(r#"<p:bldP\b[^>]*\bspid="(\d+)"[^>]*\bbuild="p""#)
        .find_iter(timing)
        .map(|m| m.get(1).unwrap_or_default().to_owned())
        .collect();
    let mut add = String::new();
    for p in items {
        let spid = number_to_string(p.a.spid.0);
        let grp_id = number_to_string(p.grp_id);
        if p.a.paragraph.is_some() {
            if para_seen.contains(&spid) {
                continue;
            }
            add.push_str(&format!(
                r#"<p:bldP spid="{spid}" grpId="{grp_id}" uiExpand="1" build="p"/>"#
            ));
            para_seen.push(spid);
        } else {
            let key = format!("{spid}:{grp_id}");
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            add.push_str(&format!(r#"<p:bldP spid="{spid}" grpId="{grp_id}"/>"#));
        }
    }
    if add.is_empty() {
        return timing.to_owned();
    }
    if let Some(bld_end) = timing.rfind("</p:bldLst>") {
        return format!("{}{add}{}", &timing[..bld_end], &timing[bld_end..]);
    }
    let Some(t_end) = timing.rfind("</p:timing>") else {
        return timing.to_owned();
    };
    format!(
        "{}<p:bldLst>{add}</p:bldLst>{}",
        &timing[..t_end],
        &timing[t_end..]
    )
}

/// Incremental `<p:timing>` patch touching only the affected effect nodes:
/// A. a pure append whose first added item is onClick: new click groups at
/// the end of the main sequence; B. one item changed, trigger and target
/// kept, nothing chained after it: that effect's `<p:par>` replaced. `None`
/// for anything else; the caller rebuilds.
pub fn patch_slide_timing_incremental_xml(
    body_suffix: &str,
    anims: &[SlideAnimation],
) -> Option<Result<String, String>> {
    let timing_m = timing_re().exec(body_suffix)?;
    let timing = timing_m.as_str();
    let old = read_slide_timing_xml(body_suffix);
    if old.is_empty() || anims.is_empty() {
        return None;
    }
    let splice = |new_timing: &str| {
        format!(
            "{}{new_timing}{}",
            &body_suffix[..timing_m.start()],
            &body_suffix[timing_m.end()..]
        )
    };

    // A. Pure append
    if anims.len() > old.len() && old.iter().zip(anims).all(|(o, a)| anim_eq(o, a)) {
        let added = anims.get(old.len()..)?;
        if added.first()?.trigger != AnimTrigger::OnClick {
            return None;
        }
        // Whole-shape and paragraph animations on one shape change the bldP
        // form (plain or build="p"): a full rebuild
        let mut kind_by_spid: JsMap<u8> = JsMap::new();
        for a in anims {
            let key = spid_key(a.spid.0);
            let kind = kind_by_spid.get(&key).copied().unwrap_or(0)
                | (if a.paragraph.is_none() { 1 } else { 2 });
            kind_by_spid.set(key, kind);
        }
        if added
            .iter()
            .any(|a| kind_by_spid.get(&spid_key(a.spid.0)) == Some(&3))
        {
            return None;
        }
        let seq_m = js_regex!(r#"<p:cTn\b[^>]*\bnodeType="mainSeq"[^>]*>"#).exec(timing)?;
        let child_open = index_of(timing, "<p:childTnLst>", seq_m.end())?;
        let child_close = find_balanced_close(timing, child_open, Balanced::ChildTnLst)?;

        let mut ids = make_gen_after_max_id(timing);
        let mut grp_base: JsMap<f64> = JsMap::new();
        for a in &old {
            if !is_media_effect(a.effect) {
                let key = spid_key(a.spid.0);
                let count = grp_base.get(&key).copied().unwrap_or(0.0);
                grp_base.set(key, count + 1.0);
            }
        }
        let groups = place_anims(added, Some(&grp_base));
        let groups_xml: String = groups.iter().map(|g| group_par_xml(&mut ids, g)).collect();
        let new_timing = format!(
            "{}{groups_xml}{}",
            &timing[..child_close],
            &timing[child_close..]
        );
        let new_timing = match append_missing_media_nodes(&new_timing, added, &mut ids) {
            Ok(with_media) => with_media,
            Err(error) => return Some(Err(error)),
        };
        let items: Vec<&Placed<'_>> = groups
            .iter()
            .flat_map(|g| g.items.iter().filter(|p| !is_media_effect(p.a.effect)))
            .collect();
        let new_timing = append_bld_ps(&new_timing, &items);
        return Some(Ok(splice(&new_timing)));
    }

    // B. One item changed
    if anims.len() == old.len() {
        let diff_idx: Vec<usize> = anims
            .iter()
            .zip(&old)
            .enumerate()
            .filter(|(_, (a, o))| !anim_eq(a, o))
            .map(|(i, _)| i)
            .collect();
        let &[i] = diff_idx.as_slice() else {
            return None;
        };
        let o = old.get(i)?;
        let a = anims.get(i)?;
        // Trigger and target kept (a paragraph change changes the bldP form);
        // no later withPrev/afterPrev hangs on this item's start or end
        if o.trigger != a.trigger || o.spid != a.spid {
            return None;
        }
        if o.paragraph != a.paragraph {
            return None;
        }
        if let Some(next) = anims.get(i + 1)
            && next.trigger != AnimTrigger::OnClick
        {
            return None;
        }
        let (start, end) = nth_effect_par_span(timing, i)?;
        let mut ids = make_gen_after_max_id(timing);
        // Keep the original cTn's grpId (bldP is keyed on it); count only where it has none
        let orig_grp_id = js_regex!(r#"\bgrpId="(\d+)""#)
            .exec(timing.get(start..end).unwrap_or_default())
            .and_then(|m| m.get(1));
        let grp_id = match orig_grp_id {
            Some(grp_id) => to_number(grp_id),
            None => anims
                .iter()
                .take(i)
                .filter(|x| x.spid == a.spid && !is_media_effect(x.effect))
                .count() as f64,
        };
        let start_ms = *abs_starts(anims).get(i)?;
        let par = effect_par_xml(
            &mut ids,
            &Placed {
                a,
                start_ms,
                grp_id,
            },
        );
        return Some(Ok(splice(&format!(
            "{}{par}{}",
            &timing[..start],
            &timing[end..]
        ))));
    }

    None
}

/// Set the slide's whole animation list: the incremental patch where it
/// applies, else the rebuild of the main sequence.
pub fn set_slide_animations(slide: &mut Slide, anims: &[SlideAnimation]) -> Result<(), String> {
    let body_suffix = slide.body_suffix.as_deref().unwrap_or("");
    let patched = match patch_slide_timing_incremental_xml(body_suffix, anims) {
        Some(incremental) => incremental?,
        None => patch_slide_timing_xml(body_suffix, anims)?,
    };
    slide.body_suffix.set(patched);
    slide.structure_dirty.set(true);
    Ok(())
}

/// The slide's animation list.
pub fn get_slide_animations(slide: &Slide) -> Vec<SlideAnimation> {
    read_slide_timing_xml(slide.body_suffix.as_deref().unwrap_or(""))
}
