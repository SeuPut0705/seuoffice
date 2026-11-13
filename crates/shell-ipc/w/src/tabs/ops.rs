//! What each channel's handler does to the state, one method per
//! `ipcMain` listener body of `registerTabsIpc` and `registerSplitIpc`.

use std::rc::Rc;

use shell_contract::ids::ViewId;
use shell_contract::value::IpcValue;

use super::host::TabHooks;
use super::state::{Inner, TabsState};
use super::wire::to_ipc;

impl TabsState {
    pub(super) fn hooks_ref(&self) -> Rc<dyn TabHooks> {
        self.hooks.clone()
    }

    /// `tabManager?.list() ?? []`
    pub(super) fn list(&self) -> Vec<IpcValue> {
        self.inner
            .borrow()
            .manager
            .as_ref()
            .map(|m| m.list().iter().map(|t| to_ipc(&t.to_value())).collect())
            .unwrap_or_default()
    }

    pub(super) fn activate(&self, id: &str) {
        self.inner
            .borrow_mut()
            .manager_call(|m, b| m.activate_tab(b, id));
    }

    pub(super) fn reorder(&self, id: &str, to_index: f64) {
        self.inner
            .borrow_mut()
            .manager_call(|m, b| m.reorder_tab(b, id, to_index));
    }

    pub(super) fn can_detach(&self, id: &str) -> bool {
        self.inner
            .borrow()
            .manager
            .as_ref()
            .is_some_and(|m| m.can_detach_tab(id))
    }

    /// `tabs:tear-off`: the tab leaves the strip for a window created under the
    /// held pointer at (x, y); the strip keeps steering it until release.
    /// What the drag started from is remembered first: tearing a pane tab out
    /// drops the split, so that is the only record of it.
    pub(super) fn tear_off(&self, id: &str, x: f64, y: f64) -> bool {
        let mut g = self.inner.borrow_mut();
        g.torn_drag = g.tear_off_split_context(id);
        g.torn_drop = None;
        g.last_hint = None;
        let torn = g.tear_off_tab_to_window(id, x, y);
        if !torn {
            g.torn_drag = None;
        }
        torn
    }

    /// `tabs:drag-torn-window`: the pointer moved while held
    pub(super) fn drag_torn_window(&self, x: f64, y: f64) {
        let mut g = self.inner.borrow_mut();
        let Inner {
            detached, bridge, ..
        } = &mut *g;
        detached.drag_torn_window(bridge, x, y);
        g.drain();
        g.update_split_hint(x, y);
    }

    /// `tabs:dock-torn-window`: the held pointer came back over the strip
    pub(super) fn dock_torn_window(&self, index: Option<f64>) {
        let mut g = self.inner.borrow_mut();
        if g.apply_torn_split_drop() {
            return;
        }
        let Inner {
            detached, bridge, ..
        } = &mut *g;
        let tab = detached.take_torn_tab(bridge);
        g.drain();
        let Some(tab) = tab else {
            return;
        };
        g.ensure_manager();
        g.manager_call(|m, b| m.attach_tab(b, tab, index, true));
    }

    /// `tabs:end-torn-drag`: the pointer was released
    pub(super) fn end_torn_drag(&self) {
        let mut g = self.inner.borrow_mut();
        if g.apply_torn_split_drop() {
            return;
        }
        let Inner {
            detached, bridge, ..
        } = &mut *g;
        detached.end_torn_drag(bridge);
        g.drain();
    }

    /// `tabs:dock-index`: the insertion slot the strip reported for the dock preview
    pub(super) fn set_dock_index(&self, index: Option<f64>) {
        self.inner.borrow_mut().last_dock_index = index;
    }

    pub(super) fn split_state(&self) -> Option<serde_json::Value> {
        self.inner
            .borrow()
            .manager
            .as_ref()
            .and_then(|m| m.split_state())
            .map(|s| s.to_value())
    }

    pub(super) fn set_split_ratio(&self, ratio: f64) {
        self.inner
            .borrow_mut()
            .manager_call(|m, b| m.set_split_ratio(b, ratio));
    }

    /// `tabManager?.splitRoleOf(event.sender.id) ?? null`
    pub(super) fn split_role_of(&self, view: ViewId) -> IpcValue {
        let mut g = self.inner.borrow_mut();
        let Inner {
            manager, bridge, ..
        } = &mut *g;
        manager
            .as_ref()
            .and_then(|m| m.split_role_of(bridge, view.0 as i64))
            .map_or(IpcValue::Null, |r| IpcValue::String(r.as_str().into()))
    }

    pub(super) fn focus_pane(&self, view: ViewId) {
        self.inner
            .borrow_mut()
            .manager_call(|m, b| m.focus_pane_by_web_contents(b, view.0 as i64));
    }
}

impl Inner {
    /// `tearOffTabToWindow`
    fn tear_off_tab_to_window(&mut self, id: &str, x: f64, y: f64) -> bool {
        if self.manager.is_none() || self.detached.is_tearing_off(&mut self.bridge) {
            return false;
        }
        if !self.manager.as_ref().is_some_and(|m| m.can_detach_tab(id)) {
            return false;
        }
        let Some(record) = self.manager_call(|m, b| m.detach_tab(b, id)).flatten() else {
            return false;
        };
        self.clear_pane_role(record.view);
        self.create_detached(record, Some((x, y)));
        true
    }
}
