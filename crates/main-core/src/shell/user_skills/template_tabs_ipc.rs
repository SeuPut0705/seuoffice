//! `apps/shell/src/main/user-skills/template-tabs-ipc.ts`: the template flow's
//! channels (spec 5.6, 5.7): any editor's AI panel and the home ask panel may
//! open a template skill's copy; an editor tab may open a preview of its
//! document; only a preview tab may read its original's bytes or end the
//! preview; a tab takes only its own hand-off. Every request is checked again
//! here.
//!
//! `ipcMain.handle` stays in the TypeScript; each function here is the body of
//! one handler, called with the arguments the renderer sent (`raw` is the
//! value as it arrived, `None` when it was `undefined`) and the id of the
//! sender's webContents. The answer is the value the handler returns.

use jscompat::{JsObject, JsonValue};

use super::template_tabs::{
    PreviewEnded, PreviewInput, TemplateOpenInput, TemplateTabs, TemplateTabsHost,
};
use super::user_skills_service::{Failure, UserSkillsFail};
use crate::packages::electron_utils::generate_handoff::{
    HandoffEditor, HandoffStore, SkillHandoff,
};
use crate::packages::electron_utils::user_skills_channels::{
    handoff_target_of, preview_ended_of, preview_input_of, template_open_input_of,
};

fn invalid() -> JsonValue {
    UserSkillsFail {
        reason: "invalid".to_owned(),
        problem: None,
    }
    .to_json()
}

fn failed() -> JsonValue {
    UserSkillsFail {
        reason: "failed".to_owned(),
        problem: None,
    }
    .to_json()
}

fn ok_with(entries: &[(&str, JsonValue)]) -> JsonValue {
    let mut object = JsObject::new();
    object.set("ok", JsonValue::Bool(true));
    for (key, value) in entries {
        object.set(*key, value.clone());
    }
    JsonValue::Object(object)
}

/// `.catch(() => failed)` of a result that may also have rejected
fn failure_json(failure: Failure) -> JsonValue {
    match failure {
        Failure::Fail(fail) => fail.to_json(),
        Failure::Thrown(_) => failed(),
    }
}

/// `typeof value !== 'string' || value.length > max`
fn short_text(value: Option<&JsonValue>, max: usize) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) if text.encode_utf16().count() <= max => Some(text),
        _ => None,
    }
}

/// the handler of `C.openTemplate`: the asking panel's window is `sender_id`,
/// the copy's tab follows its project (spec 6)
pub fn handle_open_template(
    tabs: &mut TemplateTabs,
    host: &mut dyn TemplateTabsHost,
    store: &mut HandoffStore,
    raw: Option<&JsonValue>,
    sender_id: f64,
) -> JsonValue {
    let Some(input) =
        template_open_input_of(raw).and_then(|input| TemplateOpenInput::from_json(&input))
    else {
        return invalid();
    };
    match tabs.open_template(host, store, &input, Some(sender_id)) {
        Ok((tab_id, attached)) => ok_with(&[
            ("tabId", JsonValue::String(tab_id)),
            ("attached", JsonValue::Bool(attached)),
        ]),
        Err(failure) => failure_json(failure),
    }
}

/// the handler of `C.openPreview`; `bytes` are the bytes the renderer's
/// `bytes` field stands for
pub fn handle_open_preview(
    tabs: &mut TemplateTabs,
    host: &mut dyn TemplateTabsHost,
    store: &mut HandoffStore,
    raw: Option<&JsonValue>,
    bytes: Vec<u8>,
    sender_id: f64,
) -> JsonValue {
    let Some(input) =
        preview_input_of(raw).and_then(|input| PreviewInput::from_json(&input, bytes))
    else {
        return invalid();
    };
    match tabs.open_preview(host, store, sender_id, &input) {
        Ok((tab_id, preview_id)) => ok_with(&[
            ("tabId", JsonValue::String(tab_id)),
            ("previewId", JsonValue::String(preview_id)),
        ]),
        Err(failure) => failure_json(failure),
    }
}

/// what the handler of `C.previewOriginal` answers
#[derive(Debug, Clone, PartialEq)]
pub enum PreviewOriginalAnswer {
    /// `{ ok: true, bytes, fileName }`
    Original { bytes: Vec<u8>, file_name: String },
    /// `{ ok: false, reason }`
    Refused(JsonValue),
}

/// the handler of `C.previewOriginal`
pub fn handle_preview_original(
    tabs: &TemplateTabs,
    preview_id: Option<&JsonValue>,
    sender_id: f64,
) -> PreviewOriginalAnswer {
    let Some(preview_id) = short_text(preview_id, 128) else {
        return PreviewOriginalAnswer::Refused(invalid());
    };
    match tabs.preview_original(sender_id, preview_id) {
        Ok((bytes, file_name)) => PreviewOriginalAnswer::Original { bytes, file_name },
        Err(fail) => PreviewOriginalAnswer::Refused(fail.to_json()),
    }
}

/// the handler of `C.finishPreview`
pub fn handle_finish_preview(
    tabs: &mut TemplateTabs,
    host: &mut dyn TemplateTabsHost,
    raw: Option<&JsonValue>,
    sender_id: f64,
) -> JsonValue {
    let Some(ended) = preview_ended_of(raw).and_then(|ended| PreviewEnded::from_json(&ended))
    else {
        return invalid();
    };
    match tabs.finish_preview(host, sender_id, &ended) {
        Ok(()) => ok_with(&[]),
        Err(fail) => fail.to_json(),
    }
}

/// the handler of `C.takeHandoff`; `None` is the `null` it answers
pub fn handle_take_handoff(
    tabs: &mut TemplateTabs,
    store: &mut HandoffStore,
    target: Option<&JsonValue>,
    sender_id: f64,
) -> Option<SkillHandoff> {
    let editor = handoff_target_of(target).and_then(|name| HandoffEditor::parse(&name))?;
    tabs.take_handoff(store, editor, sender_id)
}

/// the handler of `C.focusTab`
pub fn handle_focus_tab(
    tabs: &mut TemplateTabs,
    host: &mut dyn TemplateTabsHost,
    tab_id: Option<&JsonValue>,
) -> JsonValue {
    let Some(tab_id) = short_text(tab_id, 64) else {
        return invalid();
    };
    match tabs.focus_tab(host, tab_id) {
        Ok(()) => ok_with(&[]),
        Err(fail) => fail.to_json(),
    }
}
