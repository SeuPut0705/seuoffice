//! `presenter-show.ts` (the audience window on the external display and the
//! presenter-to-audience forwarding) and `slides:show-fullscreen`.

use std::time::Duration;

use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::state::{App, PresenterShow};
use crate::value::{Args, obj, or_null};

type Reply = Result<IpcValue, IpcError>;

impl App {
    /// `closePresenterShow(presenterId)`
    pub fn close_presenter_show(&self, presenter: ViewId) {
        let show = self.state.borrow_mut().presenter_shows.remove(&presenter);
        if let Some(PresenterShow {
            audience: Some((view, window)),
            ..
        }) = show
        {
            {
                let mut state = self.state.borrow_mut();
                state.detach_view(view);
                state.viewers.remove(&view);
                state.audience_presenter.remove(&view);
            }
            self.shell.close_audience_window(window);
        }
    }

    /// The audience window closed (`win.on('closed')`)
    pub fn audience_closed(&self, audience: ViewId) {
        let mut state = self.state.borrow_mut();
        state.detach_view(audience);
        state.viewers.remove(&audience);
        state.audience_presenter.remove(&audience);
        for show in state.presenter_shows.values_mut() {
            if show.audience.is_some_and(|(view, _)| view == audience) {
                show.audience = None;
            }
        }
    }
}

pub fn presenter_start(app: &App, cx: &CallContext, _args: Args) -> Reply {
    let view = cx.sender.view;
    {
        let state = app.state.borrow();
        if let Some(existing) = state.presenter_shows.get(&view) {
            return Ok(obj([(
                "audience",
                IpcValue::Bool(existing.audience.is_some()),
            )]));
        }
    }
    app.state.borrow_mut().presenter_shows.insert(
        view,
        PresenterShow {
            audience: None,
            last_sync: None,
        },
    );
    let has_session = app.state.borrow().has_session(view);
    let host = app.shell.host_window_for(view);
    let host_display = app.shell.display_of(host);
    let external = app
        .shell
        .displays()
        .into_iter()
        .find(|display| display.id != host_display.id);
    let no_audience = || Ok(obj([("audience", IpcValue::Bool(false))]));
    let Some(external) = external.filter(|_| has_session) else {
        return no_audience();
    };
    let Some((audience_view, audience_window)) = app.shell.open_audience_window(external) else {
        return no_audience();
    };
    let mut state = app.state.borrow_mut();
    if let Some(slot) = state.slot_of(view) {
        state.attach_view(audience_view, slot);
    }
    if let Some(show) = state.presenter_shows.get_mut(&view) {
        show.audience = Some((audience_view, audience_window));
    }
    state.audience_presenter.insert(audience_view, view);
    state.viewers.insert(audience_view);
    Ok(obj([("audience", IpcValue::Bool(true))]))
}

pub fn presenter_sync(app: &App, cx: &CallContext, args: Args) -> Result<(), IpcError> {
    let audience = {
        let mut state = app.state.borrow_mut();
        let Some(show) = state.presenter_shows.get_mut(&cx.sender.view) else {
            return Ok(());
        };
        show.last_sync = Some(args.get(0).clone());
        show.audience.map(|(view, _)| view)
    };
    if let Some(view) = audience.filter(|v| app.services.views.sender_of(*v).is_some()) {
        app.emit(view, "slides:show-sync", vec![args.get(0).clone()]);
    }
    Ok(())
}

pub fn presenter_ink(app: &App, cx: &CallContext, args: Args) -> Result<(), IpcError> {
    let audience = app
        .state
        .borrow()
        .presenter_shows
        .get(&cx.sender.view)
        .and_then(|show| show.audience)
        .map(|(view, _)| view);
    if let Some(view) = audience.filter(|v| app.services.views.sender_of(*v).is_some()) {
        app.emit(view, "slides:show-ink", vec![args.get(0).clone()]);
    }
    Ok(())
}

pub fn presenter_swap(app: &App, cx: &CallContext, _args: Args) -> Reply {
    let view = cx.sender.view;
    let audience = app
        .state
        .borrow()
        .presenter_shows
        .get(&view)
        .and_then(|show| show.audience);
    let host = app.shell.host_window_for(view);
    let (Some((audience_view, audience_window)), Some(host)) = (audience, host) else {
        return Ok(IpcValue::Bool(false));
    };
    if app.services.views.sender_of(audience_view).is_none() {
        return Ok(IpcValue::Bool(false));
    }
    let audience_display = app.shell.display_of(Some(audience_window));
    let host_display = app.shell.display_of(Some(host));
    if audience_display.id == host_display.id {
        return Ok(IpcValue::Bool(false));
    }
    app.shell
        .fullscreen_on_display(audience_window, host_display);
    // move the presenter window to the audience's former screen, keeping its fullscreen form
    app.shell.move_presenter_window(host, audience_display);
    Ok(IpcValue::Bool(true))
}

pub fn presenter_end(app: &App, cx: &CallContext, _args: Args) -> Reply {
    app.close_presenter_show(cx.sender.view);
    Ok(IpcValue::Undefined)
}

pub fn audience_ready(app: &App, cx: &CallContext, _args: Args) -> Reply {
    let state = app.state.borrow();
    let sync = state
        .audience_presenter
        .get(&cx.sender.view)
        .and_then(|presenter| state.presenter_shows.get(presenter))
        .and_then(|show| show.last_sync.clone());
    Ok(or_null(sync))
}

pub fn audience_nav(app: &App, cx: &CallContext, args: Args) -> Result<(), IpcError> {
    let presenter = app
        .state
        .borrow()
        .audience_presenter
        .get(&cx.sender.view)
        .copied();
    if let Some(view) = presenter.filter(|v| app.services.views.sender_of(*v).is_some()) {
        app.emit(view, "slides:audience-nav", vec![args.get(0).clone()]);
    }
    Ok(())
}

/// How long a show's release waits, so React strict-mode remounts and
/// presenter-to-show handoffs do not bounce the window
const SHOW_RELEASE_DELAY: Duration = Duration::from_millis(150);

pub fn show_fullscreen(app: &App, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    // a detached editor window fullscreens itself, never the shell behind it
    let Some(window) = app.shell.host_window_for(view) else {
        return Ok(IpcValue::Undefined);
    };
    let on = crate::value::truthy(args.get(0));
    let ticket = {
        let mut state = app.state.borrow_mut();
        // a newer call cancels a release that is waiting
        state.show_fs_ticket += 1;
        state.show_fs_ticket
    };
    if on {
        app.shell.set_bleed(view, true);
        app.shell.show_fullscreen_window(window, true);
        // the snap can leave the window's first responder on the shell chrome view
        app.contents.focus(view);
        // the snap's responder change lands async: focus once more shortly after
        let index = app.registry_index;
        let services = app.services.clone();
        app.services.workers.spawn(Box::new(move || {
            std::thread::sleep(Duration::from_millis(50));
            super::post_to(&services, index, move |app| {
                if app.services.views.sender_of(view).is_some() {
                    app.contents.focus(view);
                }
            })
        }));
    } else {
        let index = app.registry_index;
        let services = app.services.clone();
        app.services.workers.spawn(Box::new(move || {
            std::thread::sleep(SHOW_RELEASE_DELAY);
            super::post_to(&services, index, move |app| {
                if app.state.borrow().show_fs_ticket != ticket {
                    return;
                }
                if app.services.views.sender_of(view).is_some() {
                    app.shell.set_bleed(view, false);
                }
                app.shell.show_fullscreen_window(window, false);
            })
        }));
    }
    Ok(IpcValue::Undefined)
}
