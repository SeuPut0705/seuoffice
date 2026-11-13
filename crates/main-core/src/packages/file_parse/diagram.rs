//! `packages/file-parse/src/diagram.ts` and `diagramPictureExtOfName` of
//! `attachable.ts` (it reads `detectDiagramFormat` of
//! `packages/drawio-model/src/format.ts`, ported here as far as the name
//! goes). Reading a diagram (`readDiagramText`, `diagramToText`) and the
//! extraction of the diagram from a picture (`extractDiagramXml`) wait for the
//! drawio engine: [`DiagramPictures`] is what the caller implements.

use super::attachable::ATTACHABLE_MAX_BYTES;
use jscompat::node_path::host::basename;

/// `detectDiagramFormat(fileName)`: the format by file-name ending
/// (case-insensitive); `None` when it is not a diagram name. `vsdx` is a
/// name this answers and the callers refuse.
pub fn detect_diagram_format(file_name: &str) -> Option<&'static str> {
    let name = file_name.to_lowercase();
    if name.ends_with(".drawio.svg") {
        Some("drawio.svg")
    } else if name.ends_with(".drawio.png") {
        Some("drawio.png")
    } else if name.ends_with(".drawio") {
        Some("drawio")
    } else if name.ends_with(".dio") {
        Some("dio")
    } else if name.ends_with(".vsdx") {
        Some("vsdx")
    } else {
        None
    }
}

/// `diagramFormatOf(filePath)`: the diagram format of a file name; `None`
/// for any other name, `.vsdx` included (not read here).
pub fn diagram_format_of(file_path: &str) -> Option<&'static str> {
    detect_diagram_format(&basename(file_path, None)).filter(|format| *format != "vsdx")
}

/// `diagramPictureExtOfName(fileName)`: `drawio.svg`/`drawio.png` when the
/// file name ends so (any case), else `None`. Only the name: whether the
/// picture holds its diagram is for [`diagram_picture_ext_of`], which reads
/// the file.
pub fn diagram_picture_ext_of_name(file_name: &str) -> Option<&'static str> {
    match detect_diagram_format(file_name) {
        Some(format @ ("drawio.svg" | "drawio.png")) => Some(format),
        _ => None,
    }
}

/// The two reads of `diagramPictureExtOf` that touch the disk and the drawio
/// engine.
pub trait DiagramPictures {
    /// `statSync(filePath).size`; `Err` where it throws
    fn file_size(&mut self, file_path: &str) -> Result<f64, String>;
    /// `extractDiagramXml(basename, readFileSync(filePath), codec)` answers
    /// `{ ok: false, reason: 'no_original' }`; `Err` where the read throws
    fn lacks_original(&mut self, file_path: &str) -> Result<bool, String>;
}

/// `diagramPictureExtOf(filePath)`: the attachment extension of a draw.io
/// picture: `drawio.svg`/`drawio.png` when the file is named so and holds its
/// diagram, so editors read it as diagram text, not as a picture. `None` for
/// every other file, and for a picture that only carries the name (it stays a
/// picture). A file that cannot be read, or is past the attachment cap, keeps
/// its diagram name; the text reader then reports why it fails.
pub fn diagram_picture_ext_of(
    reader: &mut dyn DiagramPictures,
    file_path: &str,
) -> Option<&'static str> {
    let ext = diagram_picture_ext_of_name(&basename(file_path, None))?;
    let size = match reader.file_size(file_path) {
        Ok(size) => size,
        Err(_) => return Some(ext),
    };
    if size > ATTACHABLE_MAX_BYTES {
        return Some(ext);
    }
    match reader.lacks_original(file_path) {
        Ok(true) => None,
        Ok(false) | Err(_) => Some(ext),
    }
}
