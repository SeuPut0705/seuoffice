//! `ipcRenderer.sendSync` (the stage 3 shell contract, section 2): a
//! synchronous XHR of the bridge to the scheme `seuoffice-ipc`. The CEF
//! runtime serves a custom scheme at `http://<scheme>.localhost/`, so the
//! request is `POST http://seuoffice-ipc.localhost/<channel>` (the bridge
//! builds the URL with Tauri's `convertFileSrc`); the body is the frame
//! `{args}`, the answer the frame `{value}` or `{error}`.
//!
//! Besides the table's one `sendSync` channel the scheme answers three
//! reserved channels that are not in the table, on any thread, from the
//! sender's view record: the drop paths of `webUtils.getPathForFile` and the
//! zoom factor of `webFrame`.

use std::borrow::Cow;

use serde_json::{Value, json};
use shell_contract::error::IpcError;
use shell_contract::ipc::{ChannelKind, Reply, Sender};
use shell_contract::value::IpcValue;
use shell_core::wire::{Encoder, decode_list, frame, unframe};
use tauri::http::{self, Method, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use super::{Ipc, dispatch};
use crate::trace::trace;

pub const SCHEME: &str = "seuoffice-ipc";

/// `webUtils.getPathForFile`: the paths of the sender's latest drop, in order
const DROPPED_PATHS: &str = "webutils:dropped-paths";
const SET_ZOOM_FACTOR: &str = "webframe:set-zoom-factor";
const GET_ZOOM_FACTOR: &str = "webframe:get-zoom-factor";

fn response(
    status: StatusCode,
    body: impl Into<Cow<'static, [u8]>>,
) -> http::Response<Cow<'static, [u8]>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "application/octet-stream")
        // the page's origin is another host of `.localhost`: a cross-origin XHR
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(http::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .body(body.into())
        .expect("a response of fixed parts")
}

fn answer_frame(reply: &Reply) -> Vec<u8> {
    let mut e = Encoder::default();
    let header = match reply {
        Ok(value) => json!({ "value": e.value(value) }),
        // `sendSync` has no "Error invoking remote method" sentence: Electron's
        // listener threw, and the bridge rethrows the text
        Err(error) => json!({ "error": error.to_string() }),
    };
    frame(&header, &e.buffers)
}

fn text_error(status: StatusCode, text: &str) -> http::Response<Cow<'static, [u8]>> {
    response(
        status,
        answer_frame(&Err(IpcError {
            name: None,
            message: text.into(),
        })),
    )
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if request.method() == Method::OPTIONS {
        responder.respond(response(StatusCode::NO_CONTENT, Vec::new()));
        return;
    }
    let ipc = ctx.app_handle().state::<Ipc>();
    let Some(sender) = ipc.views.sender_of_label(ctx.webview_label()) else {
        trace!("sync", "refused: '{}' has no bridge", ctx.webview_label());
        responder.respond(text_error(
            StatusCode::FORBIDDEN,
            "this webview has no bridge to the shell",
        ));
        return;
    };
    let channel =
        percent_encoding::percent_decode_str(request.uri().path().trim_start_matches('/'))
            .decode_utf8_lossy()
            .into_owned();
    trace!(
        "sync",
        "view {}: '{channel}' ({} bytes)",
        sender.view.0,
        request.body().len()
    );
    ipc.note_call();
    let args = match unframe(request.body()).and_then(|(header, buffers)| {
        decode_list(header.get("args").unwrap_or(&Value::Null), &buffers)
    }) {
        Ok(args) => args,
        Err(error) => {
            responder.respond(text_error(StatusCode::BAD_REQUEST, &error.to_string()));
            return;
        }
    };

    if let Some(value) = reserved(ctx.app_handle(), &ipc, sender, &channel, &args) {
        responder.respond(response(StatusCode::OK, answer_frame(&Ok(value))));
        return;
    }

    ipc.core.post(Box::new(move || {
        dispatch(
            sender,
            ChannelKind::SendSync,
            None,
            channel,
            args,
            Box::new(move |reply| {
                responder.respond(response(StatusCode::OK, answer_frame(&reply)))
            }),
        );
    }));
}

/// The reserved channels, or none when `channel` is a table channel
fn reserved<R: Runtime>(
    app: &AppHandle<R>,
    ipc: &Ipc,
    sender: Sender,
    channel: &str,
    args: &[IpcValue],
) -> Option<IpcValue> {
    match channel {
        DROPPED_PATHS => Some(IpcValue::Array(
            ipc.views
                .dropped(sender.view)
                .into_iter()
                .map(|p| IpcValue::String(p.to_string_lossy().into_owned()))
                .collect(),
        )),
        SET_ZOOM_FACTOR => {
            if let Some(IpcValue::Number(factor)) = args.first()
                && factor.is_finite()
                && *factor > 0.0
            {
                ipc.views.set_zoom(sender.view, *factor);
                if let Some(label) = ipc.views.label_of_view(sender.view)
                    && let Some(webview) = app.get_webview(&label)
                    && let Err(error) = webview.set_zoom(*factor)
                {
                    eprintln!("shell: webFrame.setZoomFactor on '{label}': {error}");
                }
            }
            Some(IpcValue::Undefined)
        }
        GET_ZOOM_FACTOR => Some(IpcValue::Number(ipc.views.zoom(sender.view))),
        _ => None,
    }
}
