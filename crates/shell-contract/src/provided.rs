//! What batches provide to each other: the calls one area makes into another
//! at run time (a tab asks a document editor to save, a menu asks it to
//! export). Hosts ([`crate::hosts`]) come from the shell and are fixed before
//! the batches register; this table is filled by the batches themselves
//! while they register, and read when a handler runs, so the order in which
//! batches register does not matter.
//!
//! The things provided keep the core thread's state (`Rc`, `RefCell`), so
//! the table lives on the core thread too: the shell keeps one, hands it out
//! through [`crate::ipc::Registry::provided`], and it never crosses threads.
//! A handler that needs it keeps the `Rc` it got at registration.

use std::any::{Any, TypeId};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Provided things by type: `add::<dyn DocumentEditors>(Rc::new(editors))`,
/// then `all::<dyn DocumentEditors>()`. Several batches may add under one type.
#[derive(Default)]
pub struct Provided(RefCell<HashMap<TypeId, Box<dyn Any>>>);

impl Provided {
    pub fn add<T: ?Sized + 'static>(&self, item: Rc<T>) {
        self.0
            .borrow_mut()
            .entry(TypeId::of::<T>())
            .or_insert_with(|| Box::new(Vec::<Rc<T>>::new()))
            .downcast_mut::<Vec<Rc<T>>>()
            .expect("a list of its own type")
            .push(item);
    }

    /// Everything added under `T`, in the order it was added
    pub fn all<T: ?Sized + 'static>(&self) -> Vec<Rc<T>> {
        self.0
            .borrow()
            .get(&TypeId::of::<T>())
            .and_then(|list| list.downcast_ref::<Vec<Rc<T>>>())
            .cloned()
            .unwrap_or_default()
    }
}
