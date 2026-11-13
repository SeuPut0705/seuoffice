//! The print channels of batch M: the system print dialog, silent jobs and
//! PDF renders of the editors. Each handler is the body of the
//! `ipcMain.handle` it replaces; what the TypeScript `await`ed (windows,
//! dialogs, printers, child processes) runs on a worker with owned data, and
//! the answer goes out from there.

mod slides_html;
mod zod;

use std::rc::Rc;
use std::sync::{Arc, LazyLock, Mutex};

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{JsonValue, js_regex, math_round};
use main_core::diagram::print_document::{
    PrintDocuments, PrintPage as DiagramPage, build_print_html, is_print_cancel, is_print_page,
};
use main_core::docs::print_args::{
    print_paper_option, print_scale_option, valid_print_geometry, valid_print_paper,
};
use main_core::html::preview_document::{asset_base_href, build_preview_document};
use main_core::hwp::dialog_strings::tm;
use main_core::hwp::ipc::PrintPage as HwpPage;
use main_core::hwp::print_document::{
    PrintJob, PrintWindow as HwpWindow, bad_job, print_job_to_pdf, print_job_to_printer,
};
use main_core::markdown::print_document::{
    MarkdownPageRange, MarkdownPrintOptions, MarkdownPrintWindow, print_markdown_document,
};
use main_core::markdown::print_pdf::print_markdown_pdf;
use main_core::node_fs::{mkdtemp_random, node_error};
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use main_core::packages::electron_utils::print_cups::{
    CupsPrintJob, DriverOption, DuplexMode, PrintToPdfRequest, print_pdf_via_cups,
    print_to_pdf_options_for,
};
use main_core::packages::electron_utils::print_html_pdf::PrintWindow as HtmlPdfWindow;
use main_core::packages::electron_utils::print_job::{
    PrintDuplex, PrintJobOptions, print_job_options, print_outcome,
};
use main_core::packages::electron_utils::print_window::{
    ExecOutcome, JsError, PRINT_READY_SCRIPT, PrintDialogOutcome, PrintDialogWindow,
    PrintDocumentOptions, PrintReport, load_print_html, print_html_document, rm_recursive_force,
};
use main_core::packages::electron_utils::printer_options::{
    CommandOutcome, DRIVER_OPTION_NAMES, query_printer_options,
};
use main_core::packages::i18n::Lang;
use main_core::sheets::print_options::print_options_for;
use main_core::sheets::template_fonts::with_template_font_faces;
use serde_json::{Map, Value, json};
use shell_contract::hosts::{ContentsHost, DialogsHost, FileDialog, FileFilter, OsShellHost};
use shell_contract::ipc::{RegisterError, Registry, Reply, Responder};
use shell_contract::runtime::{AppPaths, PathName, Workers};
use shell_contract::{BytesKind, IpcError, IpcValue, ViewId, WindowId};

use crate::Ctx;
use crate::handler::{error, invoke_later};
use crate::hosts::{MHostRef, PrintProfile, PrintSurface, PrintWindowSpec, Printer};
use crate::state::MStateRef;
use crate::value::{arg, as_number, as_str, field, from_serde, is_object, to_json, to_serde};

use slides_html::{Layout, PrintDoc, build_print_document_html, print_page_size_in};

const MAX_MARKDOWN_PRINT_HTML_CHARS: usize = 50_000_000;
const MAX_MINDMAP_PAGE_CHARS: usize = 200 * 1024 * 1024;
const DRAWIO_ORIGIN: &str = "drawio-app://editor";
const BRIDGE_PREFIX: &str = "/__ieum/";
const TWIPS_PER_INCH: f64 = 1440.0;

/// `process.platform` as Node names it
fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Documents the diagram's print windows load once, by token
/// (`holdPrintDocument` of print-document.ts)
static DIAGRAM_DOCUMENTS: LazyLock<Mutex<PrintDocuments>> =
    LazyLock::new(|| Mutex::new(PrintDocuments::new()));

/// `takePrintDocument(token)`: what the diagram session's protocol answers a
/// request for `drawio-app://editor/__ieum/print/<token>` with, once
pub fn take_diagram_print_document(token: &str) -> Option<String> {
    DIAGRAM_DOCUMENTS.lock().unwrap().take_print_document(token)
}

/// Everything a worker needs, all of it `Send`
#[derive(Clone)]
struct Env {
    host: MHostRef,
    state: MStateRef,
    contents: ContentsHost,
    dialogs: DialogsHost,
    os: OsShellHost,
    workers: Arc<dyn Workers>,
    paths: Arc<dyn AppPaths>,
    platform: &'static str,
}

impl Env {
    fn of(cx: &Ctx, platform: &'static str) -> Env {
        Env {
            host: cx.host.clone(),
            state: cx.state.clone(),
            contents: cx.contents.clone(),
            dialogs: cx.dialogs.clone(),
            os: cx.os.clone(),
            workers: cx.services.workers.clone(),
            paths: cx.services.paths.clone(),
            platform,
        }
    }

    /// `os.tmpdir()`
    fn tmp(&self) -> String {
        self.paths
            .path(PathName::Temp)
            .to_string_lossy()
            .into_owned()
    }

    fn surface(&self, spec: &PrintWindowSpec) -> Box<dyn PrintSurface> {
        Box::new(WholeNumbers(self.host.print_window(spec)))
    }

    fn window(&self, spec: PrintWindowSpec) -> Win {
        Win {
            surface: self.surface(&spec),
            print_extra: None,
        }
    }

    fn run(&self, file: &str, args: &[String], stdin: Option<&[u8]>) -> CommandOutcome {
        self.host.run_command(file, args, stdin)
    }

    /// The code of `later`: run `job` on a worker and answer from there
    fn later(&self, reply: Responder, job: impl FnOnce(&Env) -> Reply + Send + 'static) {
        let env = self.clone();
        self.workers.spawn(Box::new(move || {
            let answer = job(&env);
            reply.reply(answer)
        }));
    }
}

/// A number a JavaScript object literal would hold as an integer is one here
/// too: the options a surface logs or serializes read `48`, not `48.0`
fn whole(value: &Value) -> Value {
    match value {
        Value::Number(n) if n.is_f64() => match n.as_f64() {
            Some(x) if x.fract() == 0.0 && x.abs() < 9e15 => Value::from(x as i64),
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(whole).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), whole(v))).collect())
        }
        other => other.clone(),
    }
}

/// The host's window with [`whole`] applied to what it is asked to print
struct WholeNumbers(Box<dyn PrintSurface>);

impl PrintSurface for WholeNumbers {
    fn load_file(&mut self, path: &str) -> Result<(), String> {
        self.0.load_file(path)
    }

    fn load_url(&mut self, url: &str) -> Result<(), String> {
        self.0.load_url(url)
    }

    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> ExecOutcome {
        self.0.execute_javascript(script, user_gesture)
    }

    fn print(&mut self, options: &Value) -> PrintReport {
        self.0.print(&whole(options))
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, String> {
        self.0.print_to_pdf(&whole(options))
    }

    fn show(&mut self) {
        self.0.show()
    }

    fn focus(&mut self) {
        self.0.focus()
    }

    fn is_destroyed(&self) -> bool {
        self.0.is_destroyed()
    }

    fn destroy(&mut self) {
        self.0.destroy()
    }
}

/// A print window as every main-core port sees it. `print_extra` holds the
/// keys a window adds to each `webContents.print` call (the mindmap's).
struct Win {
    surface: Box<dyn PrintSurface>,
    print_extra: Option<Value>,
}

impl Win {
    fn print_options(&self, silent: bool, print_background: bool) -> Value {
        let mut options = Map::new();
        options.insert("silent".into(), Value::Bool(silent));
        options.insert("printBackground".into(), Value::Bool(print_background));
        if let Some(Value::Object(extra)) = &self.print_extra {
            for (key, value) in extra {
                options.insert(key.clone(), value.clone());
            }
        }
        Value::Object(options)
    }
}

impl PrintDialogWindow for Win {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.surface.load_file(path).map_err(JsError::plain)
    }

    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> ExecOutcome {
        self.surface.execute_javascript(script, user_gesture)
    }

    fn print(&mut self, silent: bool, print_background: bool) -> Result<PrintReport, JsError> {
        let options = self.print_options(silent, print_background);
        Ok(self.surface.print(&options))
    }

    fn show(&mut self) -> Result<(), JsError> {
        self.surface.show();
        Ok(())
    }

    fn focus(&mut self) -> Result<(), JsError> {
        self.surface.focus();
        Ok(())
    }

    fn is_destroyed(&mut self) -> Result<bool, JsError> {
        Ok(self.surface.is_destroyed())
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.surface.destroy();
        Ok(())
    }
}

impl HtmlPdfWindow for Win {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.surface.load_file(path).map_err(JsError::plain)
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, JsError> {
        self.surface.print_to_pdf(options).map_err(JsError::plain)
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.surface.destroy();
        Ok(())
    }
}

impl HwpWindow for Win {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.surface.load_file(path).map_err(JsError::plain)
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, JsError> {
        self.surface.print_to_pdf(options).map_err(JsError::plain)
    }

    fn print(&mut self, options: &Value) -> Result<PrintReport, JsError> {
        Ok(self.surface.print(options))
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.surface.destroy();
        Ok(())
    }
}

impl MarkdownPrintWindow for Win {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.surface.load_file(path).map_err(JsError::plain)
    }

    fn show(&mut self) -> Result<(), JsError> {
        self.surface.show();
        Ok(())
    }

    fn focus(&mut self) -> Result<(), JsError> {
        self.surface.focus();
        Ok(())
    }

    fn print(&mut self, options: &Value) -> Result<PrintReport, JsError> {
        Ok(self.surface.print(options))
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.surface.destroy();
        Ok(())
    }
}

/// An object answer, `from_serde` of a `json!` literal
fn answer(value: Value) -> Reply {
    Ok(from_serde(&value))
}

/// `{ ok: false, error }`
fn failed(message: impl Into<String>) -> Reply {
    answer(json!({ "ok": false, "error": message.into() }))
}

/// What a throw of a main-core port is to the invoke
fn thrown(error: JsError) -> IpcError {
    self::error(error.message)
}

fn dialog_outcome(outcome: &PrintDialogOutcome) -> Reply {
    answer(serde_json::to_value(outcome).unwrap_or(Value::Null))
}

/// `str.length > max` without counting UTF-16 units of a string that cannot
/// be near the limit: a unit takes between one and three bytes
fn longer_than(text: &str, max: usize) -> bool {
    if text.len() <= max {
        return false;
    }
    if text.len() / 3 > max {
        return true;
    }
    text.encode_utf16().count() > max
}

fn number(x: f64) -> Value {
    Value::from(x)
}

/// `new BrowserWindow` of the print-window profile with the default size
fn plain_spec(profile: PrintProfile) -> PrintWindowSpec {
    PrintWindowSpec {
        profile,
        width: None,
        height: None,
        parent: None,
        dialog_chrome: false,
    }
}

fn printers_value(printers: &[Printer]) -> IpcValue {
    IpcValue::Array(
        printers
            .iter()
            .map(|p| {
                crate::value::object([
                    ("name", crate::value::string(p.name.as_str())),
                    (
                        "displayName",
                        // `p.displayName || p.name`
                        crate::value::string(if p.display_name.is_empty() {
                            p.name.as_str()
                        } else {
                            p.display_name.as_str()
                        }),
                    ),
                ])
            })
            .collect(),
    )
}

/// The `lp` job of the options `printJobOptions` resolved
fn cups_job(opts: &PrintJobOptions) -> CupsPrintJob {
    CupsPrintJob {
        device_name: opts.device_name.clone(),
        copies: opts.copies,
        collate: opts.collate,
        duplex_mode: opts.duplex_mode.map(|mode| match mode {
            PrintDuplex::Simplex => DuplexMode::Simplex,
            PrintDuplex::LongEdge => DuplexMode::LongEdge,
            PrintDuplex::ShortEdge => DuplexMode::ShortEdge,
        }),
        driver_options: opts.driver_options.as_ref().map(|options| {
            options
                .iter()
                .filter_map(|o| {
                    Some(DriverOption {
                        name: o.get("name")?.as_str()?.to_owned(),
                        value: o.get("value")?.as_str()?.to_owned(),
                    })
                })
                .collect()
        }),
    }
}

/// The `lp` job of a workbook request's `printOptionsFor` options
fn cups_job_of_options(options: &Value) -> CupsPrintJob {
    CupsPrintJob {
        device_name: options
            .get("deviceName")
            .and_then(Value::as_str)
            .map(str::to_owned),
        copies: options.get("copies").and_then(Value::as_f64),
        collate: options.get("collate").and_then(Value::as_bool),
        ..CupsPrintJob::default()
    }
}

fn zero_margins() -> Value {
    json!({ "top": 0, "bottom": 0, "left": 0, "right": 0 })
}

/// `{ ok, error? }` of `printPdfViaCups`
fn cups_answer(env: &Env, pdf: &[u8], job: &CupsPrintJob) -> Reply {
    let result = print_pdf_via_cups(pdf, job, &mut |file, args, stdin| {
        env.run(file, args, stdin)
    });
    answer(serde_json::to_value(&result).unwrap_or(Value::Null))
}

/// `webContents.print` of the sender's own contents: (success, failureReason)
fn contents_print(env: &Env, view: ViewId, options: &Value) -> (bool, Option<String>) {
    match env.contents.print(view, from_serde(options)) {
        Ok(true) => (true, None),
        Ok(false) => (false, None),
        Err(reason) => (false, Some(reason)),
    }
}

pub(crate) fn register(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    register_on(registry, cx, platform())
}

/// [`register`] on a platform the tests choose
fn register_on(
    registry: &mut dyn Registry,
    cx: &Rc<Ctx>,
    platform: &'static str,
) -> Result<(), RegisterError> {
    let env = Env::of(cx, platform);
    printers(registry, &env)?;
    docs(registry, &env)?;
    html(registry, cx, &env)?;
    hwp(registry, cx, &env)?;
    markdown(registry, &env)?;
    mindmap(registry, &env)?;
    diagram(registry, &env)?;
    slides(registry, cx, &env)?;
    workbook(registry, cx, &env)?;
    Ok(())
}

// ---- printers ----

fn printers(registry: &mut dyn Registry, env: &Env) -> Result<(), RegisterError> {
    for channel in ["docs:printers", "slides:printers"] {
        let env = env.clone();
        invoke_later(registry, channel, move |call, _args, reply| {
            let view = call.sender.view;
            env.later(reply, move |env| {
                Ok(printers_value(&env.host.printers(view)))
            });
        })?;
    }
    Ok(())
}

// ---- docs ----

fn docs(registry: &mut dyn Registry, env: &Env) -> Result<(), RegisterError> {
    let e = env.clone();
    invoke_later(registry, "docs:print", move |call, args, reply| {
        let view = call.sender.view;
        let scale = to_json(arg(&args, 0));
        let job = to_serde(arg(&args, 1));
        let paper = to_json(arg(&args, 2));
        let opts = print_job_options(job.as_ref());

        // { margins, ...printScale(scale), ...printJobOptions(job), ...printPaperOption(paper) }
        let mut print_opts = Map::new();
        print_opts.insert("margins".into(), json!({ "marginType": "none" }));
        if let Some(scale) = print_scale_option(scale.as_ref()) {
            print_opts.insert("scaleFactor".into(), number(math_round(scale * 100.0)));
        }
        if let Ok(Value::Object(job)) = serde_json::to_value(&opts) {
            for (key, value) in job {
                print_opts.insert(key, value);
            }
        }
        if let Some((width, height)) = print_paper_option(paper.as_ref()) {
            print_opts.insert(
                "pageSize".into(),
                json!({ "width": width, "height": height }),
            );
        }

        if e.platform == "darwin" && opts.silent {
            // Chromium's silent print can drop a job on macOS: render the
            // pages and spool them through CUPS instead
            let geometry = valid_print_paper(paper.as_ref());
            let pdf_scale = print_scale_option(scale.as_ref());
            let mut pdf_opts = Map::new();
            pdf_opts.insert("printBackground".into(), Value::Bool(true));
            pdf_opts.insert("margins".into(), zero_margins());
            if let Some(geometry) = geometry {
                pdf_opts.insert(
                    "pageSize".into(),
                    json!({
                        "width": geometry.width_twips / TWIPS_PER_INCH,
                        "height": geometry.height_twips / TWIPS_PER_INCH,
                    }),
                );
            }
            if let Some(scale) = pdf_scale {
                pdf_opts.insert("scale".into(), number(scale));
            }
            let job = cups_job(&opts);
            e.later(reply, move |env| {
                let pdf = env
                    .contents
                    .print_to_pdf(view, from_serde(&Value::Object(pdf_opts)))
                    .map_err(error)?;
                cups_answer(env, &pdf, &job)
            });
            return;
        }
        let silent = opts.silent;
        e.later(reply, move |env| {
            let (success, reason) = contents_print(env, view, &Value::Object(print_opts));
            let outcome = print_outcome(success, reason.as_deref(), silent);
            answer(serde_json::to_value(&outcome).unwrap_or(Value::Null))
        });
    })?;

    let e = env.clone();
    invoke_later(
        registry,
        "docs:print-pdf-buffer",
        move |call, args, reply| {
            let view = call.sender.view;
            let (width, height, scale) = (
                to_json(arg(&args, 0)),
                to_json(arg(&args, 1)),
                to_json(arg(&args, 2)),
            );
            if !valid_print_geometry(width.as_ref(), height.as_ref(), scale.as_ref()) {
                return reply.reply(failed("invalid page size or scale"));
            }
            let (width, height) = (
                as_number(arg(&args, 0)).unwrap_or(0.0),
                as_number(arg(&args, 1)).unwrap_or(0.0),
            );
            let mut options = Map::new();
            options.insert("printBackground".into(), Value::Bool(true));
            options.insert(
                "pageSize".into(),
                json!({ "width": width / TWIPS_PER_INCH, "height": height / TWIPS_PER_INCH }),
            );
            options.insert("margins".into(), zero_margins());
            if let Some(scale) = print_scale_option(scale.as_ref()) {
                options.insert("scale".into(), number(scale));
            }
            e.later(reply, move |env| {
                match env
                    .contents
                    .print_to_pdf(view, from_serde(&Value::Object(options)))
                {
                    Ok(data) => answer(json!({ "ok": true, "base64": jscompat::base64(&data) })),
                    // `String(err)` of the Error printToPDF rejected with
                    Err(reason) => failed(format!("Error: {reason}")),
                }
            });
        },
    )
}

// ---- html ----

/// `renderPrintPdf(html, docPath, workDir)` of html-main.ts
fn render_print_pdf(
    env: &Env,
    html: &str,
    doc_path: Option<&str>,
    work_dir: &str,
) -> Result<Vec<u8>, JsError> {
    let base = doc_path
        .filter(|p| !p.is_empty())
        .map(|p| asset_base_href(&dirname(p)));
    let html_path = join(&[work_dir, "print.html"]);
    std::fs::write(&html_path, build_preview_document(html, base.as_deref()))
        .map_err(|e| node_error(&e, "open", &html_path))?;
    let mut win = env.window(plain_spec(PrintProfile::Static));
    let printed = HtmlPdfWindow::load_file(&mut win, &html_path).and_then(|()| {
        HtmlPdfWindow::print_to_pdf(
            &mut win,
            &json!({
                "pageSize": "A4",
                "printBackground": true,
                "margins": { "top": 0.6, "bottom": 0.6, "left": 0.6, "right": 0.6 },
            }),
        )
    });
    HtmlPdfWindow::destroy(&mut win)?;
    printed
}

fn html(registry: &mut dyn Registry, cx: &Rc<Ctx>, env: &Env) -> Result<(), RegisterError> {
    let (c, e) = (cx.clone(), env.clone());
    invoke_later(registry, "html:print-preview", move |call, args, reply| {
        let view = call.sender.view;
        let doc_path = c.docs.document_path(view);
        let Some(html) = as_str(field(arg(&args, 0), "html")).map(str::to_owned) else {
            return reply.reply(Ok(IpcValue::Null));
        };
        e.later(reply, move |env| {
            let work_dir = mkdtemp_random(&join(&[&env.tmp(), "seuoffice-html-preview-"]))
                .map_err(|e| thrown(e.into()))?;
            let pdf = render_print_pdf(env, &html, doc_path.as_deref(), &work_dir);
            let _ = rm_recursive_force(&work_dir);
            match pdf {
                Ok(pdf) => Ok(IpcValue::Bytes(BytesKind::Uint8Array, pdf)),
                Err(err) => {
                    eprintln!("[html] print preview failed: {}", err.message);
                    Ok(IpcValue::Null)
                }
            }
        });
    })?;

    let (c, e) = (cx.clone(), env.clone());
    invoke_later(registry, "html:print-html", move |call, args, reply| {
        let view = call.sender.view;
        let doc_path = c.docs.document_path(view);
        let Some(html) = as_str(field(arg(&args, 0), "html")).map(str::to_owned) else {
            return reply.reply(failed("html: bad print request"));
        };
        e.later(reply, move |env| {
            let base = doc_path
                .filter(|p| !p.is_empty())
                .map(|p| asset_base_href(&dirname(&p)));
            let document = build_preview_document(&html, base.as_deref());
            let mut win = env.window(plain_spec(PrintProfile::Scripted));
            let tmp = env.tmp();
            let outcome = print_html_document(
                &mut win,
                &PrintDocumentOptions {
                    html: &document,
                    file_name: Some("print.html"),
                    dir_prefix: Some("seuoffice-html-print-"),
                    platform: env.platform,
                    tmp_dir: &tmp,
                },
                &mut log_probe_error,
            )
            .map_err(thrown)?;
            dialog_outcome(&outcome)
        });
    })
}

/// `console.error` of the readiness probe in print-window.ts
fn log_probe_error(message: &str) {
    eprintln!("[print] the readiness probe failed: {message}");
}

// ---- hwp ----

/// `pdfName(wcId)`
fn pdf_name(current: Option<&str>, lang: Lang) -> String {
    let base = current
        .filter(|c| !c.is_empty())
        .map(|c| js_regex!(r".hwpx?$", "i").replace_all(&basename(c, None), |_| String::new()))
        .unwrap_or_default();
    format!(
        "{}.pdf",
        if base.is_empty() {
            tm(lang, "untitledFile", None)
        } else {
            base
        }
    )
}

/// `pickPdfTarget(contents)` without the remembered last folder
/// (`showSaveDialogWithMemory`): the shared dialog memory is not reachable
/// from this batch
fn pick_pdf_target(env: &Env, view: ViewId, current: Option<String>, lang: Lang) -> Option<String> {
    let dir = match current.as_deref().filter(|c| !c.is_empty()) {
        Some(current) => dirname(current),
        None => env.host.default_save_dir(),
    };
    let default_path = join(&[&dir, &pdf_name(current.as_deref(), lang)]);
    let picked = env.dialogs.save(
        env.contents.window_of(view),
        &FileDialog {
            title: Some(tm(lang, "dlgExportPdfTitle", None)),
            default_path: Some(default_path.into()),
            filters: vec![FileFilter {
                name: "PDF".into(),
                extensions: vec!["pdf".into()],
            }],
            ..FileDialog::default()
        },
    )?;
    let picked = picked.to_string_lossy().into_owned();
    if picked.is_empty() {
        return None;
    }
    Some(if js_regex!(r".pdf$", "i").test(&picked) {
        picked
    } else {
        format!("{picked}.pdf")
    })
}

/// The job as `badJob` let it through
fn hwp_job(job: &Value) -> PrintJob {
    let pages = job["pages"]
        .as_array()
        .map(|pages| {
            pages
                .iter()
                .map(|page| HwpPage {
                    svg: page["svg"].as_str().unwrap_or_default().to_owned(),
                    width: page["width"].as_f64().unwrap_or_default(),
                    height: page["height"].as_f64().unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    let images = job["images"]
        .as_array()
        .map(|images| {
            images
                .iter()
                .filter_map(|image| image.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    PrintJob { pages, images }
}

/// The body of `hwp:print-pages` once the view is marked printing
fn hwp_print(
    env: &Env,
    view: ViewId,
    job: &PrintJob,
    pdf: bool,
    given: Option<String>,
    current: Option<String>,
    lang: Lang,
) -> Reply {
    let tmp = env.tmp();
    let result = (|| -> Result<Value, JsError> {
        let mut create = || Ok(env.window(plain_spec(PrintProfile::Static)));
        if !pdf {
            // a cancel in the dialog is no failure either: the job is "sent"
            print_job_to_printer(job, &tmp, &mut create)?;
            return Ok(json!({ "ok": true }));
        }
        let target = match given {
            Some(target) => target,
            None => match pick_pdf_target(env, view, current, lang) {
                Some(target) => target,
                None => return Ok(json!({ "ok": true, "canceled": true })),
            },
        };
        if target.is_empty() {
            return Ok(json!({ "ok": true, "canceled": true }));
        }
        let bytes = print_job_to_pdf(job, &tmp, &mut create)?;
        atomic_write_file(&target, &bytes).map_err(JsError::from)?;
        // a headless export stays silent: no tab, no file manager window
        if !env.host.headless() && !env.host.open_generated_path(&target) {
            env.os.show_item_in_folder(std::path::Path::new(&target));
        }
        Ok(json!({ "ok": true, "path": target }))
    })();
    match result {
        Ok(value) => answer(value),
        Err(err) => failed(err.message),
    }
}

fn hwp(registry: &mut dyn Registry, cx: &Rc<Ctx>, env: &Env) -> Result<(), RegisterError> {
    let (cx, e) = (cx.clone(), env.clone());
    invoke_later(registry, "hwp:print-pages", move |call, args, reply| {
        let view = call.sender.view;
        let job = to_serde(arg(&args, 0));
        if let Some(bad) = bad_job(job.as_ref()) {
            return reply.reply(failed(format!("hwp: {bad}")));
        }
        let Some(job) = job else { return };
        let pdf = job["mode"] == "pdf";
        // Save As > PDF: the path its dialog picked, taken once, and only for a PDF
        let options = arg(&args, 1);
        let given = if is_object(options) {
            field(options, "path")
        } else {
            &IpcValue::Undefined
        };
        let mut given_path = None;
        if !matches!(given, IpcValue::Undefined) {
            let granted = match given {
                IpcValue::String(_) if pdf => cx.docs.take_pdf_grant(view),
                _ => None,
            };
            match (given, granted) {
                (IpcValue::String(given), Some(granted)) if *given == granted => {
                    given_path = Some(given.clone());
                }
                _ => return reply.reply(failed("hwp: this PDF path was not picked in Save As")),
            }
        }
        if !cx.state.begin_print(true, view) {
            return reply.reply(failed("hwp: already printing"));
        }
        let lang = cx.state.language(&*cx.host, &cx.settings_path()).lang;
        let job = hwp_job(&job);
        let current = cx.docs.document_path(view);
        e.later(reply, move |env| {
            let answer = hwp_print(env, view, &job, pdf, given_path, current, lang);
            env.state.end_print(true, view);
            answer
        });
    })
}

// ---- markdown ----

/// `normalizeMarkdownPrintOptions(value)`
fn markdown_options(value: &IpcValue) -> MarkdownPrintOptions {
    let asked = |key: &str| field(value, key);
    MarkdownPrintOptions {
        page_size: if matches!(asked("pageSize"), IpcValue::String(s) if s == "Letter") {
            "Letter".to_owned()
        } else {
            "A4".to_owned()
        },
        margin_in: 0.6,
        landscape: matches!(asked("landscape"), IpcValue::Bool(true)),
        print_background: true,
    }
}

/// `typeof request?.html !== 'string' || !request.html || request.html.length > MAX_PRINT_HTML_CHARS`
fn markdown_html(request: &IpcValue) -> Option<String> {
    let html = as_str(field(request, "html"))?;
    if html.is_empty() || longer_than(html, MAX_MARKDOWN_PRINT_HTML_CHARS) {
        return None;
    }
    Some(html.to_owned())
}

/// `Number.isInteger(value)`
fn integer(value: &IpcValue) -> Option<f64> {
    as_number(value).filter(|n| n.is_finite() && n.fract() == 0.0)
}

fn markdown(registry: &mut dyn Registry, env: &Env) -> Result<(), RegisterError> {
    let e = env.clone();
    invoke_later(
        registry,
        "markdown:print-preview",
        move |_call, args, reply| {
            let request = arg(&args, 0);
            let Some(html) = markdown_html(request) else {
                return reply.reply(failed("markdown: bad print preview request"));
            };
            let options = markdown_options(field(request, "options"));
            e.later(reply, move |env| {
                let printed = print_markdown_pdf(
                    || Ok(env.window(plain_spec(PrintProfile::Static))),
                    &html,
                    &options,
                    &env.tmp(),
                );
                match printed {
                    Ok(pdf) => Ok(crate::value::object([
                        ("ok", IpcValue::Bool(true)),
                        ("pdf", IpcValue::Bytes(BytesKind::Uint8Array, pdf)),
                    ])),
                    Err(err) => failed(err.message),
                }
            });
        },
    )?;

    let e = env.clone();
    invoke_later(
        registry,
        "markdown:print-document",
        move |call, args, reply| {
            let view = call.sender.view;
            let request = arg(&args, 0);
            let Some(html) = markdown_html(request) else {
                return reply.reply(failed("markdown: bad print request"));
            };
            let pages = field(request, "pages");
            let range = match pages {
                IpcValue::Null => None,
                pages => {
                    let (from, to) = (integer(field(pages, "from")), integer(field(pages, "to")));
                    match (from, to) {
                        (Some(from), Some(to)) if from >= 1.0 && to >= from => {
                            Some(MarkdownPageRange { from, to })
                        }
                        _ => return reply.reply(failed("markdown: bad print range")),
                    }
                }
            };
            if !e.state.begin_print(false, view) {
                return reply.reply(failed("markdown: already printing"));
            }
            let options = markdown_options(field(request, "options"));
            e.later(reply, move |env| {
                let printed = print_markdown_document(
                    || Ok(env.window(plain_spec(PrintProfile::Static))),
                    &html,
                    range.as_ref(),
                    &options,
                    env.platform,
                    &env.tmp(),
                );
                env.state.end_print(false, view);
                // what the `finally` of the TypeScript threw rejects the invoke
                dialog_outcome(&printed.map_err(thrown)?)
            });
        },
    )
}

// ---- mindmap ----

fn mindmap(registry: &mut dyn Registry, env: &Env) -> Result<(), RegisterError> {
    let e = env.clone();
    invoke_later(registry, "mindmap:print", move |_call, args, reply| {
        let html = match field(arg(&args, 0), "html") {
            IpcValue::String(html)
                if !html.is_empty() && !longer_than(html, MAX_MINDMAP_PAGE_CHARS) =>
            {
                html.clone()
            }
            _ => return reply.reply(failed("mindmap: bad print request")),
        };
        e.later(reply, move |env| {
            let mut win = env.window(PrintWindowSpec {
                profile: PrintProfile::MindmapExport,
                width: Some(1123.0),
                height: Some(794.0),
                parent: None,
                dialog_chrome: false,
            });
            // the page size is said to the system dialog as well: landscape A4
            win.print_extra = Some(json!({
                "landscape": true,
                "pageSize": "A4",
                "margins": { "marginType": "none" },
            }));
            let tmp = env.tmp();
            let outcome = print_html_document(
                &mut win,
                &PrintDocumentOptions {
                    html: &html,
                    file_name: Some("map.html"),
                    dir_prefix: Some("seuoffice-mindmap-print-"),
                    platform: env.platform,
                    tmp_dir: &tmp,
                },
                &mut log_probe_error,
            )
            .map_err(thrown)?;
            dialog_outcome(&outcome)
        });
    })
}

// ---- diagram ----

/// `printPages(pages, title)` of export-main.ts
fn diagram_print(env: &Env, pages: &[DiagramPage], title: &str) -> Result<Value, String> {
    let mut win = env.surface(&PrintWindowSpec {
        profile: PrintProfile::Diagram,
        width: Some(900.0),
        height: Some(1200.0),
        parent: None,
        dialog_chrome: false,
    });
    let token = jscompat::random_uuid().replace('-', "");
    DIAGRAM_DOCUMENTS
        .lock()
        .unwrap()
        .hold_print_document(&build_print_html(pages, title), token.clone());
    let loaded = win.load_url(&format!("{DRAWIO_ORIGIN}{BRIDGE_PREFIX}print/{token}"));
    DIAGRAM_DOCUMENTS
        .lock()
        .unwrap()
        .drop_print_document(&token);
    let printed = loaded.and_then(
        |()| match win.execute_javascript(PRINT_READY_SCRIPT, true) {
            ExecOutcome::Throws(message) => Err(message),
            // a probe that rejects or outlasts the timer does not stop the print
            _ => Ok(()),
        },
    );
    let printed = printed.map(|()| {
        // Windows attaches the native dialog to the printed window, which must be visible
        if env.platform == "win32" {
            win.show();
            win.focus();
        }
        win.print(&json!({ "silent": false, "printBackground": true }))
    });
    if !win.is_destroyed() {
        win.destroy();
    }
    let report = printed?;
    Ok(if report.success {
        json!({ "ok": true })
    } else if is_print_cancel(Some(&JsonValue::String(report.failure_reason.clone()))) {
        json!({ "ok": true, "canceled": true })
    } else if report.failure_reason.is_empty() {
        json!({ "ok": false, "error": "the print job failed" })
    } else {
        json!({ "ok": false, "error": report.failure_reason })
    })
}

/// `printPagesOf(value)`
fn diagram_pages(value: &IpcValue) -> Option<Vec<DiagramPage>> {
    let IpcValue::Array(items) = value else {
        return None;
    };
    if items.is_empty() {
        return None;
    }
    let mut pages = Vec::with_capacity(items.len());
    for item in items {
        if !is_print_page(to_json(item).as_ref()) {
            return None;
        }
        pages.push(DiagramPage {
            svg: as_str(field(item, "svg"))?.to_owned(),
            width: as_number(field(item, "width"))?,
            height: as_number(field(item, "height"))?,
            page_width: as_number(field(item, "pageWidth"))?,
            page_height: as_number(field(item, "pageHeight"))?,
        });
    }
    Some(pages)
}

fn diagram(registry: &mut dyn Registry, env: &Env) -> Result<(), RegisterError> {
    let e = env.clone();
    invoke_later(registry, "diagram:print", move |_call, args, reply| {
        // `(raw ?? {})`: anything but an object has no `pages`
        let request = arg(&args, 0);
        let Some(pages) = diagram_pages(field(request, "pages")) else {
            return reply.reply(failed("bad print pages"));
        };
        // `String(request.title ?? '')`
        let title = match field(request, "title") {
            IpcValue::Undefined | IpcValue::Null => String::new(),
            title => jscompat::value_to_string(to_serde(title).as_ref()),
        };
        e.later(reply, move |env| match diagram_print(env, &pages, &title) {
            Ok(value) => answer(value),
            Err(message) => failed(message),
        });
    })
}

// ---- slides ----

fn slides(registry: &mut dyn Registry, cx: &Rc<Ctx>, env: &Env) -> Result<(), RegisterError> {
    let e = env.clone();
    invoke_later(
        registry,
        "slides:printer-options",
        move |_call, args, reply| {
            let queue = match arg(&args, 0) {
                IpcValue::String(queue) if js_regex!(r"^[A-Za-z0-9_.+-]{1,128}$").test(queue) => {
                    queue.clone()
                }
                _ => return reply.reply(Ok(IpcValue::Array(Vec::new()))),
            };
            e.later(reply, move |env| {
                let groups = query_printer_options(&queue, &mut |file, args, stdin| {
                    env.run(file, args, stdin)
                });
                let kept: Vec<_> = groups
                    .into_iter()
                    .filter(|g| DRIVER_OPTION_NAMES.contains(&g.name.as_str()))
                    .collect();
                answer(serde_json::to_value(&kept).unwrap_or(Value::Null))
            });
        },
    )?;

    let (cx, e) = (cx.clone(), env.clone());
    invoke_later(registry, "slides:print", move |call, args, reply| {
        let view = call.sender.view;
        let op = arg(&args, 0);
        // the page assembly throws on a bad op, which rejects the invoke
        let (doc, html) = match PrintDoc::from_op(op).and_then(|doc| {
            let html = build_print_document_html(&doc)?;
            Ok((doc, html))
        }) {
            Ok(built) => built,
            Err(err) => return reply.reply(Err(err)),
        };
        let (layout, landscape_asked, ratio) = (doc.layout, doc.landscape_asked, doc.ratio);
        let owner = cx
            .contents
            .window_of(view)
            .or_else(|| cx.main_window.window());
        let opts = print_job_options(to_serde(field(op, "job")).as_ref());
        e.later(reply, move |env| {
            slides_print(env, owner, &html, opts, layout, landscape_asked, ratio)
        });
    })
}

/// The window of `slides:print`: a child of `owner`, and on Windows, where the
/// system dialog needs it, visible and sized
fn slides_window(env: &Env, owner: Option<WindowId>, visible_dialog: bool) -> Win {
    env.window(PrintWindowSpec {
        profile: PrintProfile::Scripted,
        width: None,
        height: None,
        parent: owner,
        dialog_chrome: env.platform == "win32" && visible_dialog,
    })
}

fn slides_print(
    env: &Env,
    owner: Option<WindowId>,
    html: &str,
    opts: PrintJobOptions,
    layout: Layout,
    landscape_asked: bool,
    ratio: f64,
) -> Reply {
    let tmp = env.tmp();
    if !opts.silent {
        // the system dialog: a cancel is a bare `{ ok: false }` so the
        // renderer keeps its print dialog open
        let mut win = slides_window(env, owner, true);
        let outcome = print_html_document(
            &mut win,
            &PrintDocumentOptions {
                html,
                file_name: Some("slides.html"),
                dir_prefix: Some("seuoffice-slides-print-"),
                platform: env.platform,
                tmp_dir: &tmp,
            },
            &mut log_probe_error,
        )
        .map_err(thrown)?;
        return answer(match outcome {
            PrintDialogOutcome::Ok => json!({ "ok": true }),
            PrintDialogOutcome::Canceled => json!({ "ok": false }),
            PrintDialogOutcome::Failed(error) => json!({ "ok": false, "error": error }),
        });
    }

    let mut win = slides_window(env, owner, false);
    let mut temp_dir: Option<String> = None;
    let result = (|| -> Result<Value, String> {
        temp_dir = Some(
            load_print_html(
                &mut win,
                html,
                Some("slides.html"),
                Some("seuoffice-slides-print-"),
                &tmp,
                &mut log_probe_error,
            )
            .map_err(|e| e.message)?,
        );
        if env.platform == "darwin" {
            let (width, height) = print_page_size_in(layout, landscape_asked, ratio);
            let options = print_to_pdf_options_for(&PrintToPdfRequest {
                width_in: Some(width),
                height_in: Some(height),
                margins_in: Some(zero_margins()),
                ..PrintToPdfRequest::default()
            })
            .to_value();
            let printed = win.surface.print_to_pdf(&options)?;
            let sent = cups_answer(env, &printed, &cups_job(&opts));
            return Ok(to_serde(&sent.unwrap_or(IpcValue::Null)).unwrap_or(Value::Null));
        }
        // the options as printJobOptions made them, with every key they had
        let mut print_opts = serde_json::to_value(&opts).unwrap_or(Value::Null);
        print_opts["printBackground"] = Value::Bool(true);
        let report = win.surface.print(&print_opts);
        let outcome = print_outcome(report.success, Some(&report.failure_reason), true);
        Ok(serde_json::to_value(&outcome).unwrap_or(Value::Null))
    })();
    let removed = match &temp_dir {
        Some(dir) => rm_recursive_force(dir).map_err(|e| thrown(e.into())),
        None => Ok(()),
    };
    if !win.surface.is_destroyed() {
        win.surface.destroy();
    }
    removed?;
    match result {
        Ok(value) => answer(value),
        Err(message) => failed(message),
    }
}

// ---- workbook ----

/// `sheetsTemplateFontsDir()`
fn template_fonts_dir(env: &Env) -> String {
    main_core::packages::electron_utils::template_fonts_dir::template_fonts_dir(
        &crate::settings::TemplateFonts(&*env.host),
    )
}

/// `printWorkbook(event, request)` of pdf-export.ts
fn workbook_print(env: &Env, owner: Option<WindowId>, request: &zod::PrintRequest) -> Reply {
    let work_dir =
        mkdtemp_random(&join(&[&env.tmp(), "ai-excel-print-"])).map_err(|e| thrown(e.into()))?;
    let own_dialog = env.platform == "win32" && !request.device_name_present;
    let mut win = env.window(PrintWindowSpec {
        profile: PrintProfile::Static,
        width: None,
        height: None,
        parent: owner,
        dialog_chrome: own_dialog,
    });
    let result = (|| -> Result<Value, String> {
        let html_path = join(&[&work_dir, "print.html"]);
        let document = with_template_font_faces(&request.html, &template_fonts_dir(env));
        std::fs::write(&html_path, document)
            .map_err(|e| node_error(&e, "open", &html_path).message)?;
        win.surface.load_file(&html_path)?;
        if own_dialog {
            win.surface.show();
            win.surface.focus();
        }
        let print_opts = print_options_for(&request.options);
        if env.platform == "darwin" && print_opts["silent"] == true {
            let options = &request.options;
            let mut pdf_opts = match print_to_pdf_options_for(&PrintToPdfRequest {
                margins_in: options.get("margins").cloned(),
                landscape: options.get("landscape").and_then(Value::as_bool),
                scale: options.get("scale").and_then(Value::as_f64),
                ..PrintToPdfRequest::default()
            })
            .to_value()
            {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            // named sizes and inch sizes both go through as they are
            pdf_opts.insert("pageSize".into(), options["pageSize"].clone());
            pdf_opts.insert("preferCSSPageSize".into(), Value::Bool(true));
            let printed = win.surface.print_to_pdf(&Value::Object(pdf_opts))?;
            let sent = cups_answer(env, &printed, &cups_job_of_options(&print_opts));
            return Ok(to_serde(&sent.unwrap_or(IpcValue::Null)).unwrap_or(Value::Null));
        }
        let report = win.surface.print(&print_opts);
        Ok(if report.success {
            json!({ "ok": true })
        } else if report.failure_reason == "Print job canceled" {
            json!({ "ok": false })
        } else {
            json!({ "ok": false, "error": report.failure_reason })
        })
    })();
    win.surface.destroy();
    rm_recursive_force(&work_dir).map_err(|e| thrown(e.into()))?;
    match result {
        Ok(value) => answer(value),
        Err(message) => failed(message),
    }
}

fn workbook(registry: &mut dyn Registry, cx: &Rc<Ctx>, env: &Env) -> Result<(), RegisterError> {
    let untrusted = || error("Untrusted IPC sender.");

    let (print_cx, e) = (cx.clone(), env.clone());
    invoke_later(registry, "workbook:print", move |call, args, reply| {
        let view = call.sender.view;
        // sessionFor(event), then the schema: both throw
        if !print_cx.docs.sheets_session(view) {
            return reply.reply(Err(untrusted()));
        }
        let request = match zod::parse_print_request(arg(&args, 0)) {
            Ok(request) => request,
            Err(err) => return reply.reply(Err(err)),
        };
        let owner = print_cx.contents.window_of(view);
        e.later(reply, move |env| workbook_print(env, owner, &request));
    })?;

    let (cx, e) = (cx.clone(), env.clone());
    invoke_later(
        registry,
        "workbook:list-printers",
        move |call, _args, reply| {
            let view = call.sender.view;
            if !cx.docs.sheets_session(view) {
                return reply.reply(Err(untrusted()));
            }
            e.later(reply, move |env| {
                let printers = env.host.printers(view);
                // `printerInfoSchema.parse` of each, the first failure throws
                for printer in &printers {
                    let display = if printer.display_name.is_empty() {
                        &printer.name
                    } else {
                        &printer.display_name
                    };
                    zod::parse_printer_info(&printer.name, display)?;
                }
                Ok(printers_value(&printers))
            });
        },
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use shell_contract::Surface;

    use super::*;
    use crate::testkit::{FakeRegistry, Probe, sender};
    use crate::value::object;

    const VIEW: u32 = 1;

    /// A probe whose print handlers think they run on `platform`
    fn probe_on(platform: &'static str, config: Value) -> Probe {
        // a sheets case (`sheetsViews`) calls from a sheets view
        let surface = if config.get("sheetsViews").is_some() {
            Surface::Sheets
        } else {
            Surface::Docs
        };
        let mut probe = Probe::new(config, vec![sender(VIEW, surface)]);
        let provided = probe.registry.provided.clone();
        let cx = Rc::new(Ctx::new(&probe.services, provided.clone()).unwrap());
        let mut registry = FakeRegistry {
            provided,
            ..FakeRegistry::default()
        };
        register_on(&mut registry, &cx, platform).unwrap();
        probe.registry = registry;
        probe
    }

    fn call(probe: &Probe, channel: &str, args: Vec<Value>) -> Reply {
        let args = args
            .iter()
            .map(|v| {
                if v.is_null() {
                    IpcValue::Undefined
                } else {
                    from_serde(v)
                }
            })
            .collect();
        let from = probe.services.views.sender_of(ViewId(VIEW)).unwrap();
        probe.call(from, channel, args)
    }

    fn answer_of(reply: Reply) -> Value {
        to_serde(&reply.expect("the invoke resolved")).expect("not undefined")
    }

    fn run(
        platform: &'static str,
        config: Value,
        channel: &str,
        args: Vec<Value>,
    ) -> (Probe, Value) {
        let probe = probe_on(platform, config);
        let reply = answer_of(call(&probe, channel, args));
        (probe, reply)
    }

    /// The JSON a fake window logged after `prefix`, the first such call
    fn logged(calls: &[String], prefix: &str) -> Value {
        let line = calls
            .iter()
            .find(|c| c.starts_with(prefix))
            .unwrap_or_else(|| panic!("no `{prefix}` in {calls:?}"));
        serde_json::from_str(&line[prefix.len()..]).unwrap()
    }

    fn has(calls: &[String], prefix: &str) -> bool {
        calls.iter().any(|c| c.starts_with(prefix))
    }

    /// The host calls so far, without forgetting them
    fn peek(probe: &Probe) -> Vec<String> {
        probe.peek_calls()
    }

    fn temp_is_empty(probe: &Probe) -> bool {
        std::fs::read_dir(probe.root().join("temp"))
            .unwrap()
            .next()
            .is_none()
    }

    fn rejected(reply: Reply) -> IpcError {
        reply.expect_err("the invoke rejected")
    }

    fn refused(reason: &str) -> Value {
        json!({ "success": false, "failureReason": reason })
    }

    const CUPS_OK: &str = r#"{ "commands": { "/usr/bin/lp": { "code": 0, "stdout": "request id is q-1", "stderr": "" } } }"#;

    fn cups(extra: Value) -> Value {
        let mut config: Value = serde_json::from_str(CUPS_OK).unwrap();
        for (k, v) in extra.as_object().unwrap() {
            config[k] = v.clone();
        }
        config
    }

    #[test]
    fn the_platform_is_named_as_node_names_it() {
        assert!(["darwin", "win32", "linux", "freebsd"].contains(&platform()));
        assert!(!longer_than("aaa", 3));
        assert!(longer_than("aaaa", 3));
        // three bytes, one UTF-16 unit each
        assert!(!longer_than("\u{20ac}\u{20ac}\u{20ac}", 3));
        assert!(longer_than("\u{20ac}\u{20ac}\u{20ac}\u{20ac}", 3));
    }

    // ---- printers ----

    #[test]
    fn printers_without_a_display_name_show_their_name() {
        let config = json!({ "printers": [
            { "name": "q", "displayName": "" },
            { "name": "r", "displayName": "Room R" },
        ] });
        for channel in ["docs:printers", "slides:printers"] {
            let (_, reply) = run("linux", config.clone(), channel, vec![]);
            assert_eq!(
                reply,
                json!([{ "name": "q", "displayName": "q" }, { "name": "r", "displayName": "Room R" }]),
                "{channel}"
            );
        }
        let (_, none) = run("linux", json!({ "printers": [] }), "docs:printers", vec![]);
        assert_eq!(none, json!([]));
    }

    // ---- docs ----

    #[test]
    fn docs_print_hands_the_options_to_the_senders_own_contents() {
        let paper = json!({ "widthTwips": 11906, "heightTwips": 16838 });
        let (probe, reply) = run(
            "linux",
            json!({}),
            "docs:print",
            vec![json!(1.5), Value::Null, paper],
        );
        assert_eq!(reply, json!({ "ok": true }));
        let expected = from_serde(&json!({
            "margins": { "marginType": "none" },
            "scaleFactor": 150,
            "silent": false,
            "pageSize": { "width": 210009, "height": 297004 },
        }));
        assert_eq!(
            probe.take_calls(),
            vec![format!("contentsPrint 1 {expected:?}")]
        );
    }

    #[test]
    fn docs_print_cancel_keeps_the_dialog_open_only_when_it_is_interactive() {
        let canceled = json!({ "print": refused("Print job canceled") });
        let (_, interactive) = run("linux", canceled.clone(), "docs:print", vec![]);
        assert_eq!(interactive, json!({ "ok": false }));
        let job = json!({ "deviceName": "office" });
        let (_, silent) = run(
            "linux",
            canceled,
            "docs:print",
            vec![Value::Null, job.clone()],
        );
        assert_eq!(
            silent,
            json!({ "ok": false, "error": "Print job canceled" })
        );
        let (_, no_reason) = run(
            "linux",
            json!({ "print": { "success": false, "failureReason": "" } }),
            "docs:print",
            vec![Value::Null, job],
        );
        assert_eq!(no_reason, json!({ "ok": false }));
    }

    #[test]
    fn docs_print_a_named_printer_on_macos_spools_through_cups() {
        let job = json!({ "deviceName": "office", "copies": 2, "duplex": "longEdge" });
        let paper = json!({ "widthTwips": 11906, "heightTwips": 16838 });
        let (probe, reply) = run(
            "darwin",
            cups(json!({})),
            "docs:print",
            vec![json!(2), job.clone(), paper],
        );
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        let pdf = from_serde(&json!({
            "printBackground": true,
            "margins": { "top": 0, "bottom": 0, "left": 0, "right": 0 },
            "pageSize": { "width": 11906.0 / 1440.0, "height": 16838.0 / 1440.0 },
            "scale": 2,
        }));
        assert_eq!(
            calls,
            vec![
                format!("contentsPrintToPDF 1 {pdf:?}"),
                "execFile /usr/bin/lp -d office -n 2 -o sides=two-sided-long-edge 9".to_owned(),
            ]
        );

        let failing = cups(
            json!({ "commands": { "/usr/bin/lp": { "code": 1, "stderr": "lp: no such queue\n" } } }),
        );
        let (_, refused) = run(
            "darwin",
            failing,
            "docs:print",
            vec![Value::Null, job.clone()],
        );
        assert_eq!(
            refused,
            json!({ "ok": false, "error": "lp: no such queue" })
        );

        // not silent: the system dialog, not lp
        let (probe, reply) = run("darwin", cups(json!({})), "docs:print", vec![]);
        assert_eq!(reply, json!({ "ok": true }));
        assert!(!has(&probe.take_calls(), "execFile "));

        // printToPDF rejecting rejects the invoke
        let probe = probe_on(
            "darwin",
            cups(json!({ "pdfError": "Failed to generate PDF" })),
        );
        let err = rejected(call(&probe, "docs:print", vec![Value::Null, job]));
        assert_eq!(err.message, "Failed to generate PDF");
    }

    #[test]
    fn docs_print_a_silent_job_off_macos_goes_to_print_with_the_job() {
        let job = json!({ "deviceName": "", "copies": 3, "collate": true, "pageSizeIn": { "width": 8, "height": 11 } });
        let (probe, reply) = run("linux", json!({}), "docs:print", vec![Value::Null, job]);
        assert_eq!(reply, json!({ "ok": true }));
        let expected = from_serde(&json!({
            "margins": { "marginType": "none" },
            "silent": true,
            "pageSizeIn": { "width": 8, "height": 11 },
            "pageSize": { "width": 203200, "height": 279400 },
            "copies": 3,
            "collate": true,
        }));
        assert_eq!(
            probe.take_calls(),
            vec![format!("contentsPrint 1 {expected:?}")]
        );
    }

    #[test]
    fn docs_print_pdf_buffer_answers_the_pages_as_base64() {
        let (probe, reply) = run(
            "linux",
            json!({}),
            "docs:print-pdf-buffer",
            vec![json!(11906), json!(16838), json!(0.5)],
        );
        assert_eq!(reply, json!({ "ok": true, "base64": "JVBERi1mYWtl" }));
        let options = from_serde(&json!({
            "printBackground": true,
            "pageSize": { "width": 11906.0 / 1440.0, "height": 16838.0 / 1440.0 },
            "margins": { "top": 0, "bottom": 0, "left": 0, "right": 0 },
            "scale": 0.5,
        }));
        assert_eq!(
            probe.take_calls(),
            vec![format!("contentsPrintToPDF 1 {options:?}")]
        );

        let (probe, no_scale) = run(
            "linux",
            json!({}),
            "docs:print-pdf-buffer",
            vec![json!(144), json!(72000)],
        );
        assert_eq!(no_scale["ok"], true);
        assert!(!probe.take_calls()[0].contains("scale"));
    }

    #[test]
    fn docs_print_pdf_buffer_refuses_geometry_chromium_must_not_see() {
        for args in [
            vec![json!(143), json!(1000)],
            vec![json!(1000), json!(72001)],
            vec![json!(1000), json!(1000), json!(6)],
            vec![json!(1000), json!(1000), json!(0.05)],
            vec![json!("1000"), json!(1000)],
            vec![json!(1000), json!(1000), Value::Null],
        ] {
            let probe = probe_on("linux", json!({}));
            // an explicit null scale is not `undefined`
            let mut ipc: Vec<IpcValue> = args.iter().map(from_serde).collect();
            if args.len() == 3 && args[2].is_null() {
                ipc[2] = IpcValue::Null;
            }
            let reply = probe.call(sender(VIEW, Surface::Docs), "docs:print-pdf-buffer", ipc);
            assert_eq!(
                answer_of(reply),
                json!({ "ok": false, "error": "invalid page size or scale" }),
                "{args:?}"
            );
            assert!(probe.take_calls().is_empty());
        }
        let (_, failed) = run(
            "linux",
            json!({ "pdfError": "Printing failed" }),
            "docs:print-pdf-buffer",
            vec![json!(1000), json!(1000)],
        );
        assert_eq!(
            failed,
            json!({ "ok": false, "error": "Error: Printing failed" })
        );
    }

    // ---- html ----

    #[test]
    fn html_print_html_prints_in_a_scripted_window_and_cleans_up() {
        let (probe, reply) = run(
            "linux",
            json!({}),
            "html:print-html",
            vec![json!({ "html": "<p>hi</p>" })],
        );
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        assert_eq!(calls[0], "new BrowserWindow scripted");
        assert!(
            calls[1].starts_with("win.loadFile print.html "),
            "{}",
            calls[1]
        );
        assert_eq!(calls[2], "win.webContents.executeJavaScript");
        assert_eq!(
            logged(&calls, "win.webContents.print "),
            json!({ "silent": false, "printBackground": true })
        );
        assert_eq!(calls.last().unwrap(), "win.destroy");
        assert!(temp_is_empty(&probe));
    }

    #[test]
    fn html_print_html_tells_a_cancel_from_a_failure_by_the_exact_reason() {
        let ask = |print: Value| {
            run(
                "linux",
                json!({ "print": print }),
                "html:print-html",
                vec![json!({ "html": "x" })],
            )
            .1
        };
        assert_eq!(
            ask(refused("Print job canceled")),
            json!({ "ok": true, "canceled": true })
        );
        // only the exact text is a cancel here
        assert_eq!(
            ask(refused("user canceled")),
            json!({ "ok": false, "error": "user canceled" })
        );
        assert_eq!(
            ask(refused("")),
            json!({ "ok": false, "error": "the print job failed" })
        );
    }

    #[test]
    fn html_print_html_shows_the_window_on_windows_and_rejects_bad_requests() {
        let (probe, _) = run(
            "win32",
            json!({}),
            "html:print-html",
            vec![json!({ "html": "x" })],
        );
        let calls = probe.take_calls();
        let at = |name: &str| calls.iter().position(|c| c == name).unwrap();
        assert!(
            at("win.webContents.executeJavaScript") < at("win.show")
                && at("win.show") < at("win.focus")
        );
        assert!(
            at("win.focus")
                < calls
                    .iter()
                    .position(|c| c.starts_with("win.webContents.print "))
                    .unwrap()
        );

        for request in [json!({ "html": 5 }), json!({}), json!("<p>"), Value::Null] {
            let (probe, reply) = run("linux", json!({}), "html:print-html", vec![request]);
            assert_eq!(
                reply,
                json!({ "ok": false, "error": "html: bad print request" })
            );
            assert!(probe.take_calls().is_empty());
        }
        let (probe, failed) = run(
            "linux",
            json!({ "loadError": "ERR_FILE_NOT_FOUND" }),
            "html:print-html",
            vec![json!({ "html": "x" })],
        );
        assert_eq!(
            failed,
            json!({ "ok": false, "error": "ERR_FILE_NOT_FOUND" })
        );
        assert!(temp_is_empty(&probe));
    }

    #[test]
    fn html_print_preview_answers_the_pdf_or_null() {
        let config = json!({ "htmlPaths": { "1": "/docs/a.html" } });
        let (probe, _) = run(
            "linux",
            config,
            "html:print-preview",
            vec![json!({ "html": "<p>x</p>" })],
        );
        let probe_calls = probe.take_calls();
        assert_eq!(probe_calls[0], "new BrowserWindow static");
        assert_eq!(
            logged(&probe_calls, "win.webContents.printToPDF "),
            json!({
                "pageSize": "A4",
                "printBackground": true,
                "margins": { "top": 0.6, "bottom": 0.6, "left": 0.6, "right": 0.6 },
            })
        );
        assert_eq!(probe_calls.last().unwrap(), "win.destroy");
        assert!(temp_is_empty(&probe));
    }

    #[test]
    fn html_print_preview_is_bytes_on_success_and_null_when_anything_fails() {
        let probe = probe_on("linux", json!({}));
        let ok = call(&probe, "html:print-preview", vec![json!({ "html": "" })]).unwrap();
        assert_eq!(
            ok,
            IpcValue::Bytes(BytesKind::Uint8Array, b"%PDF-fake".to_vec())
        );

        let probe = probe_on("linux", json!({ "pdfError": "no pdf" }));
        let failed = call(&probe, "html:print-preview", vec![json!({ "html": "x" })]).unwrap();
        assert_eq!(failed, IpcValue::Null);
        assert!(has(&probe.take_calls(), "win.destroy"));
        assert!(temp_is_empty(&probe));

        for request in [json!({ "html": 1 }), json!({}), Value::Null] {
            let probe = probe_on("linux", json!({}));
            assert_eq!(
                call(&probe, "html:print-preview", vec![request]).unwrap(),
                IpcValue::Null
            );
            assert!(probe.take_calls().is_empty());
        }
    }

    // ---- hwp ----

    fn hwp_job(mode: &str) -> Value {
        json!({
            "mode": mode,
            "pages": [{ "svg": "<svg></svg>", "width": 794, "height": 1123 }],
            "images": [],
        })
    }

    /// A folder of the test's own, for the PDFs the handler writes
    struct Out(PathBuf);

    impl Out {
        fn new(name: &str) -> Out {
            let dir = std::env::temp_dir()
                .join(format!("shell-ipc-m-print-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Out(dir)
        }

        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for Out {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn hwp_pdf_goes_where_the_save_dialog_points_and_is_shown_in_the_folder() {
        let out = Out::new("hwp-dialog");
        let config =
            json!({ "hwpPaths": { "1": "/docs/Report.hwpx" }, "savePath": out.path("picked") });
        let (probe, reply) = run("linux", config, "hwp:print-pages", vec![hwp_job("pdf")]);
        let target = out.path("picked.pdf");
        assert_eq!(reply, json!({ "ok": true, "path": target }));
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-fake");
        let calls = probe.take_calls();
        assert!(
            calls.contains(&"saveDialog /docs/Report.pdf".to_owned()),
            "{calls:?}"
        );
        assert!(calls.contains(&format!("openGeneratedPath {target}")));
        // the runtime did not open it, so the file manager does
        assert!(calls.contains(&format!("showItemInFolder {target}")));
        assert_eq!(
            logged(&calls, "win.webContents.printToPDF "),
            json!({
                "preferCSSPageSize": true,
                "printBackground": true,
                "margins": { "top": 0, "bottom": 0, "left": 0, "right": 0 },
            })
        );
        assert!(temp_is_empty(&probe));
    }

    #[test]
    fn hwp_pdf_offers_the_untitled_name_and_a_cancel_writes_nothing() {
        let (probe, reply) = run(
            "linux",
            json!({ "defaultSaveDir": "/saved" }),
            "hwp:print-pages",
            vec![hwp_job("pdf")],
        );
        assert_eq!(reply, json!({ "ok": true, "canceled": true }));
        let calls = probe.take_calls();
        assert_eq!(calls, vec!["saveDialog /saved/Untitled.pdf".to_owned()]);
    }

    #[test]
    fn hwp_pdf_stays_silent_when_headless_and_keeps_an_own_pdf_extension() {
        let out = Out::new("hwp-headless");
        let config = json!({ "headless": true, "savePath": out.path("report.PDF") });
        let (probe, reply) = run("linux", config, "hwp:print-pages", vec![hwp_job("pdf")]);
        assert_eq!(reply, json!({ "ok": true, "path": out.path("report.PDF") }));
        let calls = probe.take_calls();
        assert!(!has(&calls, "openGeneratedPath") && !has(&calls, "showItemInFolder"));
    }

    #[test]
    fn hwp_pdf_to_a_path_save_as_picked_takes_the_grant_once() {
        let out = Out::new("hwp-grant");
        let target = out.path("granted.pdf");
        let probe = probe_on(
            "linux",
            json!({ "headless": true, "hwpGrants": { "1": target } }),
        );
        let options = json!({ "path": target });
        let reply = answer_of(call(
            &probe,
            "hwp:print-pages",
            vec![hwp_job("pdf"), options.clone()],
        ));
        assert_eq!(reply, json!({ "ok": true, "path": target }));
        assert!(std::fs::metadata(&target).is_ok());
        // no dialog was asked for
        assert!(!has(&peek(&probe), "saveDialog"));
        let again = answer_of(call(
            &probe,
            "hwp:print-pages",
            vec![hwp_job("pdf"), options],
        ));
        assert_eq!(
            again,
            json!({ "ok": false, "error": "hwp: this PDF path was not picked in Save As" })
        );
    }

    #[test]
    fn hwp_refuses_a_path_that_was_not_picked_or_is_not_for_a_pdf() {
        let out = Out::new("hwp-refuse");
        let target = out.path("granted.pdf");
        let config = json!({ "hwpGrants": { "1": target } });
        let not_picked =
            json!({ "ok": false, "error": "hwp: this PDF path was not picked in Save As" });
        for (job, options) in [
            (hwp_job("pdf"), json!({ "path": out.path("other.pdf") })),
            (hwp_job("print"), json!({ "path": target })),
            (hwp_job("pdf"), json!({ "path": 5 })),
            (hwp_job("pdf"), json!({ "path": null })),
        ] {
            let (probe, reply) = run(
                "linux",
                config.clone(),
                "hwp:print-pages",
                vec![job, options],
            );
            assert_eq!(reply, not_picked);
            assert!(!has(&probe.take_calls(), "printWindow"));
        }
        assert!(std::fs::metadata(&target).is_err());
    }

    #[test]
    fn hwp_print_mode_answers_ok_even_when_the_user_cancels() {
        let (probe, reply) = run(
            "linux",
            json!({}),
            "hwp:print-pages",
            vec![hwp_job("print")],
        );
        assert_eq!(reply, json!({ "ok": true }));
        assert_eq!(
            logged(&probe.take_calls(), "win.webContents.print "),
            json!({ "silent": false, "printBackground": true, "margins": { "marginType": "none" } })
        );
        let (_, canceled) = run(
            "linux",
            json!({ "print": refused("Print job canceled") }),
            "hwp:print-pages",
            vec![hwp_job("print")],
        );
        assert_eq!(canceled, json!({ "ok": true }));
        let (_, offline) = run(
            "linux",
            json!({ "print": refused("Printer offline") }),
            "hwp:print-pages",
            vec![hwp_job("print")],
        );
        assert_eq!(offline, json!({ "ok": false, "error": "Printer offline" }));
        let (_, silent) = run(
            "linux",
            json!({ "print": refused("") }),
            "hwp:print-pages",
            vec![hwp_job("print")],
        );
        assert_eq!(silent, json!({ "ok": false, "error": "print failed" }));
    }

    #[test]
    fn hwp_validates_the_job_and_prints_one_job_per_view() {
        for (job, why) in [
            (Value::Null, "not a print job"),
            (json!({ "mode": "x", "pages": [] }), "unknown print mode"),
            (json!({ "mode": "pdf", "pages": [] }), "no pages"),
            (
                json!({ "mode": "pdf", "pages": [{ "svg": "<svg/>", "width": 1, "height": 1 }], "images": [1] }),
                "bad pictures",
            ),
            (
                json!({ "mode": "pdf", "pages": [{ "svg": "<div/>", "width": 1, "height": 1 }], "images": [] }),
                "bad page",
            ),
            (
                json!({ "mode": "pdf", "pages": [{ "svg": "<svg/>", "width": 0, "height": 1 }], "images": [] }),
                "bad page size",
            ),
        ] {
            let (probe, reply) = run("linux", json!({}), "hwp:print-pages", vec![job]);
            assert_eq!(
                reply,
                json!({ "ok": false, "error": format!("hwp: {why}") })
            );
            assert!(probe.take_calls().is_empty());
        }

        let probe = probe_on("linux", json!({}));
        let state = probe.services.hosts.get::<MStateRef>().unwrap().clone();
        assert!(state.begin_print(true, ViewId(VIEW)));
        let busy = answer_of(call(&probe, "hwp:print-pages", vec![hwp_job("print")]));
        assert_eq!(
            busy,
            json!({ "ok": false, "error": "hwp: already printing" })
        );
        state.end_print(true, ViewId(VIEW));
        let free = answer_of(call(&probe, "hwp:print-pages", vec![hwp_job("print")]));
        assert_eq!(free, json!({ "ok": true }));
        // and the job releases the view when it ends
        assert!(state.begin_print(true, ViewId(VIEW)));
    }

    // ---- markdown ----

    #[test]
    fn markdown_print_preview_renders_the_normalized_options() {
        let request = json!({ "html": "<p>x</p>", "options": { "pageSize": "Letter", "landscape": true, "marginIn": 9 } });
        let (probe, reply) = run("linux", json!({}), "markdown:print-preview", vec![request]);
        assert_eq!(reply["ok"], true);
        let calls = probe.take_calls();
        assert_eq!(calls[0], "new BrowserWindow static");
        assert_eq!(
            logged(&calls, "win.webContents.printToPDF "),
            json!({
                "pageSize": "Letter",
                "printBackground": true,
                "landscape": true,
                "margins": { "top": 0.6, "bottom": 0.6, "left": 0.6, "right": 0.6 },
            })
        );
        let probe = probe_on("linux", json!({}));
        let bytes = call(
            &probe,
            "markdown:print-preview",
            vec![json!({ "html": "x", "options": "Letter" })],
        )
        .unwrap();
        assert_eq!(
            bytes,
            object([
                ("ok", IpcValue::Bool(true)),
                (
                    "pdf",
                    IpcValue::Bytes(BytesKind::Uint8Array, b"%PDF-fake".to_vec())
                ),
            ])
        );
        let defaults = logged(&probe.take_calls(), "win.webContents.printToPDF ");
        assert_eq!(defaults["pageSize"], "A4");
        assert_eq!(defaults["landscape"], false);
    }

    #[test]
    fn markdown_print_preview_refuses_what_is_not_a_document_and_reports_failures() {
        let bad = json!({ "ok": false, "error": "markdown: bad print preview request" });
        for request in [
            json!({ "html": "" }),
            json!({ "html": 5 }),
            json!({}),
            Value::Null,
        ] {
            let (probe, reply) = run("linux", json!({}), "markdown:print-preview", vec![request]);
            assert_eq!(reply, bad);
            assert!(probe.take_calls().is_empty());
        }
        let (_, too_long) = run(
            "linux",
            json!({}),
            "markdown:print-preview",
            vec![json!({ "html": "a".repeat(50_000_001) })],
        );
        assert_eq!(too_long, bad);
        let (probe, failed) = run(
            "linux",
            json!({ "pdfError": "no pdf" }),
            "markdown:print-preview",
            vec![json!({ "html": "x" })],
        );
        assert_eq!(failed, json!({ "ok": false, "error": "no pdf" }));
        assert!(has(&probe.take_calls(), "win.destroy") && temp_is_empty(&probe));
    }

    #[test]
    fn markdown_print_document_maps_the_print_callback() {
        let ask = |print: Value| {
            run(
                "linux",
                json!({ "print": print }),
                "markdown:print-document",
                vec![json!({ "html": "x", "pages": null })],
            )
            .1
        };
        assert_eq!(ask(json!({ "success": true })), json!({ "ok": true }));
        // any reason with "cancel" in it is the user's cancel
        assert_eq!(
            ask(refused("The user Canceled")),
            json!({ "ok": true, "canceled": true })
        );
        assert_eq!(
            ask(refused("Printer offline")),
            json!({ "ok": false, "error": "Printer offline" })
        );
        assert_eq!(
            ask(refused("")),
            json!({ "ok": false, "error": "print failed" })
        );
    }

    #[test]
    fn markdown_print_document_prints_one_range_with_custom_margins() {
        let request = json!({ "html": "x", "pages": { "from": 2, "to": 3 }, "options": { "pageSize": "Letter" } });
        let (probe, reply) = run("linux", json!({}), "markdown:print-document", vec![request]);
        assert_eq!(reply, json!({ "ok": true }));
        assert_eq!(
            logged(&probe.take_calls(), "win.webContents.print "),
            json!({
                "silent": false,
                "printBackground": true,
                "pageSize": "Letter",
                "landscape": false,
                "margins": { "marginType": "custom", "top": 0.6, "bottom": 0.6, "left": 0.6, "right": 0.6 },
                "header": "",
                "footer": "",
                "pageRanges": [{ "from": 2, "to": 3 }],
            })
        );
        let (probe, all) = run(
            "linux",
            json!({}),
            "markdown:print-document",
            vec![json!({ "html": "x", "pages": null })],
        );
        assert_eq!(all, json!({ "ok": true }));
        assert!(
            logged(&probe.take_calls(), "win.webContents.print ")
                .get("pageRanges")
                .is_none()
        );
    }

    #[test]
    fn markdown_print_document_validates_the_range_and_one_job_per_view() {
        let bad_range = json!({ "ok": false, "error": "markdown: bad print range" });
        for pages in [
            json!({ "from": 0, "to": 1 }),
            json!({ "from": 3, "to": 2 }),
            json!({ "from": 1.5, "to": 2 }),
            json!({ "from": "1", "to": 2 }),
            json!({ "from": 1 }),
            json!(5),
            json!([]),
        ] {
            let (probe, reply) = run(
                "linux",
                json!({}),
                "markdown:print-document",
                vec![json!({ "html": "x", "pages": pages })],
            );
            assert_eq!(reply, bad_range, "{pages}");
            assert!(probe.take_calls().is_empty());
        }
        // a missing range is not null either
        let (_, missing) = run(
            "linux",
            json!({}),
            "markdown:print-document",
            vec![json!({ "html": "x" })],
        );
        assert_eq!(missing, bad_range);
        let (_, no_html) = run(
            "linux",
            json!({}),
            "markdown:print-document",
            vec![json!({ "html": "", "pages": null })],
        );
        assert_eq!(
            no_html,
            json!({ "ok": false, "error": "markdown: bad print request" })
        );

        let probe = probe_on("linux", json!({}));
        let state = probe.services.hosts.get::<MStateRef>().unwrap().clone();
        assert!(state.begin_print(false, ViewId(VIEW)));
        let busy = answer_of(call(
            &probe,
            "markdown:print-document",
            vec![json!({ "html": "x", "pages": null })],
        ));
        assert_eq!(
            busy,
            json!({ "ok": false, "error": "markdown: already printing" })
        );
        state.end_print(false, ViewId(VIEW));
        assert_eq!(
            answer_of(call(
                &probe,
                "markdown:print-document",
                vec![json!({ "html": "x", "pages": null })]
            )),
            json!({ "ok": true })
        );
        assert!(state.begin_print(false, ViewId(VIEW)));
    }

    #[test]
    fn markdown_print_document_shows_the_window_on_windows_and_reports_a_load_failure() {
        let (probe, _) = run(
            "win32",
            json!({}),
            "markdown:print-document",
            vec![json!({ "html": "x", "pages": null })],
        );
        let calls = probe.take_calls();
        assert!(has(&calls, "win.show") && has(&calls, "win.focus"));
        let (probe, failed) = run(
            "linux",
            json!({ "loadError": "ERR_FAILED" }),
            "markdown:print-document",
            vec![json!({ "html": "x", "pages": null })],
        );
        assert_eq!(failed, json!({ "ok": false, "error": "ERR_FAILED" }));
        assert!(has(&probe.take_calls(), "win.destroy") && temp_is_empty(&probe));
    }

    // ---- mindmap ----

    #[test]
    fn mindmap_print_adds_landscape_a4_to_every_print_call() {
        let (probe, reply) = run(
            "linux",
            json!({}),
            "mindmap:print",
            vec![json!({ "html": "<svg/>" })],
        );
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        assert_eq!(calls[0], "new BrowserWindow mindmap-export");
        assert!(
            calls[1].starts_with("win.loadFile map.html "),
            "{}",
            calls[1]
        );
        assert_eq!(
            logged(&calls, "win.webContents.print "),
            json!({
                "silent": false,
                "printBackground": true,
                "landscape": true,
                "pageSize": "A4",
                "margins": { "marginType": "none" },
            })
        );
    }

    #[test]
    fn mindmap_print_forwards_a_cancel_and_refuses_bad_requests() {
        let (_, canceled) = run(
            "linux",
            json!({ "print": refused("Print job canceled") }),
            "mindmap:print",
            vec![json!({ "html": "x" })],
        );
        assert_eq!(canceled, json!({ "ok": true, "canceled": true }));
        let bad = json!({ "ok": false, "error": "mindmap: bad print request" });
        for request in [
            json!({ "html": "" }),
            json!({ "html": 1 }),
            json!([]),
            Value::Null,
            json!("html"),
        ] {
            let (probe, reply) = run("linux", json!({}), "mindmap:print", vec![request]);
            assert_eq!(reply, bad);
            assert!(probe.take_calls().is_empty());
        }
    }

    // ---- diagram ----

    fn page() -> Value {
        json!({ "svg": "<svg></svg>", "width": 400, "height": 300, "pageWidth": 827, "pageHeight": 1169 })
    }

    #[test]
    fn diagram_print_loads_the_held_document_by_token_and_drops_it() {
        let (probe, reply) = run(
            "linux",
            json!({}),
            "diagram:print",
            vec![json!({ "pages": [page()], "title": "Plan" })],
        );
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        assert_eq!(calls[0], "new BrowserWindow diagram");
        // the token after the last slash is random
        assert!(
            calls[1].starts_with("win.loadURL drawio-app://editor/__ieum/print "),
            "{}",
            calls[1]
        );
        assert_eq!(
            logged(&calls, "win.webContents.print "),
            json!({ "silent": false, "printBackground": true })
        );
        assert_eq!(calls.last().unwrap(), "win.destroy");

        // what the shell's protocol takes is served once
        DIAGRAM_DOCUMENTS
            .lock()
            .unwrap()
            .hold_print_document("<html>", "feed".to_owned());
        assert_eq!(
            take_diagram_print_document("feed").as_deref(),
            Some("<html>")
        );
        assert_eq!(take_diagram_print_document("feed"), None);
    }

    #[test]
    fn diagram_print_cancel_is_any_reason_with_cancel_in_it() {
        let ask = |print: Value| {
            run(
                "linux",
                json!({ "print": print }),
                "diagram:print",
                vec![json!({ "pages": [page()] })],
            )
            .1
        };
        assert_eq!(
            ask(refused("Print job canceled")),
            json!({ "ok": true, "canceled": true })
        );
        assert_eq!(
            ask(refused("User CANCELLED it")),
            json!({ "ok": true, "canceled": true })
        );
        assert_eq!(
            ask(refused("Printer offline")),
            json!({ "ok": false, "error": "Printer offline" })
        );
        assert_eq!(
            ask(refused("")),
            json!({ "ok": false, "error": "the print job failed" })
        );
    }

    #[test]
    fn diagram_print_refuses_bad_pages_and_reports_a_load_failure() {
        let bad = json!({ "ok": false, "error": "bad print pages" });
        let mut no_svg = page();
        no_svg["svg"] = json!("<div></div>");
        let mut text_width = page();
        text_width["width"] = json!("400");
        for request in [
            Value::Null,
            json!({}),
            json!({ "pages": [] }),
            json!({ "pages": "x" }),
            json!({ "pages": [page(), no_svg] }),
            json!({ "pages": [text_width] }),
        ] {
            let (probe, reply) = run("linux", json!({}), "diagram:print", vec![request]);
            assert_eq!(reply, bad);
            assert!(probe.take_calls().is_empty());
        }
        let (probe, failed) = run(
            "linux",
            json!({ "loadError": "ERR_ABORTED" }),
            "diagram:print",
            vec![json!({ "pages": [page()] })],
        );
        assert_eq!(failed, json!({ "ok": false, "error": "ERR_ABORTED" }));
        let calls = probe.take_calls();
        assert!(has(&calls, "win.destroy") && !has(&calls, "win.webContents.print "));
    }

    #[test]
    fn diagram_print_shows_the_window_on_windows() {
        let (probe, _) = run(
            "win32",
            json!({}),
            "diagram:print",
            vec![json!({ "pages": [page()] })],
        );
        let calls = probe.take_calls();
        assert!(has(&calls, "win.show") && has(&calls, "win.focus"));
    }

    // ---- slides ----

    const LPOPTIONS: &str = "cupsPrintQuality/Print Quality: Draft *Normal\nPageSize/Media Size: *A4 Letter\nColorModel/Color Mode: *RGB Gray\n";

    #[test]
    fn slides_printer_options_keeps_the_groups_the_dialog_presents() {
        let config =
            json!({ "commands": { "/usr/bin/lpoptions": { "code": 0, "stdout": LPOPTIONS } } });
        let (probe, reply) = run(
            "linux",
            config,
            "slides:printer-options",
            vec![json!("office_1")],
        );
        assert_eq!(
            reply,
            json!([
                { "name": "cupsPrintQuality", "translation": "Print Quality", "values": ["Draft", "Normal"], "defaultValue": "Normal" },
                { "name": "ColorModel", "translation": "Color Mode", "values": ["RGB", "Gray"], "defaultValue": "RGB" },
            ])
        );
        assert_eq!(
            probe.take_calls(),
            vec!["execFile /usr/bin/lpoptions -p office_1 -l 0".to_owned()]
        );
    }

    #[test]
    fn slides_printer_options_answers_nothing_for_a_bad_queue_or_a_failing_tool() {
        let config =
            json!({ "commands": { "/usr/bin/lpoptions": { "code": 0, "stdout": LPOPTIONS } } });
        for queue in [
            json!("a b"),
            json!(""),
            json!("x".repeat(129)),
            json!(5),
            Value::Null,
        ] {
            let (probe, reply) = run(
                "linux",
                config.clone(),
                "slides:printer-options",
                vec![queue],
            );
            assert_eq!(reply, json!([]));
            assert!(probe.take_calls().is_empty());
        }
        let (_, missing) = run(
            "linux",
            json!({}),
            "slides:printer-options",
            vec![json!("office")],
        );
        assert_eq!(missing, json!([]));
        let failing =
            json!({ "commands": { "/usr/bin/lpoptions": { "code": 1, "stdout": LPOPTIONS } } });
        assert_eq!(
            run(
                "linux",
                failing,
                "slides:printer-options",
                vec![json!("office")]
            )
            .1,
            json!([])
        );
        let (_, long_ok) = run(
            "linux",
            json!({ "commands": { "/usr/bin/lpoptions": { "code": 0, "stdout": LPOPTIONS } } }),
            "slides:printer-options",
            vec![json!("x".repeat(128))],
        );
        assert_eq!(long_ok.as_array().unwrap().len(), 2);
    }

    fn op(extra: Value) -> Value {
        let mut op = json!({ "pngsBase64": ["QUJD"], "widthPx": 1600, "heightPx": 900 });
        for (k, v) in extra.as_object().unwrap() {
            op[k] = v.clone();
        }
        op
    }

    #[test]
    fn slides_print_dialog_cancel_is_a_bare_not_ok() {
        let (probe, reply) = run("linux", json!({}), "slides:print", vec![op(json!({}))]);
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        assert_eq!(calls[0], "new BrowserWindow scripted");
        assert_eq!(
            logged(&calls, "win.webContents.print "),
            json!({ "silent": false, "printBackground": true })
        );
        assert!(temp_is_empty(&probe));

        let ask = |print: Value| {
            run(
                "linux",
                json!({ "print": print }),
                "slides:print",
                vec![op(json!({}))],
            )
            .1
        };
        assert_eq!(ask(refused("Print job canceled")), json!({ "ok": false }));
        assert_eq!(
            ask(refused("Printer offline")),
            json!({ "ok": false, "error": "Printer offline" })
        );
        assert_eq!(
            ask(refused("")),
            json!({ "ok": false, "error": "the print job failed" })
        );
    }

    #[test]
    fn slides_print_a_named_printer_off_macos_prints_with_the_job_options() {
        let job = json!({ "deviceName": "office", "copies": 2, "duplex": "shortEdge", "driverOptions": [{ "name": "ColorModel", "value": "Gray" }] });
        let (probe, reply) = run(
            "linux",
            json!({}),
            "slides:print",
            vec![op(json!({ "job": job.clone() }))],
        );
        assert_eq!(reply, json!({ "ok": true }));
        assert_eq!(
            logged(&probe.take_calls(), "win.webContents.print "),
            json!({
                "silent": true,
                "deviceName": "office",
                "copies": 2,
                "duplexMode": "shortEdge",
                "driverOptions": [{ "name": "ColorModel", "value": "Gray" }],
                "printBackground": true,
            })
        );
        // a silent job keeps the cancel as an error: no dialog is left to keep open
        let (_, canceled) = run(
            "linux",
            json!({ "print": refused("Print job canceled") }),
            "slides:print",
            vec![op(json!({ "job": job }))],
        );
        assert_eq!(
            canceled,
            json!({ "ok": false, "error": "Print job canceled" })
        );
    }

    #[test]
    fn slides_print_a_named_printer_on_macos_bakes_the_sheets_and_spools_them() {
        let job = json!({ "deviceName": "office", "copies": 2 });
        let (probe, reply) = run(
            "darwin",
            cups(json!({})),
            "slides:print",
            vec![op(json!({ "job": job.clone() }))],
        );
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        assert_eq!(
            logged(&calls, "win.webContents.printToPDF "),
            json!({
                "printBackground": true,
                "margins": { "top": 0, "bottom": 0, "left": 0, "right": 0 },
                "pageSize": { "width": 13.333, "height": 7.5 },
            })
        );
        assert!(calls.contains(&"execFile /usr/bin/lp -d office -n 2 9".to_owned()));
        assert!(!has(&calls, "win.webContents.print "));
        assert!(temp_is_empty(&probe));
        assert_eq!(calls.last().unwrap(), "win.destroy");

        // a handout sheet is A4 in the chosen orientation
        let handout = op(
            json!({ "job": job.clone(), "layout": "handout4", "orientation": "landscape", "notes": [] }),
        );
        let (probe, _) = run("darwin", cups(json!({})), "slides:print", vec![handout]);
        assert_eq!(
            logged(&probe.take_calls(), "win.webContents.printToPDF ")["pageSize"],
            json!({ "width": 11.69, "height": 8.27 })
        );

        let failing = cups(
            json!({ "commands": { "/usr/bin/lp": { "code": 1, "stdout": "", "stderr": "" } } }),
        );
        let (_, lp_failed) = run(
            "darwin",
            failing,
            "slides:print",
            vec![op(json!({ "job": job.clone() }))],
        );
        assert_eq!(
            lp_failed,
            json!({ "ok": false, "error": "lp exited with code 1" })
        );

        let (probe, load_failed) = run(
            "darwin",
            cups(json!({ "loadError": "ERR_FAILED" })),
            "slides:print",
            vec![op(json!({ "job": job }))],
        );
        assert_eq!(load_failed, json!({ "ok": false, "error": "ERR_FAILED" }));
        assert!(has(&probe.take_calls(), "win.destroy") && temp_is_empty(&probe));
    }

    #[test]
    fn slides_print_throws_on_an_op_the_page_assembly_cannot_read() {
        let probe = probe_on("linux", json!({}));
        let err = rejected(probe.call(sender(VIEW, Surface::Docs), "slides:print", vec![]));
        assert_eq!(err.name.as_deref(), Some("TypeError"));
        assert_eq!(
            err.message,
            "Cannot read properties of undefined (reading 'pngsBase64')"
        );
        let err = rejected(call(
            &probe,
            "slides:print",
            vec![json!({ "pngsBase64": 5 })],
        ));
        assert_eq!(err.message, "op.pngsBase64.map is not a function");
        assert!(probe.take_calls().is_empty());
    }

    // ---- workbook ----

    fn request(extra: Value) -> Value {
        let mut request = json!({
            "fileName": "Book.xlsx",
            "html": "<html><head></head><body>x</body></html>",
            "landscape": false,
            "pageSize": "A4",
            "margins": { "top": 0.5, "bottom": 0.5, "left": 0.25, "right": 0.25 },
            "scale": 1.5,
        });
        for (k, v) in extra.as_object().unwrap() {
            request[k] = v.clone();
        }
        request
    }

    fn sheets(config: Value) -> Value {
        let mut config = config;
        config["sheetsViews"] = json!([VIEW]);
        config
    }

    #[test]
    fn workbook_print_refuses_senders_that_are_not_sheet_tabs() {
        for channel in ["workbook:print", "workbook:list-printers"] {
            let probe = probe_on("linux", json!({}));
            let err = rejected(call(&probe, channel, vec![request(json!({}))]));
            assert_eq!(err.name.as_deref(), Some("Error"), "{channel}");
            assert_eq!(err.message, "Untrusted IPC sender.");
            assert!(probe.take_calls().is_empty());
        }
    }

    #[test]
    fn workbook_print_rejects_a_request_the_schema_refuses_with_a_zod_error() {
        let probe = probe_on("linux", sheets(json!({})));
        let err = rejected(call(
            &probe,
            "workbook:print",
            vec![request(json!({ "scale": 3, "extra": true }))],
        ));
        assert_eq!(err.name.as_deref(), Some("ZodError"));
        let issues: Value = serde_json::from_str(&err.message).unwrap();
        assert_eq!(issues[0]["path"], json!(["scale"]));
        assert_eq!(issues[0]["message"], "Too big: expected number to be <=2");
        assert_eq!(issues[1]["code"], "unrecognized_keys");
        let err = rejected(call(&probe, "workbook:print", vec![]));
        assert_eq!(err.name.as_deref(), Some("ZodError"));
        assert!(err.message.contains("expected object, received undefined"));
        assert!(probe.take_calls().is_empty());
    }

    #[test]
    fn workbook_print_opens_the_system_dialog_with_the_sheets_page_setup() {
        let (probe, reply) = run(
            "linux",
            sheets(json!({})),
            "workbook:print",
            vec![request(json!({ "landscape": true }))],
        );
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        assert_eq!(calls[0], "new BrowserWindow static");
        assert!(
            calls[1].starts_with("win.loadFile print.html "),
            "{}",
            calls[1]
        );
        assert_eq!(
            logged(&calls, "win.webContents.print "),
            json!({
                "silent": false,
                "printBackground": true,
                "landscape": true,
                "pageSize": "A4",
                "margins": { "marginType": "custom", "top": 48, "bottom": 48, "left": 24, "right": 24 },
                "scaleFactor": 150,
            })
        );
        assert_eq!(calls.last().unwrap(), "win.destroy");
        assert!(temp_is_empty(&probe));
    }

    #[test]
    fn workbook_print_cancel_is_only_the_exact_chromium_reason() {
        let ask = |print: Value| {
            run(
                "linux",
                sheets(json!({ "print": print })),
                "workbook:print",
                vec![request(json!({}))],
            )
            .1
        };
        assert_eq!(ask(refused("Print job canceled")), json!({ "ok": false }));
        assert_eq!(
            ask(refused("The job was canceled")),
            json!({ "ok": false, "error": "The job was canceled" })
        );
        assert_eq!(ask(refused("")), json!({ "ok": false, "error": "" }));
        // a silent job reports the exact cancel the same way
        let silent = request(json!({ "deviceName": "office" }));
        let (_, canceled) = run(
            "linux",
            sheets(json!({ "print": refused("Print job canceled") })),
            "workbook:print",
            vec![silent],
        );
        assert_eq!(canceled, json!({ "ok": false }));
    }

    #[test]
    fn workbook_print_a_named_printer_off_macos_prints_silently() {
        let named = request(
            json!({ "deviceName": "office", "copies": 3, "collate": true, "pageSize": { "width": 8.5, "height": 11 } }),
        );
        let (probe, reply) = run("linux", sheets(json!({})), "workbook:print", vec![named]);
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        let options = logged(&calls, "win.webContents.print ");
        assert_eq!(options["silent"], true);
        assert_eq!(options["deviceName"], "office");
        assert_eq!(options["copies"], 3);
        assert_eq!(
            options["pageSize"],
            json!({ "width": 215900, "height": 279400 })
        );
        assert!(!has(&calls, "win.show"));
    }

    #[test]
    fn workbook_print_a_named_printer_on_macos_spools_the_pdf_through_cups() {
        let named =
            request(json!({ "deviceName": "office", "copies": 3, "landscape": true, "scale": 1 }));
        let (probe, reply) = run(
            "darwin",
            sheets(cups(json!({}))),
            "workbook:print",
            vec![named],
        );
        assert_eq!(reply, json!({ "ok": true }));
        let calls = probe.take_calls();
        assert_eq!(
            logged(&calls, "win.webContents.printToPDF "),
            json!({
                "printBackground": true,
                "margins": { "top": 0.5, "bottom": 0.5, "left": 0.25, "right": 0.25 },
                "landscape": true,
                "pageSize": "A4",
                "preferCSSPageSize": true,
            })
        );
        assert!(calls.contains(&"execFile /usr/bin/lp -d office -n 3 9".to_owned()));
        assert!(!has(&calls, "win.webContents.print "));
        assert!(temp_is_empty(&probe));

        // the system default queue is '' and takes no -d
        let (probe, _) = run(
            "darwin",
            sheets(cups(json!({}))),
            "workbook:print",
            vec![request(json!({ "deviceName": "" }))],
        );
        assert!(
            probe
                .take_calls()
                .contains(&"execFile /usr/bin/lp  9".to_owned())
        );

        let failing = sheets(cups(
            json!({ "commands": { "/usr/bin/lp": { "code": 1, "stderr": "lp: bad queue" } } }),
        ));
        let (_, refused) = run(
            "darwin",
            failing,
            "workbook:print",
            vec![request(json!({ "deviceName": "nope" }))],
        );
        assert_eq!(refused, json!({ "ok": false, "error": "lp: bad queue" }));

        // an interactive print on macOS still goes to the dialog
        let (probe, _) = run(
            "darwin",
            sheets(cups(json!({}))),
            "workbook:print",
            vec![request(json!({}))],
        );
        assert!(!has(&probe.take_calls(), "execFile "));
    }

    #[test]
    fn workbook_print_shows_the_window_on_windows_only_for_the_dialog() {
        let (probe, _) = run(
            "win32",
            sheets(json!({})),
            "workbook:print",
            vec![request(json!({}))],
        );
        let calls = probe.take_calls();
        assert!(has(&calls, "win.show") && has(&calls, "win.focus"));
        let (probe, _) = run(
            "win32",
            sheets(json!({})),
            "workbook:print",
            vec![request(json!({ "deviceName": "office" }))],
        );
        assert!(!has(&probe.take_calls(), "win.show"));
    }

    #[test]
    fn workbook_print_reports_a_load_failure_and_removes_its_folder() {
        let (probe, reply) = run(
            "linux",
            sheets(json!({ "loadError": "ERR_FAILED" })),
            "workbook:print",
            vec![request(json!({}))],
        );
        assert_eq!(reply, json!({ "ok": false, "error": "ERR_FAILED" }));
        assert!(has(&probe.take_calls(), "win.destroy"));
        assert!(temp_is_empty(&probe));
    }

    #[test]
    fn workbook_list_printers_checks_each_entry_against_the_schema() {
        let config = sheets(
            json!({ "printers": [{ "name": "q", "displayName": "" }, { "name": "r", "displayName": "R" }] }),
        );
        let (_, reply) = run("linux", config, "workbook:list-printers", vec![]);
        assert_eq!(
            reply,
            json!([{ "name": "q", "displayName": "q" }, { "name": "r", "displayName": "R" }])
        );

        let long = sheets(json!({ "printers": [{ "name": "x".repeat(256), "displayName": "x" }] }));
        let probe = probe_on("linux", long);
        let err = rejected(call(&probe, "workbook:list-printers", vec![]));
        assert_eq!(err.name.as_deref(), Some("ZodError"));
        assert!(
            err.message
                .contains("Too big: expected string to have <=255 characters")
        );
        let edge = sheets(json!({ "printers": [{ "name": "x".repeat(255), "displayName": "" }] }));
        let (_, ok) = run("linux", edge, "workbook:list-printers", vec![]);
        assert_eq!(ok[0]["displayName"].as_str().unwrap().len(), 255);
    }

    #[test]
    fn the_template_fonts_folder_is_in_the_resources_once_packaged() {
        let probe = probe_on(
            "linux",
            json!({ "isPackaged": true, "resourcesPath": "/opt/seu/resources" }),
        );
        let env = Env::of(
            &Ctx::new(&probe.services, probe.registry.provided.clone()).unwrap(),
            "linux",
        );
        assert_eq!(
            template_fonts_dir(&env),
            "/opt/seu/resources/template-fonts"
        );
        let probe = probe_on("linux", json!({ "appPath": "/repo/apps/shell" }));
        let env = Env::of(
            &Ctx::new(&probe.services, probe.registry.provided.clone()).unwrap(),
            "linux",
        );
        assert_eq!(template_fonts_dir(&env), "/repo/packages/ui/template-fonts");
    }
}
