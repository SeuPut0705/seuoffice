//! Read: `<p:timing>` to `SlideAnimation[]` (animation.ts `findCTnEnd`,
//! `readSlideTimingXml`).

use jscompat::{JsNum, js_regex, last_index_of, math_max, replace_first_with, to_number, trim};

use super::incremental::{Balanced, find_balanced_close, tag_matches};
use super::model::{
    AnimEffectKind, AnimPreset, AnimTrigger, MEDIA_PLAY_CMD, SlideAnimation, direction_from_preset,
    effect_from_preset, is_media_effect, media_effect_from_cmd, modeled_effect, preset,
};
use super::write::{DEFAULT_MOTION_PATH, main_seq_span, timing_re};

/// Balanced scan from `open_end` (the end of an open tag) to the matching
/// `</p:cTn>`; the end of the content, or the end of the text.
///
/// The TypeScript searches `/<p:cTn\b[^>]*?(\/?)>|<\/p:cTn>/g`; see
/// [`tag_matches`] for why it is written out.
pub(super) fn find_ctn_end(xml: &str, open_end: usize) -> usize {
    let mut depth: i64 = 1;
    for m in tag_matches(xml, open_end, "<p:cTn", "</p:cTn>") {
        if m.closing {
            depth -= 1;
            if depth == 0 {
                return m.start;
            }
        } else if !m.self_closing {
            depth += 1;
        }
    }
    xml.len()
}

/// One presetClass `<p:cTn>` open tag: its span and its attributes.
pub(super) struct EffectCtn<'t> {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) attrs: &'t str,
}

/// The presetClass `<p:cTn>` open tags as the TypeScript's loop of
/// `re.lastIndex = lastIndex; re.exec(timing)` finds them, from one search
/// instead of one per effect: the class `[^>]` makes each search read the
/// rest of the text first. A match that starts before `lastIndex` is passed
/// over; one that also ends after it may hide a match the TypeScript finds,
/// so the search starts again at `lastIndex` then.
pub(super) struct EffectCtns<'t> {
    timing: &'t str,
    base: usize,
    matches: Box<dyn Iterator<Item = jscompat::JsMatch<'t>> + 't>,
}

impl<'t> EffectCtns<'t> {
    pub(super) fn new(timing: &'t str, from: usize) -> Self {
        Self {
            timing,
            base: from,
            matches: Self::search(timing, from),
        }
    }

    fn search(timing: &'t str, at: usize) -> Box<dyn Iterator<Item = jscompat::JsMatch<'t>> + 't> {
        // the pattern starts with `<`: a match at a position does not depend
        // on the text before it, so the search may start on a slice
        Box::new(
            js_regex!(r#"<p:cTn\b([^>]*\bpresetClass="[^"]*"[^>]*)>"#)
                .find_iter(timing.get(at..).unwrap_or_default()),
        )
    }

    /// The first match that starts at or after `last_index`, which only grows.
    pub(super) fn next_from(&mut self, last_index: usize) -> Option<EffectCtn<'t>> {
        loop {
            let m = self.matches.next()?;
            let (start, end) = (self.base + m.start(), self.base + m.end());
            if start >= last_index {
                return Some(EffectCtn {
                    start,
                    end,
                    attrs: m.get(1).unwrap_or_default(),
                });
            }
            if end > last_index {
                self.base = last_index;
                self.matches = Self::search(self.timing, last_index);
            }
        }
    }
}

/// The first capture of `regex` in `text`.
fn capture<'t>(regex: &jscompat::JsRegex, text: &'t str) -> Option<&'t str> {
    regex.exec(text).and_then(|m| m.get(1))
}

/// The bodySuffix's animation list: every effect cTn with a presetClass in
/// the main sequence. The delay is derived back by the write convention
/// (withPrev less the previous start, afterPrev less the previous end).
pub fn read_slide_timing_xml(body_suffix: &str) -> Vec<SlideAnimation> {
    let Some(timing) = timing_re().exec(body_suffix).map(|m| m.as_str()) else {
        return Vec::new();
    };
    // Only the main sequence: trigger animations of an interactiveSeq are not
    // modeled and must not turn into click animations on a rewrite
    let Some((seq_start, seq_end)) = main_seq_span(timing) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut ctns = EffectCtns::new(timing, seq_start);
    let mut last_index = seq_start;
    let mut prev_start = 0.0;
    let mut prev_end = 0.0;
    while let Some(m) = ctns.next_from(last_index) {
        if m.start >= seq_end {
            break;
        }
        let attrs = m.attrs;
        let cls = capture(js_regex!(r#"\bpresetClass="([^"]*)""#), attrs).unwrap_or("entr");
        let pid = to_number(capture(js_regex!(r#"\bpresetID="(\d+)""#), attrs).unwrap_or("0"));
        let psub =
            to_number(capture(js_regex!(r#"\bpresetSubtype="(\d+)""#), attrs).unwrap_or("0"));
        let node_type =
            capture(js_regex!(r#"\bnodeType="([^"]*)""#), attrs).unwrap_or("clickEffect");
        let trigger = match node_type {
            "withEffect" => AnimTrigger::WithPrev,
            "afterEffect" => AnimTrigger::AfterPrev,
            _ => AnimTrigger::OnClick,
        };
        let body_end = find_ctn_end(timing, m.end);
        let body = timing.get(m.end..body_end).unwrap_or_default();
        last_index = body_end;

        let Some(spid) = capture(js_regex!(r#"<p:spTgt\s[^>]*\bspid="(\d+)""#), body) else {
            continue;
        };
        let spid = to_number(spid);
        // Start: the effect cTn's own stCondLst, at the start of the body
        let start_ms = to_number(
            capture(js_regex!(r#"^\s*<p:stCondLst><p:cond delay="(\d+)""#), body).unwrap_or("0"),
        );
        // Duration: the largest numeric dur among the behaviors
        let mut duration_ms = 0.0;
        for dm in js_regex!(r#"\bdur="(\d+)""#).find_iter(body) {
            duration_ms = math_max(duration_ms, to_number(dm.get(1).unwrap_or_default()));
        }
        // autoRev (pulse): the actual duration is twice dur
        if js_regex!(r#"\bautoRev="1""#).test(body) {
            duration_ms *= 2.0;
        }
        let mut effect = effect_from_preset(cls, pid, psub);
        let mut modeled = modeled_effect(cls, pid, psub).is_some();
        if cls == "mediacall" {
            // The command string decides over presetID; a playFrom offset has
            // no model, so those bytes are kept verbatim
            let cmd = capture(js_regex!(r#"<p:cmd\b[^>]*\bcmd="([^"]*)""#), body).unwrap_or("");
            effect = media_effect_from_cmd(cmd).unwrap_or(effect);
            if cmd.starts_with("playFrom") && cmd != MEDIA_PLAY_CMD {
                modeled = false;
            }
        }
        if matches!(effect, AnimEffectKind::Appear | AnimEffectKind::Disappear)
            || is_media_effect(effect)
        {
            duration_ms = 0.0;
        }
        let par_start = last_index_of(timing, "<p:par", m.start as i64);
        let par_close = par_start.and_then(|at| find_balanced_close(timing, at, Balanced::Par));

        if trigger == AnimTrigger::OnClick {
            prev_start = 0.0;
            prev_end = 0.0;
        }
        let base = match trigger {
            AnimTrigger::AfterPrev => prev_end,
            AnimTrigger::WithPrev => prev_start,
            AnimTrigger::OnClick => 0.0,
        };
        let delay_ms = math_max(0.0, start_ms - base);
        prev_start = start_ms;
        prev_end = start_ms + math_max(1.0, duration_ms);

        let mut anim = SlideAnimation {
            spid: JsNum(spid),
            effect,
            trigger,
            duration_ms: JsNum(duration_ms),
            delay_ms: JsNum(delay_ms),
            direction: None,
            preset_xml: None,
            preset: None,
            paragraph: None,
            motion_path: None,
            media_kind: None,
        };
        if let Some(direction) = direction_from_preset(effect, psub)
            && psub != preset(effect).sub
        {
            anim.direction = Some(direction);
        }
        if !modeled && let (Some(par_start), Some(par_close)) = (par_start, par_close) {
            anim.preset_xml = timing
                .get(par_start..par_close + "</p:par>".len())
                .map(str::to_owned);
            anim.preset = Some(AnimPreset {
                id: JsNum(pid),
                cls: cls.to_owned(),
                sub: JsNum(psub),
            });
        }
        if let Some(paragraph) = capture(js_regex!(r#"<p:pgRg\s[^>]*\bst="(\d+)""#), body) {
            anim.paragraph = Some(JsNum(to_number(paragraph)));
        }
        if effect == AnimEffectKind::MotionPath {
            // Drop the " E" end marker the writer adds, giving the user's path back
            let path = capture(js_regex!(r#"<p:animMotion\b[^>]*\bpath="([^"]*)""#), body)
                .unwrap_or(DEFAULT_MOTION_PATH);
            let path = replace_first_with(js_regex!(r"\s*E$"), path, |_| String::new());
            anim.motion_path = Some(trim(&path).to_owned());
        }
        out.push(anim);
    }
    out
}
