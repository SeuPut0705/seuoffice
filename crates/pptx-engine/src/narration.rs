//! Recorded narration (Slide Show > Record), stored the way PowerPoint stores it so PowerPoint
//! plays it back too (packages/pptx-engine/src/narration.ts): per slide, an audio picture in the
//! bottom-right corner that starts with the slide, under a `<p:audio isNarration="1">` media node
//! whose `showWhenStopped="0"` hides it during the show, and presProps'
//! `<p:showPr showNarration="1">` for the whole deck.

use jscompat::{JsNum, js_regex, number_to_string, replace_first_with, to_number};
use serde::Deserialize;

use crate::animation::{
    AnimEffectKind, AnimTrigger, MediaKind, SlideAnimation, element_spid, get_slide_animations,
    set_slide_animations,
};
use crate::deck::OpenedPptx;
use crate::insert::delete_element;
use crate::media_insert::{NewMediaKind, NewMediaOptions, add_media};
use crate::notes::{add_content_type_override, append_relationship, replace_literal};
use crate::types::{EmuRect, Slide};
use crate::zip::resolve_target;

const PRES_PATH: &str = "ppt/presentation.xml";
const PRES_PROPS_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps";
const PRES_PROPS_CT: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
/// The size PowerPoint gives a recorded narration's icon: a third of an inch.
const NARRATION_ICON_EMU: f64 = 304800.0;
pub const NARRATION_NAME: &str = "Narration";

pub fn narration_spids(slide: &Slide) -> Vec<f64> {
    let body_suffix = (*slide.body_suffix).as_deref().unwrap_or_default();
    let mut spids = Vec::new();
    for node in js_regex!(r#"<p:audio\b[^>]*\bisNarration="(?:1|true)"[^>]*>[\s\S]*?<\/p:audio>"#)
        .find_iter(body_suffix)
    {
        if let Some(spid) = js_regex!(r#"<p:spTgt spid="(\d+)""#).exec(node.as_str()) {
            spids.push(to_number(spid.get(1).unwrap_or_default()));
        }
    }
    spids
}

/// Removes the slide's narration: its pictures, their timing and their media parts.
pub fn clear_narration(opened: &mut OpenedPptx, slide_index: usize) -> Result<usize, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Ok(0);
    };
    let spids = narration_spids(slide);
    let targets: Vec<String> = (*slide.elements)
        .as_ref()
        .map(|els| {
            els.iter()
                .filter(|el| {
                    let spid = element_spid(el).map_or(-1.0, |n| n.0);
                    spids.contains(&spid)
                })
                .map(|el| el.id().to_owned())
                .collect()
        })
        .unwrap_or_default();
    for id in &targets {
        delete_element(opened, slide_index, id)?;
    }
    Ok(targets.len())
}

fn mark_narration(body_suffix: &str, spid: f64) -> String {
    let needle = format!("<p:spTgt spid=\"{}\"/>", number_to_string(spid));
    let mut out = String::with_capacity(body_suffix.len());
    let mut last = 0;
    for node in js_regex!(r"<p:audio>([\s\S]*?)<\/p:audio>").find_iter(body_suffix) {
        out.push_str(body_suffix.get(last..node.start()).unwrap_or_default());
        last = node.end();
        let inner = node.get(1).unwrap_or_default();
        if !inner.contains(&needle) {
            out.push_str(node.as_str());
            continue;
        }
        let media = replace_first_with(js_regex!(r"<p:cMediaNode\b"), inner, |_| {
            "<p:cMediaNode showWhenStopped=\"0\"".to_owned()
        });
        out.push_str(&format!("<p:audio isNarration=\"1\">{media}</p:audio>"));
    }
    out.push_str(body_suffix.get(last..).unwrap_or_default());
    out
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrationAudio {
    #[serde(deserialize_with = "crate::json_bytes::bytes")]
    pub bytes: Vec<u8>,
    /// wav, m4a or mp3
    pub ext: String,
    pub duration_ms: JsNum,
}

/// Replaces the slide's narration with `audio`, which plays from the slide's start, before the
/// slide's own animations. The slide's advance time is not touched: see setSlideAdvanceTime.
/// The new element's id; the slide is `opened.deck.slides[slide_index]`.
pub fn add_narration(
    opened: &mut OpenedPptx,
    slide_index: usize,
    audio: &NarrationAudio,
    uuid: &str,
) -> Result<Option<String>, String> {
    clear_narration(opened, slide_index)?;
    let size = opened.deck.size;
    let options = NewMediaOptions {
        kind: NewMediaKind::Audio,
        bytes: audio.bytes.clone(),
        ext: audio.ext.clone(),
        poster: None,
        offset: EmuRect {
            x: JsNum(size.cx.0 - NARRATION_ICON_EMU),
            y: JsNum(size.cy.0 - NARRATION_ICON_EMU),
            cx: JsNum(NARRATION_ICON_EMU),
            cy: JsNum(NARRATION_ICON_EMU),
        },
        name: Some(NARRATION_NAME.to_owned()),
    };
    let Some(added) = add_media(opened, slide_index, &options, uuid)? else {
        return Ok(None);
    };
    let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
        return Ok(None);
    };
    let spid = (*slide.elements)
        .as_ref()
        .and_then(|els| els.iter().find(|e| e.id() == added))
        .and_then(element_spid);
    let Some(spid) = spid else {
        return Ok(None);
    };
    let mut anims = vec![SlideAnimation {
        spid,
        effect: AnimEffectKind::MediaPlay,
        trigger: AnimTrigger::AfterPrev,
        duration_ms: audio.duration_ms,
        delay_ms: JsNum(0.0),
        direction: None,
        preset_xml: None,
        preset: None,
        paragraph: None,
        motion_path: None,
        media_kind: Some(MediaKind::Audio),
    }];
    anims.extend(get_slide_animations(slide));
    set_slide_animations(slide, &anims)?;
    let marked = mark_narration((*slide.body_suffix).as_deref().unwrap_or_default(), spid.0);
    slide.body_suffix.set(marked);
    Ok(Some(added))
}

/// The deck's presProps part, created and registered when missing.
fn pres_props_path(opened: &mut OpenedPptx) -> Result<Option<String>, String> {
    let archive = &mut opened.archive;
    for rel in archive.read_rels(PRES_PATH)?.values() {
        if rel.r#type == PRES_PROPS_REL {
            return Ok(Some(resolve_target(PRES_PATH, &rel.target)));
        }
    }
    if !archive.has(PRES_PATH) {
        return Ok(None);
    }
    let path = "ppt/presProps.xml";
    archive.entries_mut().set(
        path,
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n\
<p:presentationPr xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\"/>"
        )
        .into_bytes(),
    );
    add_content_type_override(archive, path, PRES_PROPS_CT);
    append_relationship(archive, PRES_PATH, PRES_PROPS_REL, "presProps.xml");
    Ok(Some(path.to_owned()))
}

/// Sets presProps' `showNarration` (its schema default is off, so PowerPoint would not play the
/// recorded narration) and `useTimings`, keeping every other show property.
pub fn set_show_narration(opened: &mut OpenedPptx) -> Result<(), String> {
    let path = pres_props_path(opened)?;
    let Some(path) = path else {
        return Ok(());
    };
    let Some(xml) = opened
        .archive
        .read_text(&path)
        .filter(|x| !x.is_empty())
        .map(|x| x.into_owned())
    else {
        return Ok(());
    };
    let flags = [("showNarration", "1"), ("useTimings", "1")];
    let next: String;
    if let Some(show_pr) = js_regex!(r"<p:showPr\b[^>]*?(\/?)>").exec(&xml) {
        let mut tag = show_pr.as_str().to_owned();
        for (name, value) in flags {
            // `name` is one of the two attributes of `flags`: a literal pattern each
            macro_rules! attr_re {
                ($name:literal) => {
                    js_regex!(concat!(r"\s", $name, r#"="[^"]*""#))
                };
            }
            let has = match name {
                "showNarration" => attr_re!("showNarration"),
                "useTimings" => attr_re!("useTimings"),
                _ => return Err(format!("no attribute pattern for {name}")),
            };
            tag = if has.test(&tag) {
                replace_first_with(has, &tag, |_| format!(" {name}=\"{value}\""))
            } else {
                replace_first_with(js_regex!(r"^<p:showPr"), &tag, |_| {
                    format!("<p:showPr {name}=\"{value}\"")
                })
            };
        }
        // a function replacement: the tag is the deck's own, written as given
        next = replace_literal(&xml, show_pr.as_str(), &tag);
    } else {
        let element = "<p:showPr showNarration=\"1\" useTimings=\"1\"/>";
        let self_closed =
            replace_first_with(js_regex!(r"<p:presentationPr\b([^>]*?)\/>"), &xml, |m| {
                format!(
                    "<p:presentationPr{}>{element}</p:presentationPr>",
                    m.get(1).unwrap_or_default()
                )
            });
        next = if self_closed != xml {
            self_closed
        } else {
            replace_first_with(
                js_regex!(r"<p:(?:clrMru|extLst)\b|<\/p:presentationPr>"),
                &xml,
                |m| format!("{element}{}", m.as_str()),
            )
        };
    }
    if next != xml {
        opened.archive.entries_mut().set(path, next.into_bytes());
    }
    Ok(())
}
