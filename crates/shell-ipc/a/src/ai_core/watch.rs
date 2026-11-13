//! `abortOnDestroyed(event.sender, controller)`: a request the renderer
//! started ends when the view that asked goes away or navigates off. The
//! shell cancels the view's calls (`CallContext::cancel`, a flag) and then
//! tells `Views::on_destroyed`; a navigation only sets the flag, so a watch
//! also looks at it on a timer.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use main_core::packages::ai_provider::task::{Id, Rt, Signal};
use shell_contract::ViewId;
use shell_contract::runtime::CancelToken;

/// how often a watch looks at the cancel flag of its call
const POLL_MS: f64 = 250.0;

struct Watch {
    id: u64,
    view: ViewId,
    signal: Signal,
    cancel: CancelToken,
    poll: Option<Id>,
}

pub struct Watches {
    rt: Rt,
    items: RefCell<Vec<Watch>>,
    next: Cell<u64>,
}

impl Watches {
    pub fn new(rt: Rt) -> Rc<Watches> {
        Rc::new(Watches {
            rt,
            items: RefCell::default(),
            next: Cell::new(1),
        })
    }

    /// Aborts `signal` when `view`'s call is cancelled; at once for one that
    /// already is. The id is what [`Watches::unwatch`] takes.
    pub fn watch(self: &Rc<Self>, view: ViewId, cancel: &CancelToken, signal: &Signal) -> u64 {
        let id = self.next.get();
        self.next.set(id + 1);
        let gone = cancel.is_cancelled();
        self.items.borrow_mut().push(Watch {
            id,
            view,
            signal: signal.clone(),
            cancel: cancel.clone(),
            poll: None,
        });
        if gone {
            signal.abort(None);
        } else {
            self.arm(id);
        }
        id
    }

    /// The disposer `abortOnDestroyed` returns
    pub fn unwatch(&self, id: u64) {
        let mut items = self.items.borrow_mut();
        if let Some(at) = items.iter().position(|w| w.id == id) {
            let watch = items.remove(at);
            drop(items);
            self.rt.clear_timeout(watch.poll);
        }
    }

    /// `sender.once('destroyed')`: every request of the view ends
    pub fn abort_view(&self, view: ViewId) {
        let signals: Vec<Signal> = self
            .items
            .borrow()
            .iter()
            .filter(|w| w.view == view)
            .map(|w| w.signal.clone())
            .collect();
        for signal in signals {
            signal.abort(None);
        }
    }

    fn arm(self: &Rc<Self>, id: u64) {
        let this = self.clone();
        let timer = self.rt.set_timeout(POLL_MS, move || this.poll(id));
        if let Some(watch) = self.items.borrow_mut().iter_mut().find(|w| w.id == id) {
            watch.poll = Some(timer);
        }
    }

    fn poll(self: &Rc<Self>, id: u64) {
        let signal = {
            let mut items = self.items.borrow_mut();
            let Some(watch) = items.iter_mut().find(|w| w.id == id) else {
                return;
            };
            watch.poll = None;
            watch.cancel.is_cancelled().then(|| watch.signal.clone())
        };
        match signal {
            Some(signal) => signal.abort(None),
            None => self.arm(id),
        }
    }
}
