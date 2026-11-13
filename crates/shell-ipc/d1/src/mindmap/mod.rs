//! The `mindmap` channels of batch D1: a port of the `ipcMain` handlers of
//! `apps/mindmap/src/main`.
//!
//! The state of the TypeScript main module (a dozen maps keyed by
//! `webContents.id`) is one [`MindmapApp`] that every handler closure shares.
//! A promise that waited for the renderer (the menu's save, the close
//! prompt, the MCP server's reads, the OS session end) is a continuation the
//! renderer's reply, a timer or the view's end resumes; nothing blocks the
//! core thread.
//!
//! The shell reaches the app in two ways: other batches through
//! `DocumentEditors` (added to `Provided` in [`routes`]), and the view
//! lifecycle through [`handle`]: when it creates a map view it calls
//! [`MindmapApp::create_view`] (the grant of `grantAndTrack`), for a launch
//! list restore [`MindmapApp::open_file_with_decision`] or
//! [`MindmapApp::open_untitled_copy`], for queued content
//! [`MindmapApp::queue_seed`], and on a renderer crash
//! [`MindmapApp::view_crashed`].

mod app;
mod attach;
mod editors;
mod export;
mod handlers;
pub mod hosts;
#[cfg(any(test, feature = "probe"))]
mod net;
mod preview;
#[cfg(any(test, feature = "probe"))]
mod probe;
mod recovery;
#[cfg(test)]
mod tests;
mod text;
mod util;

use std::cell::RefCell;
use std::rc::Rc;

use shell_contract::editors::DocumentEditors;
use shell_contract::ipc::RegisterError;
use shell_contract::provided::Provided;
use shell_contract::runtime::Services;

use crate::route::Route;

pub use app::{
    Answer, COPY_NOW_WAIT, DONT_SAVE_HOLD, MAP_EXTENSION, MindmapApp, READ_TIMEOUT, RESEND,
    SAVE_WAIT, Seed, Wait,
};
pub use hosts::{
    FileParse, FileParseHost, LinkNet, LinkNetHost, MindmapShell, MindmapShellHost, OpenOutcome,
    OpenStatus, PageRenderer, PageRendererHost, ParsedText, XmindEngine, XmindEngineHost,
};
pub use preview::{PagePreview, parse_page_preview, read_link_preview};

thread_local! {
    /// the core thread's mind map app, set by [`routes`]
    static APP: RefCell<Option<MindmapApp>> = const { RefCell::new(None) };
}

/// The mind map app of this core thread, once [`routes`] ran: the shell's
/// entry for the view lifecycle
pub fn handle() -> Option<MindmapApp> {
    APP.with(|slot| slot.borrow().clone())
}

/// Runs `f` on the app, on the core thread; what a timer or a worker posts
/// back goes through here
pub(crate) fn with_app(f: impl FnOnce(&MindmapApp)) {
    if let Some(app) = handle() {
        f(&app)
    }
}

pub fn routes(services: &Services, provided: &Rc<Provided>) -> Result<Vec<Route>, RegisterError> {
    let app = MindmapApp::new(services)?;
    let gone = app.clone();
    crate::host::on_view_gone(services, move |view| gone.view_gone(view));
    provided.add::<dyn DocumentEditors>(Rc::new(editors::MindmapEditors(app.clone())));
    APP.with(|slot| *slot.borrow_mut() = Some(app.clone()));
    let mut routes = handlers::routes(&app);
    routes.extend(export::routes(&app));
    routes.extend(attach::routes(&app));
    routes.extend(preview::routes(&app));
    #[cfg(any(test, feature = "probe"))]
    if let Some(probe) = services.hosts.get::<probe::ProbeOpen>() {
        probe.apply(&app);
    }
    Ok(routes)
}

/// This app's fake hosts, answering from the case's `hosts.d1.mindmap` value
/// (`Null` in unit tests) and logging each call (see [`hosts::Fake`])
#[cfg(any(test, feature = "probe"))]
pub fn insert_fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    use std::sync::Arc;
    let fake = Arc::new(hosts::Fake::new(hosts, case));
    hosts.insert::<XmindEngineHost>(fake.clone());
    hosts.insert::<FileParseHost>(fake.clone());
    hosts.insert::<LinkNetHost>(fake.clone());
    hosts.insert::<PageRendererHost>(fake.clone());
    hosts.insert::<MindmapShellHost>(fake);
    hosts.insert(probe::probe_open(case));
    let clock = case
        .get("mindmap")
        .and_then(|script| script.get("clock"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    app::FIXED_CLOCK.store(clock, std::sync::atomic::Ordering::Relaxed);
}

/// This app's triggers for [`crate::probe_trigger`]: `name` without its
/// `d1/` prefix; false when it is not one of them. A trigger is what the shell,
/// a menu or the MCP server does to a map view, named after the TypeScript
/// function of `mindmap-main.ts` / `mcp-queries.ts` it stands for and run through
/// the mind map's [`DocumentEditors`] where the contract has the call, else
/// through [`MindmapApp`]; `advanceClock` is the probe's own: it lets the
/// timers due within the given milliseconds run.
#[cfg(feature = "probe")]
pub fn probe_trigger(
    name: &str,
    view: shell_contract::ViewId,
    args: &serde_json::Value,
    _services: &Services,
    provided: &std::rc::Rc<shell_contract::provided::Provided>,
    then: shell_contract::editors::Then<shell_contract::IpcValue>,
) -> bool {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use serde_json::Value;
    use shell_contract::IpcValue;
    use shell_contract::editors::{SaveMode, editor_for};

    use crate::value::{buffer, string, thrown};

    let Some(what) = name.strip_prefix("mindmap:") else {
        return false;
    };
    let Some(app) = handle() else {
        return false;
    };
    let text = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or("").to_owned();
    // the editor of the view as another batch finds it
    let editor = editor_for(provided, view);
    let Some(editor) = editor.filter(|_| !matches!(what, "advanceClock")) else {
        if what == "advanceClock" {
            let ms = args.get(0).and_then(Value::as_u64).unwrap_or(0);
            app.run_due(Instant::now() + Duration::from_millis(ms));
            then(Ok(IpcValue::Undefined));
            return true;
        }
        return false;
    };
    match what {
        "requestMindmapSave" => {
            let mode = if text(0) == "saveAs" {
                SaveMode::SaveAs
            } else {
                SaveMode::Save
            };
            editor.request_save(view, mode, Box::new(move |r| then(r.map(IpcValue::Bool))));
        }
        "requestMindmapClose" => {
            let parent = args
                .get(0)
                .and_then(Value::as_bool)
                .unwrap_or(false)
                .then(|| app.window_of(view))
                .flatten();
            editor.request_close(view, parent, Box::new(move |r| then(r.map(IpcValue::Bool))));
        }
        "mindmapSaveToPath" => editor.save_to_path(
            view,
            PathBuf::from(text(0)),
            Box::new(move |r| then(r.map(|()| IpcValue::Undefined))),
        ),
        "mindmapFileRenamed" => {
            editor.file_renamed(
                view,
                std::path::Path::new(&text(0)),
                std::path::Path::new(&text(1)),
            );
            then(Ok(IpcValue::Undefined));
        }
        "sendMindmapMenuCommand" => {
            app.send_menu_command(view, &text(0));
            then(Ok(IpcValue::Undefined));
        }
        "sendMindmapExportRequest" => {
            editor.export_request(view, &text(0));
            then(Ok(IpcValue::Undefined));
        }
        "mindmapReadOutline" => {
            editor.read_text(view, Box::new(move |r| then(r.map(IpcValue::String))))
        }
        "mindmapReadBytes" => {
            app.read_bytes(view, Box::new(move |r| then(r.map(buffer).map_err(thrown))))
        }
        "writeMindmapCopiesNow" => {
            let ms = args.get(0).and_then(Value::as_u64).unwrap_or(5000);
            app.write_copies_now(
                Duration::from_millis(ms),
                Box::new(move || then(Ok(IpcValue::Undefined))),
            );
        }
        "discardMindmapRecovery" => {
            app.discard_recovery(view);
            then(Ok(IpcValue::Undefined));
        }
        "mindmapFilePath" => then(Ok(editor
            .document_path(view)
            .map_or(IpcValue::Undefined, |p| string(p.to_string_lossy())))),
        "mindmapIsDirty" => then(Ok(IpcValue::Bool(app.is_dirty(view)))),
        _ => return false,
    }
    true
}
