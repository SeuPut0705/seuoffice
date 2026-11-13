//! `slides:land-generated-pages`: the pages `slides:local-page-generate`
//! issued land in the open deck (append, replace_at, insert_at) or become
//! the new deck (replace).

use jscompat::JsonValue;
use main_core::slides::session_state::{OpSource, Session};
use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue};

use super::engine::TxnRequest;
use super::lifecycle::sanitize_draft_base_name;
use super::session::{Obj, op};
use super::state::{App, DeckHandle, SlideSession};
use crate::value::{Args, as_bool, as_num, num, obj, string, truthy};

type Reply = Result<IpcValue, IpcError>;

fn error(message: impl Into<String>) -> IpcValue {
    obj([("error", string(message))])
}

fn is_integer(value: &IpcValue) -> Option<f64> {
    as_num(value).filter(|x| x.is_finite() && x.fract() == 0.0)
}

impl App {
    /// `nameGeneratedDeck(session, deckName)`: an AI-generated deck is not
    /// written anywhere on its own; its generated name is what the first save
    /// offers
    fn name_generated_deck(&self, s: &mut SlideSession, deck_name: &IpcValue) {
        s.core.mark_meta_dirty();
        if !s.path().is_empty() {
            return;
        }
        let base = sanitize_draft_base_name(crate::value::as_str(deck_name));
        if let Some(base) = base
            && s.first_save_name.as_deref().is_none_or(str::is_empty)
        {
            s.first_save_name = Some(format!("{base}.pptx"));
        }
        s.ask_path_on_first_save = true;
    }

    fn landed(&self, s: &SlideSession) -> Obj {
        // path, slides, size, defaultFont
        match self.open_result(s, self.render_all(s)) {
            IpcValue::Object(entries) => {
                let mut o = Obj::new();
                for (k, v) in entries {
                    o = o.set(&k, v);
                }
                o
            }
            _ => Obj::new(),
        }
    }
}

pub fn land_generated_pages(app: &App, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    let markers = args.get(0).clone();
    let fit = as_num(args.get(1)).unwrap_or(f64::NAN);
    let mode = args.str(2).map(str::to_owned);
    let at_index = args.get(3).clone();
    let deck_name = args.get(4).clone();
    // a panel that began a reviewed run says so: without that run the pages
    // would land in an unlocked deck as an unreviewed AI edit
    let land_run = app
        .state
        .borrow()
        .session(view)
        .is_some_and(|s| s.core.ai_run);
    let expected = as_bool(args.get(5)).unwrap_or_else(|| truthy(args.get(5)));
    if expected && !land_run {
        return Ok(error(
            "the AI run ended before the generated pages could land",
        ));
    }
    let reply = match land(
        app,
        view,
        &markers,
        fit,
        mode.as_deref(),
        &at_index,
        &deck_name,
    ) {
        Ok(value) => value,
        Err(message) => error(message),
    };
    Ok(reply)
}

fn land(
    app: &App,
    view: shell_contract::ViewId,
    markers: &IpcValue,
    fit: f64,
    mode: Option<&str>,
    at_index: &IpcValue,
    deck_name: &IpcValue,
) -> Result<IpcValue, String> {
    let message = |e: IpcError| e.message;
    match mode {
        Some("append") => {
            if !app.state.borrow().has_session(view) {
                return Ok(error(app.tm("errNoDeckAppend", &[])));
            }
            let before_count = {
                let state = app.state.borrow();
                app.engine
                    .slide_paths(state.session(view).expect("checked").deck())
                    .len()
            };
            // Extract every page first (pure reads), then land them as
            // insertSlidePptx ops
            let mut sources = Vec::new();
            let mut last_err: Option<String> = None;
            for marker in app.page_marker_list(markers) {
                let one = app
                    .read_one_cloud_page(marker)
                    .map_err(message)
                    .and_then(|bytes| app.engine.extract_merge_source(&bytes).map_err(|e| e.0));
                match one {
                    Ok(Some(source)) => sources.push(source),
                    Ok(None) => last_err = Some(app.tm("errMergeFailed", &[])),
                    Err(text) => last_err = Some(text),
                }
            }
            let mut state = app.state.borrow_mut();
            let existing = state.session_mut(view).expect("checked");
            let mut merged = 0;
            if !sources.is_empty() {
                let request = TxnRequest::per_op(
                    sources
                        .into_iter()
                        .map(|source| op("insertSlidePptx").set("source", source).build())
                        .collect(),
                );
                existing.core.push_history();
                let result = app.journaled_txn(existing, OpSource::Generate, &request);
                merged = result.records.as_ref().map_or(0, Vec::len);
                if merged == 0 {
                    // nothing happened, pop the just-pushed snapshot
                    existing.core.undo_stack.pop();
                }
                if last_err.is_none() {
                    last_err = result
                        .failures
                        .and_then(|f| f.first().map(|x| x.error.clone()));
                }
            }
            if merged == 0 {
                let reason = last_err.unwrap_or_else(|| app.tm("errUnknown", &[]));
                return Ok(error(
                    app.tm("errAppendFailed", &[("reason", JsonValue::String(reason))]),
                ));
            }
            existing.fit_width_px = fit;
            app.name_generated_deck(existing, deck_name);
            let page_count = app.page_marker_list(markers).len();
            let mut result = app
                .landed(existing)
                .set("appendedFrom", num(before_count as f64));
            if let Some(reason) = last_err.filter(|_| merged < page_count) {
                result = result.set(
                    "fallbackReason",
                    string(app.tm("errPartialAppend", &[("reason", JsonValue::String(reason))])),
                );
            }
            Ok(result.build())
        }
        Some(mode @ ("replace_at" | "insert_at")) => {
            let replace = mode == "replace_at";
            if !app.state.borrow().has_session(view) {
                let key = if replace {
                    "errNoDeckReplace"
                } else {
                    "errNoDeckInsert"
                };
                return Ok(error(app.tm(key, &[])));
            }
            let total = {
                let state = app.state.borrow();
                app.engine
                    .slide_paths(state.session(view).expect("checked").deck())
                    .len() as f64
            };
            let limit = if replace { total - 1.0 } else { total };
            let index = match is_integer(at_index) {
                Some(i) if i >= 0.0 && i <= limit => i,
                _ => {
                    return Ok(error(
                        app.tm("errIndexRange", &[("max", JsonValue::Number(limit))]),
                    ));
                }
            };
            let list = app.page_marker_list(markers);
            let first = list.first().filter(|m| truthy(m));
            let Some(marker) = first.filter(|_| list.len() == 1) else {
                let key = if replace {
                    "errReplaceNeedsOne"
                } else {
                    "errInsertNeedsOne"
                };
                return Ok(error(app.tm(key, &[])));
            };
            let bytes = app.read_one_cloud_page(marker).map_err(message)?;
            let source = app.engine.extract_merge_source(&bytes).map_err(|e| e.0)?;
            let Some(source) = source else {
                return Ok(error(app.tm("errMergeFailed", &[])));
            };
            let mut state = app.state.borrow_mut();
            let existing = state.session_mut(view).expect("checked");
            let mut insert = op("insertSlidePptx")
                .set("source", source)
                .set("at", num(index));
            if replace {
                insert = insert.set("replace", IpcValue::Bool(true));
            }
            let request = TxnRequest::atomic(vec![insert.build()]);
            existing.core.push_history();
            let result = app.journaled_txn(existing, OpSource::Generate, &request);
            if !result.applied {
                // the executor already restored the deck
                existing.core.undo_stack.pop();
                let key = if replace {
                    "errReplaceFailed"
                } else {
                    "errInsertFailed"
                };
                return Ok(error(
                    result
                        .failures
                        .and_then(|f| f.first().map(|x| x.error.clone()))
                        .unwrap_or_else(|| app.tm(key, &[])),
                ));
            }
            existing.fit_width_px = fit;
            app.name_generated_deck(existing, deck_name);
            let key = if replace {
                "replacedIndex"
            } else {
                "insertedIndex"
            };
            Ok(app.landed(existing).set(key, num(index)).build())
        }
        _ => {
            // replace mode: assemble the whole batch into one multi-page pptx
            // as the new deck base
            let pages = app.read_cloud_pages(markers).map_err(message)?;
            if pages.is_empty() {
                return Err("Cannot read properties of undefined (reading 'bytes')".into());
            }
            let bytes = app.engine.assemble_pages(&pages).map_err(|e| e.0)?;
            let deck = app.engine.open(&bytes).map_err(|e| e.0)?;
            let mut replacement =
                SlideSession::new("", DeckHandle::new(deck, app.engine.clone()), fit);
            let mut state = app.state.borrow_mut();
            let old_slot = state.slot_of(view);
            let old_path = state.session(view).map(|s| s.path().to_owned());
            if let Some(old) = state.session_mut(view) {
                Session::carry_history_for_replacement(Some(&mut old.core), &mut replacement.core);
                // the same tab's document: an untitled deck keeps its recovery slot
                if old.path().is_empty() {
                    replacement.recovery_id = old.recovery_id.clone();
                }
            }
            app.shell
                .inherit_template_selection(view, old_path.as_deref());
            let new_slot = state.set_session(view, replacement);
            // re-point windows that shared the old session
            if let Some(old_slot) = old_slot {
                state.repoint(old_slot, new_slot);
            }
            let session = state.slot_mut(new_slot).expect("just set");
            app.name_generated_deck(session, deck_name);
            session.core.schedule_deck_broadcast();
            Ok(app.landed(session).build())
        }
    }
}
