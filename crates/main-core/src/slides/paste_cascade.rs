//! `apps/slides/src/main/paste-cascade.ts`.

use jscompat::{JsMap, number_to_string};

/// `PasteCascade`
#[derive(Debug, Clone)]
pub struct PasteCascade {
    /// Page the elements were copied from; `None` after a cut (original removed).
    pub source_key: Option<String>,
    /// How many pastes of this clipboard each page has received.
    pub counts: JsMap<f64>,
}

/// `newPasteCascade(sourceKey)`
pub fn new_paste_cascade(source_key: Option<String>) -> PasteCascade {
    PasteCascade {
        source_key,
        counts: JsMap::new(),
    }
}

/// `pageKey(webContentsId, slideIndex)`
pub fn page_key(web_contents_id: f64, slide_index: f64) -> String {
    format!(
        "{}:{}",
        number_to_string(web_contents_id),
        number_to_string(slide_index)
    )
}

/// `pasteShiftPx(clip, targetKey)`: 16px per landing already on the page; the
/// original on the copy page counts as one.
pub fn paste_shift_px(clip: &PasteCascade, target_key: &str) -> f64 {
    let landed = clip.counts.get(target_key).copied().unwrap_or(0.0)
        + if clip.source_key.as_deref() == Some(target_key) {
            1.0
        } else {
            0.0
        };
    16.0 * landed
}

/// `recordPaste(clip, targetKey)`
pub fn record_paste(clip: &mut PasteCascade, target_key: &str) {
    let next = clip.counts.get(target_key).copied().unwrap_or(0.0) + 1.0;
    clip.counts.set(target_key, next);
}
