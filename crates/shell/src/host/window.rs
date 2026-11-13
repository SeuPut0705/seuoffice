//! Windows and views (the stage 3 shell contract, section 1): Electron's
//! `BrowserWindow` is a Tauri window and a `webContents` is a webview. A
//! window made by [`Windows::open_window`] has its first view as a webview
//! window; further views (the shell window's tabs were `WebContentsView`s)
//! are children of it ([`Windows::add_view`]).
//!
//! Every view carries a [`Bridge`]: the preload of its surface as the
//! webview's initialization script, and an entry in the [`ViewTable`] that
//! attributes its messages. A view with no bridge is for a page that is not
//! ours; it can message nothing and its navigation is not restricted.
//!
//! Callable from any thread; from the core thread a call waits for the UI
//! thread, from the UI thread it runs at once.

use std::sync::Arc;

use shell_contract::hosts::MainWindow;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::Sender;
use shell_contract::{Hosts, MainWindowHost, Surface};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, WebviewWindowBuilder,
};

use tauri_runtime_cef::{
    ConsoleMessage, FrameEvent, FrameEventKind, WebviewBuilderCefExt, WebviewWindowBuilderCefExt,
};

use super::HostContext;
use crate::app_scheme;
use crate::preload;
use crate::trace::{self, trace};
use crate::views::ViewTable;

/// One console line of a page, as the trace shows it
fn console_line(label: &str, message: &ConsoleMessage) {
    trace!(
        "console",
        "{label} {:?} {} ({}:{})", message.level, message.message, message.source, message.line
    );
}

/// A frame event of `view`: a main frame that lost its renderer goes to the
/// crash watch (U) always; the rest is a trace line
fn frame_event(view: ViewId, label: &str, event: &FrameEvent) {
    if event.is_main && matches!(event.kind, FrameEventKind::RendererTerminated) {
        super::crash::renderer_terminated(view);
    }
    if trace::enabled() {
        frame_line(label, event);
    }
}

/// The frame events worth a line: where a page went and whether it loaded
fn frame_line(label: &str, event: &FrameEvent) {
    let what = match &event.kind {
        FrameEventKind::NavigationStarted { url } => format!("navigation started {url}"),
        FrameEventKind::DocumentCommitted { url } => format!("document committed {url}"),
        FrameEventKind::NavigationFailed { url } => format!("NAVIGATION FAILED {url}"),
        FrameEventKind::LoadingStateChanged { is_loading } => format!("loading {is_loading}"),
        FrameEventKind::RendererTerminated => "RENDERER TERMINATED".to_owned(),
        _ => return,
    };
    trace!(
        "frame",
        "{label} {}{what}",
        if event.is_main { "" } else { "(subframe) " }
    );
}

/// How a view talks to the shell
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bridge {
    /// no bridge: a page that is not ours
    #[allow(dead_code)]
    // for the first page that is not ours (a sign-in window); batch W's views
    None,
    /// the preload of this surface
    Surface(Surface),
    /// `--measure-dialog`'s page: the bridge, as the shell surface
    Measure,
}

impl Bridge {
    fn surface(self) -> Option<Surface> {
        match self {
            Bridge::None => None,
            Bridge::Surface(surface) => Some(surface),
            Bridge::Measure => Some(Surface::Shell),
        }
    }

    /// The initialization script; with the trace on, the bridge is told to log its stages
    fn script(self) -> Option<String> {
        let source = match self {
            Bridge::None => return None,
            Bridge::Surface(surface) => preload::source(surface),
            Bridge::Measure => preload::MEASURE,
        };
        Some(if trace::enabled() {
            format!("window.__SEUOFFICE_TRACE__ = true;\n{source}")
        } else {
            source.to_owned()
        })
    }
}

pub struct ViewSpec {
    /// A page of a renderer bundle, named as the handlers name it
    /// (`genoffice-app://docs/index.html?mode=tab`); [`app_scheme::webview_url`] translates
    pub url: String,
    pub bridge: Bridge,
}

pub struct WindowSpec {
    pub title: String,
    /// logical pixels
    pub size: (f64, f64),
    pub min_size: Option<(f64, f64)>,
    pub visible: bool,
    /// the OS title bar and borders (Electron's `frame`)
    pub decorations: bool,
    pub transparent: bool,
    pub resizable: bool,
    /// a child window of this one (Electron's `parent`): above it, and gone with it
    pub parent: Option<WindowId>,
    /// takes the focus when it shows (false: Electron's `showInactive`)
    pub focus: bool,
    /// this window's first view is the shell window's (what [`MainWindow`] answers)
    pub main: bool,
    pub view: ViewSpec,
}

/// A child view's place in its window, in logical pixels
#[allow(dead_code)] // the tab strip's views, with `add_view`: the WindowsHost that replaces its stub
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct Windows {
    app: AppHandle,
    views: Arc<ViewTable>,
}

impl Windows {
    pub fn new(app: AppHandle, views: Arc<ViewTable>) -> Self {
        Windows { app, views }
    }

    fn url_of(url: &str) -> Result<WebviewUrl, String> {
        app_scheme::webview_url(url)
            .map(WebviewUrl::External)
            .ok_or_else(|| format!("'{url}' is not a renderer page"))
    }

    /// A new window with its first view
    pub fn open_window(&self, spec: WindowSpec) -> Result<(WindowId, ViewId), String> {
        let url = Self::url_of(&spec.view.url)?;
        let window = self.views.new_window_id();
        let view = self.views.new_view_id();
        let label = format!("view-{}", view.0);
        let frames = label.clone();
        let mut builder = WebviewWindowBuilder::new(&self.app, &label, url)
            .title(spec.title)
            .inner_size(spec.size.0, spec.size.1)
            .visible(spec.visible)
            .decorations(spec.decorations)
            .transparent(spec.transparent)
            .resizable(spec.resizable)
            .focused(spec.focus)
            .on_frame_event(move |e| frame_event(view, &frames, &e));
        if let Some((w, h)) = spec.min_size {
            builder = builder.min_inner_size(w, h);
        }
        if let Some(parent) = spec.parent {
            let parent = self
                .views
                .label_of_window(parent)
                .and_then(|l| self.app.get_webview_window(&l))
                .ok_or_else(|| format!("no parent window {}", parent.0))?;
            builder = builder
                .parent(&parent)
                .map_err(|e| format!("parenting a window: {e}"))?;
        }
        if trace::enabled() {
            let console = label.clone();
            builder = builder.on_console_message(move |m| console_line(&console, &m));
        }
        trace!(
            "window",
            "open window {} view {} '{label}' {} (bridge {:?}, script {} bytes)",
            window.0,
            view.0,
            spec.view.url,
            spec.view.bridge,
            spec.view.bridge.script().map_or(0, |s| s.len())
        );
        if let Some(script) = spec.view.bridge.script() {
            builder = builder
                .initialization_script(script)
                // a page with a bridge stays on the shell's own pages, and opens no window of its own
                .on_navigation(app_scheme::is_own_page)
                .on_new_window(|_, _| NewWindowResponse::Deny);
        }
        // known before the page can run: its first message must find its sender
        self.views.add_window(window, label.clone());
        if let Some(surface) = spec.view.bridge.surface() {
            self.views.add_view(
                Sender {
                    view,
                    window,
                    surface,
                },
                label.clone(),
            );
            if spec.main && surface == Surface::Shell {
                self.views.mark_main(view);
            }
        }
        match builder.build() {
            Ok(_) => {
                trace!("window", "window {} built", window.0);
                Ok((window, view))
            }
            Err(error) => {
                self.views.remove_window(window);
                Err(format!("opening a window: {error}"))
            }
        }
    }

    /// A child view of `window`
    #[allow(dead_code)] // the tab strip's views: the WindowsHost that replaces its stub
    pub fn add_view(
        &self,
        window: WindowId,
        spec: ViewSpec,
        bounds: Bounds,
    ) -> Result<ViewId, String> {
        let url = Self::url_of(&spec.url)?;
        let label = self
            .views
            .label_of_window(window)
            .ok_or_else(|| format!("no window {}", window.0))?;
        let parent = self
            .app
            .get_window(&label)
            .ok_or_else(|| format!("window {} is gone", window.0))?;
        let view = self.views.new_view_id();
        let view_label = format!("view-{}", view.0);
        let frames = view_label.clone();
        let mut builder = WebviewBuilder::new(&view_label, url)
            .position(LogicalPosition::new(bounds.x, bounds.y))
            .size(LogicalSize::new(bounds.width, bounds.height))
            .on_frame_event(move |e| frame_event(view, &frames, &e));
        if trace::enabled() {
            let console = view_label.clone();
            builder = builder.on_console_message(move |m| console_line(&console, &m));
        }
        trace!(
            "window",
            "add view {} '{view_label}' to window {} {}", view.0, window.0, spec.url
        );
        if let Some(script) = spec.bridge.script() {
            builder = builder
                .initialization_script(script)
                .on_navigation(app_scheme::is_own_page)
                .on_new_window(|_, _| NewWindowResponse::Deny);
        }
        if let Some(surface) = spec.bridge.surface() {
            self.views.add_view(
                Sender {
                    view,
                    window,
                    surface,
                },
                view_label,
            );
        }
        match parent.add_child(builder) {
            Ok(_) => Ok(view),
            Err(error) => {
                self.views.remove_view(view);
                Err(format!("adding a view: {error}"))
            }
        }
    }

    /// The Tauri webview of a view
    pub fn webview(&self, view: ViewId) -> Option<Webview> {
        self.app.get_webview(&self.views.label_of_view(view)?)
    }

    #[allow(dead_code)] // the tab strip's views: the WindowsHost that replaces its stub
    pub fn close_view(&self, view: ViewId) -> Result<(), String> {
        let webview = self
            .webview(view)
            .ok_or_else(|| format!("no view {}", view.0))?;
        self.views.remove_view(view);
        webview.close().map_err(|e| e.to_string())
    }

    /// Shows a window, taking the focus or not (Electron's `show` and `showInactive`)
    #[allow(dead_code)] // U's update window and the WindowsHost that replaces its stub
    pub fn show(&self, window: WindowId, focus: bool) -> Result<(), String> {
        let label = self
            .views
            .label_of_window(window)
            .ok_or_else(|| format!("no window {}", window.0))?;
        let window = self
            .app
            .get_window(&label)
            .ok_or_else(|| format!("window {label} is gone"))?;
        window.show().map_err(|e| e.to_string())?;
        if focus {
            window.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn close_window(&self, window: WindowId) -> Result<(), String> {
        let label = self
            .views
            .label_of_window(window)
            .ok_or_else(|| format!("no window {}", window.0))?;
        let window = self
            .app
            .get_window(&label)
            .ok_or_else(|| format!("window {label} is gone"))?;
        window.close().map_err(|e| e.to_string())
    }
}

/// The shell window, as the `MainWindow` host answers
struct ShellMain(Arc<ViewTable>);

impl MainWindow for ShellMain {
    fn view(&self) -> Option<ViewId> {
        self.0.main().map(|s| s.view)
    }

    fn window(&self) -> Option<WindowId> {
        self.0.main().map(|s| s.window)
    }
}

pub fn install(hosts: &mut Hosts, cx: &HostContext) {
    install_main_window(hosts, &cx.views);
}

pub fn install_main_window(hosts: &mut Hosts, views: &Arc<ViewTable>) {
    let main: MainWindowHost = Arc::new(ShellMain(views.clone()));
    hosts.insert(main);
}
