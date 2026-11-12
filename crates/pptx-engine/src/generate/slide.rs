//! Slide-level half of generate.ts: background, transition, auto-advance, hidden and
//! showMasterSp patches of a slide's `bodyPrefix` / `bodySuffix`.

use jscompat::{js_regex, replace_first_with, to_number, try_js_regex};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::shape::{FillPatch, GradientFillPatch, build_fill_xml, build_gradient_xml};
use super::{clamp_int, from_, lim, n, upto};

// ── Background ───────────────────────────────────────────────────────────

/// Slide background image write-back parameters (the rel must already exist in the slide's rels).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImagePatch {
    pub image_rid: String,
    /// Tile instead of stretch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<bool>,
}

/// `BackgroundFillPatch`: `string | GradientFillPatch | BackgroundImagePatch`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum BackgroundFillPatch {
    /// `'none'` or a color string
    Color(String),
    Gradient(GradientFillPatch),
    Image(BackgroundImagePatch),
}

impl<'de> Deserialize<'de> for BackgroundFillPatch {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::String(color) => Ok(Self::Color(color)),
            Value::Object(map) => {
                let is_image = map.contains_key("imageRid");
                let value = Value::Object(map);
                if is_image {
                    serde_json::from_value(value)
                        .map(Self::Image)
                        .map_err(D::Error::custom)
                } else {
                    serde_json::from_value(value)
                        .map(Self::Gradient)
                        .map_err(D::Error::custom)
                }
            }
            _ => Err(D::Error::custom("not a background fill patch")),
        }
    }
}

/// In-place patch of a slide's bodyPrefix: replace/inject the `<p:bg>` under `<p:cSld>`
/// with a solid color, gradient, or picture fill. Returns the new bodyPrefix.
pub fn patch_slide_background_xml(body_prefix: &str, fill: &BackgroundFillPatch) -> String {
    let fill_xml = match fill {
        // the rId goes in as given, as the TypeScript's template does
        BackgroundFillPatch::Image(img) => {
            let mut s = format!("<a:blipFill><a:blip r:embed=\"{}\"/>", img.image_rid);
            s += if img.tile == Some(true) {
                "<a:tile tx=\"0\" ty=\"0\" sx=\"100000\" sy=\"100000\" flip=\"none\" algn=\"tl\"/>"
            } else {
                "<a:stretch><a:fillRect/></a:stretch>"
            };
            s += "</a:blipFill>";
            s
        }
        BackgroundFillPatch::Gradient(g) => build_gradient_xml(g),
        BackgroundFillPatch::Color(c) => build_fill_xml(&FillPatch::Color(c.clone())),
    };
    let bg_xml = format!("<p:bg><p:bgPr>{fill_xml}<a:effectLst/></p:bgPr></p:bg>");
    if let Some(existing) = js_regex!(r"<p:bg>[\s\S]*?<\/p:bg>|<p:bg\s[^>]*\/>").exec(body_prefix) {
        return format!(
            "{}{bg_xml}{}",
            upto(body_prefix, existing.start()),
            from_(body_prefix, existing.end())
        );
    }
    let Some(c_sld) = js_regex!(r"<p:cSld(\s[^>]*)?>").exec(body_prefix) else {
        return body_prefix.to_owned();
    };
    let at = c_sld.end();
    format!(
        "{}{bg_xml}{}",
        upto(body_prefix, at),
        from_(body_prefix, at)
    )
}

/// Remove the slide's own `<p:bg>` override (background falls back to layout/master).
pub fn remove_slide_background_xml(body_prefix: &str) -> String {
    replace_first_with(
        js_regex!(r"<p:bg>[\s\S]*?<\/p:bg>|<p:bg\s[^>]*\/>"),
        body_prefix,
        |_| String::new(),
    )
}

/// Toggle showMasterSp on the `<p:sld>` root ("hide background graphics").
pub fn patch_slide_show_master_sp_xml(body_prefix: &str, hidden: bool) -> Result<String, String> {
    let re = try_js_regex!(r#"<p:sld((?:\s(?:"[^"]*"|'[^']*'|[^"'>])*?)?)>"#);
    let Some(open) = re.try_exec(body_prefix).map_err(lim)? else {
        return Ok(body_prefix.to_owned());
    };
    let mut attrs = replace_first_with(
        js_regex!(r#"\s+showMasterSp=(?:"[^"]*"|'[^']*')"#),
        open.get(1).unwrap_or_default(),
        |_| String::new(),
    );
    if hidden {
        attrs += " showMasterSp=\"0\"";
    }
    Ok(format!(
        "{}<p:sld{attrs}>{}",
        upto(body_prefix, open.start()),
        from_(body_prefix, open.end())
    ))
}

// ── Transition ───────────────────────────────────────────────────────────

/// `SlideTransitionKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlideTransitionKind {
    None,
    Morph,
    Fade,
    Push,
    Wipe,
    Split,
    Circle,
    Cover,
    Pull,
    Dissolve,
    Zoom,
    Random,
}

pub const TRANSITION_KINDS: [SlideTransitionKind; 12] = [
    SlideTransitionKind::None,
    SlideTransitionKind::Morph,
    SlideTransitionKind::Fade,
    SlideTransitionKind::Push,
    SlideTransitionKind::Wipe,
    SlideTransitionKind::Split,
    SlideTransitionKind::Circle,
    SlideTransitionKind::Cover,
    SlideTransitionKind::Pull,
    SlideTransitionKind::Dissolve,
    SlideTransitionKind::Zoom,
    SlideTransitionKind::Random,
];

fn transition_inner(kind: SlideTransitionKind) -> &'static str {
    match kind {
        SlideTransitionKind::Fade => "<p:fade/>",
        SlideTransitionKind::Push => "<p:push dir=\"u\"/>",
        SlideTransitionKind::Wipe => "<p:wipe dir=\"l\"/>",
        SlideTransitionKind::Split => "<p:split orient=\"horz\" dir=\"out\"/>",
        SlideTransitionKind::Circle => "<p:circle/>",
        SlideTransitionKind::Cover => "<p:cover dir=\"l\"/>",
        SlideTransitionKind::Pull => "<p:pull dir=\"l\"/>",
        SlideTransitionKind::Dissolve => "<p:dissolve/>",
        SlideTransitionKind::Zoom => "<p:zoom/>",
        SlideTransitionKind::Random => "<p:random/>",
        SlideTransitionKind::None | SlideTransitionKind::Morph => "",
    }
}

/// Morph transition: PowerPoint 2019+'s `<p159:morph>` (2015/main namespace), wrapped in
/// mc:AlternateContent — older PowerPoint uses the Fallback fade without erroring.
const MORPH_TRANSITION_XML: &str = concat!(
    "<mc:AlternateContent xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\">",
    "<mc:Choice xmlns:p159=\"http://schemas.microsoft.com/office/powerpoint/2015/main\" Requires=\"p159\">",
    "<p:transition xmlns:p14=\"http://schemas.microsoft.com/office/powerpoint/2010/main\" spd=\"slow\" p14:dur=\"800\">",
    "<p159:morph option=\"byObject\"/></p:transition></mc:Choice>",
    "<mc:Fallback><p:transition spd=\"slow\"><p:fade/></p:transition></mc:Fallback>",
    "</mc:AlternateContent>"
);

fn transition_re() -> &'static jscompat::JsRegex {
    js_regex!(r"<p:transition\b[^>]*\/>|<p:transition\b[^>]*>[\s\S]*?<\/p:transition>")
}

/// AlternateContent-wrapped transition (only counts when Choice is immediately followed by
/// p:transition, avoiding other AC blocks).
fn ac_transition_re() -> &'static jscompat::JsRegex {
    js_regex!(
        r"<mc:AlternateContent\b[^>]*>\s*<mc:Choice\b[^>]*>\s*<p:transition\b[\s\S]*?<\/mc:AlternateContent>"
    )
}

/// `AC_TRANSITION_RE.exec(s) ?? TRANSITION_RE.exec(s)`: (start, end, text).
fn find_transition(s: &str) -> Option<(usize, usize, &str)> {
    ac_transition_re()
        .exec(s)
        .or_else(|| transition_re().exec(s))
        .map(|m| (m.start(), m.end(), m.as_str()))
}

/// `<p:transition>`'s schema insertion point: after clrMapOvr, else after `</p:cSld>`
/// (before timing); `None` when not found.
fn transition_insert_pos(body: &str) -> Option<usize> {
    if let Some(clr_map) =
        js_regex!(r"<p:clrMapOvr\b[^>]*\/>|<p:clrMapOvr\b[^>]*>[\s\S]*?<\/p:clrMapOvr>").exec(body)
    {
        return Some(clr_map.end());
    }
    jscompat::index_of(body, "</p:cSld>", 0).map(|at| at + "</p:cSld>".len())
}

/// In-place patch of the bodySuffix's `<p:transition>` (schema order: after clrMapOvr,
/// before timing). 'none' only removes the effect; 'morph' writes an AlternateContent-wrapped
/// p159:morph. A configured auto-advance time (advTm) is kept when switching effects.
pub fn patch_slide_transition_xml(body_suffix: &str, kind: SlideTransitionKind) -> String {
    let adv_tm = read_slide_advance_time_xml(body_suffix);
    let no_ac = replace_first_with(ac_transition_re(), body_suffix, |_| String::new());
    let stripped = replace_first_with(transition_re(), &no_ac, |_| String::new());
    if kind == SlideTransitionKind::None {
        return match adv_tm {
            None => stripped,
            Some(ms) => patch_slide_advance_time_xml(&stripped, Some(ms)),
        };
    }
    let xml = if kind == SlideTransitionKind::Morph {
        MORPH_TRANSITION_XML.to_owned()
    } else {
        format!("<p:transition>{}</p:transition>", transition_inner(kind))
    };
    let Some(at) = transition_insert_pos(&stripped) else {
        return stripped;
    };
    let out = format!("{}{xml}{}", upto(&stripped, at), from_(&stripped, at));
    match adv_tm {
        None => out,
        Some(ms) => patch_slide_advance_time_xml(&out, Some(ms)),
    }
}

/// Read the current transition from the bodySuffix (unmodeled effects map to 'none').
pub fn read_slide_transition_xml(body_suffix: &str) -> SlideTransitionKind {
    // AlternateContent wrapper first (morph, or PowerPoint's newer form with p14:dur)
    let Some((_, _, m)) = find_transition(body_suffix) else {
        return SlideTransitionKind::None;
    };
    if js_regex!(r"<[\w.]+:morph[\s/>]").test(m) {
        return SlideTransitionKind::Morph;
    }
    let kind = js_regex!(r"<p:(fade|push|wipe|split|circle|cover|pull|dissolve|zoom|random)\b")
        .exec(m)
        .and_then(|k| k.get(1));
    match kind {
        Some("fade") => SlideTransitionKind::Fade,
        Some("push") => SlideTransitionKind::Push,
        Some("wipe") => SlideTransitionKind::Wipe,
        Some("split") => SlideTransitionKind::Split,
        Some("circle") => SlideTransitionKind::Circle,
        Some("cover") => SlideTransitionKind::Cover,
        Some("pull") => SlideTransitionKind::Pull,
        Some("dissolve") => SlideTransitionKind::Dissolve,
        Some("zoom") => SlideTransitionKind::Zoom,
        Some("random") => SlideTransitionKind::Random,
        _ => SlideTransitionKind::None,
    }
}

// ── Auto-advance time ────────────────────────────────────────────────────

/// Set/remove advTm on every `<p:transition>` open tag in the block (both Choice/Fallback in
/// morph's AC wrapper).
fn patch_adv_tm_attr(block: &str, ms: Option<f64>) -> String {
    js_regex!(r"<p:transition\b[^>]*>").replace_all(block, |tag| {
        let cleaned = replace_first_with(js_regex!(r#"\s+advTm="[^"]*""#), tag.as_str(), |_| {
            String::new()
        });
        let Some(ms) = ms else {
            return cleaned;
        };
        replace_first_with(js_regex!(r"(\s*\/)?>$"), &cleaned, |m| {
            format!(
                " advTm=\"{}\"{}>",
                n(clamp_int(ms, 0.0, 4_294_967_295.0)),
                m.get(1).unwrap_or_default()
            )
        })
    })
}

/// In-place patch of the bodySuffix's auto-advance time (PowerPoint's "advance slide after /
/// rehearse timings"). `None` removes it; when the slide has no transition, a new empty
/// `<p:transition>` carrying only advTm is created. Returns the new bodySuffix.
pub fn patch_slide_advance_time_xml(body_suffix: &str, ms: Option<f64>) -> String {
    if let Some((start, end, m)) = find_transition(body_suffix) {
        return format!(
            "{}{}{}",
            upto(body_suffix, start),
            patch_adv_tm_attr(m, ms),
            from_(body_suffix, end)
        );
    }
    let Some(ms) = ms else {
        return body_suffix.to_owned();
    };
    let Some(at) = transition_insert_pos(body_suffix) else {
        return body_suffix.to_owned();
    };
    format!(
        "{}<p:transition advTm=\"{}\"/>{}",
        upto(body_suffix, at),
        n(clamp_int(ms, 0.0, 4_294_967_295.0)),
        from_(body_suffix, at)
    )
}

/// Read the auto-advance time from the bodySuffix (ms; `None` when unset).
pub fn read_slide_advance_time_xml(body_suffix: &str) -> Option<f64> {
    let (_, _, m) = find_transition(body_suffix)?;
    let adv = js_regex!(r#"\badvTm="(\d+)""#).exec(m)?;
    Some(to_number(adv.get(1).unwrap_or_default()))
}

// ── Hidden slide ─────────────────────────────────────────────────────────

/// In-place patch of the show attribute on the bodyPrefix root element; hidden=false removes
/// it. Returns the new bodyPrefix.
pub fn patch_slide_hidden_xml(body_prefix: &str, hidden: bool) -> String {
    let Some(m) = js_regex!(r"<p:sld\b[^>]*>").exec(body_prefix) else {
        return body_prefix.to_owned();
    };
    let mut tag = replace_first_with(js_regex!(r#"\s+show="[^"]*""#), m.as_str(), |_| {
        String::new()
    });
    if hidden {
        tag.pop();
        tag += " show=\"0\">";
    }
    format!(
        "{}{tag}{}",
        upto(body_prefix, m.start()),
        from_(body_prefix, m.end())
    )
}

/// Read whether the bodyPrefix marks the slide as hidden.
pub fn read_slide_hidden_xml(body_prefix: &str) -> bool {
    js_regex!(r"<p:sld\b[^>]*>")
        .exec(body_prefix)
        .is_some_and(|m| js_regex!(r#"\sshow="0""#).test(m.as_str()))
}
