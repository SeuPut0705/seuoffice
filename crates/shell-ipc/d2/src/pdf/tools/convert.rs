//! The pdf editor's conversions the shell answers: the Markdown / EPUB
//! screen's requests around a job (`pdf-convert-ui.ts`,
//! `pdf-convert-ui-handlers.ts`), and the converter dropdown's Word,
//! PowerPoint, Excel and Hangul conversions (`pdf:convert-office`, the
//! `exportPdfAs*Local` and `openPdfAsHwp` flows of `shell/index.ts`).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use jscompat::js_regex;
use jscompat::node_path::host::{basename, join};
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use main_core::pdf::generated_output::exists_sync;
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::Target;
use shell_contract::runtime::PathName;
use shell_contract::{IpcError, IpcValue, ViewId, WindowId};

use super::hosts::{ConvertError, OfficeConversion, OfficeFormat, PdfTab, TabKind};
use super::password::Password;
use super::{Ctx, int_text, js_filter, js_len, js_str, options};
use crate::kit::{self, Entry, IntoIpc, as_str, field, obj};

const MAX_PATH: usize = 4096;

/// `requestPdfConvertDialog(contents, format, outPath)`: the pdf tab opens
/// its conversion dialog
pub fn request_convert_dialog(
    ctx: &Ctx,
    view: Option<ViewId>,
    format: &str,
    out_path: Option<&str>,
) {
    let Some(view) = view.filter(|v| ctx.alive(*v)) else {
        return;
    };
    let mut req = vec![("format".to_owned(), format.into_ipc())];
    if let Some(out) = out_path {
        req.push(("outPath".to_owned(), out.into_ipc()));
    }
    ctx.services.events.emit(
        Target::View(view),
        "pdf:convert-dialog-request",
        vec![IpcValue::Object(req)],
    );
}

/// The keys of one format's strings and the tabs that may show its result
struct Office {
    busy: &'static str,
    filter: &'static str,
    failed: &'static str,
    tabs: TabKind,
}

fn office(format: OfficeFormat) -> Office {
    match format {
        OfficeFormat::Docx => Office {
            busy: "pdfDocxBusyMsg",
            filter: "filterWord",
            failed: "pdfDocxFailedMsg",
            tabs: TabKind::Docs,
        },
        OfficeFormat::Pptx => Office {
            busy: "pdfPptxBusyMsg",
            filter: "filterPpt",
            failed: "pdfPptxFailedMsg",
            tabs: TabKind::Slides,
        },
        OfficeFormat::Xlsx => Office {
            busy: "pdfXlsxBusyMsg",
            filter: "filterExcel",
            failed: "pdfXlsxFailedMsg",
            tabs: TabKind::Sheets,
        },
    }
}

/// One export in flight; [`Export::end`] is its `finally`
struct Export {
    c: Convert,
    format: OfficeFormat,
    tab: PdfTab,
    host: WindowId,
    file: String,
    then: Box<dyn FnOnce()>,
}

#[derive(Clone)]
pub struct Convert {
    ctx: Rc<Ctx>,
    password: Password,
    /// `exportingPdfDocx`: one office conversion at a time, dialogs included
    exporting: Rc<Cell<bool>>,
    /// the folders of the PDF copies each Hangul tab imports
    hwp_copies: Rc<RefCell<HashMap<ViewId, String>>>,
    _gone: Rc<dyn Fn(ViewId)>,
}

impl Convert {
    pub fn new(ctx: &Rc<Ctx>, password: &Password) -> Self {
        let hwp_copies: Rc<RefCell<HashMap<ViewId, String>>> = Rc::default();
        let weak = Rc::downgrade(&hwp_copies);
        // the copy goes with the tab
        let gone = kit::on_view_destroyed(&ctx.services, move |view| {
            let dir = weak.upgrade().and_then(|m| m.borrow_mut().remove(&view));
            if let Some(dir) = dir {
                let _ = std::fs::remove_dir_all(dir);
            }
        });
        Convert {
            ctx: ctx.clone(),
            password: password.clone(),
            exporting: Rc::default(),
            hwp_copies,
            _gone: gone,
        }
    }

    fn tm(&self, key: &str) -> String {
        self.ctx.shell.text(key, &[])
    }

    fn message(&self, host: WindowId, kind: &str, message: String, detail: Option<String>) {
        self.ctx.dialogs.message(
            Some(host),
            &MessageBox {
                kind: Some(kind.to_owned()),
                message,
                detail,
                ..MessageBox::default()
            },
        );
    }

    /// `requestOf(viewId, req)`: the written path of a request this view may make
    fn request_of(&self, view: ViewId, req: &IpcValue) -> Option<String> {
        if !kit::truthy(req) || !kit::is_object(req) {
            return None;
        }
        let (source, path) = (as_str(field(req, "source"))?, as_str(field(req, "path"))?);
        if path.is_empty() || js_len(path) > MAX_PATH || !self.ctx.grants.granted(view, source) {
            return None;
        }
        Some(path.to_owned())
    }

    /// `exportPdfAs{Docx,Pptx,Xlsx}Local(preset)`: flush pending edits, pick
    /// the destination, convert, write the file and open it. `then` runs when
    /// the flow ends, however it ends.
    pub fn export_office(
        &self,
        format: OfficeFormat,
        preset: Option<(PdfTab, String)>,
        then: Box<dyn FnOnce()>,
    ) {
        let (tab, target) = match preset {
            Some((tab, target)) => (Some(tab), Some(target)),
            None => (self.ctx.shell.active_pdf_tab(), None),
        };
        let Some(tab) = tab else { return then() };
        let (Some(file), Some(host)) = (tab.file_path.clone(), tab.window) else {
            return then();
        };
        let keys = office(format);
        if self.exporting.get() {
            self.message(host, "info", self.tm(keys.busy), None);
            return then();
        }
        self.exporting.set(true);
        let export = Export {
            c: self.clone(),
            format,
            tab,
            host,
            file,
            then,
        };
        let shell = self.ctx.shell.clone();
        let view = export.tab.view;
        shell.flush_pdf_save(
            view,
            Box::new(move |flushed| {
                if !flushed {
                    return export.end();
                }
                // Save As already picked the name: no second dialog
                let picked = target.or_else(|| {
                    let ext = format.extension();
                    let default =
                        js_regex!(r"\.pdf$", "i").replace_all(&export.file, |_| format!(".{ext}"));
                    export.c.ctx.show_save(
                        Some(export.host),
                        options([
                            ("defaultPath", Some(js_str(&default))),
                            (
                                "filters",
                                Some(js_filter(&export.c.tm(keys.filter), &[ext])),
                            ),
                        ]),
                    )
                });
                let Some(picked) = picked else {
                    return export.end();
                };
                export.free_target(picked, keys.tabs)
            }),
        )
    }

    /// `openPdfAsHwp()`: the active PDF opens as a new, untitled Hangul tab
    /// that imports a copy of it
    fn open_pdf_as_hwp(&self, then: Box<dyn FnOnce(Result<(), IpcError>)>) {
        let tab = self.ctx.shell.active_pdf_tab();
        let Some((view, path)) = tab.and_then(|t| Some((t.view, t.file_path?))) else {
            return then(Ok(()));
        };
        let me = self.clone();
        self.ctx.shell.flush_pdf_save(
            view,
            Box::new(move |flushed| {
                if !flushed {
                    return then(Ok(()));
                }
                then(me.open_pdf_copy_as_hwp(&path).map_err(kit::error))
            }),
        )
    }

    /// `openPdfCopyAsHwp(pdfPath)`: the copy goes with the tab
    fn open_pdf_copy_as_hwp(&self, pdf_path: &str) -> Result<(), String> {
        let temp = self.ctx.services.paths.path(PathName::Temp);
        let dir = join(&[
            &temp.to_string_lossy(),
            "seuoffice-pdf-imports",
            &self.ctx.shell.random_uuid(),
        ]);
        let base =
            js_regex!(r"\.pdf$", "i").replace_all(&basename(pdf_path, None), |_| String::new());
        let opened = main_core::markdown::fs_util::mkdir_p(&dir)
            .and_then(|()| {
                let copy = join(&[&dir, &basename(pdf_path, None)]);
                main_core::node_fs::copy_file(pdf_path, &copy, false).map(|()| copy)
            })
            .map_err(|e| e.message)
            .and_then(|copy| self.ctx.shell.open_hwp_copy(&copy, &base));
        match opened {
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                Err(e)
            }
            Ok(Some(view)) => {
                self.hwp_copies.borrow_mut().insert(view, dir);
                Ok(())
            }
            Ok(None) => {
                let _ = std::fs::remove_dir_all(&dir);
                Ok(())
            }
        }
    }

    pub fn entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        let me = self.clone();
        out.push(kit::invoke_later(
            "pdf:convert-release-target",
            move |cx, args, r| {
                let view = cx.sender.view;
                let path = me
                    .request_of(view, args.get(0))
                    .filter(|p| js_regex!(r"\.md$", "i").test(p));
                let Some(path) = path else {
                    return r.reply(Ok(false.into_ipc()));
                };
                let Some(tab) = me.ctx.shell.find_tab(TabKind::Markdown, &path) else {
                    return r.reply(Ok(true.into_ipc()));
                };
                let shell = me.ctx.shell.clone();
                me.ctx.shell.close_tab(
                    &tab,
                    Box::new(move |closed| match closed {
                        Err(e) => r.reply(Err(kit::error(e))),
                        Ok(()) => {
                            shell.activate_view(view);
                            r.reply(Ok(shell
                                .find_tab(TabKind::Markdown, &path)
                                .is_none()
                                .into_ipc()))
                        }
                    }),
                )
            },
        ));
        let me = self.clone();
        out.push(kit::invoke("pdf:convert-open-result", move |cx, args| {
            let path = me
                .request_of(cx.sender.view, args.get(0))
                .filter(|p| js_regex!(r"\.md$", "i").test(p) && exists_sync(p));
            Ok(path
                .is_some_and(|p| me.ctx.shell.open_document_path(&p))
                .into_ipc())
        }));
        let me = self.clone();
        out.push(kit::invoke("pdf:convert-reveal-result", move |cx, args| {
            let path = me
                .request_of(cx.sender.view, args.get(0))
                .filter(|p| js_regex!(r"\.(md|epub|png|pdf)$", "i").test(p) && exists_sync(p));
            if let Some(p) = &path {
                me.ctx.os.show_item_in_folder(p.as_ref());
            }
            Ok(path.is_some().into_ipc())
        }));
        let me = self.clone();
        out.push(kit::invoke_later(
            "pdf:convert-office",
            move |cx, args, r| {
                // only the active pdf tab may convert (its file is the source)
                if me.ctx.shell.active_pdf_tab().map(|t| t.view) != Some(cx.sender.view) {
                    return r.reply(Ok(IpcValue::Undefined));
                }
                let format = match args.str(0) {
                    Some("docx") => OfficeFormat::Docx,
                    Some("xlsx") => OfficeFormat::Xlsx,
                    Some("pptx") => OfficeFormat::Pptx,
                    Some("hwp") => {
                        return me.open_pdf_as_hwp(Box::new(move |done| {
                            r.reply(done.map(|()| IpcValue::Undefined))
                        }));
                    }
                    _ => return r.reply(Ok(IpcValue::Undefined)),
                };
                me.export_office(
                    format,
                    None,
                    Box::new(move || r.reply(Ok(IpcValue::Undefined))),
                )
            },
        ));
        out
    }
}

impl Export {
    /// the `finally`: the prompt may still be open, the guard and the
    /// progress bar end
    fn end(self) {
        self.c.password.close();
        self.c.exporting.set(false);
        self.c.ctx.shell.set_progress_bar(self.host, -1.0);
        (self.then)()
    }

    /// A tab that shows the destination closes first (its unsaved-changes
    /// guard applies), so the converted file opens fresh
    fn free_target(self, picked: String, tabs: TabKind) {
        let shell = self.c.ctx.shell.clone();
        let Some(stale) = shell.find_tab(tabs, &picked) else {
            return self.convert(picked, None);
        };
        shell.clone().close_tab(
            &stale,
            Box::new(move |closed| {
                if let Err(e) = closed {
                    return self.failed(ConvertError::Other(e));
                }
                shell.activate_tab(&self.tab.id);
                if shell.find_tab(tabs, &picked).is_some() {
                    return self.end();
                }
                self.convert(picked, None)
            }),
        )
    }

    /// The conversion, asking for the password while the PDF wants one
    /// (`convertWithPasswordRetry`)
    fn convert(self, picked: String, password: Option<String>) {
        let ctx = self.c.ctx.clone();
        ctx.shell.set_progress_bar(self.host, 2.0);
        let (engine, shell) = (ctx.engine.clone(), ctx.shell.clone());
        let (format, file, host) = (self.format, self.file.clone(), self.host);
        let tried = password.clone();
        kit::on_worker(
            &ctx.services,
            move || {
                let progress = |page: f64, total: f64| {
                    if total > 0.0 {
                        shell.set_progress_bar(host, page / total)
                    }
                };
                engine.convert_to_office(format, &file, password.as_deref(), &progress)
            },
            move |result| match result {
                Ok(done) => self.write(picked, done),
                Err(ConvertError::Load(code)) if code == "password-required" => {
                    let state = self.password_state(tried.is_some());
                    let password = self.c.password.clone();
                    password.prompt(
                        Some(self.host),
                        state,
                        Box::new(move |entered| match entered {
                            None => self.end(),
                            Some(p) => self.convert(picked, Some(p)),
                        }),
                    )
                }
                Err(e) => self.failed(e),
            },
        )
    }

    /// the `PdfPasswordUiState` of one attempt
    fn password_state(&self, retry: bool) -> IpcValue {
        let tm = |k: &str| self.c.tm(k).into_ipc();
        obj([
            ("fileName", basename(&self.file, None).into_ipc()),
            ("retry", retry.into_ipc()),
            ("busy", false.into_ipc()),
            ("lang", self.c.ctx.shell.lang().into_ipc()),
            (
                "strings",
                obj([
                    ("title", tm("pdfPwdTitle")),
                    ("prompt", tm("pdfPwdPrompt")),
                    ("retryPrompt", tm("pdfPwdRetryPrompt")),
                    ("ok", tm("pdfPwdOk")),
                    ("cancel", tm("btnCancel")),
                    ("verifying", tm("pdfPwdVerifying")),
                    ("label", tm("pdfPwdLabel")),
                    ("placeholder", tm("pdfPwdPlaceholder")),
                    ("show", tm("pdfPwdShow")),
                    ("hide", tm("pdfPwdHide")),
                ]),
            ),
        ])
    }

    fn write(self, picked: String, done: OfficeConversion) {
        let services = self.c.ctx.services.clone();
        let target = picked.clone();
        let bytes = done.bytes.clone();
        kit::on_worker(
            &services,
            move || atomic_write_file(&target, &bytes).map_err(|e| e.message),
            move |written| match written {
                Err(m) => self.failed(ConvertError::Other(m)),
                Ok(()) => {
                    self.report(&done);
                    self.c.ctx.shell.open_document_path(&picked);
                    self.end()
                }
            },
        )
    }

    /// Degrade transparency: a whole scan, pages kept as pictures, pages read by OCR
    fn report(&self, done: &OfficeConversion) {
        let c = &self.c;
        let pages = |keep: &dyn Fn(&str) -> bool| {
            done.page_results
                .iter()
                .filter(|(_, s)| keep(s))
                .map(|(p, _)| int_text(*p))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let text = |key: &str, pages: &str| c.ctx.shell.text(key, &[("pages", pages.to_owned())]);
        let info = |message: &str, detail: String| {
            c.message(self.host, "info", c.tm(message), Some(detail))
        };
        match self.format {
            OfficeFormat::Docx => {
                let ocr = pages(&|s| s == "ocr");
                let image = pages(&|s| s != "ok" && s != "ocr");
                if done.scanned_document {
                    info("pdfDocxLocalScannedMsg", c.tm("pdfDocxLocalScannedDetail"))
                } else if !image.is_empty() && !ocr.is_empty() {
                    info(
                        "pdfDocxLocalDegradedMsg",
                        format!(
                            "{}\n\n{}",
                            text("pdfDocxLocalDegradedDetail", &image),
                            text("pdfDocxLocalOcrDetail", &ocr)
                        ),
                    )
                } else if !image.is_empty() {
                    info(
                        "pdfDocxLocalDegradedMsg",
                        text("pdfDocxLocalDegradedDetail", &image),
                    )
                } else if !ocr.is_empty() {
                    info("pdfDocxLocalOcrMsg", text("pdfDocxLocalOcrDetail", &ocr))
                }
            }
            OfficeFormat::Pptx => {
                let image = pages(&|s| s != "ok");
                if done.scanned_document {
                    info("pdfDocxLocalScannedMsg", c.tm("pdfPptxLocalScannedDetail"))
                } else if !image.is_empty() {
                    info(
                        "pdfDocxLocalDegradedMsg",
                        text("pdfDocxLocalDegradedDetail", &image),
                    )
                }
            }
            OfficeFormat::Xlsx => {
                let notice = pages(&|s| s != "ok");
                if done.scanned_document {
                    info("pdfDocxLocalScannedMsg", c.tm("pdfXlsxLocalScannedDetail"))
                } else if !notice.is_empty() {
                    info(
                        "pdfXlsxLocalSkippedMsg",
                        text("pdfXlsxLocalSkippedDetail", &notice),
                    )
                }
            }
        }
    }

    /// The `catch`: password-protected and damaged PDFs get an explanation
    fn failed(self, e: ConvertError) {
        let detail = match e {
            ConvertError::Load(code) => self.c.tm(match code.as_str() {
                "password-required" => "pdfDocxLocalEncryptedDetail",
                // certificate-based security: no password can open it locally
                "unsupported" => "pdfDocxLocalUnsupportedEncDetail",
                _ => "pdfDocxLocalCorruptDetail",
            }),
            ConvertError::Other(m) => m,
        };
        self.c.message(
            self.host,
            "error",
            self.c.tm(office(self.format).failed),
            Some(detail),
        );
        self.end()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use shell_contract::hosts::MessageBox;
    use shell_contract::{Surface, ViewId, WindowId};

    use super::super::test_support::*;
    use super::OfficeFormat;
    use crate::kit::IntoIpc;
    use crate::testing::HostCall;

    fn tab(path: &str) -> serde_json::Value {
        json!({ "id": "t5", "view": 5, "filePath": path, "window": 2 })
    }

    fn messages(t: &T) -> Vec<MessageBox> {
        t.rt.script()
            .calls
            .iter()
            .filter_map(|c| match c {
                HostCall::Message(_, m) => Some(m.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_conversion_screen_works_only_on_the_views_own_pdf() {
        let mut t = tools(json!({ "find_tab": ["tab-1", null] }));
        let pdf = t.pdf_view(5);
        let src = t.file("a.pdf", b"x");
        let md = t.file("a.md", b"# a");
        let req = |path: &str| v(json!({ "source": src, "path": path }));
        assert_eq!(
            j(&t.call("pdf:convert-reveal-result", pdf, vec![req(&md)])),
            json!(false)
        );
        t.grant(5, &src);
        assert_eq!(
            j(&t.call("pdf:convert-reveal-result", pdf, vec![req(&md)])),
            json!(true)
        );
        assert!(
            t.rt.script()
                .calls
                .contains(&HostCall::ShowItemInFolder(md.clone().into()))
        );
        // only existing Markdown opens
        assert_eq!(
            j(&t.call("pdf:convert-open-result", pdf, vec![req(&src)])),
            json!(false)
        );
        assert_eq!(
            j(&t.call("pdf:convert-open-result", pdf, vec![req(&md)])),
            json!(true)
        );
        // the tab that shows the target closes, and the pdf tab comes back
        assert_eq!(
            j(&t.call("pdf:convert-release-target", pdf, vec![req(&md)])),
            json!(true)
        );
        assert_eq!(t.fake.called("close_tab"), vec![json!("tab-1")]);
        assert_eq!(t.fake.called("activate_view"), vec![json!(5)]);
    }

    #[test]
    fn a_tab_kept_open_keeps_the_target_and_a_rejected_close_rejects() {
        let mut t = tools(
            json!({ "find_tab": ["tab-1", "tab-1", "tab-1"], "close_tab": [null, "closing failed"] }),
        );
        let pdf = t.pdf_view(5);
        let src = t.file("a.pdf", b"x");
        t.grant(5, &src);
        let req = v(json!({ "source": src, "path": "/x/b.MD" }));
        assert_eq!(
            j(&t.call("pdf:convert-release-target", pdf, vec![req.clone()])),
            json!(false)
        );
        let e =
            t.rt.invoke_now("pdf:convert-release-target", pdf, vec![req])
                .unwrap_err();
        assert_eq!(e.message, "closing failed");
    }

    #[test]
    fn convert_office_runs_only_for_the_active_pdf_and_asks_for_the_password() {
        let mut t = tools(json!({
            "active_pdf_tab": tab("/docs/a.pdf"),
            "convert_to_office": [{ "load": "password-required" }, { "load": "password-required" },
                { "bytes": { "$u8": [7] }, "pageResults": [[1, "ok"], [2, "image"], [3, "ocr"]] }]
        }));
        let other = t.pdf_view(6);
        t.call("pdf:convert-office", other, vec!["docx".into_ipc()]);
        assert!(t.fake.called("convert_to_office").is_empty());
        let pdf = t.pdf_view(5);
        let out = t.rt.dir.join("a.docx");
        t.rt.script().save.push_back(Some(out.clone()));
        let pending =
            t.rt.invoke("pdf:convert-office", pdf, vec!["docx".into_ipc()]);
        let tools = t.tools();
        // the prompt is up: the reply waits
        assert!(pending.take().is_none());
        let win = t.rt.view(901, Surface::ShellPdfPassword);
        assert_eq!(
            j(&t.call("pdf-password:get-state", win, vec![]))["retry"],
            json!(false)
        );
        t.call("pdf-password:submit", win, vec!["wrong".into_ipc()]);
        assert_eq!(
            j(&t.call("pdf-password:get-state", win, vec![]))["retry"],
            json!(true)
        );
        t.call("pdf-password:submit", win, vec!["right".into_ipc()]);
        assert_eq!(
            pending.take(),
            Some(Ok(shell_contract::IpcValue::Undefined))
        );
        assert_eq!(std::fs::read(&out).unwrap(), vec![7]);
        assert_eq!(
            t.fake.called("convert_to_office")[2]["password"],
            json!("right")
        );
        let m = messages(&t);
        assert_eq!(m[0].message, "pdfDocxLocalDegradedMsg");
        assert_eq!(
            m[0].detail.as_deref(),
            Some("pdfDocxLocalDegradedDetail pages=2\n\npdfDocxLocalOcrDetail pages=3")
        );
        assert_eq!(
            t.fake.called("open_document_path"),
            vec![json!(out.to_string_lossy())]
        );
        // the prompt closed and the guard is free again
        assert!(
            t.rt.script()
                .calls
                .contains(&HostCall::CloseWindow(WindowId(901)))
        );
        assert_eq!(
            t.fake.called("set_progress_bar").last(),
            Some(&json!([2, -1.0]))
        );
        drop(tools);
    }

    #[test]
    fn a_second_export_while_one_runs_is_refused_and_failures_explain() {
        let mut t = tools(json!({
            "active_pdf_tab": tab("/docs/a.pdf"),
            "convert_to_office": [{ "load": "password-required" }, { "load": "unsupported" }]
        }));
        let tools = t.tools();
        t.rt.script().save.push_back(Some(t.rt.dir.join("a.xlsx")));
        let ended = std::rc::Rc::new(std::cell::Cell::new(0));
        let e = ended.clone();
        tools.export_office(
            OfficeFormat::Xlsx,
            None,
            Box::new(move || e.set(e.get() + 1)),
        );
        t.rt.drain();
        let e = ended.clone();
        tools.export_office(
            OfficeFormat::Pptx,
            None,
            Box::new(move || e.set(e.get() + 1)),
        );
        assert_eq!(ended.get(), 1);
        assert_eq!(messages(&t)[0].message, "pdfPptxBusyMsg");
        // cancelling the prompt ends the first quietly
        let win = t.rt.view(901, Surface::ShellPdfPassword);
        t.call("pdf-password:cancel", win, vec![]);
        assert_eq!(ended.get(), 2);
        assert_eq!(messages(&t).len(), 1);
        // the next one fails with the explanation for its error
        t.rt.script().save.push_back(Some(t.rt.dir.join("b.xlsx")));
        tools.export_office(OfficeFormat::Xlsx, None, Box::new(|| {}));
        t.rt.drain();
        let m = messages(&t);
        assert_eq!(m[1].message, "pdfXlsxFailedMsg");
        assert_eq!(
            m[1].detail.as_deref(),
            Some("pdfDocxLocalUnsupportedEncDetail")
        );
        assert_eq!(m[1].kind.as_deref(), Some("error"));
    }

    #[test]
    fn hwp_opens_a_copy_that_goes_with_its_tab() {
        let mut t = tools(json!({ "open_hwp_copy": [7, "no hangul"] }));
        let src = t.file("Report.PDF", b"%PDF");
        t.fake.set("active_pdf_tab", tab(&src));
        let pdf = t.pdf_view(5);
        assert_eq!(
            t.rt.invoke_now("pdf:convert-office", pdf, vec!["hwp".into_ipc()]),
            Ok(shell_contract::IpcValue::Undefined)
        );
        let call = t.fake.called("open_hwp_copy")[0].clone();
        let copy = call[0].as_str().unwrap().to_owned();
        assert_eq!(call[1], json!("Report"));
        assert_eq!(std::fs::read(&copy).unwrap(), b"%PDF");
        t.rt.destroy(ViewId(7));
        assert!(!std::path::Path::new(&copy).exists());
        let e =
            t.rt.invoke_now("pdf:convert-office", pdf, vec!["hwp".into_ipc()])
                .unwrap_err();
        assert_eq!(e.message, "no hangul");
        // the failed copy's folder is gone too
        let imports = t.rt.dir.join("temp/seuoffice-pdf-imports");
        assert_eq!(std::fs::read_dir(imports).unwrap().count(), 0);
    }

    #[test]
    fn the_dialog_request_goes_to_a_live_pdf_view() {
        let t = tools(json!({}));
        let tools = t.tools();
        tools.request_convert_dialog(Some(ViewId(5)), "md", None);
        assert!(t.rt.events().is_empty());
        t.pdf_view(5);
        tools.request_convert_dialog(Some(ViewId(5)), "epub", Some("/o.epub"));
        assert_eq!(
            j(&t.rt.events()[0].args[0]),
            json!({ "format": "epub", "outPath": "/o.epub" })
        );
    }
}
