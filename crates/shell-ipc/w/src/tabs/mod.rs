//! `tabs:*`, `app:get-split-role`, `app:view-focused`, `app:open-dropped-files`,
//! `app:chrome-pressed`, `app:split-role-changed` and `home:new-*`,
//! `home:open-agent-window`: the tab strip, the two-pane split, detached and
//! torn-off windows and the "new document" entries.
//!
//! The handlers are `registerTabsIpc`, `registerSplitIpc` and
//! `registerDroppedFilesIpc` of `apps/shell/src/main/index.ts`; the state they
//! read and change is [`TabsState`], which owns main-core's `TabManager` and
//! `DetachedWindows`. What the shell must provide is in [`host`]:
//! [`WindowsHost`] (platform: windows, views, timers, menus; in
//! `Hosts`) and [`TabHooks`] (application: editor modules, strings, menus;
//! in `Provided`). The shell hands the host's events to
//! [`TabsState::host_event`] through the [`HostEvents`] it gets in
//! `WindowsHost::attach`.

mod bridge;
pub mod host;
mod menus;
mod open;
mod ops;
#[cfg(feature = "probe")]
mod probe;
mod project_seam;
mod state;
mod wire;

use std::rc::Rc;

use shell_contract::error::IpcError;
use shell_contract::ipc::{
    CallContext, ChannelKind, Handler, RegisterError, Registry, Responder, Target,
};
use shell_contract::runtime::Services;
use shell_contract::{Batch, IpcValue};

pub use host::{
    DocAction, HostEvent, HostEvents, MenuEntry, MenuEntryKind, ShellWindow, TabHooks, TabsChanged,
    TimerKey, ViewHappened, ViewListen, WindowEvent, WindowState, WindowsHost, WindowsHostRef,
};
#[cfg(feature = "probe")]
pub use probe::probe_hosts;
pub use project_seam::ViewDocument;
pub use state::TabsState;

use self::menus::popup_at;
use self::open::NewKind;
use self::wire::{finite, integer, number, string, to_ipc};
use crate::handle;

/// An `ipcMain.handle` listener that answers later (`await`, a popup menu)
struct Later<F>(F);

impl<F> Handler for Later<F>
where
    F: Fn(&CallContext, Vec<IpcValue>, Responder),
{
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        (self.0)(cx, args, reply)
    }
}

fn later(
    registry: &mut dyn Registry,
    channel: &'static str,
    f: impl Fn(&CallContext, Vec<IpcValue>, Responder) + 'static,
) -> Result<(), RegisterError> {
    registry.register(Batch::W, channel, ChannelKind::Invoke, Rc::new(Later(f)))
}

fn ok() -> Result<IpcValue, IpcError> {
    Ok(IpcValue::Undefined)
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let windows: WindowsHostRef = services.hosts.need(Batch::W)?;
    let provided = registry.provided();
    #[cfg(feature = "probe")]
    probe::provide_hooks(&provided, services);
    let hooks =
        provided
            .all::<dyn TabHooks>()
            .into_iter()
            .next()
            .ok_or(RegisterError::MissingHost {
                batch: Batch::W,
                host: "shell_ipc_w::tabs::TabHooks",
            })?;
    let state = TabsState::new(services, windows, hooks, provided.clone());
    provided.add::<TabsState>(state.clone());
    let main = services
        .hosts
        .need::<shell_contract::MainWindowHost>(Batch::W)?;

    // ---- the strip ----
    let s = state.clone();
    handle(registry, "tabs:list", ChannelKind::Invoke, move |_, _| {
        Ok(IpcValue::Array(s.list()))
    })?;

    let s = state.clone();
    handle(
        registry,
        "tabs:activate",
        ChannelKind::Invoke,
        move |_, args| {
            if let Some(id) = string(args.first()).filter(|id| !id.is_empty()) {
                s.activate(id);
            }
            ok()
        },
    )?;

    let s = state.clone();
    later(registry, "tabs:close", move |_, args, reply| {
        let Some(id) = string(args.first()).filter(|id| !id.is_empty()) else {
            return reply.reply(ok());
        };
        s.close_tab(
            id,
            Box::new(move |done| {
                reply.reply(
                    done.map(|()| IpcValue::Undefined)
                        .map_err(|message| IpcError {
                            name: Some("Error".into()),
                            message,
                        }),
                )
            }),
        );
    })?;

    let s = state.clone();
    handle(
        registry,
        "tabs:reorder",
        ChannelKind::Invoke,
        move |_, args| {
            if let (Some(id), Some(to)) = (string(args.first()), integer(args.get(1))) {
                s.reorder(id, to);
            }
            ok()
        },
    )?;

    // ---- native menus: the invoke is answered when the menu closes ----
    let s = state.clone();
    later(registry, "tabs:show-app-menu", move |_, args, reply| {
        let at = popup_at(number(args.first()), number(args.get(1)));
        s.show_app_menu(at, reply)
    })?;
    let s = state.clone();
    later(registry, "tabs:show-menu", move |_, args, reply| {
        let at = popup_at(number(args.first()), number(args.get(1)));
        s.show_tab_list_menu(at, reply)
    })?;
    let s = state.clone();
    later(registry, "tabs:show-tab-menu", move |_, args, reply| {
        let Some(id) = string(args.first()) else {
            return reply.reply(ok());
        };
        let at = popup_at(number(args.get(1)), number(args.get(2)));
        s.show_tab_menu(id, at, reply)
    })?;
    let s = state.clone();
    later(registry, "tabs:show-new-menu", move |_, args, reply| {
        let at = popup_at(number(args.first()), number(args.get(1)));
        s.show_new_menu(at, reply)
    })?;

    // ---- detach, tear off, dock ----
    let s = state.clone();
    handle(
        registry,
        "tabs:detach",
        ChannelKind::Invoke,
        move |_, args| {
            if let Some(id) = string(args.first())
                && s.can_detach(id)
            {
                s.detach_tab_to_window(id);
            }
            ok()
        },
    )?;

    let s = state.clone();
    handle(
        registry,
        "tabs:tear-off",
        ChannelKind::Invoke,
        move |_, args| {
            let (Some(id), Some(x), Some(y)) = (
                string(args.first()),
                finite(args.get(1)),
                finite(args.get(2)),
            ) else {
                return Ok(IpcValue::Bool(false));
            };
            Ok(IpcValue::Bool(s.tear_off(id, x, y)))
        },
    )?;

    let s = state.clone();
    handle(
        registry,
        "tabs:drag-torn-window",
        ChannelKind::Send,
        move |_, args| {
            if let (Some(x), Some(y)) = (finite(args.first()), finite(args.get(1))) {
                s.drag_torn_window(x, y);
            }
            ok()
        },
    )?;

    let s = state.clone();
    handle(
        registry,
        "tabs:dock-torn-window",
        ChannelKind::Invoke,
        move |_, args| {
            s.dock_torn_window(number(args.first()));
            ok()
        },
    )?;

    let s = state.clone();
    handle(
        registry,
        "tabs:end-torn-drag",
        ChannelKind::Invoke,
        move |_, _| {
            s.end_torn_drag();
            ok()
        },
    )?;

    let s = state.clone();
    handle(
        registry,
        "tabs:dock-index",
        ChannelKind::Send,
        move |_, args| {
            s.set_dock_index(integer(args.first()));
            ok()
        },
    )?;

    let events = services.events.clone();
    let views = services.views.clone();
    handle(
        registry,
        "tabs:chrome-pressed",
        ChannelKind::Send,
        move |cx, _| {
            // tab views see neither DOM events nor a focus change when the user
            // clicks the shell chrome: relay the press, except to the sender,
            // which already dismissed its own popovers
            for sender in views.all() {
                if sender.view != cx.sender.view {
                    events.emit(Target::View(sender.view), "app:chrome-pressed", vec![]);
                }
            }
            ok()
        },
    )?;

    // ---- the split ----
    let s = state.clone();
    handle(
        registry,
        "tabs:get-split",
        ChannelKind::Invoke,
        move |_, _| Ok(s.split_state().map_or(IpcValue::Null, |v| to_ipc(&v))),
    )?;

    let s = state.clone();
    handle(
        registry,
        "tabs:set-split-ratio",
        ChannelKind::Send,
        move |_, args| {
            if let Some(ratio) = finite(args.first()) {
                s.set_split_ratio(ratio);
            }
            ok()
        },
    )?;

    let s = state.clone();
    handle(
        registry,
        "app:get-split-role",
        ChannelKind::Invoke,
        move |cx, _| Ok(s.split_role_of(cx.sender.view)),
    )?;

    let s = state.clone();
    handle(
        registry,
        "tabs:focus-pane",
        ChannelKind::Send,
        move |cx, _| {
            s.focus_pane(cx.sender.view);
            ok()
        },
    )?;
    let s = state.clone();
    handle(
        registry,
        "app:view-focused",
        ChannelKind::Send,
        move |cx, _| {
            s.focus_pane(cx.sender.view);
            ok()
        },
    )?;

    let s = state.clone();
    handle(
        registry,
        "app:open-dropped-files",
        ChannelKind::Send,
        move |_, args| {
            s.handle_dropped_files(args.first());
            ok()
        },
    )?;

    // ---- new documents ----
    for (channel, key, kind) in [
        ("home:new-doc", "doc", NewKind::Doc),
        ("home:new-sheet", "sheet", NewKind::Sheet),
        ("home:new-slide", "slide", NewKind::Slide),
        ("home:new-markdown", "markdown", NewKind::Markdown),
        ("home:new-html", "html", NewKind::Html),
        ("home:new-mindmap", "mindmap", NewKind::Mindmap),
        ("home:new-diagram", "diagram", NewKind::Diagram),
        ("home:new-hwp", "hwp", NewKind::Hwp),
        ("home:new-pdf", "pdf", NewKind::Pdf),
    ] {
        let s = state.clone();
        handle(registry, channel, ChannelKind::Invoke, move |_, args| {
            s.remember_pending_dir(key, args.first());
            s.new_tab(kind);
            ok()
        })?;
    }

    // Home opens the agent window; nothing else may
    let hooks = state.hooks_ref();
    handle(
        registry,
        "home:open-agent-window",
        ChannelKind::Invoke,
        move |cx, _| {
            if main.view() == Some(cx.sender.view) {
                hooks.open_agent_window();
            }
            ok()
        },
    )?;
    Ok(())
}
