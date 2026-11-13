//! The output stream of each view (the stage 3 shell contract, section 2,
//! "order"): replies and events leave through one Tauri `ipc::Channel` per
//! view, which delivers them in the order they were sent. The bridge opens it
//! with the command `ipc_listen` when a page starts; a frame sent before that
//! waits here.

use std::collections::HashMap;
use std::sync::Mutex;

use shell_contract::ids::ViewId;
use shell_core::outlet::Outlet;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::trace::trace;

/// What waits for a stream that is not open yet is bounded: a view that never
/// listens must not grow the queue without end
const MAX_WAITING_FRAMES: usize = 1024;

enum Stream {
    Waiting(Vec<Vec<u8>>),
    Open(Channel<InvokeResponseBody>),
}

#[derive(Default)]
pub struct TauriOutlet {
    streams: Mutex<HashMap<ViewId, Stream>>,
}

impl TauriOutlet {
    /// A view exists: frames for it are kept until its stream opens
    pub fn expect(&self, view: ViewId) {
        self.streams
            .lock()
            .unwrap()
            .entry(view)
            .or_insert_with(|| Stream::Waiting(Vec::new()));
    }

    /// The page's bridge opened its stream. Returns whether the view had one
    /// already: then the page was replaced by a new document (a reload or a
    /// navigation), and the calls of the old page are cancelled by the caller.
    pub fn attach(&self, view: ViewId, channel: Channel<InvokeResponseBody>) -> bool {
        let mut streams = self.streams.lock().unwrap();
        trace!(
            "outlet",
            "view {}: stream attached (channel {}), {} frames were waiting",
            view.0,
            channel.id(),
            match streams.get(&view) {
                Some(Stream::Waiting(frames)) => frames.len(),
                _ => 0,
            }
        );
        let waiting = match streams.remove(&view) {
            Some(Stream::Waiting(frames)) => frames,
            Some(Stream::Open(_)) => {
                streams.insert(view, Stream::Open(channel));
                return true;
            }
            None => Vec::new(),
        };
        for frame in waiting {
            if let Err(error) = channel.send(InvokeResponseBody::Raw(frame)) {
                eprintln!(
                    "shell: view {}: a waiting frame was not sent: {error}",
                    view.0
                );
            }
        }
        streams.insert(view, Stream::Open(channel));
        false
    }

    /// The view is gone
    pub fn forget(&self, view: ViewId) {
        self.streams.lock().unwrap().remove(&view);
    }
}

impl Outlet for TauriOutlet {
    fn deliver(&self, view: ViewId, frame: Vec<u8>) {
        // sent under the lock: two threads delivering to one view keep the
        // order they took the lock in
        let mut streams = self.streams.lock().unwrap();
        // a view that is gone has no slot: what is sent to it is dropped, as
        // a reply nobody waits for is (the contract, section 2, "cancel")
        let Some(stream) = streams.get_mut(&view) else {
            trace!(
                "outlet",
                "view {}: gone, {} bytes dropped",
                view.0,
                frame.len()
            );
            return;
        };
        match stream {
            Stream::Waiting(frames) => {
                trace!(
                    "outlet",
                    "view {}: no stream yet, {} bytes kept",
                    view.0,
                    frame.len()
                );
                if frames.len() < MAX_WAITING_FRAMES {
                    frames.push(frame);
                } else {
                    eprintln!("shell: view {}: no stream yet, a frame was dropped", view.0);
                }
            }
            Stream::Open(channel) => {
                let bytes = frame.len();
                match channel.send(InvokeResponseBody::Raw(frame)) {
                    Ok(()) => trace!("outlet", "view {}: {bytes} bytes sent", view.0),
                    Err(error) => {
                        eprintln!("shell: view {}: a frame was not sent: {error}", view.0)
                    }
                }
            }
        }
    }
}
