//! `apps/sheets/src/main/import-registry.ts`.

use std::cell::Cell;
use std::rc::Rc;

/// An `AbortController`: a flag the cancel sets, and an identity the registry
/// compares (`running.get(owner) !== controller`).
#[derive(Debug, Clone)]
pub struct AbortController(Rc<Cell<bool>>);

impl AbortController {
    fn new() -> Self {
        AbortController(Rc::new(Cell::new(false)))
    }

    /// `controller.abort()`
    pub fn abort(&self) {
        self.0.set(true);
    }

    /// `controller.signal.aborted`
    pub fn aborted(&self) -> bool {
        self.0.get()
    }

    /// `a === b`
    pub fn same(&self, other: &AbortController) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// `Who a running import belongs to`: a webContents id (a number: a `Map` key,
/// so NaN is NaN and -0 is 0).
pub type ImportOwner = f64;

fn same_owner(a: ImportOwner, b: ImportOwner) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// `ImportRegistry`: the delimited imports running right now, one per tab.
#[derive(Debug, Default)]
pub struct ImportRegistry {
    running: Vec<(ImportOwner, AbortController)>,
}

impl ImportRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn position(&self, owner: ImportOwner) -> Option<usize> {
        self.running.iter().position(|(o, _)| same_owner(*o, owner))
    }

    /// Start an import for an owner. A second import for the same owner
    /// replaces the first.
    pub fn start(&mut self, owner: ImportOwner) -> AbortController {
        let controller = AbortController::new();
        match self.position(owner) {
            Some(at) => self.running[at].1 = controller.clone(),
            None => self.running.push((owner, controller.clone())),
        }
        controller
    }

    /// Stop the import running for an owner, if there is one. Returns whether
    /// something was actually stopped.
    pub fn cancel(&mut self, owner: ImportOwner) -> bool {
        let Some(at) = self.position(owner) else {
            return false;
        };
        self.running[at].1.abort();
        true
    }

    /// The import running for an owner, if any.
    pub fn controller_for(&self, owner: ImportOwner) -> Option<AbortController> {
        self.position(owner).map(|at| self.running[at].1.clone())
    }

    /// Whether the import under this controller was cancelled by the user
    pub fn was_cancelled(&self, controller: &AbortController) -> bool {
        controller.aborted()
    }

    /// Forget an import that has finished; whether this import was still the
    /// owner's current one.
    pub fn finish(&mut self, owner: ImportOwner, controller: &AbortController) -> bool {
        let Some(at) = self.position(owner) else {
            return false;
        };
        if !self.running[at].1.same(controller) {
            return false;
        }
        self.running.remove(at);
        true
    }
}
