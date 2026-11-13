//! `apps/shell/src/main/mcp/tools/open-documents-tools.ts`: MCP access to the
//! documents the *user* has open: the tab manager's list of editor tabs, not
//! the single blank session `create_session` owns. The actions share one tool
//! because they are steps of one workflow: discover, read or commit the file,
//! then act on what was discovered.
//!
//! The control object is injected ([`OpenDocumentsControl`]) so this module
//! never imports Electron: the shell implements it over the tab manager and
//! the per-family bridges, tests pass a script.
//!
//! The registry's vocabulary names a tab kind by [`family_by_kind`]. The
//! TypeScript's table has no row for the `home` and `help` kinds, so a lookup
//! there answers `undefined` and the first use throws `unknown format family
//! "undefined"` from the registry; [`family_by_kind`] answers `None` and each
//! use fails with that message in the same place.
//!
//! Public for the other tool modules: [`resolve_open_document`],
//! [`resolve_open_document_of_family`] (the shared lookup behind the content
//! tools' optional `document` argument), [`document_format`],
//! [`close_save_path`].

use std::rc::Rc;

use jscompat::node_path::host::resolve;
use jscompat::{JsonValue, js_regex, trim};

use super::document_tools::{DefaultSaveDir, sanitize_file_base, unique_path_in};
use super::formats::{EditorFamily, family_label, format_family};
use super::session_tools::{ObjectDraft, js_object, string_or_empty};
use crate::packages::i18n::PRODUCT_NAME;
use crate::packages::zod::z;
use crate::shell::mcp::mcp_server::McpToolDefinition;
use crate::shell::tab_manager::{OpenDocumentTab, TabKind};

/// what the registry throws for a family it does not know: what a lookup of
/// `FAMILY_BY_KIND` that found no row leads to
const UNKNOWN_FAMILY: &str = "unknown format family \"undefined\"";

/// `FAMILY_BY_KIND`: tab kind to format family. `home` and `help` have none.
pub fn family_by_kind(kind: TabKind) -> Option<EditorFamily> {
    Some(match kind {
        TabKind::Docs => EditorFamily::Docx,
        TabKind::Sheets => EditorFamily::Xlsx,
        TabKind::Slides => EditorFamily::Pptx,
        TabKind::Markdown => EditorFamily::Md,
        TabKind::Html => EditorFamily::Html,
        TabKind::Pdf => EditorFamily::Pdf,
        TabKind::Mindmap => EditorFamily::Xmind,
        TabKind::Hwp => EditorFamily::Hwp,
        TabKind::Epub => EditorFamily::Epub,
        TabKind::Diagram => EditorFamily::Drawio,
        TabKind::Home | TabKind::Help => return None,
    })
}

/// `READABLE_KINDS`: families whose live content can be read back over MCP
fn is_readable_kind(kind: TabKind) -> bool {
    matches!(
        kind,
        TabKind::Docs
            | TabKind::Sheets
            | TabKind::Slides
            | TabKind::Markdown
            | TabKind::Html
            | TabKind::Mindmap
            | TabKind::Hwp
            | TabKind::Epub
            | TabKind::Diagram
    )
}

/// `unsaved` of `OpenDocumentsControl.close`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsaved {
    Save,
    Discard,
}

impl Unsaved {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            Unsaved::Save => "save",
            Unsaved::Discard => "discard",
        }
    }
}

/// what `OpenDocumentsControl.close` answers: `{ savedPath? }`
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloseOutcome {
    pub saved_path: Option<String>,
}

/// what `OpenDocumentsControl.save` answers: `{ savedPath }`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveOutcome {
    pub saved_path: String,
}

/// `OpenDocumentsControl`. `Err` is the message of what a method throws.
pub trait OpenDocumentsControl {
    /// every editor tab the user can see (Home and chrome-free Present tabs excluded)
    fn list(&self) -> Result<Vec<OpenDocumentTab>, String>;
    /// live content of one open document, unsaved edits included
    fn read(&self, tab: &OpenDocumentTab) -> Result<Option<JsonValue>, String>;
    /// Settle the document's unsaved changes and close its tab. `Unsaved::Save`
    /// writes first (to the document's own path, or into the default save
    /// folder when it has never been saved); `Discard` drops the edits.
    fn close(&self, tab: &OpenDocumentTab, unsaved: Unsaved) -> Result<CloseOutcome, String>;
    /// Write the document's live content back to its own file, or into the
    /// default save folder when it has never been saved. Unlike `close`, the
    /// tab stays open, so the user can keep editing after the agent commits the
    /// file to disk.
    fn save(&self, tab: &OpenDocumentTab) -> Result<SaveOutcome, String>;
}

/// `OpenDocumentsDeps`
pub struct OpenDocumentsDeps<'h> {
    pub control: Option<Rc<dyn OpenDocumentsControl + 'h>>,
    /// folder an untitled dirty document is saved into before closing
    pub default_save_dir: DefaultSaveDir<'h>,
}

/// `extensionFor(family)`: the extension a family's document carries on disk
/// (`.docx`, `.md`, `.html`, ...).
///
/// Read from the registry's `editorSave` rather than `generateExtension`: the
/// latter only answers for the three families that have a headless `create_*`
/// tool, so asking it about html/md/pdf throws. A close-save needs the
/// family's own save format, which every family has.
fn extension_for(family: Option<EditorFamily>) -> Result<String, String> {
    let family = family.ok_or_else(|| UNKNOWN_FAMILY.to_owned())?;
    match format_family(family).editor_save.first() {
        Some(primary) => Ok(format!(".{primary}")),
        None => Err(format!("family \"{}\" has no save format", family.as_str())),
    }
}

/// `realpathSync.native(path)`, `None` where it throws
fn real_path_native(path: &str) -> Option<String> {
    let real = std::fs::canonicalize(path)
        .ok()?
        .to_string_lossy()
        .into_owned();
    // std adds the verbatim prefix on Windows; realpath does not
    Some(match real.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => rest.to_owned(),
        _ => real,
    })
}

/// `normalizePath(value)`
fn normalize_path(value: &str) -> String {
    let mut resolved = resolve(&[value]);
    // unsaved or moved file: compare the resolved path as-is
    if let Some(real) = real_path_native(&resolved) {
        resolved = real;
    }
    if cfg!(windows) {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// `resolveOpenDocument(documents, target)`: match a caller's target against
/// the open documents: an exact tab id wins, then a path (compared after
/// resolving; case-insensitively on Windows).
pub fn resolve_open_document<'a>(
    documents: &'a [OpenDocumentTab],
    target: &str,
) -> Option<&'a OpenDocumentTab> {
    if let Some(by_id) = documents.iter().find(|doc| doc.id == target) {
        return Some(by_id);
    }
    let wanted = normalize_path(target);
    documents.iter().find(|doc| {
        doc.file_path
            .as_deref()
            .is_some_and(|path| normalize_path(path) == wanted)
    })
}

/// `resolveOpenDocumentOfFamily(documents, target, family)`: resolve an open
/// document addressed by tab id or path, requiring it to belong to `family`.
/// This is the shared lookup behind the content tools' optional `document`
/// argument, so "point this edit at a tab the user opened" behaves exactly like
/// `open_documents`: same matching rules, same guided errors.
pub fn resolve_open_document_of_family<'a>(
    documents: &'a [OpenDocumentTab],
    target: &str,
    family: EditorFamily,
) -> Result<&'a OpenDocumentTab, String> {
    let Some(doc) = resolve_open_document(documents, target) else {
        return Err(no_match(target, documents));
    };
    let actual = family_by_kind(doc.kind);
    if actual != Some(family) {
        let actual = actual.ok_or_else(|| UNKNOWN_FAMILY.to_owned())?;
        return Err(format!(
            "\"{}\" is a {}, but this tool edits {} documents",
            doc.title,
            family_label(actual),
            family_label(family)
        ));
    }
    Ok(doc)
}

/// `noMatch(target, documents)`: a guided "no such document" error listing
/// what is actually open. Answers the message of the error thrown, which is
/// the registry's where a tab's kind has no family.
fn no_match(target: &str, documents: &[OpenDocumentTab]) -> String {
    if documents.is_empty() {
        return format!(
            "no document is open in {PRODUCT_NAME}, so \"{target}\" cannot be resolved"
        );
    }
    let rows: Result<Vec<String>, String> = documents
        .iter()
        .map(|doc| {
            type_label(doc).map(|label| {
                format!(
                    "  {}  {}  — {label}",
                    doc.id,
                    doc.file_path.as_deref().unwrap_or("(never saved)")
                )
            })
        })
        .collect();
    match rows {
        Ok(rows) => format!(
            "no open document matches \"{target}\". Currently open:\n{}",
            rows.join("\n")
        ),
        Err(message) => message,
    }
}

/// `typeLabel(doc)`
fn type_label(doc: &OpenDocumentTab) -> Result<&'static str, String> {
    family_by_kind(doc.kind)
        .map(family_label)
        .ok_or_else(|| UNKNOWN_FAMILY.to_owned())
}

/// `documentFormat(doc)`: the file format a document is kept in: its file's
/// extension, or the family's own save format for a never-saved tab. A Word tab
/// can hold .docx or .odt, and an agent needs to know which before it picks a
/// save path or a conversion.
pub fn document_format(doc: &OpenDocumentTab) -> Result<String, String> {
    let family = family_by_kind(doc.kind);
    let name = doc.file_path.as_deref().map(str::to_lowercase);
    // a double extension the family opens (`.drawio.svg`) is the format, not its last part
    let compound = match name.as_deref() {
        Some(name) if !name.is_empty() => {
            let family = family.ok_or_else(|| UNKNOWN_FAMILY.to_owned())?;
            format_family(family)
                .editor_open
                .iter()
                .copied()
                .find(|ext| ext.contains('.') && name.ends_with(&format!(".{ext}")))
        }
        _ => None,
    };
    if let Some(compound) = compound {
        return Ok(compound.to_owned());
    }
    let ext = name
        .as_deref()
        .and_then(|name| js_regex!(r"\.([a-z0-9]+)$").exec(name))
        .and_then(|found| found.get(1));
    match ext {
        Some(ext) => Ok(ext.to_owned()),
        None => Ok(extension_for(family)?[1..].to_owned()),
    }
}

/// `describeDocument(doc)`: one row of the `list` action
fn describe_document(doc: &OpenDocumentTab) -> Result<JsonValue, String> {
    let label = type_label(doc)?;
    let format = document_format(doc)?;
    Ok(js_object(vec![
        ("id", JsonValue::String(doc.id.clone())),
        ("type", JsonValue::String(label.to_owned())),
        ("kind", JsonValue::String(doc.kind.as_str().to_owned())),
        ("format", JsonValue::String(format)),
        ("title", JsonValue::String(doc.title.clone())),
        ("path", path_of(doc)),
        ("saved", JsonValue::Bool(doc.file_path.is_some())),
        ("dirty", JsonValue::Bool(doc.dirty)),
        ("active", JsonValue::Bool(doc.active)),
    ]))
}

/// `doc.filePath ?? null`
fn path_of(doc: &OpenDocumentTab) -> JsonValue {
    match &doc.file_path {
        Some(path) => JsonValue::String(path.clone()),
        None => JsonValue::Null,
    }
}

/// `closeSavePath(doc, defaultSaveDir)`: where a dialog-free save should land:
/// the document's own file when it has one, else a unique name derived from its
/// title inside the default folder.
pub fn close_save_path(
    doc: &OpenDocumentTab,
    default_save_dir: &dyn Fn() -> String,
) -> Result<String, String> {
    if let Some(path) = &doc.file_path
        && !path.is_empty()
    {
        return Ok(path.clone());
    }
    let name = format!(
        "{}{}",
        sanitize_file_base(&doc.title),
        extension_for(family_by_kind(doc.kind))?
    );
    Ok(unique_path_in(&default_save_dir(), &name))
}

/// `createOpenDocumentTools(deps)`: the `open_documents` tool
pub fn create_open_document_tools<'h>(deps: OpenDocumentsDeps<'h>) -> Vec<McpToolDefinition<'h>> {
    let control = deps.control;

    vec![McpToolDefinition {
        name: "open_documents".to_owned(),
        description: concat!(
            "Work with the documents the user currently has open in SeuOffice tabs — not just the ",
            "one a session opened. Actions: \"list\" (no target) returns every open document with its ",
            "id, type, path, title, whether it has ever been saved, and whether it has unsaved ",
            "changes; \"read\" returns one document's live content including unsaved edits; \"save\" ",
            "writes that live content back to the document's own file (or a fresh file in the ",
            "default save folder when it has never been saved) and leaves the tab open; \"close\" ",
            "closes one, saving it first by default (pass unsaved:\"discard\" to drop the changes). ",
            "Both \"save\" and \"close\" write over the document's own file when it has a path — they ",
            "do not stop to ask, so the saved file replaces whatever was on disk. ",
            "Identify a document by its path, or by the id from \"list\" when it has never been saved. ",
            "To *edit* one of these documents, pass its id (or path) as the `document` argument of the ",
            "family content tools (insert_content / apply_ops / apply_sheet_ops / apply_slide_ops): no ",
            "session is needed, and the UI switches to that tab so the user sees the change land. ",
            "A mind map (kind \"mindmap\") reads as its outline text; there is no tool that edits one. ",
            "PDF tabs are listed and can be closed, but this tool does not read or save them: the ",
            "pdf app is a viewer, so an open PDF has no live editable content. Read a PDF with ",
            "read_pdf; it cannot be written back. Closing one just ",
            "drops the tab — a PDF with unsaved annotations (its only unsaved state) must be closed ",
            "with unsaved:\"discard\". HWP tabs can be read ",
            "(paragraphs as lines, tables as \" | \" rows) but not edited or saved here: \"close\" on ",
            "an HWP tab with unsaved changes fails unless unsaved:\"discard\" is passed. ",
            "A book (kind \"epub\") reads as its text in reading order, headings as \"#\" lines; ",
            "there is no tool that edits one. ",
            "A diagram (kind \"diagram\") reads as the shape and edge table of every page, unsaved ",
            "edits included; read_diagram and apply_diagram_ops, where offered, read one page and ",
            "change it."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            (
                "action",
                z::enum_(&["list", "read", "save", "close"]).describe("what to do"),
            ),
            (
                "target",
                z::string()
                    .optional()
                    .describe("path or tab id of the document; required for \"read\" and \"close\""),
            ),
            (
                "unsaved",
                z::enum_(&["save", "discard"])
                    .optional()
                    .describe("\"close\" only: save before closing (default), or discard the changes"),
            ),
        ])),
        handler: Box::new(move |args: JsonValue| {
            let Some(control) = &control else {
                return Err(format!(
                    "{PRODUCT_NAME} is not running, so its open documents are unreachable"
                ));
            };
            let action = string_or_empty(&args, "action")?;
            if action == "list" {
                let documents = control.list()?;
                let rows = documents
                    .iter()
                    .map(describe_document)
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(Some(js_object(vec![("documents", JsonValue::Array(rows))])));
            }

            let target = match args.get("target").as_deref() {
                Some(JsonValue::String(target)) => trim(target).to_owned(),
                _ => String::new(),
            };
            if target.is_empty() {
                return Err(format!(
                    "\"{action}\" needs a target (a path, or an id from \"list\")"
                ));
            }

            let documents = control.list()?;
            let Some(doc) = resolve_open_document(&documents, &target) else {
                return Err(no_match(&target, &documents));
            };

            if action == "read" {
                if !is_readable_kind(doc.kind) {
                    return Err(format!(
                        "\"{}\" is a PDF: the pdf app is a viewer, so this tool cannot read it — read_pdf returns its text",
                        doc.title
                    ));
                }
                let label = type_label(doc)?;
                let content = control.read(doc)?;
                let mut out = ObjectDraft::new();
                out.set("id", Some(JsonValue::String(doc.id.clone())));
                out.set("type", Some(JsonValue::String(label.to_owned())));
                out.set("kind", Some(JsonValue::String(doc.kind.as_str().to_owned())));
                out.set("title", Some(JsonValue::String(doc.title.clone())));
                out.set("path", Some(path_of(doc)));
                out.set("dirty", Some(JsonValue::Bool(doc.dirty)));
                out.set("content", content);
                return Ok(Some(out.finish()));
            }

            if action == "save" {
                if doc.kind == TabKind::Pdf {
                    return Err(format!(
                        "\"{}\" is a PDF: the pdf app is a viewer, so an open PDF has nothing to save through this tool",
                        doc.title
                    ));
                }
                let saved = control.save(doc)?;
                return Ok(Some(js_object(vec![
                    ("saved", JsonValue::Bool(true)),
                    ("id", JsonValue::String(doc.id.clone())),
                    ("type", JsonValue::String(type_label(doc)?.to_owned())),
                    ("title", JsonValue::String(doc.title.clone())),
                    ("path", path_of(doc)),
                    ("savedTo", JsonValue::String(saved.saved_path)),
                ])));
            }

            if action == "close" {
                let unsaved = if matches!(args.get("unsaved").as_deref(), Some(JsonValue::String(u)) if u == "discard")
                {
                    Unsaved::Discard
                } else {
                    Unsaved::Save
                };
                let closed = control.close(doc, unsaved)?;
                let mut out = ObjectDraft::new();
                out.set("closed", Some(JsonValue::Bool(true)));
                out.set("id", Some(JsonValue::String(doc.id.clone())));
                out.set("type", Some(JsonValue::String(type_label(doc)?.to_owned())));
                out.set("title", Some(JsonValue::String(doc.title.clone())));
                out.set("path", Some(path_of(doc)));
                if let Some(saved_path) = closed.saved_path.filter(|path| !path.is_empty()) {
                    out.set("savedTo", Some(JsonValue::String(saved_path)));
                }
                if unsaved == Unsaved::Discard && doc.dirty {
                    out.set("discardedUnsavedChanges", Some(JsonValue::Bool(true)));
                }
                return Ok(Some(out.finish()));
            }

            Err(format!(
                "unknown action \"{action}\" — use \"list\", \"read\", \"save\" or \"close\""
            ))
        }),
    }]
}
