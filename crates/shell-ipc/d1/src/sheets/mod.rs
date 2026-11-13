//! The `sheets` channels of batch D1: `registerSheetsIpc` of
//! `apps/sheets/src/main/sheets-main.ts` (the `workbook:*` and `sheets:*`
//! channels of this batch; printing and the AI channels belong to other
//! batches).

mod conv;
mod core;
mod dialogs;
mod editors;
pub mod engine;
#[cfg(any(test, feature = "probe"))]
mod fakes;
mod i18n;
mod misc;
mod open;
mod read;
mod recovery;
mod recovery_policy;
mod save;
mod schema;
mod session;
#[cfg(test)]
mod tests;

use std::rc::Rc;

use shell_contract::editors::DocumentEditors;
use shell_contract::ipc::RegisterError;
use shell_contract::provided::Provided;
use shell_contract::runtime::Services;
use shell_contract::{
    Batch, ClipboardHost, DialogsHost, IpcError, IpcValue, MainWindowHost, OsShellHost, ViewId,
};

pub use self::core::HeadlessReport;
use self::core::{Env, core_at, create_core};
use self::editors::{SheetsEditors, install_views};
pub use self::editors::{SheetsViews, views};
use self::engine::{ScreenCaptureHost, SheetsShellHost, WorkbookEngineHost};
use crate::host::{LocaleHost, RecoveryStateHost, Shared, on_view_gone};
use crate::route::{self, Route};
use crate::value::{Args, field, thrown};

type Reply = Result<IpcValue, IpcError>;

/// `ipcMain.handle` whose body awaits in TypeScript: it runs as straight-line
/// code on a worker and answers through the responder
fn worker(env: &Env, channel: &'static str, body: fn(&Env, ViewId, Args) -> Reply) -> Route {
    let env = env.clone();
    route::invoke_later(channel, move |cx, args, reply| {
        let (view, env) = (cx.sender.view, env.clone());
        let work = env.clone();
        env.spawn(move || reply.reply(body(&work, view, args)));
    })
}

pub fn routes(services: &Services, provided: &Rc<Provided>) -> Result<Vec<Route>, RegisterError> {
    let hosts = &services.hosts;
    let locale: LocaleHost = hosts.need(Batch::D1)?;
    let core = create_core(Env {
        services: services.clone(),
        slot: 0,
        engine: hosts.need::<WorkbookEngineHost>(Batch::D1)?,
        shell: hosts.need::<SheetsShellHost>(Batch::D1)?,
        screen: hosts.need::<ScreenCaptureHost>(Batch::D1)?,
        dialogs: hosts.need::<DialogsHost>(Batch::D1)?,
        os_shell: hosts.need::<OsShellHost>(Batch::D1)?,
        clipboard: hosts.need::<ClipboardHost>(Batch::D1)?,
        main_window: hosts.need::<MainWindowHost>(Batch::D1)?,
        shared: Shared::need(hosts)?,
        recovery: hosts.need::<RecoveryStateHost>(Batch::D1)?,
        tm: i18n::Tm::new(locale),
    });
    let env = core.env.clone();

    // a tab's end, as `webContents.once('destroyed', …)`
    {
        let core = core.clone();
        on_view_gone(services, move |view| core.view_gone(view));
    }
    // the sidecar died: every tab using it is told
    {
        let env = env.clone();
        let listener_env = env.clone();
        env.engine.on_process_exit(Box::new(move || {
            listener_env.post(|core| {
                for view in core.tab_views() {
                    if core.env.alive(view) {
                        core.send(view, "workbook:sidecar-crashed", Vec::new());
                    }
                }
            })
        }));
    }
    install_views(&core);
    // the tabs and flags the shell made before the handlers run
    {
        let startup = env.shell.startup();
        for sender in services.views.all() {
            if startup.register_views
                && sender.surface == shell_contract::Surface::Sheets
                && !startup.unregistered.contains(&sender.view)
            {
                core.register_tab(sender.view);
            }
        }
        for (view, path) in &startup.queued {
            core.queue_workbook(*view, path);
        }
        if startup.new_blank {
            core.set_new_blank();
        }
        for path in &startup.untitled {
            core.mark_untitled_path(path);
        }
        for (view, path) in &startup.mcp_writable {
            core.authorize_mcp_write(*view, path);
        }
        for (view, input, out) in startup.headless {
            core.queue_workbook(view, &input);
            let mut state = core.state.borrow_mut();
            state.headless_targets.insert(view, out);
            state.headless_waiters.insert(view, Box::new(|_| {}));
        }
    }
    provided.add::<dyn DocumentEditors>(Rc::new(SheetsEditors { core: core.clone() }));

    let mut routes = Vec::new();

    // ---- on the core thread ----
    let c = core.clone();
    routes.push(route::invoke(
        "sheets:consume-new-blank",
        move |_cx, _args| {
            let mut state = c.state.borrow_mut();
            Ok(IpcValue::Bool(std::mem::take(&mut state.pending_new_blank)))
        },
    ));
    let c = core.clone();
    routes.push(route::invoke(
        "sheets:has-queued-workbook",
        move |cx, _args| {
            Ok(IpcValue::Bool(
                c.state
                    .borrow()
                    .queued_workbooks
                    .contains_key(&cx.sender.view),
            ))
        },
    ));
    let c = core.clone();
    routes.push(route::invoke(
        "sheets:consume-headless-export",
        move |cx, _args| {
            Ok(
                match c
                    .state
                    .borrow_mut()
                    .headless_targets
                    .remove(&cx.sender.view)
                {
                    Some(target) => IpcValue::String(target),
                    None => IpcValue::Null,
                },
            )
        },
    ));
    let c = core.clone();
    routes.push(route::send(
        "sheets:headless-export-done",
        move |cx, args| {
            misc::headless_export_done(&c, cx.sender.view, args.get(0));
            Ok(())
        },
    ));
    let c = core.clone();
    routes.push(route::invoke("workbook:cancel-import", move |cx, _args| {
        c.state
            .borrow_mut()
            .pending_imports
            .cancel(f64::from(cx.sender.view.0));
        Ok(IpcValue::Undefined)
    }));
    let c = core.clone();
    routes.push(route::send("workbook:pending-edits", move |cx, args| {
        misc::pending_edits(&c, cx.sender.view, args.get(0));
        Ok(())
    }));
    let c = core.clone();
    routes.push(route::send(
        "workbook:close-save-result",
        move |cx, args| {
            misc::close_save_result(&c, cx.sender.view, args.get(0));
            Ok(())
        },
    ));
    let c = core.clone();
    routes.push(route::send(
        "workbook:recovery-write-now-done",
        move |cx, args| {
            misc::recovery_write_now_done(&c, cx.sender.view, args.get(0));
            Ok(())
        },
    ));
    let c = core.clone();
    routes.push(route::invoke("workbook:list-tabs", move |cx, _args| {
        Ok(misc::list_tabs(&c, cx.sender.view))
    }));
    let c = core.clone();
    routes.push(route::invoke("workbook:pick-arm", move |cx, args| {
        misc::arm_pick(&c, cx.sender.view, args.get(0))
    }));
    let c = core.clone();
    routes.push(route::invoke("workbook:pick-select", move |cx, args| {
        misc::pick_select(&c, cx.sender.view, args.get(0))
    }));
    let c = core.clone();
    routes.push(route::invoke("workbook:pick-cancel", move |cx, args| {
        misc::pick_cancel(&c, cx.sender.view, args.get(0))
    }));
    let c = core.clone();
    routes.push(route::invoke(
        "workbook:save-edits-begin",
        move |cx, args| save::save_edits_begin(&c, cx.sender.view, args.get(0)),
    ));
    let c = core.clone();
    routes.push(route::invoke(
        "workbook:save-edits-abort",
        move |cx, args| save::save_edits_abort(&c, cx.sender.view, args.get(0)),
    ));

    // ---- on a worker ----
    routes.push(worker(&env, "workbook:select", |env, view, _args| {
        open::open_selected_workbook(env, view, None).inspect_err(|error| {
            // A headless export has no dialog to report a failed open through: settle it
            let message = format!("the input workbook did not open ({error})");
            env.core(move |core| core.fail_headless_export(view, &message));
        })
    }));
    routes.push(worker(&env, "workbook:reopen", |env, view, mut args| {
        reopen(env, view, args.take(0))
    }));
    routes.push(worker(
        &env,
        "workbook:select-for-merge",
        |env, view, _args| select_for_merge(env, view),
    ));
    routes.push(worker(
        &env,
        "workbook:open-for-merge",
        |env, view, mut args| open_for_merge(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:update-password",
        |env, view, mut args| save::update_password(env, view, args.take(0)),
    ));
    routes.push({
        let env = env.clone();
        route::invoke_later("workbook:save", move |cx, mut args, reply| {
            let (view, env) = (cx.sender.view, env.clone());
            let input = args.take(0);
            // a Save As the shell asked for (`request_save`) ends with the
            // renderer's next `save-as` request; the request it waits for is
            // the one current when this save arrives, not when it ends
            let waiter =
                matches!(field(&input, "mode"), IpcValue::String(mode) if mode == "save-as")
                    .then(|| core_at(env.slot).save_as_token(view))
                    .flatten();
            let work = env.clone();
            env.spawn(move || {
                let answer = save::save_workbook(&work, view, input);
                if let Some(token) = waiter {
                    // saved when the answer says it was not canceled
                    let saved = matches!(
                        &answer,
                        Ok(answer) if matches!(field(answer, "canceled"), IpcValue::Bool(false))
                    );
                    work.post(move |core| core.save_as_finished(view, token, saved));
                }
                reply.reply(answer)
            });
        })
    });
    routes.push(worker(
        &env,
        "workbook:save-edits-chunk",
        |env, view, mut args| save::save_edits_chunk(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:write-recovery",
        |env, view, mut args| save::write_workbook_recovery(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:template-bytes",
        |env, view, mut args| save::template_bytes(env, view, args.take(0)),
    ));
    routes.push(worker(&env, "workbook:close", |env, view, mut args| {
        save::close_workbook(env, view, args.take(0))
    }));
    routes.push(worker(
        &env,
        "workbook:auto-rename",
        |env, view, mut args| save::auto_rename(env, view, args.take(0), args.take(1)),
    ));
    routes.push(worker(
        &env,
        "workbook:export-csv",
        |env, view, mut args| save::export_csv(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:export-ods",
        |env, view, mut args| save::export_ods(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:export-pdf",
        |env, view, mut args| save::export_pdf(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:create-document",
        |env, view, mut args| save::create_document(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:csv-save-confirm",
        |env, view, _args| save::csv_save_confirm(env, view),
    ));
    routes.push(worker(
        &env,
        "workbook:withheld-export-choice",
        |env, view, args| save::withheld_export_choice(env, view, args.get(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:read-range",
        |env, view, mut args| read::read_range(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:read-formulas",
        |env, view, mut args| read::read_formulas(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:find-cells",
        |env, view, mut args| read::find_cells(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:read-row-outline",
        |env, view, mut args| read::read_row_outline(env, view, args.take(0)),
    ));
    routes.push(worker(&env, "workbook:recalc", |env, view, mut args| {
        read::recalc(env, view, args.take(0))
    }));
    routes.push(worker(
        &env,
        "workbook:read-media",
        |env, view, mut args| read::read_media(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:list-external-links",
        |env, view, mut args| read::list_external_links(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:update-external-links",
        |env, view, mut args| read::update_external_links(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:read-external-link-usage",
        |env, view, mut args| read::read_external_link_usage(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:select-external-link-source",
        |env, view, _args| read::select_external_link_source(env, view),
    ));
    routes.push(worker(
        &env,
        "workbook:read-pivot-definition",
        |env, view, mut args| read::read_pivot_definition(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:read-slicer-state",
        |env, view, mut args| read::read_slicer_state(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:list-connections",
        |env, view, mut args| read::list_connections(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:refresh-connection",
        |env, view, mut args| read::refresh_connection(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:read-queries",
        |env, view, mut args| read::read_queries(env, view, args.take(0)),
    ));
    routes.push(worker(
        &env,
        "workbook:read-redactions",
        |env, view, mut args| read::read_redactions(env, view, args.take(0)),
    ));
    routes.push(worker(&env, "sheets:files-pick", |env, view, _args| {
        misc::files_pick(env, view)
    }));
    routes.push(worker(&env, "sheets:files-add", |env, view, args| {
        misc::files_add(env, view, args.get(0))
    }));
    routes.push(worker(
        &env,
        "sheets:files-add-pasted-image",
        |env, view, args| misc::files_add_pasted_image(env, view, args.get(0), args.get(1)),
    ));
    routes.push(worker(&env, "sheets:files-read", |env, view, args| {
        misc::files_read(env, view, args.get(0), args.get(1), args.get(2))
    }));
    routes.push(worker(
        &env,
        "sheets:files-read-image",
        |env, view, args| misc::files_read_image(env, view, args.get(0)),
    ));
    routes.push(worker(
        &env,
        "sheets:capture-screen-sources",
        |env, view, _args| misc::capture_screen_sources(env, view),
    ));
    routes.push(worker(
        &env,
        "sheets:capture-screen-source",
        |env, view, args| misc::capture_screen_source(env, view, args.get(0)),
    ));
    Ok(routes)
}

/// `reopenWorkbook`
fn reopen(env: &Env, view: ViewId, path_arg: IpcValue) -> Reply {
    use main_core::sheets::session_reopen::{continued_open_options, session_to_continue};
    use std::path::Path;

    schema::parse(&schema::string().min(1), &path_arg)?;
    let IpcValue::String(path) = path_arg else {
        return Ok(IpcValue::Undefined);
    };
    // A converted, restored, new or decrypted workbook is more than its path:
    // re-open the twin of the session being continued
    let sessions = env.core(move |core| {
        core.require_tab(view)?;
        Ok(core
            .state
            .borrow()
            .tab(view)
            .map(|tab| tab.sessions.clone())
            .unwrap_or_default())
    })?;
    let maps: Vec<_> = sessions.iter().map(|(_, s)| s.to_map()).collect();
    let previous = session_to_continue(&maps, &path)
        .and_then(|found| maps.iter().position(|m| std::ptr::eq(m, found)));
    if let Some(at) = previous {
        let previous = &sessions[at].1;
        if !Path::new(&previous.path).exists() {
            return Err(thrown("Workbook file not found."));
        }
        let options = session::OpenOptions::from_carried(&continued_open_options(&maps[at]));
        let result = open::open_workbook_session(env, view, &previous.path, options)?;
        if !env.alive(view) {
            // The tab closed while the twin was opening; this session has to go the same way
            let id = result.session_id.clone();
            env.core(move |core| {
                if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
                    tab.remove_session(&id);
                }
            });
            open::cleanup_session(
                env,
                &result.session_id,
                &result.session,
                previous.import_temp_dir.as_deref(),
            );
            return Ok(IpcValue::Null);
        }
        if let Some(dir) = previous.import_temp_dir.clone() {
            let (id, mut twin) = (result.session_id.clone(), result.session.clone());
            twin.import_temp_dir = Some(dir);
            env.core(move |core| {
                if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
                    tab.set_session(&id, twin);
                }
            });
        }
        return Ok(result.value);
    }
    // A crash re-open targets the file the user already has open
    if !Path::new(&path).exists() {
        return Err(thrown("Workbook file not found."));
    }
    let ext = open::extension_of(&path);
    if !open::WORKBOOK_EXTS.contains(&ext.as_str()) {
        return Err(thrown(format!("Unsupported workbook: {ext}")));
    }
    open::open_selected_workbook(env, view, Some(path))
}

/// `selectWorkbooksForMerge`
fn select_for_merge(env: &Env, view: ViewId) -> Reply {
    use jscompat::JsonValue;
    let picked = dialogs::open_dialog(
        env,
        dialogs::dialog_parent(env, view),
        &dialogs::dialog_options(&[
            (
                "properties",
                dialogs::json_strings(&["openFile", "multiSelections"]),
            ),
            (
                "filters",
                JsonValue::Array(vec![dialogs::json_filter(
                    &env.tm.t("filterSpreadsheets"),
                    &open::WORKBOOK_EXTS,
                )]),
            ),
        ]),
    );
    if picked.canceled || picked.paths.is_empty() {
        return Ok(IpcValue::Null);
    }
    open::open_merge_sources(env, view, &picked.paths)
}

/// `openWorkbooksForMerge`: chat attachments as merge-source sessions, no dialog
fn open_for_merge(env: &Env, view: ViewId, input: IpcValue) -> Reply {
    use std::path::Path;
    schema::parse(
        &schema::array(schema::string().min(1)).min(1).max(20),
        &input,
    )?;
    let paths: Vec<String> = match &input {
        IpcValue::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                IpcValue::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    for path in &paths {
        let ext = open::extension_of(path);
        if !open::WORKBOOK_EXTS.contains(&ext.as_str()) {
            return Err(thrown(format!("Unsupported merge source: {ext}")));
        }
        if !Path::new(path).exists() {
            return Err(thrown("Merge source not found."));
        }
        // an attached workbook open with unsaved changes is not read, like any attachment
        env.shell.assert_file_saved(path).map_err(thrown)?;
    }
    open::open_merge_sources(env, view, &paths)
}

/// This app's fake hosts for [`crate::testkit::Kit`]
#[cfg(any(test, feature = "probe"))]
pub fn insert_fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    fakes::insert_fakes(hosts, case);
}

/// This app's triggers for [`crate::probe_trigger`]: `name` without its
/// `d1/` prefix; false when it is not one of them
#[cfg(feature = "probe")]
pub fn probe_trigger(
    name: &str,
    view: shell_contract::ViewId,
    args: &serde_json::Value,
    services: &Services,
    provided: &std::rc::Rc<shell_contract::provided::Provided>,
    then: shell_contract::editors::Then<shell_contract::IpcValue>,
) -> bool {
    use shell_contract::editors::editor_for;
    use shell_contract::{IpcValue, WindowId};

    // each arm runs what the TypeScript trigger of the same name runs
    // (`sheetsTriggers` of tools/ipc-diff/d1/sheets-host.ts)
    let parent = args
        .get(0)
        .and_then(serde_json::Value::as_u64)
        .map(|id| WindowId(id as u32));
    match name {
        // `requestSheetsClose(contents, parent)`
        "workbook:request-sheets-close" => match editor_for(provided, view) {
            Some(editor) => {
                editor.request_close(view, parent, Box::new(move |r| then(r.map(IpcValue::Bool))));
            }
            None => then(Err(crate::value::thrown("no sheets editor for the view"))),
        },
        // `request_save(view, SaveAs)`: see `request-save-as` of sheets-host.ts
        "workbook:request-save-as" => match editor_for(provided, view) {
            Some(editor) => editor.request_save(
                view,
                shell_contract::editors::SaveMode::SaveAs,
                Box::new(move |r| then(r.map(IpcValue::Bool))),
            ),
            None => then(Err(crate::value::thrown("no sheets editor for the view"))),
        },
        // `writeSheetsCopiesNow()`
        "workbook:write-sheets-copies-now" => match views() {
            Some(tabs) => tabs.write_copies_now(Box::new(move || then(Ok(IpcValue::Undefined)))),
            None => then(Err(crate::value::thrown(
                "the sheets module is not registered",
            ))),
        },
        // the sidecar process exits
        "workbook:sidecar-exit" => {
            if let Some(engine) = services.hosts.get::<std::sync::Arc<fakes::FakeEngine>>() {
                engine.exit();
            }
            then(Ok(IpcValue::Undefined));
        }
        // `webContents.on('render-process-gone')`
        "workbook:render-process-gone" => {
            if let Some(tabs) = views() {
                tabs.render_process_gone(view);
            }
            then(Ok(IpcValue::Undefined));
        }
        "workbook:mark-sheets-shutting-down" => {
            if let Some(tabs) = views() {
                tabs.mark_shutting_down();
            }
            then(Ok(IpcValue::Undefined));
        }
        "workbook:reset-sheets-shutting-down" => {
            if let Some(tabs) = views() {
                tabs.reset_shutting_down();
            }
            then(Ok(IpcValue::Undefined));
        }
        "workbook:discard-sheets-recovery" => {
            if let Some(tabs) = views() {
                tabs.discard_recovery(view);
            }
            then(Ok(IpcValue::Undefined));
        }
        // a held timer of this length (the close wait, the shutdown flush) ran
        "workbook:timeout-elapsed" => {
            if let Some(shell) = services.hosts.get::<std::sync::Arc<fakes::FakeShell>>() {
                shell.fire(args.get(0).and_then(serde_json::Value::as_u64).unwrap_or(0));
            }
            then(Ok(IpcValue::Undefined));
        }
        _ => return false,
    }
    true
}
