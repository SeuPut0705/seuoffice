//! `pdf-tools/pdf-tools-window.ts`: the PDF tools window, a small window
//! above the shell window. Paths never come from the window: inputs are
//! picked in an open dialog here and handed out as opaque ids, outputs are
//! picked in a save dialog, may not be a source, and come back as ids too.
//! One window at a time; opening it again shows it.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use jscompat::node_path::host::{basename, dirname, resolve};
use jscompat::{JsonValue, random_uuid};
use main_core::packages::electron_utils::dialog_memory::save_as_suggestion;
use main_core::pdf::atomic_write::write_pdf_atomically;
use main_core::pdf::generated_output::{exists_sync, unique_generated_pdf_path};
use shell_contract::ipc::{CallContext, Responder, Target};
use shell_contract::runtime::CancelToken;
use shell_contract::{IpcValue, ViewId};

use super::hosts::{PdfToolsEngine, ToolError};
use super::options::{self as tools, MAX_TOOL_INPUT_BYTES};
use super::runner::Progress;
use super::{Ctx, js_filter, js_str, js_strs, options};
use crate::kit::{self, Entry, IntoIpc, as_str, field, obj};

/// One picked file: what the window sees, and its path
#[derive(Clone, Debug)]
struct Picked {
    id: String,
    kind: &'static str,
    name: String,
    pages: f64,
    size: f64,
    path: String,
}

impl Picked {
    /// `PdfToolInput`
    fn input(&self) -> IpcValue {
        obj([
            ("id", self.id.clone().into_ipc()),
            ("kind", self.kind.into_ipc()),
            ("name", self.name.clone().into_ipc()),
            ("pages", self.pages.into_ipc()),
            ("size", self.size.into_ipc()),
        ])
    }
}

#[derive(Default)]
struct Inner {
    /// `win`'s view
    view: Option<ViewId>,
    running: bool,
    /// this window's inputs and outputs by id; cleared when it closes
    inputs: HashMap<String, Picked>,
    results: HashMap<String, String>,
    /// pages the blank-page search found, by input id: the only pages blankPages removes
    blank_found: HashMap<String, HashSet<u64>>,
    /// the running blank-page search's job id
    finding: Option<String>,
    /// stops the running tool when the window asks
    run_stop: Option<CancelToken>,
    /// the running add-password, remove-password or repair job's id
    running_job: Option<String>,
    /// a task the PDF editor's ribbon asked for, until the window takes it
    pending_start: Option<IpcValue>,
}

/// Why a file cannot be used, or the files read: name, pages, size, path
type Read = Result<(String, f64, f64, String), (String, String)>;

#[derive(Clone)]
pub struct Window {
    ctx: Rc<Ctx>,
    s: Rc<RefCell<Inner>>,
    _closed: Rc<dyn Fn(ViewId)>,
}

/// `pagesFor(bytes, kind, accept)`
fn pages_for(
    engine: &dyn PdfToolsEngine,
    bytes: &[u8],
    kind: &str,
    accept: &str,
) -> Result<f64, String> {
    if kind == "image" {
        return if engine.is_image(bytes) {
            Ok(1.0)
        } else {
            Err("not-image".into())
        };
    }
    match engine.inspect_pdf(bytes) {
        Ok(_) if accept == "encrypted" => Err("not-encrypted".into()),
        Ok(pages) => Ok(pages),
        Err(p) if p == "encrypted" && accept == "encrypted" => {
            Ok(engine.encrypted_page_count(bytes))
        }
        Err(p) if p == "unreadable" && accept == "damaged" => Ok(0.0),
        Err(p) => Err(p),
    }
}

/// two paths name the same file (Windows paths ignore case)
fn same_path(a: &str, b: &str) -> bool {
    let (x, y) = (resolve(&[a]), resolve(&[b]));
    if cfg!(windows) {
        x.to_lowercase() == y.to_lowercase()
    } else {
        x == y
    }
}

fn failed(error: &str) -> IpcValue {
    obj([("ok", false.into_ipc()), ("error", error.into_ipc())])
}

fn canceled() -> IpcValue {
    obj([("ok", false.into_ipc()), ("canceled", true.into_ipc())])
}

fn empty_pick() -> IpcValue {
    obj([
        ("inputs", IpcValue::Array(Vec::new())),
        ("rejected", IpcValue::Array(Vec::new())),
    ])
}

const PDF: (&str, &[&str]) = ("PDF", &["pdf"]);
const IMAGES: (&str, &[&str]) = ("JPG, PNG", &["jpg", "jpeg", "png"]);

impl Window {
    pub fn new(ctx: &Rc<Ctx>) -> Self {
        let s: Rc<RefCell<Inner>> = Rc::default();
        let weak = Rc::downgrade(&s);
        let closed = kit::on_view_destroyed(&ctx.services, move |view| {
            let Some(s) = weak.upgrade() else { return };
            let mut s = s.borrow_mut();
            if s.view == Some(view) {
                s.view = None;
                s.inputs.clear();
                s.results.clear();
                s.blank_found.clear();
            }
        });
        Window {
            ctx: ctx.clone(),
            s,
            _closed: closed,
        }
    }

    /// `win` while it is not destroyed
    fn win(&self) -> Option<ViewId> {
        self.s.borrow().view.filter(|v| self.ctx.alive(*v))
    }

    /// `fromWindow(event)`
    fn sent_by_window(&self, cx: &CallContext) -> bool {
        self.win() == Some(cx.sender.view)
    }

    /// `openPdfToolsWindow()`
    pub fn open_window(&self) {
        if let Some(view) = self.win() {
            return self.ctx.shell.show_window(view);
        }
        let lang = self.ctx.shell.lang();
        // `pdfToolsText(lang, 'windowTitle')`: Korean or the English default
        let tools = if lang == "ko" {
            "PDF 도구"
        } else {
            "PDF tools"
        };
        let product = main_core::packages::i18n::product_name(Some(&lang));
        let parent = self.ctx.main_window.window();
        let view = self
            .ctx
            .shell
            .open_tools_window(parent, &format!("{tools} - {product}"));
        self.s.borrow_mut().view = view;
    }

    /// `inputsFrom(paths, kind, accept)`: files the main process chose, read
    /// on a worker and handed out as ids
    fn inputs_from(
        &self,
        paths: Vec<String>,
        kind: &'static str,
        accept: &'static str,
        then: impl FnOnce(IpcValue, Vec<IpcValue>) + 'static,
    ) {
        let engine = self.ctx.engine.clone();
        let me = self.clone();
        kit::on_worker(
            &self.ctx.services,
            move || {
                paths
                    .into_iter()
                    .map(|path| -> Read {
                        let name = basename(&path, None);
                        let Ok(meta) = std::fs::metadata(&path) else {
                            return Err((name, "unreadable".into()));
                        };
                        if meta.len() > MAX_TOOL_INPUT_BYTES {
                            return Err((name, "too-large".into()));
                        }
                        let Ok(bytes) = std::fs::read(&path) else {
                            return Err((name, "unreadable".into()));
                        };
                        match pages_for(&*engine, &bytes, kind, accept) {
                            Ok(pages) => Ok((name, pages, meta.len() as f64, path)),
                            Err(problem) => Err((name, problem)),
                        }
                    })
                    .collect::<Vec<_>>()
            },
            move |read| {
                let (mut inputs, mut rejected) = (Vec::new(), Vec::new());
                for r in read {
                    match r {
                        Ok((name, pages, size, path)) => {
                            let p = Picked {
                                id: random_uuid(),
                                kind,
                                name,
                                pages,
                                size,
                                path,
                            };
                            inputs.push(p.input());
                            me.s.borrow_mut().inputs.insert(p.id.clone(), p);
                        }
                        Err((name, problem)) => rejected.push(obj([
                            ("name", name.into_ipc()),
                            ("problem", problem.into_ipc()),
                        ])),
                    }
                }
                then(IpcValue::Array(inputs.clone()), rejected)
            },
        )
    }

    /// `openPdfToolsWithFile(path, tool)`: the editor's ribbon opens the
    /// window on `tool` with the view's own file picked
    pub fn open_with_file(&self, path: &str, tool: &str) -> bool {
        let Some(tool) = tools::tool_id(&tool.into_ipc()) else {
            return false;
        };
        if tools::input_kind(tool) != "pdf" {
            return false;
        }
        let me = self.clone();
        self.inputs_from(
            vec![path.to_owned()],
            "pdf",
            tools::accepts(tool),
            move |inputs, rejected| {
                me.s.borrow_mut().pending_start = Some(obj([
                    ("tool", tool.into_ipc()),
                    ("inputs", inputs),
                    ("rejected", IpcValue::Array(rejected)),
                ]));
                let open = me.win().is_some();
                me.open_window();
                // a fresh window takes the task as it loads; an open one is told it waits
                if open && let Some(view) = me.win() {
                    me.ctx.services.events.emit(
                        Target::View(view),
                        "pdf-tools:start-ready",
                        Vec::new(),
                    );
                }
            },
        );
        true
    }

    fn pick_inputs(&self, multi: bool, kind: &'static str, accept: &'static str, r: Responder) {
        let Some(owner) = self.win() else {
            return r.reply(Ok(empty_pick()));
        };
        let (name, ext) = if kind == "image" { IMAGES } else { PDF };
        let properties: &[&str] = if multi {
            &["openFile", "multiSelections"]
        } else {
            &["openFile"]
        };
        let picked = self.ctx.show_open(
            self.ctx.window_of(owner),
            options([
                ("filters", Some(js_filter(name, ext))),
                ("properties", Some(js_strs(properties))),
            ]),
            None,
        );
        let Some(paths) = picked else {
            return r.reply(Ok(empty_pick()));
        };
        self.inputs_from(paths, kind, accept, move |inputs, rejected| {
            r.reply(Ok(obj([
                ("inputs", inputs),
                ("rejected", IpcValue::Array(rejected)),
            ])))
        })
    }

    /// `run(request)`: every way out clears the running state
    fn run(&self, raw: &IpcValue, r: Responder) {
        let Some(owner) = self.win() else {
            return r.reply(Ok(failed("failed")));
        };
        let req = tools::record_or_empty(raw);
        let Some(tool) = tools::tool_id(field(&req, "tool")) else {
            return r.reply(Ok(failed("failed")));
        };
        let kind = tools::input_kind(tool);
        let chosen: Vec<Picked> = match field(&req, "inputIds") {
            IpcValue::Array(ids) => ids
                .iter()
                .filter_map(|id| as_str(id).and_then(|id| self.s.borrow().inputs.get(id).cloned()))
                .filter(|p| p.kind == kind)
                .collect(),
            _ => Vec::new(),
        };
        if chosen.is_empty() {
            return r.reply(Ok(failed("no-input")));
        }
        let mut sources = if tools::takes_many(tool) {
            chosen
        } else {
            chosen[..1].to_vec()
        };
        if sources.len() < tools::min_inputs(tool) {
            return r.reply(Ok(failed("need-two")));
        }
        // overlay reads a second PDF, picked on its own as the background
        if tool == "overlay" {
            let background = as_str(field(&req, "backgroundId"))
                .and_then(|id| self.s.borrow().inputs.get(id).cloned())
                .filter(|b| b.kind == "pdf");
            match background {
                Some(b) => sources.push(b),
                None => return r.reply(Ok(failed("need-background"))),
            }
        }
        if self.s.borrow().running {
            return r.reply(Ok(failed("busy")));
        }
        self.s.borrow_mut().running = true;
        let run = Run {
            w: self.clone(),
            r,
            owner,
            tool,
            sources,
            options: field(&req, "options").clone(),
        };
        run.read();
    }

    /// `findBlankPages(inputId)`
    fn find_blank_pages(&self, input: &IpcValue, r: Responder) {
        let Some(owner) = self.win() else {
            return r.reply(Ok(failed("failed")));
        };
        let input = as_str(input).and_then(|id| self.s.borrow().inputs.get(id).cloned());
        let Some(input) = input.filter(|i| i.kind == "pdf") else {
            return r.reply(Ok(failed("no-input")));
        };
        if !exists_sync(&input.path) {
            return r.reply(Ok(failed("missing")));
        }
        if self.s.borrow().finding.is_some() || self.s.borrow().running {
            return r.reply(Ok(failed("busy")));
        }
        let job_id = random_uuid();
        self.s.borrow_mut().finding = Some(job_id.clone());
        let job = obj([
            ("op", "blankPages".into_ipc()),
            ("source", obj([("pdfPath", input.path.clone().into_ipc())])),
        ]);
        let me = self.clone();
        self.ctx.runner.run(
            &self.ctx,
            owner,
            &job_id,
            job,
            Some(self.progress(owner)),
            move |outcome| {
                me.s.borrow_mut().finding = None;
                let value = match outcome {
                    Err(f) if f.error == "cancelled" => return r.reply(Ok(canceled())),
                    Err(_) => return r.reply(Ok(failed("failed"))),
                    Ok(v) => v,
                };
                let Some((page_count, candidates)) = tools::found_blank_pages(&value) else {
                    return r.reply(Ok(failed("failed")));
                };
                me.s.borrow_mut()
                    .blank_found
                    .insert(input.id, candidates.iter().map(|c| c.page as u64).collect());
                let candidates = candidates
                    .into_iter()
                    .map(|c| {
                        let thumb = c
                            .thumb
                            .map(|(w, h, bgra)| me.ctx.engine.png_data_url(w, h, &bgra));
                        obj([
                            ("page", c.page.into_ipc()),
                            ("reason", c.reason.into_ipc()),
                            ("thumb", thumb.into_ipc()),
                        ])
                    })
                    .collect();
                r.reply(Ok(obj([
                    ("ok", true.into_ipc()),
                    ("pageCount", page_count.into_ipc()),
                    ("candidates", IpcValue::Array(candidates)),
                ])))
            },
        )
    }

    /// `pdf-tools:progress` to the window while it lives
    fn progress(&self, owner: ViewId) -> Progress {
        let events = self.ctx.services.events.clone();
        let views = self.ctx.services.views.clone();
        Arc::new(move |done, total| {
            if views.sender_of(owner).is_some() {
                events.emit(
                    Target::View(owner),
                    "pdf-tools:progress",
                    vec![obj([
                        ("done", done.into_ipc()),
                        ("total", total.into_ipc()),
                    ])],
                );
            }
        })
    }

    fn result_path(&self, cx: &CallContext, id: &IpcValue) -> Option<String> {
        if !self.sent_by_window(cx) {
            return None;
        }
        let id = as_str(id)?;
        self.s
            .borrow()
            .results
            .get(id)
            .cloned()
            .filter(|p| exists_sync(p))
    }

    pub fn entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:get-init", move |cx, _| {
            if !me.sent_by_window(cx) {
                return Ok(IpcValue::Null);
            }
            Ok(obj([
                ("lang", me.ctx.shell.lang().into_ipc()),
                ("theme", me.ctx.shell.theme().into_ipc()),
            ]))
        }));
        let me = self.clone();
        out.push(kit::invoke_later(
            "pdf-tools:pick-inputs",
            move |cx, args, r| {
                if !me.sent_by_window(cx) {
                    return r.reply(Ok(empty_pick()));
                }
                let kind = if args.str(1) == Some("image") {
                    "image"
                } else {
                    "pdf"
                };
                let accept = match args.str(2) {
                    Some("encrypted") => "encrypted",
                    Some("damaged") => "damaged",
                    _ => "pdf",
                };
                me.pick_inputs(args.bool(0) == Some(true), kind, accept, r)
            },
        ));
        let me = self.clone();
        out.push(kit::invoke_later("pdf-tools:run", move |cx, args, r| {
            if !me.sent_by_window(cx) {
                return r.reply(Ok(failed("failed")));
            }
            me.run(args.get(0), r)
        }));
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:open-result", move |cx, args| {
            if let Some(path) = me.result_path(cx, args.get(0)) {
                me.ctx.shell.open_result(&path);
            }
            Ok(IpcValue::Undefined)
        }));
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:reveal-result", move |cx, args| {
            if let Some(path) = me.result_path(cx, args.get(0)) {
                me.ctx.os.show_item_in_folder(path.as_ref());
            }
            Ok(IpcValue::Undefined)
        }));
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:open-in-editor", move |cx, _| {
            if me.sent_by_window(cx) {
                let picked = me.ctx.show_open(
                    me.ctx.window_of(cx.sender.view),
                    options([
                        ("filters", Some(js_filter(PDF.0, PDF.1))),
                        ("properties", Some(js_strs(&["openFile"]))),
                    ]),
                    None,
                );
                if let Some(path) = picked
                    .and_then(|p| p.into_iter().next())
                    .filter(|p| !p.is_empty())
                {
                    me.ctx.shell.open_for_editing(&path);
                }
            }
            Ok(IpcValue::Undefined)
        }));
        let me = self.clone();
        out.push(kit::invoke_later(
            "pdf-tools:find-blank-pages",
            move |cx, args, r| {
                if !me.sent_by_window(cx) {
                    return r.reply(Ok(failed("failed")));
                }
                me.find_blank_pages(args.get(0), r)
            },
        ));
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:cancel-run", move |cx, _| {
            if me.sent_by_window(cx) {
                let (stop, job) = {
                    let s = me.s.borrow();
                    (s.run_stop.clone(), s.running_job.clone())
                };
                if let Some(stop) = stop {
                    stop.cancel();
                }
                if let Some(job) = job {
                    me.ctx.runner.cancel(cx.sender.view, &job);
                }
            }
            Ok(IpcValue::Undefined)
        }));
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:cancel-find", move |cx, _| {
            let finding = me.s.borrow().finding.clone();
            if me.sent_by_window(cx)
                && let Some(job) = finding
            {
                me.ctx.runner.cancel(cx.sender.view, &job);
            }
            Ok(IpcValue::Undefined)
        }));
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:take-start", move |cx, _| {
            if !me.sent_by_window(cx) {
                return Ok(IpcValue::Null);
            }
            Ok(me
                .s
                .borrow_mut()
                .pending_start
                .take()
                .unwrap_or(IpcValue::Null))
        }));
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:close", move |cx, _| {
            if me.sent_by_window(cx)
                && let Some(window) = me.ctx.window_of(cx.sender.view)
            {
                me.ctx.contents.close_window(window);
            }
            Ok(IpcValue::Undefined)
        }));
        let me = self.clone();
        out.push(kit::invoke("pdf-tools:open", move |cx, _| {
            let parent = me.ctx.main_window.view().filter(|v| me.ctx.alive(*v));
            if parent == Some(cx.sender.view) {
                me.open_window();
            }
            Ok(IpcValue::Undefined)
        }));
        out
    }
}

/// One `run(request)` in flight: its steps go to a worker and back, and
/// every answer clears the window's running state first (`finally`)
struct Run {
    w: Window,
    r: Responder,
    owner: ViewId,
    tool: &'static str,
    sources: Vec<Picked>,
    options: IpcValue,
}

/// What reading the sources gave: bytes, the first input's pages, the background's
type Sources = Result<(Vec<Vec<u8>>, f64, f64), &'static str>;

impl Run {
    fn done(self, answer: IpcValue) {
        {
            let mut s = self.w.s.borrow_mut();
            s.running = false;
            s.run_stop = None;
            s.running_job = None;
        }
        self.r.reply(Ok(answer))
    }

    fn fail(self, error: &str) {
        self.done(failed(error))
    }

    /// read the sources, then read the first again: it may have changed since it was picked
    fn read(self) {
        let engine = self.w.ctx.engine.clone();
        let paths: Vec<String> = self.sources.iter().map(|s| s.path.clone()).collect();
        let (tool, kind) = (self.tool, tools::input_kind(self.tool));
        let services = self.w.ctx.services.clone();
        kit::on_worker(
            &services,
            move || -> Sources {
                let mut total = 0;
                let mut bytes = Vec::new();
                for path in &paths {
                    if !exists_sync(path) {
                        return Err("missing");
                    }
                    total += std::fs::metadata(path).map_err(|_| "failed")?.len();
                    if total > MAX_TOOL_INPUT_BYTES {
                        return Err("too-large");
                    }
                    bytes.push(std::fs::read(path).map_err(|_| "failed")?);
                }
                let first = pages_for(&*engine, &bytes[0], kind, tools::accepts(tool))
                    .map_err(|_| "failed")?;
                let background = if tool == "overlay" {
                    engine.inspect_pdf(&bytes[1]).map_err(|_| "failed")?
                } else {
                    1.0
                };
                Ok((bytes, first, background))
            },
            move |read| match read {
                Err(e) => self.fail(e),
                Ok((bytes, first, background)) => self.check(bytes, first, background),
            },
        )
    }

    fn check(self, bytes: Vec<Vec<u8>>, pages: f64, background: f64) {
        let options = match tools::check_options(self.tool, &self.options, pages, background) {
            Ok(o) => o,
            Err(e) => return self.fail(e),
        };
        if self.tool == "blankPages" {
            // only pages the search showed the user: nothing else is removed
            let found = self
                .w
                .s
                .borrow()
                .blank_found
                .get(&self.sources[0].id)
                .cloned();
            let chosen = as_str(field(&options, "removePages")).unwrap_or("");
            let all_found = found.is_some_and(|found| {
                chosen
                    .split(',')
                    .all(|p| p.parse::<u64>().is_ok_and(|p| found.contains(&p)))
            });
            if !all_found {
                return self.fail("not-found");
            }
        }
        if tools::runs_as_job(self.tool) {
            return self.run_job(options);
        }
        let stop = CancelToken::default();
        self.w.s.borrow_mut().run_stop = Some(stop.clone());
        let engine = self.w.ctx.engine.clone();
        let progress = self.w.progress(self.owner);
        let (tool, opts) = (self.tool, options.clone());
        let services = self.w.ctx.services.clone();
        kit::on_worker(
            &services,
            move || {
                let p = |d, t| progress(d, t);
                let made = engine.run_tool(tool, bytes, opts, &p, &stop);
                (made, stop.is_cancelled())
            },
            move |(made, aborted)| match made {
                Ok(made) => self.pick(made, options),
                Err(ToolError::Refusal(reason)) => self.fail(&reason),
                Err(ToolError::Failed(_)) if aborted => self.done(canceled()),
                Err(ToolError::Failed(_)) => self.fail("failed"),
            },
        )
    }

    /// `runToolJob(owner, tool, path, options)`: add a password, remove one
    /// or repair in the job process, and check the answer is what the tool promises
    fn run_job(self, options: IpcValue) {
        let job_id = random_uuid();
        self.w.s.borrow_mut().running_job = Some(job_id.clone());
        let job = tools::job_for(self.tool, &self.sources[0].path, &options);
        let ctx = self.w.ctx.clone();
        ctx.runner
            .run(&ctx, self.owner, &job_id, job, None, move |outcome| {
                let value = match outcome {
                    Err(f) if f.error == "cancelled" => return self.done(canceled()),
                    Err(f) if f.error == "password-required" => return self.fail("wrong-password"),
                    Err(_) => return self.fail("failed"),
                    Ok(v) => v,
                };
                let Some(bytes) = tools::job_bytes(&value) else {
                    return self.fail("failed");
                };
                let engine = self.w.ctx.engine.clone();
                let services = self.w.ctx.services.clone();
                kit::on_worker(
                    &services,
                    move || {
                        let info = engine.inspect_pdf(&bytes);
                        (bytes, info)
                    },
                    move |(bytes, info)| {
                        let as_promised = if self.tool == "encrypt" {
                            info.is_err_and(|p| p == "encrypted")
                        } else {
                            info.is_ok()
                        };
                        if as_promised {
                            self.pick(vec![bytes], options)
                        } else {
                            self.fail("failed")
                        }
                    },
                )
            })
    }

    /// `pickTargets(owner, sourcePath, names, extension)`: one file asks with a
    /// save dialog next to the source; several ask for a folder and take free names in it
    fn pick_targets(&self, names: &[String]) -> Option<Vec<String>> {
        let ctx = &self.w.ctx;
        let parent = ctx.window_of(self.owner);
        let source = &self.sources[0].path;
        let ext = tools::output_extension(self.tool);
        if names.len() == 1 {
            let filter = if ext == "txt" {
                js_filter("TXT", &["txt"])
            } else {
                js_filter(PDF.0, PDF.1)
            };
            let saved = ctx.show_save(
                parent,
                options([
                    (
                        "defaultPath",
                        Some(js_str(&save_as_suggestion(Some(source), &names[0]))),
                    ),
                    ("filters", Some(filter)),
                ]),
            )?;
            let ending = format!(".{ext}");
            return Some(vec![if saved.to_lowercase().ends_with(&ending) {
                saved
            } else {
                format!("{saved}{ending}")
            }]);
        }
        let folder = ctx.show_open(
            parent,
            options([
                ("defaultPath", Some(js_str(&dirname(source)))),
                (
                    "properties",
                    Some(js_strs(&["openDirectory", "createDirectory"])),
                ),
            ]),
            Some(&dirname(source)),
        )?;
        let dir = folder.into_iter().next().filter(|d| !d.is_empty())?;
        let mut taken: HashSet<String> = HashSet::new();
        let mut out = Vec::new();
        for name in names {
            let target =
                unique_generated_pdf_path(&dir, Some(&JsonValue::String(name.clone())), &|p| {
                    exists_sync(p) || taken.contains(p)
                })
                .ok()?;
            taken.insert(target.clone());
            out.push(target);
        }
        Some(out)
    }

    fn pick(self, made: Vec<Vec<u8>>, options: IpcValue) {
        let names = tools::output_names(self.tool, &self.sources[0].name, made.len(), &options);
        let Some(targets) = self.pick_targets(&names) else {
            return self.done(canceled());
        };
        for target in &targets {
            if self.sources.iter().any(|s| same_path(&s.path, target)) {
                return self.fail("same-as-source");
            }
            if self.w.ctx.shell.file_has_unsaved_changes(target) {
                return self.fail("unsaved-target");
            }
        }
        let services = self.w.ctx.services.clone();
        let written = targets.clone();
        kit::on_worker(
            &services,
            move || {
                written
                    .iter()
                    .zip(&made)
                    .map(|(t, bytes)| write_pdf_atomically(t, bytes).map(|()| bytes.len()))
                    .collect::<Result<Vec<_>, _>>()
            },
            move |sizes| {
                let Ok(sizes) = sizes else {
                    return self.fail("failed");
                };
                let mut outputs = Vec::new();
                for (target, size) in targets.into_iter().zip(sizes) {
                    let id = random_uuid();
                    outputs.push(obj([
                        ("id", id.clone().into_ipc()),
                        ("name", basename(&target, None).into_ipc()),
                        ("size", (size as f64).into_ipc()),
                    ]));
                    self.w.s.borrow_mut().results.insert(id, target);
                }
                self.done(obj([
                    ("ok", true.into_ipc()),
                    ("outputs", IpcValue::Array(outputs)),
                ]))
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use shell_contract::{IpcValue, Surface, ViewId};

    use super::super::test_support::*;
    use crate::kit::IntoIpc;
    use crate::testing::HostCall;

    /// the tools open with view 900 as their window
    fn open(t: &mut T) -> shell_contract::ipc::Sender {
        let shell = t.rt.view(1, Surface::Shell);
        t.rt.script().main_view = Some(ViewId(1));
        t.call("pdf-tools:open", shell, vec![]);
        t.rt.view(900, Surface::ShellPdfTools)
    }

    fn pick(
        t: &mut T,
        win: shell_contract::ipc::Sender,
        paths: &[&str],
        args: Vec<IpcValue>,
    ) -> serde_json::Value {
        t.rt.script()
            .open
            .push_back(Some(paths.iter().map(Into::into).collect()));
        j(&t.call("pdf-tools:pick-inputs", win, args))
    }

    #[test]
    fn only_the_shell_window_opens_the_tools_and_only_they_are_answered() {
        let mut t = tools(json!({ "lang": "ko" }));
        let other = t.pdf_view(5);
        t.call("pdf-tools:open", other, vec![]);
        assert!(t.fake.called("open_tools_window").is_empty());
        let win = open(&mut t);
        assert_eq!(
            t.fake.called("open_tools_window")[0][1],
            json!("PDF 도구 - SeuOffice")
        );
        assert_eq!(j(&t.call("pdf-tools:get-init", other, vec![])), json!(null));
        assert_eq!(
            j(&t.call("pdf-tools:get-init", win, vec![])),
            json!({ "lang": "ko", "theme": "system" })
        );
        // opening again shows the open window
        let shell = t.rt.view(1, Surface::Shell);
        t.call("pdf-tools:open", shell, vec![]);
        assert_eq!(t.fake.called("show_window"), vec![json!(900)]);
    }

    #[test]
    fn picked_files_become_ids_and_unusable_ones_say_why() {
        let mut t = tools(json!({ "inspect_pdf": [{ "pages": 3 }, { "problem": "encrypted" }] }));
        let win = open(&mut t);
        let a = t.file("a.pdf", b"aaaa");
        let b = t.file("b.pdf", b"bb");
        let gone = t.rt.dir.join("gone.pdf").to_string_lossy().into_owned();
        let got = pick(&mut t, win, &[&a, &b, &gone], vec![true.into_ipc()]);
        assert_eq!(got["inputs"][0]["name"], json!("a.pdf"));
        assert_eq!(got["inputs"][0]["pages"], json!(3));
        assert_eq!(got["inputs"][0]["size"], json!(4));
        assert!(got["inputs"][0].get("path").is_none());
        assert_eq!(
            got["rejected"],
            json!([{ "name": "b.pdf", "problem": "encrypted" }, { "name": "gone.pdf", "problem": "unreadable" }])
        );
        let HostCall::Open(_, dialog) = t.rt.script().calls.last().cloned().unwrap() else {
            panic!()
        };
        assert_eq!(dialog.properties, vec!["openFile", "multiSelections"]);
        // cancelled: nothing
        t.rt.script().open.push_back(None);
        assert_eq!(
            j(&t.call("pdf-tools:pick-inputs", win, vec![])),
            json!({ "inputs": [], "rejected": [] })
        );
    }

    #[test]
    fn a_run_writes_where_the_user_picked_and_never_over_a_source() {
        let mut t = tools(json!({ "run_tool": [
            { "outputs": [{ "$u8": [1, 2, 3] }], "progress": [[1, 1]] },
            { "outputs": [{ "$u8": [1] }] },
            { "refusal": "no-annots" }
        ] }));
        let win = open(&mut t);
        let a = t.file("a.pdf", b"a");
        let id = pick(&mut t, win, &[&a], vec![])["inputs"][0]["id"].clone();
        let run = |t: &mut T, tool: &str| {
            j(&t.call(
                "pdf-tools:run",
                win,
                vec![v(
                    json!({ "tool": tool, "inputIds": [id], "options": { "rotation": 180 } }),
                )],
            ))
        };
        let out = t.rt.dir.join("out.pdf").to_string_lossy().into_owned();
        t.rt.script().save.push_back(Some(t.rt.dir.join("out")));
        let done = run(&mut t, "rotate");
        assert_eq!(done["outputs"][0]["name"], json!("out.pdf"));
        assert_eq!(done["outputs"][0]["size"], json!(3));
        assert_eq!(std::fs::read(&out).unwrap(), vec![1, 2, 3]);
        assert_eq!(
            t.fake.called("run_tool")[0]["options"],
            json!({ "rotation": 180 })
        );
        assert_eq!(t.rt.events()[0].channel, "pdf-tools:progress");
        // the result opens by its id
        t.call(
            "pdf-tools:reveal-result",
            win,
            vec![done["outputs"][0]["id"].as_str().unwrap().into_ipc()],
        );
        assert!(
            t.rt.script()
                .calls
                .contains(&HostCall::ShowItemInFolder(out.clone().into()))
        );

        t.rt.script().save.push_back(Some(a.clone().into()));
        assert_eq!(
            run(&mut t, "rotate"),
            json!({ "ok": false, "error": "same-as-source" })
        );
        assert_eq!(
            run(&mut t, "stripAnnots"),
            json!({ "ok": false, "error": "no-annots" })
        );
        assert_eq!(
            run(&mut t, "merge"),
            json!({ "ok": false, "error": "need-two" })
        );
        // the window closed: its ids are gone
        t.rt.destroy(ViewId(900));
        let win = open(&mut t);
        assert_eq!(
            j(&t.call(
                "pdf-tools:run",
                win,
                vec![v(json!({ "tool": "rotate", "inputIds": [id] }))]
            )),
            json!({ "ok": false, "error": "no-input" })
        );
    }

    #[test]
    fn blank_pages_removes_only_pages_the_search_found() {
        let mut t = tools(
            json!({ "run_job": [{ "value": { "pageCount": 4, "candidates": [
            { "page": 2, "reason": "empty", "thumb": { "width": 1, "height": 1, "$u8": [] } },
            { "page": 3, "reason": "nearly-white", "thumb": { "width": 1, "height": 1, "bgra": { "$u8": [0, 0, 0, 0] } } }
        ] }, "progress": [[2, 4]] }], "inspect_pdf": { "pages": 4 } }),
        );
        let win = open(&mut t);
        let a = t.file("a.pdf", b"a");
        let id = pick(&mut t, win, &[&a], vec![])["inputs"][0]["id"].clone();
        let run = |t: &mut T, pages: &str| {
            j(&t.call("pdf-tools:run", win, vec![v(json!({ "tool": "blankPages", "inputIds": [id], "options": { "removePages": pages } }))]))
        };
        assert_eq!(run(&mut t, "3")["error"], json!("not-found"));
        // a thumbnail whose pixels do not fit its size is not that shape
        assert_eq!(
            j(&t.call(
                "pdf-tools:find-blank-pages",
                win,
                vec![id.as_str().unwrap().into_ipc()]
            )),
            json!({ "ok": false, "error": "failed" })
        );
    }

    #[test]
    fn blank_page_search_answers_candidates_with_thumbnails() {
        let mut t = tools(
            json!({ "run_job": [{ "value": { "pageCount": 4, "candidates": [
            { "page": 3, "reason": "nearly-white", "thumb": { "width": 1, "height": 1, "bgra": { "$u8": [0, 0, 0, 0] } } },
            { "page": 2, "reason": "empty", "thumb": null }
        ] }, "progress": [[2, 4]] }], "inspect_pdf": { "pages": 4 } }),
        );
        let win = open(&mut t);
        let a = t.file("a.pdf", b"a");
        let id = pick(&mut t, win, &[&a], vec![])["inputs"][0]["id"].clone();
        let found = j(&t.call(
            "pdf-tools:find-blank-pages",
            win,
            vec![id.as_str().unwrap().into_ipc()],
        ));
        assert_eq!(
            found,
            json!({ "ok": true, "pageCount": 4, "candidates": [
                { "page": 3, "reason": "nearly-white", "thumb": "data:image/png;base64,1x1" },
                { "page": 2, "reason": "empty", "thumb": null }
            ] })
        );
        assert_eq!(
            j(&t.rt.events()[0].args[0]),
            json!({ "done": 2, "total": 4 })
        );
        t.rt.script().save.push_back(Some(t.rt.dir.join("o.pdf")));
        let done = j(&t.call("pdf-tools:run", win, vec![v(json!({ "tool": "blankPages", "inputIds": [id], "options": { "removePages": "2,3" } }))]));
        assert_eq!(done["ok"], json!(true));
    }

    #[test]
    fn a_password_job_must_answer_as_promised() {
        let mut t = tools(json!({
            "run_job": [{ "value": { "bytes": { "$u8": [9] } } }, { "error": "password-required" }],
            "inspect_pdf": [{ "pages": 1 }, { "pages": 1 }, { "pages": 1 }]
        }));
        let win = open(&mut t);
        let a = t.file("a.pdf", b"a");
        let id = pick(&mut t, win, &[&a], vec![])["inputs"][0]["id"].clone();
        let run = |t: &mut T, tool: &str| {
            j(&t.call(
                "pdf-tools:run",
                win,
                vec![v(
                    json!({ "tool": tool, "inputIds": [id], "options": { "password": "p" } }),
                )],
            ))
        };
        // the locked file still opens without a password: not what encrypt promises
        assert_eq!(
            run(&mut t, "encrypt"),
            json!({ "ok": false, "error": "failed" })
        );
        assert_eq!(t.fake.called("run_job")[0]["userPassword"], json!("p"));
        assert_eq!(
            run(&mut t, "encrypt"),
            json!({ "ok": false, "error": "wrong-password" })
        );
    }

    #[test]
    fn the_ribbons_task_waits_until_the_window_takes_it() {
        let mut t = tools(json!({}));
        let a = t.file("a.pdf", b"a");
        let tools = t.tools();
        assert!(!tools.open_with_file(&a, "imagesToPdf"));
        assert!(tools.open_with_file(&a, "compress"));
        t.rt.drain();
        t.rt.script().main_view = Some(ViewId(1));
        let win = t.rt.view(900, Surface::ShellPdfTools);
        let start = j(&t.call("pdf-tools:take-start", win, vec![]));
        assert_eq!(start["tool"], json!("compress"));
        assert_eq!(start["inputs"][0]["name"], json!("a.pdf"));
        assert_eq!(j(&t.call("pdf-tools:take-start", win, vec![])), json!(null));
        // an open window is told a task waits
        assert!(tools.open_with_file(&a, "rotate"));
        t.rt.drain();
        let events = t.rt.events();
        assert_eq!(events.last().unwrap().channel, "pdf-tools:start-ready");
    }
}
