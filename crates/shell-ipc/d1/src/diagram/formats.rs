//! `apps/diagram/src/shared/formats.ts` and `links.ts`: what a save writes,
//! decided without draw.io, and which links a click may open.

use jscompat::{js_regex, slice_utf16, trim};
use main_core::packages::electron_utils::safe_external_url::{
    SafeExternalUrlOptions, safe_external_url,
};

/// `DiagramFormat` of `@seuoffice/drawio-model`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagramFormat {
    Drawio,
    Dio,
    DrawioSvg,
    DrawioPng,
}

impl DiagramFormat {
    /// the TypeScript's string value (`'drawio.svg'`)
    pub fn as_str(self) -> &'static str {
        match self {
            DiagramFormat::Drawio => "drawio",
            DiagramFormat::Dio => "dio",
            DiagramFormat::DrawioSvg => "drawio.svg",
            DiagramFormat::DrawioPng => "drawio.png",
        }
    }

    /// `FORMAT_EXTENSIONS`: the file-name ending
    pub fn extension(self) -> &'static str {
        match self {
            DiagramFormat::Drawio => ".drawio",
            DiagramFormat::Dio => ".dio",
            DiagramFormat::DrawioSvg => ".drawio.svg",
            DiagramFormat::DrawioPng => ".drawio.png",
        }
    }
}

/// `SAVE_AS_FORMATS`
pub const SAVE_AS_FORMATS: [DiagramFormat; 4] = [
    DiagramFormat::Drawio,
    DiagramFormat::Dio,
    DiagramFormat::DrawioSvg,
    DiagramFormat::DrawioPng,
];

/// What `detectDiagramFormat` finds: a diagram format, or a Visio drawing
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Detected {
    Format(DiagramFormat),
    Vsdx,
}

/// `detectDiagramFormat(fileName)`: by file-name ending, case-insensitive
pub fn detect_format(file_name: &str) -> Option<Detected> {
    let name = file_name.to_lowercase();
    if name.ends_with(".drawio.svg") {
        Some(Detected::Format(DiagramFormat::DrawioSvg))
    } else if name.ends_with(".drawio.png") {
        Some(Detected::Format(DiagramFormat::DrawioPng))
    } else if name.ends_with(".drawio") {
        Some(Detected::Format(DiagramFormat::Drawio))
    } else if name.ends_with(".dio") {
        Some(Detected::Format(DiagramFormat::Dio))
    } else if name.ends_with(".vsdx") {
        Some(Detected::Vsdx)
    } else {
        None
    }
}

/// `formatOfPath` of diagram-main: a granted path always has a diagram name
pub fn format_of_path(path: &str) -> DiagramFormat {
    match detect_format(path) {
        Some(Detected::Format(format)) => format,
        _ => DiagramFormat::Drawio,
    }
}

/// `filterExtension(format)`: the dialog filter extension, without the dot
pub fn filter_extension(format: DiagramFormat) -> &'static str {
    &format.extension()[1..]
}

/// `formatForSavePath(path, picked)`: the name decides, else the picked
/// filter, else `.drawio`
pub fn format_for_save_path(path: &str, picked: DiagramFormat) -> DiagramFormat {
    match detect_format(path) {
        Some(Detected::Format(format)) => format,
        _ => picked,
    }
}

/// `withFormatExtension(path, format)`
pub fn with_format_extension(path: &str, format: DiagramFormat) -> String {
    let ending = format.extension();
    let lower = path.to_lowercase();
    if lower.ends_with(ending) {
        return path.to_owned();
    }
    let swap = |suffix: &str| lower.ends_with(suffix) && path.len() >= suffix.len();
    if format == DiagramFormat::DrawioSvg && swap(".svg") {
        return format!("{}{ending}", &path[..path.len() - 4]);
    }
    if format == DiagramFormat::DrawioPng && swap(".png") {
        return format!("{}{ending}", &path[..path.len() - 4]);
    }
    format!("{path}{ending}")
}

/// `isCompressedFile(file)`: the file stores its pages compressed
pub fn is_compressed_file(root: &str, any_page_compressed: bool, xml: &str) -> bool {
    if root != "mxfile" {
        return false;
    }
    if any_page_compressed {
        return true;
    }
    let head = js_regex!(r"<mxfile\b[^>]*>")
        .exec(xml)
        .map_or("", |m| m.as_str());
    js_regex!(r#"\scompressed\s*=\s*["']true["']"#).test(head)
}

/// `diagramBaseName(path)`: the file name without folders and diagram ending
pub fn diagram_base_name(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or("");
    match detect_format(name) {
        Some(found) => {
            let ending = match found {
                Detected::Vsdx => ".vsdx",
                Detected::Format(format) => format.extension(),
            };
            name[..name.len() - ending.len()].to_owned()
        }
        None => match name.rfind('.') {
            Some(dot) if dot > 0 => name[..dot].to_owned(),
            _ => name.to_owned(),
        },
    }
}

/// `safeFileNameBase(name)`: a file name base made safe for every file system
pub fn safe_file_name_base(name: Option<&str>) -> String {
    let replaced =
        js_regex!(r#"[/\\:*?"<>|]"#, "g").replace_all(name.unwrap_or(""), |_| "_".to_owned());
    trim(&slice_utf16(&replaced, 0.0, Some(80.0))).to_owned()
}

/// `LINK_PROTOCOLS`
const LINK_PROTOCOLS: [&str; 3] = ["http:", "https:", "mailto:"];

/// `openableLink(url)`: the address to open, or none when it is never opened
pub fn openable_link(url: Option<&str>) -> Option<String> {
    safe_external_url(
        url,
        Some(&SafeExternalUrlOptions {
            allowed_protocols: Some(LINK_PROTOCOLS.iter().map(|p| (*p).to_owned()).collect()),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_get_their_format_ending() {
        assert_eq!(
            with_format_extension("/a/b.svg", DiagramFormat::DrawioSvg),
            "/a/b.drawio.svg"
        );
        assert_eq!(
            with_format_extension("/a/b", DiagramFormat::Dio),
            "/a/b.dio"
        );
        assert_eq!(
            with_format_extension("/a/B.DRAWIO", DiagramFormat::Drawio),
            "/a/B.DRAWIO"
        );
        assert_eq!(diagram_base_name("C:\\x\\plan.drawio.png"), "plan");
        assert_eq!(diagram_base_name("/x/plan.v2.txt"), "plan.v2");
        assert_eq!(safe_file_name_base(Some("a/b:c")), "a_b_c");
    }

    #[test]
    fn compressed_files_keep_compressing() {
        assert!(is_compressed_file(
            "mxfile",
            false,
            "<mxfile compressed=\"true\">"
        ));
        assert!(!is_compressed_file(
            "mxfile",
            false,
            "<mxfile compressed=\"false\">"
        ));
        assert!(!is_compressed_file("mxGraphModel", true, ""));
    }

    #[test]
    fn only_web_and_mail_links_open() {
        assert!(openable_link(Some("https://a.example/x")).is_some());
        assert!(openable_link(Some("mailto:a@b.c")).is_some());
        assert!(openable_link(Some("file:///etc/passwd")).is_none());
        assert!(openable_link(None).is_none());
    }
}
