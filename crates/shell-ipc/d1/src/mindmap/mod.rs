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
mod preview;
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
    Answer, COPY_NOW_WAIT, DONT_SAVE_HOLD, MAP_EXTENSION, MenuCommand, MindmapApp, READ_TIMEOUT,
    RESEND, SAVE_WAIT, Seed, Wait,
};
pub use hosts::{
    FetchResponse, FetchedImage, FileParse, FileParseHost, LinkNet, LinkNetHost, MindmapShell,
    MindmapShellHost, OpenOutcome, OpenStatus, PageRenderer, PageRendererHost, ParsedText,
    XmindEngine, XmindEngineHost,
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
}
