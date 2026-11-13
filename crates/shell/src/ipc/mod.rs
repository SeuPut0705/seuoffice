//! The shell's IPC boundary (the stage 3 shell contract, section 2): three
//! Tauri commands and one synchronous scheme, however many channels there are.
//!
//! - `ipc_invoke`: the raw body is the frame `{id, channel, args}`; it is
//!   posted to the core thread and dispatched there. The command answers
//!   "received"; the handler's answer leaves on the view's output stream as
//!   `{reply: id, value | error}`.
//! - `ipc_send`: the frame `{channel, args}`, no answer.
//! - `ipc_listen`: the bridge hands over the view's output stream (a Tauri
//!   `ipc::Channel`) when a page starts.
//! - `seuoffice-ipc` (see [`sync`]): `sendSync`, answered on the core thread.
//!
//! Who sent a message is the webview it came from: the command takes the
//! calling webview's label and looks it up in the [`ViewTable`]. A webview
//! without a bridge is not in it, and its messages are refused.

pub mod outlet;
pub mod sync;

use std::cell::RefCell;
use std::sync::Arc;

use serde_json::Value;
use shell_contract::error::IpcError;
use shell_contract::ids::{RequestId, ViewId};
use shell_contract::ipc::{ChannelKind, Reply, Sender};
use shell_contract::runtime::Thread;
use shell_contract::value::IpcValue;
use shell_core::dispatch::Dispatcher;
use shell_core::outlet::{Outlet, reply_frame};
use shell_core::wire::{decode_list, unframe};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{State, Webview};

use crate::measure::Measure;
use crate::views::ViewTable;
use outlet::TauriOutlet;

thread_local! {
    /// The dispatcher lives on the core thread, where the handlers' `Rc` state is
    static DISPATCHER: RefCell<Option<Dispatcher>> = const { RefCell::new(None) };
}

/// Installs the dispatcher on the core thread, from the job that built the table
pub fn install_dispatcher(dispatcher: Dispatcher) {
    DISPATCHER.with(|d| *d.borrow_mut() = Some(dispatcher));
}

/// Cancels a view's pending calls; on the core thread
pub fn view_destroyed(view: ViewId) {
    DISPATCHER.with(|d| {
        if let Some(d) = d.borrow().as_ref() {
            d.view_destroyed(view);
        }
    });
}

/// One message to its handler, on the core thread. `deliver` gets the answer
/// once, from whichever thread the handler answers on.
pub(crate) fn dispatch(
    sender: Sender,
    kind: ChannelKind,
    request: Option<RequestId>,
    channel: String,
    args: Vec<IpcValue>,
    deliver: Box<dyn FnOnce(Reply) + Send>,
) {
    DISPATCHER.with(|d| match d.borrow().as_ref() {
        Some(d) => d.dispatch(sender, kind, request, &channel, args, deliver),
        // the table is built before the first window opens; a message before it is a bug
        None => deliver(Err(IpcError {
            name: Some("Error".into()),
            message: "the shell has not finished starting".into(),
        })),
    });
}

/// What the commands and the scheme handler share; managed by Tauri
pub struct Ipc {
    pub core: Arc<dyn Thread>,
    pub views: Arc<ViewTable>,
    pub outlet: Arc<TauriOutlet>,
    /// set for `--measure-dialog`: the test channels of [`crate::measure`]
    pub measure: Option<Arc<Measure>>,
}

impl Ipc {
    pub(crate) fn sender(&self, webview: &Webview) -> Result<Sender, String> {
        self.views.sender_of_label(webview.label()).ok_or_else(|| {
            format!(
                "the webview '{}' has no bridge to the shell",
                webview.label()
            )
        })
    }
}

struct Call {
    id: Option<u64>,
    channel: String,
    args: Vec<IpcValue>,
}

/// The frame of `ipc_invoke` (`id`) or `ipc_send` (none)
fn parse(request: &Request<'_>, with_id: bool) -> Result<Call, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("the shell's IPC commands take a raw body".into());
    };
    let (header, buffers) = unframe(bytes).map_err(|e| e.to_string())?;
    let channel = header
        .get("channel")
        .and_then(Value::as_str)
        .ok_or("the frame has no channel")?
        .to_owned();
    let id = if with_id {
        Some(
            header
                .get("id")
                .and_then(Value::as_u64)
                .ok_or("the frame has no id")?,
        )
    } else {
        None
    };
    let args = decode_list(header.get("args").unwrap_or(&Value::Null), &buffers)
        .map_err(|e| e.to_string())?;
    Ok(Call { id, channel, args })
}

#[tauri::command]
pub async fn ipc_invoke(
    webview: Webview,
    request: Request<'_>,
    ipc: State<'_, Ipc>,
) -> Result<(), String> {
    let sender = ipc.sender(&webview)?;
    let Call { id, channel, args } = parse(&request, true)?;
    let id = RequestId(id.unwrap_or_default());
    let view = sender.view;

    if let Some(measure) = &ipc.measure
        && measure.handles(&channel)
    {
        measure.invoke(&ipc, view, id, &channel, args);
        return Ok(());
    }

    let outlet = ipc.outlet.clone();
    let reply_to = channel.clone();
    ipc.core.post(Box::new(move || {
        dispatch(
            sender,
            ChannelKind::Invoke,
            Some(id),
            channel,
            args,
            Box::new(move |reply| {
                outlet.deliver(view, reply_frame(id, &reply_to, &reply));
            }),
        );
    }));
    Ok(())
}

#[tauri::command]
pub async fn ipc_send(
    webview: Webview,
    request: Request<'_>,
    ipc: State<'_, Ipc>,
) -> Result<(), String> {
    let sender = ipc.sender(&webview)?;
    let Call { channel, args, .. } = parse(&request, false)?;
    ipc.core.post(Box::new(move || {
        let name = channel.clone();
        dispatch(
            sender,
            ChannelKind::Send,
            None,
            channel,
            args,
            // a failed `send` is only logged, as an uncaught exception in an
            // `ipcMain.on` listener was
            Box::new(move |reply| {
                if let Err(error) = reply {
                    eprintln!("shell: send '{name}': {error}");
                }
            }),
        );
    }));
    Ok(())
}

#[tauri::command]
pub async fn ipc_listen(
    webview: Webview,
    on_frame: Channel<InvokeResponseBody>,
    ipc: State<'_, Ipc>,
) -> Result<(), String> {
    let sender = ipc.sender(&webview)?;
    // a second stream for one view is a new document in it: the old page's
    // pending calls end, as they did when its renderer was replaced
    if ipc.outlet.attach(sender.view, on_frame) {
        let view = sender.view;
        ipc.core.post(Box::new(move || view_destroyed(view)));
    }
    Ok(())
}
