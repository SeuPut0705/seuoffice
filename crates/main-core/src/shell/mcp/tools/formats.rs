//! `apps/shell/src/main/mcp/tools/formats.ts`: the format capability registry,
//! the MCP layer's single source of truth for which document formats each
//! editor can open, save and export. `editor` mirrors the shell's routing and
//! each editor's Save As dialog; `mcp` is the subset the server exposes today.
//!
//! The TypeScript keys the registry by a string union and looks a family up
//! in a `Map`, throwing `unknown format family` for a string it does not
//! hold. Here a family is an enum whose variants are declared in the order of
//! the table, so [`format_family`] indexes the table and cannot miss: the
//! throw has no input left to fire on. [`EditorFamily`] is the TypeScript's
//! `EditorFamily`, [`SessionFamily`] its `SessionFamily`.

use jscompat::{JsObject, JsonValue, js_regex};

/// `SessionFamily`: the families with a visible editing session today
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionFamily {
    Docx,
    Pptx,
    Xlsx,
}

impl SessionFamily {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            SessionFamily::Docx => "docx",
            SessionFamily::Pptx => "pptx",
            SessionFamily::Xlsx => "xlsx",
        }
    }

    /// the family of a string, `None` for anything else
    pub fn parse(text: &str) -> Option<SessionFamily> {
        match text {
            "docx" => Some(SessionFamily::Docx),
            "pptx" => Some(SessionFamily::Pptx),
            "xlsx" => Some(SessionFamily::Xlsx),
            _ => None,
        }
    }

    /// the same family as the registry knows it
    pub fn editor(self) -> EditorFamily {
        match self {
            SessionFamily::Docx => EditorFamily::Docx,
            SessionFamily::Pptx => EditorFamily::Pptx,
            SessionFamily::Xlsx => EditorFamily::Xlsx,
        }
    }
}

/// `EditorFamily`: every family the app can edit, including ones MCP does not
/// drive yet. The variants run in the order of [`FORMAT_FAMILIES`], which
/// [`format_family`] relies on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorFamily {
    Docx,
    Xlsx,
    Pptx,
    Md,
    Html,
    Pdf,
    Xmind,
    Hwp,
    Epub,
    Drawio,
}

impl EditorFamily {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            EditorFamily::Docx => "docx",
            EditorFamily::Xlsx => "xlsx",
            EditorFamily::Pptx => "pptx",
            EditorFamily::Md => "md",
            EditorFamily::Html => "html",
            EditorFamily::Pdf => "pdf",
            EditorFamily::Xmind => "xmind",
            EditorFamily::Hwp => "hwp",
            EditorFamily::Epub => "epub",
            EditorFamily::Drawio => "drawio",
        }
    }
}

/// `McpFormats`: what MCP exposes of a family
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpFormats {
    /// format the headless `create_*` tool writes, when exposed
    pub generate: Option<&'static str>,
    /// extensions `save_session` accepts for this family (session families only)
    pub save: Option<&'static [&'static str]>,
    /// format the file reader tool understands, when exposed
    pub read: Option<&'static str>,
}

/// `FormatFamily`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FormatFamily {
    pub family: EditorFamily,
    /// noun used in tool copy ("a Word document is open")
    pub label: &'static str,
    /// extensions the shell routes into this family's tab when opened
    pub editor_open: &'static [&'static str],
    /// extensions the editor's Save As offers
    pub editor_save: &'static [&'static str],
    /// aside formats the editor can export (not editable in place)
    pub editor_export: &'static [&'static str],
    /// what MCP exposes; `None` while a family is editor-only
    pub mcp: Option<McpFormats>,
}

/// `FORMAT_FAMILIES`: the editor's format matrix. Order is presentation order:
/// the three edit-in-place families first (they have MCP sessions), then the
/// editor-only ones.
pub static FORMAT_FAMILIES: [FormatFamily; 10] = [
    FormatFamily {
        family: EditorFamily::Docx,
        label: "Word document",
        // .odt opens in the same Word tab and its Save As offers docx and ODT. MCP
        // sessions stay docx (a dialog-free save never changes a tab's format);
        // read_docx also reads .odt. Legacy Word .doc/.dot open as a converted
        // .docx copy, so they are open-only (never in editorSave)
        editor_open: &["docx", "odt", "doc", "dot"],
        editor_save: &["docx", "odt"],
        editor_export: &["pdf"],
        mcp: Some(McpFormats {
            generate: Some("docx"),
            save: Some(&["docx"]),
            read: Some("docx"),
        }),
    },
    FormatFamily {
        family: EditorFamily::Xlsx,
        label: "spreadsheet",
        // .tsv and .ods open as converted copies and save as .xlsx, so they are
        // open-only formats: they must not appear in editorSave
        editor_open: &["xlsx", "xlsm", "xls", "csv", "tsv", "ods"],
        // the interactive Save As also offers .xlsm/.csv; the explicit-path save the
        // MCP bridge uses writes .xlsx only (sheets-main.ts forces the extension),
        // so mcp.save stays xlsx until that pipeline is widened
        editor_save: &["xlsx", "xlsm", "csv"],
        editor_export: &["pdf"],
        mcp: Some(McpFormats {
            generate: Some("xlsx"),
            save: Some(&["xlsx"]),
            read: None,
        }),
    },
    FormatFamily {
        family: EditorFamily::Pptx,
        label: "presentation",
        // .odp/.otp and the legacy .ppt open as converted copies and save as
        // .pptx, so they are open-only formats like .ods: they must not appear in
        // editorSave
        editor_open: &["pptx", "odp", "otp", "ppt"],
        editor_save: &["pptx"],
        editor_export: &["pdf"],
        mcp: Some(McpFormats {
            generate: Some("pptx"),
            save: Some(&["pptx"]),
            read: None,
        }),
    },
    // editor-only today: no MCP session/reader yet. Add an `mcp` block and a
    // driver to expose them (kept here so the upgrade path is visible in code).
    FormatFamily {
        family: EditorFamily::Md,
        label: "Markdown document",
        editor_open: &["md", "markdown"],
        editor_save: &["md", "markdown"],
        editor_export: &["docx", "odt", "pdf"],
        mcp: None,
    },
    FormatFamily {
        family: EditorFamily::Html,
        label: "HTML page",
        editor_open: &["html", "htm"],
        editor_save: &["html", "htm"],
        editor_export: &["docx", "odt", "pdf"],
        mcp: None,
    },
    FormatFamily {
        family: EditorFamily::Pdf,
        label: "PDF document",
        editor_open: &["pdf"],
        editor_save: &["pdf"],
        // the PDF app converts on-device to the three editable formats
        editor_export: &["docx", "xlsx", "pptx"],
        // read-only by design: the pdf app is a viewer, MCP exposes text
        // extraction only and does not drive the editor
        mcp: Some(McpFormats {
            generate: None,
            save: None,
            read: Some("pdf"),
        }),
    },
    FormatFamily {
        family: EditorFamily::Xmind,
        label: "mind map",
        // a FreeMind / Freeplane map opens as a new map, saved as .xmind
        editor_open: &["xmind", "mm"],
        editor_save: &["xmind"],
        // the map menu's three exports: picture of a sheet, PDF, Markdown outline
        editor_export: &["png", "pdf", "md"],
        // no `mcp` block: there is no session, generator or file reader for maps;
        // an open map is listed, read, saved and closed through open_documents only
        mcp: None,
    },
    FormatFamily {
        family: EditorFamily::Hwp,
        label: "HWP document",
        editor_open: &["hwp", "hwpx"],
        // a document is saved back in the format it was opened in
        editor_save: &["hwp", "hwpx"],
        editor_export: &[],
        // read-only: read_hwp extracts the text of a .hwp or .hwpx file; editing is
        // done in the editor, by its own AI panel
        mcp: Some(McpFormats {
            generate: None,
            save: None,
            read: Some("hwp"),
        }),
    },
    FormatFamily {
        family: EditorFamily::Epub,
        label: "e-book",
        editor_open: &["epub"],
        // a book is saved back as itself; its translations are new books, not exports
        editor_save: &["epub"],
        editor_export: &[],
        // no `mcp` block: an open book is listed, read, saved and closed through
        // open_documents only (epub_translate and epub_status are the command line's)
        mcp: None,
    },
    FormatFamily {
        family: EditorFamily::Drawio,
        label: "diagram",
        // a Visio drawing opens as a new, untitled diagram made from it: open-only
        editor_open: &["drawio", "dio", "drawio.svg", "drawio.png", "vsdx"],
        // a diagram is saved back in the format it was opened in; a new one as .drawio
        editor_save: &["drawio", "dio", "drawio.svg", "drawio.png"],
        editor_export: &["png", "svg", "pdf"],
        // no `mcp` block: there is no session, generator or file reader for
        // diagrams; an open diagram is listed, read, saved and closed through
        // open_documents and read and edited through read_diagram / apply_diagram_ops
        mcp: None,
    },
];

/// `formatFamily(family)`: the row of the registry. Every variant has its row
/// at its own position, so there is no `unknown format family` to throw.
pub fn format_family(family: EditorFamily) -> &'static FormatFamily {
    &FORMAT_FAMILIES[family as usize]
}

/// `familyLabel(family)`
pub fn family_label(family: EditorFamily) -> &'static str {
    format_family(family).label
}

/// `generateExtension(family)`: the extension a family's headless `create_*`
/// tool writes. Throws where the family has no MCP generation format.
pub fn generate_extension(family: SessionFamily) -> Result<&'static str, String> {
    match format_family(family.editor())
        .mcp
        .and_then(|mcp| mcp.generate)
    {
        Some(ext) => Ok(ext),
        None => Err(format!(
            "family \"{}\" has no MCP generation format",
            family.as_str()
        )),
    }
}

/// `withSaveExtension(family, filePath)`: normalize a `save_session` path to
/// the family's MCP save format.
///
/// A path with no extension gets the family's primary extension appended (the
/// same convenience the headless `create_*` tools and the sheets/slides
/// bridges already offered). A path with a *different* extension is refused
/// rather than silently rewritten: saving a docx session to `.pdf` would
/// produce a corrupt file, so the agent is told what the family can actually
/// save.
pub fn with_save_extension(family: SessionFamily, file_path: &str) -> Result<String, String> {
    let formats: &[&str] = format_family(family.editor())
        .mcp
        .and_then(|mcp| mcp.save)
        .unwrap_or(&[]);
    let lower = file_path.to_lowercase();
    let ext = js_regex!(r"\.([a-z0-9]+)$")
        .exec(&lower)
        .and_then(|found| found.get(1));
    let Some(ext) = ext else {
        let primary = formats.first().copied().unwrap_or(family.as_str());
        return Ok(format!("{file_path}.{primary}"));
    };
    if formats.contains(&ext) {
        return Ok(file_path.to_owned());
    }
    let wanted = formats
        .iter()
        .map(|e| format!(".{e}"))
        .collect::<Vec<_>>()
        .join(" or ");
    // changing the format needs the user to confirm what gets lost, which a
    // dialog-free save cannot ask: point the agent at the CLI conversion instead
    let hint = if family == SessionFamily::Docx && ext == "odt" {
        "; save as .docx, then convert it with `seuoffice convert <file> --to odt`"
    } else {
        ""
    };
    Err(format!(
        "a {} session must be saved as {wanted} (got \".{ext}\"){hint}",
        family_label(family.editor())
    ))
}

fn string_list(items: &[&str]) -> JsonValue {
    JsonValue::Array(
        items
            .iter()
            .map(|item| JsonValue::String((*item).to_owned()))
            .collect(),
    )
}

/// `capabilityReport(options)`: the compact capability report for
/// `get_app_info`, editor truth plus the MCP subset. The static `mcp` block is
/// what this server *can* expose; the runtime options narrow it to what is
/// actually registered right now, so the report never advertises a tool the
/// client cannot call (`generating: false` hides the headless `create_*`
/// tools, which are opt-in). `generating` is `options.generating`: anything
/// but `Some(false)` generates.
///
/// Answers `[{ family, label, editor: { open, save, export }, mcp? }]`; `mcp`
/// holds `generate`, `save` and `read` in that order, those the family has.
pub fn capability_report(generating: Option<bool>) -> JsonValue {
    let generating = generating != Some(false);
    let mut report = Vec::new();
    for f in &FORMAT_FAMILIES {
        let mut mcp = f.mcp;
        if let Some(formats) = mcp.as_mut()
            && !generating
        {
            formats.generate = None;
        }
        let mut editor = JsObject::new();
        editor.set("open", string_list(f.editor_open));
        editor.set("save", string_list(f.editor_save));
        editor.set("export", string_list(f.editor_export));
        let mut entry = JsObject::new();
        entry.set("family", JsonValue::String(f.family.as_str().to_owned()));
        entry.set("label", JsonValue::String(f.label.to_owned()));
        entry.set("editor", JsonValue::Object(editor));
        if let Some(formats) = mcp {
            let mut out = JsObject::new();
            if let Some(generate) = formats.generate {
                out.set("generate", JsonValue::String(generate.to_owned()));
            }
            if let Some(save) = formats.save {
                out.set("save", string_list(save));
            }
            if let Some(read) = formats.read {
                out.set("read", JsonValue::String(read.to_owned()));
            }
            if !out.is_empty() {
                entry.set("mcp", JsonValue::Object(out));
            }
        }
        report.push(JsonValue::Object(entry));
    }
    JsonValue::Array(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_family_has_its_row_at_its_own_position() {
        for f in &FORMAT_FAMILIES {
            assert_eq!(format_family(f.family).family, f.family);
        }
    }
}
