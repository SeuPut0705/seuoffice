//! `apps/shell/src/main/app-routing.ts`.

use jscompat::JsRegex;
use jscompat::js_regex;
use jscompat::node_path::host::extname;
use serde::Serialize;

/// `DocumentTabKind` of `apps/shell/src/shared/tabs-api.ts`, written as its string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentTabKind {
    Docs,
    Sheets,
    Slides,
    Pdf,
    Markdown,
    Html,
    Mindmap,
    Hwp,
    Epub,
    Diagram,
}

impl DocumentTabKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentTabKind::Docs => "docs",
            DocumentTabKind::Sheets => "sheets",
            DocumentTabKind::Slides => "slides",
            DocumentTabKind::Pdf => "pdf",
            DocumentTabKind::Markdown => "markdown",
            DocumentTabKind::Html => "html",
            DocumentTabKind::Mindmap => "mindmap",
            DocumentTabKind::Hwp => "hwp",
            DocumentTabKind::Epub => "epub",
            DocumentTabKind::Diagram => "diagram",
        }
    }
}

// shared by the open route, the open-dialog filter and the rename gate so they cannot drift
pub fn docx_re() -> &'static JsRegex {
    js_regex!(r"\.docx$", "i")
}
// OpenDocument text opens in the Word tab too
pub fn odt_re() -> &'static JsRegex {
    js_regex!(r"\.odt$", "i")
}
// legacy Word 97-2003 .doc/.dot open in the Word tab as a converted .docx copy
pub fn word97_re() -> &'static JsRegex {
    js_regex!(r"\.(doc|dot)$", "i")
}
// .ods opens as a converted .xlsx copy in the spreadsheet tab (decision 0119)
pub fn ods_re() -> &'static JsRegex {
    js_regex!(r"\.ods$", "i")
}
pub fn xlsx_re() -> &'static JsRegex {
    js_regex!(r"\.(xlsx|xlsm|xls|csv|tsv|ods)$", "i")
}
// .odp and its .otp template open in Slides through the import filter
fn odp_re() -> &'static JsRegex {
    js_regex!(r"\.(odp|otp)$", "i")
}
// a legacy PowerPoint 97-2003 .ppt opens in Slides as a converted .pptx copy too
fn ppt_re() -> &'static JsRegex {
    js_regex!(r"\.ppt$", "i")
}
pub fn pptx_re() -> &'static JsRegex {
    js_regex!(r"\.(pptx|ppt|odp|otp)$", "i")
}
pub fn pdf_re() -> &'static JsRegex {
    js_regex!(r"\.pdf$", "i")
}
pub fn html_re() -> &'static JsRegex {
    js_regex!(r"\.html?$", "i")
}
// XMind maps, and a FreeMind / Freeplane map imported as a new map
pub fn mindmap_re() -> &'static JsRegex {
    js_regex!(r"\.(xmind|mm)$", "i")
}
pub fn hwp_re() -> &'static JsRegex {
    js_regex!(r"\.hwpx?$", "i")
}
pub fn epub_re() -> &'static JsRegex {
    js_regex!(r"\.epub$", "i")
}
// draw.io diagrams, and a Visio drawing imported as a new diagram
pub fn diagram_re() -> &'static JsRegex {
    js_regex!(r"\.(drawio|dio|vsdx|drawio\.svg|drawio\.png)$", "i")
}
fn diagram_picture_re() -> &'static JsRegex {
    js_regex!(r"\.drawio\.(svg|png)$", "i")
}

pub fn text_re() -> &'static JsRegex {
    js_regex!(r"\.(md|markdown|txt|json)$", "i")
}

/// A file's extension as the app names its format, lower-case without the dot:
/// `drawio.svg` / `drawio.png` for a draw.io picture, else the last extension
/// (`docx`, as `extname` reads it), or '' for a name without one.
pub fn document_extension(name: &str) -> String {
    if let Some(picture) = diagram_picture_re().exec(name) {
        let kind = picture.get(1).unwrap_or("");
        return format!("drawio.{}", kind.to_lowercase());
    }
    // `.slice(1)`: the extension is '' or starts with the dot
    extname(name)
        .chars()
        .skip(1)
        .collect::<String>()
        .to_lowercase()
}

pub fn app_for_path(path: &str) -> Option<DocumentTabKind> {
    if docx_re().test(path) || odt_re().test(path) || word97_re().test(path) {
        return Some(DocumentTabKind::Docs);
    }
    if xlsx_re().test(path) {
        return Some(DocumentTabKind::Sheets);
    }
    if pptx_re().test(path) {
        return Some(DocumentTabKind::Slides);
    }
    if pdf_re().test(path) {
        return Some(DocumentTabKind::Pdf);
    }
    if text_re().test(path) {
        return Some(DocumentTabKind::Markdown);
    }
    if html_re().test(path) {
        return Some(DocumentTabKind::Html);
    }
    if mindmap_re().test(path) {
        return Some(DocumentTabKind::Mindmap);
    }
    if hwp_re().test(path) {
        return Some(DocumentTabKind::Hwp);
    }
    if epub_re().test(path) {
        return Some(DocumentTabKind::Epub);
    }
    if diagram_re().test(path) {
        return Some(DocumentTabKind::Diagram);
    }
    None
}

/// A legal name in an extension no app routes to would turn an openable file into an unopenable one.
pub fn rename_stays_in_app(from: &str, new_name: &str) -> bool {
    let Some(current) = app_for_path(from) else {
        return true;
    };
    // .docx and .odt share the Word tab but not the bytes
    if current == DocumentTabKind::Docs && odt_re().test(from) != odt_re().test(new_name) {
        return false;
    }
    // a Word 97-2003 binary is no .docx/.odt either, only imported as a copy
    if current == DocumentTabKind::Docs && word97_re().test(from) != word97_re().test(new_name) {
        return false;
    }
    // .ods is its own container, so renaming it into or out of any other sheet form breaks the file
    if current == DocumentTabKind::Sheets && ods_re().test(from) != ods_re().test(new_name) {
        return false;
    }
    // likewise an .odp/.otp is an ODF package that Slides only imports as a .pptx copy
    if current == DocumentTabKind::Slides && odp_re().test(from) != odp_re().test(new_name) {
        return false;
    }
    // and a PowerPoint 97-2003 binary is neither a .pptx nor an ODF package
    if current == DocumentTabKind::Slides && ppt_re().test(from) != ppt_re().test(new_name) {
        return false;
    }
    // each diagram form keeps its own bytes, and so does each map form
    if (current == DocumentTabKind::Diagram || current == DocumentTabKind::Mindmap)
        && document_extension(from) != document_extension(new_name)
    {
        return false;
    }
    app_for_path(new_name) == Some(current)
}
