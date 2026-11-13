//! The shared `Dialogs` host in the shapes `main-core`'s ports call: the
//! message box of the recovery prompt and the save conflict, and the open
//! dialog of `showOpenDialogWithMemory`. Plus the editor's own dialog words
//! (`tDlg` of pdf-main.ts).

use std::path::PathBuf;

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::dialog_memory::Dialog;
use main_core::packages::electron_utils::message_box::{
    MessageBox as MessageBoxPort, MessageBoxOptions, ParentWindow,
};
use shell_contract::WindowId;
use shell_contract::hosts::{Dialogs, FileDialog, FileFilter, MessageBox};

/// A window a dialog sits over; the shell's windows outlive the calls
pub(super) struct Parent(pub WindowId);

impl ParentWindow for Parent {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// `dialog.showMessageBox` over the shared host
pub(super) struct Boxes<'a>(pub &'a dyn Dialogs);

fn message_box(o: &MessageBoxOptions) -> MessageBox {
    MessageBox {
        kind: Some(o.kind.to_owned()),
        title: o.title.clone(),
        message: o.message.clone(),
        detail: o.detail.clone(),
        buttons: o.buttons.clone(),
        default_id: Some(o.default_id as usize),
        cancel_id: o.cancel_id.map(|id| id as usize),
        checkbox_label: None,
    }
}

impl MessageBoxPort<Parent> for Boxes<'_> {
    fn show_message_box_over(&self, parent: &Parent, options: &MessageBoxOptions) -> f64 {
        self.0
            .message(Some(parent.0), &message_box(options))
            .response as f64
    }
    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        self.0.message(None, &message_box(options)).response as f64
    }
}

/// `dialog.showOpenDialog`/`showSaveDialog` with the options object the
/// TypeScript literal wrote, answering Electron's result object
pub(super) struct Files<'a>(pub &'a dyn Dialogs);

fn file_dialog(options: &JsObject<JsonValue>) -> FileDialog {
    let text = |key: &str| match options.get(key) {
        Some(JsonValue::String(s)) => Some(s.clone()),
        _ => None,
    };
    let strings = |v: Option<&JsonValue>| match v {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|i| match i {
                JsonValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let filters = match options.get("filters") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|f| match f {
                JsonValue::Object(f) => Some(FileFilter {
                    name: match f.get("name") {
                        Some(JsonValue::String(s)) => s.clone(),
                        _ => String::new(),
                    },
                    extensions: strings(f.get("extensions")),
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    FileDialog {
        title: text("title"),
        default_path: text("defaultPath").map(PathBuf::from),
        button_label: text("buttonLabel"),
        filters,
        properties: strings(options.get("properties")),
    }
}

fn path_text(p: PathBuf) -> JsonValue {
    JsonValue::String(p.to_string_lossy().into_owned())
}

impl Dialog for Files<'_> {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.open(parent.copied(), &file_dialog(options));
        let mut out = JsObject::new();
        out.set("canceled", JsonValue::Bool(picked.is_none()));
        out.set(
            "filePaths",
            JsonValue::Array(
                picked
                    .unwrap_or_default()
                    .into_iter()
                    .map(path_text)
                    .collect(),
            ),
        );
        JsonValue::Object(out)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.save(parent.copied(), &file_dialog(options));
        let mut out = JsObject::new();
        out.set("canceled", JsonValue::Bool(picked.is_none()));
        if let Some(p) = picked {
            out.set("filePath", path_text(p));
        }
        JsonValue::Object(out)
    }
}

/// The paths of an open dialog's answer; empty when cancelled
pub(super) fn picked_paths(result: &JsonValue) -> Vec<String> {
    if matches!(
        result.get("canceled").as_deref(),
        Some(JsonValue::Bool(true))
    ) {
        return Vec::new();
    }
    match result.get("filePaths").as_deref() {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|i| match i {
                JsonValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// An options object literal for the dialog ports
pub(super) fn options(entries: Vec<(&str, JsonValue)>) -> JsObject<JsonValue> {
    let mut o = JsObject::new();
    for (k, v) in entries {
        o.set(k, v);
    }
    o
}

pub(super) fn pdf_filter(name: &str) -> JsonValue {
    let mut f = JsObject::new();
    f.set("name", JsonValue::String(name.to_owned()));
    f.set(
        "extensions",
        JsonValue::Array(vec![JsonValue::String("pdf".into())]),
    );
    JsonValue::Array(vec![JsonValue::Object(f)])
}

pub(super) fn props(names: &[&str]) -> JsonValue {
    JsonValue::Array(
        names
            .iter()
            .map(|n| JsonValue::String((*n).into()))
            .collect(),
    )
}

/// The keys of `tDlg`
#[derive(Clone, Copy)]
pub(super) enum Dlg {
    ExportImages,
    Insert,
    Split,
    Merge,
    Replace,
    RedactCopy,
    PickCertificate,
    SignedCopy,
    FilterCertificate,
    FilterPdf,
    CloseUnsavedMsg,
    CloseUnsavedDetail,
    BtnSave,
    BtnDontSave,
    BtnCancel,
}

/// `tm(key)`: `tDlg(getUiLang(), key)`
pub(super) fn tm(lang: &str, key: Dlg) -> &'static str {
    let ko = lang == "ko";
    let (en, k) = match key {
        Dlg::ExportImages => ("Export Images to Folder", "이미지를 폴더로 내보내기"),
        Dlg::Insert => ("Choose a PDF to Import", "가져올 PDF 선택"),
        Dlg::Split => ("Split PDF into Folder", "PDF를 폴더로 분할"),
        Dlg::Merge => ("Choose PDFs to Merge", "병합할 PDF 선택"),
        Dlg::Replace => ("Choose a Replacement PDF", "교체할 PDF 선택"),
        Dlg::RedactCopy => ("Save Redacted Copy As", "마스킹된 복사본 저장"),
        Dlg::PickCertificate => ("Choose a Certificate File", "인증서 파일 선택"),
        Dlg::SignedCopy => ("Save Signed Copy As", "서명된 사본 저장"),
        Dlg::FilterCertificate => ("Certificate Files (.p12, .pfx)", "인증서 파일 (.p12, .pfx)"),
        Dlg::FilterPdf => ("PDF Documents", "PDF 문서"),
        Dlg::CloseUnsavedMsg => (
            "This PDF has unsaved changes.",
            "이 PDF에 저장하지 않은 변경 사항이 있습니다.",
        ),
        Dlg::CloseUnsavedDetail => (
            "Do you want to save them before closing?",
            "닫기 전에 저장하시겠습니까?",
        ),
        Dlg::BtnSave => ("Save", "저장"),
        Dlg::BtnDontSave => ("Don't Save", "저장 안 함"),
        Dlg::BtnCancel => ("Cancel", "취소"),
    };
    if ko { k } else { en }
}
