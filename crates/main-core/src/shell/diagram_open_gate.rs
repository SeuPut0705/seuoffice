//! `apps/shell/src/main/diagram-open-gate.ts`.
//!
//! The Visio check answers later in the TypeScript (`visioRefusal` returns a
//! promise). Here [`DiagramOpenGate::open_diagram_checked`] starts it through
//! [`DiagramOpenGateDeps::visio_refusal`], which hands back whatever the caller
//! waits on, and the caller finishes it with
//! [`DiagramOpenGate::finish_visio_check`] when it answers: that call is the
//! `.then`/`.catch`/`.finally` chain of the TypeScript. The module-level
//! `checking` set is the gate's own state.

use std::collections::HashSet;

use jscompat::js_regex;
use jscompat::node_path::host::resolve;

/// `DiagramOpenGateDeps`; `open` and `warn` return the message of what they throw.
pub trait DiagramOpenGateDeps {
    /// what [`DiagramOpenGateDeps::visio_refusal`] starts (the promise)
    type Check;
    /// why a diagram file does not open (the words to show), or `None` when it does
    fn refusal(&mut self, file_path: &str) -> Result<Option<String>, String>;
    /// the same for a `.vsdx`, answered later
    fn visio_refusal(&mut self, file_path: &str) -> Self::Check;
    /// give the file its tab (and a place in Recent)
    fn open(&mut self, file_path: &str) -> Result<(), String>;
    /// show why the file did not open
    fn warn(&mut self, message: &str, file_path: &str) -> Result<(), String>;
}

/// What `visioRefusal` settled with, after `.catch((err) => err instanceof
/// Error ? err.message : String(err))` has turned a rejection into text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VisioAnswer {
    /// the promise resolved: `None` is `null`, the file opens
    Resolved(Option<String>),
    /// the promise rejected: the text of the error
    Rejected(String),
}

/// What `openDiagramChecked` returned, with the check it started.
pub struct DiagramOpened<C> {
    /// true when a tab opens (or a `.vsdx` is being checked)
    pub opened: bool,
    /// the Visio check to finish with `finish_visio_check`
    pub check: Option<C>,
}

/// `pathKey(filePath)`
fn path_key(file_path: &str) -> String {
    let resolved = resolve(&[file_path]);
    if cfg!(target_os = "linux") {
        resolved
    } else {
        resolved.to_lowercase()
    }
}

fn is_vsdx(file_path: &str) -> bool {
    js_regex!(r"\.vsdx$", "i").test(file_path)
}

/// The `.vsdx` files being checked now, by path.
#[derive(Debug, Default)]
pub struct DiagramOpenGate {
    checking: HashSet<String>,
}

impl DiagramOpenGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// `openDiagramChecked(filePath, deps)`: opens a diagram file that has no
    /// tab yet, or says why it cannot. `Err` is what a dependency threw out of
    /// the checks that run at once.
    pub fn open_diagram_checked<D: DiagramOpenGateDeps>(
        &mut self,
        file_path: &str,
        deps: &mut D,
    ) -> Result<DiagramOpened<D::Check>, String> {
        if is_vsdx(file_path) {
            let key = path_key(file_path);
            if self.checking.contains(&key) {
                return Ok(DiagramOpened {
                    opened: true,
                    check: None,
                });
            }
            self.checking.insert(key);
            let check = deps.visio_refusal(file_path);
            return Ok(DiagramOpened {
                opened: true,
                check: Some(check),
            });
        }
        let reason = deps.refusal(file_path)?;
        if let Some(reason) = reason {
            deps.warn(&reason, file_path)?;
            return Ok(DiagramOpened {
                opened: false,
                check: None,
            });
        }
        deps.open(file_path)?;
        Ok(DiagramOpened {
            opened: true,
            check: None,
        })
    }

    /// The chain after `visioRefusal`: open on `null`, else warn; an `Err` of
    /// `open` or `warn` is returned as the text `console.warn` prints beside
    /// `[shell] opening a Visio drawing failed:`; the file leaves `checking`
    /// either way.
    pub fn finish_visio_check<D: DiagramOpenGateDeps>(
        &mut self,
        file_path: &str,
        answer: VisioAnswer,
        deps: &mut D,
    ) -> Option<String> {
        let reason = match answer {
            VisioAnswer::Resolved(reason) => reason,
            VisioAnswer::Rejected(message) => Some(message),
        };
        let outcome = match reason {
            None => deps.open(file_path),
            Some(reason) => deps.warn(&reason, file_path),
        };
        self.checking.remove(&path_key(file_path));
        outcome.err()
    }

    /// `diagramOpenChecking(filePath)`: whether a `.vsdx` check is running for the path.
    pub fn diagram_open_checking(&self, file_path: &str) -> bool {
        self.checking.contains(&path_key(file_path))
    }
}
