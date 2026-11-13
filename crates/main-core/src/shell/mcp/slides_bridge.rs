//! `apps/shell/src/main/mcp/slides-bridge.ts`: the shell-main half of the MCP
//! to slides bridge.
//!
//! Unlike docs, a slides editing session lives in the main process (keyed by
//! the tab's webContents id), so there is no renderer protocol here: the
//! control opens a blank slides tab, waits for the session the renderer's boot
//! pull creates (`slides:new-blank`), then drives it through the same
//! functions the app's own `slides:apply-txn` and save pipeline use. Every
//! transaction lands in the session's undo history and journal, and the tab
//! re-renders live.
//!
//! What waits for the slides engine is behind [`SlidesBridgeHost`]: the
//! session map (`sessions`, `attachedIds`), `applySessionTxn`,
//! `saveSessionDeckTo` and the reads of `@seuoffice/pptx-engine`
//! (`elementDurableId`, `slideDurableId`, `getSlideComments`,
//! `getSlideHidden`). The deck the engine opened is JSON in the shape of its
//! model: `{ size: { cx, cy }, slides: [{ path, elements: [..] }] }`, an
//! element carrying `type`, `id`, `redact`, `transform.offset`, `text.paragraphs`
//! (`runs: [{ text, redact }]`), `rows` or `children` as the model does.
//!
//! `waitSession` polls every 100 ms; here each poll is a step the caller
//! drives: [`SlidesBridge::open_blank_tab`] answers [`Submitted`], and while
//! it is pending the host's timer ([`SlidesBridgeHost::set_timeout`]) calls
//! [`SlidesBridge::on_timeout`]. The tool layer's `SlidesControl` is
//! implemented over the other methods ([`SlidesBridge::run_txn`],
//! [`SlidesBridge::read_deck`], [`SlidesBridge::deck_withholds`],
//! [`SlidesBridge::save_deck`]) by the host that owns the bridge.

use jscompat::node_path::host::{extname, is_absolute};
use jscompat::{JsObject, JsonValue};

use super::docs_bridge::{Settled, Submitted};
use super::tools::slides_tools::{ReadDeckOptions, SlidesTxnRequest};
use crate::packages::agent_core::redact_core::placeholder_source;

/// `READY_TIMEOUT_MS`
pub const READY_TIMEOUT_MS: f64 = 20_000.0;
const EMU_PER_PX_96: f64 = 9525.0;
/// per-text cap in read_deck, mirroring the CLI's describeDeck clipping
const MAX_TEXT_CHARS: usize = 300;
/// table rows echoed per element (the CLI caps its own table output the same way)
const MAX_TABLE_ROWS: usize = 3;
/// the poll interval of `waitSession`
const POLL_MS: f64 = 100.0;

/// What the bridge does to the world: Electron, the slides main process and
/// the pptx engine. `Err` is the message of what a call throws.
pub trait SlidesBridgeHost {
    /// `webContents.fromId(wcId)` is a webContents that is not destroyed
    fn web_contents_alive(&mut self, wc_id: i64) -> bool;
    /// `webContents.fromId(id)?.send('slides:deck-changed', payload)`
    fn send_deck_changed(&mut self, wc_id: i64, payload: &JsonValue);
    /// `Date.now()`
    fn now_ms(&mut self) -> f64;
    /// `setTimeout(callback, ms)`: the timer's number, given back to
    /// [`SlidesBridge::on_timeout`] when it fires
    fn set_timeout(&mut self, ms: f64) -> u64;
    /// the promise numbered `op` settles
    fn settle(&mut self, op: u64, outcome: Settled);
    /// `await deps.openBlankTab()`: open a fresh blank slides tab; its
    /// webContents id, or the message it rejects with
    fn open_blank_tab(&mut self) -> Result<i64, String>;
    /// `deps.abandonBlankTab?.(wcId)`: close a blank tab whose session never
    /// became ready, so a failed create_session leaves no orphan
    fn abandon_blank_tab(&mut self, wc_id: i64);
    /// `existsSync(path)`
    fn exists_sync(&mut self, path: &str) -> bool;

    /// `sessions.get(wcId) !== undefined`
    fn has_session(&mut self, wc_id: i64) -> bool;
    /// `session.opened.deck`
    fn deck(&mut self, wc_id: i64) -> JsonValue;
    /// `attachedIds(session)`
    fn attached_ids(&mut self, wc_id: i64) -> Vec<i64>;
    /// `applySessionTxn(session, req)`: the result (`applied`, `failures`,
    /// `slides` ..), or `None` when the session is gone
    fn apply_session_txn(&mut self, wc_id: i64, req: &SlidesTxnRequest) -> Option<JsonValue>;
    /// `await saveSessionDeckTo(session, targetPath)`
    fn save_session_deck_to(&mut self, wc_id: i64, path: &str) -> Result<(), String>;

    /// `elementDurableId(el)`; `None` is `null`
    fn element_durable_id(&mut self, element: &JsonValue) -> Option<String>;
    /// `slideDurableId(slide)`
    fn slide_durable_id(&mut self, slide: &JsonValue) -> String;
    /// `getSlideComments(session.opened.archive, slidePath)`
    fn slide_comments(&mut self, wc_id: i64, slide_path: &str) -> Vec<JsonValue>;
    /// `getSlideHidden(slide)`
    fn slide_hidden(&mut self, slide: &JsonValue) -> bool;
}

/// a `waitSession` that is waiting for its next poll
struct SessionWait {
    op: u64,
    wc_id: i64,
    deadline: f64,
    timer: u64,
}

/// the state of `slides-bridge.ts`: only the polls in flight (the sessions
/// are the slides main process's)
pub struct SlidesBridge<H: SlidesBridgeHost> {
    host: H,
    waits: Vec<SessionWait>,
    next_op: u64,
}

const NO_SESSION: &str =
    "the deck session is gone \u{2014} its tab was closed; call create_session again";

/// how a readout treats withheld words. The outside MCP surface reads them as
/// they are (its output is a published contract, decision 0016); an agent
/// session reads each withheld run, and every word of a withheld element, as
/// its `{{label}}` (decision 0032).
#[derive(Debug, Clone, Copy)]
struct ReadOptions {
    withhold: bool,
}

/// `value.key`, `None` being `undefined`
fn field(value: &JsonValue, key: &str) -> Option<JsonValue> {
    value.get(key).map(|found| found.into_owned())
}

/// `Boolean(value.key)`
fn truthy_field(value: &JsonValue, key: &str) -> bool {
    value.get(key).is_some_and(|found| found.truthy())
}

/// `typeof value.key === 'string'`
fn string_field(value: &JsonValue, key: &str) -> Option<String> {
    match value.get(key).as_deref() {
        Some(JsonValue::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `list ?? []` of an array
fn list_field(value: &JsonValue, key: &str) -> Vec<JsonValue> {
    match value.get(key).as_deref() {
        Some(JsonValue::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// `clip(text, max)`
fn clip(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() > MAX_TEXT_CHARS {
        format!(
            "{}\u{2026}",
            String::from_utf16_lossy(&units[..MAX_TEXT_CHARS])
        )
    } else {
        text.to_owned()
    }
}

/// `text.length`
fn length16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `paragraphsText(paragraphs, options, separator)`
fn paragraphs_text(paragraphs: &[JsonValue], options: ReadOptions, separator: &str) -> String {
    paragraphs
        .iter()
        .map(|paragraph| {
            list_field(paragraph, "runs")
                .iter()
                .map(|run| match string_field(run, "redact") {
                    Some(label) if options.withhold && !label.is_empty() => {
                        placeholder_source(&label)
                    }
                    _ => string_field(run, "text").unwrap_or_default(),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(separator)
}

/// `el.text?.paragraphs ?? []`
fn text_paragraphs(el: &JsonValue) -> Vec<JsonValue> {
    match field(el, "text") {
        Some(text) => list_field(&text, "paragraphs"),
        None => Vec::new(),
    }
}

/// `runsWithhold(paragraphs)`
fn runs_withhold(paragraphs: &[JsonValue]) -> bool {
    paragraphs.iter().any(|paragraph| {
        list_field(paragraph, "runs")
            .iter()
            .any(|run| truthy_field(run, "redact"))
    })
}

/// `elementWithholds(el)`: the element itself, or any run in it, carries a
/// withholding mark
pub fn element_withholds(el: &JsonValue) -> bool {
    if truthy_field(el, "redact") {
        return true;
    }
    match string_field(el, "type").as_deref() {
        Some("text") | Some("shape") => runs_withhold(&text_paragraphs(el)),
        Some("table") => list_field(el, "rows").iter().any(|row| match row {
            JsonValue::Array(cells) => cells
                .iter()
                .any(|cell| runs_withhold(&text_paragraphs(cell))),
            _ => false,
        }),
        Some("group") => list_field(el, "children").iter().any(element_withholds),
        _ => false,
    }
}

/// `el.redact` as a label, for `placeholderSource(el.redact)`
fn redact_label(el: &JsonValue) -> Option<String> {
    match field(el, "redact") {
        Some(JsonValue::String(label)) if !label.is_empty() => Some(label),
        _ => None,
    }
}

impl<H: SlidesBridgeHost> SlidesBridge<H> {
    pub fn new(host: H) -> Self {
        SlidesBridge {
            host,
            waits: Vec::new(),
            next_op: 0,
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    /// `requireSession(wcId)`
    fn require_session(&mut self, wc_id: i64) -> Result<(), String> {
        if self.host.has_session(wc_id) {
            Ok(())
        } else {
            Err(NO_SESSION.to_owned())
        }
    }

    /// `elementInfo(el, options)`: compact model readout for the agent: ids,
    /// geometry (EMU) and text per element.
    ///
    /// Group children carry the group's child coordinate system, not
    /// document-space EMU, so their box is reported as `local` (with the
    /// parent's own box alongside) instead of being passed off as an absolute
    /// position.
    fn element_info(&mut self, el: &JsonValue, options: ReadOptions) -> JsonValue {
        // `el.transform?.offset ?? { x: 0, y: 0, cx: 0, cy: 0 }`
        let offset = field(el, "transform")
            .and_then(|transform| field(&transform, "offset"))
            .filter(|offset| !matches!(offset, JsonValue::Null));
        let coordinate = |key: &str| match &offset {
            Some(offset) => field(offset, key),
            None => Some(JsonValue::Number(0.0)),
        };
        let kind = string_field(el, "type");
        // `elementDurableId(el) ?? el.id`
        let id = match self.host.element_durable_id(el) {
            Some(id) => Some(JsonValue::String(id)),
            None => field(el, "id"),
        };
        let mut info = JsObject::new();
        if let Some(id) = id {
            info.set("id", id);
        }
        if let Some(kind) = field(el, "type") {
            info.set("type", kind);
        }
        for (key, source) in [("x", "x"), ("y", "y"), ("w", "cx"), ("h", "cy")] {
            if let Some(value) = coordinate(source) {
                info.set(key, value);
            }
        }
        match kind.as_deref() {
            Some("text") | Some("shape") => {
                let paragraphs = text_paragraphs(el);
                if !paragraphs.is_empty() {
                    let full = match redact_label(el) {
                        Some(label) if options.withhold => placeholder_source(&label),
                        _ => paragraphs_text(&paragraphs, options, "\n"),
                    };
                    info.set("text", JsonValue::String(clip(&full)));
                    if length16(&full) > MAX_TEXT_CHARS {
                        info.set("textTruncated", JsonValue::Bool(true));
                    }
                }
            }
            Some("table") => {
                let rows = list_field(el, "rows");
                let total_rows = rows.len();
                let body = rows
                    .iter()
                    .take(MAX_TABLE_ROWS)
                    .map(|row| match row {
                        JsonValue::Array(cells) => cells
                            .iter()
                            .map(|cell| paragraphs_text(&text_paragraphs(cell), options, ""))
                            .collect::<Vec<_>>()
                            .join(" | "),
                        _ => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let shown = match redact_label(el) {
                    Some(label) if options.withhold => placeholder_source(&label),
                    _ => body,
                };
                info.set("text", JsonValue::String(clip(&shown)));
                if total_rows > MAX_TABLE_ROWS {
                    info.set("textTruncated", JsonValue::Bool(true));
                    info.set("rows", JsonValue::Number(total_rows as f64));
                }
            }
            Some("group") => {
                // children are in the group's local frame: say so rather than implying
                // document-space coordinates
                let children = list_field(el, "children")
                    .iter()
                    .map(|child| {
                        let mut child_info = self.element_info(child, options);
                        if let JsonValue::Object(object) = &mut child_info {
                            object.set(
                                "coordinates",
                                JsonValue::String("local-to-group".to_owned()),
                            );
                        }
                        child_info
                    })
                    .collect();
                info.set("children", JsonValue::Array(children));
            }
            _ => {}
        }
        JsonValue::Object(info)
    }

    /// `readDeckModel(session, options)`
    fn read_deck_model(&mut self, wc_id: i64, options: ReadOptions) -> JsonValue {
        let deck = self.host.deck(wc_id);
        let size = field(&deck, "size");
        let dimension = |key: &str| {
            let value = size.as_ref().and_then(|size| field(size, key));
            match value {
                Some(JsonValue::Number(value)) => value,
                _ => f64::NAN,
            }
        };
        let mut slides = Vec::new();
        for (index, slide) in list_field(&deck, "slides").iter().enumerate() {
            let path = string_field(slide, "path").unwrap_or_default();
            let comments = self.host.slide_comments(wc_id, &path);
            let mut out = JsObject::new();
            out.set("index", JsonValue::Number(index as f64));
            let id = self.host.slide_durable_id(slide);
            out.set("id", JsonValue::String(id));
            if self.host.slide_hidden(slide) {
                out.set("hidden", JsonValue::Bool(true));
            }
            let elements = list_field(slide, "elements")
                .iter()
                .map(|el| self.element_info(el, options))
                .collect();
            out.set("elements", JsonValue::Array(elements));
            // comments are never withheld: they are metadata, not slide content
            if !comments.is_empty() {
                let rows = comments
                    .iter()
                    .map(|c| {
                        let mut row = JsObject::new();
                        if let Some(value) = field(c, "authorId") {
                            row.set("authorId", value);
                        }
                        if let Some(value) = field(c, "idx") {
                            row.set("idx", value);
                        }
                        let author = match field(c, "author") {
                            Some(JsonValue::String(author))
                                if !jscompat::trim(&author).is_empty() =>
                            {
                                JsonValue::String(author)
                            }
                            _ => JsonValue::String("Unknown author".to_owned()),
                        };
                        row.set("author", author);
                        if let Some(value) = field(c, "dt") {
                            row.set("dt", value);
                        }
                        if let Some(value) = field(c, "text") {
                            row.set("text", value);
                        }
                        JsonValue::Object(row)
                    })
                    .collect();
                out.set("comments", JsonValue::Array(rows));
            }
            slides.push(JsonValue::Object(out));
        }
        let mut model = JsObject::new();
        model.set("emuPerPx", JsonValue::Number(EMU_PER_PX_96));
        model.set(
            "note",
            JsonValue::String(
                "x/y/w/h are EMU in slide space; elements inside a group use the group-local frame (marked coordinates:\"local-to-group\")."
                    .to_owned(),
            ),
        );
        let mut slide_size = JsObject::new();
        slide_size.set(
            "widthPx",
            JsonValue::Number(js_round(dimension("cx") / EMU_PER_PX_96)),
        );
        slide_size.set(
            "heightPx",
            JsonValue::Number(js_round(dimension("cy") / EMU_PER_PX_96)),
        );
        model.set("slideSize", JsonValue::Object(slide_size));
        model.set("slides", JsonValue::Array(slides));
        JsonValue::Object(model)
    }

    fn new_op(&mut self) -> u64 {
        let op = self.next_op;
        self.next_op += 1;
        op
    }

    /// one pass of the `waitSession` loop: the session exists, the tab is
    /// gone, the deadline passed, or it sleeps 100 ms. `Ok` is the end of the
    /// wait.
    fn poll(&mut self, wc_id: i64, deadline: f64) -> Option<Result<(), String>> {
        if self.host.has_session(wc_id) {
            return Some(Ok(()));
        }
        if !self.host.web_contents_alive(wc_id) {
            return Some(Err(
                "the presentation tab was closed before it became ready".to_owned(),
            ));
        }
        if self.host.now_ms() > deadline {
            return Some(Err(format!(
                "the presentation did not become ready within {READY_TIMEOUT_MS}ms"
            )));
        }
        None
    }

    /// the wait ended: `openBlankTab` abandons its tab on a failure
    fn finish_wait(&mut self, wc_id: i64, ended: Result<(), String>) -> Settled {
        match ended {
            Ok(()) => Ok(Some(JsonValue::Number(wc_id as f64))),
            Err(message) => {
                self.host.abandon_blank_tab(wc_id);
                Err(message)
            }
        }
    }

    /// `openBlankTab()` of the control: open a fresh blank slides tab and wait
    /// for the session the renderer's boot pull creates. Resolves with the
    /// tab's id (a number); a failed wait closes the tab first.
    pub fn open_blank_tab(&mut self) -> Submitted {
        let wc_id = match self.host.open_blank_tab() {
            Ok(wc_id) => wc_id,
            Err(message) => return Submitted::Rejected(message),
        };
        let deadline = self.host.now_ms() + READY_TIMEOUT_MS;
        let op = self.new_op();
        match self.poll(wc_id, deadline) {
            Some(ended) => match self.finish_wait(wc_id, ended) {
                Ok(value) => Submitted::Resolved(value),
                Err(message) => Submitted::Rejected(message),
            },
            None => {
                let timer = self.host.set_timeout(POLL_MS);
                self.waits.push(SessionWait {
                    op,
                    wc_id,
                    deadline,
                    timer,
                });
                Submitted::Pending(op)
            }
        }
    }

    /// the timer `timer` fires: the next pass of a `waitSession` loop
    pub fn on_timeout(&mut self, timer: u64) {
        let Some(at) = self.waits.iter().position(|wait| wait.timer == timer) else {
            return;
        };
        let wait = self.waits.remove(at);
        match self.poll(wait.wc_id, wait.deadline) {
            Some(ended) => {
                let outcome = self.finish_wait(wait.wc_id, ended);
                self.host.settle(wait.op, outcome);
            }
            None => {
                let timer = self.host.set_timeout(POLL_MS);
                self.waits.push(SessionWait { timer, ..wait });
            }
        }
    }

    /// `runTxn(wcId, req)` of the control: apply one transaction to the tab's
    /// session; the outcome without the render tree
    pub fn run_txn(
        &mut self,
        wc_id: i64,
        req: &SlidesTxnRequest,
    ) -> Result<Option<JsonValue>, String> {
        self.require_session(wc_id)?;
        let Some(result) = self.host.apply_session_txn(wc_id, req) else {
            return Err("the deck session is gone \u{2014} call create_session again".to_owned());
        };
        // The ordinary `slides:apply-txn` path has an originating renderer that
        // applies its own IPC return value; MCP runs in the main process, so the
        // tab would never hear about the change: scheduleDeckBroadcast no-ops
        // for single-window sessions. Push the fresh render to the tab ourselves
        // (multi-window sessions already get the scheduled broadcast).
        if truthy_field(&result, "applied") && truthy_field(&result, "slides") {
            let ids = self.host.attached_ids(wc_id);
            if ids.len() < 2 {
                let deck = self.host.deck(wc_id);
                let size = field(&deck, "size");
                let dimension = |key: &str| {
                    size.as_ref()
                        .and_then(|size| field(size, key))
                        .unwrap_or(JsonValue::Number(f64::NAN))
                };
                let mut size_out = JsObject::new();
                size_out.set("cx", dimension("cx"));
                size_out.set("cy", dimension("cy"));
                let mut payload = JsObject::new();
                payload.set(
                    "slides",
                    field(&result, "slides").unwrap_or(JsonValue::Null),
                );
                payload.set("size", JsonValue::Object(size_out));
                let payload = JsonValue::Object(payload);
                for id in ids {
                    self.host.send_deck_changed(id, &payload);
                }
            }
        }
        // The render tree was only needed for the canvas push above: it carries
        // base64 dataUrls for pictures and fills, so echoing it in the tool result
        // would put the whole deck (and its images) into the agent's context on
        // every op. The agent sees the transaction outcome; read_deck is the model
        // readout.
        let summary = match result {
            JsonValue::Object(object) => JsonValue::Object(
                object
                    .entries()
                    .into_iter()
                    .filter(|(key, _)| *key != "slides")
                    .map(|(key, value)| (key.to_owned(), value.clone()))
                    .collect(),
            ),
            other => other,
        };
        Ok(Some(summary))
    }

    /// `readDeck(wcId, options)` of the control
    pub fn read_deck(
        &mut self,
        wc_id: i64,
        options: Option<&ReadDeckOptions>,
    ) -> Result<Option<JsonValue>, String> {
        self.require_session(wc_id)?;
        let withhold = options.and_then(|options| options.withhold) == Some(true);
        Ok(Some(self.read_deck_model(wc_id, ReadOptions { withhold })))
    }

    /// `deckWithholds(wcId)` of the control: the deck carries any withholding mark
    pub fn deck_withholds(&mut self, wc_id: i64) -> Result<bool, String> {
        self.require_session(wc_id)?;
        let deck = self.host.deck(wc_id);
        Ok(list_field(&deck, "slides")
            .iter()
            .any(|slide| list_field(slide, "elements").iter().any(element_withholds)))
    }

    /// `saveDeck(wcId, filePath, overwrite)` of the control: the path written
    pub fn save_deck(
        &mut self,
        wc_id: i64,
        file_path: &str,
        overwrite: bool,
    ) -> Result<String, String> {
        if !is_absolute(file_path) {
            return Err("path must be absolute".to_owned());
        }
        let ext = extname(file_path).to_lowercase();
        let target_path = if ext.is_empty() {
            format!("{file_path}.pptx")
        } else if ext == ".pptx" {
            file_path.to_owned()
        } else {
            return Err("path must point to a .pptx file".to_owned());
        };
        if self.host.exists_sync(&target_path) && !overwrite {
            return Err(format!(
                "file already exists: {target_path} (pass overwrite:true to replace it)"
            ));
        }
        self.require_session(wc_id)?;
        self.host.save_session_deck_to(wc_id, &target_path)?;
        Ok(target_path)
    }
}

/// `Math.round(x)`
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}
