//! What the diagram handlers need that is not in Rust yet: the draw.io
//! model (`@seuoffice/drawio-model`) and `file-parse`. One method per
//! TypeScript function the handlers call.

use std::sync::Arc;

use super::formats::DiagramFormat;

/// The diagram a file opens as: `DiagramFile` of the model, the fields the
/// handlers read
#[derive(Clone, Debug, PartialEq)]
pub struct DiagramFile {
    /// the draw.io XML to load (taken out of an SVG or PNG for those formats)
    pub xml: String,
    pub format: DiagramFormat,
    /// `file.root`: `mxfile` or `mxGraphModel`
    pub root: String,
    /// whether any page is stored compressed (`file.pages.some(p => p.compressed)`)
    pub any_page_compressed: bool,
}

/// `DiagramOpenFailure` of the model
#[derive(Clone, Debug, PartialEq)]
pub struct OpenFailure {
    /// `unsupported`, `no_original`, `corrupt_image`, `not_xml`,
    /// `decompress_failed` or `no_diagram`
    pub reason: String,
    pub message: String,
}

/// What `parseFileToText` answers, the fields the handlers read
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedText {
    pub ok: bool,
    /// `kind === 'text'`
    pub is_text: bool,
    pub text: Option<String>,
    pub damaged: bool,
    pub error: Option<String>,
}

pub trait DiagramEngine: Send + Sync {
    /// `openDiagram(name, bytes, nodePageCodec)` of `@seuoffice/drawio-model`
    fn open_diagram(&self, name: &str, bytes: &[u8]) -> Result<DiagramFile, OpenFailure>;

    /// `diagramPictureExtOf(filePath)` of `@seuoffice/file-parse`: `DrawioSvg`
    /// or `DrawioPng` when the file is named so and holds its diagram
    fn diagram_picture_ext_of(&self, path: &str) -> Option<DiagramFormat>;

    /// `parseFileToText(filePath)` of `@seuoffice/file-parse`. Runs on a
    /// worker thread.
    fn parse_file_to_text(&self, path: &str) -> ParsedText;
}

pub type DiagramEngineHost = Arc<dyn DiagramEngine>;
