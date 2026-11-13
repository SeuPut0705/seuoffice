//! Write: `SlideAnimation[]` to `<p:timing>`, and the in-place patch of a
//! slide's timing (animation.ts from `tgtElXml` to `patchSlideTimingXml`).

use jscompat::{
    JsMap, JsRegex, TryJsRegex, index_of, js_regex, last_index_of, math_max, math_round,
    number_to_string, replace_first_with, trim,
};

use super::incremental::{Balanced, find_balanced_close, make_gen_after_max_id};
use super::model::{
    AnimDirection, AnimEffectKind, AnimTrigger, IdGen, MediaKind, SlideAnimation, is_media_effect,
    media_cmd, node_type, preset, preset_subtype_of,
};
use super::read::find_ctn_end;

/// Behavior target `<p:tgtEl>`; with a paragraph, `txEl/pgRg` (0-based st/end).
fn tgt_el_xml(a: &SlideAnimation) -> String {
    let spid = number_to_string(a.spid.0);
    let inner = match a.paragraph {
        None => format!(r#"<p:spTgt spid="{spid}"/>"#),
        Some(paragraph) => {
            let paragraph = number_to_string(paragraph.0);
            format!(
                r#"<p:spTgt spid="{spid}"><p:txEl><p:pgRg st="{paragraph}" end="{paragraph}"/></p:txEl></p:spTgt>"#
            )
        }
    };
    format!("<p:tgtEl>{inner}</p:tgtEl>")
}

/// Set style.visibility (entrance=visible / exit=hidden), delay relative to the effect start.
fn set_visibility_xml(ids: &mut IdGen, tgt: &str, visible: bool, delay_ms: f64) -> String {
    let id = number_to_string(ids.next());
    let delay = number_to_string(delay_ms);
    let value = if visible { "visible" } else { "hidden" };
    format!(
        r#"<p:set><p:cBhvr><p:cTn id="{id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="{delay}"/></p:stCondLst></p:cTn>{tgt}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="{value}"/></p:to></p:set>"#
    )
}

/// Attribute keyframe animation (tm a per-mille time point 0..100000, val a formula).
fn keyframe_anim_xml(
    ids: &mut IdGen,
    tgt: &str,
    dur: f64,
    attr: &str,
    frames: &[(f64, &str)],
) -> String {
    let tavs: String = frames
        .iter()
        .map(|&(tm, val)| {
            format!(
                r#"<p:tav tm="{}"><p:val><p:strVal val="{val}"/></p:val></p:tav>"#,
                number_to_string(tm)
            )
        })
        .collect();
    let id = number_to_string(ids.next());
    let dur = number_to_string(dur);
    format!(
        r#"<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="{id}" dur="{dur}" fill="hold"/>{tgt}<p:attrNameLst><p:attrName>{attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst>{tavs}</p:tavLst></p:anim>"#
    )
}

/// ppt_x/ppt_y translation animation (fly in/out).
fn move_anim_xml(ids: &mut IdGen, tgt: &str, dur: f64, attr: &str, from: &str, to: &str) -> String {
    keyframe_anim_xml(ids, tgt, dur, attr, &[(0.0, from), (100_000.0, to)])
}

/// Default motionPath (straight line to the right, 1/4 of the slide width).
pub const DEFAULT_MOTION_PATH: &str = "M 0 0 L 0.25 0";

/// Off-slide position (x, y) a fly effect starts from or ends at.
fn fly_offscreen(d: AnimDirection) -> (&'static str, &'static str) {
    match d {
        AnimDirection::Top => ("#ppt_x", "0-#ppt_h/2"),
        AnimDirection::Left => ("0-#ppt_w/2", "#ppt_y"),
        AnimDirection::Right => ("1+#ppt_w/2", "#ppt_y"),
        AnimDirection::Bottom => ("#ppt_x", "1+#ppt_h/2"),
    }
}

/// `WIPE_IN_FILTER[d]`: the reveal moves away from the side it comes from.
fn wipe_in_filter(d: AnimDirection) -> &'static str {
    match d {
        AnimDirection::Top => "down",
        AnimDirection::Bottom => "up",
        AnimDirection::Left => "right",
        AnimDirection::Right => "left",
    }
}

/// `WIPE_OUT_FILTER[d]`.
fn wipe_out_filter(d: AnimDirection) -> &'static str {
    match d {
        AnimDirection::Top => "up",
        AnimDirection::Bottom => "down",
        AnimDirection::Left => "left",
        AnimDirection::Right => "right",
    }
}

/// Move along a path (`<p:animMotion>`); the path gets the " E" end marker.
fn motion_anim_xml(ids: &mut IdGen, tgt: &str, dur: f64, path: &str) -> String {
    let trimmed = trim(path);
    let p = if trimmed.is_empty() {
        DEFAULT_MOTION_PATH
    } else {
        trimmed
    };
    let path_attr = if js_regex!(r"\bE$").test(p) {
        p.to_owned()
    } else {
        format!("{p} E")
    };
    let id = number_to_string(ids.next());
    let dur = number_to_string(dur);
    format!(
        r#"<p:animMotion origin="layout" path="{path_attr}" pathEditMode="relative"><p:cBhvr><p:cTn id="{id}" dur="{dur}" fill="hold"/>{tgt}<p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr></p:animMotion>"#
    )
}

/// `<p:animEffect>` with one behavior cTn.
fn anim_effect_xml(
    ids: &mut IdGen,
    transition: &str,
    filter: &str,
    dur: &str,
    tgt: &str,
) -> String {
    let id = number_to_string(ids.next());
    format!(
        r#"<p:animEffect transition="{transition}" filter="{filter}"><p:cBhvr><p:cTn id="{id}" dur="{dur}"/>{tgt}</p:cBhvr></p:animEffect>"#
    )
}

/// `<p:animScale>` from/to (or by) a size.
fn anim_scale_xml(ids: &mut IdGen, dur: &str, tgt: &str, values: &str) -> String {
    let id = number_to_string(ids.next());
    format!(
        r#"<p:animScale><p:cBhvr><p:cTn id="{id}" dur="{dur}" fill="hold"/>{tgt}</p:cBhvr>{values}</p:animScale>"#
    )
}

/// `<p:animRot>` by an angle.
fn anim_rot_xml(ids: &mut IdGen, by: &str, dur: &str, tgt: &str) -> String {
    let id = number_to_string(ids.next());
    format!(
        r#"<p:animRot by="{by}"><p:cBhvr><p:cTn id="{id}" dur="{dur}" fill="hold"/>{tgt}<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>"#
    )
}

/// Behavior list of one effect. `show` and `hideAtEnd` take their ids
/// before the effect's own behaviors, whatever the effect.
fn effect_behaviors_xml(ids: &mut IdGen, a: &SlideAnimation) -> String {
    use AnimEffectKind::*;
    let dur = math_max(1.0, math_round(a.duration_ms.0));
    let target = tgt_el_xml(a);
    let show = set_visibility_xml(ids, &target, true, 0.0);
    let hide_at_end = set_visibility_xml(ids, &target, false, math_max(0.0, dur - 1.0));
    let dur_text = number_to_string(dur);
    let direction = a.direction.unwrap_or(AnimDirection::Bottom);
    match a.effect {
        MediaPlay | MediaPause | MediaStop => {
            let id = number_to_string(ids.next());
            format!(
                r#"<p:cmd type="call" cmd="{}"><p:cBhvr><p:cTn id="{id}" dur="1" fill="hold"/>{target}</p:cBhvr></p:cmd>"#,
                media_cmd(a.effect)
            )
        }
        Appear => show,
        Fade => show + &anim_effect_xml(ids, "in", "fade", &dur_text, &target),
        FlyIn => {
            let (x, y) = fly_offscreen(direction);
            let along_x = move_anim_xml(ids, &target, dur, "ppt_x", x, "#ppt_x");
            let along_y = move_anim_xml(ids, &target, dur, "ppt_y", y, "#ppt_y");
            show + &along_x + &along_y
        }
        Wipe => {
            let filter = format!("wipe({})", wipe_in_filter(direction));
            show + &anim_effect_xml(ids, "in", &filter, &dur_text, &target)
        }
        WipeDown => show + &anim_effect_xml(ids, "in", "wipe(down)", &dur_text, &target),
        SplitIn => show + &anim_effect_xml(ids, "in", "split(inHorizontal)", &dur_text, &target),
        Bounce => {
            // Drop from above and a damped rebound (approximates PowerPoint's bounce)
            show + &keyframe_anim_xml(
                ids,
                &target,
                dur,
                "ppt_y",
                &[
                    (0.0, "#ppt_y-0.25"),
                    (55_000.0, "#ppt_y"),
                    (70_000.0, "#ppt_y-0.08"),
                    (85_000.0, "#ppt_y"),
                    (92_000.0, "#ppt_y-0.03"),
                    (100_000.0, "#ppt_y"),
                ],
            )
        }
        FlipIn => {
            let fade = anim_effect_xml(ids, "in", "fade", &dur_text, &target);
            let scale = anim_scale_xml(
                ids,
                &dur_text,
                &target,
                r#"<p:from x="0" y="100000"/><p:to x="100000" y="100000"/>"#,
            );
            show + &fade + &scale
        }
        Zoom => {
            show + &anim_scale_xml(
                ids,
                &dur_text,
                &target,
                r#"<p:from x="0" y="0"/><p:to x="100000" y="100000"/>"#,
            )
        }
        Pulse => {
            let id = number_to_string(ids.next());
            let half = number_to_string(math_max(1.0, math_round(dur / 2.0)));
            format!(
                r#"<p:animScale><p:cBhvr><p:cTn id="{id}" dur="{half}" autoRev="1" fill="hold"/>{target}</p:cBhvr><p:by x="106000" y="106000"/></p:animScale>"#
            )
        }
        Spin => anim_rot_xml(ids, "21600000", &dur_text, &target),
        Grow => anim_scale_xml(ids, &dur_text, &target, r#"<p:by x="150000" y="150000"/>"#),
        Teeter => keyframe_anim_xml(
            ids,
            &target,
            dur,
            "ppt_r",
            &[
                (0.0, "#ppt_r"),
                (12_500.0, "#ppt_r-9"),
                (37_500.0, "#ppt_r+9"),
                (62_500.0, "#ppt_r-6"),
                (87_500.0, "#ppt_r+3"),
                (100_000.0, "#ppt_r"),
            ],
        ),
        Disappear => set_visibility_xml(ids, &target, false, 0.0),
        FadeOut => anim_effect_xml(ids, "out", "fade", &dur_text, &target) + &hide_at_end,
        FlyOut => {
            let (x, y) = fly_offscreen(direction);
            let along_x = move_anim_xml(ids, &target, dur, "ppt_x", "#ppt_x", x);
            let along_y = move_anim_xml(ids, &target, dur, "ppt_y", "#ppt_y", y);
            along_x + &along_y + &hide_at_end
        }
        WipeOut => {
            let filter = format!("wipe({})", wipe_out_filter(direction));
            anim_effect_xml(ids, "out", &filter, &dur_text, &target) + &hide_at_end
        }
        Shrink => {
            let scale = anim_scale_xml(
                ids,
                &dur_text,
                &target,
                r#"<p:from x="100000" y="100000"/><p:to x="1000" y="1000"/>"#,
            );
            let rot = anim_rot_xml(ids, "-5400000", &dur_text, &target);
            scale + &rot + &hide_at_end
        }
        ZoomOut => {
            anim_scale_xml(
                ids,
                &dur_text,
                &target,
                r#"<p:from x="100000" y="100000"/><p:to x="1000" y="1000"/>"#,
            ) + &hide_at_end
        }
        MotionPath => motion_anim_xml(
            ids,
            &target,
            dur,
            a.motion_path.as_deref().unwrap_or(DEFAULT_MOTION_PATH),
        ),
    }
}

/// One effect placed in its click group.
pub(super) struct Placed<'a> {
    pub a: &'a SlideAnimation,
    pub start_ms: f64,
    pub grp_id: f64,
}

/// One click group.
pub(super) struct Group<'a> {
    pub auto: bool,
    pub items: Vec<Placed<'a>>,
}

/// The key of a `Map<number, ...>`: `number_to_string` tells numbers apart
/// as SameValueZero does.
pub(super) fn spid_key(spid: f64) -> String {
    number_to_string(spid)
}

/// Grouping and absolute in-group start: onClick starts a new click group;
/// withPrev starts at the previous start plus delay, afterPrev at the previous
/// end plus delay. `grp_base` counts the animations already used per spid.
pub(super) fn place_anims<'a>(
    anims: &'a [SlideAnimation],
    grp_base: Option<&JsMap<f64>>,
) -> Vec<Group<'a>> {
    let mut groups: Vec<Group<'a>> = Vec::new();
    let mut grp_count: JsMap<f64> = grp_base.cloned().unwrap_or_default();
    let mut prev_start = 0.0;
    let mut prev_end = 0.0;
    for a in anims {
        if a.trigger == AnimTrigger::OnClick || groups.is_empty() {
            groups.push(Group {
                auto: a.trigger != AnimTrigger::OnClick,
                items: Vec::new(),
            });
            prev_start = 0.0;
            prev_end = 0.0;
        }
        let base = match a.trigger {
            AnimTrigger::AfterPrev => prev_end,
            AnimTrigger::WithPrev => prev_start,
            AnimTrigger::OnClick => 0.0,
        };
        let start = base + math_max(0.0, math_round(a.delay_ms.0));
        // Media steps carry no bldP, so they take no build group id
        let key = spid_key(a.spid.0);
        let grp_id = grp_count.get(&key).copied().unwrap_or(0.0);
        if !is_media_effect(a.effect) {
            grp_count.set(key, grp_id + 1.0);
        }
        if let Some(group) = groups.last_mut() {
            group.items.push(Placed {
                a,
                start_ms: start,
                grp_id,
            });
        }
        prev_start = start;
        prev_end = start + math_max(1.0, math_round(a.duration_ms.0));
    }
    groups
}

/// One effect's `<p:par>`.
pub(super) fn effect_par_xml(ids: &mut IdGen, p: &Placed<'_>) -> String {
    if p.a.preset_xml.as_deref().is_some_and(|xml| !xml.is_empty()) {
        return place_preset_xml(ids, p);
    }
    let preset = preset(p.a.effect);
    let id = number_to_string(ids.next());
    let head = format!(
        r#"<p:par><p:cTn id="{id}" presetID="{}" presetClass="{}" presetSubtype="{}" fill="hold" grpId="{}" nodeType="{}"><p:stCondLst><p:cond delay="{}"/></p:stCondLst>"#,
        number_to_string(preset.id),
        preset.cls,
        number_to_string(preset_subtype_of(p.a)),
        number_to_string(p.grp_id),
        node_type(p.a.trigger),
        number_to_string(p.start_ms),
    );
    let behaviors = effect_behaviors_xml(ids, p.a);
    format!("{head}<p:childTnLst>{behaviors}</p:childTnLst></p:cTn></p:par>")
}

/// A verbatim effect `<p:par>` placed again: cTn ids renumbered into the
/// slide's id space, the outer cTn given the list's trigger, group and start.
fn place_preset_xml(ids: &mut IdGen, p: &Placed<'_>) -> String {
    let source = p.a.preset_xml.as_deref().unwrap_or_default();
    let xml = js_regex!(r#"(<p:cTn\b[^>]*?\bid=")\d+(")"#).replace_all(source, |m| {
        format!(
            "{}{}{}",
            m.get(1).unwrap_or_default(),
            number_to_string(ids.next()),
            m.get(2).unwrap_or_default()
        )
    });
    let xml = replace_first_with(js_regex!(r"<p:cTn\b[^>]*>"), &xml, |open| {
        let o = js_regex!(r#"\s(?:grpId|nodeType)="[^"]*""#)
            .replace_all(open.as_str(), |_| String::new());
        replace_first_with(js_regex!(r">$"), &o, |_| {
            format!(
                r#" grpId="{}" nodeType="{}">"#,
                number_to_string(p.grp_id),
                node_type(p.a.trigger)
            )
        })
    });
    replace_first_with(
        js_regex!(r#"(<p:stCondLst><p:cond delay=")[^"]*(")"#),
        &xml,
        |m| {
            format!(
                "{}{}{}",
                m.get(1).unwrap_or_default(),
                number_to_string(p.start_ms),
                m.get(2).unwrap_or_default()
            )
        },
    )
}

/// The two-level `<p:par>` wrapper of one click group; its ids come after
/// those of its effects.
pub(super) fn group_par_xml(ids: &mut IdGen, g: &Group<'_>) -> String {
    let effects: String = g.items.iter().map(|p| effect_par_xml(ids, p)).collect();
    let outer = number_to_string(ids.next());
    let inner = number_to_string(ids.next());
    let delay = if g.auto { "0" } else { "indefinite" };
    format!(
        r#"<p:par><p:cTn id="{outer}" fill="hold"><p:stCondLst><p:cond delay="{delay}"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="{inner}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>{effects}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>"#
    )
}

/// bldP list for a full rebuild: a shape with paragraph animation gets one
/// build="p" bldP instead of one plain bldP per grpId.
fn bld_ps_xml(all: &[SlideAnimation]) -> String {
    let anims: Vec<&SlideAnimation> = all.iter().filter(|a| !is_media_effect(a.effect)).collect();
    let para_spids: Vec<f64> = anims
        .iter()
        .filter(|a| a.paragraph.is_some())
        .map(|a| a.spid.0)
        .collect();
    let mut bld_seen: Vec<String> = Vec::new();
    let mut out = String::new();
    for (i, a) in anims.iter().enumerate() {
        let spid = number_to_string(a.spid.0);
        if para_spids.contains(&a.spid.0) {
            let key = format!("p:{spid}");
            if bld_seen.contains(&key) {
                continue;
            }
            bld_seen.push(key);
            // grpId 0: on a full rebuild the spid's first animation has grpId 0
            out.push_str(&format!(
                r#"<p:bldP spid="{spid}" grpId="0" uiExpand="1" build="p"/>"#
            ));
            continue;
        }
        // the nth animation of a spid has grpId n
        let before = anims.iter().take(i).filter(|x| x.spid == a.spid).count();
        let before = number_to_string(before as f64);
        let key = format!("{spid}:{before}");
        if bld_seen.contains(&key) {
            continue;
        }
        bld_seen.push(key);
        out.push_str(&format!(r#"<p:bldP spid="{spid}" grpId="{before}"/>"#));
    }
    out
}

/// The `<p:video>`/`<p:audio>` node PowerPoint keeps beside the main sequence
/// for every media shape driven by media commands.
fn media_node_xml(ids: &mut IdGen, spid: f64, kind: MediaKind) -> String {
    let tag = match kind {
        MediaKind::Video => "p:video",
        MediaKind::Audio => "p:audio",
    };
    let id = number_to_string(ids.next());
    let spid = number_to_string(spid);
    format!(
        r#"<{tag}><p:cMediaNode vol="80000"><p:cTn id="{id}" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:endCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst></p:cTn><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cMediaNode></{tag}>"#
    )
}

/// Media nodes missing from `existing` (tmRoot childTnLst content) for the
/// media effects of `anims`.
pub(super) fn missing_media_nodes_xml(
    ids: &mut IdGen,
    anims: &[SlideAnimation],
    existing: &str,
) -> Result<String, String> {
    let mut seen: Vec<f64> = Vec::new();
    let mut out = String::new();
    for a in anims {
        let Some(kind) = a.media_kind else { continue };
        if !is_media_effect(a.effect) || seen.contains(&a.spid.0) {
            continue;
        }
        seen.push(a.spid.0);
        let target = TryJsRegex::new(
            &format!(r#"<p:spTgt spid="{}""#, number_to_string(a.spid.0)),
            "",
        )
        .map_err(|error| error.to_string())?;
        let mut has = false;
        for node in
            js_regex!(r"<p:(?:video|audio)>[\s\S]*?<\/p:(?:video|audio)>").find_iter(existing)
        {
            if target
                .try_test(node.as_str())
                .map_err(|limit| limit.to_string())?
            {
                has = true;
                break;
            }
        }
        if !has {
            out.push_str(&media_node_xml(ids, a.spid.0, kind));
        }
    }
    Ok(out)
}

const PREV_COND_LST: &str = r#"<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>"#;
const NEXT_COND_LST: &str = r#"<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>"#;

/// The whole `<p:timing>`. onClick starts a click group; withPrev and
/// afterPrev join the current one; a list that starts with another trigger
/// plays group 0 after the slide transition.
pub fn build_timing_xml(anims: &[SlideAnimation]) -> Result<String, String> {
    if anims.is_empty() {
        return Ok(String::new());
    }
    let mut ids = IdGen::after(0.0);
    let root_id = number_to_string(ids.next());
    let seq_id = number_to_string(ids.next());
    let group_xml: String = place_anims(anims, None)
        .iter()
        .map(|g| group_par_xml(&mut ids, g))
        .collect();
    let bld_ps = bld_ps_xml(anims);
    let media_nodes = missing_media_nodes_xml(&mut ids, anims, "")?;
    let bld_lst = if bld_ps.is_empty() {
        String::new()
    } else {
        format!("<p:bldLst>{bld_ps}</p:bldLst>")
    };
    Ok(format!(
        r#"<p:timing><p:tnLst><p:par><p:cTn id="{root_id}" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="{seq_id}" dur="indefinite" nodeType="mainSeq"><p:childTnLst>{group_xml}</p:childTnLst></p:cTn>{PREV_COND_LST}{NEXT_COND_LST}</p:seq>{media_nodes}</p:childTnLst></p:cTn></p:par></p:tnLst>{bld_lst}</p:timing>"#
    ))
}

/// `TIMING_RE`.
pub(super) fn timing_re() -> &'static JsRegex {
    js_regex!(r"<p:timing\b[^>]*\/>|<p:timing\b[^>]*>[\s\S]*?<\/p:timing>")
}

fn main_seq_ctn_re() -> &'static JsRegex {
    js_regex!(r#"<p:cTn\b[^>]*\bnodeType="mainSeq"[^>]*>"#)
}

fn tm_root_ctn_re() -> &'static JsRegex {
    js_regex!(r#"<p:cTn\b[^>]*\bnodeType="tmRoot"[^>]*>"#)
}

const CHILD_TN_LST: &str = "<p:childTnLst>";

/// Content span `(start, end)` of the mainSeq cTn; `None` without a main sequence.
pub(super) fn main_seq_span(timing: &str) -> Option<(usize, usize)> {
    let m = main_seq_ctn_re().exec(timing)?;
    let start = m.end();
    Some((start, find_ctn_end(timing, start)))
}

/// Whether the tmRoot cTn's childTnLst has no children left.
fn root_child_tn_lst_empty(timing: &str) -> bool {
    let Some(root) = tm_root_ctn_re().exec(timing) else {
        return true;
    };
    let Some(child_open) = index_of(timing, CHILD_TN_LST, root.end()) else {
        return true;
    };
    let Some(child_close) = find_balanced_close(timing, child_open, Balanced::ChildTnLst) else {
        return true;
    };
    trim(
        timing
            .get(child_open + CHILD_TN_LST.len()..child_close)
            .unwrap_or_default(),
    )
    .is_empty()
}

/// Strip every `<p:bldP>` from bldLst and write ours; bldDgm, bldOleChart,
/// bldGraphic and the like are kept.
fn rebuild_bld_lst(timing: &str, anims: &[SlideAnimation]) -> String {
    let ours = bld_ps_xml(anims);
    let Some(bld_open) = js_regex!(r"<p:bldLst\b[^>]*>").exec(timing) else {
        if ours.is_empty() {
            return timing.to_owned();
        }
        let Some(t_end) = timing.rfind("</p:timing>") else {
            return timing.to_owned();
        };
        return format!(
            "{}<p:bldLst>{ours}</p:bldLst>{}",
            &timing[..t_end],
            &timing[t_end..]
        );
    };
    let Some(close) = find_balanced_close(timing, bld_open.start(), Balanced::BldLst) else {
        return timing.to_owned();
    };
    let inner = timing.get(bld_open.end()..close).unwrap_or_default();
    let kept = js_regex!(r"<p:bldP\b[^>]*\/>|<p:bldP\b[^>]*>[\s\S]*?<\/p:bldP>")
        .replace_all(inner, |_| String::new());
    let new_inner = ours + &kept;
    let replacement = if new_inner.is_empty() {
        String::new()
    } else {
        format!("<p:bldLst>{new_inner}</p:bldLst>")
    };
    format!(
        "{}{replacement}{}",
        &timing[..bld_open.start()],
        &timing[close + "</p:bldLst>".len()..]
    )
}

/// Rebuild of the main sequence only: its childTnLst gets the new effect
/// groups; interactive sequences, media timelines and other siblings keep
/// their bytes; bldP is rewritten, other bld* kept. An empty list removes the
/// whole `<p:seq>`, and the whole timing (`""`) when the root has nothing
/// left. `None` where the structure is unexpected.
fn rebuild_timing_preserving_xml(
    timing: &str,
    anims: &[SlideAnimation],
) -> Option<Result<String, String>> {
    let seq_ctn = main_seq_ctn_re().exec(timing);
    if anims.is_empty() {
        let Some(seq_ctn) = seq_ctn else {
            return Some(Ok(rebuild_bld_lst(timing, anims)));
        };
        let seq_start = last_index_of(timing, "<p:seq", seq_ctn.start() as i64)?;
        let seq_close = find_balanced_close(timing, seq_start, Balanced::Seq)?;
        let new_timing = format!(
            "{}{}",
            &timing[..seq_start],
            &timing[seq_close + "</p:seq>".len()..]
        );
        let new_timing = rebuild_bld_lst(&new_timing, anims);
        return Some(Ok(if root_child_tn_lst_empty(&new_timing) {
            String::new()
        } else {
            new_timing
        }));
    }

    let mut ids = make_gen_after_max_id(timing);
    let group_xml: String = place_anims(anims, None)
        .iter()
        .map(|g| group_par_xml(&mut ids, g))
        .collect();
    let new_timing = if let Some(seq_ctn) = seq_ctn {
        let child_open = index_of(timing, CHILD_TN_LST, seq_ctn.end())?;
        let child_close = find_balanced_close(timing, child_open, Balanced::ChildTnLst)?;
        format!(
            "{}{group_xml}{}",
            &timing[..child_open + CHILD_TN_LST.len()],
            &timing[child_close..]
        )
    } else {
        // No main sequence (only trigger or media nodes): a new <p:seq> at the
        // end of the tmRoot childTnLst
        let root = tm_root_ctn_re().exec(timing)?;
        let child_open = index_of(timing, CHILD_TN_LST, root.end())?;
        let child_close = find_balanced_close(timing, child_open, Balanced::ChildTnLst)?;
        let seq_id = number_to_string(ids.next());
        let seq_xml = format!(
            r#"<p:seq concurrent="1" nextAc="seek"><p:cTn id="{seq_id}" dur="indefinite" nodeType="mainSeq"><p:childTnLst>{group_xml}</p:childTnLst></p:cTn>{PREV_COND_LST}{NEXT_COND_LST}</p:seq>"#
        );
        format!(
            "{}{seq_xml}{}",
            &timing[..child_close],
            &timing[child_close..]
        )
    };
    Some(
        append_missing_media_nodes(&new_timing, anims, &mut ids)
            .map(|with_media| rebuild_bld_lst(&with_media, anims)),
    )
}

pub(super) fn append_missing_media_nodes(
    timing: &str,
    anims: &[SlideAnimation],
    ids: &mut IdGen,
) -> Result<String, String> {
    let Some(root) = tm_root_ctn_re().exec(timing) else {
        return Ok(timing.to_owned());
    };
    let Some(child_open) = index_of(timing, CHILD_TN_LST, root.end()) else {
        return Ok(timing.to_owned());
    };
    let Some(child_close) = find_balanced_close(timing, child_open, Balanced::ChildTnLst) else {
        return Ok(timing.to_owned());
    };
    let add = missing_media_nodes_xml(
        ids,
        anims,
        timing.get(child_open..child_close).unwrap_or_default(),
    )?;
    Ok(if add.is_empty() {
        timing.to_owned()
    } else {
        format!("{}{add}{}", &timing[..child_close], &timing[child_close..])
    })
}

/// In-place patch of the bodySuffix's `<p:timing>` (after transition, before
/// extLst). An existing timing has only its main sequence rebuilt; an empty
/// list removes the main sequence, and the timing once nothing is left.
pub fn patch_slide_timing_xml(
    body_suffix: &str,
    anims: &[SlideAnimation],
) -> Result<String, String> {
    if let Some(timing_m) = timing_re().exec(body_suffix)
        && let Some(rebuilt) =
            rebuild_timing_preserving_xml(timing_m.as_str(), anims).transpose()?
    {
        return Ok(format!(
            "{}{rebuilt}{}",
            &body_suffix[..timing_m.start()],
            &body_suffix[timing_m.end()..]
        ));
    }
    let stripped = replace_first_with(timing_re(), body_suffix, |_| String::new());
    if anims.is_empty() {
        return Ok(stripped);
    }
    let xml = build_timing_xml(anims)?;
    // Before </p:sld>; with a slide-level <p:extLst> (legal after timing, but
    // PowerPoint writes timing first), before the last extLst
    let ext = stripped.rfind("<p:extLst");
    let sld_end = stripped.rfind("</p:sld>");
    let Some(at) = ext.or(sld_end) else {
        return Ok(stripped);
    };
    Ok(format!("{}{xml}{}", &stripped[..at], &stripped[at..]))
}
