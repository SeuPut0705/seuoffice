//! `clipboard.*` (the shared host `Clipboard`), the formats the handlers
//! use. The clipboard is touched on the UI thread only (the contract,
//! section 3); each call opens it afresh, as the platform crates are not
//! `Send`.

use std::sync::Arc;

use clipboard_rs::common::RustImage;
use clipboard_rs::{
    Clipboard as _, ClipboardContent, ClipboardContext, ContentFormat, RustImageData,
};
use shell_contract::hosts::Clipboard;
use shell_contract::runtime::Thread;
use shell_contract::{ClipboardHost, Hosts};

use super::{HostContext, on_ui};

struct ShellClipboard {
    ui: Arc<dyn Thread>,
}

pub fn install(hosts: &mut Hosts, cx: &HostContext) {
    let clipboard: ClipboardHost = Arc::new(ShellClipboard { ui: cx.ui.clone() });
    hosts.insert(clipboard);
}

/// `job` on the UI thread with the clipboard; a clipboard that cannot be opened is logged and reads as empty
fn with_clipboard<R: Default + Send + 'static>(
    ui: &Arc<dyn Thread>,
    what: &'static str,
    job: impl FnOnce(&ClipboardContext) -> clipboard_rs::Result<R> + Send + 'static,
) -> R {
    on_ui(ui, move || {
        let result = ClipboardContext::new().and_then(|context| job(&context));
        result.unwrap_or_else(|error| {
            eprintln!("shell: clipboard.{what}: {error}");
            R::default()
        })
    })
}

impl Clipboard for ShellClipboard {
    fn read_text(&self) -> String {
        with_clipboard(&self.ui, "readText", |c| c.get_text())
    }

    fn write_text(&self, text: &str) {
        let text = text.to_owned();
        with_clipboard(&self.ui, "writeText", move |c| c.set_text(text));
    }

    fn read_html(&self) -> String {
        with_clipboard(&self.ui, "readHTML", |c| c.get_html())
    }

    fn write_html(&self, html: &str, text: Option<&str>) {
        let mut contents = vec![ClipboardContent::Html(html.to_owned())];
        if let Some(text) = text {
            contents.push(ClipboardContent::Text(text.to_owned()));
        }
        with_clipboard(&self.ui, "write", move |c| c.set(contents));
    }

    fn read_image_png(&self) -> Vec<u8> {
        with_clipboard(&self.ui, "readImage", |c| {
            // no image on the clipboard is an error of the platform crate: empty bytes
            Ok(match c.get_image() {
                Ok(image) => image
                    .to_png()
                    .map(|p| p.get_bytes().to_vec())
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            })
        })
    }

    fn write_image_png(&self, png: &[u8]) {
        let png = png.to_vec();
        with_clipboard(&self.ui, "writeImage", move |c| {
            c.set_image(RustImageData::from_bytes(&png)?)
        });
    }

    fn available_formats(&self) -> Vec<String> {
        with_clipboard(&self.ui, "availableFormats", |c| {
            let formats = [
                (ContentFormat::Text, "text/plain"),
                (ContentFormat::Html, "text/html"),
                (ContentFormat::Rtf, "text/rtf"),
                (ContentFormat::Image, "image/png"),
                (ContentFormat::Files, "text/uri-list"),
            ];
            Ok(formats
                .into_iter()
                .filter(|(format, _)| c.has(format.clone()))
                .map(|(_, mime)| mime.to_owned())
                .collect())
        })
    }
}
