//! The functions of group `b6-utils` (tools/main-diff/groups/b6-utils.ts):
//! the modules of `packages/electron-utils` that call Electron (batch B6 of
//! decision 0030). What they call is a fake the spec describes; each call of
//! a fake is one `logs` line, and the TypeScript writes the same lines.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsObject, JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::Value;

use super::fakes::{FakeDialog, FakeWindow, fake_parent};
use super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::electron_utils::dialog_memory::{Dialog, DialogMemory};
use crate::packages::electron_utils::remote_image::MemoryResponse;
use crate::packages::electron_utils::safe_remote_url::Response;
use crate::packages::electron_utils::save_conflict::{
    ProbeThrew, SaveConflictOptions, SaveDiskState, confirm_overwrite_if_conflicted,
    is_modified_since, is_path_open_elsewhere, record_disk_state, should_defer_auto_save,
};
use crate::packages::electron_utils::save_image::{
    SaveImageOptions, decode_data_url, is_savable_image_url, save_image_from_url,
    suggest_image_file_name,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- save-conflict ----
        "save-conflict.recordDiskState" => {
            str_arg(args, 0).map(|path| Some(to_value(&record_disk_state(path))))
        }
        "save-conflict.isModifiedSince" => (|| {
            let recorded = disk_state(arg(args, 0))?;
            let path = str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_modified_since(
                recorded.as_ref(),
                path,
            ))))
        })(),
        "save-conflict.isPathOpenElsewhere" => (|| {
            let probe = Probe::of(arg(args, 0));
            let path = str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_path_open_elsewhere(
                probe
                    .as_ref()
                    .map(|p| p as &dyn Fn(&str) -> Result<bool, ProbeThrew>),
                path,
            ))))
        })(),
        "save-conflict.confirmOverwriteIfConflicted" => confirm_call(args, cx),
        "save-conflict.shouldDeferAutoSave" => (|| {
            let probe = Probe::of(arg(args, 0));
            let path = str_arg(args, 1)?;
            let recorded = disk_state(arg(args, 2))?;
            Ok(Some(Value::Bool(should_defer_auto_save(
                probe
                    .as_ref()
                    .map(|p| p as &dyn Fn(&str) -> Result<bool, ProbeThrew>),
                path,
                recorded.as_ref(),
            ))))
        })(),

        // ---- save-image ----
        "save-image.isSavableImageUrl" => {
            str_arg(args, 0).map(|url| Some(Value::Bool(is_savable_image_url(url))))
        }
        "save-image.suggestImageFileName" => str_arg(args, 0).map(|url| {
            let mime = arg(args, 1).and_then(Value::as_str);
            Some(Value::from(suggest_image_file_name(url, mime)))
        }),
        "save-image.decodeDataUrl" => str_arg(args, 0).map(|url| {
            Some(decode_data_url(url).map_or(Value::Null, |decoded| {
                let mut out = serde_json::Map::new();
                out.insert("bytes".into(), Value::from(hex(&decoded.bytes)));
                out.insert("mime".into(), decoded.mime.map_or(Value::Null, Value::from));
                Value::Object(out)
            }))
        }),
        "save-image.saveImageFromUrl" => save_image_call(args, cx),
        _ => return None,
    })
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// `SaveDiskState | undefined` from JSON; `null` stands for undefined
fn disk_state(value: Option<&Value>) -> Result<Option<SaveDiskState>, CallError> {
    let Some(Value::Object(o)) = value else {
        return Ok(None);
    };
    let num = |key: &str| {
        o.get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| CallError::plain(format!("recorded.{key} is not a number")))
    };
    Ok(Some(SaveDiskState {
        mtime_ms: num("mtimeMs")?,
        size: num("size")?,
        hash: o
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    }))
}

/// The open-path probe of a spec: `null` (none), `{ open: [paths] }` (true
/// for those), `{ answer: v }` (answers `v` whatever the path) or
/// `{ throws: true }`.
struct Probe(Value);

impl Probe {
    fn of(spec: Option<&Value>) -> Option<impl Fn(&str) -> Result<bool, ProbeThrew>> {
        let spec = spec.filter(|v| v.is_object())?.clone();
        let probe = Probe(spec);
        Some(move |path: &str| probe.answer(path))
    }

    fn answer(&self, path: &str) -> Result<bool, ProbeThrew> {
        if self
            .0
            .get("throws")
            .is_some_and(|v| v == &Value::Bool(true))
        {
            return Err(ProbeThrew);
        }
        if let Some(open) = self.0.get("open").and_then(Value::as_array) {
            return Ok(open.iter().any(|p| p.as_str() == Some(path)));
        }
        Ok(self.0.get("answer") == Some(&Value::Bool(true)))
    }
}

/// `[{ probe, parent, path, recorded, lang, response }]`
fn confirm_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("options"))?;
    let probe = Probe::of(spec.get("probe"));
    let dialog = FakeDialog::of(spec);
    let parent = fake_parent(spec);
    let recorded = disk_state(spec.get("recorded"))?;
    let answer = confirm_overwrite_if_conflicted(&SaveConflictOptions {
        probe: probe
            .as_ref()
            .map(|p| p as &dyn Fn(&str) -> Result<bool, ProbeThrew>),
        dialog: &dialog,
        parent: parent.as_ref(),
        path: spec.get("path").and_then(Value::as_str).unwrap_or_default(),
        recorded: recorded.as_ref(),
        lang: spec.get("lang").and_then(Value::as_str).unwrap_or_default(),
    });
    cx.logs.extend(dialog.log.into_inner());
    Ok(Some(to_value(&answer)))
}

/// A save dialog that logs `["showSaveDialog", "<window>"?, options]` and
/// answers the spec's `pick`.
struct FileDialog {
    log: Rc<RefCell<Vec<Vec<Value>>>>,
    pick: Value,
}

impl Dialog for FileDialog {
    type Window = FakeWindow;

    fn show_open_dialog(
        &mut self,
        parent: Option<&FakeWindow>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        self.record("showOpenDialog", parent, options)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&FakeWindow>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        self.record("showSaveDialog", parent, options)
    }
}

impl FileDialog {
    fn record(
        &self,
        name: &str,
        parent: Option<&FakeWindow>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let mut line = vec![Value::from(name)];
        if parent.is_some() {
            line.push(Value::from("<window>"));
        }
        line.push(json_value_to_serde(&JsonValue::Object(options.clone())));
        self.log.borrow_mut().push(line);
        json_value_from_serde(&self.pick)
    }
}

/// `[{ parent, url, title, fallbackDir?, fetch, pick }]`: `fetch` answers
/// `{ status, headers, body }` (hex) or rejects `{ reject: { name, message } }`;
/// each fetch logs `["fetch", url]`
fn save_image_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("options"))?;
    let log = Rc::new(RefCell::new(Vec::new()));
    let mut dialog = FileDialog {
        log: Rc::clone(&log),
        pick: spec.get("pick").cloned().unwrap_or(Value::Null),
    };
    let fetch_spec = spec.get("fetch").cloned().unwrap_or(Value::Null);
    let fetch_log = Rc::clone(&log);
    let mut fetch = move |url: &str| -> Result<Box<dyn Response>, String> {
        fetch_log
            .borrow_mut()
            .push(vec![Value::from("fetch"), Value::from(url)]);
        if let Some(reject) = fetch_spec.get("reject") {
            let field = |key: &str| reject.get(key).and_then(Value::as_str).unwrap_or("");
            return Err(format!("{}: {}", field("name"), field("message")));
        }
        let status = fetch_spec
            .get("status")
            .and_then(Value::as_u64)
            .unwrap_or(200) as u16;
        let headers = fetch_spec
            .get("headers")
            .and_then(Value::as_object)
            .map(|h| {
                h.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let body = unhex(fetch_spec.get("body").and_then(Value::as_str).unwrap_or(""));
        Ok(Box::new(MemoryResponse::new(status, headers, body)))
    };
    let parent = fake_parent(spec);
    let mut memory = DialogMemory::new();
    let result = save_image_from_url(
        &mut memory,
        &mut dialog,
        &mut fetch,
        parent.as_ref(),
        spec.get("url").and_then(Value::as_str).unwrap_or_default(),
        &SaveImageOptions {
            title: spec
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            fallback_dir: spec.get("fallbackDir").and_then(Value::as_str),
        },
    );
    cx.logs.extend(log.take());
    Ok(Some(to_value(&result)))
}
