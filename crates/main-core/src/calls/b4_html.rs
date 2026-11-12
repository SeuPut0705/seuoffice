//! The functions of group `b4-html` (tools/main-diff/groups/b4-html.ts): the
//! modules of `apps/html/src/main` and `apps/epub/src/main` that hold no
//! Electron object, and the pieces of `packages/pdf-structure` the EPUB
//! store handlers call.
//!
//! Names are `<ts-file>.<export>`; a file whose name more than one app has
//! (`asset-lifecycle`, `atomic-write`, `generate-handoff-ipc`, `old-names`) is
//! `<app>/<ts-file>`, and the pdf-structure pieces are
//! `pdf-structure/<ts-file>.<export>`. Bytes are hex strings. What the
//! TypeScript takes as an object with methods or a callback is a fake the spec
//! describes; each of its calls is one `logs` line, and the TypeScript writes
//! the same lines. The reading state, the store handlers and the hand-off
//! registration are driven as scenarios, one answer per step.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsMap, js_regex, json_value_from_serde, number_to_string};
use serde_json::{Map, Value};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::epub::atomic_write::atomic_write_file as epub_atomic_write_file;
use crate::epub::reading_state::{
    EPUB_VIEW_PREFS_DEFAULT, MAX_POSITIONS, READING_STATE_FILE, ReadingState, ReadingStateDeps,
    ViewPrefs, read_position_of, view_prefs_of,
};
use crate::epub::result_paths::{ResultPathContext, check_result_path, path_key, same_path};
use crate::epub::store_handlers::{
    self, EpubStore, EpubStoreHandlerDeps, StoreError, StoredTranslation,
};
use crate::html::asset_lifecycle::{
    self as lifecycle, ASSET_MANIFEST_FILENAME, PreparedSaveAsAssets,
};
use crate::html::asset_mime::{
    ASSET_SNIFF_BYTES, PREVIEW_ASSET_EXTS, editable_image_mime, extensionless_asset_mime,
    slot_from_accept, sniff_binary_asset_mime,
};
use crate::html::atomic_write::atomic_write_file as html_atomic_write_file;
use crate::html::generate_handoff_ipc::{
    HandoffEvent, HandoffHandler, HandoffIpc, register_html_handoff_ipc,
};
use crate::html::old_names::OLD_ASSET_MANIFEST_FILENAMES;
use crate::html::preview_document::{
    ASSET_SCHEME, PREVIEW_SCHEME, asset_base_href, build_preview_document, preview_url_for,
};
use crate::html::single_file_html::{inline_images_for_single_file, single_file_export_base_name};
use crate::node_fs::{NodeError, node_error};
use crate::packages::electron_utils::generate_handoff::{GenerateHandoff, HandoffStore};
use crate::packages::pdf_structure::{
    StoreWriteError, TranslationMode, is_translation_mode, job_key_of,
};

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let answer = call_named(name, args, cx)?;
    // a temp file's random name shows in the messages of the asset list's writes
    Some(if MASKED.contains(&name) {
        mask_answer(answer)
    } else {
        answer
    })
}

/// the functions whose TypeScript spec writes a temp file's name as `<hex>`
const MASKED: [&str; 8] = [
    "html/asset-lifecycle.copyImageIntoOwnedAssets",
    "html/asset-lifecycle.writeImageIntoOwnedAssets",
    "html/asset-lifecycle.prepareAssetsForSaveAs",
    "html/asset-lifecycle.rollbackPreparedSaveAsAssets",
    "html/asset-lifecycle.discardPendingOwnedAssets",
    "html/asset-lifecycle.resolveSourcePendingAfterSaveAs",
    "html/asset-lifecycle.reconcileOwnedAssets",
    "html/asset-lifecycle.renameOwnedAssetDocument",
];

/// the answer with every temp file name written `<hex>`
fn mask_answer(answer: Answer) -> Answer {
    match answer {
        Ok(value) => Ok(value.map(mask_value)),
        Err(mut error) => {
            error.message = mask_tmp(&error.message);
            Err(error)
        }
    }
}

fn mask_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(mask_tmp(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(mask_value).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, mask_value(v))).collect())
        }
        other => other,
    }
}

fn call_named(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- html: asset-lifecycle ----
        "html/asset-lifecycle.ASSET_MANIFEST_FILENAME" => {
            Ok(Some(Value::from(ASSET_MANIFEST_FILENAME)))
        }
        "html/asset-lifecycle.isInDocDir" => is_in_doc_dir_call(args),
        "html/asset-lifecycle.extractHtmlImageSources" => str_arg(args, 0).and_then(|text| {
            lifecycle::extract_html_image_sources(text)
                .map(|sources| Some(strings(sources)))
                .map_err(limit)
        }),
        "html/asset-lifecycle.extractDocumentImageSources" => str_arg(args, 0)
            .map(|text| Some(strings(lifecycle::extract_document_image_sources(text)))),
        "html/asset-lifecycle.scanCssUrls" => {
            str_arg(args, 0).map(|text| Some(to_value(&lifecycle::scan_css_urls(text))))
        }
        "html/asset-lifecycle.extractHtmlAssetReferences" => str_arg(args, 0).and_then(|text| {
            lifecycle::extract_html_asset_references(text)
                .map(|sources| Some(strings(sources)))
                .map_err(limit)
        }),
        "html/asset-lifecycle.rewriteHtmlImageSources" => (|| {
            let text = str_arg(args, 0)?;
            let rewrites = pairs_arg(args, 1)?;
            lifecycle::rewrite_html_image_sources(text, &rewrites)
                .map(|text| Some(Value::from(text)))
                .map_err(limit)
        })(),
        "html/asset-lifecycle.rewriteDocumentImageSources" => (|| {
            let text = str_arg(args, 0)?;
            let rewrites = pairs_arg(args, 1)?;
            Ok(Some(Value::from(
                lifecycle::rewrite_document_image_sources(text, &rewrites),
            )))
        })(),
        "html/asset-lifecycle.resolveSafeRelativeImagePath" => (|| {
            let document = str_arg(args, 0)?;
            let source = str_arg(args, 1)?;
            Ok(Some(
                lifecycle::resolve_safe_relative_image_path(document, source)
                    .map_or(Value::Null, Value::from),
            ))
        })(),
        "html/asset-lifecycle.copyImageIntoOwnedAssets" => (|| {
            let document = str_arg(args, 0)?;
            let source = str_arg(args, 1)?;
            Ok(Some(Value::from(lifecycle::copy_image_into_owned_assets(
                document, source,
            )?)))
        })(),
        "html/asset-lifecycle.writeImageIntoOwnedAssets" => (|| {
            let document = str_arg(args, 0)?;
            let preferred = str_arg(args, 1)?;
            let bytes = hex_arg(args, 2)?;
            Ok(Some(Value::from(lifecycle::write_image_into_owned_assets(
                document, preferred, &bytes,
            )?)))
        })(),
        "html/asset-lifecycle.prepareAssetsForSaveAs" => (|| {
            let source = str_arg(args, 0)?;
            let target = str_arg(args, 1)?;
            let text = str_arg(args, 2)?;
            let sources = string_list(args, 3)?;
            let plan = lifecycle::prepare_assets_for_save_as(source, target, text, &sources)?;
            Ok(Some(to_value(&plan)))
        })(),
        "html/asset-lifecycle.rollbackPreparedSaveAsAssets" => (|| {
            let plan: PreparedSaveAsAssets =
                serde_json::from_value(arg(args, 0).cloned().unwrap_or(Value::Null))
                    .map_err(|_| bad("a plan"))?;
            lifecycle::rollback_prepared_save_as_assets(&plan)?;
            Ok(None)
        })(),
        "html/asset-lifecycle.pendingOwnedAssetsForDocument" => str_arg(args, 0).map(|document| {
            Some(strings(lifecycle::pending_owned_assets_for_document(
                document,
            )))
        }),
        "html/asset-lifecycle.discardPendingOwnedAssets" => str_arg(args, 0)
            .map(|document| Some(to_value(&lifecycle::discard_pending_owned_assets(document)))),
        "html/asset-lifecycle.resolveSourcePendingAfterSaveAs" => (|| {
            let source = str_arg(args, 0)?;
            let pending = string_list(args, 1)?;
            Ok(Some(to_value(
                &lifecycle::resolve_source_pending_after_save_as(source, &pending),
            )))
        })(),
        "html/asset-lifecycle.reconcileOwnedAssets" => (|| {
            let document = str_arg(args, 0)?;
            let sources = string_list(args, 1)?;
            let pending = match arg(args, 2) {
                None | Some(Value::Null) => None,
                Some(_) => Some(string_list(args, 2)?),
            };
            Ok(Some(to_value(&lifecycle::reconcile_owned_assets(
                document,
                &sources,
                pending.as_deref(),
            ))))
        })(),
        "html/asset-lifecycle.renameOwnedAssetDocument" => (|| {
            let old = str_arg(args, 0)?;
            let new = str_arg(args, 1)?;
            lifecycle::rename_owned_asset_document(old, new)?;
            Ok(None)
        })(),
        "html/asset-lifecycle.readOwnedAssetManifest" => str_arg(args, 0).map(|document| {
            Some(
                lifecycle::read_owned_asset_manifest(document)
                    .map_or(Value::Null, |manifest| manifest.to_json()),
            )
        }),

        // ---- html: asset-mime ----
        "asset-mime.PREVIEW_ASSET_EXTS" => Ok(Some(strings(
            PREVIEW_ASSET_EXTS
                .iter()
                .map(|ext| (*ext).to_owned())
                .collect(),
        ))),
        "asset-mime.ASSET_SNIFF_BYTES" => Ok(Some(Value::from(ASSET_SNIFF_BYTES as u64))),
        "asset-mime.sniffBinaryAssetMime" => {
            hex_arg(args, 0).map(|head| Some(sniffed(sniff_binary_asset_mime(&head))))
        }
        "asset-mime.slotFromAccept" => Ok(Some(Value::from(
            slot_from_accept(opt_str(args, 0)).as_str(),
        ))),
        "asset-mime.extensionlessAssetMime" => (|| {
            let target = str_arg(args, 0)?;
            let head = hex_arg(args, 1)?;
            Ok(Some(sniffed(extensionless_asset_mime(
                target,
                &head,
                opt_str(args, 2),
            ))))
        })(),
        "asset-mime.editableImageMime" => {
            hex_arg(args, 0).map(|head| Some(sniffed(editable_image_mime(&head))))
        }

        // ---- html: the small ones ----
        "html/atomic-write.atomicWriteFile" => atomic_write_call(args, html_atomic_write_file),
        "html/old-names.OLD_ASSET_MANIFEST_FILENAMES" => Ok(Some(strings(
            OLD_ASSET_MANIFEST_FILENAMES
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
        ))),
        "html/generate-handoff-ipc.registerHtmlHandoffIpc" => handoff_ipc_call(args, cx),
        "preview-document.PREVIEW_SCHEME" => Ok(Some(Value::from(PREVIEW_SCHEME))),
        "preview-document.ASSET_SCHEME" => Ok(Some(Value::from(ASSET_SCHEME))),
        "preview-document.assetBaseHref" => {
            str_arg(args, 0).map(|dir| Some(Value::from(asset_base_href(dir))))
        }
        "preview-document.buildPreviewDocument" => str_arg(args, 0)
            .map(|text| Some(Value::from(build_preview_document(text, opt_str(args, 1))))),
        "preview-document.previewUrlFor" => Ok(Some(Value::from(preview_url_for(
            arg(args, 0).and_then(Value::as_f64).unwrap_or(f64::NAN),
        )))),
        "single-file-html.singleFileExportBaseName" => {
            str_arg(args, 0).map(|name| Some(Value::from(single_file_export_base_name(name))))
        }
        "single-file-html.inlineImagesForSingleFile" => str_arg(args, 0).map(|text| {
            Some(to_value(&inline_images_for_single_file(
                text,
                opt_str(args, 1),
            )))
        }),

        // ---- epub ----
        "epub/atomic-write.atomicWriteFile" => atomic_write_call(args, epub_atomic_write_file),
        "reading-state.READING_STATE_FILE" => Ok(Some(Value::from(READING_STATE_FILE))),
        "reading-state.MAX_POSITIONS" => Ok(Some(Value::from(MAX_POSITIONS as u64))),
        "reading-state.viewPrefsOf" => view_prefs_of_call(args),
        "reading-state.readPositionOf" => Ok(Some(
            read_position_of(arg(args, 0).map(json_value_from_serde).as_ref())
                .map_or(Value::Null, |position| position.to_json()),
        )),
        "reading-state.createReadingState" => reading_state_call(args, cx),
        "result-paths.pathKey" => {
            str_arg(args, 0).map(|path| Some(Value::from(path_key(path, opt_bool(args, 1)))))
        }
        "result-paths.samePath" => (|| {
            let a = str_arg(args, 0)?;
            let b = str_arg(args, 1)?;
            Ok(Some(Value::Bool(same_path(a, b, opt_bool(args, 2)))))
        })(),
        "result-paths.checkResultPath" => check_result_path_call(args, cx),
        "store-handlers.createEpubStoreHandlers" => store_handlers_call(args, cx),

        // ---- packages/pdf-structure ----
        "pdf-structure/job-keys.isTranslationMode" => Ok(Some(Value::Bool(
            arg(args, 0).is_some_and(is_translation_mode),
        ))),
        "pdf-structure/job-keys.jobKeyOf" => (|| {
            let job = arg(args, 0).ok_or_else(|| bad("a job"))?;
            let kind = job
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("a kind"))?;
            let key = job_key_of(
                kind,
                job.get("lang").and_then(Value::as_str),
                job.get("runId").and_then(Value::as_str),
            );
            Ok(key.map(Value::from))
        })(),
        "pdf-structure/files.StoreWriteError" => (|| {
            let path = str_arg(args, 0)?;
            let code = arg(args, 1)
                .and_then(|cause| cause.get("code"))
                .and_then(Value::as_str);
            let error = StoreWriteError::new(path, code);
            let mut out = Map::new();
            out.insert("name".into(), Value::from(StoreWriteError::NAME));
            out.insert("message".into(), Value::from(error.message));
            out.insert("code".into(), Value::from(StoreWriteError::CODE));
            out.insert("errno".into(), Value::from(error.errno));
            out.insert("path".into(), Value::from(error.path));
            Ok(Some(Value::Object(out)))
        })(),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn limit(stop: jscompat::RegexLimit) -> CallError {
    CallError::plain(stop.to_string())
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn strings(items: Vec<String>) -> Value {
    Value::Array(items.into_iter().map(Value::String).collect())
}

fn sniffed(mime: Option<&str>) -> Value {
    mime.map_or(Value::Null, Value::from)
}

/// the argument as a string, `None` where the spec left it out (JSON `null`)
fn opt_str(args: &[Value], i: usize) -> Option<&str> {
    arg(args, i).and_then(Value::as_str)
}

fn opt_bool(args: &[Value], i: usize) -> Option<bool> {
    arg(args, i).and_then(Value::as_bool)
}

fn string_list(args: &[Value], i: usize) -> Result<Vec<String>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

fn hex_arg(args: &[Value], i: usize) -> Result<Vec<u8>, CallError> {
    let text = str_arg(args, i)?;
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return Err(bad("hex"));
    }
    (0..text.len() / 2)
        .map(|at| u8::from_str_radix(&text[2 * at..2 * at + 2], 16).map_err(|_| bad("hex")))
        .collect()
}

/// `new Map(pairs)` of `[[from, to], ...]`
fn pairs_arg(args: &[Value], i: usize) -> Result<JsMap<String>, CallError> {
    let mut map = JsMap::new();
    for pair in arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("pairs"))?
    {
        let pair = pair.as_array().ok_or_else(|| bad("a pair"))?;
        let (Some(from), Some(to)) = (
            pair.first().and_then(Value::as_str),
            pair.get(1).and_then(Value::as_str),
        ) else {
            return Err(bad("a pair of strings"));
        };
        map.set(from, to.to_owned());
    }
    Ok(map)
}

/// a temp file's random name, as it shows in an error message
fn mask_tmp(text: &str) -> String {
    js_regex!(r"\.[0-9a-f]{12}\.tmp").replace_all(text, |_| ".<hex>.tmp".to_owned())
}

fn atomic_write_call(args: &[Value], write: fn(&str, &[u8]) -> Result<(), NodeError>) -> Answer {
    let path = str_arg(args, 0)?;
    let text = str_arg(args, 1)?;
    write(path, text.as_bytes())
        .map(|()| None)
        .map_err(|mut error| {
            error.message = mask_tmp(&error.message);
            error.into()
        })
}

/// `[target, dir, separator | null]`
fn is_in_doc_dir_call(args: &[Value]) -> Answer {
    let target = str_arg(args, 0)?;
    let dir = str_arg(args, 1)?;
    let separator = opt_str(args, 2).unwrap_or(jscompat::node_path::host::SEP);
    Ok(Some(Value::Bool(lifecycle::is_in_doc_dir(
        target, dir, separator,
    ))))
}

// ---------- the hand-off registration ----------

/// `ipcMain` as the spec fakes it: it keeps the handlers by channel
struct FakeIpc {
    log: Log,
    handlers: Vec<(String, HandoffHandler)>,
}

impl HandoffIpc for FakeIpc {
    fn handle(&mut self, channel: &str, handler: HandoffHandler) {
        self.log
            .borrow_mut()
            .push(vec![Value::from("handle"), Value::from(channel)]);
        match self.handlers.iter_mut().find(|(name, _)| name == channel) {
            Some(entry) => entry.1 = handler,
            None => self.handlers.push((channel.to_owned(), handler)),
        }
    }
}

/// `[openedOnFile, queue, calls, resolver]`: `openedOnFile` the web contents
/// ids that were opened on a file; `queue` the `{ id, handoff }` the store
/// holds before the registration; `calls` the `{ channel, sender, args }` the
/// fake ipc invokes; `resolver` the tab id table `{ table, throwsFor }` or null.
fn handoff_ipc_call(args: &[Value], cx: &mut Context) -> Answer {
    let opened: Vec<f64> = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("opened ids"))?
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    let queue = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a queue"))?;
    let calls = arg(args, 2)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("calls"))?;

    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let store = Rc::new(RefCell::new(HandoffStore::new(false)));
    for entry in queue {
        let id = entry
            .get("id")
            .and_then(Value::as_f64)
            .ok_or_else(|| bad("an id"))?;
        let handoff: GenerateHandoff =
            serde_json::from_value(entry.get("handoff").cloned().unwrap_or(Value::Null))
                .map_err(|_| bad("a hand-off"))?;
        store.borrow_mut().queue_generate_handoff(id, handoff);
    }
    if let Some(resolver) = arg(args, 3).filter(|resolver| resolver.is_object()) {
        let table = resolver.get("table").cloned().unwrap_or(Value::Null);
        let throws: Vec<f64> = resolver
            .get("throwsFor")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default();
        store
            .borrow_mut()
            .set_generate_tab_id_resolver(Some(Box::new(move |id| {
                if throws.contains(&id) {
                    return Err("resolver boom".to_owned());
                }
                Ok(table
                    .get(number_to_string(id))
                    .and_then(Value::as_str)
                    .map(str::to_owned))
            })));
    }

    let mut ipc = FakeIpc {
        log: Rc::clone(&log),
        handlers: Vec::new(),
    };
    let opened_log = Rc::clone(&log);
    let now = cx.now_ms;
    register_html_handoff_ipc(
        &mut ipc,
        Rc::clone(&store),
        Box::new(move |id| {
            opened_log
                .borrow_mut()
                .push(vec![Value::from("openedOnFile"), number(id)]);
            opened.contains(&id)
        }),
        Box::new(move || now),
    );

    let mut answers = Vec::new();
    for call in calls {
        let channel = call
            .get("channel")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("a channel"))?;
        let sender = call
            .get("sender")
            .and_then(Value::as_f64)
            .ok_or_else(|| bad("a sender"))?;
        let call_args: Vec<Value> = call
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let (_, handler) = ipc
            .handlers
            .iter_mut()
            .find(|(name, _)| name == channel)
            .ok_or_else(|| bad("a registered channel"))?;
        let mut answer = Map::new();
        match handler(&HandoffEvent { sender_id: sender }, &call_args) {
            Ok(value) => {
                answer.insert("ok".into(), value);
            }
            Err(message) => {
                answer.insert("error".into(), Value::from(message));
            }
        }
        answers.push(Value::Object(answer));
    }

    cx.logs.extend(log.borrow().iter().cloned());
    let mut out = Map::new();
    out.insert(
        "channels".into(),
        strings(ipc.handlers.iter().map(|(name, _)| name.clone()).collect()),
    );
    out.insert("answers".into(), Value::Array(answers));
    out.insert(
        "runs".into(),
        to_value(&store.borrow().generate_run_started_events()),
    );
    Ok(Some(Value::Object(out)))
}

fn number(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

// ---------- the reading state ----------

/// `viewPrefsOf(v, base)`: `[v, base | null]`
fn view_prefs_of_call(args: &[Value]) -> Answer {
    let base = match arg(args, 1) {
        None | Some(Value::Null) => EPUB_VIEW_PREFS_DEFAULT,
        Some(base) => ViewPrefs {
            font_scale: base
                .get("fontScale")
                .and_then(Value::as_f64)
                .ok_or_else(|| bad("a base"))?,
            line_height: base.get("lineHeight").and_then(Value::as_f64),
            dark: base.get("dark").and_then(Value::as_bool).unwrap_or(false),
        },
    };
    let v = arg(args, 0).map(json_value_from_serde);
    Ok(Some(view_prefs_of(v.as_ref(), &base).to_json()))
}

/// the deps of the spec: the folder, a writer that may be told to fail, a clock
struct FakeReadingDeps {
    dir: String,
    log: Log,
    fail: bool,
    now: f64,
    tick: f64,
}

impl ReadingStateDeps for FakeReadingDeps {
    fn dir(&mut self) -> String {
        self.log.borrow_mut().push(vec![Value::from("dir")]);
        self.dir.clone()
    }

    fn write(&mut self, path: &str, text: &str) -> Result<(), NodeError> {
        self.log
            .borrow_mut()
            .push(vec![Value::from("write"), Value::from(path)]);
        if self.fail {
            return Err(NodeError {
                code: Some("EBOOM"),
                message: "boom".to_owned(),
            });
        }
        std::fs::write(path, text).map_err(|e| node_error(&e, "open", path))
    }

    fn now(&mut self) -> f64 {
        self.log.borrow_mut().push(vec![Value::from("now")]);
        let at = self.now + self.tick;
        self.tick += 1.0;
        at
    }
}

/// `[dir, steps]`: `steps` are `{ op: "get", path }`,
/// `{ op: "setPosition", path, position }`, `{ op: "setViewPrefs", patch }`,
/// `{ op: "movePosition", from, to }` and `{ op: "failWrites", on }`; one
/// answer per step: `{ op, ok? }` or `{ op, error }`
fn reading_state_call(args: &[Value], cx: &mut Context) -> Answer {
    let dir = str_arg(args, 0)?;
    let steps = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let mut state = ReadingState::new(FakeReadingDeps {
        dir: dir.to_owned(),
        log: Rc::clone(&log),
        fail: false,
        now: cx.now_ms,
        tick: 0.0,
    });
    let mut answers = Vec::new();
    for step in steps {
        let op = step
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("an op"))?;
        let text = |key: &str| step.get(key).and_then(Value::as_str);
        let outcome: Result<Option<Value>, NodeError> = match op {
            "get" => Ok(Some(state.get(text("path")).to_json())),
            "setPosition" => {
                let path = text("path").ok_or_else(|| bad("a path"))?;
                let position =
                    read_position_of(step.get("position").map(json_value_from_serde).as_ref())
                        .ok_or_else(|| bad("a position"))?;
                state.set_position(path, &position).map(|()| None)
            }
            "setViewPrefs" => {
                let patch = step.get("patch").map(json_value_from_serde);
                state
                    .set_view_prefs(patch.as_ref())
                    .map(|prefs| Some(prefs.to_json()))
            }
            "movePosition" => {
                let from = text("from").ok_or_else(|| bad("from"))?;
                let to = text("to").ok_or_else(|| bad("to"))?;
                state.move_position(from, to).map(|()| None)
            }
            "failWrites" => {
                state.deps().fail = step.get("on").and_then(Value::as_bool).unwrap_or(false);
                Ok(None)
            }
            _ => return Err(bad("an op")),
        };
        let mut answer = Map::new();
        answer.insert("op".into(), Value::from(op));
        match outcome {
            Ok(Some(value)) => {
                answer.insert("ok".into(), value);
            }
            Ok(None) => {}
            Err(error) => {
                answer.insert("error".into(), Value::from(error.message));
            }
        }
        answers.push(Value::Object(answer));
    }
    cx.logs.extend(log.borrow().iter().cloned());
    Ok(Some(Value::Array(answers)))
}

// ---------- the result paths ----------

/// `[path, { sourcePath, open, caseInsensitive }]`; `open` the paths a tab has
/// open; every `isOpenInTab` call is a log line
fn check_result_path_call(args: &[Value], cx: &mut Context) -> Answer {
    let context = arg(args, 1).ok_or_else(|| bad("a context"))?;
    let source = context
        .get("sourcePath")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("a source path"))?;
    let open: Vec<&str> = context
        .get("open")
        .and_then(Value::as_array)
        .map(|paths| paths.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut logs: Vec<Vec<Value>> = Vec::new();
    let mut is_open = |path: &str| {
        logs.push(vec![Value::from("isOpenInTab"), Value::from(path)]);
        open.contains(&path)
    };
    let verdict = check_result_path(
        arg(args, 0).and_then(Value::as_str),
        &mut ResultPathContext {
            source_path: source,
            is_open_in_tab: &mut is_open,
            case_insensitive: context.get("caseInsensitive").and_then(Value::as_bool),
        },
    );
    cx.logs.extend(logs);
    Ok(Some(verdict.to_json()))
}

// ---------- the store handlers ----------

/// what the fake store throws from every method, as the spec names it
fn thrown(kind: &str) -> StoreError {
    match kind {
        "write" => StoreError::Write(StoreWriteError::new("/x/y", Some("ENOSPC"))),
        "type" => StoreError::Type("bad thing".to_owned()),
        "error" => StoreError::Other("boom".to_owned()),
        "empty" => StoreError::Other(String::new()),
        "string" => StoreError::Other("plain string".to_owned()),
        _ => StoreError::Other("42".to_owned()),
    }
}

struct FakeStore {
    log: Log,
    config: Value,
}

impl FakeStore {
    fn record(&self, method: &str, mut rest: Vec<Value>) -> Result<(), StoreError> {
        let mut line = vec![Value::from(method)];
        line.append(&mut rest);
        self.log.borrow_mut().push(line);
        match self.config.get("throws").and_then(Value::as_str) {
            Some(kind) => Err(thrown(kind)),
            None => Ok(()),
        }
    }
}

fn mode_values(mode: Option<TranslationMode>) -> Vec<Value> {
    mode.map(|mode| Value::from(mode.as_str()))
        .into_iter()
        .collect()
}

fn with_mode(mut front: Vec<Value>, mode: Option<TranslationMode>) -> Vec<Value> {
    front.extend(mode_values(mode));
    front
}

impl EpubStore for FakeStore {
    fn list_translations(
        &mut self,
        doc_hash: &str,
        mode: Option<TranslationMode>,
    ) -> Result<Vec<String>, StoreError> {
        self.record(
            "listTranslations",
            with_mode(vec![Value::from(doc_hash)], mode),
        )?;
        Ok(self
            .config
            .get("langs")
            .and_then(Value::as_array)
            .map(|langs| {
                langs
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default())
    }

    fn read_translation(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<Option<StoredTranslation>, StoreError> {
        self.record(
            "readTranslation",
            with_mode(vec![Value::from(doc_hash), Value::from(lang)], mode),
        )?;
        let Some(stored) = self
            .config
            .get("stored")
            .filter(|stored| stored.is_object())
        else {
            return Ok(None);
        };
        Ok(Some(StoredTranslation {
            lang: stored
                .get("lang")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            provider: stored
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_owned),
            model: stored
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            blocks: stored
                .get("blocks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }))
    }

    fn unfinished_jobs(&mut self, doc_hash: &str) -> Result<Vec<Value>, StoreError> {
        self.record("unfinishedJobs", vec![Value::from(doc_hash)])?;
        Ok(self
            .config
            .get("jobs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    fn write_translation_meta(
        &mut self,
        doc_hash: &str,
        lang: &str,
        provider: &str,
        model: &str,
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError> {
        let mut meta = Map::new();
        meta.insert("provider".into(), Value::from(provider));
        meta.insert("model".into(), Value::from(model));
        self.record(
            "writeTranslationMeta",
            with_mode(
                vec![
                    Value::from(doc_hash),
                    Value::from(lang),
                    Value::Object(meta),
                ],
                mode,
            ),
        )
    }

    fn write_translation_blocks(
        &mut self,
        doc_hash: &str,
        lang: &str,
        blocks: &[Value],
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError> {
        self.record(
            "writeTranslationBlocks",
            with_mode(
                vec![
                    Value::from(doc_hash),
                    Value::from(lang),
                    Value::Array(blocks.to_vec()),
                ],
                mode,
            ),
        )
    }

    fn delete_translation(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError> {
        self.record(
            "deleteTranslation",
            with_mode(vec![Value::from(doc_hash), Value::from(lang)], mode),
        )
    }

    fn delete_translation_except_edited(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<f64, StoreError> {
        self.record(
            "deleteTranslationExceptEdited",
            with_mode(vec![Value::from(doc_hash), Value::from(lang)], mode),
        )?;
        Ok(self
            .config
            .get("removed")
            .and_then(Value::as_f64)
            .unwrap_or(0.0))
    }

    fn write_job(&mut self, doc_hash: &str, job: &Value) -> Result<(), StoreError> {
        self.record("writeJob", vec![Value::from(doc_hash), job.clone()])
    }

    fn heartbeat_job(
        &mut self,
        doc_hash: &str,
        kind: &str,
        key: Option<&str>,
        mode: Option<TranslationMode>,
    ) -> Result<bool, StoreError> {
        self.record(
            "heartbeatJob",
            with_mode(
                vec![
                    Value::from(doc_hash),
                    Value::from(kind),
                    key.map_or(Value::Null, Value::from),
                ],
                mode,
            ),
        )?;
        Ok(self
            .config
            .get("heartbeat")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }
}

struct FakeStoreDeps {
    log: Log,
    known: Value,
    store: FakeStore,
    store_throws: bool,
}

impl EpubStoreHandlerDeps for FakeStoreDeps {
    fn store(&mut self) -> Result<&mut dyn EpubStore, StoreError> {
        self.log.borrow_mut().push(vec![Value::from("store")]);
        if self.store_throws {
            return Err(StoreError::Other("no store".to_owned()));
        }
        Ok(&mut self.store)
    }

    fn knows(&mut self, owner: f64, doc_hash: &str) -> bool {
        self.log.borrow_mut().push(vec![
            Value::from("knows"),
            number(owner),
            Value::from(doc_hash),
        ]);
        self.known
            .get(number_to_string(owner))
            .and_then(Value::as_array)
            .is_some_and(|hashes| hashes.iter().any(|hash| hash.as_str() == Some(doc_hash)))
    }
}

/// `[config, calls]`: `config` is `{ known: { "<owner>": [hashes] }, store:
/// { langs, stored, jobs, removed, heartbeat, throws }, storeThrows }`;
/// `calls` are `{ fn, owner, args }` with `fn` one of `translations`,
/// `translation`, `unfinishedJobs` and `write`; one answer per call:
/// `{ ok }` or `{ error }` (a rejection)
fn store_handlers_call(args: &[Value], cx: &mut Context) -> Answer {
    let config = arg(args, 0).ok_or_else(|| bad("a config"))?;
    let calls = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("calls"))?;
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let mut deps = FakeStoreDeps {
        log: Rc::clone(&log),
        known: config.get("known").cloned().unwrap_or(Value::Null),
        store: FakeStore {
            log: Rc::clone(&log),
            config: config.get("store").cloned().unwrap_or(Value::Null),
        },
        store_throws: config
            .get("storeThrows")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    let mut answers = Vec::new();
    for entry in calls {
        let function = entry
            .get("fn")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("a function"))?;
        let owner = entry
            .get("owner")
            .and_then(Value::as_f64)
            .ok_or_else(|| bad("an owner"))?;
        let call_args: &[Value] = entry
            .get("args")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice);
        let outcome: Result<Value, StoreError> = match function {
            "translations" => Ok(store_handlers::translations(
                &mut deps,
                owner,
                call_args.first(),
                call_args.get(1),
            )),
            "translation" => Ok(store_handlers::translation(
                &mut deps,
                owner,
                call_args.first(),
                call_args.get(1),
                call_args.get(2),
            )),
            "unfinishedJobs" => Ok(store_handlers::unfinished_jobs(
                &mut deps,
                owner,
                call_args.first(),
            )),
            "write" => store_handlers::write(&mut deps, owner, call_args.first()),
            _ => return Err(bad("a function")),
        };
        let mut answer = Map::new();
        match outcome {
            Ok(value) => {
                answer.insert("ok".into(), value);
            }
            Err(StoreError::Write(error)) => {
                answer.insert("error".into(), Value::from(error.message));
            }
            Err(StoreError::Type(message) | StoreError::Other(message)) => {
                answer.insert("error".into(), Value::from(message));
            }
        }
        answers.push(Value::Object(answer));
    }
    cx.logs.extend(log.borrow().iter().cloned());
    Ok(Some(Value::Array(answers)))
}
