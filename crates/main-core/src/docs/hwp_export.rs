//! `apps/docs/src/main/hwp-export.ts`: "Export as HWP Document". The steps of
//! the flow are injected, as in the TypeScript.
//!
//! A step that throws answers [`HwpError`]. The worker thread of
//! `convertInWorker` is a [`HwpWorker`]: the events its handlers receive come
//! one by one out of [`HwpWorker::next_event`] after the job is posted.

use jscompat::number_to_string;

use super::hwp_export_strings::hwp_export_i18n;
use crate::packages::i18n::Lang;

/// `HwpFormat`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwpFormat {
    Hwp,
    Hwpx,
}

impl HwpFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            HwpFormat::Hwp => "hwp",
            HwpFormat::Hwpx => "hwpx",
        }
    }
}

/// `Loss`: what a conversion left out or changed. `count` is a double.
#[derive(Debug, Clone, PartialEq)]
pub struct Loss {
    pub feature: String,
    pub kind: String,
    pub count: f64,
}

/// `HwpConversion`
#[derive(Debug, Clone, PartialEq)]
pub struct HwpConversion {
    pub bytes: Vec<u8>,
    pub losses: Vec<Loss>,
}

/// `HwpExportJob`
#[derive(Debug, Clone, PartialEq)]
pub struct HwpExportJob {
    pub docx: Vec<u8>,
    pub format: HwpFormat,
    pub wasm_path: String,
}

/// `HwpExportReply`
#[derive(Debug, Clone, PartialEq)]
pub enum HwpExportReply {
    Ok { bytes: Vec<u8>, losses: Vec<Loss> },
    Failed { code: String, error: String },
}

/// What a thrown value is to the flow: a refusal of the package
/// (`HwpExportFailure`, with its code), an `Error`, or another value
/// (`String(err)`).
#[derive(Debug, Clone, PartialEq)]
pub enum HwpError {
    Failure { code: String, message: String },
    Error(String),
    Other(String),
}

impl HwpError {
    /// `err instanceof Error ? err.message : String(err)`
    pub fn text(&self) -> &str {
        match self {
            HwpError::Failure { message, .. } => message,
            HwpError::Error(message) | HwpError::Other(message) => message,
        }
    }
}

/// An event of the worker the handlers of `convertInWorker` listen to.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerEvent {
    Message(HwpExportReply),
    Error(String),
    Exit(f64),
}

/// `WorkerLike`
pub trait HwpWorker {
    /// `postMessage(job, [docx.buffer])`; a throw is `Err` with its message
    fn post_message(&mut self, job: &HwpExportJob) -> Result<(), String>;
    /// the next event the worker emits; `None` = it never answers
    fn next_event(&mut self) -> Option<WorkerEvent>;
    fn terminate(&mut self);
}

/// One conversion in one worker, terminated on every path: answered, refused
/// or crashed. `spawn` throwing is not caught (no worker to terminate yet).
pub fn convert_in_worker<W: HwpWorker>(
    job: &HwpExportJob,
    spawn: &mut dyn FnMut() -> Result<W, String>,
) -> Result<HwpConversion, HwpError> {
    let mut worker = spawn().map_err(HwpError::Error)?;
    let outcome = (|| -> Result<HwpConversion, HwpError> {
        // a Buffer can be a view into Node's shared pool: hand over a copy this side owns
        worker.post_message(job).map_err(HwpError::Error)?;
        match worker.next_event() {
            Some(WorkerEvent::Message(reply)) => match reply {
                HwpExportReply::Failed { code, error } => Err(HwpError::Failure {
                    code,
                    message: error,
                }),
                HwpExportReply::Ok { bytes, losses } => Ok(HwpConversion { bytes, losses }),
            },
            Some(WorkerEvent::Error(message)) => Err(HwpError::Error(message)),
            Some(WorkerEvent::Exit(code)) => Err(HwpError::Error(format!(
                "the conversion stopped (exit code {})",
                number_to_string(code)
            ))),
            None => Err(HwpError::Error("the worker never answered".to_owned())),
        }
    })();
    worker.terminate();
    outcome
}

/// `HwpExportOutcome`
#[derive(Debug, Clone, PartialEq)]
pub enum HwpExportOutcome {
    Ok {
        path: String,
    },
    Canceled,
    Failed {
        code: String,
        error: String,
        path: Option<String>,
    },
}

/// `HwpExportSteps`
pub trait HwpExportSteps {
    /// a path sent by the renderer is written only if this tab was allowed to write it
    fn authorized(&mut self, path: &str) -> Result<bool, HwpError>;
    /// the export's own save dialog; `None` = canceled
    fn pick_path(&mut self) -> Result<Option<(String, HwpFormat)>, HwpError>;
    /// puts lazily served pictures back into the docx
    fn materialize(&mut self, docx: &[u8]) -> Result<Vec<u8>, HwpError>;
    fn convert(&mut self, docx: &[u8], format: HwpFormat) -> Result<HwpConversion, HwpError>;
    /// asked only when something is lost; false = canceled
    fn confirm(&mut self, losses: &[Loss], password_dropped: bool) -> Result<bool, HwpError>;
    /// false once the tab is gone: a closed tab's export writes nothing
    fn still_open(&mut self) -> Result<bool, HwpError>;
    fn write(&mut self, path: &str, bytes: &[u8]) -> Result<(), HwpError>;
    fn open(&mut self, path: &str) -> Result<(), HwpError>;
}

/// `HwpExportRequest`
#[derive(Debug, Clone, PartialEq)]
pub struct HwpExportRequest {
    pub docx: Vec<u8>,
    /// the Save As pick, already authorized; `None` = the export's own dialog
    pub out_path: Option<String>,
    /// the document carries an open password: the copy does not
    pub password_set: bool,
}

/// path -> dialog -> docx -> Hangul -> confirm (when something is lost) ->
/// write -> open. `Err` is what the steps outside the `try` threw.
pub fn export_hwp(
    steps: &mut dyn HwpExportSteps,
    request: &HwpExportRequest,
) -> Result<HwpExportOutcome, HwpError> {
    let (path, format) = match &request.out_path {
        Some(out_path) => {
            if !steps.authorized(out_path)? {
                return Ok(HwpExportOutcome::Failed {
                    code: "unauthorized".to_owned(),
                    error: "export target is not an authorized path".to_owned(),
                    path: None,
                });
            }
            let format = if jscompat::js_regex!(r"\.hwpx$", "i").test(out_path) {
                HwpFormat::Hwpx
            } else {
                HwpFormat::Hwp
            };
            (out_path.clone(), format)
        }
        None => match steps.pick_path()? {
            Some(target) => target,
            None => return Ok(HwpExportOutcome::Canceled),
        },
    };
    let attempt = (|| -> Result<bool, HwpError> {
        let whole = steps.materialize(&request.docx)?;
        let HwpConversion { bytes, losses } = steps.convert(&whole, format)?;
        if !steps.still_open()? {
            return Ok(false);
        }
        if !losses.is_empty() || request.password_set {
            let save = steps.confirm(&losses, request.password_set)?;
            if !save || !steps.still_open()? {
                return Ok(false);
            }
        }
        steps.write(&path, &bytes)?;
        steps.open(&path)?;
        Ok(true)
    })();
    Ok(match attempt {
        Ok(true) => HwpExportOutcome::Ok { path },
        Ok(false) => HwpExportOutcome::Canceled,
        Err(err) => HwpExportOutcome::Failed {
            code: match &err {
                HwpError::Failure { code, .. } => code.clone(),
                _ => "failed".to_owned(),
            },
            error: err.text().to_owned(),
            path: Some(path),
        },
    })
}

/// `FEATURE_KEY`: a name for every loss the package reports.
fn feature_key(feature: &str) -> &'static str {
    match feature {
        "comment" => "featComment",
        "revision" => "featRevision",
        "equation" => "featEquation",
        "chart" => "featChart",
        "shape" => "featShape",
        "textbox" => "featTextbox",
        "object" => "featObject",
        "ink" => "featInk",
        "watermark" => "featWatermark",
        "hidden_text" => "featHiddenText",
        "picture" => "featPicture",
        "table" => "featTable",
        "note" => "featNote",
        "page_border" => "featPageBorder",
        "para_border" => "featParaBorder",
        "line_numbers" => "featLineNumbers",
        "protection" => "featProtection",
        "hyperlink" => "featHyperlink",
        "section" => "featSection",
        "columns" => "featColumns",
        "header_variant" => "featHeaderVariant",
        "header_content" => "featHeaderContent",
        "floating_picture" => "featFloatingPicture",
        "nested_table" => "featNestedTable",
        "table_layout" => "featTableLayout",
        "numbering" => "featNumbering",
        "tab_stop" => "featTabStop",
        "toc" => "featToc",
        "field" => "featField",
        "text_effect" => "featTextEffect",
        "note_format" => "featNoteFormat",
        "text_direction" => "featTextDirection",
        "plain_paragraph" => "featPlainParagraph",
        // outside the types: the TypeScript would look up `undefined`
        _ => "undefined",
    }
}

/// `MessageBoxOptions` as `hwpLossMessageBox` builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct MessageBox {
    /// `type`
    pub kind: &'static str,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: [String; 2],
    pub default_id: u8,
    pub cancel_id: u8,
    pub no_link: bool,
}

/// The confirmation: what changes and what is left out, by feature.
pub fn hwp_loss_message_box(losses: &[Loss], password_dropped: bool, lang: Lang) -> MessageBox {
    let i18n = hwp_export_i18n();
    let t = |key: &str| i18n.t(lang, key, None);
    let line = |name: &str, count: f64| {
        if count > 1.0 {
            format!("\u{2022} {name} ({})", number_to_string(count))
        } else {
            format!("\u{2022} {name}")
        }
    };
    let of = |kind: &str| -> Vec<String> {
        losses
            .iter()
            .filter(|loss| loss.kind == kind)
            .map(|loss| line(&t(feature_key(&loss.feature)), loss.count))
            .collect()
    };
    let section = |heading: &str, lines: Vec<String>| -> Option<String> {
        if lines.is_empty() {
            return None;
        }
        let mut all = vec![t(heading)];
        all.extend(lines);
        Some(all.join("\n"))
    };
    let mut dropped = of("dropped");
    if password_dropped {
        dropped.push(line(&t("featPassword"), 1.0));
    }
    let detail = [
        section("hwpChanges", of("changed")),
        section("hwpLeftOut", dropped),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    MessageBox {
        kind: "warning",
        title: t("hwpExportTitle"),
        message: t("hwpConfirmMessage"),
        detail,
        buttons: [t("hwpSave"), t("hwpCancel")],
        default_id: 0,
        cancel_id: 1,
        no_link: true,
    }
}
