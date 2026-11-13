//! `apps/slides/src/main/seed-deck.ts`: a new slides tab that starts with a
//! given deck (spec 8.6, "convert without AI"). The tab takes the queued deck
//! once, when its renderer asks for the pending open after mounting: the deck
//! becomes the view's session as a NEW, UNSAVED document.
//!
//! What moved is the judgment: taking the queued entry (through
//! [`SeedQueue`]), the session fields built from the entry's options, the
//! order of the session calls, the result and the deck-changed message that
//! follows the open. `shapedMetricsReady`, `openPptx` (pptx-engine,
//! engine-waiting) and the session registry (`session-state`) are the
//! [`SeedDeckHost`] the caller implements. The `setImmediate` of the message
//! is [`DeckChanged::deliver`], which the caller runs on the next turn.

use serde_json::{Map, Number, Value};

use crate::slides::seed_queue::{RecoveryIdentity, SeedQueue};

/// the fields `openSlidesSeed` sets on the new `Session`, besides the deck
/// and the empty undo and redo stacks
#[derive(Debug, Clone, PartialEq)]
pub struct SeedSession {
    /// always `''`: the deck was never saved
    pub path: String,
    pub fit_width_px: f64,
    /// `askPathOnFirstSave: true`; `false` leaves the key out
    pub ask_path_on_first_save: bool,
    /// `firstSaveName`, set with `askPathOnFirstSave`
    pub first_save_name: Option<String>,
    pub recovery_id: Option<RecoveryIdentity>,
    pub password: Option<String>,
}

/// The session registry and the engine, as `openSlidesSeed` reaches them. The
/// session of a view is addressed by its webContents id once `set_session`
/// has put it there.
pub trait SeedDeckHost {
    /// `OpenedPptx`
    type Opened;
    /// the `Session` built from the fields and the opened deck
    type Session;

    /// `shapedMetricsReady()`: lay out only after the complex-script metrics are ready
    fn shaped_metrics_ready(&mut self);
    /// `openPptx(bytes)`; `Err` is the message of what it threw
    fn open_pptx(&mut self, bytes: &[u8]) -> Result<Self::Opened, String>;
    /// the `Session` object: `{ path, opened, fitWidthPx, undoStack: [], redoStack: [], ... }`
    fn new_session(&mut self, fields: SeedSession, opened: Self::Opened) -> Self::Session;
    /// `markMetaDirty(session)`
    fn mark_meta_dirty(&mut self, session: &mut Self::Session);
    /// `sessions.set(wc.id, session)`
    fn set_session(&mut self, wc_id: f64, session: Self::Session);
    /// `scheduleHistoryNotify(session)`, of the session of `wc_id`
    fn schedule_history_notify(&mut self, wc_id: f64);
    /// `buildAllRenderSlides(opened, fitWidthPx)`, of the session of `wc_id`
    fn build_all_render_slides(&mut self, wc_id: f64, fit_width_px: f64) -> Vec<Value>;
    /// `{ cx: opened.deck.size.cx, cy: opened.deck.size.cy }`, of the session of `wc_id`
    fn deck_size(&mut self, wc_id: f64) -> (f64, f64);
    /// `defaultFontOf(opened)`, of the session of `wc_id`
    fn default_font_of(&mut self, wc_id: f64) -> Option<String>;
}

/// the part of a webContents the deferred message needs
pub trait SeedContents {
    fn is_destroyed(&self) -> bool;
    /// `wc.send(channel, payload)`
    fn send(&mut self, channel: &str, payload: &Value);
}

fn number(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn size_value(size: (f64, f64)) -> Value {
    let mut map = Map::new();
    map.insert("cx".into(), number(size.0));
    map.insert("cy".into(), number(size.1));
    Value::Object(map)
}

/// `OpenResult`: `{ path, slides, size, defaultFont? }`
#[derive(Debug, Clone, PartialEq)]
pub struct OpenResult {
    pub path: String,
    pub slides: Vec<Value>,
    pub size: (f64, f64),
    pub default_font: Option<String>,
}

impl OpenResult {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("path".into(), Value::from(self.path.as_str()));
        map.insert("slides".into(), Value::Array(self.slides.clone()));
        map.insert("size".into(), size_value(self.size));
        if let Some(font) = &self.default_font {
            map.insert("defaultFont".into(), Value::from(font.as_str()));
        }
        Value::Object(map)
    }
}

/// The `slides:deck-changed` message sent right after the open: an open shows
/// the deck as clean; this one makes the renderer ask the session, which
/// answers "unsaved".
#[derive(Debug, Clone, PartialEq)]
pub struct DeckChanged {
    pub slides: Vec<Value>,
    pub size: (f64, f64),
}

impl DeckChanged {
    /// the callback of `setImmediate`
    pub fn deliver(&self, wc: &mut dyn SeedContents) {
        if !wc.is_destroyed() {
            let mut map = Map::new();
            map.insert("slides".into(), Value::Array(self.slides.clone()));
            map.insert("size".into(), size_value(self.size));
            wc.send("slides:deck-changed", &Value::Object(map));
        }
    }
}

/// what `openSlidesSeed` answers when a deck was queued
#[derive(Debug, Clone, PartialEq)]
pub struct SeedOpen {
    pub result: OpenResult,
    pub deck_changed: DeckChanged,
}

/// `openSlidesSeed(wc, fitWidthPx, defaultFontOf)`: the pending-open step for
/// a view with a queued deck: the view's session becomes the new unsaved deck
/// and the renderer gets what an open returns. `Ok(None)` when nothing is
/// queued for this view; `Err` is what `openPptx` threw.
pub fn open_slides_seed<H: SeedDeckHost>(
    host: &mut H,
    queue: &mut SeedQueue,
    wc_id: f64,
    fit_width_px: f64,
) -> Result<Option<SeedOpen>, String> {
    let Some(entry) = queue.take_slides_seed_entry(wc_id) else {
        return Ok(None);
    };
    // lay out only after the complex-script metrics are ready, like any open
    host.shaped_metrics_ready();
    let opened = host.open_pptx(&entry.deck)?;
    let ask = entry.options.ask_path_on_first_save == Some(true);
    let fields = SeedSession {
        path: String::new(),
        fit_width_px,
        ask_path_on_first_save: ask,
        first_save_name: if ask {
            entry.options.suggested_name.clone()
        } else {
            None
        },
        recovery_id: entry.options.recovery_id.clone(),
        password: entry.options.password.clone(),
    };
    let mut session = host.new_session(fields, opened);
    // never saved: the deck holds what the disk does not
    host.mark_meta_dirty(&mut session);
    host.set_session(wc_id, session);
    host.schedule_history_notify(wc_id);
    let slides = host.build_all_render_slides(wc_id, fit_width_px);
    let size = host.deck_size(wc_id);
    let deck_changed = DeckChanged {
        slides: slides.clone(),
        size,
    };
    let default_font = host.default_font_of(wc_id);
    Ok(Some(SeedOpen {
        result: OpenResult {
            path: String::new(),
            slides,
            size,
            default_font,
        },
        deck_changed,
    }))
}
