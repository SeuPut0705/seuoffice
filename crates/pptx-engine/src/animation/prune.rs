//! Removal of the effect blocks of deleted shapes, and the cNvPr ids of a
//! fragment (animation.ts from `enclosingTagSpan` to the end).

use jscompat::{
    JsNum, JsRegex, TryJsRegex, index_of, js_regex, last_index_of, number_to_string, prefix_utf16,
    to_number, try_js_regex,
};

use crate::types::Slide;

/// The tags `enclosingTagSpan` is called with.
#[derive(Debug, Clone, Copy)]
enum Enclosing {
    Seq,
    Video,
    Audio,
    Par,
}

impl Enclosing {
    /// `new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'g')`
    fn regex(self) -> &'static JsRegex {
        match self {
            Self::Seq => js_regex!(r"<p:seq\b[^>]*>|</p:seq>"),
            Self::Video => js_regex!(r"<p:video\b[^>]*>|</p:video>"),
            Self::Audio => js_regex!(r"<p:audio\b[^>]*>|</p:audio>"),
            Self::Par => js_regex!(r"<p:par\b[^>]*>|</p:par>"),
        }
    }
}

/// Innermost balanced `<tag>...</tag>` span `(start, end)` holding `at`.
fn enclosing_tag_span(xml: &str, at: usize, tag: Enclosing) -> Option<(usize, usize)> {
    let mut stack: Vec<usize> = Vec::new();
    for m in tag.regex().find_iter(xml) {
        if m.as_str().as_bytes().get(1) != Some(&b'/') {
            if !m.as_str().ends_with("/>") {
                stack.push(m.start());
            }
        } else {
            let start = stack.pop()?;
            if start <= at && at < m.end() {
                return Some((start, m.end()));
            }
        }
    }
    None
}

/// Whether the nearest preceding `<p:cond` still open at `at` wraps it
/// (self-closing and already-closed ones skipped).
fn wrapped_by_cond(xml: &str, at: usize) -> bool {
    let mut from = at as i64;
    loop {
        let Some(open) = last_index_of(xml, "<p:cond", from) else {
            return false;
        };
        let Some(gt) = index_of(xml, ">", open) else {
            return false;
        };
        if gt
            .checked_sub(1)
            .and_then(|before| xml.as_bytes().get(before))
            == Some(&b'/')
        {
            from = open as i64 - 1;
            continue;
        }
        return index_of(xml, "</p:cond>", gt).is_some_and(|close| close > at);
    }
}

/// Whether the spTgt at `at` is a trigger reference (inside an open
/// `<p:cond>`) rather than an effect or media target.
fn is_trigger_ref(xml: &str, at: usize) -> bool {
    wrapped_by_cond(xml, at)
}

const MAX_TIMING_COLLAPSE_PASSES: usize = 64;

/// Remove the effect blocks targeting the given cNvPr ids from the slide's
/// `<p:timing>`, by byte surgery: a trigger reference takes its whole
/// interactiveSeq; an effect or media target the narrowest wrapper
/// (video/audio/par) holding no surviving shape's target, or nothing when
/// there is none; matching bldP go too; a timing left with no target and no
/// diagram build is dropped. `spids` holds the values of the set in its
/// order, without repeats.
///
/// The pruned timing is put back as it is (the TypeScript replaces with a function).
pub fn prune_timing_for_spids(slide: &mut Slide, spids: &[f64]) -> Result<bool, String> {
    if spids.is_empty() {
        return Ok(false);
    }
    let Some(timing) = js_regex!(r"<p:timing>[\s\S]*?<\/p:timing>")
        .exec(slide.body_suffix.as_deref().unwrap_or(""))
        .map(|m| m.as_str().to_owned())
    else {
        return Ok(false);
    };
    let has = |id: &str| spids.contains(&to_number(id));
    let sp_tgt = js_regex!(r#"<p:spTgt spid="(\d+)""#);
    let mut xml = timing.clone();
    let mut changed = false;
    let mut from = 0;
    loop {
        let mut blocked_at = usize::MAX;
        let mut cursor = from;
        let mut removal = None;
        while let Some(hit) = js_regex!(r#"<p:spTgt spid="(\d+)""#)
            .find_from(&xml, cursor)
            .next()
        {
            cursor = hit.end();
            if !has(hit.get(1).unwrap_or_default()) {
                continue;
            }
            let at = hit.start();
            let mut span = None;
            if is_trigger_ref(&xml, at)
                && let Some(seq) = enclosing_tag_span(&xml, at, Enclosing::Seq)
            {
                // the first 400 UTF-16 code units of the sequence
                let head = prefix_utf16(xml.get(seq.0..).unwrap_or_default(), 400);
                if head.contains(r#"nodeType="interactiveSeq""#) {
                    span = Some(seq);
                }
            }
            if span.is_none() {
                let mut candidates: Vec<(usize, usize)> =
                    [Enclosing::Video, Enclosing::Audio, Enclosing::Par]
                        .into_iter()
                        .filter_map(|tag| enclosing_tag_span(&xml, at, tag))
                        .collect();
                candidates.sort_by_key(|&(start, end)| end - start);
                span = candidates.into_iter().find(|&(start, end)| {
                    !sp_tgt
                        .find_iter(xml.get(start..end).unwrap_or_default())
                        .any(|m| !has(m.get(1).unwrap_or_default()))
                });
            }
            match span {
                Some(span) => {
                    removal = Some(span);
                    break;
                }
                None => blocked_at = blocked_at.min(at),
            }
        }
        let Some((start, end)) = removal else {
            break;
        };
        xml = format!("{}{}", &xml[..start], &xml[end..]);
        changed = true;
        from = start.min(blocked_at);
    }
    for &id in spids {
        let id = number_to_string(id);
        let re = TryJsRegex::new(
            &format!(r#"<p:bldP spid="{id}"[^>]*/>|<p:bldP spid="{id}"[^>]*>[\s\S]*?</p:bldP>"#),
            "",
        )
        .map_err(|error| error.to_string())?;
        if re.try_test(&xml).map_err(|limit| limit.to_string())? {
            xml = re
                .try_replace_all(&xml, |_| String::new())
                .map_err(|limit| limit.to_string())?;
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    xml = js_regex!(r"<p:bldLst\s*\/>|<p:bldLst\s*>\s*<\/p:bldLst>")
        .replace_all(&xml, |_| String::new());
    let targets = js_regex!(r"<p:spTgt\b");
    if targets.test(&xml) {
        for _ in 0..MAX_TIMING_COLLAPSE_PASSES {
            let collapsed =
                try_js_regex!(r"<p:par\b[^>]*>(?:(?!<p:par\b|<\/p:par>)[\s\S])*?<\/p:par>")
                    .try_replace_all(&xml, |block| {
                        if targets.test(block.as_str()) {
                            block.as_str().to_owned()
                        } else {
                            String::new()
                        }
                    })
                    .map_err(|limit| limit.to_string())?;
            if collapsed == xml {
                break;
            }
            xml = collapsed;
        }
    }
    let kept = if targets.test(&xml) || js_regex!(r"<p:bldDgm\b").test(&xml) {
        xml.as_str()
    } else {
        ""
    };
    let replaced = slide
        .body_suffix
        .as_deref()
        .unwrap_or("")
        .replacen(&timing, kept, 1);
    slide.body_suffix.set(replaced);
    slide.structure_dirty.set(true);
    Ok(true)
}

/// Every cNvPr id inside an element's XML fragment (group children
/// included): the values of the set, in order, without repeats.
pub fn c_nv_pr_ids_in_xml(xml: &str) -> Vec<JsNum> {
    let mut out: Vec<JsNum> = Vec::new();
    for m in js_regex!(r#"<p:cNvPr\b[^>]*?\bid=["'](\d+)["']"#).find_iter(xml) {
        let id = JsNum(to_number(m.get(1).unwrap_or_default()));
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}
