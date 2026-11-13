//! `mindmap-main.ts`'s `registerMindmapIpc`, `handoff-main.ts`,
//! `seed-main.ts` and the reply channels of `mcp-queries.ts`.

use std::collections::HashSet;
use std::fs;

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{JsObject, JsonValue};
use main_core::mindmap::atomic_write::atomic_write_file;
use main_core::mindmap::save_as_formats::{
    MapSaveAsKind, save_as_default_path, save_as_filters, save_as_target,
};
use main_core::packages::electron_utils::dialog_memory::{
    FallbackDir, show_save_dialog_with_memory,
};
use main_core::packages::electron_utils::safe_external_url::{
    SafeExternalUrlOptions, safe_external_url,
};
use shell_contract::ipc::{CallContext, Reply};
use shell_contract::{IpcValue, ViewId};

use super::app::{Answer, Ask, MAP_EXTENSION, MindmapApp, SaveMode, Wait, Waiter};
use super::hosts::OpenStatus;
use super::util::{file_name_base, has_key, js_string, one_line, slice, utf16_len};
use crate::host::HostDialog;
use crate::route::{self, Route};
use crate::value::{Args, as_bytes, buffer, field, num, obj, string, thrown};

/// The largest `.mm` read for an import; a FreeMind map is plain XML
const MAX_FREEMIND_BYTES: u64 = 32 * 1024 * 1024;
/// more attachments than a panel would ever hold are not a real report
const MAX_REPORTED_PATHS: usize = 256;
const MAX_PATH_CHARS: usize = 4096;

/// The links a map opens: `mailto:` stays openable on purpose
const LINK_PROTOCOLS: [&str; 3] = ["http:", "https:", "mailto:"];

fn is_freemind(path: &str) -> bool {
    path.to_lowercase().ends_with(".mm")
}

fn failure(message: impl Into<String>) -> IpcValue {
    obj([("ok", IpcValue::Bool(false)), ("error", string(message))])
}

fn ok_with(key: &str, value: IpcValue) -> IpcValue {
    obj([("ok", IpcValue::Bool(true)), (key, value)])
}

/// The path picked in a save dialog over the view's window, or `None` when it
/// was cancelled or picked nothing (`picked.canceled || !picked.filePath`)
pub(super) fn pick_save_path(
    app: &MindmapApp,
    view: ViewId,
    options: &JsObject<JsonValue>,
    fallback: Option<&FallbackDir<'_>>,
) -> Option<String> {
    let parent = app.window_of(view);
    let mut memory = app
        .0
        .shared
        .dialog_memory
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut dialog = HostDialog(&*app.0.dialogs);
    let picked =
        show_save_dialog_with_memory(&mut memory, &mut dialog, parent.as_ref(), options, fallback);
    let JsonValue::Object(picked) = &picked else {
        return None;
    };
    if picked.get("canceled").is_some_and(JsonValue::truthy) {
        return None;
    }
    match picked.get("filePath") {
        Some(JsonValue::String(path)) if !path.is_empty() => Some(path.clone()),
        _ => None,
    }
}

/// `importSaveAsDefault`: an imported map's first save is an `.xmind` of the
/// same name beside its `.mm`
fn import_save_as_default(app: &MindmapApp, view: ViewId) -> Option<String> {
    let (path, title) = app.0.state.borrow().imported.get(&view).cloned()?;
    let base = file_name_base(Some(&title));
    let name = if base.is_empty() {
        app.tm("untitledFile")
    } else {
        base
    };
    Some(join(&[&dirname(&path), &format!("{name}{MAP_EXTENSION}")]))
}

/// `resolveSaveTarget`: where a save goes, and as what; `Ok(None)` is a
/// cancelled dialog. An `Err` is what the TypeScript's `try` caught.
fn resolve_save_target(
    app: &MindmapApp,
    view: ViewId,
    mode: SaveMode,
    default_name: Option<&str>,
) -> Result<Option<(String, MapSaveAsKind)>, String> {
    let current = app.file_path(view);
    if mode == SaveMode::Save
        && let Some(current) = &current
    {
        return Ok(Some((current.clone(), MapSaveAsKind::Xmind)));
    }
    let offer_exports = mode == SaveMode::SaveAs;
    let default_path = match &current {
        Some(current) => join(&[&dirname(current), &basename(current, None)]),
        None => {
            // a restored map whose file is gone is offered that file's old
            // place, an imported map the place of the .mm it came from
            let restored = app
                .view_save_as_default(view)
                .or_else(|| import_save_as_default(app, view));
            match restored {
                Some(path) => path,
                None => {
                    // an untitled map whose panel has a project starts in that folder (spec 6)
                    let dir = match app.0.shell.new_document_dir(view) {
                        Some(dir) => dir,
                        None => app.default_save_dir()?,
                    };
                    let base = file_name_base(default_name);
                    let name = if base.is_empty() {
                        app.tm("untitledFile")
                    } else {
                        base
                    };
                    join(&[&dir, &format!("{name}{MAP_EXTENSION}")])
                }
            }
        }
    };
    let filters = save_as_filters(offer_exports, &mut |key| app.tm(key));
    let mut options = JsObject::new();
    options.set("title", JsonValue::String(app.tm("dlgSaveTitle")));
    options.set(
        "defaultPath",
        JsonValue::String(save_as_default_path(&default_path, offer_exports)),
    );
    options.set(
        "filters",
        JsonValue::Array(
            filters
                .into_iter()
                .map(|filter| {
                    let mut item = JsObject::new();
                    item.set("name", JsonValue::String(filter.name));
                    item.set(
                        "extensions",
                        JsonValue::Array(
                            filter
                                .extensions
                                .into_iter()
                                .map(|e| JsonValue::String(e.to_owned()))
                                .collect(),
                        ),
                    );
                    JsonValue::Object(item)
                })
                .collect(),
        ),
    );
    let Some(picked) = pick_save_path(app, view, &options, None) else {
        return Ok(None);
    };
    Ok(Some(save_as_target(&picked, offer_exports)))
}

fn done(waiter: Option<Waiter>, result: IpcValue, wrote: bool) -> Reply {
    // only a written map is a save: a cancel or a Save As copy is not
    if let Some(waiter) = waiter {
        waiter(Wait::Answer(wrote));
    }
    Ok(result)
}

enum Saved {
    Path(String),
    Canceled,
    Export(MapSaveAsKind, String),
}

fn save(app: &MindmapApp, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    let waiter = app.0.state.borrow_mut().save_waiters.take(view);
    if !app.may_write(view) {
        return done(
            waiter,
            failure("mindmap: the file did not open, nothing is written"),
            false,
        );
    }
    let request = args.get(0);
    let Some(bytes) = as_bytes(field(request, "bytes")) else {
        return done(waiter, failure("mindmap: bad save request"), false);
    };
    // The bytes come from a renderer. They replace the user's file only when they are a map that opens.
    let check = app.0.engine.open_xmind(bytes);
    if check.status != OpenStatus::Ok {
        return done(
            waiter,
            failure(format!(
                "mindmap: refusing to write a file that would not open ({})",
                check.status.as_str()
            )),
            false,
        );
    }
    let mode = if field(request, "mode") == &string("saveAs") {
        SaveMode::SaveAs
    } else {
        SaveMode::Save
    };
    // Request input is untrusted: only an explicit automatic-save flag counts
    let auto = matches!(field(request, "auto"), IpcValue::Bool(true));
    // A copy pair saving onto the map's own path settles the conflict first
    if mode == SaveMode::Save
        && let Some(current) = app.file_path(view)
        && app.conflict_stops_save(view, &current, auto)
    {
        return done(waiter, failure("external-modified"), false);
    }
    let default_name = match field(request, "defaultName") {
        IpcValue::String(name) => Some(name.as_str()),
        _ => None,
    };
    let outcome = (|| -> Result<Saved, String> {
        let Some((path, kind)) = resolve_save_target(app, view, mode, default_name)? else {
            return Ok(Saved::Canceled);
        };
        if kind != MapSaveAsKind::Xmind {
            // Save As > an export type: a copy, written by the export channel to
            // exactly this path. The map keeps its file, state and recovery copy.
            app.0
                .state
                .borrow_mut()
                .save_as_grants
                .insert(view, (kind, path.clone()));
            return Ok(Saved::Export(kind, path));
        }
        let previous = app.file_path(view);
        atomic_write_file(&path, bytes).map_err(|error| error.message)?;
        app.adopt_written_path(view, &path, previous.as_deref());
        Ok(Saved::Path(path))
    })();
    match outcome {
        Ok(Saved::Canceled) => done(
            waiter,
            obj([
                ("ok", IpcValue::Bool(true)),
                ("canceled", IpcValue::Bool(true)),
            ]),
            false,
        ),
        Ok(Saved::Export(kind, path)) => done(
            waiter,
            ok_with(
                "export",
                obj([("format", string(kind.as_str())), ("path", string(path))]),
            ),
            false,
        ),
        Ok(Saved::Path(path)) => done(waiter, ok_with("path", string(path)), true),
        Err(message) => done(waiter, failure(message), false),
    }
}

/// `importFreeMind`: a `.mm` for the renderer to import: its bytes, read and
/// never written
fn import_free_mind(app: &MindmapApp, view: ViewId, path: &str) -> Reply {
    let read = fs::metadata(path)
        .ok()
        .filter(|meta| meta.len() <= MAX_FREEMIND_BYTES)
        .and_then(|_| fs::read(path).ok());
    let Some(bytes) = read else {
        app.refuse_writes(view);
        return Ok(obj([("status", string("unreadable"))]));
    };
    let title = {
        let name = basename(path, None);
        name[..name.len() - 3].to_owned()
    };
    {
        let mut state = app.0.state.borrow_mut();
        state.unopened.remove(&view);
        state.save_path.remove(&view);
        state
            .imported
            .insert(view, (path.to_owned(), title.clone()));
    }
    Ok(obj([
        ("status", string("import")),
        ("importer", string("freemind")),
        ("bytes", buffer(bytes)),
        ("title", string(title)),
    ]))
}

fn open_file(app: &MindmapApp, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    let granted = match args.str(0) {
        Some(path) => app
            .0
            .state
            .borrow()
            .allowed
            .get(&view)
            .is_some_and(|allowed: &HashSet<String>| allowed.contains(path)),
        None => false,
    };
    let Some(path) = args.str(0).filter(|_| granted) else {
        return Err(thrown("mindmap: path not granted to this view"));
    };
    if is_freemind(path) {
        return import_free_mind(app, view, path);
    }
    // A recovery copy left for this file is settled before any of the map is loaded.
    let restored = app.resolve_view_open(view, path, app.window_of(view));
    let bytes = fs::read(path).ok();
    if let Some(restored) = restored {
        let copy = app.0.engine.open_xmind(&restored);
        if copy.status == OpenStatus::Ok {
            // the restored map is written only by a save; the copy is the whole file
            app.0.state.borrow_mut().unopened.remove(&view);
            if bytes
                .as_ref()
                .is_some_and(|b| app.0.engine.open_xmind(b).status == OpenStatus::Ok)
            {
                // the file still opens: it stays the save target
                app.0
                    .state
                    .borrow_mut()
                    .save_path
                    .insert(view, path.to_owned());
                app.remember_disk_state(view, path);
                return Ok(obj([
                    ("status", string("ok")),
                    ("bytes", buffer(restored)),
                    ("restored", string("file")),
                ]));
            }
            // The file is gone or no longer opens, so it is not written over: the
            // map is untitled, its first save offers the old place, and its copies
            // keep replacing the restored one.
            app.0.state.borrow_mut().save_path.remove(&view);
            app.view_restored_untitled(view, path);
            return Ok(obj([
                ("status", string("ok")),
                ("bytes", buffer(restored)),
                ("restored", string("untitled")),
            ]));
        }
    }
    let Some(bytes) = bytes else {
        app.refuse_writes(view);
        return Ok(obj([("status", string("unreadable"))]));
    };
    let opened = app.0.engine.open_xmind(&bytes);
    if opened.status != OpenStatus::Ok {
        app.refuse_writes(view);
        return Ok(obj([("status", string(opened.status.as_str()))]));
    }
    // Seen open, here: only now is the path a save target. This also covers a
    // reload of a view whose file opens again after it was replaced on disk.
    {
        let mut state = app.0.state.borrow_mut();
        state.unopened.remove(&view);
        state.save_path.insert(view, path.to_owned());
    }
    app.remember_disk_state(view, path);
    Ok(obj([("status", string("ok")), ("bytes", buffer(bytes))]))
}

fn save_into_project(app: &MindmapApp, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    let skipped = || {
        obj([
            ("ok", IpcValue::Bool(false)),
            ("skipped", IpcValue::Bool(true)),
        ])
    };
    if !app.0.shell.has_new_document_writer()
        || !app.may_write(view)
        || app.file_path(view).is_some()
    {
        return Ok(skipped());
    }
    let request = args.get(0);
    let Some(bytes) = as_bytes(field(request, "bytes")) else {
        return Ok(failure("mindmap: bad save request"));
    };
    // the bytes come from a renderer: only a map that opens is written
    let check = app.0.engine.open_xmind(bytes);
    if check.status != OpenStatus::Ok {
        return Ok(failure(format!(
            "mindmap: refusing to write a map that would not open ({})",
            check.status.as_str()
        )));
    }
    let name = match field(request, "defaultName") {
        IpcValue::String(name) => Some(name.as_str()),
        _ => None,
    };
    let base = file_name_base(name);
    let base = if base.is_empty() {
        app.tm("untitledFile")
    } else {
        base
    };
    match app
        .0
        .shell
        .write_new_document(view, &format!("{base}{MAP_EXTENSION}"), bytes)
    {
        Ok(written) => {
            // no project chosen, or a save that asked where landed meanwhile
            let Some(written) = written.filter(|w| !w.is_empty()) else {
                return Ok(skipped());
            };
            if app.file_path(view).is_some() {
                return Ok(skipped());
            }
            app.adopt_written_path(view, &written, None);
            Ok(ok_with("path", string(written)))
        }
        Err(message) => Ok(failure(message)),
    }
}

fn open_link(app: &MindmapApp, args: Args) -> Reply {
    let options = SafeExternalUrlOptions {
        allowed_protocols: Some(LINK_PROTOCOLS.map(String::from).to_vec()),
    };
    let Some(target) = safe_external_url(args.str(0), Some(&options)) else {
        return Ok(IpcValue::Bool(false));
    };
    Ok(IpcValue::Bool(
        app.0.os_shell.open_external(&target).is_ok(),
    ))
}

fn untitled_copy_title(app: &MindmapApp, view: ViewId, offered: Option<&str>) -> String {
    if let Some(from_shell) = app.0.shell.recovery_title(view) {
        let trimmed = jscompat::trim(&from_shell);
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    let name = offered
        .map(|offered| slice(&one_line(offered), 0, 80))
        .unwrap_or_default();
    if name.is_empty() {
        app.tm("untitledFile")
    } else {
        name
    }
}

fn recovery_copy(app: &MindmapApp, cx: &CallContext, args: Args) -> Reply {
    use main_core::packages::electron_utils::recovery_store::RecoveryWriteResult;
    let view = cx.sender.view;
    let skipped = || Ok(string("skipped"));
    // nothing unsaved (a save came first), or a view whose file did not open
    if !app.may_write(view) || !app.is_dirty(view) {
        return skipped();
    }
    let request = args.get(0);
    let Some(bytes) = as_bytes(field(request, "bytes")) else {
        return skipped();
    };
    let offered = match field(request, "name") {
        IpcValue::String(name) => Some(name.as_str()),
        _ => None,
    };
    let save_path = app.file_path(view);
    match app.write_view_copy(view, save_path.as_deref(), bytes, || {
        untitled_copy_title(app, view, offered)
    }) {
        Ok(RecoveryWriteResult::Written) => Ok(string("written")),
        Ok(RecoveryWriteResult::Superseded) => Ok(string("superseded")),
        Err(error) => Err(thrown(error.message)),
    }
}

/// `reportedPaths`: the paths of a run-started report, or `None` when the report is not one
fn reported_paths(report: &IpcValue) -> Option<(String, Vec<String>)> {
    let IpcValue::String(id) = field(report, "id") else {
        return None;
    };
    if id.is_empty() {
        return None;
    }
    let IpcValue::Array(attached) = field(report, "attachedPaths") else {
        return None;
    };
    let paths: Vec<String> = attached
        .iter()
        .take(MAX_REPORTED_PATHS)
        .filter_map(|item| match item {
            IpcValue::String(p) if !p.is_empty() && utf16_len(p) <= MAX_PATH_CHARS => {
                Some(p.clone())
            }
            _ => None,
        })
        .collect();
    (!paths.is_empty()).then(|| (id.clone(), paths))
}

/// the settings of a read of the map the renderer answered (`question.parse`)
fn parse_reply(kind: Ask, reply: &IpcValue) -> Option<Result<Answer, String>> {
    if !matches!(reply, IpcValue::Object(_)) {
        return None;
    }
    let error_of =
        |reply: &IpcValue| has_key(reply, "error").then(|| Err(js_string(field(reply, "error"))));
    match kind {
        Ask::Outline => match field(reply, "text") {
            IpcValue::String(text) if has_key(reply, "text") => {
                Some(Ok(Answer::Text(text.clone())))
            }
            _ => error_of(reply),
        },
        Ask::Bytes => {
            if has_key(reply, "bytes") {
                return Some(match field(reply, "bytes") {
                    IpcValue::Bytes(_, bytes) => Ok(Answer::Bytes(bytes.clone())),
                    _ => Err("the map sent no bytes".into()),
                });
            }
            error_of(reply)
        }
    }
}

pub(super) fn routes(app: &MindmapApp) -> Vec<Route> {
    let mut routes = Vec::new();

    let a = app.clone();
    routes.push(route::invoke(
        "mindmap:consume-pending",
        move |cx, _args| {
            Ok(match a.0.state.borrow().open_path.get(&cx.sender.view) {
                Some(path) => string(path.clone()),
                None => IpcValue::Null,
            })
        },
    ));

    let a = app.clone();
    routes.push(route::invoke("mindmap:open-file", move |cx, args| {
        open_file(&a, cx, args)
    }));

    let a = app.clone();
    routes.push(route::invoke("mindmap:save", move |cx, args| {
        save(&a, cx, args)
    }));

    let a = app.clone();
    routes.push(route::invoke(
        "mindmap:save-into-project",
        move |cx, args| save_into_project(&a, cx, args),
    ));

    let a = app.clone();
    routes.push(route::invoke("mindmap:open-link", move |_cx, args| {
        open_link(&a, args)
    }));

    let a = app.clone();
    routes.push(route::send("mindmap:dirty-changed", move |cx, args| {
        let view = cx.sender.view;
        let mut state = a.0.state.borrow_mut();
        if matches!(args.get(0), IpcValue::Bool(true)) && !state.unopened.contains_key(&view) {
            state.dirty.insert(view);
        } else {
            state.dirty.remove(&view);
        }
        Ok(())
    }));

    let a = app.clone();
    routes.push(route::send("mindmap:close-save-result", move |cx, args| {
        let waiter = a.0.state.borrow_mut().close_waiters.take(cx.sender.view);
        if let Some(waiter) = waiter {
            waiter(Wait::Answer(matches!(args.get(0), IpcValue::Bool(true))));
        }
        Ok(())
    }));

    // safety net for menu saves the renderer declined without invoking save()
    // (still loading, or a file that did not open): the save handler itself
    // resolves the normal path
    let a = app.clone();
    routes.push(route::send("mindmap:save-request-ack", move |cx, args| {
        let waiter = a.0.state.borrow_mut().save_waiters.take(cx.sender.view);
        if let Some(waiter) = waiter {
            waiter(Wait::Answer(matches!(args.get(0), IpcValue::Bool(true))));
        }
        Ok(())
    }));

    let a = app.clone();
    routes.push(route::send(
        "mindmap:make-from-document",
        move |cx, _args| {
            a.0.shell.make_from_document(cx.sender.view);
            Ok(())
        },
    ));

    let a = app.clone();
    routes.push(route::invoke("mindmap:recovery-copy", move |cx, args| {
        recovery_copy(&a, cx, args)
    }));

    let a = app.clone();
    routes.push(route::send(
        "mindmap:recovery-copy-now-done",
        move |cx, _args| {
            a.finish_copy_now(cx.sender.view, None);
            Ok(())
        },
    ));

    let a = app.clone();
    routes.push(route::invoke("mindmap:handoff-take", move |cx, _args| {
        let view = cx.sender.view;
        if a.opens_file(view) {
            return Ok(IpcValue::Null);
        }
        let Some(handoff) = a.0.shell.take_generate_handoff(view) else {
            return Ok(IpcValue::Null);
        };
        a.0.state
            .borrow_mut()
            .taken_handoff
            .insert(view, handoff.id.clone());
        Ok(obj([
            ("id", string(handoff.id)),
            (
                "sourcePaths",
                IpcValue::Array(
                    handoff
                        .materials
                        .iter()
                        .map(|m| string(m.path.clone()))
                        .collect(),
                ),
            ),
            ("prompt", string(handoff.text)),
        ]))
    }));

    let a = app.clone();
    routes.push(route::send(
        "mindmap:handoff-run-started",
        move |cx, args| {
            let view = cx.sender.view;
            let Some((id, paths)) = reported_paths(args.get(0)) else {
                return Ok(());
            };
            if a.0.state.borrow().taken_handoff.get(&view) != Some(&id) {
                return Ok(());
            }
            // the store keeps the first run with at least one handed-over file attached
            if a.0.shell.report_generate_run_started(view, &paths) {
                a.0.state.borrow_mut().taken_handoff.remove(&view);
            }
            Ok(())
        },
    ));

    let a = app.clone();
    routes.push(route::invoke("mindmap:seed-take", move |cx, _args| {
        let view = cx.sender.view;
        if a.opens_file(view) {
            return Ok(IpcValue::Null);
        }
        Ok(a.take_seed(view)
            .map_or(IpcValue::Null, |seed| seed.to_value()))
    }));

    for (channel, kind) in [
        ("mindmap:outline-result", Ask::Outline),
        ("mindmap:bytes-result", Ask::Bytes),
    ] {
        let a = app.clone();
        routes.push(route::send(channel, move |cx, args| {
            let view = cx.sender.view;
            if !a.has_pending_ask(kind, view) {
                return Ok(());
            }
            if let Some(answer) = parse_reply(kind, args.get(0)) {
                a.settle_ask(kind, view, None, answer);
            }
            Ok(())
        }));
    }

    let _ = num;
    routes
}
