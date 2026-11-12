//! animation.ts of the slides engine, called as `animation.<TypeScript name>`.

use pptx_engine::animation::{
    ANIM_DIRECTIONS, ANIM_EFFECTS, ANIM_TRIGGERS, AnimClass, AnimEffectKind, DEFAULT_MOTION_PATH,
    SlideAnimation, anim_class_of, build_timing_xml, c_nv_pr_ids_in_xml, element_spid,
    get_slide_animations, is_media_effect, patch_slide_timing_incremental_xml,
    patch_slide_timing_xml, prune_timing_for_spids, read_slide_timing_xml, set_slide_animations,
};
use pptx_engine::types::Slide;
use serde::Serialize;
use serde_json::Value;

use super::pptx_ident::element_with;
use super::{Returned, arg, required, value};

/// The effect a text names. A text outside the union answers as the
/// TypeScript's comparisons and its switch do: no media effect, class exit.
fn effect_named(text: &str) -> Option<AnimEffectKind> {
    serde_json::from_value(Value::String(text.to_owned())).ok()
}

/// `args.whole ? list : list.indexOf(text)`
fn list_constant<T: Serialize>(list: &[T], text: &str, args: &Value) -> Returned {
    if arg::<bool>(args, "whole")?.unwrap_or(false) {
        return value(list);
    }
    let index = list
        .iter()
        .position(|item| {
            serde_json::to_value(item)
                .ok()
                .as_ref()
                .and_then(Value::as_str)
                == Some(text)
        })
        .map_or(-1, |at| at as i64);
    value(index)
}

fn slide_of(text: &str, args: &Value) -> Result<Slide, String> {
    let mut slide = Slide::default();
    slide.body_suffix.set(text.to_owned());
    slide
        .structure_dirty
        .set(arg::<bool>(args, "structureDirty")?.unwrap_or(false));
    Ok(slide)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pruned<'a> {
    changed: bool,
    body_suffix: &'a str,
    structure_dirty: bool,
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "animation.ANIM_DIRECTIONS" => list_constant(&ANIM_DIRECTIONS, text, args),
        "animation.ANIM_TRIGGERS" => list_constant(&ANIM_TRIGGERS, text, args),
        "animation.ANIM_EFFECTS" => list_constant(&ANIM_EFFECTS, text, args),
        "animation.DEFAULT_MOTION_PATH" => {
            if arg::<bool>(args, "whole")?.unwrap_or(false) {
                return value(DEFAULT_MOTION_PATH);
            }
            // the constant is ASCII: a byte index is its UTF-16 index
            value(DEFAULT_MOTION_PATH.find(text).map_or(-1, |at| at as i64))
        }
        "animation.isMediaEffect" => value(effect_named(text).is_some_and(is_media_effect)),
        "animation.animClassOf" => value(effect_named(text).map_or(AnimClass::Exit, anim_class_of)),
        "animation.elementSpid" => value(element_spid(&element_with(None, Some(text), None))),
        "animation.buildTimingXml" => {
            let anims: Vec<SlideAnimation> = required(args, "anims")?;
            value(build_timing_xml(&anims)?)
        }
        "animation.patchSlideTimingXml" => {
            let anims: Vec<SlideAnimation> = required(args, "anims")?;
            value(patch_slide_timing_xml(text, &anims)?)
        }
        "animation.readSlideTimingXml" => value(read_slide_timing_xml(text)),
        "animation.patchSlideTimingIncrementalXml" => {
            let anims: Vec<SlideAnimation> = required(args, "anims")?;
            value(patch_slide_timing_incremental_xml(text, &anims).transpose()?)
        }
        "animation.setSlideAnimations" => {
            let anims: Vec<SlideAnimation> = required(args, "anims")?;
            let mut slide = slide_of(text, args)?;
            set_slide_animations(&mut slide, &anims)?;
            value(slide)
        }
        "animation.getSlideAnimations" => value(get_slide_animations(&slide_of(text, args)?)),
        "animation.pruneTimingForSpids" => {
            // `new Set(spids)`: the values in order, without repeats
            let listed: Vec<f64> = required(args, "spids")?;
            let mut spids: Vec<f64> = Vec::with_capacity(listed.len());
            for id in listed {
                if !spids.contains(&id) {
                    spids.push(id);
                }
            }
            let mut slide = slide_of(text, args)?;
            let changed = prune_timing_for_spids(&mut slide, &spids)?;
            value(Pruned {
                changed,
                body_suffix: slide.body_suffix.as_deref().unwrap_or(""),
                structure_dirty: slide.structure_dirty.unwrap_or(false),
            })
        }
        "animation.cNvPrIdsInXml" => value(c_nv_pr_ids_in_xml(text)),
        _ => Err(format!("unknown function {function}")),
    }
}
