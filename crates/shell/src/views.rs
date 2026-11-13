//! The windows and views the shell has (the stage 3 shell contract, sections
//! 1 and 2): which Tauri webview is which `ViewId`, in which window, loaded
//! with which preload. Every message from a renderer is attributed through
//! this table, by the label of the webview that sent it: a page cannot name
//! its own sender.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use shell_contract::Surface;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::Sender;
use shell_contract::runtime::{Thread, Views};

use crate::ipc::outlet::TauriOutlet;

struct Record {
    sender: Sender,
    /// the Tauri webview label
    label: String,
    /// `webContents.getZoomFactor`, 1.0 as a page starts
    zoom: f64,
    /// the paths of the latest drop, in the OS's order (`webUtils.getPathForFile`)
    dropped: Vec<PathBuf>,
}

#[derive(Default)]
struct Inner {
    views: BTreeMap<ViewId, Record>,
    by_label: HashMap<String, ViewId>,
    /// window id to its Tauri window label
    windows: BTreeMap<WindowId, String>,
    /// the view of the shell window (Electron's `shellWindow`), when one was named
    main: Option<ViewId>,
}

type Listener = Arc<dyn Fn(ViewId) + Send + Sync>;

pub struct ViewTable {
    inner: Mutex<Inner>,
    next_window: AtomicU32,
    next_view: AtomicU32,
    listeners: Mutex<Vec<Listener>>,
    outlet: Arc<TauriOutlet>,
    core: Arc<dyn Thread>,
}

impl ViewTable {
    pub fn new(outlet: Arc<TauriOutlet>, core: Arc<dyn Thread>) -> Self {
        ViewTable {
            inner: Mutex::default(),
            // Electron's ids start at 1
            next_window: AtomicU32::new(1),
            next_view: AtomicU32::new(1),
            listeners: Mutex::default(),
            outlet,
            core,
        }
    }

    pub fn new_window_id(&self) -> WindowId {
        WindowId(self.next_window.fetch_add(1, Ordering::Relaxed))
    }

    pub fn new_view_id(&self) -> ViewId {
        ViewId(self.next_view.fetch_add(1, Ordering::Relaxed))
    }

    pub fn add_window(&self, window: WindowId, label: String) {
        self.inner.lock().unwrap().windows.insert(window, label);
    }

    /// A view that carries a bridge: its messages are accepted from now on
    pub fn add_view(&self, sender: Sender, label: String) {
        self.outlet.expect(sender.view);
        let mut inner = self.inner.lock().unwrap();
        inner.by_label.insert(label.clone(), sender.view);
        inner.views.insert(
            sender.view,
            Record {
                sender,
                label,
                zoom: 1.0,
                dropped: Vec::new(),
            },
        );
    }

    /// The shell window's view: what [`shell_contract::hosts::MainWindow`] answers
    pub fn mark_main(&self, view: ViewId) {
        self.inner.lock().unwrap().main = Some(view);
    }

    /// The shell window's view if it is alive; else the first view of the shell surface
    pub fn main(&self) -> Option<Sender> {
        let inner = self.inner.lock().unwrap();
        inner
            .main
            .and_then(|view| inner.views.get(&view))
            .or_else(|| {
                inner
                    .views
                    .values()
                    .find(|r| r.sender.surface == Surface::Shell)
            })
            .map(|r| r.sender)
    }

    /// Who sent from the webview with this label; none for a webview without a bridge
    pub fn sender_of_label(&self, label: &str) -> Option<Sender> {
        let inner = self.inner.lock().unwrap();
        let view = inner.by_label.get(label)?;
        inner.views.get(view).map(|r| r.sender)
    }

    pub fn label_of_view(&self, view: ViewId) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner.views.get(&view).map(|r| r.label.clone())
    }

    pub fn label_of_window(&self, window: WindowId) -> Option<String> {
        self.inner.lock().unwrap().windows.get(&window).cloned()
    }

    pub fn window_of_window_label(&self, label: &str) -> Option<WindowId> {
        let inner = self.inner.lock().unwrap();
        inner
            .windows
            .iter()
            .find(|(_, l)| *l == label)
            .map(|(w, _)| *w)
    }

    pub fn views_of_window(&self, window: WindowId) -> Vec<ViewId> {
        let inner = self.inner.lock().unwrap();
        inner
            .views
            .values()
            .filter(|r| r.sender.window == window)
            .map(|r| r.sender.view)
            .collect()
    }

    pub fn zoom(&self, view: ViewId) -> f64 {
        let inner = self.inner.lock().unwrap();
        inner.views.get(&view).map_or(1.0, |r| r.zoom)
    }

    pub fn set_zoom(&self, view: ViewId, factor: f64) {
        if let Some(r) = self.inner.lock().unwrap().views.get_mut(&view) {
            r.zoom = factor;
        }
    }

    pub fn set_dropped(&self, label: &str, paths: Vec<PathBuf>) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(view) = inner.by_label.get(label).copied()
            && let Some(r) = inner.views.get_mut(&view)
        {
            r.dropped = paths;
        }
    }

    pub fn dropped(&self, view: ViewId) -> Vec<PathBuf> {
        let inner = self.inner.lock().unwrap();
        inner
            .views
            .get(&view)
            .map_or_else(Vec::new, |r| r.dropped.clone())
    }

    /// The view is gone: forget it, close its stream, and on the core thread
    /// cancel its pending calls and tell the listeners of [`Views::on_destroyed`]
    pub fn remove_view(&self, view: ViewId) {
        let removed = {
            let mut inner = self.inner.lock().unwrap();
            let removed = inner.views.remove(&view);
            if let Some(r) = &removed {
                inner.by_label.remove(&r.label);
            }
            if inner.main == Some(view) {
                inner.main = None;
            }
            removed.is_some()
        };
        if !removed {
            return;
        }
        self.outlet.forget(view);
        let listeners: Vec<Listener> = self.listeners.lock().unwrap().clone();
        self.core.post(Box::new(move || {
            crate::ipc::view_destroyed(view);
            for listener in &listeners {
                listener(view);
            }
        }));
    }

    /// The window is gone with every view in it
    pub fn remove_window(&self, window: WindowId) {
        for view in self.views_of_window(window) {
            self.remove_view(view);
        }
        self.inner.lock().unwrap().windows.remove(&window);
    }
}

impl Views for ViewTable {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        self.inner
            .lock()
            .unwrap()
            .views
            .get(&view)
            .map(|r| r.sender)
    }

    fn all(&self) -> Vec<Sender> {
        self.inner
            .lock()
            .unwrap()
            .views
            .values()
            .map(|r| r.sender)
            .collect()
    }

    fn on_destroyed(&self, listener: Box<dyn Fn(ViewId) + Send + Sync>) {
        self.listeners.lock().unwrap().push(Arc::from(listener));
    }
}
