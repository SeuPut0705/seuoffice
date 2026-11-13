//! `apps/shell/src/main/user-skills/template-tabs.ts`: template copies in new
//! tabs (spec 5.6, 5.7).
//!
//! A template skill's document is copied byte for byte into a fresh folder and
//! opened as a new untitled document of its editor; the request, its skill
//! chips and, for a template preview, the pending skill proposal are queued
//! for that tab's AI panel to take once (the caller's [`HandoffStore`]).
//! "Make a blank template" opens the current document's copy the same way, in
//! a preview tab, and keeps the original bytes for that tab's "save the
//! original as is".
//!
//! The file, tab and id operations are [`TemplateTabsHost`]. The
//! `contents.once('destroyed', ...)` listeners of the TypeScript are one
//! method, [`TemplateTabs::contents_destroyed`], which the adapter calls when
//! a copy tab's webContents is destroyed.

use jscompat::node_path::host as path_host;
use jscompat::{JsMap, JsObject, JsonValue, js_regex, json_value_to_serde, slice_utf16, trim};
use serde_json::{Map, Value};

use super::user_skills_service::{Failure, Svc, TemplateFile, UserSkillsFail};
use crate::packages::ai_provider::user_skills_import::Thrown;
use crate::packages::electron_utils::generate_handoff::{
    HandoffEditor, HandoffEditorName, HandoffSkillChip, HandoffStore, HandoffWebContents,
    SkillHandoff, handoff_editor_for_file, handoff_editor_takes_attachments,
};

/// `USER_SKILLS_CHANNELS.previewEnded`
pub const PREVIEW_ENDED_CHANNEL: &str = "skills:preview-ended";

/// `TemplateCopy`: a byte copy of a document, ready to open in its editor
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateCopy {
    pub editor: HandoffEditor,
    /// the copy on disk, alone in a fresh folder
    pub path: String,
    /// the folder made for it
    pub dir: String,
    pub bytes: Vec<u8>,
    /// the copy's file name, with the extension
    pub file_name: String,
    /// the title the new tab shows
    pub title: String,
}

/// `OpenedCopyTab`, with `ownsCopy`
pub struct OpenedCopyTab {
    pub tab_id: String,
    pub contents: Box<dyn HandoffWebContents>,
    /// true when the editor removes the folder itself
    pub owns_copy: bool,
}

/// `currentDocumentOf(openerId)`
#[derive(Debug, Clone, PartialEq)]
pub enum CurrentDocument {
    /// the path of a saved document with no unsaved changes
    Path(String),
    /// never saved, or has unsaved changes
    Unsaved,
}

/// `TemplateTabsDeps`; a `Err(String)` is a rejection
pub trait TemplateTabsHost {
    /// a new empty folder for one copy
    fn make_copy_dir(&mut self) -> Result<String, String>;
    fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), String>;
    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, String>;
    fn remove_dir(&mut self, path: &str) -> Result<(), String>;
    /// an enabled skill's template file, or why there is none
    fn template_file_of(&mut self, skill_id: &str) -> Svc<TemplateFile>;
    /// Open a new untitled tab of the copy's editor on the copy; `None` when
    /// it could not
    fn open_copy(&mut self, copy: &TemplateCopy) -> Result<Option<OpenedCopyTab>, String>;
    /// The saved document of the tab whose AI panel asked: `None` when the
    /// host has no such operation (nothing is attached)
    fn current_document_of(&mut self, opener_id: f64) -> Option<Result<CurrentDocument, String>>;
    /// bring a tab to the front; false when it is gone
    fn focus_tab(&mut self, tab_id: &str) -> bool;
    /// A skill template's copy opened for the panel of `opener_id` (spec 6):
    /// the shell lets the new tab follow that panel's project. Not called for
    /// a preview.
    fn copy_opened_for(&mut self, _contents_id: f64, _opener_id: f64) {}
    fn new_id(&mut self) -> String;
    fn now(&mut self) -> f64;
    /// `owner.isDestroyed()` of the tab that opened a preview
    fn owner_is_destroyed(&mut self, owner_id: f64) -> bool;
    /// `owner.send(channel, payload)`
    fn owner_send(&mut self, owner_id: f64, channel: &str, payload: &JsonValue);
}

/// `UserSkillTemplateOpenInput`
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateOpenInput {
    pub skill_id: String,
    pub text: String,
    pub chips: Vec<HandoffSkillChip>,
    pub with_current: bool,
}

fn chips_from_json(value: Option<&JsonValue>) -> Option<Vec<HandoffSkillChip>> {
    let Some(JsonValue::Array(items)) = value else {
        return None;
    };
    let mut chips = Vec::new();
    for item in items {
        let JsonValue::Object(item) = item else {
            return None;
        };
        let get = |key: &str| match item.get(key) {
            Some(JsonValue::String(text)) => Some(text.clone()),
            _ => None,
        };
        chips.push(HandoffSkillChip {
            id: get("id")?,
            source: get("source")?,
            title: get("title")?,
        });
    }
    Some(chips)
}

impl TemplateOpenInput {
    /// from the value `templateOpenInputOf` answers
    pub fn from_json(value: &JsonValue) -> Option<TemplateOpenInput> {
        let JsonValue::Object(object) = value else {
            return None;
        };
        let get = |key: &str| match object.get(key) {
            Some(JsonValue::String(text)) => Some(text.clone()),
            _ => None,
        };
        Some(TemplateOpenInput {
            skill_id: get("skillId")?,
            text: get("text")?,
            chips: chips_from_json(object.get("chips"))?,
            with_current: object.get("withCurrent") == Some(&JsonValue::Bool(true)),
        })
    }
}

/// `UserSkillPreviewInput`
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewInput {
    /// the current document as edited
    pub bytes: Vec<u8>,
    pub file_name: String,
    pub title: String,
    pub tab_title: String,
    pub text: String,
    pub original_redacted: bool,
    pub proposal: Value,
    pub draft: Option<Value>,
}

impl PreviewInput {
    /// from the value `previewInputOf` answers; `bytes` are the bytes its `bytes` stands for
    pub fn from_json(value: &JsonValue, bytes: Vec<u8>) -> Option<PreviewInput> {
        let JsonValue::Object(object) = value else {
            return None;
        };
        let get = |key: &str| match object.get(key) {
            Some(JsonValue::String(text)) => Some(text.clone()),
            _ => None,
        };
        let JsonValue::Bool(original_redacted) = object.get("originalRedacted")? else {
            return None;
        };
        Some(PreviewInput {
            bytes,
            file_name: get("fileName")?,
            title: get("title")?,
            tab_title: get("tabTitle")?,
            text: get("text")?,
            original_redacted: *original_redacted,
            proposal: json_value_to_serde(object.get("proposal")?),
            draft: object.get("draft").map(json_value_to_serde),
        })
    }
}

/// `UserSkillPreviewEnded`
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewEnded {
    pub preview_id: String,
    /// `saved` or `unsaved`
    pub outcome: String,
    pub skill_id: Option<String>,
    pub title: Option<String>,
}

impl PreviewEnded {
    /// from the value `previewEndedOf` answers
    pub fn from_json(value: &JsonValue) -> Option<PreviewEnded> {
        let JsonValue::Object(object) = value else {
            return None;
        };
        let get = |key: &str| match object.get(key) {
            Some(JsonValue::String(text)) => Some(text.clone()),
            _ => None,
        };
        Some(PreviewEnded {
            preview_id: get("previewId")?,
            outcome: get("outcome")?,
            skill_id: get("skillId"),
            title: get("title"),
        })
    }

    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("previewId", JsonValue::String(self.preview_id.clone()));
        object.set("outcome", JsonValue::String(self.outcome.clone()));
        if let Some(skill_id) = &self.skill_id {
            object.set("skillId", JsonValue::String(skill_id.clone()));
        }
        if let Some(title) = &self.title {
            object.set("title", JsonValue::String(title.clone()));
        }
        JsonValue::Object(object)
    }
}

struct PreviewRecord {
    owner_id: f64,
    /// the preview tab's webContents id
    tab_contents_id: f64,
    original: Vec<u8>,
    file_name: String,
    /// the original's editor reported it may withhold something: "save as is" is refused
    original_redacted: bool,
    ended: bool,
}

fn fail(reason: &str) -> UserSkillsFail {
    UserSkillsFail {
        reason: reason.to_owned(),
        problem: None,
    }
}

fn rejected(message: String) -> Failure {
    Failure::Thrown(Thrown::Plain(message))
}

/// `copyFileNameOf(title, extension)`: a file name made from a title: no path
/// characters, not too long
pub fn copy_file_name_of(title: &str, extension: &str) -> String {
    let spaced =
        js_regex!(r#"[<>:"/\\|?*\u0000-\u001f\u007f]"#).replace_all(title, |_| " ".to_owned());
    let single = js_regex!(r"\s+").replace_all(&spaced, |_| " ".to_owned());
    let trimmed = trim(&single);
    let undotted = js_regex!(r"^\.+").replace_all(trimmed, |_| String::new());
    let undotted_end = js_regex!(r"[. ]+$").replace_all(&undotted, |_| String::new());
    let cleaned = slice_utf16(&undotted_end, 0.0, Some(150.0));
    format!(
        "{}{extension}",
        if cleaned.is_empty() {
            "template"
        } else {
            cleaned.as_str()
        }
    )
}

/// what `openWithHandoff` opened
struct OpenedWithHandoff {
    tab_id: String,
    contents_id: f64,
}

/// the `handoff(target)` argument of `openWithHandoff`
type HandoffBuilder<'a> = &'a dyn Fn(&mut dyn TemplateTabsHost, HandoffEditor) -> SkillHandoff;

/// `createTemplateTabs(deps)`: the previews still open, and the copy folders
/// to remove when their tab goes
#[derive(Default)]
pub struct TemplateTabs {
    previews: JsMap<PreviewRecord>,
    /// (the copy tab's webContents id, its folder): removed when that tab is destroyed
    copy_dirs: Vec<(f64, String)>,
}

impl TemplateTabs {
    pub fn new() -> Self {
        TemplateTabs::default()
    }

    fn notify(host: &mut dyn TemplateTabsHost, record: &PreviewRecord, ended: &PreviewEnded) {
        if !host.owner_is_destroyed(record.owner_id) {
            host.owner_send(record.owner_id, PREVIEW_ENDED_CHANNEL, &ended.to_json());
        }
    }

    /// `openWithHandoff(bytes, fileName, title, handoff)`: copy the bytes into
    /// a fresh folder and open the copy; the hand-off goes with it
    fn open_with_handoff(
        &mut self,
        host: &mut dyn TemplateTabsHost,
        store: &mut HandoffStore,
        bytes: &[u8],
        file_name: &str,
        title: &str,
        handoff: HandoffBuilder<'_>,
    ) -> Svc<OpenedWithHandoff> {
        let Some(editor) = handoff_editor_for_file(file_name) else {
            return Err(fail("bad-template").into());
        };
        let dir = host.make_copy_dir().map_err(rejected)?;
        let path = path_host::join(&[&dir, file_name]);
        let opened = match host.write_file(&path, bytes) {
            Ok(()) => host
                .open_copy(&TemplateCopy {
                    editor,
                    path: path.clone(),
                    dir: dir.clone(),
                    bytes: bytes.to_vec(),
                    file_name: file_name.to_owned(),
                    title: title.to_owned(),
                })
                .unwrap_or(None),
            Err(_) => None,
        };
        let Some(mut opened) = opened else {
            let _ = host.remove_dir(&dir);
            return Err(fail("failed").into());
        };
        let queued = handoff(host, editor);
        store.queue_skill_handoff_for(&mut *opened.contents, queued);
        let contents_id = opened.contents.id();
        if !opened.owns_copy {
            self.copy_dirs.push((contents_id, dir));
        }
        Ok(OpenedWithHandoff {
            tab_id: opened.tab_id,
            contents_id,
        })
    }

    /// `openTemplate(input, openerId)`: spec 5.7: the template of the skill a
    /// request names, copied into a new tab of its editor, with the request
    /// and every chip handed over. With `withCurrent`, the asking tab's saved
    /// document goes along for the new tab to attach; a document never saved
    /// or with unsaved changes is refused (`unsaved`) and nothing opens.
    /// Returns `(tabId, attached)`.
    pub fn open_template(
        &mut self,
        host: &mut dyn TemplateTabsHost,
        store: &mut HandoffStore,
        input: &TemplateOpenInput,
        opener_id: Option<f64>,
    ) -> Svc<(String, bool)> {
        let template = host.template_file_of(&input.skill_id)?;
        let editor = handoff_editor_for_file(&template.file_name);
        let mut attach: Option<Vec<String>> = None;
        if input.with_current && editor.is_some_and(handoff_editor_takes_attachments) {
            let current = match opener_id {
                Some(opener_id) => match host.current_document_of(opener_id) {
                    Some(Ok(current)) => current,
                    Some(Err(_)) | None => CurrentDocument::Unsaved,
                },
                None => CurrentDocument::Unsaved,
            };
            match current {
                CurrentDocument::Unsaved => return Err(fail("unsaved").into()),
                CurrentDocument::Path(path) => attach = Some(vec![path]),
            }
        }
        let Ok(bytes) = host.read_file(&template.path) else {
            return Err(fail("no-template").into());
        };
        let extension_len = path_host::extname(&template.file_name)
            .encode_utf16()
            .count();
        let title = slice_utf16(
            &template.file_name,
            0.0,
            Some((template.file_name.encode_utf16().count() - extension_len) as f64),
        );
        let attach_for_handoff = attach.clone();
        let build = |host: &mut dyn TemplateTabsHost, target: HandoffEditor| SkillHandoff {
            id: host.new_id(),
            mode: "skill".to_owned(),
            target: HandoffEditorName(target),
            text: input.text.clone(),
            chips: input.chips.clone(),
            preview: None,
            attach: attach_for_handoff.clone(),
            created_at: host.now(),
        };
        let opened =
            self.open_with_handoff(host, store, &bytes, &template.file_name, &title, &build)?;
        if let Some(opener_id) = opener_id {
            host.copy_opened_for(opened.contents_id, opener_id);
        }
        Ok((opened.tab_id, attach.is_some()))
    }

    /// `openPreview(owner, input)`: spec 5.6 "make a blank template": the
    /// current document's copy in a preview tab, with the clearing request and
    /// the pending proposal handed over. The original bytes stay here for that
    /// tab's "save as is". Returns `(tabId, previewId)`.
    pub fn open_preview(
        &mut self,
        host: &mut dyn TemplateTabsHost,
        store: &mut HandoffStore,
        owner_id: f64,
        input: &PreviewInput,
    ) -> Svc<(String, String)> {
        let extension = path_host::extname(&input.file_name).to_lowercase();
        if handoff_editor_for_file(&input.file_name).is_none() {
            return Err(fail("bad-template").into());
        }
        let preview_id = host.new_id();
        let build = |host: &mut dyn TemplateTabsHost, target: HandoffEditor| {
            let mut preview = Map::new();
            preview.insert("previewId".to_owned(), Value::from(preview_id.clone()));
            preview.insert("title".to_owned(), Value::from(input.title.clone()));
            preview.insert("fileName".to_owned(), Value::from(input.file_name.clone()));
            preview.insert(
                "originalRedacted".to_owned(),
                Value::from(input.original_redacted),
            );
            preview.insert("proposal".to_owned(), input.proposal.clone());
            if let Some(draft) = &input.draft {
                preview.insert("draft".to_owned(), draft.clone());
            }
            SkillHandoff {
                id: host.new_id(),
                mode: "skill".to_owned(),
                target: HandoffEditorName(target),
                text: input.text.clone(),
                chips: Vec::new(),
                preview: Some(Value::Object(preview)),
                attach: None,
                created_at: host.now(),
            }
        };
        let opened = self.open_with_handoff(
            host,
            store,
            &input.bytes,
            &copy_file_name_of(&input.tab_title, &extension),
            &input.tab_title,
            &build,
        )?;
        let record = PreviewRecord {
            owner_id,
            tab_contents_id: opened.contents_id,
            original: input.bytes.clone(),
            file_name: input.file_name.clone(),
            original_redacted: input.original_redacted,
            ended: false,
        };
        self.previews.set(preview_id.as_str(), record);
        Ok((opened.tab_id, preview_id))
    }

    /// `openCopy(input)`: any document's byte copy as a new untitled tab of
    /// its editor, with a request (and skill chips) handed to that tab's AI
    /// panel. Returns the `tabId`.
    #[allow(clippy::too_many_arguments)]
    pub fn open_copy(
        &mut self,
        host: &mut dyn TemplateTabsHost,
        store: &mut HandoffStore,
        bytes: &[u8],
        file_name: &str,
        title: &str,
        request: &str,
        chips: &[HandoffSkillChip],
    ) -> Svc<String> {
        let build = |host: &mut dyn TemplateTabsHost, target: HandoffEditor| SkillHandoff {
            id: host.new_id(),
            mode: "skill".to_owned(),
            target: HandoffEditorName(target),
            text: request.to_owned(),
            chips: chips.to_vec(),
            preview: None,
            attach: None,
            created_at: host.now(),
        };
        let opened = self.open_with_handoff(host, store, bytes, file_name, title, &build)?;
        Ok(opened.tab_id)
    }

    /// `previewOriginal(senderId, previewId)`: the preview tab's "save the
    /// original as is": only that tab may ask, and never for an original that
    /// may withhold something. Returns `(bytes, fileName)`.
    pub fn preview_original(
        &self,
        sender_id: f64,
        preview_id: &str,
    ) -> Result<(Vec<u8>, String), UserSkillsFail> {
        let Some(record) = self.previews.get(preview_id) else {
            return Err(fail("not-found"));
        };
        if record.tab_contents_id != sender_id {
            return Err(fail("not-found"));
        }
        if record.original_redacted {
            return Err(fail("redacted"));
        }
        Ok((record.original.clone(), record.file_name.clone()))
    }

    /// `finishPreview(senderId, ended)`: the preview tab's card was saved or
    /// left unsaved: the original tab hears it
    pub fn finish_preview(
        &mut self,
        host: &mut dyn TemplateTabsHost,
        sender_id: f64,
        ended: &PreviewEnded,
    ) -> Result<(), UserSkillsFail> {
        let Some(record) = self.previews.get_mut(&ended.preview_id) else {
            return Err(fail("not-found"));
        };
        if record.tab_contents_id != sender_id {
            return Err(fail("not-found"));
        }
        if record.ended {
            return Ok(());
        }
        record.ended = true;
        let record = self
            .previews
            .get(&ended.preview_id)
            .expect("the record was just found");
        Self::notify(host, record, ended);
        Ok(())
    }

    /// `takeHandoff(target, senderId)`: a new tab's AI panel takes its hand-off, once
    pub fn take_handoff(
        &mut self,
        store: &mut HandoffStore,
        target: HandoffEditor,
        sender_id: f64,
    ) -> Option<SkillHandoff> {
        store.take_skill_handoff(target, sender_id)
    }

    /// `focusTab(tabId)`
    pub fn focus_tab(
        &mut self,
        host: &mut dyn TemplateTabsHost,
        tab_id: &str,
    ) -> Result<(), UserSkillsFail> {
        if host.focus_tab(tab_id) {
            Ok(())
        } else {
            Err(fail("not-found"))
        }
    }

    /// the `once('destroyed')` listeners of a copy tab and of a preview tab:
    /// the adapter calls this when the webContents `contents_id` is destroyed
    pub fn contents_destroyed(&mut self, host: &mut dyn TemplateTabsHost, contents_id: f64) {
        let mut at = 0;
        while at < self.copy_dirs.len() {
            if self.copy_dirs[at].0 == contents_id {
                let (_, dir) = self.copy_dirs.remove(at);
                let _ = host.remove_dir(&dir);
            } else {
                at += 1;
            }
        }
        let ids: Vec<String> = self
            .previews
            .iter()
            .filter(|(_, record)| record.tab_contents_id == contents_id)
            .map(|(id, _)| id.to_owned())
            .collect();
        for preview_id in ids {
            let Some(record) = self.previews.delete(&preview_id) else {
                continue;
            };
            if !record.ended {
                let ended = PreviewEnded {
                    preview_id: preview_id.clone(),
                    outcome: "unsaved".to_owned(),
                    skill_id: None,
                    title: None,
                };
                Self::notify(host, &record, &ended);
            }
        }
    }

    /// `openPreviewIds()`: tests and diagnostics: the previews still open
    pub fn open_preview_ids(&self) -> Vec<String> {
        self.previews.keys().map(str::to_owned).collect()
    }
}
