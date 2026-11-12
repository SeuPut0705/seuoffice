//! Shape animation (`<p:timing>`) read and write
//! (packages/pptx-engine/src/animation.ts), the engine layer behind
//! PowerPoint's Animations tab.
//!
//! A slide's animations are an ordered `SlideAnimation` list: target shape
//! (`spid`, the shape's `<p:cNvPr id>`), effect, trigger, duration and delay.
//! A write rebuilds the main sequence as PowerPoint lays it out (tmRoot,
//! mainSeq, one par per click group, one par per effect); a read maps
//! unmodeled presets to an effect of the same class and keeps their bytes.

mod incremental;
mod model;
mod prune;
mod read;
mod write;

pub use incremental::{
    get_slide_animations, patch_slide_timing_incremental_xml, set_slide_animations,
};
pub use model::{
    ANIM_DIRECTIONS, ANIM_EFFECTS, ANIM_TRIGGERS, AnimClass, AnimDirection, AnimEffectKind,
    AnimPreset, AnimTrigger, MediaKind, SlideAnimation, anim_class_of, element_spid,
    is_media_effect,
};
pub use prune::{c_nv_pr_ids_in_xml, prune_timing_for_spids};
pub use read::read_slide_timing_xml;
pub use write::{DEFAULT_MOTION_PATH, build_timing_xml, patch_slide_timing_xml};
