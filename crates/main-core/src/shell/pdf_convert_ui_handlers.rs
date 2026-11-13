//! `apps/shell/src/main/pdf-convert-ui-handlers.ts`.
//!
//! `view_id` is the `number` the TypeScript passes around (a webContents id).
//! `closeTab` is the one dependency that returns a promise, and it asks the
//! tab's editor whether the document may close (its answer arrives on the
//! thread that asked), so `releaseTarget` is a pair of calls:
//! [`PdfConvertUiHandlers::release_target`] answers a [`ReleaseStep`], and
//! once the caller has closed the tab as asked,
//! [`PdfConvertUiHandlers::finish_release_target`] answers the rest (the
//! rejection of `closeTab` is its `Err` argument and passes on).

use jscompat::{JsonValue, js_regex};

/// `PdfConvertUiTabs`
pub trait PdfConvertUiTabs {
    /// the Markdown tab showing the file, if any
    fn find_markdown_tab(&mut self, path: &str) -> Option<String>;
    /// bring the pdf view's tab back to the front after closing another tab
    fn activate_view(&mut self, view_id: f64);
    /// open a file the way File > Open does
    fn open_document(&mut self, path: &str) -> bool;
}

/// What the caller does next for `releaseTarget`.
#[derive(Debug, Clone, PartialEq)]
pub enum ReleaseStep {
    /// `await deps.closeTab(tabId)`: close a tab, its unsaved-changes guard
    /// applies (the user may keep it open); then answer with
    /// [`PdfConvertUiHandlers::finish_release_target`], `Err` where the
    /// promise rejects
    CloseTab { tab_id: String, run: ReleaseRun },
    /// `releaseTarget` returned (`Ok`) or threw (`Err`)
    Done(Result<bool, String>),
}

/// `releaseTarget` while its tab is being closed.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseRun {
    view_id: f64,
    path: String,
}

/// `PdfConvertUiDeps`
pub trait PdfConvertUiDeps: PdfConvertUiTabs {
    /// the view was given this PDF as its open file
    fn owns_source(&mut self, view_id: f64, path: &str) -> bool;
    fn exists(&mut self, path: &str) -> bool;
    fn show_in_folder(&mut self, path: &str);
}

const MAX_PATH: usize = 4096;

fn is_markdown(path: &str) -> bool {
    js_regex!(r"\.md$", "i").test(path)
}

/// what the conversion dialog, the picture export and the translation write
fn is_revealable(path: &str) -> bool {
    js_regex!(r"\.(md|epub|png|pdf)$", "i").test(path)
}

/// The object `createPdfConvertUiHandlers(deps)` returns.
pub struct PdfConvertUiHandlers<D: PdfConvertUiDeps> {
    deps: D,
}

/// `createPdfConvertUiHandlers(deps)`
pub fn create_pdf_convert_ui_handlers<D: PdfConvertUiDeps>(deps: D) -> PdfConvertUiHandlers<D> {
    PdfConvertUiHandlers { deps }
}

impl<D: PdfConvertUiDeps> PdfConvertUiHandlers<D> {
    /// the dependencies, for the caller that built the handlers
    pub fn deps(&self) -> &D {
        &self.deps
    }

    /// `requestOf(viewId, req)`: the written path of a request this view may
    /// make (`{ source, path }` in the TypeScript, whose `source` is only checked)
    fn request_of(&mut self, view_id: f64, req: Option<&JsonValue>) -> Option<String> {
        // `!req || typeof req !== 'object'`
        let req = match req {
            Some(req @ (JsonValue::Object(_) | JsonValue::Array(_))) => req,
            _ => return None,
        };
        let (Some(source), Some(path)) = (
            req.get("source").and_then(|v| string_of(&v)),
            req.get("path").and_then(|v| string_of(&v)),
        ) else {
            return None;
        };
        if path.is_empty()
            || path.encode_utf16().count() > MAX_PATH
            || !self.deps.owns_source(view_id, &source)
        {
            return None;
        }
        Some(path)
    }

    /// `releaseTarget(viewId, req)` up to its `await`: true when no Markdown
    /// tab shows the target (any more)
    pub fn release_target(&mut self, view_id: f64, req: Option<&JsonValue>) -> ReleaseStep {
        let Some(path) = self.request_of(view_id, req) else {
            return ReleaseStep::Done(Ok(false));
        };
        if !is_markdown(&path) {
            return ReleaseStep::Done(Ok(false));
        }
        let Some(tab) = self.deps.find_markdown_tab(&path) else {
            return ReleaseStep::Done(Ok(true));
        };
        ReleaseStep::CloseTab {
            tab_id: tab,
            run: ReleaseRun { view_id, path },
        }
    }

    /// the rest of `releaseTarget`, once `closeTab` has answered
    pub fn finish_release_target(
        &mut self,
        run: ReleaseRun,
        closed: Result<(), String>,
    ) -> Result<bool, String> {
        let ReleaseRun { view_id, path } = run;
        closed?;
        self.deps.activate_view(view_id);
        Ok(self.deps.find_markdown_tab(&path).is_none())
    }

    /// `openResult(viewId, req)`
    pub fn open_result(&mut self, view_id: f64, req: Option<&JsonValue>) -> bool {
        let Some(path) = self.request_of(view_id, req) else {
            return false;
        };
        if !is_markdown(&path) || !self.deps.exists(&path) {
            return false;
        }
        self.deps.open_document(&path)
    }

    /// `revealResult(viewId, req)`
    pub fn reveal_result(&mut self, view_id: f64, req: Option<&JsonValue>) -> bool {
        let Some(path) = self.request_of(view_id, req) else {
            return false;
        };
        if !is_revealable(&path) || !self.deps.exists(&path) {
            return false;
        }
        self.deps.show_in_folder(&path);
        true
    }
}

/// the text of a value that is a string
fn string_of(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(text) => Some(text.clone()),
        _ => None,
    }
}
