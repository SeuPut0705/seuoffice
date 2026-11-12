//! The animation model, the effect classes and the preset tables
//! (animation.ts up to `NODE_TYPE` and `IdGen`).

use jscompat::{JsNum, js_regex, to_number};
use serde::{Deserialize, Serialize};

use crate::types::SlideElement;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnimEffectKind {
    // Entrance
    Appear,
    Fade,
    FlyIn,
    Wipe,
    WipeDown,
    SplitIn,
    Bounce,
    FlipIn,
    Zoom,
    // Emphasis
    Pulse,
    Spin,
    Grow,
    Teeter,
    // Exit
    Disappear,
    FadeOut,
    FlyOut,
    WipeOut,
    Shrink,
    ZoomOut,
    MotionPath,
    MediaPlay,
    MediaPause,
    MediaStop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnimTrigger {
    OnClick,
    WithPrev,
    AfterPrev,
}

/// Side a fly/wipe effect comes from (entrance) or leaves towards (exit).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnimDirection {
    Top,
    Bottom,
    Left,
    Right,
}

pub const ANIM_DIRECTIONS: [AnimDirection; 4] = [
    AnimDirection::Top,
    AnimDirection::Bottom,
    AnimDirection::Left,
    AnimDirection::Right,
];

pub const ANIM_TRIGGERS: [AnimTrigger; 3] = [
    AnimTrigger::OnClick,
    AnimTrigger::WithPrev,
    AnimTrigger::AfterPrev,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnimClass {
    Entrance,
    Emphasis,
    Exit,
    Path,
    Media,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Video,
    Audio,
}

/// presetID/presetClass/presetSubtype of a kept-verbatim effect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnimPreset {
    pub id: JsNum,
    pub cls: String,
    pub sub: JsNum,
}

/// `SlideAnimation`. The fields after `delayMs` are in the order
/// `readSlideTimingXml` assigns them, which is the order its objects
/// serialize in; `mediaKind` is never read back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideAnimation {
    pub spid: JsNum,
    pub effect: AnimEffectKind,
    pub trigger: AnimTrigger,
    pub duration_ms: JsNum,
    pub delay_ms: JsNum,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<AnimDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_xml: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<AnimPreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraph: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_kind: Option<MediaKind>,
}

/// Whether the effect is a media command (play/pause/stop on a video or audio shape).
pub fn is_media_effect(effect: AnimEffectKind) -> bool {
    matches!(
        effect,
        AnimEffectKind::MediaPlay | AnimEffectKind::MediaPause | AnimEffectKind::MediaStop
    )
}

pub fn anim_class_of(effect: AnimEffectKind) -> AnimClass {
    use AnimEffectKind::*;
    match effect {
        Appear | Fade | FlyIn | Wipe | WipeDown | SplitIn | Bounce | FlipIn | Zoom => {
            AnimClass::Entrance
        }
        Pulse | Spin | Grow | Teeter => AnimClass::Emphasis,
        MotionPath => AnimClass::Path,
        MediaPlay | MediaPause | MediaStop => AnimClass::Media,
        Disappear | FadeOut | FlyOut | WipeOut | Shrink | ZoomOut => AnimClass::Exit,
    }
}

/// The element's own `<p:cNvPr id>` (the first one; group children follow).
pub fn element_spid(el: &SlideElement) -> Option<JsNum> {
    let anchor = crate::with_element!(el, e => e.anchor.as_ref())?;
    js_regex!(r#"<p:cNvPr\s[^>]*\bid=["'](\d+)["']"#)
        .exec(&anchor.original_xml)
        .map(|m| JsNum(to_number(m.get(1).unwrap_or_default())))
}

/// One entry of `PRESET`.
pub(super) struct Preset {
    pub id: f64,
    pub cls: &'static str,
    pub sub: f64,
}

/// `PRESET[effect]`.
pub(super) fn preset(effect: AnimEffectKind) -> Preset {
    use AnimEffectKind::*;
    let (id, cls, sub) = match effect {
        Appear => (1.0, "entr", 0.0),
        Fade => (10.0, "entr", 0.0),
        FlyIn => (2.0, "entr", 4.0),
        Wipe => (22.0, "entr", 1.0),
        WipeDown => (22.0, "entr", 4.0),
        SplitIn => (16.0, "entr", 21.0),
        Bounce => (26.0, "entr", 0.0),
        FlipIn => (30.0, "entr", 0.0),
        Zoom => (23.0, "entr", 16.0),
        Pulse => (26.0, "emph", 0.0),
        Spin => (8.0, "emph", 0.0),
        Grow => (6.0, "emph", 0.0),
        Teeter => (32.0, "emph", 0.0),
        Disappear => (1.0, "exit", 0.0),
        FadeOut => (10.0, "exit", 0.0),
        FlyOut => (2.0, "exit", 4.0),
        WipeOut => (22.0, "exit", 1.0),
        Shrink => (30.0, "exit", 0.0),
        ZoomOut => (23.0, "exit", 16.0),
        MotionPath => (0.0, "path", 0.0),
        MediaPause => (1.0, "mediacall", 0.0),
        MediaPlay => (2.0, "mediacall", 0.0),
        MediaStop => (3.0, "mediacall", 0.0),
    };
    Preset { id, cls, sub }
}

/// `MEDIA_CMD.mediaPlay`.
pub(super) const MEDIA_PLAY_CMD: &str = "playFrom(0.0)";

/// `MEDIA_CMD[effect]` of a media effect.
pub(super) fn media_cmd(effect: AnimEffectKind) -> &'static str {
    match effect {
        AnimEffectKind::MediaPause => "togglePause",
        AnimEffectKind::MediaStop => "stop",
        _ => MEDIA_PLAY_CMD,
    }
}

/// Media effect from a `<p:cmd cmd="...">` string; `None` for non-media commands.
pub(super) fn media_effect_from_cmd(cmd: &str) -> Option<AnimEffectKind> {
    if cmd.starts_with("playFrom") {
        return Some(AnimEffectKind::MediaPlay);
    }
    if cmd == "togglePause" {
        return Some(AnimEffectKind::MediaPause);
    }
    if cmd == "stop" {
        return Some(AnimEffectKind::MediaStop);
    }
    None
}

/// `Object.keys(PRESET)`: the order of the table, `mediaPause` before `mediaPlay`.
pub const ANIM_EFFECTS: [AnimEffectKind; 23] = {
    use AnimEffectKind::*;
    [
        Appear, Fade, FlyIn, Wipe, WipeDown, SplitIn, Bounce, FlipIn, Zoom, Pulse, Spin, Grow,
        Teeter, Disappear, FadeOut, FlyOut, WipeOut, Shrink, ZoomOut, MotionPath, MediaPause,
        MediaPlay, MediaStop,
    ]
};

/// `DIRECTIONAL.has(effect)`.
fn is_directional(effect: AnimEffectKind) -> bool {
    matches!(
        effect,
        AnimEffectKind::FlyIn
            | AnimEffectKind::FlyOut
            | AnimEffectKind::Wipe
            | AnimEffectKind::WipeOut
    )
}

fn is_fly(effect: AnimEffectKind) -> bool {
    matches!(effect, AnimEffectKind::FlyIn | AnimEffectKind::FlyOut)
}

/// `FLY_SUB[d]`: PowerPoint's presetSubtype per side for fly effects.
fn fly_sub(d: AnimDirection) -> f64 {
    match d {
        AnimDirection::Top => 1.0,
        AnimDirection::Bottom => 4.0,
        AnimDirection::Left => 8.0,
        AnimDirection::Right => 2.0,
    }
}

/// `WIPE_SUB[d]`.
fn wipe_sub(d: AnimDirection) -> f64 {
    match d {
        AnimDirection::Top => 4.0,
        AnimDirection::Bottom => 1.0,
        AnimDirection::Left => 8.0,
        AnimDirection::Right => 2.0,
    }
}

pub(super) fn preset_subtype_of(a: &SlideAnimation) -> f64 {
    match a.direction {
        Some(d) if is_directional(a.effect) => {
            if is_fly(a.effect) {
                fly_sub(d)
            } else {
                wipe_sub(d)
            }
        }
        _ => preset(a.effect).sub,
    }
}

pub(super) fn direction_from_preset(effect: AnimEffectKind, sub: f64) -> Option<AnimDirection> {
    if !is_directional(effect) {
        return None;
    }
    let table: fn(AnimDirection) -> f64 = if is_fly(effect) { fly_sub } else { wipe_sub };
    ANIM_DIRECTIONS.into_iter().find(|&d| table(d) == sub)
}

/// The TypeScript keys its two tables by `${cls}:${id}:${sub}` and
/// `${cls}:${id}`; every key holds a colon, so no inherited name can answer,
/// and a match on the three values is the same lookup.
pub(super) fn modeled_effect(cls: &str, id: f64, sub: f64) -> Option<AnimEffectKind> {
    use AnimEffectKind::*;
    if cls == "path" {
        return Some(MotionPath);
    }
    if cls == "mediacall" {
        return Some(if id == 1.0 {
            MediaPause
        } else if id == 3.0 {
            MediaStop
        } else {
            MediaPlay
        });
    }
    // entr:22:4 reads as wipe with direction top (wipeDown writes the same bytes)
    if cls == "entr" && id == 22.0 && (sub == 1.0 || sub == 4.0) {
        return Some(Wipe);
    }
    let exact: &[(f64, AnimEffectKind)] = match cls {
        "entr" => &[
            (1.0, Appear),
            (10.0, Fade),
            (2.0, FlyIn),
            (22.0, Wipe),
            (16.0, SplitIn),
            (26.0, Bounce),
            (30.0, FlipIn),
            (23.0, Zoom),
        ],
        "emph" => &[(26.0, Pulse), (8.0, Spin), (6.0, Grow), (32.0, Teeter)],
        "exit" => &[
            (1.0, Disappear),
            (10.0, FadeOut),
            (2.0, FlyOut),
            (22.0, WipeOut),
            (30.0, Shrink),
            (23.0, ZoomOut),
        ],
        _ => &[],
    };
    exact
        .iter()
        .find(|(key, _)| *key == id)
        .map(|&(_, effect)| effect)
}

pub(super) fn effect_from_preset(cls: &str, id: f64, sub: f64) -> AnimEffectKind {
    if let Some(hit) = modeled_effect(cls, id, sub) {
        return hit;
    }
    match cls {
        "exit" => AnimEffectKind::FadeOut,
        "emph" => AnimEffectKind::Pulse,
        _ => AnimEffectKind::Fade,
    }
}

/// `NODE_TYPE[trigger]`.
pub(super) fn node_type(trigger: AnimTrigger) -> &'static str {
    match trigger {
        AnimTrigger::OnClick => "clickEffect",
        AnimTrigger::WithPrev => "withEffect",
        AnimTrigger::AfterPrev => "afterEffect",
    }
}

/// `IdGen`: `next()` is `++counter` on a JavaScript number.
pub(super) struct IdGen {
    counter: f64,
}

impl IdGen {
    pub fn after(counter: f64) -> Self {
        Self { counter }
    }

    pub fn next(&mut self) -> f64 {
        self.counter += 1.0;
        self.counter
    }
}
