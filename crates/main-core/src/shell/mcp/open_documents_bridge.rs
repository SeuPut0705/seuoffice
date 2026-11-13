//! `apps/shell/src/main/mcp/open-documents-bridge.ts`: the shell's
//! implementation of the `open_documents` control: the four actions over the
//! tab-manager plus each family's own bridge, so an MCP agent reaches the
//! documents the *user* has open (the bridges are addressed by webContents id,
//! so they do not care who opened the tab).
//!
//! Every method answers a [`ToolStep`]: what the TypeScript awaits of a
//! renderer or another window is a [`ToolStep::Await`] naming the interface
//! and method (the deps of `OpenDocumentsBridgeDeps` are the
//! `"OpenDocumentsBridgeDeps"` calls `list []`, `webContentsFor [tabId]`
//! (answers the webContents id, or nothing), `slidesDiscard [wc]` and
//! `recoveryDiscard [tab, wc]`; the families' own controls are
//! `DocsControl.runCommand`, `SheetsControl.runCommand`,
//! `SlidesControl.readDeck | saveDeck`, and `MarkdownBridge`, `HtmlBridge`,
//! `MindmapBridge`, `EpubBridge`, `DiagramBridge` with `read [wc]`, `save [wc,
//! path]`, `discard [wc]`, and `HwpBridge.read [wc]`). Tabs travel as
//! `{ id, kind, title, filePath?, active, dirty }` ([`tab_json`]). What is
//! sync in the shell stays a method of [`OpenBridgeSync`]: the tab manager's
//! `closeTab`, `isUnloaded`, `defaultSaveDir`, `contents.isDestroyed()`, the
//! UI's `activate` / `revealWindow` and `console.warn`; which optional deps
//! the shell wired is [`OpenBridgeSync::wired`].

use std::rc::Rc;

use jscompat::JsonValue;

use super::tools::diagram_tools::tab_of_json;
use super::tools::formats::EditorFamily;
use super::tools::open_documents_tools::{
    Unsaved, close_save_path, resolve_open_document_of_family, tab_json,
};
use super::tools::session_tools::js_object;
use super::tools::sheets_tools::ask;
use crate::packages::i18n::PRODUCT_NAME;
use crate::shell::mcp::mcp_server::{Settled, ToolStep};
use crate::shell::tab_manager::{OpenDocumentTab, TabKind};

/// the optional deps of `OpenDocumentsBridgeDeps`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dep {
    Docs,
    Sheets,
    Slides,
    SlidesDiscard,
    RecoveryDiscard,
    Markdown,
    Html,
    Mindmap,
    Hwp,
    Epub,
    Diagram,
}

/// What the bridges ask of the shell synchronously.
pub trait OpenBridgeSync {
    /// the dep is wired
    fn wired(&self, dep: Dep) -> bool;
    /// `contents.isDestroyed()` of the webContents with this id
    fn is_destroyed(&self, wc_id: i64) -> bool;
    /// remove one tab with no save prompt; false when it is already gone
    fn close_tab(&self, tab_id: &str) -> bool;
    /// `isUnloaded?.(tabId)`: a restored tab whose editor never loaded: it has
    /// no edits to settle, and a discard close must neither load it nor touch
    /// its recovery copy. `None` is a shell without the dep.
    fn is_unloaded(&self, _tab_id: &str) -> Option<bool> {
        None
    }
    /// folder an untitled dirty document is saved into before closing
    fn default_save_dir(&self) -> String;
    /// `activate?`: make a tab the visible one; a shell without it does nothing
    fn activate(&self, _tab_id: &str) -> Result<(), String> {
        Ok(())
    }
    /// `revealWindow?`: bring the window hosting the tab forward
    fn reveal_window(&self, _tab_id: &str) -> Result<(), String> {
        Ok(())
    }
    /// `console.warn(message, error)`, `error` being the message of the error
    fn warn(&self, message: &str, error: &str);
}

/// `step` first, then `next` with how it settled: `await` of the TypeScript
pub fn bind<'h>(
    step: ToolStep<'h>,
    next: impl FnOnce(Settled) -> ToolStep<'h> + 'h,
) -> ToolStep<'h> {
    match step {
        ToolStep::Done(settled) => next(settled),
        ToolStep::Await { call, then } => ToolStep::Await {
            call,
            then: Box::new(move |settled| bind(then(settled), next)),
        },
    }
}

/// a step that settled with nothing (`undefined`)
fn nothing<'h>(settled: Settled) -> ToolStep<'h> {
    ToolStep::Done(settled.map(|_| None))
}

/// `x is unavailable in this build`
fn unavailable(what: &str) -> String {
    format!("the {what} is unavailable in this build")
}

/// `requireContents(tab, deps)` as a step: the webContents id
fn require_contents<'h>(
    sync: Rc<dyn OpenBridgeSync + 'h>,
    tab: OpenDocumentTab,
    then: impl FnOnce(i64) -> ToolStep<'h> + 'h,
) -> ToolStep<'h> {
    ask(
        "OpenDocumentsBridgeDeps",
        "webContentsFor",
        vec![JsonValue::String(tab.id.clone())],
        move |settled| match settled {
            Err(message) => ToolStep::Done(Err(message)),
            Ok(Some(JsonValue::Number(wc))) if !sync.is_destroyed(wc as i64) => then(wc as i64),
            Ok(_) => ToolStep::Done(Err(format!("\"{}\" is no longer open", tab.title))),
        },
    )
}

fn wc_json(wc: i64) -> JsonValue {
    JsonValue::Number(wc as f64)
}

/// `createOpenTargetResolver(deps)(target, family, options)` as steps: an
/// agent can point an edit at a tab the *user* has open (by tab id or path)
/// instead of the blank one `create_session` opened. `focus` is
/// `options?.focus`. Answers the webContents id.
pub fn resolve_target<'h>(
    sync: Rc<dyn OpenBridgeSync + 'h>,
    target: String,
    family: EditorFamily,
    focus: bool,
) -> ToolStep<'h> {
    ask("OpenDocumentsBridgeDeps", "list", vec![], move |settled| {
        let documents: Vec<OpenDocumentTab> = match settled {
            Ok(Some(JsonValue::Array(items))) => items.iter().map(tab_of_json).collect(),
            Ok(_) => Vec::new(),
            Err(message) => return ToolStep::Done(Err(message)),
        };
        let doc = match resolve_open_document_of_family(&documents, &target, family) {
            Ok(doc) => doc.clone(),
            Err(message) => return ToolStep::Done(Err(message)),
        };
        let shown = Rc::clone(&sync);
        require_contents(sync, doc.clone(), move |wc| {
            if focus && !doc.active {
                // Showing the tab is a courtesy, not part of the edit: a UI failure here
                // must not fail the command the caller actually asked for.
                let result = shown
                    .activate(&doc.id)
                    .and_then(|()| shown.reveal_window(&doc.id));
                if let Err(error) = result {
                    shown.warn(
                        "[mcp] could not bring the target document into view:",
                        &error,
                    );
                }
            }
            ToolStep::Done(Ok(Some(wc_json(wc))))
        })
    })
}

/// the control of a family's own editor protocol
fn editor_control(kind: TabKind) -> Option<(&'static str, Dep, &'static str)> {
    Some(match kind {
        TabKind::Markdown => ("MarkdownBridge", Dep::Markdown, "Markdown editor"),
        TabKind::Html => ("HtmlBridge", Dep::Html, "HTML editor"),
        TabKind::Mindmap => ("MindmapBridge", Dep::Mindmap, "mind map editor"),
        TabKind::Hwp => ("HwpBridge", Dep::Hwp, "HWP editor"),
        TabKind::Epub => ("EpubBridge", Dep::Epub, "e-book editor"),
        TabKind::Diagram => ("DiagramBridge", Dep::Diagram, "diagram editor"),
        _ => return None,
    })
}

/// `createOpenDocumentsControl(deps)`
pub struct OpenDocumentsBridge<'h> {
    sync: Rc<dyn OpenBridgeSync + 'h>,
}

/// `createOpenDocumentsControl(deps)`
pub fn create_open_documents_control<'h>(
    sync: Rc<dyn OpenBridgeSync + 'h>,
) -> OpenDocumentsBridge<'h> {
    OpenDocumentsBridge { sync }
}

impl<'h> OpenDocumentsBridge<'h> {
    /// save one document to `file_path` through its family's own writer
    fn save_to(&self, tab: &OpenDocumentTab, file_path: &str) -> ToolStep<'h> {
        let sync = Rc::clone(&self.sync);
        let path = JsonValue::String(file_path.to_owned());
        let payload = js_object(vec![
            ("path", path.clone()),
            ("overwrite", JsonValue::Bool(true)),
        ]);
        let tab = tab.clone();
        match tab.kind {
            TabKind::Docs => {
                if !sync.wired(Dep::Docs) {
                    return ToolStep::Done(Err(unavailable("Word editor")));
                }
                require_contents(sync, tab, move |wc| {
                    ask(
                        "DocsControl",
                        "runCommand",
                        vec![
                            wc_json(wc),
                            JsonValue::String("save_document".to_owned()),
                            payload,
                        ],
                        nothing,
                    )
                })
            }
            TabKind::Sheets => {
                if !sync.wired(Dep::Sheets) {
                    return ToolStep::Done(Err(unavailable("spreadsheet editor")));
                }
                require_contents(sync, tab, move |wc| {
                    ask(
                        "SheetsControl",
                        "runCommand",
                        vec![
                            wc_json(wc),
                            JsonValue::String("save_sheet".to_owned()),
                            payload,
                        ],
                        nothing,
                    )
                })
            }
            TabKind::Slides => {
                if !sync.wired(Dep::Slides) {
                    return ToolStep::Done(Err(unavailable("presentation editor")));
                }
                require_contents(sync, tab, move |wc| {
                    ask(
                        "SlidesControl",
                        "saveDeck",
                        vec![wc_json(wc), path, JsonValue::Bool(true)],
                        nothing,
                    )
                })
            }
            TabKind::Markdown
            | TabKind::Html
            | TabKind::Mindmap
            | TabKind::Epub
            | TabKind::Diagram => {
                let (control, dep, what) = editor_control(tab.kind).expect("an editor family");
                if !sync.wired(dep) {
                    return ToolStep::Done(Err(unavailable(what)));
                }
                require_contents(sync, tab, move |wc| {
                    ask(control, "save", vec![wc_json(wc), path], nothing)
                })
            }
            TabKind::Pdf => ToolStep::Done(Err(
                "a PDF cannot be saved through this tool: the pdf app is a viewer".to_owned(),
            )),
            TabKind::Hwp => ToolStep::Done(Err(concat!(
                "an HWP document cannot be saved through this tool: it is saved by the user in its ",
                "editor. Pass unsaved:\"discard\" to close it without its changes, or leave it open"
            )
            .to_owned())),
            TabKind::Home | TabKind::Help => {
                ToolStep::Done(Err(format!("cannot save a {} tab", tab.kind.as_str())))
            }
        }
    }

    /// `readDocument(tab)`
    pub fn read(&self, tab: &OpenDocumentTab) -> ToolStep<'h> {
        let sync = Rc::clone(&self.sync);
        let tab = tab.clone();
        match tab.kind {
            TabKind::Docs => {
                if !sync.wired(Dep::Docs) {
                    return ToolStep::Done(Err(unavailable("Word editor")));
                }
                require_contents(sync, tab, |wc| {
                    ask(
                        "DocsControl",
                        "runCommand",
                        vec![
                            wc_json(wc),
                            JsonValue::String("read_document".to_owned()),
                            js_object(vec![]),
                        ],
                        ToolStep::Done,
                    )
                })
            }
            TabKind::Sheets => {
                if !sync.wired(Dep::Sheets) {
                    return ToolStep::Done(Err(unavailable("spreadsheet editor")));
                }
                require_contents(sync, tab, |wc| {
                    ask(
                        "SheetsControl",
                        "runCommand",
                        vec![
                            wc_json(wc),
                            JsonValue::String("read_sheet".to_owned()),
                            js_object(vec![]),
                        ],
                        ToolStep::Done,
                    )
                })
            }
            TabKind::Slides => {
                if !sync.wired(Dep::Slides) {
                    return ToolStep::Done(Err(unavailable("presentation editor")));
                }
                require_contents(sync, tab, |wc| {
                    ask(
                        "SlidesControl",
                        "readDeck",
                        vec![wc_json(wc)],
                        ToolStep::Done,
                    )
                })
            }
            TabKind::Markdown
            | TabKind::Html
            | TabKind::Mindmap
            | TabKind::Hwp
            | TabKind::Epub
            | TabKind::Diagram => {
                let (control, dep, what) = editor_control(tab.kind).expect("an editor family");
                if !sync.wired(dep) {
                    return ToolStep::Done(Err(unavailable(what)));
                }
                require_contents(sync, tab, move |wc| {
                    ask(control, "read", vec![wc_json(wc)], ToolStep::Done)
                })
            }
            TabKind::Pdf | TabKind::Home | TabKind::Help => {
                ToolStep::Done(Err(format!("cannot read a {} tab", tab.kind.as_str())))
            }
        }
    }

    /// what a discard leaves behind: markdown and html release staged assets
    /// and drop their recovery copy (an untitled document's too), slides drops
    /// its copies, and docs / sheets / pdf / mind map / hwp / diagram drop
    /// theirs through `recoveryDiscard`.
    fn discard_leftovers(&self, tab: &OpenDocumentTab) -> ToolStep<'h> {
        let sync = Rc::clone(&self.sync);
        let tab = tab.clone();
        let staged = |control: &'static str, text: &'static str| {
            let warn = Rc::clone(&sync);
            let step = require_contents(Rc::clone(&sync), tab.clone(), move |wc| {
                ask(control, "discard", vec![wc_json(wc)], nothing)
            });
            bind(step, move |settled| {
                if let Err(error) = settled {
                    warn.warn(text, &error);
                }
                ToolStep::Done(Ok(None))
            })
        };
        if tab.kind == TabKind::Markdown && sync.wired(Dep::Markdown) {
            staged(
                "MarkdownBridge",
                "[mcp] markdown discard cleanup incomplete:",
            )
        } else if tab.kind == TabKind::Html && sync.wired(Dep::Html) {
            staged("HtmlBridge", "[mcp] html discard cleanup incomplete:")
        } else if tab.kind == TabKind::Slides && sync.wired(Dep::SlidesDiscard) {
            // slides keeps its own crash-recovery copies; dropping the edits must drop
            // them too, or the next open offers them back
            require_contents(sync, tab, |wc| {
                ask(
                    "OpenDocumentsBridgeDeps",
                    "slidesDiscard",
                    vec![wc_json(wc)],
                    nothing,
                )
            })
        } else if sync.wired(Dep::RecoveryDiscard) {
            let shown = tab_json(&tab);
            require_contents(sync, tab, move |wc| {
                ask(
                    "OpenDocumentsBridgeDeps",
                    "recoveryDiscard",
                    vec![shown, wc_json(wc)],
                    nothing,
                )
            })
        } else {
            ToolStep::Done(Ok(None))
        }
    }

    /// the caller's snapshot may predate an edit: settle against the live
    /// state; `then` gets the live tab
    fn live(
        &self,
        tab: &OpenDocumentTab,
        then: impl FnOnce(OpenDocumentTab) -> ToolStep<'h> + 'h,
    ) -> ToolStep<'h> {
        let tab = tab.clone();
        ask("OpenDocumentsBridgeDeps", "list", vec![], move |settled| {
            let found = match settled {
                Ok(Some(JsonValue::Array(items))) => {
                    items.iter().map(tab_of_json).find(|doc| doc.id == tab.id)
                }
                Ok(_) => None,
                Err(message) => return ToolStep::Done(Err(message)),
            };
            match found {
                Some(live) => then(live),
                None => ToolStep::Done(Err(format!("\"{}\" is already closed", tab.title))),
            }
        })
    }

    /// `list`
    pub fn list(&self) -> ToolStep<'h> {
        ask("OpenDocumentsBridgeDeps", "list", vec![], ToolStep::Done)
    }

    /// `save(tab)`: answers `{ savedPath }`
    pub fn save(&self, tab: &OpenDocumentTab) -> ToolStep<'h> {
        let sync = Rc::clone(&self.sync);
        let me = OpenDocumentsBridge {
            sync: Rc::clone(&self.sync),
        };
        self.live(tab, move |live| {
            let saved_path = match close_save_path(&live, &|| sync.default_save_dir()) {
                Ok(path) => path,
                Err(message) => return ToolStep::Done(Err(message)),
            };
            let shown = JsonValue::String(saved_path.clone());
            bind(me.save_to(&live, &saved_path), move |settled| {
                ToolStep::Done(settled.map(|_| Some(js_object(vec![("savedPath", shown)]))))
            })
        })
    }

    /// `close(tab, { unsaved })`: answers `{ savedPath? }`
    pub fn close(&self, tab: &OpenDocumentTab, unsaved: Unsaved) -> ToolStep<'h> {
        let sync = Rc::clone(&self.sync);
        let me = OpenDocumentsBridge {
            sync: Rc::clone(&self.sync),
        };
        self.live(tab, move |live| {
            // the tab goes once what the save or the discard did has settled
            let finish = {
                let (sync, live) = (Rc::clone(&sync), live.clone());
                move |saved_path: Option<String>| -> ToolStep<'h> {
                    if !sync.close_tab(&live.id) {
                        return ToolStep::Done(Err(format!(
                            "\"{}\" could not be closed: it is already closed or waiting on a prompt",
                            live.title
                        )));
                    }
                    // `savedPath ? { savedPath } : {}`
                    ToolStep::Done(Ok(Some(match saved_path.filter(|p| !p.is_empty()) {
                        Some(path) => js_object(vec![("savedPath", JsonValue::String(path))]),
                        None => js_object(vec![]),
                    })))
                }
            };
            if unsaved == Unsaved::Save && live.dirty {
                if live.kind == TabKind::Pdf {
                    // A PDF has no content this tool can write back. Its one unsaved state:
                    // annotations drawn in the viewer, cannot be saved here, so a save-close
                    // refuses to lose it silently; an explicit discard drops it below, like
                    // every other family's.
                    return ToolStep::Done(Err(format!(
                        "\"{}\" has unsaved changes, and a PDF cannot be saved through this tool: close it with unsaved:\"discard\" to drop them, or save it in {PRODUCT_NAME} first",
                        live.title
                    )));
                }
                let path = match close_save_path(&live, &|| sync.default_save_dir()) {
                    Ok(path) => path,
                    Err(message) => return ToolStep::Done(Err(message)),
                };
                let saved = path.clone();
                bind(me.save_to(&live, &path), move |settled| match settled {
                    Err(message) => ToolStep::Done(Err(message)),
                    Ok(_) => finish(Some(saved)),
                })
            } else if unsaved == Unsaved::Discard
                && !sync.is_unloaded(&live.id).unwrap_or(false)
            {
                // a restored tab that never loaded has no edits: its copy stays as it is
                bind(me.discard_leftovers(&live), move |settled| match settled {
                    Err(message) => ToolStep::Done(Err(message)),
                    Ok(_) => finish(None),
                })
            } else {
                finish(None)
            }
        })
    }
}
