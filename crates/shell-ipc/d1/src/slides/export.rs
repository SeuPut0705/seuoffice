//! Export and picker channels, headless export, local fonts, template bytes
//! and cover, microphone, hand-off and generated pages.

use std::time::{Duration, Instant};

use jscompat::{JsonValue, buffer_from_base64};
use main_core::slides::export_images::build_export_image_paths;
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::Target;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::{IpcError, IpcValue, ViewId};

use super::dialog::{filter, jstr, jstrs, options};
use super::lifecycle::read_file;
use super::session::{Obj, null, prop};
use super::state::{App, NarrationMicrophone};
use crate::value::{Args, as_str, buffer, field, obj, string, thrown};

type Reply = Result<IpcValue, IpcError>;

/// `NARRATION_MICROPHONE_MAX_MS`
const NARRATION_MICROPHONE_MAX: Duration = Duration::from_secs(4 * 60 * 60);

fn node_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| {
        format!(
            "Error: {}",
            main_core::node_fs::node_error(&e, "open", path).message
        )
    })
}

pub fn pick_export_dir(app: &App, _cx: &CallContext, _args: Args) -> Reply {
    let picked = app.pick_open_first(&options([
        ("title", jstr(app.tm("dlgPickExportDir", &[]))),
        ("buttonLabel", jstr(app.tm("btnExport", &[]))),
        ("properties", jstrs(&["openDirectory", "createDirectory"])),
    ]));
    Ok(picked.map_or(IpcValue::Null, string))
}

/// `slides:ask-withheld-export`: a PDF or image copy records no mark, so the
/// person chooses before anything is written; the renderer acts on the answer
pub fn ask_withheld_export(app: &App, _cx: &CallContext, args: Args) -> Reply {
    let format = match args.str(0) {
        Some(format @ ("PDF" | "PNG" | "JPG")) => format,
        _ => return Err(thrown("Invalid export format.")),
    };
    let with_format = [("format", JsonValue::String(format.to_owned()))];
    let options = MessageBox {
        kind: Some("warning".into()),
        title: None,
        message: app.tm("withheldExportMsg", &with_format),
        detail: Some(app.tm("withheldExportDetail", &with_format)),
        buttons: vec![
            app.tm("withheldExportKeepPptxBtn", &[]),
            app.tm("withheldExportWithoutMarksBtn", &with_format),
            app.tm("btnCancel", &[]),
        ],
        default_id: Some(0),
        cancel_id: Some(2),
        checkbox_label: None,
    };
    Ok(string(
        match app.message_box(app.shell.dialog_parent(), &options) {
            0 => "pptx",
            1 => "export",
            _ => "cancel",
        },
    ))
}

pub fn pick_export_pdf_path(app: &App, _cx: &CallContext, args: Args) -> Reply {
    let mut entries = vec![("title", jstr(app.tm("dlgExportPdf", &[])))];
    if let Some(name) = args.str(0) {
        entries.push(("defaultPath", jstr(name)));
    }
    let mut opts = jscompat::JsObject::new();
    for (key, value) in entries {
        opts.set(key, value);
    }
    opts.set("filters", JsonValue::Array(vec![filter("PDF", &["pdf"])]));
    Ok(app.pick_save(&opts)?.map_or(IpcValue::Null, string))
}

pub fn save_picture(app: &App, _cx: &CallContext, args: Args) -> Reply {
    let op = args.get(0);
    let default_name = match prop(op, "defaultName")? {
        IpcValue::String(name) => name.clone(),
        IpcValue::Undefined => "undefined".to_owned(),
        other => super::session::js_string(other),
    };
    let picked = app.pick_save(&options([
        ("title", jstr(app.tm("dlgSavePicture", &[]))),
        ("defaultPath", jstr(format!("{default_name}.png"))),
        ("filters", JsonValue::Array(vec![filter("PNG", &["png"])])),
    ]))?;
    let Some(path) = picked else {
        return Ok(obj([("ok", IpcValue::Bool(false))]));
    };
    let bytes = buffer_from_base64(as_str(field(op, "pngBase64")).unwrap_or(""));
    Ok(match node_write(&path, &bytes) {
        Ok(()) => obj([("ok", IpcValue::Bool(true)), ("path", string(path))]),
        Err(error) => obj([("ok", IpcValue::Bool(false)), ("error", string(error))]),
    })
}

pub fn export_images(app: &App, cx: &CallContext, args: Args, responder: Responder) {
    let op = args.get(0);
    let failed = |error: String| obj([("ok", IpcValue::Bool(false)), ("error", string(error))]);
    let outcome: Result<(Vec<String>, Vec<Vec<u8>>), String> = (|| {
        let format = prop(op, "format").map_err(|e| e.to_string())?;
        let ext = if as_str(format) == Some("jpg") {
            "jpg"
        } else {
            "png"
        };
        let target = field(op, "saveAsTarget");
        let has_target = !matches!(target, IpcValue::Undefined);
        if has_target && ext != "png" {
            return Err("Save As images are PNG".into());
        }
        let pngs: Vec<Vec<u8>> = match field(op, "pngsBase64") {
            IpcValue::Array(items) => items
                .iter()
                .map(|item| buffer_from_base64(as_str(item).unwrap_or("")))
                .collect(),
            _ => {
                return Err(
                    "TypeError: Cannot read properties of undefined (reading 'length')".into(),
                );
            }
        };
        let count = pngs.len() as f64;
        let paths = if has_target {
            let wanted = as_str(target).unwrap_or("").to_owned();
            let taken = app.state.borrow_mut().save_as_image_targets.take(
                f64::from(cx.sender.view.0),
                &wanted,
                count,
            );
            match taken {
                Ok(paths) => paths,
                Err(error) => return Err(format!("RangeError: {}", error.0)),
            }
        } else {
            Some(build_export_image_paths(
                as_str(field(op, "dir")).unwrap_or(""),
                as_str(field(op, "baseName")).unwrap_or(""),
                count,
                ext,
            ))
        };
        let Some(paths) = paths else {
            return Err("export target was not authorized".into());
        };
        Ok((paths, pngs))
    })();
    let (paths, pngs) = match outcome {
        Ok(ok) => ok,
        Err(error) => return responder.reply(Ok(failed(error))),
    };
    app.services.workers.spawn(Box::new(move || {
        for (path, bytes) in paths.iter().zip(&pngs) {
            if let Err(error) = node_write(path, bytes) {
                return responder.reply(Ok(failed(error)));
            }
        }
        responder.reply(Ok(obj([
            ("ok", IpcValue::Bool(true)),
            (
                "paths",
                IpcValue::Array(paths.into_iter().map(string).collect()),
            ),
        ])))
    }));
}

pub fn export_pdf(app: &App, _cx: &CallContext, args: Args, responder: Responder) {
    let op = args.get(0).clone();
    let shell = app.shell.clone();
    let os_shell = app.os_shell.clone();
    app.services.workers.spawn(Box::new(move || {
        let result = shell.export_pdf(&op);
        if result.ok
            && let Some(path) = &result.path
            && !shell.is_headless()
        {
            // open the PDF in a tab (shell) or reveal it in the folder
            if !shell.open_generated_path(path) {
                os_shell.show_item_in_folder(std::path::Path::new(path));
            }
        }
        let mut reply = Obj::new().set("ok", IpcValue::Bool(result.ok));
        if let Some(path) = result.path {
            reply = reply.set("path", string(path));
        }
        if let Some(error) = result.error {
            reply = reply.set("error", string(error));
        }
        responder.reply(Ok(reply.build()))
    }));
}

pub fn consume_headless_export(app: &App, cx: &CallContext, _args: Args) -> Reply {
    Ok(app
        .shell
        .take_headless_target(cx.sender.view)
        .map_or(IpcValue::Null, string))
}

pub fn headless_export_done(app: &App, cx: &CallContext, args: Args) -> Result<(), IpcError> {
    let result = args.get(0);
    let ok = matches!(field(result, "ok"), IpcValue::Bool(true));
    let error = as_str(field(result, "error")).map(str::to_owned);
    app.shell.headless_export_done(cx.sender.view, ok, error);
    Ok(())
}

pub fn font_install_local(app: &App, _cx: &CallContext, _args: Args) -> Reply {
    let paths = app.pick_open(&options([
        ("properties", jstrs(&["openFile", "multiSelections"])),
        (
            "filters",
            JsonValue::Array(vec![filter("Fonts", &["ttf", "otf", "ttc", "otc"])]),
        ),
    ]));
    if paths.is_empty() {
        return Ok(obj([("families", IpcValue::Array(Vec::new()))]));
    }
    let user_data = crate::host::path_string(
        app.services
            .paths
            .path(shell_contract::runtime::PathName::UserData),
    );
    let engine = app.engine.clone();
    let families = main_core::slides::font_store::install_local_font_files(
        &mut || user_data.clone(),
        &|path| engine.font_file_families(path),
        &paths,
    )
    .map_err(|e| thrown(e.message))?;
    if !families.is_empty() {
        app.after_fonts_changed();
    }
    Ok(obj([(
        "families",
        IpcValue::Array(families.into_iter().map(string).collect()),
    )]))
}

impl App {
    /// `afterFontsChanged()`: rebuild every open session with a fresh
    /// registry and push the relaid-out slides to all attached windows
    fn after_fonts_changed(&self) {
        self.engine.reset_font_metrics();
        let sends: Vec<(ViewId, IpcValue)> = {
            let state = self.state.borrow();
            let mut sends = Vec::new();
            for slot in state.live_slots() {
                let Some(session) = state.slot(slot) else {
                    continue;
                };
                let payload = obj([
                    ("slides", self.render_all(session)),
                    ("size", self.size_value(self.engine.size(session.deck()))),
                ]);
                for view in state.attached_ids(slot) {
                    sends.push((view, payload.clone()));
                }
            }
            sends
        };
        for (view, payload) in sends {
            self.emit(view, "slides:deck-changed", vec![payload]);
        }
        self.services
            .events
            .emit(Target::All, "slides:fonts-changed", Vec::new());
    }
}

pub fn private_font_faces(app: &App, _cx: &CallContext, _args: Args) -> Reply {
    Ok(app.engine.private_font_faces())
}

pub fn private_font_data(app: &App, _cx: &CallContext, args: Args) -> Reply {
    Ok(app.engine.private_font_data(args.get(0)))
}

// ---- template bytes and cover ----

pub fn template_bytes(app: &App, cx: &CallContext, _args: Args) -> Reply {
    let state = app.state.borrow();
    let Some(s) = state.session(cx.sender.view) else {
        // `track` runs the write: no deck, no bytes
        return null();
    };
    // refused while an AI run's unaccepted edits are in the deck: null
    if s.core.ai_run {
        return null();
    }
    Ok(match app.engine.save_bytes(s.deck()) {
        Ok(bytes) => obj([
            ("bytes", buffer(bytes)),
            (
                "redacted",
                IpcValue::Bool(app.engine.has_redaction(s.deck())),
            ),
        ]),
        Err(_) => IpcValue::Null,
    })
}

pub fn template_cover_render(app: &App, _cx: &CallContext, args: Args) -> Reply {
    let (Some(id), Some(lang)) = (args.str(0), args.str(1)) else {
        return null();
    };
    if lang != "ko" && lang != "en" {
        return null();
    }
    let key = format!("{id}\n{lang}");
    if let Some(cached) = app.state.borrow().covers.get(&key) {
        return Ok(cached.clone().unwrap_or(IpcValue::Null));
    }
    // the width the editor lays slides out at (the renderer's FIT_WIDTH)
    let cover = app.engine.template_cover(id, lang, 1280.0);
    // a failure is not kept, so the next ask retries
    if cover.is_some() {
        app.state.borrow_mut().covers.insert(key, cover.clone());
    }
    Ok(cover.unwrap_or(IpcValue::Null))
}

// ---- narration microphone ----

impl App {
    /// `closeNarrationMicrophone(wcId)`
    pub fn close_narration_microphone(&self, view: ViewId) {
        self.state.borrow_mut().narration.remove(&view);
    }

    /// `slidesMicrophoneOpen(wcId)`: true from the moment this editor's
    /// narration recording was let start until it stops
    pub fn microphone_open(&self, view: ViewId) -> bool {
        self.state
            .borrow()
            .narration
            .get(&view)
            .and_then(|m| m.deadline)
            .is_some_and(|deadline| Instant::now() < deadline)
    }
}

pub fn microphone_access(app: &App, cx: &CallContext, _args: Args, responder: Responder) {
    let view = cx.sender.view;
    let ticket = {
        let mut state = app.state.borrow_mut();
        // only an editor with a deck open records
        if !state.has_session(view) {
            return responder.reply(Ok(IpcValue::Bool(false)));
        }
        state.next_ticket += 1;
        let ticket = state.next_ticket;
        state.narration.insert(
            view,
            NarrationMicrophone {
                deadline: None,
                ticket,
            },
        );
        ticket
    };
    let index = app.registry_index;
    let services = app.services.clone();
    app.shell.ask_microphone(Box::new(move |granted| {
        super::post_to(&services, index, move |app| {
            let reply = {
                let mut state = app.state.borrow_mut();
                // Stop, navigation or a newer recording invalidates this OS question
                if state.narration.get(&view).map(|m| m.ticket) != Some(ticket) {
                    false
                } else if !granted || !state.has_session(view) {
                    state.narration.remove(&view);
                    false
                } else {
                    if let Some(recording) = state.narration.get_mut(&view) {
                        recording.deadline = Some(Instant::now() + NARRATION_MICROPHONE_MAX);
                    }
                    true
                }
            };
            responder.reply(Ok(IpcValue::Bool(reply)));
        })
    }));
}

pub fn microphone_release(app: &App, cx: &CallContext, _args: Args) -> Result<(), IpcError> {
    app.close_narration_microphone(cx.sender.view);
    Ok(())
}

// ---- generate hand-off ----

pub fn handoff_take(app: &App, cx: &CallContext, _args: Args) -> Reply {
    Ok(match app.shell.take_generate_handoff(cx.sender.view) {
        None => IpcValue::Null,
        Some(handoff) => obj([
            ("id", string(handoff.id)),
            ("text", string(handoff.text)),
            (
                "materials",
                IpcValue::Array(
                    handoff
                        .materials
                        .into_iter()
                        .map(|(path, name)| obj([("path", string(path)), ("name", string(name))]))
                        .collect(),
                ),
            ),
        ]),
    })
}

/// a run carries at most this many attachment paths in one report
const MAX_REPORTED_PATHS: usize = 200;

pub fn handoff_run_started(app: &App, cx: &CallContext, args: Args) -> Reply {
    let IpcValue::Array(items) = args.get(0) else {
        return Ok(IpcValue::Bool(false));
    };
    let paths: Vec<String> = items
        .iter()
        .take(MAX_REPORTED_PATHS)
        .filter_map(|p| as_str(p).filter(|s| !s.is_empty()).map(str::to_owned))
        .collect();
    if paths.is_empty() {
        return Ok(IpcValue::Bool(false));
    }
    Ok(IpcValue::Bool(
        app.shell
            .report_generate_run_started(cx.sender.view, &paths),
    ))
}

// ---- generated pages ----

const CLOUD_PAGE_PREFIX: &str = "cloudpptx:";

pub fn local_page_generate(app: &App, _cx: &CallContext, args: Args, responder: Responder) {
    let op = args.get(0);
    let spec_json = match field(op, "specJson") {
        IpcValue::String(text) => text.clone(),
        IpcValue::Undefined | IpcValue::Null => String::new(),
        other => super::session::js_string(other),
    };
    let default_fonts = field(op, "defaultFonts").clone();
    let engine = app.engine.clone();
    let shell = app.shell.clone();
    let temp = app
        .services
        .paths
        .path(shell_contract::runtime::PathName::Temp);
    let index = app.registry_index;
    let services = app.services.clone();
    app.services.workers.spawn(Box::new(move || {
        let failed = |error: String| obj([("ok", IpcValue::Bool(false)), ("error", string(error))]);
        let page = match engine.generate_page(&spec_json, &default_fonts) {
            Ok(page) => page,
            Err(error) => return responder.reply(Ok(failed(error))),
        };
        let dir = temp.join("seuoffice-local-pages");
        let path = dir.join(format!("{}.pptx", shell.random_uuid()));
        let path_text = path.to_string_lossy().into_owned();
        if let Err(error) =
            std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, &page.bytes))
        {
            return responder.reply(Ok(failed(error.to_string())));
        }
        let reply = Obj::new()
            .set("ok", IpcValue::Bool(true))
            .set("marker", string(format!("{CLOUD_PAGE_PREFIX}{path_text}")))
            .set_if(!page.image_failures.is_empty(), "imageFailures", || {
                IpcValue::Array(
                    page.image_failures
                        .iter()
                        .map(|f| string(f.as_str()))
                        .collect(),
                )
            })
            .build();
        super::post_to(&services, index, move |app| {
            app.state.borrow_mut().issued_cloud_pages.insert(path_text);
            responder.reply(Ok(reply));
        });
    }));
}

impl App {
    /// `readCloudPage(marker)`: the bytes of a page this process issued
    fn read_cloud_page(&self, marker: &IpcValue) -> Result<Vec<u8>, IpcError> {
        let Some(rest) = as_str(marker).and_then(|m| m.strip_prefix(CLOUD_PAGE_PREFIX)) else {
            return Err(thrown("expected a generated page marker"));
        };
        if !self.state.borrow().issued_cloud_pages.contains(rest) {
            return Err(thrown("unknown generated page marker"));
        }
        read_file(rest)
    }

    pub fn page_marker_list<'a>(&self, markers: &'a IpcValue) -> &'a [IpcValue] {
        match markers {
            IpcValue::Array(items) => items,
            _ => &[],
        }
    }

    pub fn read_cloud_pages(&self, markers: &IpcValue) -> Result<Vec<Vec<u8>>, IpcError> {
        self.page_marker_list(markers)
            .iter()
            .map(|m| self.read_cloud_page(m))
            .collect()
    }

    pub fn read_one_cloud_page(&self, marker: &IpcValue) -> Result<Vec<u8>, IpcError> {
        self.read_cloud_page(marker)
    }
}
