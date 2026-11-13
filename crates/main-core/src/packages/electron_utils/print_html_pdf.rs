//! `packages/electron-utils/src/print-html-pdf.ts`.
//!
//! Render a standalone HTML document to PDF bytes in a hidden window, shared
//! by the AI create_document flows. The caller makes the window through
//! `createWindow` (a [`PrintWindow`]); the renderer calls on it are the steps
//! of a [`PdfJob`] the caller carries out. The HTML is parsed and written by
//! `crate::html_parse`, which follows parse5.

use jscompat::node_path::host::join;
use serde_json::{Map, Value};

use super::print_window::{
    JsError, RendererAnswer, RendererCall, WindowStep, load_call, release_job,
};
use crate::html_parse::{self, Node};
use crate::node_fs::node_error;

/// `PrintWindow`: what a job calls on the hidden window it made without
/// waiting for its renderer. `loadFile` and `printToPDF` are the steps of a
/// [`PdfStep`].
pub trait PrintWindow {
    fn destroy(&mut self) -> Result<(), JsError>;
}

/// A job that loads a page it wrote into its own hidden window and prints it to
/// PDF bytes (`printHtmlToPdf`, and the PDF exports of markdown and Hangul
/// that do the same): the window, the work folder, and the `printToPDF`
/// options until the load is done.
#[derive(Debug)]
pub struct PdfJob<W> {
    win: W,
    work_dir: String,
    /// `Some` while the load is awaited
    options: Option<Value>,
}

/// A step of a [`PdfJob`]; [`WindowStep::Done`] holds the PDF once the window
/// is destroyed and the folder removed, or what the job or that cleanup threw
/// (the cleanup's error replaces the job's).
pub type PdfStep<W> = WindowStep<PdfJob<W>, Result<Vec<u8>, JsError>>;

impl<W: PrintWindow> PdfJob<W> {
    /// The job once its window is made and its page written at `html_path`:
    /// `await win.loadFile(htmlPath)`, then `printToPDF(options)`.
    pub(crate) fn loading(win: W, work_dir: String, html_path: &str, options: Value) -> PdfStep<W> {
        WindowStep::Await {
            call: load_call(html_path),
            job: PdfJob {
                win,
                work_dir,
                options: Some(options),
            },
        }
    }

    /// The window the awaited call is carried out on.
    pub fn window(&mut self) -> &mut W {
        &mut self.win
    }

    /// The answer to the call this job waits for.
    pub fn resume(mut self, answer: RendererAnswer) -> PdfStep<W> {
        match self.options.take() {
            Some(options) => match answer.into_loaded() {
                Ok(()) => WindowStep::Await {
                    call: RendererCall::PrintToPdf { options },
                    job: self,
                },
                Err(error) => self.end(Err(error)),
            },
            None => {
                let pdf = answer.into_pdf();
                self.end(pdf)
            }
        }
    }

    fn end(mut self, pdf: Result<Vec<u8>, JsError>) -> PdfStep<W> {
        let released = release_job(Some(&mut self.win), &self.work_dir, |win| win.destroy());
        WindowStep::Done(released.and(pdf))
    }
}

/// The start every job of this shape shares: a work folder named `dir_prefix`
/// under `tmp_dir`, then (in the `try`) the window made and the page written
/// as `print.html`. What fails after the folder exists goes through the job's
/// `finally`.
pub(crate) fn begin_pdf_job<W: PrintWindow>(
    create_window: impl FnOnce() -> Result<W, JsError>,
    html: &str,
    tmp_dir: &str,
    dir_prefix: &str,
    options: Value,
) -> PdfStep<W> {
    let work_dir = match crate::node_fs::mkdtemp_random(&join(&[tmp_dir, dir_prefix])) {
        Ok(dir) => dir,
        Err(error) => return WindowStep::Done(Err(error.into())),
    };
    let mut win = match create_window() {
        Ok(win) => win,
        Err(error) => {
            let released = release_job::<W>(None, &work_dir, |win| win.destroy());
            return WindowStep::Done(released.and(Err(error)));
        }
    };
    let html_path = join(&[&work_dir, "print.html"]);
    if let Err(e) = std::fs::write(&html_path, html) {
        let error = node_error(&e, "open", &html_path).into();
        let released = release_job(Some(&mut win), &work_dir, |win| win.destroy());
        return WindowStep::Done(released.and(Err(error)));
    }
    PdfJob::loading(win, work_dir, &html_path, options)
}

fn escape_html_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

const ALLOWED_BODY_TAGS: [&str; 26] = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "u",
    "s",
    "a",
    "br",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "pre",
    "code",
    "blockquote",
    "formula",
];

/// Elements whose contents must not be salvaged as printable text.
const DROP_WITH_CONTENT: [&str; 15] = [
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base",
    "form", "template", "noscript", "svg", "math",
];

fn sanitize_children(nodes: Vec<Node>) -> Vec<Node> {
    let mut safe: Vec<Node> = Vec::new();
    for node in nodes {
        match node {
            Node::Text(_) => safe.push(node),
            Node::Comment(_) => {}
            Node::Element(mut element) => {
                let tag = element.name.to_lowercase();
                if DROP_WITH_CONTENT.contains(&tag.as_str()) {
                    continue;
                }
                let children = sanitize_children(std::mem::take(&mut element.children));
                if ALLOWED_BODY_TAGS.contains(&tag.as_str()) {
                    element.attrs = Vec::new();
                    element.children = children;
                    safe.push(Node::Element(element));
                } else {
                    safe.extend(children);
                }
            }
        }
    }
    safe
}

/// Keep only the restricted document tags and strip every attribute/URL.
pub fn sanitize_printable_body(body_html: &str) -> String {
    let fragment = html_parse::parse_fragment(body_html);
    html_parse::serialize(&sanitize_children(fragment))
}

/// `serialize(parseFragment(html))`, with no sanitizing
pub fn parse_and_serialize(fragment_html: &str) -> String {
    html_parse::serialize(&html_parse::parse_fragment(fragment_html))
}

// Print stylesheet, not UI chrome: document output must render identically in
// both app themes, so the colors stay hardcoded.
const PRINT_CSS: &str = "
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB',
      'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #1a1a1a;
    margin: 0;
  }
  h1 { font-size: 20pt; line-height: 1.3; margin: 0 0 12pt; }
  h2 { font-size: 16pt; line-height: 1.3; margin: 16pt 0 8pt; }
  h3 { font-size: 13pt; line-height: 1.3; margin: 14pt 0 6pt; }
  h4, h5, h6 { font-size: 11pt; margin: 12pt 0 4pt; }
  p { margin: 0 0 8pt; }
  ul, ol { margin: 0 0 8pt; padding-left: 22pt; }
  li { margin: 0 0 3pt; }
  table { border-collapse: collapse; margin: 0 0 10pt; width: 100%; }
  th, td { border: 1pt solid #999; padding: 3pt 6pt; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  pre {
    font-family: Consolas, Menlo, monospace;
    font-size: 9.5pt;
    background: #f5f5f5;
    border: 1pt solid #ddd;
    padding: 6pt 8pt;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0 0 8pt;
  }
  blockquote { border-left: 3pt solid #ccc; color: #555; margin: 0 0 8pt; padding: 0 0 0 10pt; }
";

const PRINT_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'";

/// Sanitize an AI-generated restricted-HTML body and wrap it in a printable page.
pub fn build_printable_html(title: &str, body_html: &str) -> String {
    [
        "<!DOCTYPE html>".to_owned(),
        "<html>".to_owned(),
        "<head>".to_owned(),
        "<meta charset=\"utf-8\">".to_owned(),
        format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{PRINT_CSP}\">"),
        format!("<title>{}</title>", escape_html_text(title)),
        format!("<style>{PRINT_CSS}</style>"),
        "</head>".to_owned(),
        format!("<body>{}</body>", sanitize_printable_body(body_html)),
        "</html>".to_owned(),
    ]
    .join("\n")
}

/// The options `printHtmlToPdf` hands to `printToPDF`.
fn pdf_options() -> Value {
    let mut margins = Map::new();
    for side in ["top", "bottom", "left", "right"] {
        margins.insert(side.into(), Value::from(0.6));
    }
    let mut options = Map::new();
    options.insert("pageSize".into(), Value::from("A4"));
    options.insert("printBackground".into(), Value::Bool(true));
    options.insert("margins".into(), Value::Object(margins));
    Value::Object(options)
}

/// `printHtmlToPdf(html, createWindow)` up to its first await: load the HTML in
/// the supplied hidden window and print it to A4 PDF bytes. The HTML goes
/// through a temp file (data: URLs truncate long documents); the window is
/// destroyed and the temp dir removed in every outcome. `tmp_dir` is
/// `os.tmpdir()`. Where `destroy` throws, the temp dir stays, as in the
/// TypeScript.
pub fn begin_print_html_to_pdf<W: PrintWindow>(
    html: &str,
    create_window: impl FnOnce() -> Result<W, JsError>,
    tmp_dir: &str,
) -> PdfStep<W> {
    begin_pdf_job(
        create_window,
        html,
        tmp_dir,
        "seuoffice-ai-doc-",
        pdf_options(),
    )
}
